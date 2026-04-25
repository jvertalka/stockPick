import 'dart:async';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';

/// Stooq is a free, no-auth CSV endpoint with broad US stock coverage. Does
/// not require a CORS proxy for most deployments. Delivers daily OHLCV.
class StooqFeedProvider {
  StooqFeedProvider({
    required this.symbols,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final List<String> symbols;
  final http.Client _client;

  /// Stooq uses lowercase symbols with a `.us` suffix for US equities and a
  /// daily CSV endpoint: https://stooq.com/q/d/l/?s=aapl.us&i=d
  Future<StooqBarSeries?> loadDailyBars(String symbol) async {
    final stooqSymbol = _toStooqSymbol(symbol);
    final url = 'https://stooq.com/q/d/l/?s=$stooqSymbol&i=d';
    try {
      final response =
          await _client.get(Uri.parse(url)).timeout(const Duration(seconds: 12));
      if (response.statusCode != 200) return null;
      final body = response.body.trim();
      if (body.isEmpty || !body.contains('Date')) return null;
      final lines = body.split('\n');
      if (lines.length < 2) return null;
      final bars = <StooqBar>[];
      for (var i = 1; i < lines.length; i++) {
        final row = lines[i].trim();
        if (row.isEmpty) continue;
        final parts = row.split(',');
        // Date,Open,High,Low,Close,Volume
        if (parts.length < 6) continue;
        final date = DateTime.tryParse(parts[0]);
        if (date == null) continue;
        bars.add(
          StooqBar(
            date: date,
            open: double.tryParse(parts[1]) ?? 0,
            high: double.tryParse(parts[2]) ?? 0,
            low: double.tryParse(parts[3]) ?? 0,
            close: double.tryParse(parts[4]) ?? 0,
            volume: double.tryParse(parts[5]) ?? 0,
          ),
        );
      }
      return StooqBarSeries(symbol: symbol, bars: bars);
    } catch (_) {
      return null;
    }
  }

  Future<FeedSlice<StooqUniverse>> loadUniverse() async {
    final loaded = <String, StooqBarSeries>{};
    for (final symbol in symbols) {
      final bars = await loadDailyBars(symbol);
      if (bars != null && bars.bars.isNotEmpty) {
        loaded[symbol] = bars;
      }
    }
    final latest = loaded.values
        .map((series) => series.bars.last.date)
        .fold<DateTime?>(
      null,
      (prev, next) => prev == null || next.isAfter(prev) ? next : prev,
    );
    return FeedSlice(
      name: 'Stooq daily OHLCV',
      source: 'stooq',
      asOf: latest ?? DateTime.now(),
      data: StooqUniverse(seriesBySymbol: loaded),
      availability: loaded.isEmpty
          ? FeedAvailability.fixture
          : FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail: loaded.isEmpty
          ? 'Stooq did not return data for the configured universe. Could indicate a rate limit or unknown tickers.'
          : 'Stooq supplied daily OHLCV for ${loaded.length} of ${symbols.length} symbols.',
    );
  }

  String _toStooqSymbol(String symbol) {
    // BRK.B etc — Stooq expects dots replaced with hyphens.
    final normalized = symbol.toLowerCase().replaceAll('.', '-');
    return '$normalized.us';
  }
}

class StooqBar {
  const StooqBar({
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

class StooqBarSeries {
  const StooqBarSeries({required this.symbol, required this.bars});

  final String symbol;
  final List<StooqBar> bars;

  StooqBar? get latest => bars.isEmpty ? null : bars.last;

  double? percentChangeOver(int tradingDays) {
    if (bars.length <= tradingDays) return null;
    final cur = bars.last.close;
    final prior = bars[bars.length - 1 - tradingDays].close;
    if (prior == 0) return null;
    return (cur - prior) / prior * 100;
  }
}

class StooqUniverse {
  const StooqUniverse({required this.seriesBySymbol});

  final Map<String, StooqBarSeries> seriesBySymbol;

  StooqBarSeries? operator [](String symbol) => seriesBySymbol[symbol];

  int get symbolCount => seriesBySymbol.length;
}
