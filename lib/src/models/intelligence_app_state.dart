import 'market_intelligence.dart';

enum FeedAvailability { fixture, connected, planned, missing }

extension FeedAvailabilityLabel on FeedAvailability {
  String get label => switch (this) {
    FeedAvailability.fixture => 'Fixture',
    FeedAvailability.connected => 'Connected',
    FeedAvailability.planned => 'Planned',
    FeedAvailability.missing => 'Missing',
  };
}

enum FeedRefreshCadence {
  onDemand,
  intraday,
  daily,
  weekly,
  eventDriven,
  planned,
}

extension FeedRefreshCadenceLabel on FeedRefreshCadence {
  String get label => switch (this) {
    FeedRefreshCadence.onDemand => 'On demand',
    FeedRefreshCadence.intraday => 'Intraday',
    FeedRefreshCadence.daily => 'Daily',
    FeedRefreshCadence.weekly => 'Weekly',
    FeedRefreshCadence.eventDriven => 'Event driven',
    FeedRefreshCadence.planned => 'Planned',
  };
}

enum ValidationStage {
  none,
  fixtureWalkForward,
  pointInTimeBacktest,
  liveShadow,
}

extension ValidationStageLabel on ValidationStage {
  String get label => switch (this) {
    ValidationStage.none => 'Not validated',
    ValidationStage.fixtureWalkForward => 'Fixture walk-forward',
    ValidationStage.pointInTimeBacktest => 'Point-in-time backtest',
    ValidationStage.liveShadow => 'Live shadow mode',
  };
}

class IntelligenceAppState {
  const IntelligenceAppState({
    required this.snapshot,
    required this.dataStatus,
    required this.engineStatus,
  });

  final MarketIntelligenceSnapshot snapshot;
  final DataStatusReport dataStatus;
  final EngineStatusReport engineStatus;
}

class DataStatusReport {
  const DataStatusReport({
    required this.title,
    required this.summary,
    required this.lastRefresh,
    required this.archiveSummary,
    required this.archiveSnapshotCount,
    required this.latestArchive,
    required this.feeds,
  });

  final String title;
  final String summary;
  final DateTime lastRefresh;
  final String archiveSummary;
  final int archiveSnapshotCount;
  final DateTime? latestArchive;
  final List<DataFeedStatus> feeds;
}

class DataFeedStatus {
  const DataFeedStatus({
    required this.name,
    required this.availability,
    required this.refreshCadence,
    required this.detail,
    this.lastUpdated,
  });

  final String name;
  final FeedAvailability availability;
  final FeedRefreshCadence refreshCadence;
  final String detail;
  final DateTime? lastUpdated;
}

class EngineStatusReport {
  const EngineStatusReport({
    required this.title,
    required this.summary,
    required this.isTrained,
    required this.validationStage,
    required this.validationReport,
    required this.caveats,
    required this.nextSteps,
  });

  final String title;
  final String summary;
  final bool isTrained;
  final ValidationStage validationStage;
  final ValidationReport validationReport;
  final List<String> caveats;
  final List<String> nextSteps;
}

class ValidationReport {
  const ValidationReport({
    required this.windowCount,
    required this.observationCount,
    required this.topPickCount,
    required this.hitRate,
    required this.averageAlpha,
    required this.averageReturn,
    required this.worstDrawdown,
    required this.scoreCorrelation,
    required this.trainSplit,
    required this.testSplit,
    required this.windows,
    required this.shadowMode,
    required this.coverageStart,
    required this.coverageEnd,
    required this.calibrationBands,
    required this.integrity,
    required this.robustness,
    required this.modelReadiness,
    required this.verdict,
  });

  final int windowCount;
  final int observationCount;
  final int topPickCount;
  final double hitRate;
  final double averageAlpha;
  final double averageReturn;
  final double worstDrawdown;
  final double scoreCorrelation;
  final ValidationSplitReport trainSplit;
  final ValidationSplitReport testSplit;
  final List<ValidationWindowReport> windows;
  final ShadowModeReport shadowMode;
  final DateTime? coverageStart;
  final DateTime? coverageEnd;
  final List<CalibrationBandReport> calibrationBands;
  final ResearchIntegrityReport integrity;
  final RobustnessReport robustness;
  final ModelReadinessReport modelReadiness;
  final String verdict;
}

class ValidationSplitReport {
  const ValidationSplitReport({
    required this.label,
    required this.windowCount,
    required this.observationCount,
    required this.topPickCount,
    required this.hitRate,
    required this.averageAlpha,
    required this.averageReturn,
    required this.worstDrawdown,
    required this.scoreCorrelation,
    required this.verdict,
  });

  final String label;
  final int windowCount;
  final int observationCount;
  final int topPickCount;
  final double hitRate;
  final double averageAlpha;
  final double averageReturn;
  final double worstDrawdown;
  final double scoreCorrelation;
  final String verdict;
}

class ValidationWindowReport {
  const ValidationWindowReport({
    required this.asOf,
    required this.regimeLabel,
    required this.observationCount,
    required this.topPickCount,
    required this.hitRate,
    required this.averageAlpha,
    required this.averageReturn,
    required this.worstDrawdown,
    required this.topPicks,
  });

  final DateTime asOf;
  final String regimeLabel;
  final int observationCount;
  final int topPickCount;
  final double hitRate;
  final double averageAlpha;
  final double averageReturn;
  final double worstDrawdown;
  final List<ValidationPickReport> topPicks;
}

class ValidationPickReport {
  const ValidationPickReport({
    required this.ticker,
    required this.company,
    required this.action,
    required this.opportunityScore,
    required this.forwardReturn,
    required this.alpha,
    required this.maxDrawdown,
  });

  final String ticker;
  final String company;
  final RecommendationAction action;
  final double opportunityScore;
  final double forwardReturn;
  final double alpha;
  final double maxDrawdown;
}

class ShadowModeReport {
  const ShadowModeReport({
    required this.isReady,
    required this.archivedSnapshotCount,
    required this.minimumSnapshotCount,
    required this.summary,
  });

  final bool isReady;
  final int archivedSnapshotCount;
  final int minimumSnapshotCount;
  final String summary;
}

class ModelReadinessReport {
  const ModelReadinessReport({
    required this.isReady,
    required this.summary,
    required this.gates,
  });

  final bool isReady;
  final String summary;
  final List<ReadinessGateReport> gates;
}

class ReadinessGateReport {
  const ReadinessGateReport({
    required this.label,
    required this.passed,
    required this.current,
    required this.minimum,
    required this.detail,
  });

  final String label;
  final bool passed;
  final int current;
  final int minimum;
  final String detail;
}

class CalibrationBandReport {
  const CalibrationBandReport({
    required this.label,
    required this.observationCount,
    required this.hitRate,
    required this.averageAlpha,
    required this.averageScore,
  });

  final String label;
  final int observationCount;
  final double hitRate;
  final double averageAlpha;
  final double averageScore;
}

class ResearchIntegrityReport {
  const ResearchIntegrityReport({
    required this.summary,
    required this.overallPassed,
    required this.checks,
  });

  final String summary;
  final bool overallPassed;
  final List<ResearchIntegrityCheck> checks;
}

class ResearchIntegrityCheck {
  const ResearchIntegrityCheck({
    required this.label,
    required this.passed,
    required this.detail,
  });

  final String label;
  final bool passed;
  final String detail;
}

class RobustnessReport {
  const RobustnessReport({
    required this.positiveWindowRate,
    required this.medianWindowAlpha,
    required this.worstWindowAlpha,
    required this.averageTopPickCount,
    required this.summary,
  });

  final double positiveWindowRate;
  final double medianWindowAlpha;
  final double worstWindowAlpha;
  final double averageTopPickCount;
  final String summary;
}
