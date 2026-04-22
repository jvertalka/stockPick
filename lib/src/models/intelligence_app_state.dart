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
    required this.feeds,
  });

  final String title;
  final String summary;
  final DateTime lastRefresh;
  final List<DataFeedStatus> feeds;
}

class DataFeedStatus {
  const DataFeedStatus({
    required this.name,
    required this.availability,
    required this.detail,
  });

  final String name;
  final FeedAvailability availability;
  final String detail;
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
    required this.hitRate,
    required this.averageAlpha,
    required this.averageReturn,
    required this.worstDrawdown,
    required this.scoreCorrelation,
    required this.verdict,
  });

  final int windowCount;
  final int observationCount;
  final double hitRate;
  final double averageAlpha;
  final double averageReturn;
  final double worstDrawdown;
  final double scoreCorrelation;
  final String verdict;
}
