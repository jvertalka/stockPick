import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/models/app_settings_models.dart';
import 'package:finance_app/src/models/recommendation_ledger_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('app settings normalize and persist custom universe tickers', () {
    final settings = AppSettings.empty
        .addTicker(' nvda ')
        .addTicker('brk.b')
        .addTicker('NVDA');
    expect(settings.customUniverseTickers, ['BRK.B', 'NVDA']);

    final restored = AppSettings.fromJson(settings.toJson());
    expect(restored.customUniverseTickers, ['BRK.B', 'NVDA']);
    expect(restored.removeTicker('nvda').customUniverseTickers, ['BRK.B']);
  });

  test(
    'recommendation ledger records snapshots and pending outcomes',
    () async {
      final state = await FixtureMarketRepository().loadState();
      final ledger = RecommendationLedger.empty.upsertSnapshot(state.snapshot);

      expect(ledger.records, isNotEmpty);
      final first = ledger.records.first;
      expect(first.ticker, isNotEmpty);
      expect(first.outcome5d, isNull);

      final restored = RecommendationLedger.fromJson(ledger.toJson());
      expect(restored.records.length, ledger.records.length);
    },
  );
}
