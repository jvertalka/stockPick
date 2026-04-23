import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/intelligence_app_state.dart';
import 'market_data_configuration.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

const _defaultAlphaVantageSymbols = [
  'NVDA',
  'PANW',
  'MSFT',
  'UBER',
  'LLY',
  'JPM',
  'AVGO',
  'TSLA',
  'MDB',
  'CAT',
  'AMD',
  'TSM',
  'CRWD',
  'ZS',
  'FTNT',
  'GOOGL',
  'ORCL',
  'ADBE',
  'CRM',
  'NOW',
  'SNOW',
  'BKNG',
  'ABNB',
  'DASH',
];

class AlphaVantageMarketFeedProvider
    implements
        MarketEnvironmentProvider,
        StyleSignalProvider,
        SectorSignalProvider,
        StockSignalProvider,
        ValidationWindowProvider,
        HistoricalMarketStateProvider {
  AlphaVantageMarketFeedProvider({
    required MarketDataConfiguration configuration,
    required FixtureMarketFeedProvider fallbackProvider,
    http.Client? client,
    AlphaVantagePriceCacheStore? cacheStore,
  }) : _configuration = configuration,
       _fallbackProvider = fallbackProvider,
       _client = client ?? http.Client(),
       _cacheStore = cacheStore ?? AlphaVantagePriceCacheStore();

  final MarketDataConfiguration _configuration;
  final FixtureMarketFeedProvider _fallbackProvider;
  final http.Client _client;
  final AlphaVantagePriceCacheStore _cacheStore;
  Future<_PriceBundle>? _bundleFuture;

  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() async {
    final fallback = await _fallbackProvider.loadMarketEnvironment();
    final bundle = await _loadBundle();
    final environment = _buildEnvironment(
      asOf: bundle.latestAsOf,
      fallback: fallback.data,
      benchmark: bundle.benchmarkSeries,
      stockSeries: bundle.stockSeries.values,
    );

    if (!bundle.hasAlphaData) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: 'alpha-vantage-price-derived',
      asOf: bundle.latestAsOf,
      data: environment,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Market environment is derived from cached Alpha Vantage daily prices where possible, with macro fields still carried from the fallback model.',
    );
  }

  @override
  Future<FeedSlice<List<RawStyleSignal>>> loadStyleSignals() async {
    final fallback = await _fallbackProvider.loadStyleSignals();
    final bundle = await _loadBundle();
    if (!bundle.hasAlphaData) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: 'alpha-vantage-plus-fallback-style-model',
      asOf: bundle.latestAsOf,
      data: fallback.data,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Style rotation still uses the fallback model, but it is timestamped with the Alpha Vantage price refresh so the app can move forward while factor data is connected.',
    );
  }

  @override
  Future<FeedSlice<List<RawSectorSignal>>> loadSectorSignals() async {
    final fallback = await _fallbackProvider.loadSectorSignals();
    final bundle = await _loadBundle();
    if (!bundle.hasAlphaData) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: 'alpha-vantage-plus-fallback-sector-model',
      asOf: bundle.latestAsOf,
      data: _priceAdjustedSectors(fallback.data, bundle),
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Sector sponsorship blends fallback sector structure with Alpha Vantage price breadth by sector.',
    );
  }

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() async {
    final fallback = await _fallbackProvider.loadStockSignals();
    final bundle = await _loadBundle(fallbackStocks: fallback.data);
    if (!bundle.hasAlphaData) {
      return _fallbackStockSlice(
        fallback,
        'No Alpha Vantage daily price series were available yet. Add ORACLE_ALPHA_VANTAGE_API_KEY or wait for the quota-aware cache to populate.',
      );
    }

    final stocks = _buildStocksForDate(
      asOf: bundle.latestAsOf,
      bundle: bundle,
      fallbackStocks: fallback.data,
    );

    if (stocks.isEmpty) {
      return _fallbackStockSlice(
        fallback,
        'Alpha Vantage returned data, but not enough price history was available to build stock signals.',
      );
    }

    return FeedSlice(
      name: fallback.name,
      source: 'alpha-vantage-daily-prices',
      asOf: bundle.latestAsOf,
      data: stocks,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Real daily OHLCV prices from Alpha Vantage now drive trend, momentum, volume, volatility, relative-strength, and drawdown-sensitive fields for ${stocks.length} stocks. Fundamentals, revisions, and options-like fields still use explicit fallback estimates until those feeds are connected. ${bundle.summary}',
    );
  }

  @override
  Future<FeedSlice<List<ValidationWindow>>> loadValidationWindows() async {
    final fallback = await _fallbackProvider.loadValidationWindows();
    final bundle = await _loadBundle();
    if (!bundle.hasAlphaData) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source} (price-spine fallback)',
      asOf: fallback.asOf,
      data: fallback.data,
      availability: FeedAvailability.fixture,
      refreshCadence: fallback.refreshCadence,
      detail:
          '${fallback.detail} Alpha Vantage is currently used for price history only; labeled validation outcomes still require a separate research-data build.',
    );
  }

  @override
  Future<FeedSlice<List<RawMarketState>>> loadHistoricalMarketStates() async {
    final fallback = await _fallbackProvider.loadHistoricalMarketStates();
    final fallbackStocks = await _fallbackProvider.loadStockSignals();
    final fallbackEnvironment = await _fallbackProvider.loadMarketEnvironment();
    final fallbackStyles = await _fallbackProvider.loadStyleSignals();
    final fallbackSectors = await _fallbackProvider.loadSectorSignals();
    final bundle = await _loadBundle(fallbackStocks: fallbackStocks.data);

    if (!bundle.hasAlphaData) {
      return fallback;
    }

    final states = _buildHistoricalStates(
      bundle: bundle,
      fallbackStocks: fallbackStocks.data,
      fallbackEnvironment: fallbackEnvironment.data,
      fallbackStyles: fallbackStyles.data,
      fallbackSectors: fallbackSectors.data,
    );

    if (states.isEmpty) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: 'alpha-vantage-price-history',
      asOf: states.last.asOf,
      data: states,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Historical market states are built from cached Alpha Vantage daily price history for ${bundle.stockSeries.length} symbols. This is now real price history, with non-price fields still filled by fallback estimates.',
    );
  }

  Future<_PriceBundle> _loadBundle({List<RawStockSignal>? fallbackStocks}) {
    return _bundleFuture ??= _buildBundle(fallbackStocks: fallbackStocks);
  }

  Future<_PriceBundle> _buildBundle({
    List<RawStockSignal>? fallbackStocks,
  }) async {
    final fallback =
        fallbackStocks ?? (await _fallbackProvider.loadStockSignals()).data;
    final symbols = _resolveSymbols(fallback);
    final benchmarkSymbol = _configuration.alphaVantageBenchmarkSymbol
        .trim()
        .toUpperCase();
    final requestedSymbols = <String>{benchmarkSymbol, ...symbols}.toList();
    final seriesBySymbol = <String, AlphaVantageDailySeries>{};
    final messages = <String>[];
    var networkRequests = 0;

    for (final symbol in requestedSymbols) {
      final result = await _loadSeries(symbol);
      if (result.series != null) {
        seriesBySymbol[symbol] = result.series!;
      }
      if (result.usedNetwork) {
        networkRequests++;
      }
      if (result.message != null) {
        messages.add(result.message!);
      }
    }

    final benchmark = seriesBySymbol[benchmarkSymbol];
    final stockSeries = {
      for (final symbol in symbols)
        if (seriesBySymbol.containsKey(symbol)) symbol: seriesBySymbol[symbol]!,
    };
    final latestAsOf = _latestSeriesDate([...stockSeries.values, ?benchmark]);

    return _PriceBundle(
      requestedSymbols: symbols,
      stockSeries: stockSeries,
      benchmarkSeries: benchmark,
      latestAsOf: latestAsOf ?? DateTime.now(),
      networkRequests: networkRequests,
      messages: messages,
      templateByTicker: {for (final stock in fallback) stock.ticker: stock},
    );
  }

  List<String> _resolveSymbols(List<RawStockSignal> fallbackStocks) {
    final configured = _configuration.alphaVantageSymbols.isNotEmpty;
    final candidateSymbols = configured
        ? _configuration.alphaVantageSymbols
        : [
            ..._defaultAlphaVantageSymbols,
            ...fallbackStocks.map((stock) => stock.ticker),
          ];
    final benchmarkSymbol = _configuration.alphaVantageBenchmarkSymbol
        .trim()
        .toUpperCase();
    final maxFreshSymbols = math.max(
      1,
      _configuration.alphaVantageDailyRequestLimit - 1,
    );
    final limit = !configured
        ? math.min(_configuration.stockUniverseLimit, maxFreshSymbols)
        : _configuration.stockUniverseLimit;

    return candidateSymbols
        .map((symbol) => symbol.trim().toUpperCase())
        .where((symbol) => symbol.isNotEmpty)
        .where((symbol) => symbol != benchmarkSymbol)
        .toSet()
        .take(limit)
        .toList();
  }

  Future<_SeriesLoadResult> _loadSeries(String symbol) async {
    final cached = await _cacheStore.loadSeries(symbol);
    if (_isFresh(cached)) {
      return _SeriesLoadResult(series: cached);
    }

    final apiKey = _configuration.alphaVantageApiKey;
    if (apiKey == null || apiKey.isEmpty) {
      return _SeriesLoadResult(
        series: cached,
        message: 'Alpha Vantage key is missing for $symbol.',
      );
    }

    final quota = await _cacheStore.loadQuota();
    if (!quota.canUse(_configuration.alphaVantageDailyRequestLimit)) {
      return _SeriesLoadResult(
        series: cached,
        message: 'Alpha Vantage daily quota is exhausted before $symbol.',
      );
    }

    try {
      final uri = Uri.https('www.alphavantage.co', '/query', {
        'function': 'TIME_SERIES_DAILY',
        'symbol': symbol,
        'outputsize': 'compact',
        'apikey': apiKey,
      });
      final response = await _client.get(uri);
      await _recordQuotaUse();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return _SeriesLoadResult(
          series: cached,
          usedNetwork: true,
          message:
              'Alpha Vantage returned HTTP ${response.statusCode} for $symbol.',
        );
      }

      final series = AlphaVantageDailySeries.fromResponse(
        symbol: symbol,
        body: response.body,
        fetchedAt: DateTime.now(),
      );
      await _saveSeries(series);
      return _SeriesLoadResult(series: series, usedNetwork: true);
    } catch (error) {
      return _SeriesLoadResult(
        series: cached,
        usedNetwork: true,
        message: 'Alpha Vantage request failed for $symbol: $error',
      );
    }
  }

  Future<void> _recordQuotaUse() async {
    try {
      await _cacheStore.recordRequest();
    } catch (_) {
      // Quota persistence is helpful, but a browser storage hiccup should not
      // turn a successful market-data response into an app-load failure.
    }
  }

  Future<void> _saveSeries(AlphaVantageDailySeries series) async {
    try {
      await _cacheStore.saveSeries(series);
    } catch (_) {
      // Keep the live response for this run even if local cache storage is full.
    }
  }

  bool _isFresh(AlphaVantageDailySeries? series) {
    if (series == null) {
      return false;
    }
    final now = DateTime.now();
    return series.fetchedAt.year == now.year &&
        series.fetchedAt.month == now.month &&
        series.fetchedAt.day == now.day;
  }

  FeedSlice<List<RawStockSignal>> _fallbackStockSlice(
    FeedSlice<List<RawStockSignal>> fallback,
    String reason,
  ) {
    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source} (alpha-vantage fallback)',
      asOf: fallback.asOf,
      data: fallback.data,
      availability: fallback.availability,
      refreshCadence: fallback.refreshCadence,
      detail: '${fallback.detail} $reason',
    );
  }

  List<RawStockSignal> _buildStocksForDate({
    required DateTime asOf,
    required _PriceBundle bundle,
    required List<RawStockSignal> fallbackStocks,
  }) {
    final templates = {for (final stock in fallbackStocks) stock.ticker: stock};
    return bundle.stockSeries.entries
        .map((entry) {
          final template = templates[entry.key] ?? fallbackStocks.first;
          return _stockFromSeries(
            symbol: entry.key,
            asOf: asOf,
            series: entry.value,
            benchmark: bundle.benchmarkSeries,
            template: template,
          );
        })
        .whereType<RawStockSignal>()
        .toList();
  }

  RawStockSignal? _stockFromSeries({
    required String symbol,
    required DateTime asOf,
    required AlphaVantageDailySeries series,
    required RawStockSignal template,
    AlphaVantageDailySeries? benchmark,
  }) {
    final bars = series.bars.where((bar) => !bar.date.isAfter(asOf)).toList()
      ..sort((left, right) => left.date.compareTo(right.date));
    if (bars.length < 2) {
      return null;
    }

    final latest = bars.last;
    final hasKnownTemplate = template.ticker == symbol;
    final neutralMetric = hasKnownTemplate ? null : 50.0;
    final return5 = _returnPercent(bars, 5);
    final return20 = _returnPercent(bars, 20);
    final return60 = _returnPercent(bars, 60);
    final benchmarkReturn20 = benchmark == null
        ? 0.0
        : _returnPercent(
            benchmark.bars.where((bar) => !bar.date.isAfter(asOf)).toList(),
            20,
          );
    final relativeReturn20 = return20 - benchmarkReturn20;
    final annualizedVol20 = _annualizedVolatility(bars, 20);
    final annualizedVol60 = _annualizedVolatility(bars, 60);
    final volumeRatio = latest.volume / math.max(1, _averageVolume(bars, 20));
    final closeVsHigh60 =
        latest.close / math.max(latest.close, _high(bars, 60));
    final closeVsSma50 = latest.close / math.max(0.01, _sma(bars, 50));
    final downVolumePressure = _downVolumePressure(bars, 20);
    final persistence = _upDayRate(bars, 20);
    final volChange = annualizedVol20 - annualizedVol60;
    final priceResponse = _scoreReturn(return5, scale: 5);
    final relativeStrength = _scoreReturn(relativeReturn20, scale: 5);
    final trendBlend = _average([
      _scoreReturn(return5, scale: 5),
      _scoreReturn(return20, scale: 3),
      _scoreReturn(return60, scale: 1.5),
    ]);
    final volatilityScore = _scoreVolatility(annualizedVol20);
    final nearHighScore = _clampScore(30 + closeVsHigh60 * 70);

    return RawStockSignal(
      ticker: symbol,
      company: hasKnownTemplate ? template.company : symbol,
      sector: hasKnownTemplate ? template.sector : 'Unclassified',
      industry: hasKnownTemplate ? template.industry : 'Imported equity',
      shortTrend: _scoreReturn(return5, scale: 5),
      mediumTrend: _scoreReturn(return20, scale: 3),
      longTrend: _scoreReturn(return60, scale: 1.5),
      residualStrength: relativeStrength,
      momentumPersistence: persistence,
      breakoutQuality: nearHighScore,
      volumeSupport: _clampScore(50 + (volumeRatio - 1) * 45),
      earningsRevisions: neutralMetric ?? template.earningsRevisions,
      earningsSurprise: neutralMetric ?? template.earningsSurprise,
      marginTrend: neutralMetric ?? template.marginTrend,
      revenueTrend: neutralMetric ?? template.revenueTrend,
      freeCashFlowTrend: neutralMetric ?? template.freeCashFlowTrend,
      balanceSheetQuality: neutralMetric ?? template.balanceSheetQuality,
      profitability: neutralMetric ?? template.profitability,
      leverageQuality: neutralMetric ?? template.leverageQuality,
      earningsStability: neutralMetric ?? template.earningsStability,
      valuationSupport: neutralMetric ?? template.valuationSupport,
      crowdingRisk: _clampScore(
        0.45 * nearHighScore + 0.35 * trendBlend + 0.20 * volatilityScore,
      ),
      impliedVolRank: volatilityScore,
      realizedImpliedGap: _clampScore(50 + volChange),
      putSkewChange: _clampScore(35 + downVolumePressure * 0.45),
      eventPremium: _clampScore(35 + volatilityScore * 0.25),
      downsideProtectionDemand: _clampScore(
        0.5 * volatilityScore + 0.5 * downVolumePressure,
      ),
      relativeStrengthDelta: relativeStrength,
      sectorBreadthDelta: _clampScore(50 + return20 * 2),
      revisionDelta: _average([
        neutralMetric ?? template.revisionDelta,
        priceResponse,
      ]),
      priceResponse: priceResponse,
      abnormalDownVolume: downVolumePressure,
      volatilityRepricing: _clampScore(50 + volChange * 1.5),
      peerLeadership: relativeStrength,
      growthExposure: neutralMetric ?? template.growthExposure,
      defensiveExposure: neutralMetric ?? template.defensiveExposure,
      creditSensitivity: neutralMetric ?? template.creditSensitivity,
      rateSensitivity: neutralMetric ?? template.rateSensitivity,
      expectedStability: _average([
        neutralMetric ?? template.expectedStability,
        100 - volatilityScore,
        _clampScore(closeVsSma50 * 55),
      ]),
      peers: hasKnownTemplate ? template.peers : const <RawPeerSignal>[],
    );
  }

  List<RawMarketState> _buildHistoricalStates({
    required _PriceBundle bundle,
    required List<RawStockSignal> fallbackStocks,
    required RawMarketEnvironment fallbackEnvironment,
    required List<RawStyleSignal> fallbackStyles,
    required List<RawSectorSignal> fallbackSectors,
  }) {
    final anchorSeries =
        bundle.benchmarkSeries ?? bundle.stockSeries.values.firstOrNull;
    if (anchorSeries == null) {
      return const <RawMarketState>[];
    }

    final dates = anchorSeries.bars.map((bar) => bar.date).toList()..sort();
    final limit = _configuration.historicalSnapshotLimit;
    final trimmedDates = dates.length > limit
        ? dates.sublist(dates.length - limit)
        : dates;

    final states = <RawMarketState>[];
    for (final date in trimmedDates) {
      final asOf = DateTime(date.year, date.month, date.day, 16);
      final stocks = _buildStocksForDate(
        asOf: asOf,
        bundle: bundle,
        fallbackStocks: fallbackStocks,
      );
      if (stocks.isEmpty) {
        continue;
      }
      states.add(
        RawMarketState(
          asOf: asOf,
          environment: _buildEnvironment(
            asOf: asOf,
            fallback: fallbackEnvironment,
            benchmark: bundle.benchmarkSeries,
            stockSeries: bundle.stockSeries.values,
          ),
          styles: fallbackStyles,
          sectors: _priceAdjustedSectors(fallbackSectors, bundle, asOf: asOf),
          stocks: stocks,
        ),
      );
    }

    return states;
  }

  RawMarketEnvironment _buildEnvironment({
    required DateTime asOf,
    required RawMarketEnvironment fallback,
    required Iterable<AlphaVantageDailySeries> stockSeries,
    AlphaVantageDailySeries? benchmark,
  }) {
    final benchmarkBars =
        benchmark?.bars.where((bar) => !bar.date.isAfter(asOf)).toList() ??
        const <AlphaVantageDailyBar>[];
    final benchmarkReturn20 = _returnPercent(benchmarkBars, 20);
    final benchmarkVol20 = _annualizedVolatility(benchmarkBars, 20);
    final stockReturns = stockSeries
        .map((series) {
          final bars = series.bars
              .where((bar) => !bar.date.isAfter(asOf))
              .toList();
          return _returnPercent(bars, 20);
        })
        .where((value) => value.isFinite)
        .toList();
    final breadth = stockReturns.isEmpty
        ? fallback.breadth
        : stockReturns.where((value) => value > 0).length /
              stockReturns.length *
              100;
    final dispersion = stockReturns.length < 2
        ? fallback.dispersion
        : _standardDeviation(stockReturns) * 8;
    final aboveMajorAverage = stockSeries
        .map((series) {
          final bars = series.bars
              .where((bar) => !bar.date.isAfter(asOf))
              .toList();
          if (bars.length < 50) {
            return null;
          }
          return bars.last.close > _sma(bars, 50);
        })
        .whereType<bool>()
        .toList();
    final pctAboveMajorAverage = aboveMajorAverage.isEmpty
        ? fallback.percentAboveMajorAverages
        : aboveMajorAverage.where((value) => value).length /
              aboveMajorAverage.length *
              100;
    final marketReturn20 = benchmarkBars.isEmpty && stockReturns.isNotEmpty
        ? _average(stockReturns)
        : benchmarkReturn20;
    final equalWeightConfirmation = stockReturns.isEmpty
        ? fallback.equalWeightConfirmation
        : 50 + (_average(stockReturns) - marketReturn20) * 2;

    return RawMarketEnvironment(
      indexTrend: _scoreReturn(marketReturn20, scale: 2.5),
      realizedVolatility: _scoreVolatility(benchmarkVol20),
      impliedVolatility: _clampScore(_scoreVolatility(benchmarkVol20) + 5),
      creditStress: fallback.creditStress,
      financialConditions: fallback.financialConditions,
      growthLeadership: _clampScore(50 + marketReturn20 * 2.2),
      defensiveLeadership: _clampScore(fallback.defensiveLeadership),
      smallCapLeadership: fallback.smallCapLeadership,
      inflationPressure: fallback.inflationPressure,
      breadth: _clampScore(breadth),
      advanceDecline: _clampScore(breadth),
      newHighLow: _clampScore(50 + marketReturn20 * 1.8),
      percentAboveMajorAverages: _clampScore(pctAboveMajorAverage),
      equalWeightConfirmation: _clampScore(equalWeightConfirmation),
      sectorParticipation: _clampScore(breadth),
      correlation: fallback.correlation,
      dispersion: _clampScore(dispersion),
      volumeConcentration: fallback.volumeConcentration,
    );
  }

  List<RawSectorSignal> _priceAdjustedSectors(
    List<RawSectorSignal> fallbackSectors,
    _PriceBundle bundle, {
    DateTime? asOf,
  }) {
    final bySector = <String, List<double>>{};
    for (final series in bundle.stockSeries.values) {
      final stock = bundle.templateByTicker[series.symbol];
      if (stock == null) {
        continue;
      }
      final bars = asOf == null
          ? series.bars
          : series.bars.where((bar) => !bar.date.isAfter(asOf)).toList();
      bySector
          .putIfAbsent(stock.sector, () => <double>[])
          .add(_returnPercent(bars, 20));
    }

    return fallbackSectors.map((sector) {
      final returns = bySector[sector.sector];
      if (returns == null || returns.isEmpty) {
        return sector;
      }
      final priceScore = _scoreReturn(_average(returns), scale: 2.5);
      return RawSectorSignal(
        sector: sector.sector,
        strength: _average([sector.strength, priceScore]),
        breadth: _clampScore(
          returns.where((value) => value > 0).length / returns.length * 100,
        ),
        revisions: sector.revisions,
        sponsorship: _average([sector.sponsorship, priceScore]),
        crowdingRisk: sector.crowdingRisk,
        note:
            '${sector.note} Alpha Vantage daily prices are now contributing to sector price breadth.',
      );
    }).toList();
  }

  DateTime? _latestSeriesDate(Iterable<AlphaVantageDailySeries> seriesList) {
    DateTime? latest;
    for (final series in seriesList) {
      if (series.bars.isEmpty) {
        continue;
      }
      final date = series.bars.last.date;
      latest = latest == null || date.isAfter(latest) ? date : latest;
    }
    return latest == null
        ? null
        : DateTime(latest.year, latest.month, latest.day, 16);
  }

  double _returnPercent(List<AlphaVantageDailyBar> bars, int lookback) {
    if (bars.length < 2) {
      return 0;
    }
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final last = ordered.last.close;
    final referenceIndex = math.max(0, ordered.length - 1 - lookback);
    final reference = ordered[referenceIndex].close;
    if (reference <= 0) {
      return 0;
    }
    return (last / reference - 1) * 100;
  }

  double _annualizedVolatility(List<AlphaVantageDailyBar> bars, int lookback) {
    final returns = _dailyReturns(bars, lookback);
    if (returns.length < 2) {
      return 20;
    }
    return _standardDeviation(returns) * math.sqrt(252) * 100;
  }

  List<double> _dailyReturns(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final start = math.max(1, ordered.length - lookback);
    final returns = <double>[];
    for (var index = start; index < ordered.length; index++) {
      final previous = ordered[index - 1].close;
      if (previous <= 0) {
        continue;
      }
      returns.add(ordered[index].close / previous - 1);
    }
    return returns;
  }

  double _averageVolume(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final recent = ordered.length > lookback
        ? ordered.sublist(ordered.length - lookback)
        : ordered;
    return recent.isEmpty
        ? 1
        : recent.map((bar) => bar.volume).reduce((a, b) => a + b) /
              recent.length;
  }

  double _high(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final recent = ordered.length > lookback
        ? ordered.sublist(ordered.length - lookback)
        : ordered;
    return recent.map((bar) => bar.high).fold<double>(0, math.max);
  }

  double _sma(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final recent = ordered.length > lookback
        ? ordered.sublist(ordered.length - lookback)
        : ordered;
    if (recent.isEmpty) {
      return 0;
    }
    return recent.map((bar) => bar.close).reduce((a, b) => a + b) /
        recent.length;
  }

  double _downVolumePressure(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final start = math.max(1, ordered.length - lookback);
    final downVolumes = <double>[];
    final allVolumes = <double>[];
    for (var index = start; index < ordered.length; index++) {
      allVolumes.add(ordered[index].volume);
      if (ordered[index].close < ordered[index - 1].close) {
        downVolumes.add(ordered[index].volume);
      }
    }
    if (allVolumes.isEmpty) {
      return 50;
    }
    final avgAll = _average(allVolumes);
    final avgDown = downVolumes.isEmpty ? 0 : _average(downVolumes);
    return _clampScore(35 + (avgDown / math.max(1, avgAll)) * 45);
  }

  double _upDayRate(List<AlphaVantageDailyBar> bars, int lookback) {
    final ordered = [...bars]
      ..sort((left, right) => left.date.compareTo(right.date));
    final start = math.max(1, ordered.length - lookback);
    var upDays = 0;
    var observations = 0;
    for (var index = start; index < ordered.length; index++) {
      observations++;
      if (ordered[index].close > ordered[index - 1].close) {
        upDays++;
      }
    }
    return observations == 0 ? 50 : upDays / observations * 100;
  }

  double _scoreReturn(double returnPercent, {required double scale}) {
    return _clampScore(50 + returnPercent * scale);
  }

  double _scoreVolatility(double annualizedVolatility) {
    return _clampScore(35 + annualizedVolatility * 1.1);
  }

  double _average(Iterable<double> values) {
    final list = values.where((value) => value.isFinite).toList();
    if (list.isEmpty) {
      return 50;
    }
    return list.reduce((left, right) => left + right) / list.length;
  }

  double _standardDeviation(List<double> values) {
    if (values.length < 2) {
      return 0;
    }
    final mean = _average(values);
    final variance =
        values
            .map((value) => math.pow(value - mean, 2).toDouble())
            .reduce((a, b) => a + b) /
        values.length;
    return math.sqrt(variance);
  }

  double _clampScore(double value) {
    if (value < 0) {
      return 0;
    }
    if (value > 100) {
      return 100;
    }
    return value;
  }
}

class AlphaVantageDailySeries {
  const AlphaVantageDailySeries({
    required this.symbol,
    required this.fetchedAt,
    required this.bars,
  });

  final String symbol;
  final DateTime fetchedAt;
  final List<AlphaVantageDailyBar> bars;

  Map<String, dynamic> toJson() => {
    'symbol': symbol,
    'fetchedAt': fetchedAt.toIso8601String(),
    'bars': bars.map((bar) => bar.toJson()).toList(),
  };

  factory AlphaVantageDailySeries.fromJson(Map<String, dynamic> json) {
    return AlphaVantageDailySeries(
      symbol: json['symbol'] as String,
      fetchedAt: DateTime.parse(json['fetchedAt'] as String),
      bars:
          (json['bars'] as List<dynamic>)
              .map(
                (bar) =>
                    AlphaVantageDailyBar.fromJson(bar as Map<String, dynamic>),
              )
              .toList()
            ..sort((left, right) => left.date.compareTo(right.date)),
    );
  }

  factory AlphaVantageDailySeries.fromResponse({
    required String symbol,
    required String body,
    required DateTime fetchedAt,
  }) {
    final decoded = jsonDecode(body) as Map<String, dynamic>;
    final error =
        decoded['Error Message'] ?? decoded['Note'] ?? decoded['Information'];
    if (error != null) {
      throw StateError(error.toString());
    }

    final rawSeries = decoded['Time Series (Daily)'];
    if (rawSeries is! Map<String, dynamic>) {
      throw StateError('Alpha Vantage response did not include daily prices.');
    }

    final bars = rawSeries.entries.map((entry) {
      final values = entry.value as Map<String, dynamic>;
      return AlphaVantageDailyBar(
        date: DateTime.parse(entry.key),
        open: _readAlphaNumber(values, '1. open'),
        high: _readAlphaNumber(values, '2. high'),
        low: _readAlphaNumber(values, '3. low'),
        close: _readAlphaNumber(values, '4. close'),
        volume: _readAlphaNumber(values, '5. volume'),
      );
    }).toList()..sort((left, right) => left.date.compareTo(right.date));

    if (bars.isEmpty) {
      throw StateError('Alpha Vantage response contained no price bars.');
    }

    return AlphaVantageDailySeries(
      symbol: symbol,
      fetchedAt: fetchedAt,
      bars: bars,
    );
  }
}

class AlphaVantageDailyBar {
  const AlphaVantageDailyBar({
    required this.date,
    required this.open,
    required this.high,
    required this.low,
    required this.close,
    required this.volume,
  });

  final DateTime date;
  final double open;
  final double high;
  final double low;
  final double close;
  final double volume;

  Map<String, dynamic> toJson() => {
    'date': date.toIso8601String(),
    'open': open,
    'high': high,
    'low': low,
    'close': close,
    'volume': volume,
  };

  factory AlphaVantageDailyBar.fromJson(Map<String, dynamic> json) {
    return AlphaVantageDailyBar(
      date: DateTime.parse(json['date'] as String),
      open: (json['open'] as num).toDouble(),
      high: (json['high'] as num).toDouble(),
      low: (json['low'] as num).toDouble(),
      close: (json['close'] as num).toDouble(),
      volume: (json['volume'] as num).toDouble(),
    );
  }
}

class AlphaVantagePriceCacheStore {
  AlphaVantagePriceCacheStore({
    this.priceCacheKey = 'finance_oracle_alpha_vantage_price_cache_v1',
    this.quotaCacheKey = 'finance_oracle_alpha_vantage_quota_v1',
  });

  final String priceCacheKey;
  final String quotaCacheKey;

  Future<AlphaVantageDailySeries?> loadSeries(String symbol) async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(priceCacheKey);
    if (raw == null || raw.isEmpty) {
      return null;
    }
    try {
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      final seriesJson = decoded[symbol] as Map<String, dynamic>?;
      return seriesJson == null
          ? null
          : AlphaVantageDailySeries.fromJson(seriesJson);
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSeries(AlphaVantageDailySeries series) async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(priceCacheKey);
    final decoded = _decodeCache(raw);
    decoded[series.symbol] = series.toJson();
    await preferences.setString(priceCacheKey, jsonEncode(decoded));
  }

  Map<String, dynamic> _decodeCache(String? raw) {
    if (raw == null || raw.isEmpty) {
      return <String, dynamic>{};
    }
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<AlphaVantageQuotaState> loadQuota() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(quotaCacheKey);
    if (raw == null || raw.isEmpty) {
      return AlphaVantageQuotaState.today();
    }
    try {
      final quota = AlphaVantageQuotaState.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      );
      return quota.isToday ? quota : AlphaVantageQuotaState.today();
    } catch (_) {
      return AlphaVantageQuotaState.today();
    }
  }

  Future<void> recordRequest() async {
    final preferences = await SharedPreferences.getInstance();
    final quota = await loadQuota();
    await preferences.setString(
      quotaCacheKey,
      quota.copyWith(requestsUsed: quota.requestsUsed + 1).toJson(),
    );
  }
}

class AlphaVantageQuotaState {
  const AlphaVantageQuotaState({required this.day, required this.requestsUsed});

  final String day;
  final int requestsUsed;

  bool get isToday => day == _todayKey();

  bool canUse(int limit) => isToday && requestsUsed < limit;

  AlphaVantageQuotaState copyWith({int? requestsUsed}) {
    return AlphaVantageQuotaState(
      day: day,
      requestsUsed: requestsUsed ?? this.requestsUsed,
    );
  }

  String toJson() => jsonEncode({'day': day, 'requestsUsed': requestsUsed});

  factory AlphaVantageQuotaState.today() {
    return AlphaVantageQuotaState(day: _todayKey(), requestsUsed: 0);
  }

  factory AlphaVantageQuotaState.fromJson(Map<String, dynamic> json) {
    return AlphaVantageQuotaState(
      day: json['day'] as String,
      requestsUsed: json['requestsUsed'] as int? ?? 0,
    );
  }

  static String _todayKey() {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
  }
}

class _PriceBundle {
  _PriceBundle({
    required this.requestedSymbols,
    required this.stockSeries,
    required this.benchmarkSeries,
    required this.latestAsOf,
    required this.networkRequests,
    required this.messages,
    required this.templateByTicker,
  });

  final List<String> requestedSymbols;
  final Map<String, AlphaVantageDailySeries> stockSeries;
  final AlphaVantageDailySeries? benchmarkSeries;
  final DateTime latestAsOf;
  final int networkRequests;
  final List<String> messages;
  final Map<String, RawStockSignal> templateByTicker;

  bool get hasAlphaData => stockSeries.isNotEmpty;

  String get summary {
    final missing = requestedSymbols.length - stockSeries.length;
    final requestText = networkRequests == 1 ? 'request' : 'requests';
    final missingText = missing <= 0
        ? ''
        : ' $missing symbols still need cache coverage.';
    return '${stockSeries.length}/${requestedSymbols.length} requested symbols have price history; $networkRequests Alpha Vantage $requestText used this run.$missingText';
  }
}

class _SeriesLoadResult {
  const _SeriesLoadResult({
    this.series,
    this.usedNetwork = false,
    this.message,
  });

  final AlphaVantageDailySeries? series;
  final bool usedNetwork;
  final String? message;
}

double _readAlphaNumber(Map<String, dynamic> values, String key) {
  final raw = values[key];
  if (raw is num) {
    return raw.toDouble();
  }
  if (raw is String) {
    return double.parse(raw.replaceAll(',', ''));
  }
  throw StateError('Alpha Vantage response is missing $key.');
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
