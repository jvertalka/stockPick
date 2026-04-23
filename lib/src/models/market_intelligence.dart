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
}

extension ScenarioTypeLabel on ScenarioType {
  String get label => switch (this) {
    ScenarioType.creditWidening => 'Credit spreads widen',
    ScenarioType.volatilityShock => 'Volatility jumps 20%',
    ScenarioType.growthLeadershipBreak => 'Growth leadership breaks',
    ScenarioType.ratesFallingQuickly => 'Rates fall quickly',
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
  });

  final DateTime asOf;
  final MarketRadar marketRadar;
  final List<StockInsight> rankedUniverse;
  final List<StockInsight> opportunities;
  final List<SellAlert> sellAlerts;
  final List<ScenarioOutcome> scenarios;

  MarketIntelligenceSnapshot copyWith({
    DateTime? asOf,
    MarketRadar? marketRadar,
    List<StockInsight>? rankedUniverse,
    List<StockInsight>? opportunities,
    List<SellAlert>? sellAlerts,
    List<ScenarioOutcome>? scenarios,
  }) {
    return MarketIntelligenceSnapshot(
      asOf: asOf ?? this.asOf,
      marketRadar: marketRadar ?? this.marketRadar,
      rankedUniverse: rankedUniverse ?? this.rankedUniverse,
      opportunities: opportunities ?? this.opportunities,
      sellAlerts: sellAlerts ?? this.sellAlerts,
      scenarios: scenarios ?? this.scenarios,
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
    this.opportunityTrend,
    this.fragilityTrend,
    this.regimeFitTrend,
    this.convictionTrend,
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
  final MetricTrend? opportunityTrend;
  final MetricTrend? fragilityTrend;
  final MetricTrend? regimeFitTrend;
  final MetricTrend? convictionTrend;

  String get confidenceLabel {
    if (confidenceScore >= 80) {
      return 'High confidence';
    }
    if (confidenceScore >= 62) {
      return 'Moderate confidence';
    }
    return 'Low confidence';
  }

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
    MetricTrend? opportunityTrend,
    MetricTrend? fragilityTrend,
    MetricTrend? regimeFitTrend,
    MetricTrend? convictionTrend,
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
      opportunityTrend: opportunityTrend ?? this.opportunityTrend,
      fragilityTrend: fragilityTrend ?? this.fragilityTrend,
      regimeFitTrend: regimeFitTrend ?? this.regimeFitTrend,
      convictionTrend: convictionTrend ?? this.convictionTrend,
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
  });

  final double ivRank;
  final double realizedGap;
  final double skewChange;
  final double eventPremium;
  final String commentary;
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
