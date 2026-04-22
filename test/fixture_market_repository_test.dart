import 'package:flutter_test/flutter_test.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  test('fixture repository builds a rules-engine app state', () async {
    final state = await FixtureMarketRepository().loadState();

    expect(state.snapshot.opportunities, isNotEmpty);
    expect(state.snapshot.sellAlerts, isNotEmpty);
    expect(state.dataStatus.feeds.length, greaterThanOrEqualTo(4));
    expect(state.engineStatus.isTrained, isFalse);
    expect(
      state.engineStatus.validationStage,
      ValidationStage.fixtureWalkForward,
    );
    expect(state.engineStatus.validationReport.windowCount, greaterThan(0));
    expect(
      state.engineStatus.validationReport.observationCount,
      greaterThan(0),
    );
  });
}
