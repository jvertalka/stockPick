import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/finance_oracle_app.dart';
import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/data/market_intelligence_repository.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';
import 'package:finance_app/src/models/market_intelligence.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('renders the cross-platform market dashboard', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FinanceOracleApp());
    await tester.pumpAndSettle();

    expect(find.text('Finance Oracle'), findsOneWidget);
    expect(find.text('Market Radar'), findsWidgets);

    await tester.tap(find.text('Opportunity Board').first);
    await tester.pumpAndSettle();

    expect(find.text('NVDA'), findsOneWidget);
  });

  testWidgets('renders empty-state fallbacks for sparse live snapshots', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final baseState = await FixtureMarketRepository().loadState();
    final emptyState = IntelligenceAppState(
      snapshot: MarketIntelligenceSnapshot(
        asOf: baseState.snapshot.asOf,
        marketRadar: baseState.snapshot.marketRadar,
        opportunities: const [],
        sellAlerts: const [],
        scenarios: const [],
      ),
      dataStatus: baseState.dataStatus,
      engineStatus: baseState.engineStatus,
    );

    await tester.pumpWidget(
      FinanceOracleApp(repository: _StaticRepository(emptyState)),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Opportunity Board').first);
    await tester.pumpAndSettle();
    expect(find.text('No ranked opportunities yet.'), findsOneWidget);

    await tester.tap(find.text('Stock Intelligence').first);
    await tester.pumpAndSettle();
    expect(find.text('No stock intelligence yet.'), findsOneWidget);

    await tester.tap(find.text('Sell Alerts').first);
    await tester.pumpAndSettle();
    expect(find.text('No sell alerts yet.'), findsOneWidget);

    await tester.tap(find.text('Scenario Lab').first);
    await tester.pumpAndSettle();
    expect(find.text('No scenario outputs yet.'), findsOneWidget);
  });
}

class _StaticRepository implements MarketIntelligenceRepository {
  const _StaticRepository(this.state);

  final IntelligenceAppState state;

  @override
  Future<IntelligenceAppState> loadState() async => state;

  @override
  Future<IntelligenceAppState> refreshState() async => state;
}
