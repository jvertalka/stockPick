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
    required this.opportunities,
    required this.sellAlerts,
    required this.scenarios,
  });

  final DateTime asOf;
  final MarketRadar marketRadar;
  final List<StockInsight> opportunities;
  final List<SellAlert> sellAlerts;
  final List<ScenarioOutcome> scenarios;

  StockInsight stockByTicker(String ticker) {
    return opportunities.firstWhere(
      (stock) => stock.ticker == ticker,
      orElse: () => opportunities.first,
    );
  }

  ScenarioOutcome scenarioByType(ScenarioType type) {
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
}

class RadarMetric {
  const RadarMetric({
    required this.label,
    required this.value,
    required this.detail,
    required this.tone,
  });

  final String label;
  final String value;
  final String detail;
  final SignalTone tone;
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

  String get confidenceLabel {
    if (confidenceScore >= 80) {
      return 'High confidence';
    }
    if (confidenceScore >= 62) {
      return 'Moderate confidence';
    }
    return 'Low confidence';
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
  });

  final ScenarioType type;
  final String title;
  final String description;
  final String regimeImpact;
  final List<String> favoredExposures;
  final List<String> vulnerableExposures;
  final List<ScenarioStockImpact> stockImpacts;
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
