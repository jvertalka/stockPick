enum MarketRegimeType {
  riskOn,
  neutral,
  riskOff,
  inflationStress,
  growthScare,
  creditDeterioration,
  euphoricMeltUp,
  washoutRecovery,
}

extension MarketRegimeTypeLabel on MarketRegimeType {
  String get label => switch (this) {
    MarketRegimeType.riskOn => 'Risk-on',
    MarketRegimeType.neutral => 'Neutral',
    MarketRegimeType.riskOff => 'Risk-off',
    MarketRegimeType.inflationStress => 'Inflationary stress',
    MarketRegimeType.growthScare => 'Growth scare',
    MarketRegimeType.creditDeterioration => 'Credit deterioration',
    MarketRegimeType.euphoricMeltUp => 'Euphoric melt-up',
    MarketRegimeType.washoutRecovery => 'Washout recovery',
  };
}

enum InternalHealthType {
  healthyBroadRally,
  narrowLeadership,
  weakeningInternals,
  hiddenBreakdown,
  washedOutReversalPotential,
}

extension InternalHealthTypeLabel on InternalHealthType {
  String get label => switch (this) {
    InternalHealthType.healthyBroadRally => 'Healthy broad rally',
    InternalHealthType.narrowLeadership => 'Narrow leadership',
    InternalHealthType.weakeningInternals => 'Weakening internals',
    InternalHealthType.hiddenBreakdown => 'Hidden breakdown',
    InternalHealthType.washedOutReversalPotential =>
      'Washed-out reversal potential',
  };
}

enum RecommendationAction {
  watch,
  accumulate,
  buy,
  hold,
  trim,
  deRisk,
  exit,
  avoidForNow,
}

extension RecommendationActionLabel on RecommendationAction {
  String get label => switch (this) {
    RecommendationAction.watch => 'Watch',
    RecommendationAction.accumulate => 'Accumulate',
    RecommendationAction.buy => 'Buy',
    RecommendationAction.hold => 'Hold',
    RecommendationAction.trim => 'Trim',
    RecommendationAction.deRisk => 'De-risk',
    RecommendationAction.exit => 'Exit',
    RecommendationAction.avoidForNow => 'Avoid for now',
  };
}

enum AlertSeverity { low, moderate, high, critical }

extension AlertSeverityLabel on AlertSeverity {
  String get label => switch (this) {
    AlertSeverity.low => 'Low',
    AlertSeverity.moderate => 'Moderate',
    AlertSeverity.high => 'High',
    AlertSeverity.critical => 'Critical',
  };
}

enum SignalTone { positive, caution, negative, neutral }

enum HistoryProvenance { live, archived, researchReplay, mixed, missing }

extension HistoryProvenanceLabel on HistoryProvenance {
  String get label => switch (this) {
    HistoryProvenance.live => 'Live',
    HistoryProvenance.archived => 'Archived',
    HistoryProvenance.researchReplay => 'Research replay',
    HistoryProvenance.mixed => 'Mixed',
    HistoryProvenance.missing => 'Missing',
  };
}

enum ScenarioType {
  creditWidening,
  volatilityShock,
  growthLeadershipBreak,
  ratesFallingQuickly,
  custom,
}

extension ScenarioTypeLabel on ScenarioType {
  String get label => switch (this) {
    ScenarioType.creditWidening => 'Credit spreads widen',
    ScenarioType.volatilityShock => 'Volatility jumps 20%',
    ScenarioType.growthLeadershipBreak => 'Growth leadership breaks',
    ScenarioType.ratesFallingQuickly => 'Rates fall quickly',
    ScenarioType.custom => 'Custom scenario',
  };
}

enum ConfidenceTier { low, moderate, high, conflicted }

extension ConfidenceTierLabel on ConfidenceTier {
  String get label => switch (this) {
    ConfidenceTier.low => 'Low confidence',
    ConfidenceTier.moderate => 'Moderate confidence',
    ConfidenceTier.high => 'High confidence',
    ConfidenceTier.conflicted => 'Conflicted signals',
  };
}

enum SignalProvenance { live, cached, derived, fixture, missing }

extension SignalProvenanceLabel on SignalProvenance {
  String get label => switch (this) {
    SignalProvenance.live => 'Live',
    SignalProvenance.cached => 'Cached',
    SignalProvenance.derived => 'Derived',
    SignalProvenance.fixture => 'Fixture',
    SignalProvenance.missing => 'Missing',
  };

  bool get isReal =>
      this == SignalProvenance.live || this == SignalProvenance.cached;
}

enum DecisionTrustLevel { actionable, researchOnly, insufficientData }

extension DecisionTrustLevelLabel on DecisionTrustLevel {
  String get label => switch (this) {
    DecisionTrustLevel.actionable => 'Actionable',
    DecisionTrustLevel.researchOnly => 'Research-only',
    DecisionTrustLevel.insufficientData => 'Insufficient data',
  };
}

enum ForecastHorizon { twentyDay, sixtyDay }

extension ForecastHorizonLabel on ForecastHorizon {
  String get label => switch (this) {
    ForecastHorizon.twentyDay => 'Next 20 trading days',
    ForecastHorizon.sixtyDay => 'Next 60 trading days',
  };

  int get tradingDays => switch (this) {
    ForecastHorizon.twentyDay => 20,
    ForecastHorizon.sixtyDay => 60,
  };
}

class MarketIntelligenceSnapshot {
  const MarketIntelligenceSnapshot({
    required this.asOf,
    required this.marketRadar,
    required this.rankedUniverse,
    required this.opportunities,
    required this.sellAlerts,
    required this.scenarios,
    this.customScenarios = const <ScenarioOutcome>[],
  });

  final DateTime asOf;
  final MarketRadar marketRadar;
  final List<StockInsight> rankedUniverse;
  final List<StockInsight> opportunities;
  final List<SellAlert> sellAlerts;
  final List<ScenarioOutcome> scenarios;
  final List<ScenarioOutcome> customScenarios;

  MarketIntelligenceSnapshot copyWith({
    DateTime? asOf,
    MarketRadar? marketRadar,
    List<StockInsight>? rankedUniverse,
    List<StockInsight>? opportunities,
    List<SellAlert>? sellAlerts,
    List<ScenarioOutcome>? scenarios,
    List<ScenarioOutcome>? customScenarios,
  }) {
    return MarketIntelligenceSnapshot(
      asOf: asOf ?? this.asOf,
      marketRadar: marketRadar ?? this.marketRadar,
      rankedUniverse: rankedUniverse ?? this.rankedUniverse,
      opportunities: opportunities ?? this.opportunities,
      sellAlerts: sellAlerts ?? this.sellAlerts,
      scenarios: scenarios ?? this.scenarios,
      customScenarios: customScenarios ?? this.customScenarios,
    );
  }

  StockInsight stockByTicker(String ticker) {
    final stocks = rankedUniverse.isNotEmpty ? rankedUniverse : opportunities;
    if (stocks.isEmpty) {
      throw StateError('No ranked stocks are available.');
    }
    return stocks.firstWhere(
      (stock) => stock.ticker == ticker,
      orElse: () => stocks.first,
    );
  }

  ScenarioOutcome scenarioByType(ScenarioType type) {
    if (scenarios.isEmpty) {
      throw StateError('No scenarios are available.');
    }
    return scenarios.firstWhere(
      (scenario) => scenario.type == type,
      orElse: () => scenarios.first,
    );
  }
}

class MarketRadar {
  const MarketRadar({
    required this.regime,
    required this.regimeConfidence,
    required this.marketScore,
    required this.riskScore,
    required this.internalHealth,
    required this.headline,
    required this.summary,
    required this.breadthSummary,
    required this.metrics,
    required this.styleRotation,
    required this.sectorRotation,
    required this.supportingSignals,
    required this.warnings,
    this.regimeDistribution = const <RegimeProbability>[],
    this.regimeTransition,
    this.regimeStability = 0,
    this.breadthDecomposition = const <SectorBreadthRow>[],
  });

  final MarketRegimeType regime;
  final double regimeConfidence;
  final double marketScore;
  final double riskScore;
  final InternalHealthType internalHealth;
  final String headline;
  final String summary;
  final String breadthSummary;
  final List<RadarMetric> metrics;
  final List<StyleRotation> styleRotation;
  final List<SectorRotation> sectorRotation;
  final List<String> supportingSignals;
  final List<String> warnings;
  final List<RegimeProbability> regimeDistribution;
  final RegimeTransition? regimeTransition;
  final double regimeStability;
  final List<SectorBreadthRow> breadthDecomposition;

  MarketRadar copyWith({
    MarketRegimeType? regime,
    double? regimeConfidence,
    double? marketScore,
    double? riskScore,
    InternalHealthType? internalHealth,
    String? headline,
    String? summary,
    String? breadthSummary,
    List<RadarMetric>? metrics,
    List<StyleRotation>? styleRotation,
    List<SectorRotation>? sectorRotation,
    List<String>? supportingSignals,
    List<String>? warnings,
    List<RegimeProbability>? regimeDistribution,
    RegimeTransition? regimeTransition,
    double? regimeStability,
    List<SectorBreadthRow>? breadthDecomposition,
  }) {
    return MarketRadar(
      regime: regime ?? this.regime,
      regimeConfidence: regimeConfidence ?? this.regimeConfidence,
      marketScore: marketScore ?? this.marketScore,
      riskScore: riskScore ?? this.riskScore,
      internalHealth: internalHealth ?? this.internalHealth,
      headline: headline ?? this.headline,
      summary: summary ?? this.summary,
      breadthSummary: breadthSummary ?? this.breadthSummary,
      metrics: metrics ?? this.metrics,
      styleRotation: styleRotation ?? this.styleRotation,
      sectorRotation: sectorRotation ?? this.sectorRotation,
      supportingSignals: supportingSignals ?? this.supportingSignals,
      warnings: warnings ?? this.warnings,
      regimeDistribution: regimeDistribution ?? this.regimeDistribution,
      regimeTransition: regimeTransition ?? this.regimeTransition,
      regimeStability: regimeStability ?? this.regimeStability,
      breadthDecomposition: breadthDecomposition ?? this.breadthDecomposition,
    );
  }
}

class MetricTrend {
  const MetricTrend({
    required this.points,
    required this.mean60,
    required this.median60,
    required this.lookbackCount,
    required this.provenance,
  });

  final List<MetricTrendPoint> points;
  final double mean60;
  final double median60;
  final int lookbackCount;
  final HistoryProvenance provenance;

  bool get hasHistory => points.length > 1;
}

class MetricTrendPoint {
  const MetricTrendPoint({required this.asOf, required this.value});

  final DateTime asOf;
  final double value;
}

class RadarMetric {
  const RadarMetric({
    required this.label,
    required this.numericValue,
    required this.value,
    required this.detail,
    required this.tone,
    this.trend,
  });

  final String label;
  final double numericValue;
  final String value;
  final String detail;
  final SignalTone tone;
  final MetricTrend? trend;

  RadarMetric copyWith({
    String? label,
    double? numericValue,
    String? value,
    String? detail,
    SignalTone? tone,
    MetricTrend? trend,
  }) {
    return RadarMetric(
      label: label ?? this.label,
      numericValue: numericValue ?? this.numericValue,
      value: value ?? this.value,
      detail: detail ?? this.detail,
      tone: tone ?? this.tone,
      trend: trend ?? this.trend,
    );
  }
}

class StyleRotation {
  const StyleRotation({
    required this.style,
    required this.score,
    required this.note,
    required this.tone,
  });

  final String style;
  final double score;
  final String note;
  final SignalTone tone;
}

class SectorRotation {
  const SectorRotation({
    required this.sector,
    required this.score,
    required this.sponsorship,
    required this.note,
    required this.tone,
  });

  final String sector;
  final double score;
  final String sponsorship;
  final String note;
  final SignalTone tone;
}

class StockInsight {
  const StockInsight({
    required this.ticker,
    required this.company,
    required this.sector,
    required this.industry,
    required this.action,
    required this.opportunityScore,
    required this.regimeFit,
    required this.trendQuality,
    required this.revisionTrend,
    required this.convictionScore,
    required this.fragilityScore,
    required this.asymmetryScore,
    required this.riskScore,
    required this.confidenceScore,
    required this.summary,
    required this.whyItRanks,
    required this.whatCouldGoWrong,
    required this.invalidationSignals,
    required this.recentChanges,
    required this.stabilitySummary,
    required this.optionsSignal,
    required this.peers,
    this.lastPrice = 0,
    this.opportunityTrend,
    this.fragilityTrend,
    this.regimeFitTrend,
    this.convictionTrend,
    this.forecasts = const ForecastPack.empty(),
    this.confidenceBreakdown = const ConfidenceBreakdown.empty(),
    this.counterfactuals = const <CounterfactualSensitivity>[],
    this.peerContrast = const <PeerContrast>[],
    this.decayedSignals = const <DecayedSignal>[],
    this.macroGates = const <MacroGate>[],
    this.correlationCluster,
    this.decisionTrust = const DecisionTrustReport.actionable(),
  });

  final String ticker;
  final String company;
  final String sector;
  final String industry;
  final RecommendationAction action;
  final double opportunityScore;
  final double regimeFit;
  final double trendQuality;
  final double revisionTrend;
  final double convictionScore;
  final double fragilityScore;
  final double asymmetryScore;
  final double riskScore;
  final double confidenceScore;
  final String summary;
  final List<String> whyItRanks;
  final List<String> whatCouldGoWrong;
  final List<String> invalidationSignals;
  final List<String> recentChanges;
  final String stabilitySummary;
  final OptionsSignal optionsSignal;
  final List<PeerScore> peers;
  final double lastPrice;
  final MetricTrend? opportunityTrend;
  final MetricTrend? fragilityTrend;
  final MetricTrend? regimeFitTrend;
  final MetricTrend? convictionTrend;
  final ForecastPack forecasts;
  final ConfidenceBreakdown confidenceBreakdown;
  final List<CounterfactualSensitivity> counterfactuals;
  final List<PeerContrast> peerContrast;
  final List<DecayedSignal> decayedSignals;
  final List<MacroGate> macroGates;
  final CorrelationCluster? correlationCluster;
  final DecisionTrustReport decisionTrust;

  String get confidenceLabel => confidenceBreakdown.tier.label;

  StockInsight copyWith({
    String? ticker,
    String? company,
    String? sector,
    String? industry,
    RecommendationAction? action,
    double? opportunityScore,
    double? regimeFit,
    double? trendQuality,
    double? revisionTrend,
    double? convictionScore,
    double? fragilityScore,
    double? asymmetryScore,
    double? riskScore,
    double? confidenceScore,
    String? summary,
    List<String>? whyItRanks,
    List<String>? whatCouldGoWrong,
    List<String>? invalidationSignals,
    List<String>? recentChanges,
    String? stabilitySummary,
    OptionsSignal? optionsSignal,
    List<PeerScore>? peers,
    double? lastPrice,
    MetricTrend? opportunityTrend,
    MetricTrend? fragilityTrend,
    MetricTrend? regimeFitTrend,
    MetricTrend? convictionTrend,
    ForecastPack? forecasts,
    ConfidenceBreakdown? confidenceBreakdown,
    List<CounterfactualSensitivity>? counterfactuals,
    List<PeerContrast>? peerContrast,
    List<DecayedSignal>? decayedSignals,
    List<MacroGate>? macroGates,
    CorrelationCluster? correlationCluster,
    DecisionTrustReport? decisionTrust,
  }) {
    return StockInsight(
      ticker: ticker ?? this.ticker,
      company: company ?? this.company,
      sector: sector ?? this.sector,
      industry: industry ?? this.industry,
      action: action ?? this.action,
      opportunityScore: opportunityScore ?? this.opportunityScore,
      regimeFit: regimeFit ?? this.regimeFit,
      trendQuality: trendQuality ?? this.trendQuality,
      revisionTrend: revisionTrend ?? this.revisionTrend,
      convictionScore: convictionScore ?? this.convictionScore,
      fragilityScore: fragilityScore ?? this.fragilityScore,
      asymmetryScore: asymmetryScore ?? this.asymmetryScore,
      riskScore: riskScore ?? this.riskScore,
      confidenceScore: confidenceScore ?? this.confidenceScore,
      summary: summary ?? this.summary,
      whyItRanks: whyItRanks ?? this.whyItRanks,
      whatCouldGoWrong: whatCouldGoWrong ?? this.whatCouldGoWrong,
      invalidationSignals: invalidationSignals ?? this.invalidationSignals,
      recentChanges: recentChanges ?? this.recentChanges,
      stabilitySummary: stabilitySummary ?? this.stabilitySummary,
      optionsSignal: optionsSignal ?? this.optionsSignal,
      peers: peers ?? this.peers,
      lastPrice: lastPrice ?? this.lastPrice,
      opportunityTrend: opportunityTrend ?? this.opportunityTrend,
      fragilityTrend: fragilityTrend ?? this.fragilityTrend,
      regimeFitTrend: regimeFitTrend ?? this.regimeFitTrend,
      convictionTrend: convictionTrend ?? this.convictionTrend,
      forecasts: forecasts ?? this.forecasts,
      confidenceBreakdown: confidenceBreakdown ?? this.confidenceBreakdown,
      counterfactuals: counterfactuals ?? this.counterfactuals,
      peerContrast: peerContrast ?? this.peerContrast,
      decayedSignals: decayedSignals ?? this.decayedSignals,
      macroGates: macroGates ?? this.macroGates,
      correlationCluster: correlationCluster ?? this.correlationCluster,
      decisionTrust: decisionTrust ?? this.decisionTrust,
    );
  }
}

class SignalProvenanceComponent {
  const SignalProvenanceComponent({
    required this.label,
    required this.provenance,
    required this.detail,
    this.blocksStrongActions = false,
  });

  final String label;
  final SignalProvenance provenance;
  final String detail;
  final bool blocksStrongActions;

  bool get isReal =>
      provenance == SignalProvenance.live ||
      provenance == SignalProvenance.cached;
}

class DecisionTrustReport {
  const DecisionTrustReport({
    required this.level,
    required this.summary,
    required this.components,
    this.originalAction,
    this.gatedAction,
  });

  const DecisionTrustReport.actionable()
    : level = DecisionTrustLevel.actionable,
      summary =
          'The required signal stack is sufficiently covered for this action.',
      components = const <SignalProvenanceComponent>[],
      originalAction = null,
      gatedAction = null;

  final DecisionTrustLevel level;
  final String summary;
  final List<SignalProvenanceComponent> components;
  final RecommendationAction? originalAction;
  final RecommendationAction? gatedAction;

  bool get isActionable => level == DecisionTrustLevel.actionable;
  bool get isResearchOnly => level == DecisionTrustLevel.researchOnly;
  bool get isInsufficient => level == DecisionTrustLevel.insufficientData;
  bool get actionWasGated =>
      originalAction != null &&
      gatedAction != null &&
      originalAction != gatedAction;

  DecisionTrustReport copyWith({
    DecisionTrustLevel? level,
    String? summary,
    List<SignalProvenanceComponent>? components,
    RecommendationAction? originalAction,
    RecommendationAction? gatedAction,
  }) {
    return DecisionTrustReport(
      level: level ?? this.level,
      summary: summary ?? this.summary,
      components: components ?? this.components,
      originalAction: originalAction ?? this.originalAction,
      gatedAction: gatedAction ?? this.gatedAction,
    );
  }
}

class OptionsSignal {
  const OptionsSignal({
    required this.ivRank,
    required this.realizedGap,
    required this.skewChange,
    required this.eventPremium,
    required this.commentary,
    this.termStructureSlope = 0,
    this.frontMonthSkew = 0,
    this.backMonthSkew = 0,
    this.gammaExposure = 0,
    this.pinningRisk = 0,
    this.unusualFlowRatio = 1.0,
    this.putCallRatio = 1.0,
    this.dealerPositioning = 0,
    this.flowCommentary = '',
  });

  final double ivRank;
  final double realizedGap;
  final double skewChange;
  final double eventPremium;
  final String commentary;
  final double termStructureSlope;
  final double frontMonthSkew;
  final double backMonthSkew;
  final double gammaExposure;
  final double pinningRisk;
  final double unusualFlowRatio;
  final double putCallRatio;
  final double dealerPositioning;
  final String flowCommentary;

  bool get isContango => termStructureSlope > 2;
  bool get isBackwardated => termStructureSlope < -2;
  bool get hasUnusualFlow => unusualFlowRatio >= 1.6;
  bool get isPinningLikely => pinningRisk >= 55;
  bool get dealerShort => dealerPositioning < -20;
}

class PeerScore {
  const PeerScore({
    required this.ticker,
    required this.company,
    required this.relativeStrength,
    required this.revisionTrend,
    required this.crowdingScore,
  });

  final String ticker;
  final String company;
  final double relativeStrength;
  final double revisionTrend;
  final double crowdingScore;
}

class SellAlert {
  const SellAlert({
    required this.ticker,
    required this.company,
    required this.action,
    required this.severity,
    required this.thesisDamageScore,
    required this.clusterCount,
    required this.summary,
    required this.triggers,
    required this.nextCheck,
    this.decayedTriggers = const <DecayedSignal>[],
    this.macroGates = const <MacroGate>[],
    this.effectiveClusterWeight = 0,
    this.correlationCluster,
    this.exitProbability = 0,
  });

  final String ticker;
  final String company;
  final RecommendationAction action;
  final AlertSeverity severity;
  final double thesisDamageScore;
  final int clusterCount;
  final String summary;
  final List<String> triggers;
  final String nextCheck;
  final List<DecayedSignal> decayedTriggers;
  final List<MacroGate> macroGates;
  final double effectiveClusterWeight;
  final CorrelationCluster? correlationCluster;
  final double exitProbability;
}

class ScenarioOutcome {
  const ScenarioOutcome({
    required this.type,
    required this.title,
    required this.description,
    required this.regimeImpact,
    required this.favoredExposures,
    required this.vulnerableExposures,
    required this.stockImpacts,
    this.sensitivityScore = 0,
    this.sensitivityTrend,
    this.fullBoardImpacts = const <ScenarioStockImpact>[],
    this.label,
    this.probability = 0,
  });

  final ScenarioType type;
  final String title;
  final String description;
  final String regimeImpact;
  final List<String> favoredExposures;
  final List<String> vulnerableExposures;
  final List<ScenarioStockImpact> stockImpacts;
  final double sensitivityScore;
  final MetricTrend? sensitivityTrend;
  final List<ScenarioStockImpact> fullBoardImpacts;
  final String? label;
  final double probability;

  ScenarioOutcome copyWith({
    ScenarioType? type,
    String? title,
    String? description,
    String? regimeImpact,
    List<String>? favoredExposures,
    List<String>? vulnerableExposures,
    List<ScenarioStockImpact>? stockImpacts,
    double? sensitivityScore,
    MetricTrend? sensitivityTrend,
    List<ScenarioStockImpact>? fullBoardImpacts,
    String? label,
    double? probability,
  }) {
    return ScenarioOutcome(
      type: type ?? this.type,
      title: title ?? this.title,
      description: description ?? this.description,
      regimeImpact: regimeImpact ?? this.regimeImpact,
      favoredExposures: favoredExposures ?? this.favoredExposures,
      vulnerableExposures: vulnerableExposures ?? this.vulnerableExposures,
      stockImpacts: stockImpacts ?? this.stockImpacts,
      sensitivityScore: sensitivityScore ?? this.sensitivityScore,
      sensitivityTrend: sensitivityTrend ?? this.sensitivityTrend,
      fullBoardImpacts: fullBoardImpacts ?? this.fullBoardImpacts,
      label: label ?? this.label,
      probability: probability ?? this.probability,
    );
  }
}

class ScenarioStockImpact {
  const ScenarioStockImpact({
    required this.ticker,
    required this.action,
    required this.deltaOpportunity,
    required this.rationale,
  });

  final String ticker;
  final String action;
  final double deltaOpportunity;
  final String rationale;
}

/// Probability distribution for a forecast. Values encode a roughly-normal band
/// by mean, stddev, and explicit quantiles so the UI can render bands without
/// re-sampling.
class ProbabilityDistribution {
  const ProbabilityDistribution({
    required this.mean,
    required this.stdDev,
    required this.p10,
    required this.p25,
    required this.p50,
    required this.p75,
    required this.p90,
    this.unit = '%',
  });

  final double mean;
  final double stdDev;
  final double p10;
  final double p25;
  final double p50;
  final double p75;
  final double p90;
  final String unit;

  double get spread => p90 - p10;

  bool get isSkewedUp => (p75 - p50) > (p50 - p25) * 1.15;
  bool get isSkewedDown => (p50 - p25) > (p75 - p50) * 1.15;
}

/// A bundle of probabilistic forecasts for a single stock.
class ForecastPack {
  const ForecastPack({
    required this.outperformSectorProbability,
    required this.drawdownOver8pctProbability,
    required this.earningsGapExceedsImpliedProbability,
    required this.leadershipRotationProbability,
    required this.breakoutPersistenceProbability,
    required this.forwardReturn20d,
    required this.forwardReturn60d,
    required this.horizonLabel,
  });

  const ForecastPack.empty()
    : outperformSectorProbability = 0,
      drawdownOver8pctProbability = 0,
      earningsGapExceedsImpliedProbability = 0,
      leadershipRotationProbability = 0,
      breakoutPersistenceProbability = 0,
      forwardReturn20d = const ProbabilityDistribution(
        mean: 0,
        stdDev: 0,
        p10: 0,
        p25: 0,
        p50: 0,
        p75: 0,
        p90: 0,
      ),
      forwardReturn60d = const ProbabilityDistribution(
        mean: 0,
        stdDev: 0,
        p10: 0,
        p25: 0,
        p50: 0,
        p75: 0,
        p90: 0,
      ),
      horizonLabel = '';

  final double outperformSectorProbability;
  final double drawdownOver8pctProbability;
  final double earningsGapExceedsImpliedProbability;
  final double leadershipRotationProbability;
  final double breakoutPersistenceProbability;
  final ProbabilityDistribution forwardReturn20d;
  final ProbabilityDistribution forwardReturn60d;
  final String horizonLabel;

  bool get isEmpty => horizonLabel.isEmpty;

  ForecastPack copyWith({
    double? outperformSectorProbability,
    double? drawdownOver8pctProbability,
    double? earningsGapExceedsImpliedProbability,
    double? leadershipRotationProbability,
    double? breakoutPersistenceProbability,
    ProbabilityDistribution? forwardReturn20d,
    ProbabilityDistribution? forwardReturn60d,
    String? horizonLabel,
  }) {
    return ForecastPack(
      outperformSectorProbability:
          outperformSectorProbability ?? this.outperformSectorProbability,
      drawdownOver8pctProbability:
          drawdownOver8pctProbability ?? this.drawdownOver8pctProbability,
      earningsGapExceedsImpliedProbability:
          earningsGapExceedsImpliedProbability ??
          this.earningsGapExceedsImpliedProbability,
      leadershipRotationProbability:
          leadershipRotationProbability ?? this.leadershipRotationProbability,
      breakoutPersistenceProbability:
          breakoutPersistenceProbability ?? this.breakoutPersistenceProbability,
      forwardReturn20d: forwardReturn20d ?? this.forwardReturn20d,
      forwardReturn60d: forwardReturn60d ?? this.forwardReturn60d,
      horizonLabel: horizonLabel ?? this.horizonLabel,
    );
  }
}

/// Multi-component confidence. Each component is a signed contribution; when
/// strong positives and negatives both exist we flag the result conflicted.
class ConfidenceComponent {
  const ConfidenceComponent({
    required this.label,
    required this.weight,
    required this.value,
    required this.supporting,
    this.rationale = '',
  });

  final String label;
  final double weight;
  final double value;
  final bool supporting;
  final String rationale;
}

class ConfidenceBreakdown {
  const ConfidenceBreakdown({
    required this.composite,
    required this.tier,
    required this.components,
    required this.conflictScore,
    this.summary = '',
  });

  const ConfidenceBreakdown.empty()
    : composite = 0,
      tier = ConfidenceTier.low,
      components = const <ConfidenceComponent>[],
      conflictScore = 0,
      summary = '';

  final double composite;
  final ConfidenceTier tier;
  final List<ConfidenceComponent> components;
  final double conflictScore;
  final String summary;

  bool get isConflicted => tier == ConfidenceTier.conflicted;
}

/// What would happen to the opportunity score if a single input component
/// shifted by ±N points? Lets the UI show score sensitivity.
class CounterfactualSensitivity {
  const CounterfactualSensitivity({
    required this.component,
    required this.deltaInput,
    required this.deltaOpportunity,
    required this.deltaRankSlots,
    required this.flipAction,
    required this.narrative,
  });

  final String component;
  final double deltaInput;
  final double deltaOpportunity;
  final int deltaRankSlots;
  final RecommendationAction? flipAction;
  final String narrative;
}

/// Ranks this stock vs. its peer group on specific axes and explains the
/// positive/negative gaps.
class PeerContrast {
  const PeerContrast({
    required this.axis,
    required this.selfValue,
    required this.peerMedian,
    required this.rankInPeerGroup,
    required this.totalPeers,
    required this.narrative,
  });

  final String axis;
  final double selfValue;
  final double peerMedian;
  final int rankInPeerGroup;
  final int totalPeers;
  final String narrative;

  double get gap => selfValue - peerMedian;
}

/// A deterioration signal that carries freshness. Older signals contribute
/// less to cluster totals than fresh ones.
class DecayedSignal {
  const DecayedSignal({
    required this.label,
    required this.firstObserved,
    required this.ageInSessions,
    required this.weight,
    required this.severity,
  });

  final String label;
  final DateTime firstObserved;
  final int ageInSessions;
  final double weight;
  final double severity;

  bool get isFresh => ageInSessions <= 3;
  bool get isStale => ageInSessions > 12;
}

/// A macro condition that must hold for an action to be taken. Example:
/// "Don't exit if credit is tight but improving."
class MacroGate {
  const MacroGate({
    required this.label,
    required this.isSatisfied,
    required this.rationale,
  });

  final String label;
  final bool isSatisfied;
  final String rationale;
}

/// Regime-transition forecast: what regime is likely next, with what
/// probability, and what would trigger it.
class RegimeTransition {
  const RegimeTransition({
    required this.fromRegime,
    required this.toRegime,
    required this.probability,
    required this.triggers,
    required this.rationale,
  });

  final MarketRegimeType fromRegime;
  final MarketRegimeType toRegime;
  final double probability;
  final List<String> triggers;
  final String rationale;
}

class RegimeProbability {
  const RegimeProbability({required this.regime, required this.probability});

  final MarketRegimeType regime;
  final double probability;
}

/// Decomposes breadth health by sector so users can see which sectors are
/// pulling the aggregate up or down.
class SectorBreadthRow {
  const SectorBreadthRow({
    required this.sector,
    required this.participation,
    required this.leadership,
    required this.divergence,
    required this.tone,
  });

  final String sector;
  final double participation;
  final double leadership;
  final double divergence;
  final SignalTone tone;
}

/// Cluster of correlated stocks: when one breaks, others tend to follow.
/// Used for cross-holding correlation in sell discipline.
class CorrelationCluster {
  const CorrelationCluster({
    required this.clusterId,
    required this.label,
    required this.tickers,
    required this.correlationStrength,
    required this.narrative,
  });

  final String clusterId;
  final String label;
  final List<String> tickers;
  final double correlationStrength;
  final String narrative;

  bool get isConcentrated => correlationStrength >= 65;
}

/// User-supplied custom scenario definition. Sign-weighted shocks to the
/// market environment that the engine re-ranks against.
class CustomScenarioDefinition {
  const CustomScenarioDefinition({
    required this.label,
    required this.description,
    this.creditStressDelta = 0,
    this.impliedVolDelta = 0,
    this.growthLeadershipDelta = 0,
    this.rateShockDelta = 0,
    this.breadthDelta = 0,
  });

  final String label;
  final String description;
  final double creditStressDelta;
  final double impliedVolDelta;
  final double growthLeadershipDelta;
  final double rateShockDelta;
  final double breadthDelta;
}
