import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/engine/daily_decision_brief_engine.dart';
import 'package:finance_app/src/engine/portfolio_decision_engine.dart';
import 'package:finance_app/src/models/market_intelligence.dart';
import 'package:finance_app/src/models/portfolio_models.dart';
import 'package:finance_app/src/models/recommendation_ledger_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'summarizes buy, hold, sell, and changed-signal work for the day',
    () async {
      final state = await FixtureMarketRepository().loadState();
      final portfolio = PortfolioState(
        cashBalance: 25000,
        holdings: [
          PortfolioHolding(
            ticker: 'NVDA',
            shares: 2,
            averageCostBasis: 820.10,
            currentValue: 1850,
            addedAt: DateTime(2026, 4, 23),
          ),
        ],
      );
      final report = const PortfolioDecisionEngine().build(
        snapshot: state.snapshot,
        portfolio: portfolio,
      );
      final target = state.snapshot.rankedUniverse.first;
      final priorAction = target.action == RecommendationAction.watch
          ? RecommendationAction.buy
          : RecommendationAction.watch;
      final priorStock = target.copyWith(
        action: priorAction,
        opportunityScore: target.opportunityScore - 12,
        confidenceScore: target.confidenceScore - 8,
      );
      final priorSnapshot = state.snapshot.copyWith(
        asOf: state.snapshot.asOf.subtract(const Duration(days: 2)),
        rankedUniverse: [priorStock],
      );
      final ledger = RecommendationLedger.empty.upsertSnapshot(priorSnapshot);

      final brief = const DailyDecisionBriefEngine().build(
        snapshot: state.snapshot,
        report: report,
        ledger: ledger,
      );

      expect(brief.headline, isNotEmpty);
      expect(brief.priorityActions, isNotEmpty);
      expect(brief.buyIdeas, isNotEmpty);
      expect(brief.agenda, isNotEmpty);
      expect(brief.buyCount, brief.buyIdeas.length);
      expect(brief.holdCount, brief.holdFocus.length);
      expect(brief.riskControlCount, brief.trimCount + brief.sellCount);
      expect(
        brief.changes.any((change) => change.stock.ticker == target.ticker),
        isTrue,
      );
    },
  );
}
