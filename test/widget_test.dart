import 'package:flutter/material.dart';
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
    expect(find.textContaining('60 mean'), findsWidgets);

    await tester.tap(find.text('Opportunity Board').first);
    await tester.pumpAndSettle();

    expect(find.text('NVDA'), findsOneWidget);
  });

  testWidgets('surfaces plain-English guides for confusing finance terms', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FinanceOracleApp());
    await tester.pumpAndSettle();

    expect(find.text('Plain-English guide'), findsOneWidget);

    await tester.tap(find.text('Plain-English guide'));
    await tester.pumpAndSettle();

    expect(find.text('Market regime'), findsOneWidget);
    expect(find.text('Alpha and drawdown'), findsOneWidget);
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
        rankedUniverse: const [],
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

  testWidgets(
    'supports workflow actions and surfaces them in the workflow hub',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 960));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(const FinanceOracleApp());
      await tester.pumpAndSettle();

      await tester.tap(find.text('Opportunity Board').first);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byType(FilterChip).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(FilterChip).first);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Workflow Hub').first);
      await tester.pumpAndSettle();

      expect(find.textContaining('Added to watchlist'), findsOneWidget);
      expect(find.text('Recent actions'), findsOneWidget);
    },
  );

  testWidgets('imports holdings and renders portfolio-aware decisions', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FinanceOracleApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Decision Desk').first);
    await tester.pumpAndSettle();

    expect(find.text('Buy candidates'), findsWidgets);
    expect(find.text('Portfolio input'), findsOneWidget);

    await tester.ensureVisible(
      find.byKey(const ValueKey('portfolio-csv-input')),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('portfolio-csv-input')),
      'Symbol,Quantity,Average Cost\nNVDA,2,820.10',
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('import-portfolio-button')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('import-portfolio-button')));
    await tester.pumpAndSettle();

    expect(find.text('1 imported, 0 skipped.'), findsOneWidget);
    expect(find.textContaining('NVDA'), findsWidgets);
    expect(find.textContaining('2 shares'), findsWidgets);
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
