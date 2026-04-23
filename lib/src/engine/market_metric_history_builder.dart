import '../data/market_snapshot_archive.dart';
import '../data/raw_market_data.dart';
import '../models/market_intelligence.dart';
import 'market_intelligence_engine.dart';

MarketIntelligenceSnapshot withHistoricalInsights({
  required MarketIntelligenceSnapshot snapshot,
  required Iterable<ArchivedMarketSnapshot> historicalSnapshots,
  required MarketIntelligenceEngine engine,
  int maxHistoryPoints = 240,
  int rollingWindow = 60,
}) {
  final evaluations = _buildHistoricalEvaluations(
    historicalSnapshots,
    engine: engine,
    maxHistoryPoints: maxHistoryPoints,
  );
  if (evaluations.isEmpty) {
    return snapshot;
  }

  final radarMetrics = _enrichRadarMetrics(
    snapshot.marketRadar.metrics,
    evaluations,
    rollingWindow: rollingWindow,
  );
  final rankedUniverse = _enrichStocks(
    snapshot.rankedUniverse,
    evaluations,
    rollingWindow: rollingWindow,
  );
  final opportunityTickers = snapshot.opportunities
      .map((stock) => stock.ticker)
      .toSet();
  final opportunities = rankedUniverse
      .where((stock) => opportunityTickers.contains(stock.ticker))
      .toList();
  final scenarios = _enrichScenarios(
    snapshot.scenarios,
    evaluations,
    rollingWindow: rollingWindow,
  );

  return snapshot.copyWith(
    marketRadar: snapshot.marketRadar.copyWith(metrics: radarMetrics),
    rankedUniverse: rankedUniverse,
    opportunities: opportunities,
    scenarios: scenarios,
  );
}

List<RawMarketState> buildFixtureReplayHistory({
  required RawMarketState currentState,
  required Iterable<RawMarketState> anchorStates,
  int maxHistoryPoints = 120,
}) {
  final orderedAnchors = _normalizeStates([...anchorStates, currentState]);
  if (orderedAnchors.length < 2) {
    return const <RawMarketState>[];
  }

  final replayStates = <RawMarketState>[];
  for (var index = 0; index < orderedAnchors.length - 1; index++) {
    final left = orderedAnchors[index];
    final right = orderedAnchors[index + 1];
    replayStates.add(
      RawMarketState(
        asOf: _withReferenceClock(left.asOf, currentState.asOf),
        environment: left.environment,
        styles: currentState.styles,
        sectors: currentState.sectors,
        stocks: currentState.stocks,
      ),
    );

    final intermediateDates = _businessDaysBetweenExclusive(
      left.asOf,
      right.asOf,
    );
    for (var dateIndex = 0; dateIndex < intermediateDates.length; dateIndex++) {
      final fraction = (dateIndex + 1) / (intermediateDates.length + 1);
      replayStates.add(
        RawMarketState(
          asOf: _withReferenceClock(
            intermediateDates[dateIndex],
            currentState.asOf,
          ),
          environment: _interpolateEnvironment(
            left.environment,
            right.environment,
            fraction,
          ),
          styles: currentState.styles,
          sectors: currentState.sectors,
          stocks: currentState.stocks,
        ),
      );
    }
  }

  final currentDate = DateTime(
    currentState.asOf.year,
    currentState.asOf.month,
    currentState.asOf.day,
  );
  final trimmed = _trimStates(
    replayStates.where((state) {
      final stateDate = DateTime(
        state.asOf.year,
        state.asOf.month,
        state.asOf.day,
      );
      return stateDate.isBefore(currentDate);
    }).toList(),
    maxHistoryPoints: maxHistoryPoints,
  );
  return _normalizeStates(trimmed);
}

List<RadarMetric> _enrichRadarMetrics(
  List<RadarMetric> metrics,
  List<_HistoricalEvaluation> evaluations, {
  required int rollingWindow,
}) {
  final trackedLabels = {for (final metric in metrics) metric.label};
  final pointsByLabel = {
    for (final label in trackedLabels) label: <MetricTrendPoint>[],
  };
  final provenanceByLabel = {
    for (final label in trackedLabels) label: <HistoryProvenance>[],
  };

  for (final evaluation in evaluations) {
    for (final metric in evaluation.snapshot.marketRadar.metrics) {
      if (!trackedLabels.contains(metric.label)) {
        continue;
      }
      pointsByLabel[metric.label]!.add(
        MetricTrendPoint(asOf: evaluation.asOf, value: metric.numericValue),
      );
      provenanceByLabel[metric.label]!.add(evaluation.provenance);
    }
  }

  return metrics.map((metric) {
    return metric.copyWith(
      trend: _buildTrend(
        pointsByLabel[metric.label] ?? const <MetricTrendPoint>[],
        provenanceByLabel[metric.label] ?? const <HistoryProvenance>[],
        currentValue: metric.numericValue,
        rollingWindow: rollingWindow,
      ),
    );
  }).toList();
}

List<StockInsight> _enrichStocks(
  List<StockInsight> stocks,
  List<_HistoricalEvaluation> evaluations, {
  required int rollingWindow,
}) {
  final tickers = {for (final stock in stocks) stock.ticker};
  final opportunityPoints = {
    for (final ticker in tickers) ticker: <MetricTrendPoint>[],
  };
  final fragilityPoints = {
    for (final ticker in tickers) ticker: <MetricTrendPoint>[],
  };
  final regimeFitPoints = {
    for (final ticker in tickers) ticker: <MetricTrendPoint>[],
  };
  final convictionPoints = {
    for (final ticker in tickers) ticker: <MetricTrendPoint>[],
  };
  final provenanceByTicker = {
    for (final ticker in tickers) ticker: <HistoryProvenance>[],
  };

  for (final evaluation in evaluations) {
    final scoredByTicker = {
      for (final stock in evaluation.scoredStocks)
        stock.raw.ticker: stock.insight,
    };
    for (final ticker in tickers) {
      final stock = scoredByTicker[ticker];
      if (stock == null) {
        continue;
      }
      final point = MetricTrendPoint(
        asOf: evaluation.asOf,
        value: stock.opportunityScore,
      );
      opportunityPoints[ticker]!.add(point);
      fragilityPoints[ticker]!.add(
        MetricTrendPoint(asOf: evaluation.asOf, value: stock.fragilityScore),
      );
      regimeFitPoints[ticker]!.add(
        MetricTrendPoint(asOf: evaluation.asOf, value: stock.regimeFit),
      );
      convictionPoints[ticker]!.add(
        MetricTrendPoint(asOf: evaluation.asOf, value: stock.convictionScore),
      );
      provenanceByTicker[ticker]!.add(evaluation.provenance);
    }
  }

  return stocks.map((stock) {
    final provenance =
        provenanceByTicker[stock.ticker] ?? const <HistoryProvenance>[];
    return stock.copyWith(
      opportunityTrend: _buildTrend(
        opportunityPoints[stock.ticker] ?? const <MetricTrendPoint>[],
        provenance,
        currentValue: stock.opportunityScore,
        rollingWindow: rollingWindow,
      ),
      fragilityTrend: _buildTrend(
        fragilityPoints[stock.ticker] ?? const <MetricTrendPoint>[],
        provenance,
        currentValue: stock.fragilityScore,
        rollingWindow: rollingWindow,
      ),
      regimeFitTrend: _buildTrend(
        regimeFitPoints[stock.ticker] ?? const <MetricTrendPoint>[],
        provenance,
        currentValue: stock.regimeFit,
        rollingWindow: rollingWindow,
      ),
      convictionTrend: _buildTrend(
        convictionPoints[stock.ticker] ?? const <MetricTrendPoint>[],
        provenance,
        currentValue: stock.convictionScore,
        rollingWindow: rollingWindow,
      ),
    );
  }).toList();
}

List<ScenarioOutcome> _enrichScenarios(
  List<ScenarioOutcome> scenarios,
  List<_HistoricalEvaluation> evaluations, {
  required int rollingWindow,
}) {
  final types = {for (final scenario in scenarios) scenario.type};
  final pointsByType = {for (final type in types) type: <MetricTrendPoint>[]};
  final provenanceByType = {
    for (final type in types) type: <HistoryProvenance>[],
  };

  for (final evaluation in evaluations) {
    final scenariosByType = {
      for (final scenario in evaluation.snapshot.scenarios)
        scenario.type: scenario,
    };
    for (final type in types) {
      final scenario = scenariosByType[type];
      if (scenario == null) {
        continue;
      }
      pointsByType[type]!.add(
        MetricTrendPoint(
          asOf: evaluation.asOf,
          value: _scenarioSensitivity(scenario),
        ),
      );
      provenanceByType[type]!.add(evaluation.provenance);
    }
  }

  return scenarios.map((scenario) {
    return scenario.copyWith(
      sensitivityScore: _scenarioSensitivity(scenario),
      sensitivityTrend: _buildTrend(
        pointsByType[scenario.type] ?? const <MetricTrendPoint>[],
        provenanceByType[scenario.type] ?? const <HistoryProvenance>[],
        currentValue: _scenarioSensitivity(scenario),
        rollingWindow: rollingWindow,
      ),
    );
  }).toList();
}

List<_HistoricalEvaluation> _buildHistoricalEvaluations(
  Iterable<ArchivedMarketSnapshot> historicalSnapshots, {
  required MarketIntelligenceEngine engine,
  required int maxHistoryPoints,
}) {
  final orderedSnapshots = historicalSnapshots.toList()
    ..sort(
      (left, right) => left.marketState.asOf.compareTo(right.marketState.asOf),
    );
  final trimmedSnapshots = orderedSnapshots.length > maxHistoryPoints
      ? orderedSnapshots.sublist(orderedSnapshots.length - maxHistoryPoints)
      : orderedSnapshots;

  return trimmedSnapshots.map((record) {
    final evaluation = engine.evaluate(record.marketState);
    return _HistoricalEvaluation(
      asOf: record.marketState.asOf,
      provenance: _classifySource(record.source),
      snapshot: evaluation.snapshot,
      scoredStocks: evaluation.scoredStocks,
    );
  }).toList();
}

MetricTrend _buildTrend(
  List<MetricTrendPoint> points,
  List<HistoryProvenance> provenances, {
  required double currentValue,
  required int rollingWindow,
}) {
  final series = points.isEmpty
      ? <MetricTrendPoint>[
          MetricTrendPoint(asOf: DateTime.now(), value: currentValue),
        ]
      : points;
  final lookbackPoints = series.length > rollingWindow
      ? series.sublist(series.length - rollingWindow)
      : series;
  final values = lookbackPoints.map((point) => point.value).toList();
  return MetricTrend(
    points: series,
    mean60: values.isEmpty ? currentValue : _mean(values),
    median60: values.isEmpty ? currentValue : _median(values),
    lookbackCount: lookbackPoints.length,
    provenance: _resolveProvenance(provenances),
  );
}

HistoryProvenance _resolveProvenance(List<HistoryProvenance> provenances) {
  if (provenances.isEmpty) {
    return HistoryProvenance.missing;
  }
  final counts = <HistoryProvenance, int>{};
  for (final provenance in provenances) {
    counts.update(provenance, (value) => value + 1, ifAbsent: () => 1);
  }
  final ranked = counts.entries.toList()
    ..sort((left, right) => right.value.compareTo(left.value));
  if (ranked.length == 1) {
    return ranked.first.key;
  }
  if (ranked.first.value == ranked[1].value) {
    return HistoryProvenance.mixed;
  }
  return ranked.first.key;
}

HistoryProvenance _classifySource(String source) {
  final normalized = source.toLowerCase();
  if (normalized.contains('live')) {
    return HistoryProvenance.live;
  }
  if (normalized.contains('replay') || normalized.contains('validation')) {
    return HistoryProvenance.researchReplay;
  }
  return HistoryProvenance.archived;
}

double _scenarioSensitivity(ScenarioOutcome scenario) {
  if (scenario.stockImpacts.isEmpty) {
    return 0;
  }
  final absoluteDeltas = scenario.stockImpacts
      .map((impact) => impact.deltaOpportunity.abs())
      .toList();
  return _mean(absoluteDeltas);
}

List<RawMarketState> _normalizeStates(Iterable<RawMarketState> states) {
  final deduped = <String, RawMarketState>{};
  for (final state in states) {
    deduped[state.asOf.toIso8601String()] = state;
  }
  final ordered = deduped.values.toList()
    ..sort((left, right) => left.asOf.compareTo(right.asOf));
  return ordered;
}

List<RawMarketState> _trimStates(
  List<RawMarketState> states, {
  required int maxHistoryPoints,
}) {
  if (states.length <= maxHistoryPoints) {
    return states;
  }
  return states.sublist(states.length - maxHistoryPoints);
}

List<DateTime> _businessDaysBetweenExclusive(DateTime start, DateTime end) {
  final dates = <DateTime>[];
  var cursor = DateTime(
    start.year,
    start.month,
    start.day,
  ).add(const Duration(days: 1));
  final endDate = DateTime(end.year, end.month, end.day);
  while (cursor.isBefore(endDate)) {
    if (_isBusinessDay(cursor)) {
      dates.add(cursor);
    }
    cursor = cursor.add(const Duration(days: 1));
  }
  return dates;
}

bool _isBusinessDay(DateTime value) =>
    value.weekday != DateTime.saturday && value.weekday != DateTime.sunday;

DateTime _withReferenceClock(DateTime date, DateTime reference) {
  return DateTime(
    date.year,
    date.month,
    date.day,
    reference.hour,
    reference.minute,
    reference.second,
    reference.millisecond,
    reference.microsecond,
  );
}

RawMarketEnvironment _interpolateEnvironment(
  RawMarketEnvironment left,
  RawMarketEnvironment right,
  double fraction,
) {
  return RawMarketEnvironment(
    indexTrend: _lerp(left.indexTrend, right.indexTrend, fraction),
    realizedVolatility: _lerp(
      left.realizedVolatility,
      right.realizedVolatility,
      fraction,
    ),
    impliedVolatility: _lerp(
      left.impliedVolatility,
      right.impliedVolatility,
      fraction,
    ),
    creditStress: _lerp(left.creditStress, right.creditStress, fraction),
    financialConditions: _lerp(
      left.financialConditions,
      right.financialConditions,
      fraction,
    ),
    growthLeadership: _lerp(
      left.growthLeadership,
      right.growthLeadership,
      fraction,
    ),
    defensiveLeadership: _lerp(
      left.defensiveLeadership,
      right.defensiveLeadership,
      fraction,
    ),
    smallCapLeadership: _lerp(
      left.smallCapLeadership,
      right.smallCapLeadership,
      fraction,
    ),
    inflationPressure: _lerp(
      left.inflationPressure,
      right.inflationPressure,
      fraction,
    ),
    breadth: _lerp(left.breadth, right.breadth, fraction),
    advanceDecline: _lerp(left.advanceDecline, right.advanceDecline, fraction),
    newHighLow: _lerp(left.newHighLow, right.newHighLow, fraction),
    percentAboveMajorAverages: _lerp(
      left.percentAboveMajorAverages,
      right.percentAboveMajorAverages,
      fraction,
    ),
    equalWeightConfirmation: _lerp(
      left.equalWeightConfirmation,
      right.equalWeightConfirmation,
      fraction,
    ),
    sectorParticipation: _lerp(
      left.sectorParticipation,
      right.sectorParticipation,
      fraction,
    ),
    correlation: _lerp(left.correlation, right.correlation, fraction),
    dispersion: _lerp(left.dispersion, right.dispersion, fraction),
    volumeConcentration: _lerp(
      left.volumeConcentration,
      right.volumeConcentration,
      fraction,
    ),
  );
}

double _lerp(double left, double right, double fraction) {
  return left + (right - left) * fraction;
}

double _mean(List<double> values) {
  return values.reduce((left, right) => left + right) / values.length;
}

double _median(List<double> values) {
  final ordered = [...values]..sort();
  final middle = ordered.length ~/ 2;
  if (ordered.length.isOdd) {
    return ordered[middle];
  }
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

class _HistoricalEvaluation {
  const _HistoricalEvaluation({
    required this.asOf,
    required this.provenance,
    required this.snapshot,
    required this.scoredStocks,
  });

  final DateTime asOf;
  final HistoryProvenance provenance;
  final MarketIntelligenceSnapshot snapshot;
  final List<DerivedStockSignal> scoredStocks;
}
