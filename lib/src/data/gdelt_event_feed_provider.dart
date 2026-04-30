import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

class GdeltEventFeedProvider {
  GdeltEventFeedProvider({
    required this.symbols,
    this.corsProxyPrefix = '',
    this.requestTimeout = const Duration(seconds: 4),
    http.Client? client,
  }) : _client = client ?? http.Client();

  final List<String> symbols;
  final String corsProxyPrefix;
  final Duration requestTimeout;
  final http.Client _client;

  Future<FeedSlice<GdeltEventUniverse>> probe({int maxSymbols = 5}) async {
    final loaded = <String, GdeltEventSignal>{};
    for (final symbol in symbols.take(maxSymbols)) {
      final signal = await loadEventSignal(symbol: symbol, companyName: symbol);
      if (signal != null) {
        loaded[symbol.toUpperCase()] = signal;
      }
    }

    return FeedSlice(
      name: 'GDELT event risk',
      source: 'gdelt-doc',
      asOf: DateTime.now(),
      data: GdeltEventUniverse(signalsBySymbol: loaded),
      availability: loaded.isEmpty
          ? FeedAvailability.missing
          : FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.eventDriven,
      detail: loaded.isEmpty
          ? 'GDELT did not return article signals from this environment. It remains optional event-risk confirmation.'
          : 'GDELT supplied recent news pressure signals for ${loaded.length} symbols.',
    );
  }

  Future<GdeltEventSignal?> loadEventSignal({
    required String symbol,
    required String companyName,
  }) async {
    final query = _queryFor(symbol: symbol, companyName: companyName);
    final uri = Uri.https('api.gdeltproject.org', '/api/v2/doc/doc', {
      'query': query,
      'mode': 'ArtList',
      'format': 'json',
      'maxrecords': '25',
      'sort': 'DateDesc',
      'timespan': '7d',
    });

    try {
      final response = await _client
          .get(Uri.parse(_wrap(uri.toString())))
          .timeout(requestTimeout);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic>) {
        return null;
      }
      final articles = decoded['articles'];
      if (articles is! List<dynamic>) {
        return null;
      }
      final parsed = articles
          .whereType<Map<String, dynamic>>()
          .map(GdeltArticle.fromJson)
          .toList();
      if (parsed.isEmpty) {
        return null;
      }
      return _buildSignal(symbol.toUpperCase(), parsed);
    } catch (_) {
      return null;
    }
  }

  GdeltEventSignal _buildSignal(String symbol, List<GdeltArticle> articles) {
    final negativeKeywordHits = articles
        .where((article) => _negativeKeywordCount(article.title) > 0)
        .length;
    final toneValues = articles
        .map((article) => article.tone)
        .whereType<double>()
        .toList();
    final averageTone = toneValues.isEmpty
        ? 0.0
        : toneValues.reduce((a, b) => a + b) / toneValues.length;
    final pressureScore = (34 + articles.length * 2.2 + negativeKeywordHits * 8)
        .clamp(0, 100)
        .toDouble();
    final negativeToneScore = (50 - averageTone * 5 + negativeKeywordHits * 6)
        .clamp(0, 100)
        .toDouble();
    final eventRiskScore = _average([pressureScore, negativeToneScore]);

    return GdeltEventSignal(
      symbol: symbol,
      articleCount: articles.length,
      negativeArticleCount: negativeKeywordHits,
      averageTone: averageTone,
      eventRiskScore: eventRiskScore,
      pressureScore: pressureScore,
      latestArticleDate: articles
          .map((article) => article.seenAt)
          .whereType<DateTime>()
          .fold<DateTime?>(
            null,
            (latest, seenAt) =>
                latest == null || seenAt.isAfter(latest) ? seenAt : latest,
          ),
      sampleHeadlines: articles
          .take(3)
          .map((article) => article.title)
          .toList(),
    );
  }

  String _queryFor({required String symbol, required String companyName}) {
    final cleanedName = companyName
        .replaceAll(
          RegExp(
            r'\b(Inc|Corp|Corporation|Class A|PLC|Ltd)\.?$',
            caseSensitive: false,
          ),
          '',
        )
        .trim();
    if (cleanedName.isEmpty || cleanedName == symbol) {
      return '"$symbol" sourceCountry:US';
    }
    return '("$cleanedName" OR "$symbol") sourceCountry:US';
  }

  int _negativeKeywordCount(String text) {
    final lower = text.toLowerCase();
    const keywords = [
      'probe',
      'lawsuit',
      'miss',
      'warning',
      'downgrade',
      'cuts',
      'cut',
      'layoff',
      'fraud',
      'investigation',
      'recall',
      'guidance',
      'shortfall',
      'slump',
      'falls',
      'drops',
    ];
    return keywords.where(lower.contains).length;
  }

  double _average(List<double> values) {
    if (values.isEmpty) {
      return 50;
    }
    return values.reduce((a, b) => a + b) / values.length;
  }

  String _wrap(String url) {
    if (corsProxyPrefix.isEmpty) {
      return url;
    }
    if (corsProxyPrefix.contains('url=')) {
      return '$corsProxyPrefix${Uri.encodeComponent(url)}';
    }
    return '$corsProxyPrefix$url';
  }
}

class GdeltEventRiskOverlayStockProvider implements StockSignalProvider {
  GdeltEventRiskOverlayStockProvider({
    required StockSignalProvider fallbackProvider,
    required GdeltEventFeedProvider gdeltProvider,
    this.maxSymbolsPerRefresh = 5,
    this.overlayTimeout = const Duration(seconds: 5),
  }) : _fallbackProvider = fallbackProvider,
       _gdeltProvider = gdeltProvider;

  final StockSignalProvider _fallbackProvider;
  final GdeltEventFeedProvider _gdeltProvider;
  final int maxSymbolsPerRefresh;
  final Duration overlayTimeout;

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() async {
    final fallback = await _fallbackProvider.loadStockSignals();
    final candidates = fallback.data.take(maxSymbolsPerRefresh).toList();
    final eventEntries =
        await Future.wait(
          candidates.map((stock) async {
            return MapEntry(
              stock.ticker,
              await _gdeltProvider.loadEventSignal(
                symbol: stock.ticker,
                companyName: stock.company,
              ),
            );
          }),
        ).timeout(
          overlayTimeout,
          onTimeout: () => const <MapEntry<String, GdeltEventSignal?>>[],
        );
    final eventByTicker = <String, GdeltEventSignal>{
      for (final entry in eventEntries)
        if (entry.value != null) entry.key: entry.value!,
    };
    final enriched = <RawStockSignal>[];
    var overlayCount = 0;
    for (final stock in fallback.data) {
      final signal = eventByTicker[stock.ticker];
      if (signal == null) {
        enriched.add(stock);
        continue;
      }
      enriched.add(_overlay(stock, signal));
      overlayCount++;
    }

    if (overlayCount == 0) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source}+gdelt-event-risk',
      asOf: DateTime.now(),
      data: enriched,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.eventDriven,
      detail:
          '${fallback.detail} GDELT added free news-pressure and event-risk overlays for $overlayCount symbols.',
    );
  }

  RawStockSignal _overlay(RawStockSignal stock, GdeltEventSignal signal) {
    final eventDrag = (signal.eventRiskScore - 50).clamp(0, 50).toDouble();
    final calmBonus = (50 - signal.eventRiskScore).clamp(0, 18).toDouble();
    return stock.copyWith(
      eventPremium: _blend(stock.eventPremium, signal.eventRiskScore, 0.44),
      downsideProtectionDemand: _blend(
        stock.downsideProtectionDemand,
        stock.downsideProtectionDemand + eventDrag,
        0.28,
      ),
      volatilityRepricing: _blend(
        stock.volatilityRepricing,
        stock.volatilityRepricing + eventDrag,
        0.24,
      ),
      putSkewChange: _blend(
        stock.putSkewChange,
        stock.putSkewChange + eventDrag * 0.8,
        0.20,
      ),
      priceResponse: _blend(
        stock.priceResponse,
        stock.priceResponse - eventDrag * 0.5 + calmBonus,
        0.18,
      ),
      expectedStability: _blend(
        stock.expectedStability,
        stock.expectedStability - eventDrag * 0.5 + calmBonus,
        0.18,
      ),
    );
  }

  double _blend(double oldValue, double newValue, double weight) {
    return (oldValue * (1 - weight) + newValue * weight)
        .clamp(0, 100)
        .toDouble();
  }
}

class GdeltArticle {
  const GdeltArticle({required this.title, this.url, this.seenAt, this.tone});

  factory GdeltArticle.fromJson(Map<String, dynamic> json) {
    return GdeltArticle(
      title: (json['title'] as String?) ?? '',
      url: json['url'] as String?,
      seenAt: DateTime.tryParse(
        (json['seendate'] as String?) ?? (json['seenDate'] as String?) ?? '',
      ),
      tone: _asDouble(json['tone']),
    );
  }

  final String title;
  final String? url;
  final DateTime? seenAt;
  final double? tone;
}

class GdeltEventSignal {
  const GdeltEventSignal({
    required this.symbol,
    required this.articleCount,
    required this.negativeArticleCount,
    required this.averageTone,
    required this.eventRiskScore,
    required this.pressureScore,
    required this.sampleHeadlines,
    this.latestArticleDate,
  });

  final String symbol;
  final int articleCount;
  final int negativeArticleCount;
  final double averageTone;
  final double eventRiskScore;
  final double pressureScore;
  final List<String> sampleHeadlines;
  final DateTime? latestArticleDate;
}

class GdeltEventUniverse {
  const GdeltEventUniverse({required this.signalsBySymbol});

  final Map<String, GdeltEventSignal> signalsBySymbol;
}

double? _asDouble(dynamic value) {
  if (value is num) {
    return value.toDouble();
  }
  if (value is String) {
    return double.tryParse(value);
  }
  return null;
}
