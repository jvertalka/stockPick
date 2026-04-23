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

    expect(state.snapshot.rankedUniverse, hasLength(40));
    expect(state.snapshot.opportunities, isNotEmpty);
    expect(state.snapshot.opportunities, hasLength(6));
    expect(
      state.snapshot.opportunities.every(
        (stock) => state.snapshot.rankedUniverse.any(
          (candidate) => candidate.ticker == stock.ticker,
        ),
      ),
      isTrue,
    );
    expect(state.snapshot.sellAlerts, isNotEmpty);
    expect(
      state.snapshot.marketRadar.metrics.every(
        (metric) => metric.trend != null,
      ),
      isTrue,
    );
    expect(
      state.snapshot.marketRadar.metrics.every(
        (metric) => metric.trend!.points.isNotEmpty,
      ),
      isTrue,
    );
    expect(
      state.snapshot.marketRadar.metrics.every(
        (metric) => metric.trend!.points.length >= 60,
      ),
      isTrue,
    );
    expect(
      state.snapshot.marketRadar.metrics.every(
        (metric) => metric.trend!.lookbackCount == 60,
      ),
      isTrue,
    );
    expect(
      state.snapshot.rankedUniverse.every(
        (stock) =>
            stock.opportunityTrend != null &&
            stock.fragilityTrend != null &&
            stock.regimeFitTrend != null &&
            stock.convictionTrend != null,
      ),
      isTrue,
    );
    expect(
      state.snapshot.scenarios.every(
        (scenario) => scenario.sensitivityTrend != null,
      ),
      isTrue,
    );
    expect(state.dataStatus.feeds.length, greaterThanOrEqualTo(4));
    expect(
      state.dataStatus.feeds.any((feed) => feed.name == 'Historical market states'),
      isTrue,
    );
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
    expect(state.engineStatus.validationReport.calibrationBands, isNotEmpty);
    expect(state.engineStatus.validationReport.integrity.checks, isNotEmpty);
  });
}
