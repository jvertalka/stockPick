import 'dart:convert';

import 'market_intelligence.dart';

class RecommendationLedger {
  const RecommendationLedger({required this.records});

  static const empty = RecommendationLedger(records: <RecommendationRecord>[]);

  final List<RecommendationRecord> records;

  List<RecommendationRecord> get recent {
    final ordered = [...records]..sort((a, b) => b.asOf.compareTo(a.asOf));
    return ordered;
  }

  RecommendationLedger upsertSnapshot(MarketIntelligenceSnapshot snapshot) {
    final existing = {for (final record in records) record.id: record};
    final updated = <String, RecommendationRecord>{...existing};
    for (final stock in snapshot.rankedUniverse.take(80)) {
      final id = RecommendationRecord.buildId(snapshot.asOf, stock.ticker);
      final record = updated[id];
      updated[id] =
          (record ??
                  RecommendationRecord.fromStock(
                    asOf: snapshot.asOf,
                    stock: stock,
                    regime: snapshot.marketRadar.regime,
                  ))
              .updateOutcomes(currentAsOf: snapshot.asOf, currentStock: stock);
    }

    for (final record in updated.values.toList()) {
      final stock = snapshot.rankedUniverse
          .where((candidate) => candidate.ticker == record.ticker)
          .firstOrNull;
      if (stock != null) {
        updated[record.id] = record.updateOutcomes(
          currentAsOf: snapshot.asOf,
          currentStock: stock,
        );
      }
    }

    final pruned = updated.values.toList()
      ..sort((a, b) => b.asOf.compareTo(a.asOf));
    return RecommendationLedger(records: pruned.take(500).toList());
  }

  String toJson() {
    return jsonEncode({
      'records': records.map((record) => record.toJson()).toList(),
    });
  }

  factory RecommendationLedger.fromJson(String raw) {
    if (raw.isEmpty) {
      return RecommendationLedger.empty;
    }
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      return RecommendationLedger.empty;
    }
    final records = decoded['records'];
    return RecommendationLedger(
      records: records is List<dynamic>
          ? records
                .whereType<Map<String, dynamic>>()
                .map(RecommendationRecord.fromJson)
                .toList()
          : const <RecommendationRecord>[],
    );
  }
}

class RecommendationRecord {
  const RecommendationRecord({
    required this.id,
    required this.asOf,
    required this.ticker,
    required this.company,
    required this.regime,
    required this.action,
    required this.trustLevel,
    required this.opportunityScore,
    required this.confidenceScore,
    required this.priceAtSignal,
    required this.thesis,
    this.outcome5d,
    this.outcome20d,
    this.outcome60d,
  });

  final String id;
  final DateTime asOf;
  final String ticker;
  final String company;
  final MarketRegimeType regime;
  final RecommendationAction action;
  final DecisionTrustLevel trustLevel;
  final double opportunityScore;
  final double confidenceScore;
  final double priceAtSignal;
  final String thesis;
  final RecommendationOutcome? outcome5d;
  final RecommendationOutcome? outcome20d;
  final RecommendationOutcome? outcome60d;

  static String buildId(DateTime asOf, String ticker) =>
      '${asOf.toIso8601String().split('T').first}:$ticker';

  factory RecommendationRecord.fromStock({
    required DateTime asOf,
    required StockInsight stock,
    required MarketRegimeType regime,
  }) {
    return RecommendationRecord(
      id: buildId(asOf, stock.ticker),
      asOf: asOf,
      ticker: stock.ticker,
      company: stock.company,
      regime: regime,
      action: stock.action,
      trustLevel: stock.decisionTrust.level,
      opportunityScore: stock.opportunityScore,
      confidenceScore: stock.confidenceScore,
      priceAtSignal: stock.lastPrice,
      thesis: stock.summary,
    );
  }

  RecommendationRecord updateOutcomes({
    required DateTime currentAsOf,
    required StockInsight currentStock,
  }) {
    return RecommendationRecord(
      id: id,
      asOf: asOf,
      ticker: ticker,
      company: company,
      regime: regime,
      action: action,
      trustLevel: trustLevel,
      opportunityScore: opportunityScore,
      confidenceScore: confidenceScore,
      priceAtSignal: priceAtSignal,
      thesis: thesis,
      outcome5d:
          outcome5d ??
          _buildOutcome(
            horizonLabel: '5d',
            minimumElapsedDays: 7,
            currentAsOf: currentAsOf,
            currentStock: currentStock,
          ),
      outcome20d:
          outcome20d ??
          _buildOutcome(
            horizonLabel: '20d',
            minimumElapsedDays: 30,
            currentAsOf: currentAsOf,
            currentStock: currentStock,
          ),
      outcome60d:
          outcome60d ??
          _buildOutcome(
            horizonLabel: '60d',
            minimumElapsedDays: 90,
            currentAsOf: currentAsOf,
            currentStock: currentStock,
          ),
    );
  }

  RecommendationOutcome? _buildOutcome({
    required String horizonLabel,
    required int minimumElapsedDays,
    required DateTime currentAsOf,
    required StockInsight currentStock,
  }) {
    if (currentAsOf.difference(asOf).inDays < minimumElapsedDays) {
      return null;
    }
    if (priceAtSignal <= 0 || currentStock.lastPrice <= 0) {
      return RecommendationOutcome(
        horizonLabel: horizonLabel,
        measuredAt: currentAsOf,
        returnPct: 0,
        opportunityDelta: currentStock.opportunityScore - opportunityScore,
        status: OutcomeStatus.priceMissing,
      );
    }
    return RecommendationOutcome(
      horizonLabel: horizonLabel,
      measuredAt: currentAsOf,
      returnPct: (currentStock.lastPrice / priceAtSignal - 1) * 100,
      opportunityDelta: currentStock.opportunityScore - opportunityScore,
      status: OutcomeStatus.measured,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'asOf': asOf.toIso8601String(),
    'ticker': ticker,
    'company': company,
    'regime': regime.name,
    'action': action.name,
    'trustLevel': trustLevel.name,
    'opportunityScore': opportunityScore,
    'confidenceScore': confidenceScore,
    'priceAtSignal': priceAtSignal,
    'thesis': thesis,
    'outcome5d': outcome5d?.toJson(),
    'outcome20d': outcome20d?.toJson(),
    'outcome60d': outcome60d?.toJson(),
  };

  factory RecommendationRecord.fromJson(Map<String, dynamic> json) {
    return RecommendationRecord(
      id: json['id'] as String? ?? '',
      asOf: DateTime.tryParse(json['asOf'] as String? ?? '') ?? DateTime.now(),
      ticker: json['ticker'] as String? ?? '',
      company: json['company'] as String? ?? '',
      regime: _enumByName(
        MarketRegimeType.values,
        json['regime'] as String?,
        MarketRegimeType.neutral,
      ),
      action: _enumByName(
        RecommendationAction.values,
        json['action'] as String?,
        RecommendationAction.watch,
      ),
      trustLevel: _enumByName(
        DecisionTrustLevel.values,
        json['trustLevel'] as String?,
        DecisionTrustLevel.insufficientData,
      ),
      opportunityScore: _readDouble(json['opportunityScore']),
      confidenceScore: _readDouble(json['confidenceScore']),
      priceAtSignal: _readDouble(json['priceAtSignal']),
      thesis: json['thesis'] as String? ?? '',
      outcome5d: _readOutcome(json['outcome5d']),
      outcome20d: _readOutcome(json['outcome20d']),
      outcome60d: _readOutcome(json['outcome60d']),
    );
  }
}

enum OutcomeStatus { pending, measured, priceMissing }

class RecommendationOutcome {
  const RecommendationOutcome({
    required this.horizonLabel,
    required this.measuredAt,
    required this.returnPct,
    required this.opportunityDelta,
    required this.status,
  });

  final String horizonLabel;
  final DateTime measuredAt;
  final double returnPct;
  final double opportunityDelta;
  final OutcomeStatus status;

  Map<String, dynamic> toJson() => {
    'horizonLabel': horizonLabel,
    'measuredAt': measuredAt.toIso8601String(),
    'returnPct': returnPct,
    'opportunityDelta': opportunityDelta,
    'status': status.name,
  };

  factory RecommendationOutcome.fromJson(Map<String, dynamic> json) {
    return RecommendationOutcome(
      horizonLabel: json['horizonLabel'] as String? ?? '',
      measuredAt:
          DateTime.tryParse(json['measuredAt'] as String? ?? '') ??
          DateTime.now(),
      returnPct: _readDouble(json['returnPct']),
      opportunityDelta: _readDouble(json['opportunityDelta']),
      status: _enumByName(
        OutcomeStatus.values,
        json['status'] as String?,
        OutcomeStatus.pending,
      ),
    );
  }
}

T _enumByName<T extends Enum>(List<T> values, String? name, T fallback) {
  for (final value in values) {
    if (value.name == name) {
      return value;
    }
  }
  return fallback;
}

double _readDouble(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? 0;
  return 0;
}

RecommendationOutcome? _readOutcome(Object? value) {
  if (value is Map<String, dynamic>) {
    return RecommendationOutcome.fromJson(value);
  }
  return null;
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
