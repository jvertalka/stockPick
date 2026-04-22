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

  Map<String, dynamic> toJson() => {
    'asOf': asOf.toIso8601String(),
    'environment': environment.toJson(),
    'styles': styles.map((style) => style.toJson()).toList(),
    'sectors': sectors.map((sector) => sector.toJson()).toList(),
    'stocks': stocks.map((stock) => stock.toJson()).toList(),
  };

  factory RawMarketState.fromJson(Map<String, dynamic> json) => RawMarketState(
    asOf: DateTime.parse(json['asOf'] as String),
    environment: RawMarketEnvironment.fromJson(
      json['environment'] as Map<String, dynamic>,
    ),
    styles: (json['styles'] as List<dynamic>)
        .map((style) => RawStyleSignal.fromJson(style as Map<String, dynamic>))
        .toList(),
    sectors: (json['sectors'] as List<dynamic>)
        .map(
          (sector) => RawSectorSignal.fromJson(sector as Map<String, dynamic>),
        )
        .toList(),
    stocks: (json['stocks'] as List<dynamic>)
        .map((stock) => RawStockSignal.fromJson(stock as Map<String, dynamic>))
        .toList(),
  );
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

  Map<String, dynamic> toJson() => {
    'indexTrend': indexTrend,
    'realizedVolatility': realizedVolatility,
    'impliedVolatility': impliedVolatility,
    'creditStress': creditStress,
    'financialConditions': financialConditions,
    'growthLeadership': growthLeadership,
    'defensiveLeadership': defensiveLeadership,
    'smallCapLeadership': smallCapLeadership,
    'inflationPressure': inflationPressure,
    'breadth': breadth,
    'advanceDecline': advanceDecline,
    'newHighLow': newHighLow,
    'percentAboveMajorAverages': percentAboveMajorAverages,
    'equalWeightConfirmation': equalWeightConfirmation,
    'sectorParticipation': sectorParticipation,
    'correlation': correlation,
    'dispersion': dispersion,
    'volumeConcentration': volumeConcentration,
  };

  factory RawMarketEnvironment.fromJson(Map<String, dynamic> json) =>
      RawMarketEnvironment(
        indexTrend: _readDouble(json, 'indexTrend'),
        realizedVolatility: _readDouble(json, 'realizedVolatility'),
        impliedVolatility: _readDouble(json, 'impliedVolatility'),
        creditStress: _readDouble(json, 'creditStress'),
        financialConditions: _readDouble(json, 'financialConditions'),
        growthLeadership: _readDouble(json, 'growthLeadership'),
        defensiveLeadership: _readDouble(json, 'defensiveLeadership'),
        smallCapLeadership: _readDouble(json, 'smallCapLeadership'),
        inflationPressure: _readDouble(json, 'inflationPressure'),
        breadth: _readDouble(json, 'breadth'),
        advanceDecline: _readDouble(json, 'advanceDecline'),
        newHighLow: _readDouble(json, 'newHighLow'),
        percentAboveMajorAverages: _readDouble(
          json,
          'percentAboveMajorAverages',
        ),
        equalWeightConfirmation: _readDouble(json, 'equalWeightConfirmation'),
        sectorParticipation: _readDouble(json, 'sectorParticipation'),
        correlation: _readDouble(json, 'correlation'),
        dispersion: _readDouble(json, 'dispersion'),
        volumeConcentration: _readDouble(json, 'volumeConcentration'),
      );
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

  Map<String, dynamic> toJson() => {
    'style': style,
    'strength': strength,
    'note': note,
  };

  factory RawStyleSignal.fromJson(Map<String, dynamic> json) => RawStyleSignal(
    style: json['style'] as String,
    strength: _readDouble(json, 'strength'),
    note: json['note'] as String,
  );
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

  Map<String, dynamic> toJson() => {
    'sector': sector,
    'strength': strength,
    'breadth': breadth,
    'revisions': revisions,
    'sponsorship': sponsorship,
    'crowdingRisk': crowdingRisk,
    'note': note,
  };

  factory RawSectorSignal.fromJson(Map<String, dynamic> json) =>
      RawSectorSignal(
        sector: json['sector'] as String,
        strength: _readDouble(json, 'strength'),
        breadth: _readDouble(json, 'breadth'),
        revisions: _readDouble(json, 'revisions'),
        sponsorship: _readDouble(json, 'sponsorship'),
        crowdingRisk: _readDouble(json, 'crowdingRisk'),
        note: json['note'] as String,
      );
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

  Map<String, dynamic> toJson() => {
    'ticker': ticker,
    'company': company,
    'sector': sector,
    'industry': industry,
    'shortTrend': shortTrend,
    'mediumTrend': mediumTrend,
    'longTrend': longTrend,
    'residualStrength': residualStrength,
    'momentumPersistence': momentumPersistence,
    'breakoutQuality': breakoutQuality,
    'volumeSupport': volumeSupport,
    'earningsRevisions': earningsRevisions,
    'earningsSurprise': earningsSurprise,
    'marginTrend': marginTrend,
    'revenueTrend': revenueTrend,
    'freeCashFlowTrend': freeCashFlowTrend,
    'balanceSheetQuality': balanceSheetQuality,
    'profitability': profitability,
    'leverageQuality': leverageQuality,
    'earningsStability': earningsStability,
    'valuationSupport': valuationSupport,
    'crowdingRisk': crowdingRisk,
    'impliedVolRank': impliedVolRank,
    'realizedImpliedGap': realizedImpliedGap,
    'putSkewChange': putSkewChange,
    'eventPremium': eventPremium,
    'downsideProtectionDemand': downsideProtectionDemand,
    'relativeStrengthDelta': relativeStrengthDelta,
    'sectorBreadthDelta': sectorBreadthDelta,
    'revisionDelta': revisionDelta,
    'priceResponse': priceResponse,
    'abnormalDownVolume': abnormalDownVolume,
    'volatilityRepricing': volatilityRepricing,
    'peerLeadership': peerLeadership,
    'growthExposure': growthExposure,
    'defensiveExposure': defensiveExposure,
    'creditSensitivity': creditSensitivity,
    'rateSensitivity': rateSensitivity,
    'expectedStability': expectedStability,
    'peers': peers.map((peer) => peer.toJson()).toList(),
  };

  factory RawStockSignal.fromJson(Map<String, dynamic> json) => RawStockSignal(
    ticker: json['ticker'] as String,
    company: json['company'] as String,
    sector: json['sector'] as String,
    industry: json['industry'] as String,
    shortTrend: _readDouble(json, 'shortTrend'),
    mediumTrend: _readDouble(json, 'mediumTrend'),
    longTrend: _readDouble(json, 'longTrend'),
    residualStrength: _readDouble(json, 'residualStrength'),
    momentumPersistence: _readDouble(json, 'momentumPersistence'),
    breakoutQuality: _readDouble(json, 'breakoutQuality'),
    volumeSupport: _readDouble(json, 'volumeSupport'),
    earningsRevisions: _readDouble(json, 'earningsRevisions'),
    earningsSurprise: _readDouble(json, 'earningsSurprise'),
    marginTrend: _readDouble(json, 'marginTrend'),
    revenueTrend: _readDouble(json, 'revenueTrend'),
    freeCashFlowTrend: _readDouble(json, 'freeCashFlowTrend'),
    balanceSheetQuality: _readDouble(json, 'balanceSheetQuality'),
    profitability: _readDouble(json, 'profitability'),
    leverageQuality: _readDouble(json, 'leverageQuality'),
    earningsStability: _readDouble(json, 'earningsStability'),
    valuationSupport: _readDouble(json, 'valuationSupport'),
    crowdingRisk: _readDouble(json, 'crowdingRisk'),
    impliedVolRank: _readDouble(json, 'impliedVolRank'),
    realizedImpliedGap: _readDouble(json, 'realizedImpliedGap'),
    putSkewChange: _readDouble(json, 'putSkewChange'),
    eventPremium: _readDouble(json, 'eventPremium'),
    downsideProtectionDemand: _readDouble(json, 'downsideProtectionDemand'),
    relativeStrengthDelta: _readDouble(json, 'relativeStrengthDelta'),
    sectorBreadthDelta: _readDouble(json, 'sectorBreadthDelta'),
    revisionDelta: _readDouble(json, 'revisionDelta'),
    priceResponse: _readDouble(json, 'priceResponse'),
    abnormalDownVolume: _readDouble(json, 'abnormalDownVolume'),
    volatilityRepricing: _readDouble(json, 'volatilityRepricing'),
    peerLeadership: _readDouble(json, 'peerLeadership'),
    growthExposure: _readDouble(json, 'growthExposure'),
    defensiveExposure: _readDouble(json, 'defensiveExposure'),
    creditSensitivity: _readDouble(json, 'creditSensitivity'),
    rateSensitivity: _readDouble(json, 'rateSensitivity'),
    expectedStability: _readDouble(json, 'expectedStability'),
    peers: (json['peers'] as List<dynamic>? ?? const [])
        .map((peer) => RawPeerSignal.fromJson(peer as Map<String, dynamic>))
        .toList(),
  );
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

  Map<String, dynamic> toJson() => {
    'ticker': ticker,
    'company': company,
    'relativeStrength': relativeStrength,
    'revisionTrend': revisionTrend,
    'crowdingScore': crowdingScore,
  };

  factory RawPeerSignal.fromJson(Map<String, dynamic> json) => RawPeerSignal(
    ticker: json['ticker'] as String,
    company: json['company'] as String,
    relativeStrength: _readDouble(json, 'relativeStrength'),
    revisionTrend: _readDouble(json, 'revisionTrend'),
    crowdingScore: _readDouble(json, 'crowdingScore'),
  );
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

double _readDouble(Map<String, dynamic> json, String key) {
  return (json[key] as num).toDouble();
}
