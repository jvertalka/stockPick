import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/data/raw_data_enrichment.dart';
import 'package:finance_app/src/engine/market_intelligence_engine.dart';
import 'package:finance_app/src/engine/recommendation_trust_gate.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';
import 'package:finance_app/src/models/market_intelligence.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('oracle engine', () {
    test('produces probabilistic forecasts per stock', () async {
      final state = await FixtureMarketRepository().loadState();
      final sample = state.snapshot.rankedUniverse.first;

      expect(sample.forecasts.isEmpty, isFalse);
      expect(
        sample.forecasts.outperformSectorProbability,
        inInclusiveRange(0.5, 99.5),
      );
      expect(
        sample.forecasts.drawdownOver8pctProbability,
        inInclusiveRange(0.5, 99.5),
      );
      expect(
        sample.forecasts.earningsGapExceedsImpliedProbability,
        inInclusiveRange(0.5, 99.5),
      );
      expect(
        sample.forecasts.leadershipRotationProbability,
        inInclusiveRange(0.5, 99.5),
      );
      expect(
        sample.forecasts.breakoutPersistenceProbability,
        inInclusiveRange(0.5, 99.5),
      );

      final forward20 = sample.forecasts.forwardReturn20d;
      expect(forward20.p10, lessThanOrEqualTo(forward20.p50));
      expect(forward20.p50, lessThanOrEqualTo(forward20.p90));
      expect(forward20.p25, lessThanOrEqualTo(forward20.p50));
      expect(forward20.p50, lessThanOrEqualTo(forward20.p75));
      expect(forward20.stdDev, greaterThan(0));

      final forward60 = sample.forecasts.forwardReturn60d;
      expect(forward60.spread, greaterThan(forward20.spread));
    });

    test('multi-component confidence exposes tier + conflicts', () async {
      final state = await FixtureMarketRepository().loadState();
      for (final stock in state.snapshot.rankedUniverse.take(10)) {
        expect(stock.confidenceBreakdown.components, isNotEmpty);
        expect(stock.confidenceBreakdown.composite, inInclusiveRange(0, 100));
        expect(
          stock.confidenceBreakdown.conflictScore,
          inInclusiveRange(0, 100),
        );
        expect(stock.confidenceBreakdown.summary, isNotEmpty);
      }
    });

    test('counterfactual sensitivity returns non-empty deltas', () async {
      final state = await FixtureMarketRepository().loadState();
      final sample = state.snapshot.rankedUniverse.first;
      expect(sample.counterfactuals, isNotEmpty);
      // Sorted by absolute impact descending.
      for (var i = 0; i + 1 < sample.counterfactuals.length; i++) {
        expect(
          sample.counterfactuals[i].deltaOpportunity.abs(),
          greaterThanOrEqualTo(
            sample.counterfactuals[i + 1].deltaOpportunity.abs(),
          ),
        );
      }
    });

    test('peer contrast ranks against sector peers', () async {
      final state = await FixtureMarketRepository().loadState();
      for (final stock in state.snapshot.rankedUniverse.take(5)) {
        for (final contrast in stock.peerContrast) {
          expect(contrast.rankInPeerGroup, greaterThanOrEqualTo(1));
          expect(
            contrast.rankInPeerGroup,
            lessThanOrEqualTo(contrast.totalPeers),
          );
        }
      }
    });

    test(
      'options signal exposes term structure, gamma, flow, pinning',
      () async {
        final state = await FixtureMarketRepository().loadState();
        final sample = state.snapshot.rankedUniverse.first;
        final signal = sample.optionsSignal;
        expect(signal.termStructureSlope, isNot(0));
        expect(signal.frontMonthSkew, greaterThan(0));
        expect(signal.backMonthSkew, greaterThan(0));
        expect(signal.unusualFlowRatio, greaterThan(0.3));
        expect(signal.flowCommentary, isNotEmpty);
      },
    );

    test('market radar includes regime distribution + transition', () async {
      final state = await FixtureMarketRepository().loadState();
      final radar = state.snapshot.marketRadar;
      expect(radar.regimeDistribution, isNotEmpty);
      final totalProb = radar.regimeDistribution
          .map((p) => p.probability)
          .reduce((a, b) => a + b);
      expect(totalProb, closeTo(100, 1.0));
      // Every probability is within [0, 100].
      for (final prob in radar.regimeDistribution) {
        expect(prob.probability, inInclusiveRange(0, 100));
      }
      expect(radar.regimeStability, greaterThan(0));
      expect(radar.breadthDecomposition, isNotEmpty);
    });

    test('sell alerts carry decayed triggers and macro gates', () async {
      final state = await FixtureMarketRepository().loadState();
      expect(state.snapshot.sellAlerts, isNotEmpty);
      for (final alert in state.snapshot.sellAlerts) {
        expect(alert.decayedTriggers, isNotEmpty);
        expect(alert.macroGates, isNotEmpty);
        expect(alert.effectiveClusterWeight, greaterThan(0));
        expect(alert.exitProbability, inInclusiveRange(0, 100));
        // Fresh signals should weight higher than stale ones.
        for (final signal in alert.decayedTriggers) {
          expect(signal.weight, inInclusiveRange(0, 1.1));
        }
      }
    });

    test('scenarios provide full-board re-rank + probability', () async {
      final state = await FixtureMarketRepository().loadState();
      expect(state.snapshot.scenarios, isNotEmpty);
      for (final scenario in state.snapshot.scenarios) {
        expect(
          scenario.fullBoardImpacts.length,
          greaterThanOrEqualTo(scenario.stockImpacts.length),
        );
        expect(scenario.probability, inInclusiveRange(0, 100));
      }
    });

    test('custom scenario re-ranks universe via engine', () {
      final engine = MarketIntelligenceEngine();
      final repository = FixtureMarketRepository();
      final raw = const RawDataEnrichment().enrichState(
        repository.currentMarketState(),
      );

      final snapshot = engine.evaluateCustomScenario(
        raw,
        const CustomScenarioDefinition(
          label: 'Credit rupture',
          description: 'Severe credit stress + vol spike + leadership break.',
          creditStressDelta: 60,
          impliedVolDelta: 40,
          breadthDelta: -30,
          growthLeadershipDelta: -40,
        ),
      );

      expect(snapshot.customScenarios, hasLength(1));
      final customOutcome = snapshot.customScenarios.first;
      expect(customOutcome.type, ScenarioType.custom);
      expect(
        customOutcome.fullBoardImpacts.length,
        snapshot.rankedUniverse.length,
      );
      // Average absolute delta across the board should be meaningful for a big
      // shock — confirms the shock is actually changing scores.
      final avgAbsDelta =
          customOutcome.fullBoardImpacts
              .map((impact) => impact.deltaOpportunity.abs())
              .reduce((a, b) => a + b) /
          customOutcome.fullBoardImpacts.length;
      expect(avgAbsDelta, greaterThan(0.1));
    });

    test('correlation clusters group stocks that move together', () async {
      final state = await FixtureMarketRepository().loadState();
      final clustered = state.snapshot.rankedUniverse
          .where((stock) => stock.correlationCluster != null)
          .toList();
      expect(clustered, isNotEmpty);
      final aCluster = clustered.first.correlationCluster!;
      expect(aCluster.tickers.length, greaterThanOrEqualTo(2));
      expect(aCluster.correlationStrength, inInclusiveRange(0, 100));
      expect(aCluster.label, isNotEmpty);
    });

    test('decayed signals have valid timestamps and weights', () async {
      final state = await FixtureMarketRepository().loadState();
      for (final stock in state.snapshot.rankedUniverse.take(10)) {
        for (final signal in stock.decayedSignals) {
          expect(signal.ageInSessions, greaterThan(0));
          expect(signal.weight, inInclusiveRange(0, 1.1));
          expect(signal.severity, greaterThan(0));
          expect(
            signal.firstObserved.isBefore(
              DateTime.now().add(const Duration(days: 365)),
            ),
            isTrue,
          );
        }
      }
    });

    test(
      'trust gate downgrades strong actions when critical feeds are fallback',
      () async {
        final state = await FixtureMarketRepository().loadState();
        final gated = const RecommendationTrustGate().apply(
          snapshot: state.snapshot,
          feeds: const [
            DataFeedStatus(
              name: 'Stock, revisions, and options signals',
              availability: FeedAvailability.fixture,
              refreshCadence: FeedRefreshCadence.daily,
              detail: 'Fixture stock feed.',
            ),
            DataFeedStatus(
              name: 'Market and breadth',
              availability: FeedAvailability.fixture,
              refreshCadence: FeedRefreshCadence.intraday,
              detail: 'Fixture macro feed.',
            ),
            DataFeedStatus(
              name: 'Research labels and windows',
              availability: FeedAvailability.fixture,
              refreshCadence: FeedRefreshCadence.onDemand,
              detail: 'Fixture outcomes.',
            ),
          ],
        );

        expect(gated.rankedUniverse.first.decisionTrust.isActionable, isFalse);
        expect(
          gated.rankedUniverse.first.forecasts.outperformSectorProbability,
          lessThanOrEqualTo(58),
        );
        expect(
          gated.rankedUniverse.any(
            (stock) => stock.action == RecommendationAction.buy,
          ),
          isFalse,
        );
      },
    );
  });
}
