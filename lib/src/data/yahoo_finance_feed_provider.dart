import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';

/// Yahoo Finance is unofficial but free and has broad coverage. It does NOT
/// allow direct browser origins via CORS — this provider routes requests
/// through an optional CORS proxy prefix. On server or mobile it works
/// directly without a proxy.
///
/// Use as a secondary/fallback adapter behind Alpha Vantage. Supplies daily
/// OHLCV only; fundamentals and options still come from other sources.
class YahooFinanceFeedProvider {
  YahooFinanceFeedProvider({
    required this.symbols,
    this.corsProxyPrefix = '',
    http.Client? client,
  }) : _client = client ?? http.Client();

  final List<String> symbols;
  final String corsProxyPrefix;
  final http.Client _client;

  static const String _chartBase =
      'https://query1.finance.yahoo.com/v8/finance/chart/';

  /// Fetch daily OHLCV bars for [symbol] over [rangeDays] calendar days.
  /// Returns null if the request fails so callers can fall back.
  Future<YahooBarSeries?> loadDailyBars(
    String symbol, {
    int rangeDays = 365,
  }) async {
    final raw =
        '$_chartBase${Uri.encodeComponent(symbol)}?interval=1d&range=${rangeDays}d';
    final url = _wrap(raw);
    try {
      final response = await _client
          .get(Uri.parse(url))
          .timeout(const Duration(seconds: 5));
      if (response.statusCode != 200) {
        return null;
      }
      final decoded = jsonDecode(response.body) as Map<String, dynamic>;
      final chart = decoded['chart'] as Map<String, dynamic>?;
      final result = (chart?['result'] as List<dynamic>?)?.cast<dynamic>();
      if (result == null || result.isEmpty) {
        return null;
      }
      final entry = result.first as Map<String, dynamic>;
      final timestamps =
          (entry['timestamp'] as List<dynamic>?)?.cast<int>() ?? const [];
      final indicators = entry['indicators'] as Map<String, dynamic>?;
      final quoteList = (indicators?['quote'] as List<dynamic>?)
          ?.cast<Map<String, dynamic>>();
      if (timestamps.isEmpty || quoteList == null || quoteList.isEmpty) {
        return null;
      }
      final quote = quoteList.first;
      final closes = (quote['close'] as List<dynamic>?)?.cast<num?>();
      final opens = (quote['open'] as List<dynamic>?)?.cast<num?>();
      final highs = (quote['high'] as List<dynamic>?)?.cast<num?>();
      final lows = (quote['low'] as List<dynamic>?)?.cast<num?>();
      final volumes = (quote['volume'] as List<dynamic>?)?.cast<num?>();
      if (closes == null) return null;

      final bars = <YahooBar>[];
      for (var i = 0; i < timestamps.length; i++) {
        final close = closes[i];
        if (close == null) continue;
        bars.add(
          YahooBar(
            date: DateTime.fromMillisecondsSinceEpoch(
              timestamps[i] * 1000,
            ).toUtc(),
            open: _doubleOr(opens, i, close.toDouble()),
            high: _doubleOr(highs, i, close.toDouble()),
            low: _doubleOr(lows, i, close.toDouble()),
            close: close.toDouble(),
            volume: _doubleOr(volumes, i, 0),
          ),
        );
      }
      return YahooBarSeries(symbol: symbol, bars: bars);
    } catch (_) {
      return null;
    }
  }

  Future<FeedSlice<YahooUniverse>> loadUniverse({int rangeDays = 365}) async {
    final loaded = <String, YahooBarSeries>{};
    for (final symbol in symbols) {
      final bars = await loadDailyBars(symbol, rangeDays: rangeDays);
      if (bars != null) {
        loaded[symbol] = bars;
      }
    }
    final latest = loaded.values
        .map(
          (series) =>
              series.bars.isEmpty ? DateTime.now() : series.bars.last.date,
        )
        .fold<DateTime?>(
          null,
          (prev, next) => prev == null || next.isAfter(prev) ? next : prev,
        );
    return FeedSlice(
      name: 'Yahoo Finance daily OHLCV',
      source: 'yahoo-finance',
      asOf: latest ?? DateTime.now(),
      data: YahooUniverse(seriesBySymbol: loaded),
      availability: loaded.isEmpty
          ? FeedAvailability.fixture
          : FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail: loaded.isEmpty
          ? 'Yahoo Finance is unreachable from this environment. Configure a CORS proxy or run the app server-side to use it.'
          : 'Yahoo Finance supplied daily OHLCV for ${loaded.length} of ${symbols.length} symbols.',
    );
  }

  String _wrap(String url) {
    if (corsProxyPrefix.isEmpty) return url;
    if (corsProxyPrefix.contains('url=')) {
      return '$corsProxyPrefix${Uri.encodeComponent(url)}';
    }
    return '$corsProxyPrefix$url';
  }

  double _doubleOr(List<num?>? list, int index, double fallback) {
    if (list == null || index >= list.length) return fallback;
    final value = list[index];
    if (value == null) return fallback;
    return value.toDouble();
  }
}

class YahooBar {
  const YahooBar({
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
}

class YahooBarSeries {
  const YahooBarSeries({required this.symbol, required this.bars});

  final String symbol;
  final List<YahooBar> bars;

  YahooBar? get latest => bars.isEmpty ? null : bars.last;

  double? percentChangeOver(int tradingDays) {
    if (bars.length <= tradingDays) return null;
    final cur = bars.last.close;
    final prior = bars[bars.length - 1 - tradingDays].close;
    if (prior == 0) return null;
    return (cur - prior) / prior * 100;
  }
}

class YahooUniverse {
  const YahooUniverse({required this.seriesBySymbol});

  final Map<String, YahooBarSeries> seriesBySymbol;

  YahooBarSeries? operator [](String symbol) => seriesBySymbol[symbol];

  int get symbolCount => seriesBySymbol.length;
}
