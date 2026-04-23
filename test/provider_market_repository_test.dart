import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/provider_market_repository.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('provider-backed repository loads through fixture adapters', () async {
    final state = await ProviderMarketRepository.fixtureBacked().loadState();

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
    expect(
      state.snapshot.marketRadar.metrics.every(
        (metric) => metric.trend != null,
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
    expect(state.dataStatus.title, 'Provider-backed research repository');
    expect(
      state.dataStatus.feeds.any((feed) => feed.name == 'Live vendor adapters'),
      isTrue,
    );
    expect(
      state.dataStatus.feeds.any(
        (feed) => feed.name == 'Historical market states',
      ),
      isTrue,
    );
    expect(state.engineStatus.isTrained, isFalse);
    expect(
      state.engineStatus.validationStage,
      ValidationStage.fixtureWalkForward,
    );
    expect(
      state.engineStatus.validationReport.trainSplit.windowCount,
      greaterThan(0),
    );
    expect(state.engineStatus.validationReport.calibrationBands, isNotEmpty);
    expect(state.engineStatus.validationReport.integrity.checks, isNotEmpty);
    expect(state.engineStatus.validationReport.modelReadiness.isReady, isFalse);
    expect(
      state.engineStatus.validationReport.modelReadiness.gates,
      hasLength(5),
    );
  });
}
