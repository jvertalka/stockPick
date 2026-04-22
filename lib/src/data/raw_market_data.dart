class RawMarketState {
  const RawMarketState({
    required this.asOf,
    required this.environment,
    required this.styles,
    required this.sectors,
    required this.stocks,
  });

  final DateTime asOf;
  final RawMarketEnvironment environment;
  final List<RawStyleSignal> styles;
  final List<RawSectorSignal> sectors;
  final List<RawStockSignal> stocks;
}

class RawMarketEnvironment {
  const RawMarketEnvironment({
    required this.indexTrend,
    required this.realizedVolatility,
    required this.impliedVolatility,
    required this.creditStress,
    required this.financialConditions,
    required this.growthLeadership,
    required this.defensiveLeadership,
    required this.smallCapLeadership,
    required this.inflationPressure,
    required this.breadth,
    required this.advanceDecline,
    required this.newHighLow,
    required this.percentAboveMajorAverages,
    required this.equalWeightConfirmation,
    required this.sectorParticipation,
    required this.correlation,
    required this.dispersion,
    required this.volumeConcentration,
  });

  final double indexTrend;
  final double realizedVolatility;
  final double impliedVolatility;
  final double creditStress;
  final double financialConditions;
  final double growthLeadership;
  final double defensiveLeadership;
  final double smallCapLeadership;
  final double inflationPressure;
  final double breadth;
  final double advanceDecline;
  final double newHighLow;
  final double percentAboveMajorAverages;
  final double equalWeightConfirmation;
  final double sectorParticipation;
  final double correlation;
  final double dispersion;
  final double volumeConcentration;
}

class RawStyleSignal {
  const RawStyleSignal({
    required this.style,
    required this.strength,
    required this.note,
  });

  final String style;
  final double strength;
  final String note;
}

class RawSectorSignal {
  const RawSectorSignal({
    required this.sector,
    required this.strength,
    required this.breadth,
    required this.revisions,
    required this.sponsorship,
    required this.crowdingRisk,
    required this.note,
  });

  final String sector;
  final double strength;
  final double breadth;
  final double revisions;
  final double sponsorship;
  final double crowdingRisk;
  final String note;
}

class RawStockSignal {
  const RawStockSignal({
    required this.ticker,
    required this.company,
    required this.sector,
    required this.industry,
    required this.shortTrend,
    required this.mediumTrend,
    required this.longTrend,
    required this.residualStrength,
    required this.momentumPersistence,
    required this.breakoutQuality,
    required this.volumeSupport,
    required this.earningsRevisions,
    required this.earningsSurprise,
    required this.marginTrend,
    required this.revenueTrend,
    required this.freeCashFlowTrend,
    required this.balanceSheetQuality,
    required this.profitability,
    required this.leverageQuality,
    required this.earningsStability,
    required this.valuationSupport,
    required this.crowdingRisk,
    required this.impliedVolRank,
    required this.realizedImpliedGap,
    required this.putSkewChange,
    required this.eventPremium,
    required this.downsideProtectionDemand,
    required this.relativeStrengthDelta,
    required this.sectorBreadthDelta,
    required this.revisionDelta,
    required this.priceResponse,
    required this.abnormalDownVolume,
    required this.volatilityRepricing,
    required this.peerLeadership,
    required this.growthExposure,
    required this.defensiveExposure,
    required this.creditSensitivity,
    required this.rateSensitivity,
    required this.expectedStability,
    required this.peers,
  });

  final String ticker;
  final String company;
  final String sector;
  final String industry;
  final double shortTrend;
  final double mediumTrend;
  final double longTrend;
  final double residualStrength;
  final double momentumPersistence;
  final double breakoutQuality;
  final double volumeSupport;
  final double earningsRevisions;
  final double earningsSurprise;
  final double marginTrend;
  final double revenueTrend;
  final double freeCashFlowTrend;
  final double balanceSheetQuality;
  final double profitability;
  final double leverageQuality;
  final double earningsStability;
  final double valuationSupport;
  final double crowdingRisk;
  final double impliedVolRank;
  final double realizedImpliedGap;
  final double putSkewChange;
  final double eventPremium;
  final double downsideProtectionDemand;
  final double relativeStrengthDelta;
  final double sectorBreadthDelta;
  final double revisionDelta;
  final double priceResponse;
  final double abnormalDownVolume;
  final double volatilityRepricing;
  final double peerLeadership;
  final double growthExposure;
  final double defensiveExposure;
  final double creditSensitivity;
  final double rateSensitivity;
  final double expectedStability;
  final List<RawPeerSignal> peers;
}

class RawPeerSignal {
  const RawPeerSignal({
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

class ValidationWindow {
  const ValidationWindow({
    required this.asOf,
    required this.marketState,
    required this.outcomes,
  });

  final DateTime asOf;
  final RawMarketState marketState;
  final List<ValidationOutcome> outcomes;
}

class ValidationOutcome {
  const ValidationOutcome({
    required this.ticker,
    required this.forwardReturn20d,
    required this.sectorReturn20d,
    required this.maxDrawdown20d,
  });

  final String ticker;
  final double forwardReturn20d;
  final double sectorReturn20d;
  final double maxDrawdown20d;
}
