import 'dart:math' as math;

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'alpha_vantage_models.dart';
import 'alpha_vantage_store.dart';
import 'alpha_vantage_store_factory.dart';
import 'local_secrets.dart' as local;
import 'market_data_configuration.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';
import 'yahoo_finance_feed_provider.dart';

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

abstract class SupplementalDataStatusProvider {
  Future<List<DataFeedStatus>> loadSupplementalFeedStatuses();
}

class AlphaVantageMarketFeedProvider
    implements
        MarketEnvironmentProvider,
        StyleSignalProvider,
        SectorSignalProvider,
        StockSignalProvider,
        ValidationWindowProvider,
        HistoricalMarketStateProvider,
        SupplementalDataStatusProvider {
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
  Future<List<DataFeedStatus>> loadSupplementalFeedStatuses() async {
    final snapshot = await _cacheStore.loadSnapshot();
    final storeAvailability = snapshot.hasHistory
        ? FeedAvailability.connected
        : FeedAvailability.missing;
    final syncAvailability = snapshot.sync.hasSuccessfulSync
        ? FeedAvailability.connected
        : FeedAvailability.planned;
    final coverageRange =
        snapshot.coverageStart == null || snapshot.coverageEnd == null
        ? 'Coverage will appear after the first successful sync.'
        : 'Coverage spans ${snapshot.coverageStart!.toIso8601String()} through ${snapshot.coverageEnd!.toIso8601String()}.';
    final nextSyncText = snapshot.sync.nextEligibleSyncAt == null
        ? 'A sync can run on the next refresh.'
        : 'Next eligible sync after ${snapshot.sync.nextEligibleSyncAt!.toIso8601String()}.';
    final requestedCount = snapshot.sync.requestedSymbols.length;
    final availableCount = snapshot.sync.availableSymbols.length;
    final missingCount = snapshot.sync.missingSymbols.length;

    return [
      DataFeedStatus(
        name: 'Alpha Vantage local store',
        availability: storeAvailability,
        refreshCadence: FeedRefreshCadence.daily,
        detail:
            'Stored $availableCount/$requestedCount requested symbols across ${snapshot.cachedBarCount} daily bars. $coverageRange',
        lastUpdated: snapshot.coverageEnd,
      ),
      DataFeedStatus(
        name: 'Alpha Vantage sync cadence',
        availability: syncAvailability,
        refreshCadence: FeedRefreshCadence.intraday,
        detail:
            '${snapshot.sync.summary ?? 'The sync pipeline is ready but has not populated local history yet.'} $nextSyncText ${missingCount > 0 ? '$missingCount requested symbols are still waiting for local coverage.' : 'All requested symbols in the current run have local coverage.'}',
        lastUpdated:
            snapshot.sync.lastSuccessfulSyncAt ?? snapshot.sync.lastAttemptedAt,
      ),
    ];
  }

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
    final now = DateTime.now();
    final previousSync = await _cacheStore.loadSyncState();
    final allowNetwork = previousSync.isDue(now);
    if (!allowNetwork && previousSync.nextEligibleSyncAt != null) {
      messages.add(
        'Local store is warm, so the next vendor sync waits until ${previousSync.nextEligibleSyncAt!.toIso8601String()}.',
      );
    }
    var networkRequests = 0;
    var successfulFetches = 0;

    for (final symbol in requestedSymbols) {
      final result = await _loadSeries(symbol, allowNetwork: allowNetwork);
      if (result.series != null) {
        seriesBySymbol[symbol] = result.series!;
      }
      if (result.usedNetwork) {
        networkRequests++;
        if (result.series != null) {
          successfulFetches++;
        }
      }
      if (result.message != null) {
        messages.add(result.message!);
      }
    }

    // Yahoo Finance fallback for symbols Alpha Vantage couldn't provide.
    // Covers the 75+ stocks/day beyond AV's free-tier quota.
    final yahooBackfilled = await _backfillFromYahoo(
      requestedSymbols: requestedSymbols,
      seriesBySymbol: seriesBySymbol,
      now: now,
    );
    if (yahooBackfilled > 0) {
      messages.add(
        'Yahoo Finance filled $yahooBackfilled symbol(s) that were beyond the Alpha Vantage daily quota.',
      );
    }

    final benchmark = seriesBySymbol[benchmarkSymbol];
    final stockSeries = {
      for (final symbol in symbols)
        if (seriesBySymbol.containsKey(symbol)) symbol: seriesBySymbol[symbol]!,
    };
    final latestAsOf = _latestSeriesDate([...stockSeries.values, ?benchmark]);
    final availableSymbols =
        requestedSymbols
            .where((symbol) => seriesBySymbol.containsKey(symbol))
            .toList()
          ..sort();
    final missingSymbols =
        requestedSymbols
            .where((symbol) => !seriesBySymbol.containsKey(symbol))
            .toList()
          ..sort();
    final syncState = AlphaVantageSyncState(
      lastAttemptedAt: allowNetwork ? now : previousSync.lastAttemptedAt,
      lastSuccessfulSyncAt: successfulFetches > 0
          ? now
          : previousSync.lastSuccessfulSyncAt,
      nextEligibleSyncAt: allowNetwork
          ? now.add(
              Duration(minutes: _configuration.alphaVantageSyncIntervalMinutes),
            )
          : previousSync.nextEligibleSyncAt,
      requestedSymbols: [...requestedSymbols]..sort(),
      availableSymbols: availableSymbols,
      missingSymbols: missingSymbols,
      networkRequestsUsed: networkRequests,
      summary: _syncSummary(
        allowNetwork: allowNetwork,
        availableCount: availableSymbols.length,
        requestedCount: requestedSymbols.length,
        networkRequests: networkRequests,
        missingCount: missingSymbols.length,
      ),
      messages: messages,
    );
    await _saveSyncState(syncState);

    return _PriceBundle(
      requestedSymbols: symbols,
      stockSeries: stockSeries,
      benchmarkSeries: benchmark,
      latestAsOf: latestAsOf ?? DateTime.now(),
      networkRequests: networkRequests,
      messages: messages,
      syncState: syncState,
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

  /// After the Alpha Vantage pass, try Yahoo Finance for any requested symbol
  /// whose series is still missing. Yahoo's free endpoint covers the full
  /// universe — its only limitation is CORS for direct browser calls, which
  /// the configured CORS proxy works around.
  ///
  /// Requests run in batches of 10 concurrent calls to keep total wall time
  /// under a minute even for 300-symbol universes.
  Future<int> _backfillFromYahoo({
    required Iterable<String> requestedSymbols,
    required Map<String, AlphaVantageDailySeries> seriesBySymbol,
    required DateTime now,
  }) async {
    final missing = requestedSymbols
        .where((symbol) => !seriesBySymbol.containsKey(symbol))
        .toList();
    if (missing.isEmpty) return 0;

    final yahoo = YahooFinanceFeedProvider(
      symbols: missing,
      corsProxyPrefix: local.kCorsProxyPrefix,
    );

    const concurrency = 10;
    var filled = 0;

    for (var start = 0; start < missing.length; start += concurrency) {
      final end = math.min(start + concurrency, missing.length);
      final batch = missing.sublist(start, end);
      final results = await Future.wait(
        batch.map(
          (symbol) => yahoo
              .loadDailyBars(symbol, rangeDays: 365)
              .then((bars) => MapEntry(symbol, bars)),
        ),
      );
      for (final entry in results) {
        final bars = entry.value;
        if (bars == null || bars.bars.isEmpty) continue;
        final converted = AlphaVantageDailySeries(
          symbol: entry.key,
          fetchedAt: now,
          bars:
              bars.bars
                  .map(
                    (bar) => AlphaVantageDailyBar(
                      date: bar.date,
                      open: bar.open,
                      high: bar.high,
                      low: bar.low,
                      close: bar.close,
                      volume: bar.volume,
                    ),
                  )
                  .toList()
                ..sort((a, b) => a.date.compareTo(b.date)),
        );
        seriesBySymbol[entry.key] = converted;
        await _saveSeries(converted);
        filled++;
      }
    }
    return filled;
  }

  Future<_SeriesLoadResult> _loadSeries(
    String symbol, {
    required bool allowNetwork,
  }) async {
    final cached = await _cacheStore.loadSeries(symbol);
    if (_isFresh(cached)) {
      return _SeriesLoadResult(series: cached);
    }

    if (!allowNetwork) {
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
      final uri = _alphaVantageUri({
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

  Future<void> _saveSyncState(AlphaVantageSyncState syncState) async {
    try {
      await _cacheStore.saveSyncState(syncState);
    } catch (_) {
      // The live run should still work even if sync metadata fails to persist.
    }
  }

  Uri _alphaVantageUri(Map<String, String> queryParameters) {
    final proxyUrl = _configuration.alphaVantageProxyUrl;
    if (proxyUrl == null || proxyUrl.isEmpty) {
      return Uri.https('www.alphavantage.co', '/query', queryParameters);
    }

    final baseUri = Uri.parse(proxyUrl);
    final mergedQuery = <String, String>{
      ...baseUri.queryParameters,
      ...queryParameters,
    };

    return baseUri.replace(queryParameters: mergedQuery);
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

  String _syncSummary({
    required bool allowNetwork,
    required int availableCount,
    required int requestedCount,
    required int networkRequests,
    required int missingCount,
  }) {
    if (!allowNetwork) {
      return 'The app is currently reading from the local store instead of hitting Alpha Vantage again.';
    }
    final requestLabel = networkRequests == 1 ? 'request' : 'requests';
    return 'This sync cycle populated $availableCount/$requestedCount requested symbols and used $networkRequests vendor $requestLabel. ${missingCount > 0 ? '$missingCount symbols are still waiting for history.' : 'Local coverage is complete for the current request set.'}';
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
      lastPrice: latest.close,
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

class AlphaVantagePriceCacheStore {
  AlphaVantagePriceCacheStore({
    String? storeKey,
    String? priceCacheKey,
    String? quotaCacheKey,
    AlphaVantageLocalStore? localStore,
  }) : _localStore =
           localStore ??
           createDefaultAlphaVantageLocalStore(
             preferencesKey:
                 storeKey ??
                 priceCacheKey ??
                 quotaCacheKey ??
                 'finance_oracle_alpha_vantage_store_v1',
           ),
       storeKey =
           storeKey ??
           priceCacheKey ??
           quotaCacheKey ??
           'finance_oracle_alpha_vantage_store_v1';

  final String storeKey;
  final AlphaVantageLocalStore _localStore;

  Future<AlphaVantageDailySeries?> loadSeries(String symbol) async {
    final state = await _localStore.load();
    return state.seriesBySymbol[symbol];
  }

  Future<void> saveSeries(AlphaVantageDailySeries series) async {
    final state = await _localStore.load();
    final nextSeries = Map<String, AlphaVantageDailySeries>.from(
      state.seriesBySymbol,
    );
    nextSeries[series.symbol] = series;
    await _localStore.save(state.copyWith(seriesBySymbol: nextSeries));
  }

  Future<AlphaVantageQuotaState> loadQuota() async {
    final state = await _localStore.load();
    return state.quota.isToday ? state.quota : AlphaVantageQuotaState.today();
  }

  Future<void> recordRequest() async {
    final state = await _localStore.load();
    final quota = state.quota.isToday
        ? state.quota
        : AlphaVantageQuotaState.today();
    await _localStore.save(
      state.copyWith(
        quota: quota.copyWith(requestsUsed: quota.requestsUsed + 1),
      ),
    );
  }

  Future<AlphaVantageSyncState> loadSyncState() async {
    final state = await _localStore.load();
    return state.sync;
  }

  Future<void> saveSyncState(AlphaVantageSyncState syncState) async {
    final state = await _localStore.load();
    await _localStore.save(state.copyWith(sync: syncState));
  }

  Future<AlphaVantageStoreSnapshot> loadSnapshot() async {
    final state = await _localStore.load();
    final seriesList = state.seriesBySymbol.values.toList();
    DateTime? coverageStart;
    DateTime? coverageEnd;
    var cachedBarCount = 0;
    for (final series in seriesList) {
      cachedBarCount += series.bars.length;
      if (series.bars.isEmpty) {
        continue;
      }
      final seriesStart = series.bars.first.date;
      final seriesEnd = series.bars.last.date;
      coverageStart =
          coverageStart == null || seriesStart.isBefore(coverageStart)
          ? seriesStart
          : coverageStart;
      coverageEnd = coverageEnd == null || seriesEnd.isAfter(coverageEnd)
          ? seriesEnd
          : coverageEnd;
    }

    return AlphaVantageStoreSnapshot(
      sync: state.sync,
      quota: state.quota.isToday ? state.quota : AlphaVantageQuotaState.today(),
      cachedSymbolCount: state.seriesBySymbol.length,
      cachedBarCount: cachedBarCount,
      coverageStart: coverageStart,
      coverageEnd: coverageEnd,
    );
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
    required this.syncState,
    required this.templateByTicker,
  });

  final List<String> requestedSymbols;
  final Map<String, AlphaVantageDailySeries> stockSeries;
  final AlphaVantageDailySeries? benchmarkSeries;
  final DateTime latestAsOf;
  final int networkRequests;
  final List<String> messages;
  final AlphaVantageSyncState syncState;
  final Map<String, RawStockSignal> templateByTicker;

  bool get hasAlphaData => stockSeries.isNotEmpty;

  String get summary {
    final missing = requestedSymbols.length - stockSeries.length;
    final requestText = networkRequests == 1 ? 'request' : 'requests';
    final missingText = missing <= 0
        ? ''
        : ' $missing symbols still need cache coverage.';
    final syncText = syncState.summary == null ? '' : ' ${syncState.summary}';
    return '${stockSeries.length}/${requestedSymbols.length} requested symbols have price history; $networkRequests Alpha Vantage $requestText used this run.$missingText$syncText';
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

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
