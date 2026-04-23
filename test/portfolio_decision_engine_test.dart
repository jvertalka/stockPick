import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/engine/portfolio_decision_engine.dart';
import 'package:finance_app/src/models/portfolio_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('builds buy candidates and owned-position decisions', () async {
    final state = await FixtureMarketRepository().loadState();
    final portfolio = PortfolioState(
      holdings: [
        PortfolioHolding(
          ticker: 'NVDA',
          shares: 2,
          averageCostBasis: 820.10,
          addedAt: DateTime(2026, 4, 23),
        ),
      ],
    );

    final report = const PortfolioDecisionEngine().build(
      snapshot: state.snapshot,
      portfolio: portfolio,
    );
    final ownedDecisions = [
      ...report.holdDecisions,
      ...report.watchDecisions.where((decision) => decision.isOwned),
      ...report.trimDecisions,
      ...report.sellDecisions,
    ];

    expect(report.buyCandidates, isNotEmpty);
    expect(report.ownedDecisionCount, 1);
    expect(ownedDecisions.single.stock.ticker, 'NVDA');
    expect(report.summary, contains('imported holdings matched'));
  });
}
