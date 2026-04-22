import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('fixture repository builds a rules-engine app state', () async {
    final state = await FixtureMarketRepository().loadState();

    expect(state.snapshot.opportunities, isNotEmpty);
    expect(state.snapshot.sellAlerts, isNotEmpty);
    expect(state.dataStatus.feeds.length, greaterThanOrEqualTo(4));
    expect(state.dataStatus.archiveSnapshotCount, greaterThan(0));
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
    expect(
      state.engineStatus.validationReport.trainSplit.windowCount,
      greaterThan(0),
    );
    expect(
      state.engineStatus.validationReport.testSplit.windowCount,
      greaterThan(0),
    );
    expect(
      state.engineStatus.validationReport.windows.length,
      state.engineStatus.validationReport.windowCount,
    );
  });
}
