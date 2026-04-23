import 'dart:math' as math;

import '../data/raw_market_data.dart';
import '../models/intelligence_app_state.dart';
import '../models/market_intelligence.dart';
import 'market_intelligence_engine.dart';

class ValidationEngine {
  ValidationEngine({required MarketIntelligenceEngine engine})
    : _engine = engine;

  final MarketIntelligenceEngine _engine;

  ValidationReport validate(
    List<ValidationWindow> windows, {
    int topPickCount = 2,
    int archivedSnapshotCount = 0,
    int minimumShadowSnapshots = 20,
  }) {
    final orderedWindows = [...windows]
      ..sort((left, right) => left.asOf.compareTo(right.asOf));
    final evaluatedWindows = orderedWindows
        .map((window) => _evaluateWindow(window, topPickCount))
        .toList();
    final aggregate = _aggregate(evaluatedWindows);
    final trainWindowCount = _trainWindowCount(evaluatedWindows.length);
    final trainWindows = evaluatedWindows.take(trainWindowCount).toList();
    final testWindows = evaluatedWindows.skip(trainWindowCount).toList();

    final trainSplit = _buildSplitReport(
      'Train',
      trainWindows,
      calibrationContext: true,
    );
    final testSplit = _buildSplitReport(
      'Test',
      testWindows,
      calibrationContext: false,
    );
    final shadowMode = _buildShadowMode(
      archivedSnapshotCount: archivedSnapshotCount,
      minimumShadowSnapshots: minimumShadowSnapshots,
    );
    final calibrationBands = _buildCalibrationBands(evaluatedWindows);
    final integrity = _buildIntegrityReport(
      orderedWindows: orderedWindows,
      trainWindows: trainWindows,
      testWindows: testWindows,
    );
    final robustness = _buildRobustnessReport(evaluatedWindows);

    final verdict = _overallVerdict(
      trainSplit: trainSplit,
      testSplit: testSplit,
      shadowMode: shadowMode,
      integrity: integrity,
    );

    return ValidationReport(
      windowCount: evaluatedWindows.length,
      observationCount: aggregate.observationCount,
      topPickCount: aggregate.topPickCount,
      hitRate: aggregate.hitRate,
      averageAlpha: aggregate.averageAlpha,
      averageReturn: aggregate.averageReturn,
      worstDrawdown: aggregate.worstDrawdown,
      scoreCorrelation: aggregate.scoreCorrelation,
      trainSplit: trainSplit,
      testSplit: testSplit,
      windows: evaluatedWindows.map((window) => window.report).toList(),
      shadowMode: shadowMode,
      coverageStart: orderedWindows.isEmpty ? null : orderedWindows.first.asOf,
      coverageEnd: orderedWindows.isEmpty ? null : orderedWindows.last.asOf,
      calibrationBands: calibrationBands,
      integrity: integrity,
      robustness: robustness,
      verdict: verdict,
    );
  }

  _WindowEvaluation _evaluateWindow(ValidationWindow window, int topPickCount) {
    final evaluation = _engine.evaluate(window.marketState);
    final outcomeMap = {
      for (final outcome in window.outcomes) outcome.ticker: outcome,
    };
    final allObservations = <_ScoreOutcomeObservation>[];
    final allScores = <double>[];
    final allAlpha = <double>[];
    final topPickAlpha = <double>[];
    final topPickReturns = <double>[];
    final topPickDrawdowns = <double>[];

    for (final scored in evaluation.scoredStocks) {
      final outcome = outcomeMap[scored.raw.ticker];
      if (outcome == null) {
        continue;
      }
      final alpha = outcome.forwardReturn20d - outcome.sectorReturn20d;
      allScores.add(scored.insight.opportunityScore);
      allAlpha.add(alpha);
      allObservations.add(
        _ScoreOutcomeObservation(
          score: scored.insight.opportunityScore,
          alpha: alpha,
        ),
      );
    }

    final ranked =
        evaluation.scoredStocks
            .where((stock) => outcomeMap.containsKey(stock.raw.ticker))
            .toList()
          ..sort(
            (left, right) => right.insight.opportunityScore.compareTo(
              left.insight.opportunityScore,
            ),
          );

    final picks = <ValidationPickReport>[];
    for (final topPick in ranked.take(topPickCount)) {
      final outcome = outcomeMap[topPick.raw.ticker]!;
      final alpha = outcome.forwardReturn20d - outcome.sectorReturn20d;
      topPickAlpha.add(alpha);
      topPickReturns.add(outcome.forwardReturn20d);
      topPickDrawdowns.add(outcome.maxDrawdown20d);
      picks.add(
        ValidationPickReport(
          ticker: topPick.raw.ticker,
          company: topPick.raw.company,
          action: topPick.insight.action,
          opportunityScore: topPick.insight.opportunityScore,
          forwardReturn: outcome.forwardReturn20d,
          alpha: alpha,
          maxDrawdown: outcome.maxDrawdown20d,
        ),
      );
    }

    final hitRate = topPickAlpha.isEmpty
        ? 0.0
        : topPickAlpha.where((alpha) => alpha > 0).length / topPickAlpha.length;
    final averageAlpha = _average(topPickAlpha);
    final averageReturn = _average(topPickReturns);
    final worstDrawdown = _minimum(topPickDrawdowns);

    return _WindowEvaluation(
      report: ValidationWindowReport(
        asOf: window.asOf,
        regimeLabel: evaluation.snapshot.marketRadar.regime.label,
        observationCount: allScores.length,
        topPickCount: picks.length,
        hitRate: hitRate * 100,
        averageAlpha: averageAlpha,
        averageReturn: averageReturn,
        worstDrawdown: worstDrawdown,
        topPicks: picks,
      ),
      allObservations: allObservations,
      allScores: allScores,
      allAlpha: allAlpha,
      topPickAlpha: topPickAlpha,
      topPickReturns: topPickReturns,
      topPickDrawdowns: topPickDrawdowns,
    );
  }

  ValidationSplitReport _buildSplitReport(
    String label,
    List<_WindowEvaluation> windows, {
    required bool calibrationContext,
  }) {
    final aggregate = _aggregate(windows);
    final verdict = _splitVerdict(
      label: label,
      aggregate: aggregate,
      calibrationContext: calibrationContext,
    );

    return ValidationSplitReport(
      label: label,
      windowCount: windows.length,
      observationCount: aggregate.observationCount,
      topPickCount: aggregate.topPickCount,
      hitRate: aggregate.hitRate,
      averageAlpha: aggregate.averageAlpha,
      averageReturn: aggregate.averageReturn,
      worstDrawdown: aggregate.worstDrawdown,
      scoreCorrelation: aggregate.scoreCorrelation,
      verdict: verdict,
    );
  }

  ShadowModeReport _buildShadowMode({
    required int archivedSnapshotCount,
    required int minimumShadowSnapshots,
  }) {
    final isReady = archivedSnapshotCount >= minimumShadowSnapshots;
    final summary = isReady
        ? 'Archive depth is sufficient to begin live shadow tracking once a connected feed is online.'
        : 'Shadow mode is not ready yet. Capture at least $minimumShadowSnapshots distinct archived snapshots and connect a live feed before trusting live evaluation.';

    return ShadowModeReport(
      isReady: isReady,
      archivedSnapshotCount: archivedSnapshotCount,
      minimumSnapshotCount: minimumShadowSnapshots,
      summary: summary,
    );
  }

  String _splitVerdict({
    required String label,
    required _AggregateMetrics aggregate,
    required bool calibrationContext,
  }) {
    if (aggregate.windowCount == 0) {
      return 'No $label split is available yet.';
    }
    if (aggregate.topPickCount == 0) {
      return 'The $label split has windows, but no scored outcomes were available for top-pick evaluation.';
    }
    if (!calibrationContext && aggregate.windowCount < 2) {
      return 'The holdout is directionally useful, but still too small to treat as a trustworthy test set.';
    }
    if (aggregate.hitRate >= 60 &&
        aggregate.averageAlpha >= 1.0 &&
        aggregate.scoreCorrelation >= 0.15) {
      return calibrationContext
          ? 'The calibration split shows useful separation, but it still needs a larger and more honest holdout.'
          : 'The holdout split is constructive, though the sample is still thin and vendor-free.';
    }
    if (aggregate.averageAlpha > 0) {
      return calibrationContext
          ? 'The calibration split is mildly positive, but not strong enough to justify confidence.'
          : 'The holdout split is only mildly positive, so conviction should stay low.';
    }
    return calibrationContext
        ? 'The calibration split is weak, so the scoring stack still needs redesign.'
        : 'The holdout split does not yet show convincing separation.';
  }

  String _overallVerdict({
    required ValidationSplitReport trainSplit,
    required ValidationSplitReport testSplit,
    required ShadowModeReport shadowMode,
    required ResearchIntegrityReport integrity,
  }) {
    if (!integrity.overallPassed) {
      return 'The research diagnostics now expose useful structure, but the chronology and holdout checks are not yet strong enough for production confidence.';
    }
    if (testSplit.windowCount == 0) {
      return 'The research harness now has train-style diagnostics, but there is still no meaningful holdout yet.';
    }
    if (testSplit.hitRate >= 60 &&
        testSplit.averageAlpha >= 1.0 &&
        testSplit.scoreCorrelation >= 0.15) {
      return shadowMode.isReady
          ? 'The rules engine looks directionally constructive on the current holdout and has enough archive depth to start shadow tracking when live feeds arrive.'
          : 'The rules engine looks directionally constructive on the current holdout, but archive depth and live feeds are still too thin for real shadow mode.';
    }
    return 'The research harness is now exposing the right train/test questions, but the current evidence is still too thin for production confidence.';
  }

  List<CalibrationBandReport> _buildCalibrationBands(
    List<_WindowEvaluation> windows,
  ) {
    final observations = windows
        .expand((window) => window.allObservations)
        .toList();

    return [
      _bandReport('High score', observations.where((item) => item.score >= 75)),
      _bandReport(
        'Middle score',
        observations.where((item) => item.score >= 60 && item.score < 75),
      ),
      _bandReport('Low score', observations.where((item) => item.score < 60)),
    ];
  }

  CalibrationBandReport _bandReport(
    String label,
    Iterable<_ScoreOutcomeObservation> items,
  ) {
    final observations = items.toList();
    final hitRate = observations.isEmpty
        ? 0.0
        : observations.where((item) => item.alpha > 0).length /
              observations.length *
              100;
    return CalibrationBandReport(
      label: label,
      observationCount: observations.length,
      hitRate: hitRate,
      averageAlpha: _average(observations.map((item) => item.alpha).toList()),
      averageScore: _average(observations.map((item) => item.score).toList()),
    );
  }

  ResearchIntegrityReport _buildIntegrityReport({
    required List<ValidationWindow> orderedWindows,
    required List<_WindowEvaluation> trainWindows,
    required List<_WindowEvaluation> testWindows,
  }) {
    final dates = orderedWindows.map((window) => window.asOf).toList();
    final strictlyOrdered = _isStrictlyIncreasing(dates);
    final uniqueDates =
        dates.map((date) => date.toIso8601String()).toSet().length ==
        dates.length;
    final chronologicalSplit =
        trainWindows.isEmpty ||
        testWindows.isEmpty ||
        trainWindows.last.report.asOf.isBefore(testWindows.first.report.asOf);
    final holdoutDepth = testWindows.length >= 2;

    final checks = [
      ResearchIntegrityCheck(
        label: 'Chronological ordering',
        passed: strictlyOrdered,
        detail: strictlyOrdered
            ? 'Validation windows are strictly increasing in time.'
            : 'At least one validation window is out of chronological order.',
      ),
      ResearchIntegrityCheck(
        label: 'Unique as-of dates',
        passed: uniqueDates,
        detail: uniqueDates
            ? 'No duplicate validation dates were detected.'
            : 'Duplicate validation dates were detected, which can leak repeated evidence.',
      ),
      ResearchIntegrityCheck(
        label: 'Train/test separation',
        passed: chronologicalSplit,
        detail: chronologicalSplit
            ? 'The train split finishes before the holdout starts.'
            : 'Train and holdout windows overlap in time.',
      ),
      ResearchIntegrityCheck(
        label: 'Holdout depth',
        passed: holdoutDepth,
        detail: holdoutDepth
            ? 'The holdout contains at least two windows.'
            : 'The holdout is still only one window deep, so results remain fragile.',
      ),
    ];

    final overallPassed = checks.every((check) => check.passed);
    final summary = overallPassed
        ? 'Chronology, duplicate-date, and holdout-boundary checks passed.'
        : 'At least one integrity guard failed, so the research output should stay exploratory.';
    return ResearchIntegrityReport(
      summary: summary,
      overallPassed: overallPassed,
      checks: checks,
    );
  }

  RobustnessReport _buildRobustnessReport(List<_WindowEvaluation> windows) {
    final scoredWindows = windows
        .where((window) => window.report.topPickCount > 0)
        .toList();
    final windowAlpha = scoredWindows
        .map((window) => window.report.averageAlpha)
        .toList();
    final positiveWindowRate = windowAlpha.isEmpty
        ? 0.0
        : windowAlpha.where((value) => value > 0).length /
              windowAlpha.length *
              100;
    final averageTopPickCount = scoredWindows.isEmpty
        ? 0.0
        : _average(
            scoredWindows
                .map((window) => window.report.topPickCount.toDouble())
                .toList(),
          );
    final summary = positiveWindowRate >= 60
        ? 'Window-level results are more often positive than negative, though the sample is still thin.'
        : 'Window-level results are still inconsistent, so the stack needs more evidence before it earns trust.';

    return RobustnessReport(
      positiveWindowRate: positiveWindowRate,
      medianWindowAlpha: _median(windowAlpha),
      worstWindowAlpha: _minimum(windowAlpha),
      averageTopPickCount: averageTopPickCount,
      summary: summary,
    );
  }

  _AggregateMetrics _aggregate(List<_WindowEvaluation> windows) {
    final allScores = <double>[];
    final allAlpha = <double>[];
    final topPickAlpha = <double>[];
    final topPickReturns = <double>[];
    final topPickDrawdowns = <double>[];

    for (final window in windows) {
      allScores.addAll(window.allScores);
      allAlpha.addAll(window.allAlpha);
      topPickAlpha.addAll(window.topPickAlpha);
      topPickReturns.addAll(window.topPickReturns);
      topPickDrawdowns.addAll(window.topPickDrawdowns);
    }

    final hitRate = topPickAlpha.isEmpty
        ? 0.0
        : topPickAlpha.where((alpha) => alpha > 0).length / topPickAlpha.length;

    return _AggregateMetrics(
      windowCount: windows.length,
      observationCount: allScores.length,
      topPickCount: topPickAlpha.length,
      hitRate: hitRate * 100,
      averageAlpha: _average(topPickAlpha),
      averageReturn: _average(topPickReturns),
      worstDrawdown: _minimum(topPickDrawdowns),
      scoreCorrelation: _correlation(allScores, allAlpha),
    );
  }

  int _trainWindowCount(int windowCount) {
    if (windowCount <= 1) {
      return windowCount;
    }

    final proposed = (windowCount * 0.67).floor();
    return proposed.clamp(1, windowCount - 1);
  }

  double _average(List<double> values) {
    if (values.isEmpty) {
      return 0.0;
    }
    return values.reduce((left, right) => left + right) / values.length;
  }

  double _minimum(List<double> values) {
    if (values.isEmpty) {
      return 0.0;
    }
    return values.reduce((left, right) => math.min(left, right));
  }

  double _correlation(List<double> xs, List<double> ys) {
    if (xs.length != ys.length || xs.length < 2) {
      return 0.0;
    }

    final meanX = _average(xs);
    final meanY = _average(ys);
    var numerator = 0.0;
    var sumSquaredX = 0.0;
    var sumSquaredY = 0.0;

    for (var index = 0; index < xs.length; index++) {
      final dx = xs[index] - meanX;
      final dy = ys[index] - meanY;
      numerator += dx * dy;
      sumSquaredX += dx * dx;
      sumSquaredY += dy * dy;
    }

    final denominator = math.sqrt(sumSquaredX * sumSquaredY);
    if (denominator == 0.0) {
      return 0.0;
    }
    return numerator / denominator;
  }

  double _median(List<double> values) {
    if (values.isEmpty) {
      return 0.0;
    }
    final ordered = [...values]..sort();
    final middle = ordered.length ~/ 2;
    if (ordered.length.isOdd) {
      return ordered[middle];
    }
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }

  bool _isStrictlyIncreasing(List<DateTime> values) {
    for (var index = 1; index < values.length; index++) {
      if (!values[index].isAfter(values[index - 1])) {
        return false;
      }
    }
    return true;
  }
}

class _WindowEvaluation {
  const _WindowEvaluation({
    required this.report,
    required this.allObservations,
    required this.allScores,
    required this.allAlpha,
    required this.topPickAlpha,
    required this.topPickReturns,
    required this.topPickDrawdowns,
  });

  final ValidationWindowReport report;
  final List<_ScoreOutcomeObservation> allObservations;
  final List<double> allScores;
  final List<double> allAlpha;
  final List<double> topPickAlpha;
  final List<double> topPickReturns;
  final List<double> topPickDrawdowns;
}

class _ScoreOutcomeObservation {
  const _ScoreOutcomeObservation({required this.score, required this.alpha});

  final double score;
  final double alpha;
}

class _AggregateMetrics {
  const _AggregateMetrics({
    required this.windowCount,
    required this.observationCount,
    required this.topPickCount,
    required this.hitRate,
    required this.averageAlpha,
    required this.averageReturn,
    required this.worstDrawdown,
    required this.scoreCorrelation,
  });

  final int windowCount;
  final int observationCount;
  final int topPickCount;
  final double hitRate;
  final double averageAlpha;
  final double averageReturn;
  final double worstDrawdown;
  final double scoreCorrelation;
}
