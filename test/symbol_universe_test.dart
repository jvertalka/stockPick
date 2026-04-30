import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/default_symbol_universe.dart';
import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/data/market_data_configuration.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('default universe tracks a broad stock and ETF catalog', () {
    final symbols = kDefaultSymbolUniverse.toSet();
    final etfCount = symbols
        .where((symbol) => defaultSymbolProfileFor(symbol)?.isEtf ?? false)
        .length;
    final stockCount = symbols.length - etfCount;

    expect(symbols.length, greaterThanOrEqualTo(1300));
    expect(stockCount, greaterThanOrEqualTo(1000));
    expect(etfCount, greaterThanOrEqualTo(250));
    expect(symbols.containsAll(['AAPL', 'NVDA', 'JPM', 'LLY']), isTrue);
    expect(symbols.containsAll(['SPY', 'QQQ', 'XLK', 'HYG', 'TLT']), isTrue);

    final configuration = MarketDataConfiguration.fromEnvironment();
    expect(
      configuration.alphaVantageSymbols.length,
      greaterThanOrEqualTo(kDefaultSymbolUniverse.length),
    );
    expect(
      configuration.stockUniverseLimit,
      greaterThanOrEqualTo(kDefaultStockUniverseLimit),
    );
  });

  test(
    'fixture fast-start universe includes ETFs inside wider scans',
    () async {
      final state = await FixtureMarketRepository(
        stockUniverseLimit: 180,
        historicalSnapshotLimit: 70,
      ).loadState();
      final tickers = state.snapshot.rankedUniverse
          .map((stock) => stock.ticker)
          .toSet();

      expect(state.snapshot.rankedUniverse, hasLength(180));
      expect(tickers.containsAll(['QQQ', 'XLK', 'HYG', 'TLT']), isTrue);
    },
  );
}
