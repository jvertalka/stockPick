import 'dart:math' as math;

import 'raw_market_data.dart';

/// Derives realistic values for new raw-data fields from existing ones so the
/// oracle engine has populated inputs even when the underlying fixture or
/// adapter hasn't explicitly provided them yet.
///
/// Everything here is deterministic: same inputs always produce the same
/// derived outputs, so snapshots remain reproducible.
class RawDataEnrichment {
  const RawDataEnrichment();

  RawMarketState enrichState(RawMarketState state) {
    final env = enrichEnvironment(state.environment);
    final enrichedStocks = state.stocks
        .map((stock) => enrichStock(stock, env))
        .toList();
    return RawMarketState(
      asOf: state.asOf,
      environment: env,
      styles: state.styles,
      sectors: state.sectors,
      stocks: enrichedStocks,
    );
  }

  RawMarketEnvironment enrichEnvironment(RawMarketEnvironment env) {
    if (env.breadthByPhase.isNotEmpty &&
        env.volTermStructure != 0 &&
        env.regimePersistenceSessions != 0) {
      return env;
    }

    final stability = (
      env.breadth * 0.3 +
      (100 - env.creditStress) * 0.3 +
      (100 - env.impliedVolatility) * 0.2 +
      env.sectorParticipation * 0.2
    ).clamp(10, 95).toDouble();

    final termStructure = env.impliedVolatility > 58
        ? -4 - ((env.impliedVolatility - 58) / 10)
        : 6 - ((env.impliedVolatility - 40) / 8);

    final persistence = (env.breadth / 4).round();
    final slope = (env.financialConditions - 50) / 12;

    final breadthByPhase = {
      'Leaders above 50DMA': env.percentAboveMajorAverages,
      'Laggards above 50DMA':
          (env.percentAboveMajorAverages - 15).clamp(0, 100).toDouble(),
      'New highs last 20d': env.newHighLow,
      'New lows last 20d': (100 - env.newHighLow) * 0.6,
    };

    return RawMarketEnvironment(
      indexTrend: env.indexTrend,
      realizedVolatility: env.realizedVolatility,
      impliedVolatility: env.impliedVolatility,
      creditStress: env.creditStress,
      financialConditions: env.financialConditions,
      growthLeadership: env.growthLeadership,
      defensiveLeadership: env.defensiveLeadership,
      smallCapLeadership: env.smallCapLeadership,
      inflationPressure: env.inflationPressure,
      breadth: env.breadth,
      advanceDecline: env.advanceDecline,
      newHighLow: env.newHighLow,
      percentAboveMajorAverages: env.percentAboveMajorAverages,
      equalWeightConfirmation: env.equalWeightConfirmation,
      sectorParticipation: env.sectorParticipation,
      correlation: env.correlation,
      dispersion: env.dispersion,
      volumeConcentration: env.volumeConcentration,
      regimeStability: stability,
      regimePersistenceSessions: persistence,
      volTermStructure: termStructure,
      yieldCurveSlope: slope,
      breadthByPhase: breadthByPhase,
    );
  }

  RawStockSignal enrichStock(
    RawStockSignal stock,
    RawMarketEnvironment env,
  ) {
    // Already enriched? Pass through.
    if (stock.correlationStrength != 0 ||
        stock.signalFirstObservedDays.isNotEmpty ||
        stock.expectedMoveEarnings != 0) {
      return stock;
    }

    final rand = _deterministicRng(stock.ticker);

    final termSlope = -4 + (stock.impliedVolRank - 50) / 20 + rand(-2, 2);
    final frontSkew =
        (stock.putSkewChange + rand(-5, 5)).clamp(0, 100).toDouble();
    final backSkew =
        (stock.putSkewChange * 0.8 + rand(-5, 5)).clamp(0, 100).toDouble();
    final gammaExposure =
        ((stock.crowdingRisk - 50) * 0.6 + rand(-5, 5)).clamp(-60, 60).toDouble();
    final pinningRisk = stock.impliedVolRank < 50
        ? (55 + (stock.valuationSupport - 50) * 0.4 + rand(-5, 5))
            .clamp(0, 100)
            .toDouble()
        : (30 + rand(-5, 10)).clamp(0, 100).toDouble();

    final unusualFlow = 1.0 +
        (stock.putSkewChange - 50) / 60 +
        (stock.impliedVolRank - 50) / 100 +
        rand(-0.25, 0.35);
    final unusualFlowClamped = unusualFlow.clamp(0.4, 3.5).toDouble();

    final putCallRatio =
        (0.7 + (stock.putSkewChange - 50) / 120 + rand(-0.1, 0.15))
            .clamp(0.3, 2.4)
            .toDouble();

    final dealerPositioning = (-(stock.impliedVolRank - 50) * 0.5 -
            (stock.putSkewChange - 50) * 0.4 +
            rand(-8, 8))
        .clamp(-80, 60)
        .toDouble();

    final clusterId = _clusterIdFor(stock);
    final correlationStrength =
        (55 + (stock.peerLeadership - 50) * 0.6 + rand(-8, 10))
            .clamp(20, 92)
            .toDouble();

    final signalAges = <String, int>{};
    if (stock.relativeStrengthDelta < 44) {
      signalAges['relative_strength'] =
          _signalAge(stock.relativeStrengthDelta, 44, rand);
    }
    if (stock.sectorBreadthDelta < 45) {
      signalAges['sector_breadth'] =
          _signalAge(stock.sectorBreadthDelta, 45, rand);
    }
    if (stock.revisionDelta < 43) {
      signalAges['revisions'] = _signalAge(stock.revisionDelta, 43, rand);
    }
    if (stock.priceResponse < 42) {
      signalAges['price_response'] = _signalAge(stock.priceResponse, 42, rand);
    }
    if (stock.abnormalDownVolume > 62) {
      signalAges['abnormal_volume'] =
          _signalAge(100 - stock.abnormalDownVolume, 38, rand);
    }
    if (stock.volatilityRepricing > 60) {
      signalAges['vol_repricing'] =
          _signalAge(100 - stock.volatilityRepricing, 40, rand);
    }
    if (stock.peerLeadership < 45) {
      signalAges['peer_leadership'] = _signalAge(stock.peerLeadership, 45, rand);
    }
    if (dealerPositioning < -30) {
      signalAges['dealer_short'] = 1 + rand(0, 4).toInt();
    }

    final expectedMoveEarnings =
        (stock.eventPremium * 6 + stock.impliedVolRank * 0.25 + rand(-8, 8))
            .clamp(0, 100)
            .toDouble();

    return RawStockSignal(
      ticker: stock.ticker,
      company: stock.company,
      sector: stock.sector,
      industry: stock.industry,
      shortTrend: stock.shortTrend,
      mediumTrend: stock.mediumTrend,
      longTrend: stock.longTrend,
      residualStrength: stock.residualStrength,
      momentumPersistence: stock.momentumPersistence,
      breakoutQuality: stock.breakoutQuality,
      volumeSupport: stock.volumeSupport,
      earningsRevisions: stock.earningsRevisions,
      earningsSurprise: stock.earningsSurprise,
      marginTrend: stock.marginTrend,
      revenueTrend: stock.revenueTrend,
      freeCashFlowTrend: stock.freeCashFlowTrend,
      balanceSheetQuality: stock.balanceSheetQuality,
      profitability: stock.profitability,
      leverageQuality: stock.leverageQuality,
      earningsStability: stock.earningsStability,
      valuationSupport: stock.valuationSupport,
      crowdingRisk: stock.crowdingRisk,
      impliedVolRank: stock.impliedVolRank,
      realizedImpliedGap: stock.realizedImpliedGap,
      putSkewChange: stock.putSkewChange,
      eventPremium: stock.eventPremium,
      downsideProtectionDemand: stock.downsideProtectionDemand,
      relativeStrengthDelta: stock.relativeStrengthDelta,
      sectorBreadthDelta: stock.sectorBreadthDelta,
      revisionDelta: stock.revisionDelta,
      priceResponse: stock.priceResponse,
      abnormalDownVolume: stock.abnormalDownVolume,
      volatilityRepricing: stock.volatilityRepricing,
      peerLeadership: stock.peerLeadership,
      growthExposure: stock.growthExposure,
      defensiveExposure: stock.defensiveExposure,
      creditSensitivity: stock.creditSensitivity,
      rateSensitivity: stock.rateSensitivity,
      expectedStability: stock.expectedStability,
      peers: stock.peers,
      volTermStructureSlope: termSlope,
      frontMonthSkew: frontSkew,
      backMonthSkew: backSkew,
      gammaExposure: gammaExposure,
      pinningRisk: pinningRisk,
      unusualFlowRatio: unusualFlowClamped,
      putCallRatio: putCallRatio,
      dealerPositioning: dealerPositioning,
      correlationClusterId: clusterId,
      correlationStrength: correlationStrength,
      signalFirstObservedDays: signalAges,
      expectedMoveEarnings: expectedMoveEarnings,
    );
  }

  String _clusterIdFor(RawStockSignal stock) {
    final industry = stock.industry.trim().toLowerCase();
    if (industry.isNotEmpty) {
      return industry.replaceAll(' ', '_');
    }
    return stock.sector.trim().toLowerCase().replaceAll(' ', '_');
  }

  int _signalAge(double value, double threshold, double Function(num, num) rand) {
    final gap = (threshold - value).clamp(0, 50);
    final base = 1 + (gap / 3).round();
    return (base + rand(0, 3).toInt()).clamp(1, 30);
  }

  double Function(num lo, num hi) _deterministicRng(String seed) {
    final rng = math.Random(
      seed.codeUnits.fold<int>(1, (acc, c) => acc * 31 + c),
    );
    return (num lo, num hi) => lo.toDouble() + rng.nextDouble() * (hi - lo);
  }
}
