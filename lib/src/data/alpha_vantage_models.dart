import 'dart:convert';

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
        open: readAlphaNumber(values, '1. open'),
        high: readAlphaNumber(values, '2. high'),
        low: readAlphaNumber(values, '3. low'),
        close: readAlphaNumber(values, '4. close'),
        volume: readAlphaNumber(values, '5. volume'),
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

class AlphaVantageQuotaState {
  const AlphaVantageQuotaState({required this.day, required this.requestsUsed});

  final String day;
  final int requestsUsed;

  bool get isToday => day == todayKey();

  bool canUse(int limit) => isToday && requestsUsed < limit;

  AlphaVantageQuotaState copyWith({int? requestsUsed}) {
    return AlphaVantageQuotaState(
      day: day,
      requestsUsed: requestsUsed ?? this.requestsUsed,
    );
  }

  String toJsonString() =>
      jsonEncode({'day': day, 'requestsUsed': requestsUsed});

  Map<String, dynamic> toJson() => {'day': day, 'requestsUsed': requestsUsed};

  factory AlphaVantageQuotaState.today() {
    return AlphaVantageQuotaState(day: todayKey(), requestsUsed: 0);
  }

  factory AlphaVantageQuotaState.fromJson(Map<String, dynamic> json) {
    return AlphaVantageQuotaState(
      day: json['day'] as String,
      requestsUsed: json['requestsUsed'] as int? ?? 0,
    );
  }
}

double readAlphaNumber(Map<String, dynamic> values, String key) {
  final raw = values[key];
  if (raw is num) {
    return raw.toDouble();
  }
  if (raw is String) {
    return double.parse(raw.replaceAll(',', ''));
  }
  throw StateError('Alpha Vantage response is missing $key.');
}

String todayKey() {
  final now = DateTime.now();
  return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
}
