import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

/// Finnhub.io free tier: 60 req/min, real fundamentals + recommendation
/// trends + news sentiment. CORS-friendly so it works from the browser.
/// https://finnhub.io/docs/api
class FinnhubFeedProvider {
  FinnhubFeedProvider({
    required this.apiKey,
    required this.symbols,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiKey;
  final List<String> symbols;
  final http.Client _client;

  static const String _base = 'https://finnhub.io/api/v1';

  bool get isConfigured => apiKey.trim().isNotEmpty;

  Future<FinnhubCompanyProfile?> loadCompanyProfile(String symbol) async {
    if (!isConfigured) return null;
    final uri = Uri.parse(
      '$_base/stock/profile2?symbol=${Uri.encodeComponent(symbol)}&token=$apiKey',
    );
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200 || response.body.isEmpty) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic> || decoded.isEmpty) return null;
      return FinnhubCompanyProfile(
        symbol: symbol,
        name: (decoded['name'] as String?) ?? symbol,
        industry: (decoded['finnhubIndustry'] as String?) ?? 'Unclassified',
        exchange: (decoded['exchange'] as String?) ?? '',
        marketCap: _asDouble(decoded['marketCapitalization']),
        shareOutstanding: _asDouble(decoded['shareOutstanding']),
        country: (decoded['country'] as String?) ?? '',
        currency: (decoded['currency'] as String?) ?? '',
      );
    } catch (_) {
      return null;
    }
  }

  Future<FinnhubRecommendation?> loadRecommendation(String symbol) async {
    if (!isConfigured) return null;
    final uri = Uri.parse(
      '$_base/stock/recommendation?symbol=${Uri.encodeComponent(symbol)}&token=$apiKey',
    );
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body) as List<dynamic>?;
      if (decoded == null || decoded.isEmpty) return null;
      final latest = decoded.first as Map<String, dynamic>;
      return FinnhubRecommendation(
        symbol: symbol,
        buy: _asInt(latest['buy']),
        hold: _asInt(latest['hold']),
        sell: _asInt(latest['sell']),
        strongBuy: _asInt(latest['strongBuy']),
        strongSell: _asInt(latest['strongSell']),
        period: (latest['period'] as String?) ?? '',
      );
    } catch (_) {
      return null;
    }
  }

  Future<FinnhubMetrics?> loadMetrics(String symbol) async {
    if (!isConfigured) return null;
    final uri = Uri.parse(
      '$_base/stock/metric?symbol=${Uri.encodeComponent(symbol)}&metric=all&token=$apiKey',
    );
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body) as Map<String, dynamic>?;
      final metric = decoded?['metric'] as Map<String, dynamic>?;
      if (metric == null) return null;
      return FinnhubMetrics(
        symbol: symbol,
        peRatio: _asDouble(metric['peNormalizedAnnual']),
        forwardPE: _asDouble(metric['peInclExtraTTM']),
        priceToBook: _asDouble(metric['pbAnnual']),
        dividendYield: _asDouble(metric['dividendYieldIndicatedAnnual']),
        roeTTM: _asDouble(metric['roeTTM']),
        netMargin: _asDouble(metric['netMarginAnnual']),
        revenueGrowthTTM: _asDouble(metric['revenueGrowthTTMYoy']),
        epsGrowthTTM: _asDouble(metric['epsGrowthTTMYoy']),
        debtToEquity: _asDouble(metric['totalDebt/totalEquityAnnual']),
        beta: _asDouble(metric['beta']),
        week52High: _asDouble(metric['52WeekHigh']),
        week52Low: _asDouble(metric['52WeekLow']),
      );
    } catch (_) {
      return null;
    }
  }

  Future<FinnhubQuote?> loadQuote(String symbol) async {
    if (!isConfigured) return null;
    final uri = Uri.parse(
      '$_base/quote?symbol=${Uri.encodeComponent(symbol)}&token=$apiKey',
    );
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body) as Map<String, dynamic>?;
      if (decoded == null) return null;
      return FinnhubQuote(
        symbol: symbol,
        current: _asDouble(decoded['c']) ?? 0,
        change: _asDouble(decoded['d']) ?? 0,
        changePct: _asDouble(decoded['dp']) ?? 0,
        high: _asDouble(decoded['h']) ?? 0,
        low: _asDouble(decoded['l']) ?? 0,
        open: _asDouble(decoded['o']) ?? 0,
        previousClose: _asDouble(decoded['pc']) ?? 0,
      );
    } catch (_) {
      return null;
    }
  }

  Future<FeedSlice<FinnhubUniverse>> probe() async {
    if (!isConfigured) {
      return FeedSlice(
        name: 'Finnhub fundamentals',
        source: 'finnhub',
        asOf: DateTime.now(),
        data: const FinnhubUniverse(profilesBySymbol: {}),
        availability: FeedAvailability.missing,
        refreshCadence: FeedRefreshCadence.intraday,
        detail:
            'Finnhub key not set. Paste a free key from finnhub.io into kFinnhubApiKey in local_secrets.dart to activate fundamentals, recommendations, and quotes.',
      );
    }

    final loaded = <String, FinnhubCompanyProfile>{};
    final metrics = <String, FinnhubMetrics>{};
    final recommendations = <String, FinnhubRecommendation>{};
    for (final symbol in symbols.take(5)) {
      final profile = await loadCompanyProfile(symbol);
      if (profile != null) loaded[symbol] = profile;
      final metricData = await loadMetrics(symbol);
      if (metricData != null) metrics[symbol] = metricData;
      final rec = await loadRecommendation(symbol);
      if (rec != null) recommendations[symbol] = rec;
    }

    return FeedSlice(
      name: 'Finnhub fundamentals',
      source: 'finnhub',
      asOf: DateTime.now(),
      data: FinnhubUniverse(
        profilesBySymbol: loaded,
        metricsBySymbol: metrics,
        recommendationsBySymbol: recommendations,
      ),
      availability: loaded.isEmpty
          ? FeedAvailability.missing
          : FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.intraday,
      detail: loaded.isEmpty
          ? 'Finnhub key present but returned no data. Check the key is valid and the symbols are US equities.'
          : 'Finnhub supplied profiles for ${loaded.length} symbols, metrics for ${metrics.length}, recommendations for ${recommendations.length}. Full universe coverage syncs progressively on each background refresh.',
    );
  }
}

class FinnhubFundamentalsOverlayStockProvider implements StockSignalProvider {
  FinnhubFundamentalsOverlayStockProvider({
    required StockSignalProvider fallbackProvider,
    required FinnhubFeedProvider finnhubProvider,
    this.maxSymbolsPerRefresh = 20,
  }) : _fallbackProvider = fallbackProvider,
       _finnhubProvider = finnhubProvider;

  final StockSignalProvider _fallbackProvider;
  final FinnhubFeedProvider _finnhubProvider;
  final int maxSymbolsPerRefresh;

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() async {
    final fallback = await _fallbackProvider.loadStockSignals();
    if (!_finnhubProvider.isConfigured) {
      return fallback;
    }

    final enriched = <RawStockSignal>[];
    var overlayCount = 0;
    for (final stock in fallback.data) {
      if (overlayCount >= maxSymbolsPerRefresh) {
        enriched.add(stock);
        continue;
      }
      final metrics = await _finnhubProvider.loadMetrics(stock.ticker);
      final recommendation = await _finnhubProvider.loadRecommendation(
        stock.ticker,
      );
      if (metrics == null && recommendation == null) {
        enriched.add(stock);
        continue;
      }
      enriched.add(_overlay(stock, metrics, recommendation));
      overlayCount++;
    }

    if (overlayCount == 0) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source}+finnhub-fundamentals',
      asOf: DateTime.now(),
      data: enriched,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.intraday,
      detail:
          '${fallback.detail} Finnhub overlaid live fundamentals/recommendation inputs for $overlayCount symbols this refresh.',
    );
  }

  RawStockSignal _overlay(
    RawStockSignal stock,
    FinnhubMetrics? metrics,
    FinnhubRecommendation? recommendation,
  ) {
    final profitability = _scoreHigh(
      _first(metrics?.roeTTM, metrics?.netMargin),
      scale: 1.8,
      neutral: stock.profitability,
    );
    final revenueTrend = _scoreHigh(
      metrics?.revenueGrowthTTM,
      scale: 2.0,
      neutral: stock.revenueTrend,
    );
    final earningsTrend = _scoreHigh(
      metrics?.epsGrowthTTM,
      scale: 1.8,
      neutral: stock.earningsSurprise,
    );
    final leverageQuality = _scoreLow(
      metrics?.debtToEquity,
      scale: 18,
      neutral: stock.leverageQuality,
    );
    final valuationSupport = _valuationScore(
      metrics?.forwardPE ?? metrics?.peRatio,
      stock.valuationSupport,
    );
    final revisionScore = recommendation == null || recommendation.total == 0
        ? stock.earningsRevisions
        : (recommendation.bullishShare * 100 - recommendation.bearishShare * 45)
              .clamp(0, 100)
              .toDouble();

    return stock.copyWith(
      earningsRevisions: _blend(stock.earningsRevisions, revisionScore, 0.65),
      earningsSurprise: _blend(stock.earningsSurprise, earningsTrend, 0.45),
      marginTrend: _blend(stock.marginTrend, profitability, 0.45),
      revenueTrend: _blend(stock.revenueTrend, revenueTrend, 0.55),
      freeCashFlowTrend: _blend(stock.freeCashFlowTrend, profitability, 0.35),
      balanceSheetQuality: _blend(
        stock.balanceSheetQuality,
        leverageQuality,
        0.45,
      ),
      profitability: _blend(stock.profitability, profitability, 0.55),
      leverageQuality: _blend(stock.leverageQuality, leverageQuality, 0.55),
      earningsStability: _blend(
        stock.earningsStability,
        _average([profitability, leverageQuality]),
        0.35,
      ),
      valuationSupport: _blend(stock.valuationSupport, valuationSupport, 0.45),
      revisionDelta: _blend(stock.revisionDelta, revisionScore, 0.45),
    );
  }

  double? _first(double? left, double? right) => left ?? right;

  double _scoreHigh(
    double? value, {
    required double scale,
    required double neutral,
  }) {
    if (value == null) return neutral;
    return (50 + value * scale).clamp(0, 100).toDouble();
  }

  double _scoreLow(
    double? value, {
    required double scale,
    required double neutral,
  }) {
    if (value == null) return neutral;
    return (78 - value * scale).clamp(0, 100).toDouble();
  }

  double _valuationScore(double? pe, double neutral) {
    if (pe == null || pe <= 0) return neutral;
    if (pe <= 12) return 82;
    if (pe <= 22) return 70;
    if (pe <= 35) return 56;
    if (pe <= 55) return 42;
    return 30;
  }

  double _blend(double oldValue, double newValue, double weight) {
    return (oldValue * (1 - weight) + newValue * weight)
        .clamp(0, 100)
        .toDouble();
  }

  double _average(List<double> values) {
    if (values.isEmpty) return 50;
    return values.reduce((left, right) => left + right) / values.length;
  }
}

class FinnhubCompanyProfile {
  const FinnhubCompanyProfile({
    required this.symbol,
    required this.name,
    required this.industry,
    required this.exchange,
    required this.country,
    required this.currency,
    this.marketCap,
    this.shareOutstanding,
  });

  final String symbol;
  final String name;
  final String industry;
  final String exchange;
  final String country;
  final String currency;
  final double? marketCap;
  final double? shareOutstanding;
}

class FinnhubRecommendation {
  const FinnhubRecommendation({
    required this.symbol,
    required this.buy,
    required this.hold,
    required this.sell,
    required this.strongBuy,
    required this.strongSell,
    required this.period,
  });

  final String symbol;
  final int buy;
  final int hold;
  final int sell;
  final int strongBuy;
  final int strongSell;
  final String period;

  int get total => buy + hold + sell + strongBuy + strongSell;

  double get bullishShare => total == 0 ? 0 : (buy + strongBuy) / total;
  double get bearishShare => total == 0 ? 0 : (sell + strongSell) / total;
}

class FinnhubMetrics {
  const FinnhubMetrics({
    required this.symbol,
    this.peRatio,
    this.forwardPE,
    this.priceToBook,
    this.dividendYield,
    this.roeTTM,
    this.netMargin,
    this.revenueGrowthTTM,
    this.epsGrowthTTM,
    this.debtToEquity,
    this.beta,
    this.week52High,
    this.week52Low,
  });

  final String symbol;
  final double? peRatio;
  final double? forwardPE;
  final double? priceToBook;
  final double? dividendYield;
  final double? roeTTM;
  final double? netMargin;
  final double? revenueGrowthTTM;
  final double? epsGrowthTTM;
  final double? debtToEquity;
  final double? beta;
  final double? week52High;
  final double? week52Low;
}

class FinnhubQuote {
  const FinnhubQuote({
    required this.symbol,
    required this.current,
    required this.change,
    required this.changePct,
    required this.high,
    required this.low,
    required this.open,
    required this.previousClose,
  });

  final String symbol;
  final double current;
  final double change;
  final double changePct;
  final double high;
  final double low;
  final double open;
  final double previousClose;
}

class FinnhubUniverse {
  const FinnhubUniverse({
    required this.profilesBySymbol,
    this.metricsBySymbol = const {},
    this.recommendationsBySymbol = const {},
  });

  final Map<String, FinnhubCompanyProfile> profilesBySymbol;
  final Map<String, FinnhubMetrics> metricsBySymbol;
  final Map<String, FinnhubRecommendation> recommendationsBySymbol;
}

double? _asDouble(dynamic value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

int _asInt(dynamic value) {
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}
