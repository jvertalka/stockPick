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

    expect(state.snapshot.opportunities, isNotEmpty);
    expect(state.dataStatus.title, 'Provider-backed research repository');
    expect(
      state.dataStatus.feeds.any((feed) => feed.name == 'Live vendor adapters'),
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
  });
}
