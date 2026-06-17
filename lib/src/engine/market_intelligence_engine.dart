import 'dart:math' as math;

import '../data/raw_market_data.dart';
import '../models/market_intelligence.dart';

class MarketEvaluation {
  const MarketEvaluation({required this.snapshot, required this.scoredStocks});

  final MarketIntelligenceSnapshot snapshot;
  final List<DerivedStockSignal> scoredStocks;
}

class DerivedStockSignal {
  const DerivedStockSignal({
    required this.raw,
    required this.insight,
    required this.opportunityScore,
    required this.fragilityScore,
    required this.deteriorationSignals,
    required this.decayedSignals,
  });

  final RawStockSignal raw;
  final StockInsight insight;
  final double opportunityScore;
  final double fragilityScore;
  final List<String> deteriorationSignals;
  final List<DecayedSignal> decayedSignals;
}

class MarketIntelligenceEngine {
  MarketEvaluation evaluate(
    RawMarketState state, {
    bool includeDiagnostics = true,
  }) {
    final regimeContext = _analyzeRegime(state);
    final sectorMap = {
      for (final sector in state.sectors) sector.sector.toLowerCase(): sector,
    };

    final rawScored =
        state.stocks
            .map(
              (stock) => _scoreStockRaw(stock, state, regimeContext, sectorMap),
            )
            .toList()
          ..sort(
            (left, right) =>
                right.opportunityScore.compareTo(left.opportunityScore),
          );

    final rankIndex = {
      for (int index = 0; index < rawScored.length; index++)
        rawScored[index].raw.ticker: index,
    };

    final correlationClusters = _buildCorrelationClusters(rawScored);

    final sectorMedians = _sectorMedians(rawScored);

    final scoredStocks = rawScored
        .map(
          (raw) => _finalizeStock(
            raw,
            rawScored,
            rankIndex,
            sectorMap,
            state,
            regimeContext,
            correlationClusters,
            sectorMedians,
            includeDiagnostics,
          ),
        )
        .toList();

    final sellAlerts =
        scoredStocks
            .map(
              (signal) => _buildSellAlert(
                signal,
                state,
                regimeContext,
                correlationClusters,
              ),
            )
            .whereType<SellAlert>()
            .toList()
          ..sort(
            (left, right) =>
                right.thesisDamageScore.compareTo(left.thesisDamageScore),
          );

    final rankedUniverse = scoredStocks.map((item) => item.insight).toList();
    final opportunities = rankedUniverse.take(6).toList();

    final snapshot = MarketIntelligenceSnapshot(
      asOf: state.asOf,
      marketRadar: _buildMarketRadar(state, regimeContext),
      rankedUniverse: rankedUniverse,
      opportunities: opportunities,
      sellAlerts: sellAlerts,
      scenarios: _buildScenarios(scoredStocks, regimeContext, state),
    );

    return MarketEvaluation(snapshot: snapshot, scoredStocks: scoredStocks);
  }

  /// Run the engine with a custom scenario shock applied to the raw state. The
  /// Scenario Lab UI uses this to re-rank the full board under user-defined
  /// shocks.
  MarketIntelligenceSnapshot evaluateCustomScenario(
    RawMarketState state,
    CustomScenarioDefinition scenario,
  ) {
    final shocked = _applyScenarioShock(state, scenario);
    final evaluation = evaluate(shocked);
    final baseline = evaluate(state);
    final baselineByTicker = {
      for (final stock in baseline.snapshot.rankedUniverse) stock.ticker: stock,
    };
    final fullBoardImpacts = <ScenarioStockImpact>[];
    for (final shockedInsight in evaluation.snapshot.rankedUniverse) {
      final baselineInsight =
          baselineByTicker[shockedInsight.ticker] ?? shockedInsight;
      final delta =
          shockedInsight.opportunityScore - baselineInsight.opportunityScore;
      fullBoardImpacts.add(
        ScenarioStockImpact(
          ticker: shockedInsight.ticker,
          action: _scenarioActionFor(delta),
          deltaOpportunity: delta,
          rationale:
              'Custom scenario re-ranks this name by ${delta.toStringAsFixed(1)} points versus the baseline.',
        ),
      );
    }
    fullBoardImpacts.sort(
      (left, right) =>
          right.deltaOpportunity.abs().compareTo(left.deltaOpportunity.abs()),
    );

    final customOutcome = ScenarioOutcome(
      type: ScenarioType.custom,
      title: scenario.label,
      description: scenario.description,
      regimeImpact:
          'Custom shocks applied. Positive deltas mean the name looks better under the shock, negatives mean it looks worse.',
      favoredExposures: _favoredExposuresFromImpacts(fullBoardImpacts, true),
      vulnerableExposures: _favoredExposuresFromImpacts(
        fullBoardImpacts,
        false,
      ),
      stockImpacts: fullBoardImpacts.take(6).toList(),
      fullBoardImpacts: fullBoardImpacts,
      label: scenario.label,
      probability: 0,
    );

    return evaluation.snapshot.copyWith(customScenarios: [customOutcome]);
  }

  _RawStockScore _scoreStockRaw(
    RawStockSignal stock,
    RawMarketState state,
    _RegimeContext regimeContext,
    Map<String, RawSectorSignal> sectorMap,
  ) {
    final sector = sectorMap[stock.sector.toLowerCase()];

    final trendQuality = _average([
      stock.shortTrend,
      stock.mediumTrend,
      stock.longTrend,
      stock.residualStrength,
      stock.momentumPersistence,
      stock.breakoutQuality,
      stock.volumeSupport,
    ]);

    final revisionTrend = _average([
      stock.earningsRevisions,
      stock.earningsSurprise,
      stock.marginTrend,
      stock.revenueTrend,
      stock.freeCashFlowTrend,
      stock.revisionDelta,
    ]);

    final qualityScore = _average([
      stock.balanceSheetQuality,
      stock.profitability,
      stock.leverageQuality,
      stock.earningsStability,
      stock.expectedStability,
    ]);

    final optionsStress = _average([
      stock.impliedVolRank,
      stock.putSkewChange,
      stock.downsideProtectionDemand,
      stock.volatilityRepricing,
      stock.crowdingRisk,
      _optionsFlowStress(stock),
    ]);

    final fragilityScore = _average([
      optionsStress,
      100 - stock.priceResponse,
      100 - stock.peerLeadership,
      stock.abnormalDownVolume,
      100 - stock.valuationSupport,
    ]);

    final styleAlignment = _styleAlignment(stock, regimeContext);
    final sectorStrength = sector == null
        ? 50.0
        : _average([sector.strength, sector.breadth, sector.revisions]);

    final macroAlignment = _macroAlignment(
      stock,
      state.environment,
      regimeContext,
    );

    final regimeFit = _clampScore(
      0.42 * sectorStrength + 0.33 * styleAlignment + 0.25 * macroAlignment,
    );

    final asymmetryScore = _clampScore(
      0.28 * revisionTrend +
          0.24 * trendQuality +
          0.18 * qualityScore +
          0.16 * stock.valuationSupport +
          0.14 * (100 - fragilityScore),
    );

    final opportunityScore = _clampScore(
      0.3 * trendQuality +
          0.24 * revisionTrend +
          0.22 * regimeFit +
          0.12 * qualityScore +
          0.12 * stock.valuationSupport -
          0.18 * fragilityScore,
    );

    final convictionScore = _clampScore(
      0.34 * opportunityScore +
          0.24 * qualityScore +
          0.22 * regimeContext.confidence +
          0.20 * (100 - fragilityScore),
    );

    final riskScore = _clampScore(
      0.46 * fragilityScore +
          0.20 *
              state.environment.creditStress *
              stock.creditSensitivity /
              100 +
          0.18 * state.environment.impliedVolatility +
          0.16 * (100 - stock.priceResponse),
    );

    return _RawStockScore(
      raw: stock,
      sector: sector,
      trendQuality: trendQuality,
      revisionTrend: revisionTrend,
      qualityScore: qualityScore,
      fragilityScore: fragilityScore,
      sectorStrength: sectorStrength,
      styleAlignment: styleAlignment,
      macroAlignment: macroAlignment,
      regimeFit: regimeFit,
      asymmetryScore: asymmetryScore,
      opportunityScore: opportunityScore,
      convictionScore: convictionScore,
      riskScore: riskScore,
    );
  }

  DerivedStockSignal _finalizeStock(
    _RawStockScore scored,
    List<_RawStockScore> allStocks,
    Map<String, int> rankIndex,
    Map<String, RawSectorSignal> sectorMap,
    RawMarketState state,
    _RegimeContext regimeContext,
    Map<String, CorrelationCluster> clusters,
    Map<String, _SectorMedianSet> sectorMedians,
    bool includeDiagnostics,
  ) {
    final stock = scored.raw;
    final fragilityScore = scored.fragilityScore;
    final opportunityScore = scored.opportunityScore;
    final convictionScore = scored.convictionScore;

    final decayedSignals = _decayedSignals(stock, state.asOf);
    final effectiveClusterWeight = _effectiveWeight(decayedSignals);
    final macroGates = _macroGates(stock, state.environment, regimeContext);
    final clusterInfo = clusters[stock.ticker];

    final action = _actionFor(
      opportunityScore,
      scored.riskScore,
      effectiveClusterWeight,
      macroGates,
    );

    final confidenceBreakdown = _confidenceBreakdown(
      scored,
      regimeContext,
      effectiveClusterWeight,
      clusterInfo,
    );

    final forecasts = _forecastPack(scored, regimeContext, state.environment);

    final counterfactuals = includeDiagnostics
        ? _counterfactuals(
            scored,
            state,
            regimeContext,
            sectorMap,
            rankIndex,
            allStocks,
          )
        : const <CounterfactualSensitivity>[];

    final peerContrast = includeDiagnostics
        ? _peerContrast(
            scored,
            sectorMedians[stock.sector] ?? _SectorMedianSet.empty(),
          )
        : const <PeerContrast>[];

    final whyItRanks = _topNarratives([
      _NarrativeScore(
        score: stock.residualStrength,
        text:
            'Residual relative strength remains strong after controlling for sector and market drift.',
      ),
      _NarrativeScore(
        score: stock.earningsRevisions,
        text: 'Estimate revisions are still moving in the right direction.',
      ),
      _NarrativeScore(
        score: scored.sectorStrength,
        text:
            '${stock.sector} sponsorship is still supportive underneath the name.',
      ),
      _NarrativeScore(
        score: stock.breakoutQuality,
        text:
            'Breakout quality is backed by participation rather than a thin squeeze.',
      ),
      _NarrativeScore(
        score: stock.balanceSheetQuality,
        text:
            'Balance-sheet quality improves regime resilience if the tape turns less friendly.',
      ),
      _NarrativeScore(
        score: stock.freeCashFlowTrend,
        text: 'Free cash flow direction adds durability to the thesis.',
      ),
    ]);

    final whatCouldGoWrong = _topNarratives(
      [
        _NarrativeScore(
          score: stock.crowdingRisk,
          text:
              'Crowding is high enough that the next leg higher may demand cleaner execution.',
        ),
        _NarrativeScore(
          score: stock.putSkewChange,
          text:
              'Put skew has steepened, which can front-run a failed breakout.',
        ),
        _NarrativeScore(
          score: stock.eventPremium * 10,
          text:
              'Event premium is rich enough that disappointment could be punished quickly.',
        ),
        _NarrativeScore(
          score: 100 - stock.priceResponse,
          text:
              'Price response to good news has cooled, which weakens conviction.',
        ),
        _NarrativeScore(
          score: 100 - stock.peerLeadership,
          text:
              'Peer leadership is no longer as secure as it was earlier in the move.',
        ),
        _NarrativeScore(
          score: stock.pinningRisk,
          text:
              'Options pinning pressure is rising into the next expiry, which can cap upside even if the thesis still works.',
        ),
      ],
      descending: true,
      count: 4,
    );

    final invalidationSignals = [
      'Relative strength loses leadership versus ${stock.industry.toLowerCase()} peers.',
      'Sector breadth weakens while downside hedging continues to expand.',
      'Price stops rewarding good news for more than one update cycle.',
      if (clusterInfo != null && clusterInfo.isConcentrated)
        'Correlated cluster (${clusterInfo.label}) breaks down together.',
    ];

    final recentChanges = _recentChanges(stock, scored.sectorStrength);

    final peers = stock.peers
        .map(
          (peer) => PeerScore(
            ticker: peer.ticker,
            company: peer.company,
            relativeStrength: peer.relativeStrength,
            revisionTrend: peer.revisionTrend,
            crowdingScore: peer.crowdingScore,
          ),
        )
        .toList();

    final insight = StockInsight(
      ticker: stock.ticker,
      company: stock.company,
      sector: stock.sector,
      industry: stock.industry,
      action: action,
      opportunityScore: opportunityScore,
      regimeFit: scored.regimeFit,
      trendQuality: scored.trendQuality,
      revisionTrend: scored.revisionTrend,
      convictionScore: convictionScore,
      fragilityScore: fragilityScore,
      asymmetryScore: scored.asymmetryScore,
      riskScore: scored.riskScore,
      confidenceScore: confidenceBreakdown.composite,
      summary: _summaryFor(
        stock,
        regimeContext,
        opportunityScore,
        fragilityScore,
      ),
      whyItRanks: whyItRanks,
      whatCouldGoWrong: whatCouldGoWrong,
      invalidationSignals: invalidationSignals,
      recentChanges: recentChanges,
      stabilitySummary: _stabilitySummary(stock, regimeContext),
      optionsSignal: _buildOptionsSignal(stock),
      peers: peers,
      lastPrice: stock.lastPrice,
      forecasts: forecasts,
      confidenceBreakdown: confidenceBreakdown,
      counterfactuals: counterfactuals,
      peerContrast: peerContrast,
      decayedSignals: decayedSignals,
      macroGates: macroGates,
      correlationCluster: clusterInfo,
    );

    return DerivedStockSignal(
      raw: stock,
      insight: insight,
      opportunityScore: opportunityScore,
      fragilityScore: fragilityScore,
      deteriorationSignals: decayedSignals
          .map((signal) => signal.label)
          .toList(),
      decayedSignals: decayedSignals,
    );
  }

  OptionsSignal _buildOptionsSignal(RawStockSignal stock) {
    final flow = stock.unusualFlowRatio >= 1.6
        ? 'Unusual options activity: total flow is ${stock.unusualFlowRatio.toStringAsFixed(1)}x normal with put/call at ${stock.putCallRatio.toStringAsFixed(2)}.'
        : stock.dealerPositioning < -20
        ? 'Dealer positioning is short gamma, which tends to amplify moves in both directions.'
        : 'Flow is within normal bands; no clear smart-money fingerprint yet.';

    return OptionsSignal(
      ivRank: stock.impliedVolRank,
      realizedGap: stock.realizedImpliedGap,
      skewChange: stock.putSkewChange,
      eventPremium: stock.eventPremium / 10,
      commentary: _optionsCommentary(stock),
      termStructureSlope: stock.volTermStructureSlope,
      frontMonthSkew: stock.frontMonthSkew,
      backMonthSkew: stock.backMonthSkew,
      gammaExposure: stock.gammaExposure,
      pinningRisk: stock.pinningRisk,
      unusualFlowRatio: stock.unusualFlowRatio,
      putCallRatio: stock.putCallRatio,
      dealerPositioning: stock.dealerPositioning,
      flowCommentary: flow,
    );
  }

  double _optionsFlowStress(RawStockSignal stock) {
    final flowComponent =
        ((stock.unusualFlowRatio - 1.0).clamp(0, 2) / 2) * 100;
    final gammaComponent =
        (stock.dealerPositioning < 0 ? (-stock.dealerPositioning) * 0.6 : 0)
            .clamp(0, 60)
            .toDouble();
    final pinning = stock.pinningRisk * 0.4;
    return ((flowComponent + gammaComponent + pinning) / 2.0).clamp(0, 100);
  }

  ConfidenceBreakdown _confidenceBreakdown(
    _RawStockScore scored,
    _RegimeContext regimeContext,
    double effectiveClusterWeight,
    CorrelationCluster? cluster,
  ) {
    final components = <ConfidenceComponent>[
      ConfidenceComponent(
        label: 'Opportunity score',
        weight: 0.28,
        value: scored.opportunityScore,
        supporting: scored.opportunityScore >= 60,
        rationale:
            'Weighted composite of trend, revisions, regime fit, and quality minus fragility.',
      ),
      ConfidenceComponent(
        label: 'Regime confidence',
        weight: 0.20,
        value: regimeContext.confidence,
        supporting: regimeContext.confidence >= 62,
        rationale:
            'How decisively the regime classifier prefers the current regime vs. runner-up.',
      ),
      ConfidenceComponent(
        label: 'Quality durability',
        weight: 0.18,
        value: scored.qualityScore,
        supporting: scored.qualityScore >= 62,
        rationale:
            'Balance sheet, profitability, leverage, and earnings stability.',
      ),
      ConfidenceComponent(
        label: 'Fragility drag',
        weight: 0.16,
        value: 100 - scored.fragilityScore,
        supporting: scored.fragilityScore < 55,
        rationale:
            'High fragility erodes confidence even when the thesis reads well on paper.',
      ),
      ConfidenceComponent(
        label: 'Deterioration cluster',
        weight: 0.10,
        value: (100 - effectiveClusterWeight * 18).clamp(0, 100).toDouble(),
        supporting: effectiveClusterWeight < 2.0,
        rationale:
            'Time-decayed deterioration signals; fresh signals drag more than stale ones.',
      ),
      ConfidenceComponent(
        label: 'Correlation risk',
        weight: 0.08,
        value: (100 - (cluster?.correlationStrength ?? 0))
            .clamp(0, 100)
            .toDouble(),
        supporting: (cluster?.correlationStrength ?? 0) < 60,
        rationale: cluster == null
            ? 'No dominant correlation cluster detected.'
            : 'Named in cluster ${cluster.label} at correlation ${cluster.correlationStrength.round()}.',
      ),
    ];

    final composite = _clampScore(
      components.fold<double>(0, (acc, c) => acc + c.weight * c.value),
    );

    final supportingCount = components.where((c) => c.supporting).length;
    final opposingCount = components.length - supportingCount;
    final conflictScore =
        math.min(supportingCount, opposingCount) /
        (components.length / 2) *
        100;

    final tier = _confidenceTier(composite, conflictScore);
    final summary = _confidenceSummary(tier, components);

    return ConfidenceBreakdown(
      composite: composite,
      tier: tier,
      components: components,
      conflictScore: conflictScore,
      summary: summary,
    );
  }

  ConfidenceTier _confidenceTier(double composite, double conflictScore) {
    if (conflictScore >= 60) {
      return ConfidenceTier.conflicted;
    }
    if (composite >= 78) {
      return ConfidenceTier.high;
    }
    if (composite >= 60) {
      return ConfidenceTier.moderate;
    }
    return ConfidenceTier.low;
  }

  String _confidenceSummary(
    ConfidenceTier tier,
    List<ConfidenceComponent> components,
  ) {
    final strongest = components.reduce(
      (a, b) => a.weight * a.value > b.weight * b.value ? a : b,
    );
    final weakest = components.reduce(
      (a, b) => a.weight * (100 - a.value) > b.weight * (100 - b.value) ? a : b,
    );
    switch (tier) {
      case ConfidenceTier.high:
        return 'Confidence is high: ${strongest.label} is carrying the weight and no major component is dragging.';
      case ConfidenceTier.moderate:
        return 'Confidence is moderate: ${strongest.label} is supportive, but ${weakest.label} is the component to monitor.';
      case ConfidenceTier.low:
        return 'Confidence is low: ${weakest.label} is dragging enough to demand a higher bar before adding risk.';
      case ConfidenceTier.conflicted:
        return 'Confidence is conflicted: supporting and opposing components are balanced, so treat the score as uncertain until one side resolves.';
    }
  }

  ForecastPack _forecastPack(
    _RawStockScore scored,
    _RegimeContext regimeContext,
    RawMarketEnvironment environment,
  ) {
    final stock = scored.raw;

    // Probability of outperforming sector over 20d.
    final outperformInput =
        0.55 * _normalize(scored.opportunityScore) +
        0.25 * _normalize(scored.regimeFit) +
        0.20 * _normalize(100 - scored.fragilityScore);
    final outperformProb = _logisticProbability(
      outperformInput,
      scale: 3.5,
      center: 0.55,
    );

    // Probability of drawdown > 8% over 20d.
    final drawdownInput =
        0.50 * _normalize(scored.fragilityScore) +
        0.25 * _normalize(stock.putSkewChange) +
        0.15 * _normalize(environment.impliedVolatility) +
        0.10 * _normalize(stock.abnormalDownVolume);
    final drawdownProb = _logisticProbability(
      drawdownInput,
      scale: 3.2,
      center: 0.45,
    );

    // Probability of earnings gap > implied move.
    final earningsGapInput =
        0.45 * _normalize(stock.expectedMoveEarnings.clamp(0, 100)) +
        0.35 * _normalize(stock.eventPremium * 10) +
        0.20 * _normalize(stock.volatilityRepricing);
    final earningsGapProb = _logisticProbability(
      earningsGapInput,
      scale: 3.0,
      center: 0.50,
    );

    // Probability of leadership rotating away from this factor bucket over 20d.
    final rotationInput =
        0.45 * _normalize(100 - scored.styleAlignment) +
        0.35 * _normalize(100 - environment.growthLeadership) +
        0.20 * _normalize(environment.creditStress);
    final rotationProb = _logisticProbability(
      rotationInput,
      scale: 3.0,
      center: 0.55,
    );

    // Probability of current breakout persisting.
    final persistenceInput =
        0.55 * _normalize(scored.trendQuality) +
        0.25 * _normalize(stock.breakoutQuality) +
        0.20 * _normalize(100 - stock.crowdingRisk);
    final persistenceProb = _logisticProbability(
      persistenceInput,
      scale: 3.5,
      center: 0.55,
    );

    // 20-day forward-return distribution in %.
    final mean20 =
        (scored.opportunityScore - 50) * 0.12 + (scored.regimeFit - 50) * 0.06;
    final sigma20 =
        2.0 +
        (scored.fragilityScore / 25) +
        (environment.impliedVolatility / 30);
    final forwardReturn20d = _normalDistribution(mean20, sigma20);

    // 60-day forward-return distribution: wider, mean shifts more with trend.
    final mean60 = mean20 * 1.8 + (scored.trendQuality - 50) * 0.08;
    final sigma60 = sigma20 * 1.6;
    final forwardReturn60d = _normalDistribution(mean60, sigma60);

    return ForecastPack(
      outperformSectorProbability: outperformProb,
      drawdownOver8pctProbability: drawdownProb,
      earningsGapExceedsImpliedProbability: earningsGapProb,
      leadershipRotationProbability: rotationProb,
      breakoutPersistenceProbability: persistenceProb,
      forwardReturn20d: forwardReturn20d,
      forwardReturn60d: forwardReturn60d,
      horizonLabel: '20d and 60d',
    );
  }

  ProbabilityDistribution _normalDistribution(double mean, double stdDev) {
    // Clamp the distribution to something that renders well in the UI.
    final sigma = stdDev.clamp(1.5, 40.0).toDouble();
    return ProbabilityDistribution(
      mean: mean,
      stdDev: sigma,
      p10: mean - 1.28 * sigma,
      p25: mean - 0.67 * sigma,
      p50: mean,
      p75: mean + 0.67 * sigma,
      p90: mean + 1.28 * sigma,
    );
  }

  /// Quick logistic on an input range that is centered loosely around 0.5.
  double _logisticProbability(
    double input, {
    double scale = 3.0,
    double center = 0.5,
  }) {
    final x = (input - center) * scale;
    final p = 1 / (1 + math.exp(-x));
    return (p * 100).clamp(0.5, 99.5).toDouble();
  }

  double _normalize(double value) {
    return (value.clamp(0, 100)) / 100;
  }

  List<CounterfactualSensitivity> _counterfactuals(
    _RawStockScore scored,
    RawMarketState state,
    _RegimeContext regimeContext,
    Map<String, RawSectorSignal> sectorMap,
    Map<String, int> rankIndex,
    List<_RawStockScore> allStocks,
  ) {
    final currentRank = rankIndex[scored.raw.ticker] ?? 0;
    final baselineAction = _actionFor(
      scored.opportunityScore,
      scored.riskScore,
      0,
      const [],
    );

    final cases = <_CounterfactualCase>[
      _CounterfactualCase(
        component: 'Revision momentum',
        delta: -15,
        apply: (stock) => stock.copyWith(
          earningsRevisions: (stock.earningsRevisions - 15).clamp(0, 100),
          revisionDelta: (stock.revisionDelta - 15).clamp(0, 100),
        ),
      ),
      _CounterfactualCase(
        component: 'Revision momentum',
        delta: 15,
        apply: (stock) => stock.copyWith(
          earningsRevisions: (stock.earningsRevisions + 15).clamp(0, 100),
          revisionDelta: (stock.revisionDelta + 15).clamp(0, 100),
        ),
      ),
      _CounterfactualCase(
        component: 'Sector strength',
        delta: -15,
        apply: (stock) => stock,
        sectorShock: -15,
      ),
      _CounterfactualCase(
        component: 'Credit stress',
        delta: 15,
        apply: (stock) => stock,
        environmentShock: _EnvironmentShock(creditStress: 15),
      ),
      _CounterfactualCase(
        component: 'Implied volatility',
        delta: 15,
        apply: (stock) => stock,
        environmentShock: _EnvironmentShock(impliedVolatility: 15),
      ),
      _CounterfactualCase(
        component: 'Crowding',
        delta: 15,
        apply: (stock) => stock.copyWith(
          crowdingRisk: (stock.crowdingRisk + 15).clamp(0, 100),
        ),
      ),
    ];

    final results = <CounterfactualSensitivity>[];
    for (final counter in cases) {
      final shocked = _scoreStockRaw(
        counter.apply(scored.raw),
        _shockedState(state, counter),
        regimeContext,
        _shockedSectorMap(sectorMap, scored.raw.sector, counter),
      );
      final deltaOpportunity =
          shocked.opportunityScore - scored.opportunityScore;
      final newRank = _projectedRank(
        shocked.opportunityScore,
        allStocks,
        scored.raw.ticker,
      );
      final flip = _actionFor(
        shocked.opportunityScore,
        shocked.riskScore,
        0,
        const [],
      );
      results.add(
        CounterfactualSensitivity(
          component: counter.component,
          deltaInput: counter.delta.toDouble(),
          deltaOpportunity: deltaOpportunity,
          deltaRankSlots: newRank - currentRank,
          flipAction: flip == baselineAction ? null : flip,
          narrative: _counterfactualNarrative(
            counter.component,
            counter.delta,
            deltaOpportunity,
            newRank - currentRank,
          ),
        ),
      );
    }

    results.sort(
      (left, right) =>
          right.deltaOpportunity.abs().compareTo(left.deltaOpportunity.abs()),
    );

    return results.take(5).toList();
  }

  int _projectedRank(
    double newScore,
    List<_RawStockScore> allStocks,
    String ticker,
  ) {
    var rank = 0;
    for (final stock in allStocks) {
      if (stock.raw.ticker == ticker) {
        continue;
      }
      if (stock.opportunityScore > newScore) {
        rank += 1;
      }
    }
    return rank;
  }

  String _counterfactualNarrative(
    String component,
    double deltaInput,
    double deltaOpportunity,
    int deltaRank,
  ) {
    final direction = deltaInput >= 0 ? 'improving' : 'weakening';
    final scoreDirection = deltaOpportunity >= 0 ? '+' : '';
    final rankDescription = deltaRank == 0
        ? 'the rank would hold.'
        : deltaRank < 0
        ? 'it would climb ${deltaRank.abs()} spots.'
        : 'it would slip $deltaRank spots.';
    return 'If $component were $direction by ${deltaInput.abs().round()} pts, opportunity would shift $scoreDirection${deltaOpportunity.toStringAsFixed(1)} and $rankDescription';
  }

  RawMarketState _shockedState(
    RawMarketState state,
    _CounterfactualCase counter,
  ) {
    final shock = counter.environmentShock;
    if (shock == null) {
      return state;
    }
    return RawMarketState(
      asOf: state.asOf,
      environment: _shockedEnvironment(state.environment, shock),
      styles: state.styles,
      sectors: state.sectors,
      stocks: state.stocks,
    );
  }

  RawMarketEnvironment _shockedEnvironment(
    RawMarketEnvironment env,
    _EnvironmentShock shock,
  ) {
    return RawMarketEnvironment(
      indexTrend: (env.indexTrend + shock.indexTrend).clamp(0, 100).toDouble(),
      realizedVolatility: env.realizedVolatility,
      impliedVolatility: (env.impliedVolatility + shock.impliedVolatility)
          .clamp(0, 100)
          .toDouble(),
      creditStress: (env.creditStress + shock.creditStress)
          .clamp(0, 100)
          .toDouble(),
      financialConditions: (env.financialConditions + shock.financialConditions)
          .clamp(0, 100)
          .toDouble(),
      growthLeadership: (env.growthLeadership + shock.growthLeadership)
          .clamp(0, 100)
          .toDouble(),
      defensiveLeadership: env.defensiveLeadership,
      smallCapLeadership: env.smallCapLeadership,
      inflationPressure: env.inflationPressure,
      breadth: (env.breadth + shock.breadth).clamp(0, 100).toDouble(),
      advanceDecline: env.advanceDecline,
      newHighLow: env.newHighLow,
      percentAboveMajorAverages: env.percentAboveMajorAverages,
      equalWeightConfirmation: env.equalWeightConfirmation,
      sectorParticipation: env.sectorParticipation,
      correlation: env.correlation,
      dispersion: env.dispersion,
      volumeConcentration: env.volumeConcentration,
      regimeStability: env.regimeStability,
      regimePersistenceSessions: env.regimePersistenceSessions,
      volTermStructure: env.volTermStructure,
      yieldCurveSlope: env.yieldCurveSlope,
      breadthByPhase: env.breadthByPhase,
    );
  }

  Map<String, RawSectorSignal> _shockedSectorMap(
    Map<String, RawSectorSignal> sectorMap,
    String targetSector,
    _CounterfactualCase counter,
  ) {
    if (counter.sectorShock == 0) {
      return sectorMap;
    }
    final current = sectorMap[targetSector.toLowerCase()];
    if (current == null) {
      return sectorMap;
    }
    final shocked = RawSectorSignal(
      sector: current.sector,
      strength: (current.strength + counter.sectorShock)
          .clamp(0, 100)
          .toDouble(),
      breadth: (current.breadth + counter.sectorShock).clamp(0, 100).toDouble(),
      revisions: current.revisions,
      sponsorship: current.sponsorship,
      crowdingRisk: current.crowdingRisk,
      note: current.note,
    );
    return {...sectorMap, targetSector.toLowerCase(): shocked};
  }

  List<PeerContrast> _peerContrast(
    _RawStockScore scored,
    _SectorMedianSet medians,
  ) {
    final contrasts = <PeerContrast>[];
    final stock = scored.raw;
    final axes = <_ContrastAxis>[
      _ContrastAxis(
        label: 'Residual strength',
        self: stock.residualStrength,
        median: medians.residualStrength,
        rank: medians.rankOf(
          stock.residualStrength,
          _MedianAxis.residualStrength,
        ),
        total: medians.total,
      ),
      _ContrastAxis(
        label: 'Estimate revisions',
        self: stock.earningsRevisions,
        median: medians.earningsRevisions,
        rank: medians.rankOf(
          stock.earningsRevisions,
          _MedianAxis.earningsRevisions,
        ),
        total: medians.total,
      ),
      _ContrastAxis(
        label: 'Free cash flow trend',
        self: stock.freeCashFlowTrend,
        median: medians.freeCashFlow,
        rank: medians.rankOf(stock.freeCashFlowTrend, _MedianAxis.freeCashFlow),
        total: medians.total,
      ),
      _ContrastAxis(
        label: 'Crowding risk',
        self: stock.crowdingRisk,
        median: medians.crowdingRisk,
        rank: medians.rankOf(
          stock.crowdingRisk,
          _MedianAxis.crowding,
          inverse: true,
        ),
        total: medians.total,
      ),
    ];

    for (final axis in axes) {
      if (axis.total == 0) continue;
      final gap = axis.self - axis.median;
      final narrative = gap.abs() < 4
          ? 'Sits near the ${stock.sector.toLowerCase()} median on ${axis.label.toLowerCase()}, so the name is neither a standout nor a drag here.'
          : gap > 0
          ? 'Runs ${gap.toStringAsFixed(1)} points above the ${stock.sector.toLowerCase()} median on ${axis.label.toLowerCase()} — this is a real edge vs. peers.'
          : 'Trails the ${stock.sector.toLowerCase()} median by ${gap.abs().toStringAsFixed(1)} points on ${axis.label.toLowerCase()} — a relative weakness to watch.';
      contrasts.add(
        PeerContrast(
          axis: axis.label,
          selfValue: axis.self,
          peerMedian: axis.median,
          rankInPeerGroup: axis.rank,
          totalPeers: axis.total,
          narrative: narrative,
        ),
      );
    }

    return contrasts;
  }

  Map<String, _SectorMedianSet> _sectorMedians(List<_RawStockScore> stocks) {
    final grouped = <String, List<RawStockSignal>>{};
    for (final s in stocks) {
      grouped.putIfAbsent(s.raw.sector, () => <RawStockSignal>[]).add(s.raw);
    }
    return grouped.map((sector, entries) {
      return MapEntry(sector, _SectorMedianSet.fromStocks(entries));
    });
  }

  List<DecayedSignal> _decayedSignals(RawStockSignal stock, DateTime asOf) {
    final signals = <DecayedSignal>[];
    void emit(String key, String label, double severity) {
      final age = stock.signalFirstObservedDays[key] ?? 1;
      final weight = _timeDecay(age);
      signals.add(
        DecayedSignal(
          label: label,
          firstObserved: asOf.subtract(Duration(days: age)),
          ageInSessions: age,
          weight: weight,
          severity: severity,
        ),
      );
    }

    if (stock.relativeStrengthDelta < 44) {
      emit(
        'relative_strength',
        'Relative strength is rolling over against peers.',
        (44 - stock.relativeStrengthDelta),
      );
    }
    if (stock.sectorBreadthDelta < 45) {
      emit(
        'sector_breadth',
        'Sector breadth is deteriorating underneath the stock.',
        (45 - stock.sectorBreadthDelta),
      );
    }
    if (stock.revisionDelta < 43) {
      emit(
        'revisions',
        'Revision momentum has inflected lower.',
        (43 - stock.revisionDelta),
      );
    }
    if (stock.priceResponse < 42) {
      emit(
        'price_response',
        'Price is no longer rewarding good news cleanly.',
        (42 - stock.priceResponse),
      );
    }
    if (stock.abnormalDownVolume > 62) {
      emit(
        'abnormal_volume',
        'Down moves are arriving on abnormal volume.',
        (stock.abnormalDownVolume - 62),
      );
    }
    if (stock.volatilityRepricing > 60) {
      emit(
        'vol_repricing',
        'Options are repricing risk faster than price is repairing.',
        (stock.volatilityRepricing - 60),
      );
    }
    if (stock.peerLeadership < 45) {
      emit(
        'peer_leadership',
        'Leadership has been ceded to peers.',
        (45 - stock.peerLeadership),
      );
    }
    if (stock.dealerPositioning < -30) {
      emit(
        'dealer_short',
        'Dealers are net short gamma, which widens the tails on bad days.',
        (-stock.dealerPositioning - 30),
      );
    }
    return signals;
  }

  double _timeDecay(int days) {
    // Half-life of ~7 trading sessions.
    return math.exp(-days / 7.0);
  }

  double _effectiveWeight(List<DecayedSignal> decayed) {
    return decayed.fold<double>(0, (acc, s) => acc + s.weight);
  }

  List<MacroGate> _macroGates(
    RawStockSignal stock,
    RawMarketEnvironment environment,
    _RegimeContext regimeContext,
  ) {
    final gates = <MacroGate>[];

    gates.add(
      MacroGate(
        label: 'Regime stability gate',
        isSatisfied: environment.regimeStability >= 55,
        rationale: environment.regimeStability >= 55
            ? 'Regime is stable enough that rules-based sells are trustworthy.'
            : 'Regime is in flux — prefer staged de-risking over outright exits unless multiple gates fail.',
      ),
    );

    gates.add(
      MacroGate(
        label: 'Credit gate',
        isSatisfied:
            !(environment.creditStress >= 65 && stock.creditSensitivity >= 60),
        rationale:
            (environment.creditStress >= 65 && stock.creditSensitivity >= 60)
            ? 'Credit stress is biting a credit-sensitive name — treat de-risking as more urgent.'
            : 'Credit backdrop is not adding urgency for this name.',
      ),
    );

    gates.add(
      MacroGate(
        label: 'Volatility gate',
        isSatisfied: environment.impliedVolatility < 72,
        rationale: environment.impliedVolatility >= 72
            ? 'Aggregate vol is elevated — exits in fragile names run the risk of selling a tactical low.'
            : 'Volatility is not at an acute level that should veto a disciplined exit.',
      ),
    );

    return gates;
  }

  Map<String, CorrelationCluster> _buildCorrelationClusters(
    List<_RawStockScore> stocks,
  ) {
    final grouped = <String, List<_RawStockScore>>{};
    for (final s in stocks) {
      if (s.raw.correlationClusterId.isEmpty) continue;
      grouped.putIfAbsent(s.raw.correlationClusterId, () => []).add(s);
    }
    final clusters = <String, CorrelationCluster>{};
    grouped.forEach((id, members) {
      if (members.length < 2) return;
      final avgStrength =
          members
              .map((m) => m.raw.correlationStrength)
              .reduce((a, b) => a + b) /
          members.length;
      final tickers = members.map((m) => m.raw.ticker).toList()..sort();
      final label = _clusterLabel(id, members);
      final cluster = CorrelationCluster(
        clusterId: id,
        label: label,
        tickers: tickers,
        correlationStrength: avgStrength,
        narrative: avgStrength >= 65
            ? 'Highly correlated: stress in one tends to pull the rest lower within days.'
            : 'Moderately correlated: worth watching, but breakdowns do not chain perfectly.',
      );
      for (final m in members) {
        clusters[m.raw.ticker] = cluster;
      }
    });
    return clusters;
  }

  String _clusterLabel(String id, List<_RawStockScore> members) {
    final firstSector = members.first.raw.sector;
    final allSameSector = members.every((m) => m.raw.sector == firstSector);
    if (allSameSector) {
      return '${firstSector.toLowerCase()} cohort ($id)';
    }
    return 'cross-sector cohort ($id)';
  }

  SellAlert? _buildSellAlert(
    DerivedStockSignal stock,
    RawMarketState state,
    _RegimeContext regimeContext,
    Map<String, CorrelationCluster> clusters,
  ) {
    final decayed = stock.decayedSignals;
    final effectiveWeight = _effectiveWeight(decayed);
    final clusterCount = decayed.length;

    // Require a cluster of fresh-ish signals (effective weight ~>= 2.2
    // roughly = three fresh signals or five older ones).
    if (effectiveWeight < 2.2) {
      return null;
    }

    final macroGates = _macroGates(stock.raw, state.environment, regimeContext);
    final satisfiedGates = macroGates.where((g) => g.isSatisfied).length;
    final gateRatio = macroGates.isEmpty
        ? 1.0
        : satisfiedGates / macroGates.length;

    final severity = switch (effectiveWeight) {
      >= 4.5 => AlertSeverity.critical,
      >= 3.3 => AlertSeverity.high,
      >= 2.5 => AlertSeverity.moderate,
      _ => AlertSeverity.low,
    };

    RecommendationAction action = switch (effectiveWeight) {
      >= 4.5 => RecommendationAction.exit,
      >= 3.3 => RecommendationAction.deRisk,
      _ => RecommendationAction.trim,
    };

    // Macro gates can soften the action. Missing regime stability often
    // downgrades exit -> deRisk -> trim.
    if (gateRatio < 0.6 && action == RecommendationAction.exit) {
      action = RecommendationAction.deRisk;
    }
    if (gateRatio < 0.4 && action == RecommendationAction.deRisk) {
      action = RecommendationAction.trim;
    }

    final clusterInfo = clusters[stock.raw.ticker];
    final correlationPenalty = clusterInfo?.isConcentrated == true ? 12.0 : 0.0;

    final thesisDamageScore = _clampScore(
      0.52 * stock.fragilityScore +
          0.32 * (effectiveWeight * 12) +
          correlationPenalty,
    );

    final exitProbability = _logisticProbability(
      (effectiveWeight / 6).clamp(0, 1) * 0.6 +
          _normalize(stock.fragilityScore) * 0.4,
      scale: 4.2,
      center: 0.45,
    );

    final triggers = decayed
        .map(
          (s) =>
              '${s.label} (${s.ageInSessions}d, weight ${s.weight.toStringAsFixed(2)})',
        )
        .toList();

    return SellAlert(
      ticker: stock.raw.ticker,
      company: stock.raw.company,
      action: action,
      severity: severity,
      thesisDamageScore: thesisDamageScore,
      clusterCount: clusterCount,
      summary:
          _sellSummary(stock.raw, action) +
          (gateRatio < 1
              ? ' Note: ${macroGates.length - satisfiedGates} macro gate(s) are not satisfied, so the action has been softened.'
              : ''),
      triggers: triggers,
      nextCheck: _nextCheck(stock.raw),
      decayedTriggers: decayed,
      macroGates: macroGates,
      effectiveClusterWeight: effectiveWeight,
      correlationCluster: clusterInfo,
      exitProbability: exitProbability,
    );
  }

  MarketRadar _buildMarketRadar(
    RawMarketState state,
    _RegimeContext regimeContext,
  ) {
    final env = state.environment;
    final breadthHealth = _average([
      env.breadth,
      env.advanceDecline,
      env.newHighLow,
      env.percentAboveMajorAverages,
    ]);

    final leadershipQuality = _average([
      env.growthLeadership,
      env.dispersion,
      100 - env.correlation,
      env.sectorParticipation,
    ]);

    final crowdingRisk = _average([
      env.volumeConcentration,
      env.impliedVolatility,
      100 - env.equalWeightConfirmation,
    ]);

    final styleRotation =
        state.styles
            .map(
              (style) => StyleRotation(
                style: style.style,
                score: style.strength,
                note: style.note,
                tone: _toneFor(style.strength),
              ),
            )
            .toList()
          ..sort((left, right) => right.score.compareTo(left.score));

    final sectorRotation =
        state.sectors
            .map(
              (sector) => SectorRotation(
                sector: sector.sector,
                score: sector.strength,
                sponsorship: _sponsorshipLabel(sector.sponsorship),
                note: sector.note,
                tone: _toneFor(sector.strength),
              ),
            )
            .toList()
          ..sort((left, right) => right.score.compareTo(left.score));

    final sectorBreadth =
        state.sectors
            .map(
              (sector) => SectorBreadthRow(
                sector: sector.sector,
                participation: sector.breadth,
                leadership: sector.strength,
                divergence: sector.breadth - sector.strength,
                tone: _toneFor(sector.breadth),
              ),
            )
            .toList()
          ..sort(
            (left, right) => right.participation.compareTo(left.participation),
          );

    return MarketRadar(
      regime: regimeContext.regime,
      regimeConfidence: regimeContext.confidence,
      marketScore: regimeContext.marketScore,
      riskScore: regimeContext.riskScore,
      internalHealth: regimeContext.internalHealth,
      headline: _radarHeadline(regimeContext),
      summary: _radarSummary(regimeContext, env),
      breadthSummary: _breadthSummary(regimeContext, env),
      metrics: [
        RadarMetric(
          label: 'Index trend',
          numericValue: env.indexTrend,
          value: env.indexTrend.round().toString(),
          detail:
              'Major indexes remain supportive relative to their medium-term trend.',
          tone: _toneFor(env.indexTrend),
        ),
        RadarMetric(
          label: 'Realized volatility',
          numericValue: env.realizedVolatility,
          value: env.realizedVolatility.round().toString(),
          detail:
              'Higher values mean realized swings are large enough to demand humility.',
          tone: env.realizedVolatility > 58
              ? SignalTone.caution
              : SignalTone.positive,
        ),
        RadarMetric(
          label: 'Credit pulse',
          numericValue: 100 - env.creditStress,
          value: (100 - env.creditStress).round().toString(),
          detail:
              'Credit is still calm enough to avoid confirming broad stress.',
          tone: env.creditStress < 45
              ? SignalTone.positive
              : SignalTone.caution,
        ),
        RadarMetric(
          label: 'Breadth health',
          numericValue: breadthHealth,
          value: breadthHealth.round().toString(),
          detail:
              'Participation remains the key test for trusting the current tape.',
          tone: _toneFor(breadthHealth),
        ),
        RadarMetric(
          label: 'Leadership quality',
          numericValue: leadershipQuality,
          value: leadershipQuality.round().toString(),
          detail:
              'Leadership improves when dispersion and sector participation stay supportive.',
          tone: _toneFor(leadershipQuality),
        ),
        RadarMetric(
          label: 'Crowding risk',
          numericValue: crowdingRisk,
          value: crowdingRisk.round().toString(),
          detail:
              'High values mean consensus positioning is rich enough to matter.',
          tone: crowdingRisk > 60 ? SignalTone.caution : SignalTone.neutral,
        ),
      ],
      styleRotation: styleRotation,
      sectorRotation: sectorRotation,
      supportingSignals: _supportingSignals(env),
      warnings: _warningSignals(env),
      regimeDistribution: regimeContext.distribution,
      regimeTransition: regimeContext.transition,
      regimeStability: env.regimeStability,
      breadthDecomposition: sectorBreadth,
    );
  }

  List<ScenarioOutcome> _buildScenarios(
    List<DerivedStockSignal> stocks,
    _RegimeContext regimeContext,
    RawMarketState state,
  ) {
    return [
      _scenario(
        type: ScenarioType.creditWidening,
        title:
            'Credit stress would punish fragile cyclicality before it hurts quality franchises.',
        description:
            'If credit widens from here, the tape likely shifts from constructive risk-taking toward a lower-conviction regime where balance sheets and defensive growth matter more.',
        regimeImpact:
            'Lower market conviction, raise sell sensitivity, and reward quality over leverage-sensitive upside.',
        favored: const [
          'Quality software with strong cash generation',
          'Defensive growth',
          'Cash-rich mega-cap platforms',
        ],
        vulnerable: const [
          'Crowded growth leaders',
          'Leverage-sensitive cyclicals',
          'Small-cap beta',
        ],
        stocks: stocks,
        deltaBuilder: (stock) =>
            0.28 * stock.raw.defensiveExposure +
            0.24 * stock.raw.balanceSheetQuality -
            0.25 * stock.raw.creditSensitivity -
            0.16 * stock.raw.crowdingRisk -
            0.12 * stock.raw.growthExposure,
        probability: _scenarioProbability(
          state.environment.creditStress / 100,
          0.35,
        ),
      ),
      _scenario(
        type: ScenarioType.volatilityShock,
        title:
            'A volatility shock would test whether leadership is real or just crowded.',
        description:
            'When volatility reprices quickly, the most crowded leaders usually get marked first while higher-stability franchises recover faster.',
        regimeImpact:
            'Widen risk controls, reward stability, and reduce tolerance for crowded breakouts.',
        favored: const [
          'Stable quality software',
          'Healthcare compounders',
          'Lower-fragility balance-sheet leaders',
        ],
        vulnerable: const [
          'Crowded semiconductors',
          'Thin momentum breakouts',
          'Names with steepening downside skew',
        ],
        stocks: stocks,
        deltaBuilder: (stock) =>
            0.25 * stock.raw.expectedStability +
            0.18 * stock.raw.defensiveExposure -
            0.22 * stock.raw.crowdingRisk -
            0.18 * stock.raw.impliedVolRank -
            0.17 * stock.raw.putSkewChange,
        probability: _scenarioProbability(
          state.environment.impliedVolatility / 100,
          0.32,
        ),
      ),
      _scenario(
        type: ScenarioType.growthLeadershipBreak,
        title:
            'If growth leadership breaks, the board should rotate toward durability and breadth.',
        description:
            'A real break in growth leadership usually pushes the board toward defensive growth, financials, and names that do not depend on a single factor bucket staying hot.',
        regimeImpact:
            'Lower trend persistence assumptions and upgrade stocks whose thesis can survive factor rotation.',
        favored: const [
          'Defensive growth',
          'Select financials',
          'Broadening industrial leaders',
        ],
        vulnerable: const [
          'Semiconductors',
          'High-multiple momentum software',
          'Re-rating stories that need abundant risk appetite',
        ],
        stocks: stocks,
        deltaBuilder: (stock) =>
            0.24 * stock.raw.defensiveExposure +
            0.20 * (100 - stock.raw.growthExposure) +
            0.18 * stock.raw.expectedStability -
            0.22 * stock.raw.growthExposure -
            0.16 * stock.raw.crowdingRisk,
        probability: _scenarioProbability(
          (100 - state.environment.growthLeadership) / 100,
          0.28,
        ),
      ),
      _scenario(
        type: ScenarioType.ratesFallingQuickly,
        title:
            'Falling rates help or hurt depending on whether the move is benign or fearful.',
        description:
            'A fast rates decline can support duration if credit stays calm, or reward defensives first if the move signals growth fear.',
        regimeImpact:
            'Keep the response conditional: upgrade duration only when credit and breadth remain supportive.',
        favored: const [
          'Quality duration if credit is calm',
          'Defensive growth if the move reflects fear',
          'Selected internet platforms with improving revisions',
        ],
        vulnerable: const [
          'Banks if growth concern drives the move',
          'Late-cycle cyclicals',
          'Names dependent on strong nominal growth',
        ],
        stocks: stocks,
        deltaBuilder: (stock) =>
            0.22 * stock.raw.rateSensitivity +
            0.18 * stock.raw.balanceSheetQuality +
            0.12 * stock.raw.growthExposure -
            0.20 * stock.raw.creditSensitivity +
            0.16 * regimeContext.riskScore / 2,
        probability: _scenarioProbability(
          (100 - state.environment.yieldCurveSlope.clamp(-10, 10) * 5 - 50)
                  .abs() /
              100,
          0.24,
        ),
      ),
    ];
  }

  double _scenarioProbability(double input, double base) {
    final normalized = input.clamp(0, 1).toDouble();
    return (base * 100 + normalized * 35).clamp(2, 95).toDouble();
  }

  ScenarioOutcome _scenario({
    required ScenarioType type,
    required String title,
    required String description,
    required String regimeImpact,
    required List<String> favored,
    required List<String> vulnerable,
    required List<DerivedStockSignal> stocks,
    required double Function(DerivedStockSignal stock) deltaBuilder,
    required double probability,
  }) {
    final ranked =
        stocks
            .map(
              (stock) => _ScenarioImpact(
                stock: stock,
                delta: _scenarioDelta(deltaBuilder(stock)),
              ),
            )
            .toList()
          ..sort(
            (left, right) => right.delta.abs().compareTo(left.delta.abs()),
          );

    ScenarioStockImpact build(_ScenarioImpact impact) {
      final action = _scenarioActionFor(impact.delta.toDouble());
      return ScenarioStockImpact(
        ticker: impact.stock.raw.ticker,
        action: action,
        deltaOpportunity: impact.delta.toDouble(),
        rationale: _scenarioRationale(type, impact.stock.raw, impact.delta),
      );
    }

    final topImpacts = ranked.take(4).map(build).toList();
    final fullBoardImpacts = ranked.map(build).toList();

    return ScenarioOutcome(
      type: type,
      title: title,
      description: description,
      regimeImpact: regimeImpact,
      favoredExposures: favored,
      vulnerableExposures: vulnerable,
      stockImpacts: topImpacts,
      fullBoardImpacts: fullBoardImpacts,
      probability: probability,
    );
  }

  String _scenarioActionFor(double delta) {
    if (delta >= 6) return 'Up-rank';
    if (delta >= 2) return 'Hold firmer';
    if (delta <= -6) return 'Cut risk';
    if (delta <= -2) return 'De-risk';
    return 'Hold neutral';
  }

  List<String> _favoredExposuresFromImpacts(
    List<ScenarioStockImpact> impacts,
    bool favored,
  ) {
    final relevant = impacts
        .where(
          (impact) => favored
              ? impact.deltaOpportunity > 0
              : impact.deltaOpportunity < 0,
        )
        .take(3)
        .map((impact) => impact.ticker)
        .toList();
    return relevant;
  }

  RawMarketState _applyScenarioShock(
    RawMarketState state,
    CustomScenarioDefinition scenario,
  ) {
    final env = state.environment;
    final shocked = RawMarketEnvironment(
      indexTrend: env.indexTrend,
      realizedVolatility:
          (env.realizedVolatility + scenario.impliedVolDelta * 0.8)
              .clamp(0, 100)
              .toDouble(),
      impliedVolatility: (env.impliedVolatility + scenario.impliedVolDelta)
          .clamp(0, 100)
          .toDouble(),
      creditStress: (env.creditStress + scenario.creditStressDelta)
          .clamp(0, 100)
          .toDouble(),
      financialConditions:
          (env.financialConditions - scenario.creditStressDelta * 0.6)
              .clamp(0, 100)
              .toDouble(),
      growthLeadership: (env.growthLeadership + scenario.growthLeadershipDelta)
          .clamp(0, 100)
          .toDouble(),
      defensiveLeadership:
          (env.defensiveLeadership - scenario.growthLeadershipDelta * 0.5)
              .clamp(0, 100)
              .toDouble(),
      smallCapLeadership: env.smallCapLeadership,
      inflationPressure: env.inflationPressure,
      breadth: (env.breadth + scenario.breadthDelta).clamp(0, 100).toDouble(),
      advanceDecline: (env.advanceDecline + scenario.breadthDelta)
          .clamp(0, 100)
          .toDouble(),
      newHighLow: env.newHighLow,
      percentAboveMajorAverages:
          (env.percentAboveMajorAverages + scenario.breadthDelta * 0.5)
              .clamp(0, 100)
              .toDouble(),
      equalWeightConfirmation: env.equalWeightConfirmation,
      sectorParticipation: env.sectorParticipation,
      correlation: env.correlation,
      dispersion: env.dispersion,
      volumeConcentration: env.volumeConcentration,
      regimeStability: env.regimeStability,
      regimePersistenceSessions: env.regimePersistenceSessions,
      volTermStructure: env.volTermStructure,
      yieldCurveSlope: (env.yieldCurveSlope + scenario.rateShockDelta / 10),
      breadthByPhase: env.breadthByPhase,
    );
    return RawMarketState(
      asOf: state.asOf,
      environment: shocked,
      styles: state.styles,
      sectors: state.sectors,
      stocks: state.stocks,
    );
  }

  _RegimeContext _analyzeRegime(RawMarketState state) {
    final env = state.environment;
    final riskOn = _average([
      env.indexTrend,
      env.breadth,
      env.sectorParticipation,
      env.growthLeadership,
      env.financialConditions,
      100 - env.creditStress,
      100 - env.impliedVolatility,
    ]);
    final neutral = _average([
      100 - (env.indexTrend - 50).abs() * 1.4,
      100 - (env.breadth - 50).abs() * 1.2,
      100 - (env.impliedVolatility - 50).abs() * 1.1,
    ]);
    final riskOff = _average([
      env.defensiveLeadership,
      env.creditStress,
      env.impliedVolatility,
      100 - env.indexTrend,
      100 - env.breadth,
    ]);
    final inflationStress = _average([
      env.inflationPressure,
      env.creditStress,
      100 - env.financialConditions,
      100 - env.smallCapLeadership,
    ]);
    final growthScare = _average([
      env.creditStress,
      env.defensiveLeadership,
      100 - env.growthLeadership,
      100 - env.smallCapLeadership,
    ]);
    final creditDeterioration = _average([
      env.creditStress,
      100 - env.financialConditions,
      env.impliedVolatility,
      100 - env.equalWeightConfirmation,
    ]);
    final euphoricMeltUp = _average([
      env.indexTrend,
      env.growthLeadership,
      env.volumeConcentration,
      100 - env.correlation,
    ]);
    final washoutRecovery = _average([
      100 - env.indexTrend,
      100 - env.breadth,
      100 - env.newHighLow,
      100 - env.percentAboveMajorAverages,
    ]);

    final scores = <MarketRegimeType, double>{
      MarketRegimeType.riskOn: riskOn,
      MarketRegimeType.neutral: neutral,
      MarketRegimeType.riskOff: riskOff,
      MarketRegimeType.inflationStress: inflationStress,
      MarketRegimeType.growthScare: growthScare,
      MarketRegimeType.creditDeterioration: creditDeterioration,
      MarketRegimeType.euphoricMeltUp: euphoricMeltUp,
      MarketRegimeType.washoutRecovery: washoutRecovery,
    };

    // Convert raw regime scores to a probability distribution via softmax.
    final distribution = _softmaxDistribution(scores);
    final rankedScores = scores.entries.toList()
      ..sort((left, right) => right.value.compareTo(left.value));

    final top = rankedScores.first;
    final runnerUp = rankedScores[1];
    final confidence = _clampScore(58 + (top.value - runnerUp.value) * 1.9);
    final marketScore = _clampScore(
      riskOn * 0.72 + neutral * 0.18 - riskOff * 0.1,
    );
    final riskScore = _clampScore(
      0.34 * env.impliedVolatility +
          0.24 * env.creditStress +
          0.22 * env.volumeConcentration +
          0.20 * (100 - env.equalWeightConfirmation),
    );

    final internalHealth = switch ((
      env.breadth,
      env.sectorParticipation,
      env.equalWeightConfirmation,
      env.volumeConcentration,
    )) {
      (>= 70, >= 70, >= 55, < 70) => InternalHealthType.healthyBroadRally,
      (>= 58, _, < 52, >= 62) => InternalHealthType.narrowLeadership,
      (< 45, _, _, _) when env.indexTrend > 58 =>
        InternalHealthType.hiddenBreakdown,
      (< 48, < 48, _, _) => InternalHealthType.weakeningInternals,
      _ => InternalHealthType.washedOutReversalPotential,
    };

    final transition = _regimeTransition(top.key, distribution, env);

    return _RegimeContext(
      regime: top.key,
      confidence: confidence,
      marketScore: marketScore,
      riskScore: riskScore,
      internalHealth: internalHealth,
      distribution: distribution,
      transition: transition,
    );
  }

  List<RegimeProbability> _softmaxDistribution(
    Map<MarketRegimeType, double> scores,
  ) {
    const temperature = 10.0;
    final maxScore = scores.values.reduce(math.max);
    final expScores = scores.map(
      (regime, score) =>
          MapEntry(regime, math.exp((score - maxScore) / temperature)),
    );
    final total = expScores.values.reduce((a, b) => a + b);
    final probs = expScores.map(
      (regime, value) => MapEntry(regime, (value / total) * 100),
    );
    final list =
        probs.entries
            .map(
              (entry) => RegimeProbability(
                regime: entry.key,
                probability: entry.value,
              ),
            )
            .toList()
          ..sort(
            (left, right) => right.probability.compareTo(left.probability),
          );
    return list;
  }

  RegimeTransition? _regimeTransition(
    MarketRegimeType currentRegime,
    List<RegimeProbability> distribution,
    RawMarketEnvironment env,
  ) {
    if (distribution.length < 2) return null;
    final runnerUp = distribution[1];
    if (runnerUp.probability < 12) return null;

    final triggers = <String>[];
    // Pick triggers that point toward the runner-up regime.
    switch (runnerUp.regime) {
      case MarketRegimeType.riskOff:
      case MarketRegimeType.growthScare:
        if (env.creditStress >= 45) {
          triggers.add('Credit stress rising toward the danger zone.');
        }
        if (env.breadth < 55) {
          triggers.add('Breadth has already thinned below trend.');
        }
        if (env.impliedVolatility > 55) {
          triggers.add('Vol is elevated enough to front-run de-risking.');
        }
        break;
      case MarketRegimeType.creditDeterioration:
        triggers.add('Credit spreads leading the market lower.');
        if (env.financialConditions < 50) {
          triggers.add('Financial conditions tightening underneath.');
        }
        break;
      case MarketRegimeType.euphoricMeltUp:
        if (env.volumeConcentration > 60) {
          triggers.add('Concentration in leadership names rising sharply.');
        }
        if (env.correlation < 45) {
          triggers.add('Dispersion expanding as beta chases winners.');
        }
        break;
      case MarketRegimeType.inflationStress:
        if (env.inflationPressure > 55) {
          triggers.add('Inflation-sensitive signals re-accelerating.');
        }
        break;
      case MarketRegimeType.washoutRecovery:
        if (env.newHighLow < 45) {
          triggers.add('New-low expansion consistent with a washout.');
        }
        break;
      case MarketRegimeType.riskOn:
      case MarketRegimeType.neutral:
        if (env.creditStress < 40) {
          triggers.add('Credit staying calm supports a re-risking shift.');
        }
        if (env.breadth > 60) {
          triggers.add('Breadth repair consistent with a re-risking move.');
        }
        break;
    }

    if (triggers.isEmpty) {
      triggers.add(
        'Distribution is close enough that a shift cannot be ruled out.',
      );
    }

    final rationale = runnerUp.probability >= 25
        ? 'Runner-up regime (${runnerUp.regime.label}) holds a meaningful ${runnerUp.probability.toStringAsFixed(0)}% probability — watch for confirming signals.'
        : 'Runner-up regime (${runnerUp.regime.label}) is a modest ${runnerUp.probability.toStringAsFixed(0)}% probability, but worth monitoring.';

    return RegimeTransition(
      fromRegime: currentRegime,
      toRegime: runnerUp.regime,
      probability: runnerUp.probability,
      triggers: triggers,
      rationale: rationale,
    );
  }

  RecommendationAction _actionFor(
    double opportunityScore,
    double riskScore,
    double effectiveWeight,
    List<MacroGate> gates,
  ) {
    if (effectiveWeight >= 4.5) {
      return RecommendationAction.exit;
    }
    if (effectiveWeight >= 3.3) {
      return RecommendationAction.deRisk;
    }
    if (opportunityScore >= 88 && riskScore <= 68) {
      return RecommendationAction.buy;
    }
    if (opportunityScore >= 78 && riskScore <= 58) {
      return RecommendationAction.accumulate;
    }
    if (opportunityScore >= 68 && riskScore <= 52) {
      return RecommendationAction.hold;
    }
    if (opportunityScore >= 58) {
      return RecommendationAction.watch;
    }
    return RecommendationAction.avoidForNow;
  }

  String _summaryFor(
    RawStockSignal stock,
    _RegimeContext regimeContext,
    double opportunityScore,
    double fragilityScore,
  ) {
    final regimePhrase = switch (regimeContext.regime) {
      MarketRegimeType.riskOn => 'The current tape still rewards risk-taking.',
      MarketRegimeType.neutral =>
        'The tape is mixed enough that selectivity matters more than beta.',
      MarketRegimeType.riskOff =>
        'The market backdrop is defensive and demands quality first.',
      MarketRegimeType.inflationStress =>
        'Inflation-sensitive stress is distorting the opportunity set.',
      MarketRegimeType.growthScare =>
        'Growth fear is compressing tolerance for fragile upside.',
      MarketRegimeType.creditDeterioration =>
        'Credit deterioration makes balance-sheet quality more important.',
      MarketRegimeType.euphoricMeltUp =>
        'The market is rewarding leadership, but crowding is a real tax.',
      MarketRegimeType.washoutRecovery =>
        'Recovery conditions exist, but they still require proof underneath.',
    };

    final fragilityPhrase = fragilityScore >= 62
        ? 'The main risk is crowding and fast thesis damage.'
        : 'The fragility profile is manageable relative to the opportunity.';

    final upsidePhrase = opportunityScore >= 85
        ? 'This still screens like a top-decile conditional opportunity.'
        : 'The setup is constructive, though not without trade-offs.';

    return '$regimePhrase $upsidePhrase $fragilityPhrase';
  }

  String _optionsCommentary(RawStockSignal stock) {
    if (stock.putSkewChange >= 64 && stock.priceResponse < 50) {
      return 'Downside protection demand has risen while price response cooled, which often appears ahead of a failed breakout.';
    }
    if (stock.volTermStructureSlope < -3) {
      return 'Term structure is backwardated — the market is paying up for near-term protection. Expect a fast resolution in either direction.';
    }
    if (stock.impliedVolRank <= 52 && stock.putSkewChange <= 52) {
      return 'The options surface is comparatively calm, which lowers the odds that price is hiding acute stress.';
    }
    return 'Options are active but not yet fully alarmed. The tape remains tradable, but the risk premium is no longer cheap.';
  }

  String _stabilitySummary(RawStockSignal stock, _RegimeContext regimeContext) {
    if (stock.expectedStability >= 78 && stock.balanceSheetQuality >= 78) {
      return 'This signal stack is one of the steadier fits for the current regime because balance-sheet quality and earnings durability help it survive a bumpier tape.';
    }
    if (stock.crowdingRisk >= 70) {
      return 'The setup can work, but historical reliability fades when crowding and options hedging both accelerate from here.';
    }
    return 'The setup has worked best when regime conditions stay close to the current backdrop, but it is less forgiving if leadership rotates sharply.';
  }

  List<String> _recentChanges(RawStockSignal stock, double sectorStrength) {
    final items = <_NarrativeScore>[
      _NarrativeScore(
        score: stock.revisionDelta,
        text: 'Revision momentum improved over the latest update cycle.',
      ),
      _NarrativeScore(
        score: stock.sectorBreadthDelta,
        text: 'Peer-group breadth improved over the last several sessions.',
      ),
      _NarrativeScore(
        score: stock.relativeStrengthDelta,
        text: 'Residual relative strength improved versus peers.',
      ),
      _NarrativeScore(
        score: stock.putSkewChange,
        text: 'Downside skew steepened into the latest catalyst window.',
      ),
      _NarrativeScore(
        score: sectorStrength,
        text: 'Sector sponsorship remains supportive underneath the name.',
      ),
    ];
    return _topNarratives(items, count: 3);
  }

  String _sellSummary(RawStockSignal stock, RecommendationAction action) {
    return switch (action) {
      RecommendationAction.trim =>
        'The story is still partly intact, but upside looks more compressed as deterioration begins to cluster.',
      RecommendationAction.deRisk =>
        'Evidence has weakened enough to reduce size. The thesis is no longer getting clean confirmation from price, peers, and options at the same time.',
      RecommendationAction.exit =>
        'The thesis now looks broken for this regime. Too many pieces of evidence are leaning the wrong way at once.',
      _ => 'The setup needs a fresh read.',
    };
  }

  String _nextCheck(RawStockSignal stock) {
    if (stock.priceResponse < 42) {
      return 'Watch whether the stock can respond to the next supportive catalyst instead of fading it.';
    }
    if (stock.sectorBreadthDelta < 45) {
      return 'Monitor whether peer-group breadth repairs before rebuilding conviction.';
    }
    return 'Re-check whether relative strength and options behavior begin to repair together.';
  }

  double _styleAlignment(RawStockSignal stock, _RegimeContext regimeContext) {
    return switch (regimeContext.regime) {
      MarketRegimeType.riskOn => _average([
        stock.growthExposure,
        100 - stock.defensiveExposure,
      ]),
      MarketRegimeType.euphoricMeltUp => _average([
        stock.growthExposure,
        100 - stock.creditSensitivity,
      ]),
      MarketRegimeType.riskOff => _average([
        stock.defensiveExposure,
        stock.expectedStability,
      ]),
      MarketRegimeType.growthScare => _average([
        stock.defensiveExposure,
        stock.balanceSheetQuality,
      ]),
      MarketRegimeType.creditDeterioration => _average([
        stock.balanceSheetQuality,
        100 - stock.creditSensitivity,
      ]),
      MarketRegimeType.inflationStress => _average([
        100 - stock.rateSensitivity,
        stock.expectedStability,
      ]),
      MarketRegimeType.washoutRecovery => _average([
        stock.growthExposure,
        stock.valuationSupport,
      ]),
      MarketRegimeType.neutral => _average([
        stock.expectedStability,
        stock.valuationSupport,
      ]),
    };
  }

  double _macroAlignment(
    RawStockSignal stock,
    RawMarketEnvironment environment,
    _RegimeContext regimeContext,
  ) {
    final creditPenalty =
        environment.creditStress * stock.creditSensitivity / 100;
    final rateTailwind =
        environment.financialConditions * stock.rateSensitivity / 100;
    final volDrag = environment.impliedVolatility * stock.crowdingRisk / 400;
    final breadthBonus = (environment.breadth - 50) / 4;
    final base = switch (regimeContext.regime) {
      MarketRegimeType.riskOn =>
        stock.growthExposure + rateTailwind - creditPenalty + breadthBonus,
      MarketRegimeType.riskOff =>
        stock.defensiveExposure +
            stock.balanceSheetQuality -
            creditPenalty -
            volDrag,
      MarketRegimeType.creditDeterioration =>
        stock.balanceSheetQuality +
            stock.expectedStability -
            creditPenalty -
            volDrag,
      MarketRegimeType.growthScare =>
        stock.defensiveExposure +
            stock.expectedStability -
            stock.growthExposure * 0.2 -
            creditPenalty * 0.5,
      MarketRegimeType.inflationStress =>
        100 -
            stock.rateSensitivity +
            stock.expectedStability -
            creditPenalty * 0.3,
      MarketRegimeType.euphoricMeltUp =>
        stock.growthExposure +
            stock.residualStrength -
            stock.crowdingRisk * 0.2 -
            creditPenalty * 0.5 -
            volDrag,
      MarketRegimeType.washoutRecovery =>
        stock.valuationSupport + stock.growthExposure + breadthBonus,
      MarketRegimeType.neutral =>
        stock.expectedStability +
            stock.valuationSupport +
            breadthBonus -
            creditPenalty * 0.3,
    };
    return _clampScore(base / 2);
  }

  List<String> _supportingSignals(RawMarketEnvironment env) {
    final signals = <String>[
      if (env.breadth >= 70)
        'Breadth remains strong enough to confirm the current move underneath the headline index.',
      if (env.creditStress <= 40)
        'Credit and financial conditions are not yet confirming a broader risk break.',
      if (env.growthLeadership >= 72)
        'Growth leadership remains supportive across the strongest factor buckets.',
      if (env.sectorParticipation >= 68)
        'Sector participation is still broad enough to trust the current leadership cohort.',
    ];
    return signals.take(3).toList();
  }

  List<String> _warningSignals(RawMarketEnvironment env) {
    final warnings = <String>[
      if (env.volumeConcentration >= 65)
        'Leadership is becoming more concentrated, which raises crowding and reversal risk.',
      if (env.equalWeightConfirmation <= 58)
        'Equal-weight confirmation is lagging the cap-weighted tape.',
      if (env.impliedVolatility >= 58)
        'Volatility expectations are rich enough that the next miss could travel further than usual.',
      if (env.smallCapLeadership <= 48)
        'Small-cap participation is still too soft for a fully healthy risk-on read.',
    ];
    return warnings.take(3).toList();
  }

  String _radarHeadline(_RegimeContext regimeContext) {
    return switch (regimeContext.regime) {
      MarketRegimeType.riskOn =>
        'The tape is still constructive, but crowding is no longer a footnote.',
      MarketRegimeType.neutral =>
        'The market is balanced enough that selectivity matters more than blanket risk-taking.',
      MarketRegimeType.riskOff =>
        'The tape is defensive and increasingly intolerant of fragile upside.',
      MarketRegimeType.inflationStress =>
        'Inflation-sensitive stress is distorting leadership and compressing clean setups.',
      MarketRegimeType.growthScare =>
        'Growth fear is creeping in, even if the headline tape has not fully rolled over.',
      MarketRegimeType.creditDeterioration =>
        'Credit deterioration is forcing the market to care more about fragility.',
      MarketRegimeType.euphoricMeltUp =>
        'Leadership remains powerful, but the tape is flirting with excess.',
      MarketRegimeType.washoutRecovery =>
        'Recovery conditions exist, but the market still needs confirmation underneath.',
    };
  }

  String _radarSummary(_RegimeContext regimeContext, RawMarketEnvironment env) {
    final breadth = env.breadth >= 70
        ? 'broad enough to trust'
        : 'not broad enough to trust blindly';
    final credit = env.creditStress <= 40
        ? 'credit remains calm enough to support risk'
        : 'credit is no longer giving the all-clear';
    return 'Breadth is $breadth, $credit, and volatility is ${env.impliedVolatility >= 58 ? 'elevated enough to matter' : 'still reasonably contained'}.';
  }

  String _breadthSummary(
    _RegimeContext regimeContext,
    RawMarketEnvironment env,
  ) {
    return 'Breadth, equal-weight confirmation, and sector participation are driving confidence. The current internal health reads ${regimeContext.internalHealth.label.toLowerCase()}.';
  }

  String _sponsorshipLabel(double score) {
    if (score >= 85) {
      return 'Top decile';
    }
    if (score >= 72) {
      return 'Strong inflows';
    }
    if (score >= 58) {
      return 'Balanced';
    }
    return 'Weak';
  }

  SignalTone _toneFor(double value) {
    if (value >= 72) {
      return SignalTone.positive;
    }
    if (value >= 56) {
      return SignalTone.neutral;
    }
    if (value >= 44) {
      return SignalTone.caution;
    }
    return SignalTone.negative;
  }

  List<String> _topNarratives(
    List<_NarrativeScore> items, {
    bool descending = true,
    int count = 4,
  }) {
    final ordered = List<_NarrativeScore>.from(items)
      ..sort(
        (left, right) => descending
            ? right.score.compareTo(left.score)
            : left.score.compareTo(right.score),
      );
    return ordered.take(count).map((item) => item.text).toList();
  }

  String _scenarioRationale(
    ScenarioType type,
    RawStockSignal stock,
    int delta,
  ) {
    if (delta >= 0) {
      return switch (type) {
        ScenarioType.creditWidening =>
          'Balance-sheet quality and defensive resilience improve this name relative to the field.',
        ScenarioType.volatilityShock =>
          'Stability and lower fragility make this one more likely to hold up in a volatility reset.',
        ScenarioType.growthLeadershipBreak =>
          'The thesis is less dependent on one hot factor bucket staying in control.',
        ScenarioType.ratesFallingQuickly =>
          'The name benefits from better duration support and cleaner balance-sheet quality.',
        ScenarioType.custom =>
          'Custom shocks tilt the risk/reward positively for this name.',
      };
    }
    return switch (type) {
      ScenarioType.creditWidening =>
        'Credit sensitivity and crowding would leave this one less forgiving.',
      ScenarioType.volatilityShock =>
        'Rich positioning and options stress would make the setup less forgiving.',
      ScenarioType.growthLeadershipBreak =>
        'This thesis depends more on continued growth leadership than the scenario allows.',
      ScenarioType.ratesFallingQuickly =>
        'The setup leans too much on nominal growth staying firm.',
      ScenarioType.custom =>
        'Custom shocks tilt the risk/reward negatively for this name.',
    };
  }

  int _scenarioDelta(double rawDelta) {
    return ((rawDelta - 50) / 4).round().clamp(-18, 18);
  }

  double _average(List<double> values) {
    if (values.isEmpty) {
      return 0;
    }
    return values.reduce((left, right) => left + right) / values.length;
  }

  double _clampScore(double value) {
    return math.max(0, math.min(100, value));
  }
}

class _RegimeContext {
  const _RegimeContext({
    required this.regime,
    required this.confidence,
    required this.marketScore,
    required this.riskScore,
    required this.internalHealth,
    required this.distribution,
    this.transition,
  });

  final MarketRegimeType regime;
  final double confidence;
  final double marketScore;
  final double riskScore;
  final InternalHealthType internalHealth;
  final List<RegimeProbability> distribution;
  final RegimeTransition? transition;
}

class _NarrativeScore {
  const _NarrativeScore({required this.score, required this.text});

  final double score;
  final String text;
}

class _ScenarioImpact {
  const _ScenarioImpact({required this.stock, required this.delta});

  final DerivedStockSignal stock;
  final int delta;
}

class _RawStockScore {
  const _RawStockScore({
    required this.raw,
    required this.sector,
    required this.trendQuality,
    required this.revisionTrend,
    required this.qualityScore,
    required this.fragilityScore,
    required this.sectorStrength,
    required this.styleAlignment,
    required this.macroAlignment,
    required this.regimeFit,
    required this.asymmetryScore,
    required this.opportunityScore,
    required this.convictionScore,
    required this.riskScore,
  });

  final RawStockSignal raw;
  final RawSectorSignal? sector;
  final double trendQuality;
  final double revisionTrend;
  final double qualityScore;
  final double fragilityScore;
  final double sectorStrength;
  final double styleAlignment;
  final double macroAlignment;
  final double regimeFit;
  final double asymmetryScore;
  final double opportunityScore;
  final double convictionScore;
  final double riskScore;
}

class _CounterfactualCase {
  const _CounterfactualCase({
    required this.component,
    required this.delta,
    required this.apply,
    this.sectorShock = 0,
    this.environmentShock,
  });

  final String component;
  final double delta;
  final RawStockSignal Function(RawStockSignal) apply;
  final double sectorShock;
  final _EnvironmentShock? environmentShock;
}

class _EnvironmentShock {
  const _EnvironmentShock({this.impliedVolatility = 0, this.creditStress = 0});

  final double impliedVolatility;
  final double creditStress;

  double get indexTrend => 0;
  double get financialConditions => 0;
  double get growthLeadership => 0;
  double get breadth => 0;
}

enum _MedianAxis { residualStrength, earningsRevisions, freeCashFlow, crowding }

class _SectorMedianSet {
  const _SectorMedianSet({
    required this.residualStrength,
    required this.earningsRevisions,
    required this.freeCashFlow,
    required this.crowdingRisk,
    required this.total,
    required this.residualStrengthSorted,
    required this.earningsRevisionsSorted,
    required this.freeCashFlowSorted,
    required this.crowdingSorted,
  });

  factory _SectorMedianSet.empty() => const _SectorMedianSet(
    residualStrength: 50,
    earningsRevisions: 50,
    freeCashFlow: 50,
    crowdingRisk: 50,
    total: 0,
    residualStrengthSorted: <double>[],
    earningsRevisionsSorted: <double>[],
    freeCashFlowSorted: <double>[],
    crowdingSorted: <double>[],
  );

  factory _SectorMedianSet.fromStocks(List<RawStockSignal> stocks) {
    final rsSorted = stocks.map((s) => s.residualStrength).toList()..sort();
    final erSorted = stocks.map((s) => s.earningsRevisions).toList()..sort();
    final fcSorted = stocks.map((s) => s.freeCashFlowTrend).toList()..sort();
    final crSorted = stocks.map((s) => s.crowdingRisk).toList()..sort();
    double median(List<double> xs) {
      if (xs.isEmpty) return 50;
      final mid = xs.length ~/ 2;
      if (xs.length.isOdd) return xs[mid];
      return (xs[mid - 1] + xs[mid]) / 2;
    }

    return _SectorMedianSet(
      residualStrength: median(rsSorted),
      earningsRevisions: median(erSorted),
      freeCashFlow: median(fcSorted),
      crowdingRisk: median(crSorted),
      total: stocks.length,
      residualStrengthSorted: rsSorted,
      earningsRevisionsSorted: erSorted,
      freeCashFlowSorted: fcSorted,
      crowdingSorted: crSorted,
    );
  }

  final double residualStrength;
  final double earningsRevisions;
  final double freeCashFlow;
  final double crowdingRisk;
  final int total;
  final List<double> residualStrengthSorted;
  final List<double> earningsRevisionsSorted;
  final List<double> freeCashFlowSorted;
  final List<double> crowdingSorted;

  int rankOf(double value, _MedianAxis axis, {bool inverse = false}) {
    final list = switch (axis) {
      _MedianAxis.residualStrength => residualStrengthSorted,
      _MedianAxis.earningsRevisions => earningsRevisionsSorted,
      _MedianAxis.freeCashFlow => freeCashFlowSorted,
      _MedianAxis.crowding => crowdingSorted,
    };
    if (list.isEmpty) return 0;
    int rank = list.length - list.where((v) => v >= value).length + 1;
    if (inverse) {
      rank = list.length - rank + 1;
    }
    return rank.clamp(1, list.length);
  }
}

class _ContrastAxis {
  const _ContrastAxis({
    required this.label,
    required this.self,
    required this.median,
    required this.rank,
    required this.total,
  });

  final String label;
  final double self;
  final double median;
  final int rank;
  final int total;
}
