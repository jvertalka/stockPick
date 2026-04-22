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
  });

  final RawStockSignal raw;
  final StockInsight insight;
  final double opportunityScore;
  final double fragilityScore;
  final List<String> deteriorationSignals;
}

class MarketIntelligenceEngine {
  MarketEvaluation evaluate(RawMarketState state) {
    final regimeContext = _analyzeRegime(state);
    final sectorMap = {
      for (final sector in state.sectors) sector.sector.toLowerCase(): sector,
    };

    final scoredStocks =
        state.stocks
            .map((stock) => _scoreStock(stock, state, regimeContext, sectorMap))
            .toList()
          ..sort(
            (left, right) => right.insight.opportunityScore.compareTo(
              left.insight.opportunityScore,
            ),
          );

    final sellAlerts =
        scoredStocks.map(_buildSellAlert).whereType<SellAlert>().toList()..sort(
          (left, right) =>
              right.thesisDamageScore.compareTo(left.thesisDamageScore),
        );

    final opportunities = scoredStocks
        .take(6)
        .map((item) => item.insight)
        .toList();

    final snapshot = MarketIntelligenceSnapshot(
      asOf: state.asOf,
      marketRadar: _buildMarketRadar(state, regimeContext),
      opportunities: opportunities,
      sellAlerts: sellAlerts,
      scenarios: _buildScenarios(scoredStocks, regimeContext),
    );

    return MarketEvaluation(snapshot: snapshot, scoredStocks: scoredStocks);
  }

  DerivedStockSignal _scoreStock(
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

    final confidenceScore = _clampScore(
      0.38 * convictionScore +
          0.26 * regimeContext.confidence +
          0.20 * stock.expectedStability +
          0.16 * (100 - fragilityScore),
    );

    final deteriorationSignals = _deteriorationSignals(stock);
    final action = _actionFor(
      opportunityScore,
      riskScore,
      deteriorationSignals.length,
    );

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
        score: sectorStrength,
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
      ],
      descending: true,
      count: 3,
    );

    final invalidationSignals = [
      'Relative strength loses leadership versus ${stock.industry.toLowerCase()} peers.',
      'Sector breadth weakens while downside hedging continues to expand.',
      'Price stops rewarding good news for more than one update cycle.',
    ];

    final recentChanges = _recentChanges(stock, sectorStrength);

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
      regimeFit: regimeFit,
      trendQuality: trendQuality,
      revisionTrend: revisionTrend,
      convictionScore: convictionScore,
      fragilityScore: fragilityScore,
      asymmetryScore: asymmetryScore,
      riskScore: riskScore,
      confidenceScore: confidenceScore,
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
      optionsSignal: OptionsSignal(
        ivRank: stock.impliedVolRank,
        realizedGap: stock.realizedImpliedGap,
        skewChange: stock.putSkewChange,
        eventPremium: stock.eventPremium / 10,
        commentary: _optionsCommentary(stock),
      ),
      peers: peers,
    );

    return DerivedStockSignal(
      raw: stock,
      insight: insight,
      opportunityScore: opportunityScore,
      fragilityScore: fragilityScore,
      deteriorationSignals: deteriorationSignals,
    );
  }

  SellAlert? _buildSellAlert(DerivedStockSignal stock) {
    final clusterCount = stock.deteriorationSignals.length;
    if (clusterCount < 3) {
      return null;
    }

    final severity = switch (clusterCount) {
      >= 5 => AlertSeverity.critical,
      4 => AlertSeverity.high,
      3 => AlertSeverity.moderate,
      _ => AlertSeverity.low,
    };

    final action = switch (clusterCount) {
      >= 5 => RecommendationAction.exit,
      4 => RecommendationAction.deRisk,
      _ => RecommendationAction.trim,
    };

    final thesisDamageScore = _clampScore(
      0.58 * stock.fragilityScore + 0.42 * (clusterCount * 18),
    );

    return SellAlert(
      ticker: stock.raw.ticker,
      company: stock.raw.company,
      action: action,
      severity: severity,
      thesisDamageScore: thesisDamageScore,
      clusterCount: clusterCount,
      summary: _sellSummary(stock.raw, action),
      triggers: stock.deteriorationSignals,
      nextCheck: _nextCheck(stock.raw),
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
          value: env.indexTrend.round().toString(),
          detail:
              'Major indexes remain supportive relative to their medium-term trend.',
          tone: _toneFor(env.indexTrend),
        ),
        RadarMetric(
          label: 'Realized volatility',
          value: env.realizedVolatility.round().toString(),
          detail:
              'Higher values mean realized swings are large enough to demand humility.',
          tone: env.realizedVolatility > 58
              ? SignalTone.caution
              : SignalTone.positive,
        ),
        RadarMetric(
          label: 'Credit pulse',
          value: (100 - env.creditStress).round().toString(),
          detail:
              'Credit is still calm enough to avoid confirming broad stress.',
          tone: env.creditStress < 45
              ? SignalTone.positive
              : SignalTone.caution,
        ),
        RadarMetric(
          label: 'Breadth health',
          value: breadthHealth.round().toString(),
          detail:
              'Participation remains the key test for trusting the current tape.',
          tone: _toneFor(breadthHealth),
        ),
        RadarMetric(
          label: 'Leadership quality',
          value: leadershipQuality.round().toString(),
          detail:
              'Leadership improves when dispersion and sector participation stay supportive.',
          tone: _toneFor(leadershipQuality),
        ),
        RadarMetric(
          label: 'Crowding risk',
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
    );
  }

  List<ScenarioOutcome> _buildScenarios(
    List<DerivedStockSignal> stocks,
    _RegimeContext regimeContext,
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
      ),
    ];
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

    final topImpacts = ranked.take(4).map((impact) {
      final action = switch (impact.delta) {
        >= 6 => 'Up-rank',
        >= 2 => 'Hold firmer',
        <= -6 => 'Cut risk',
        <= -2 => 'De-risk',
        _ => 'Hold neutral',
      };
      return ScenarioStockImpact(
        ticker: impact.stock.raw.ticker,
        action: action,
        deltaOpportunity: impact.delta.toDouble(),
        rationale: _scenarioRationale(type, impact.stock.raw, impact.delta),
      );
    }).toList();

    return ScenarioOutcome(
      type: type,
      title: title,
      description: description,
      regimeImpact: regimeImpact,
      favoredExposures: favored,
      vulnerableExposures: vulnerable,
      stockImpacts: topImpacts,
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

    return _RegimeContext(
      regime: top.key,
      confidence: confidence,
      marketScore: marketScore,
      riskScore: riskScore,
      internalHealth: internalHealth,
    );
  }

  List<String> _deteriorationSignals(RawStockSignal stock) {
    final signals = <String>[];
    if (stock.relativeStrengthDelta < 44) {
      signals.add('Relative strength is rolling over against peers.');
    }
    if (stock.sectorBreadthDelta < 45) {
      signals.add('Sector breadth is deteriorating underneath the stock.');
    }
    if (stock.revisionDelta < 43) {
      signals.add('Revision momentum has inflected lower.');
    }
    if (stock.priceResponse < 42) {
      signals.add('Price is no longer rewarding good news cleanly.');
    }
    if (stock.abnormalDownVolume > 62) {
      signals.add('Down moves are arriving on abnormal volume.');
    }
    if (stock.volatilityRepricing > 60) {
      signals.add('Options are repricing risk faster than price is repairing.');
    }
    if (stock.peerLeadership < 45) {
      signals.add('Leadership has been ceded to peers.');
    }
    return signals;
  }

  RecommendationAction _actionFor(
    double opportunityScore,
    double riskScore,
    int deteriorationClusters,
  ) {
    if (deteriorationClusters >= 5) {
      return RecommendationAction.exit;
    }
    if (deteriorationClusters == 4) {
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
    final base = switch (regimeContext.regime) {
      MarketRegimeType.riskOn =>
        stock.growthExposure + rateTailwind - creditPenalty,
      MarketRegimeType.riskOff =>
        stock.defensiveExposure + stock.balanceSheetQuality - creditPenalty,
      MarketRegimeType.creditDeterioration =>
        stock.balanceSheetQuality + stock.expectedStability - creditPenalty,
      MarketRegimeType.growthScare =>
        stock.defensiveExposure +
            stock.expectedStability -
            stock.growthExposure * 0.2,
      MarketRegimeType.inflationStress =>
        100 - stock.rateSensitivity + stock.expectedStability,
      MarketRegimeType.euphoricMeltUp =>
        stock.growthExposure +
            stock.residualStrength -
            stock.crowdingRisk * 0.2,
      MarketRegimeType.washoutRecovery =>
        stock.valuationSupport + stock.growthExposure,
      MarketRegimeType.neutral =>
        stock.expectedStability + stock.valuationSupport,
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
  });

  final MarketRegimeType regime;
  final double confidence;
  final double marketScore;
  final double riskScore;
  final InternalHealthType internalHealth;
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
