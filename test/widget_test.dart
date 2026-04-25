import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/finance_oracle_app.dart';
import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/data/market_intelligence_repository.dart';
import 'package:finance_app/src/data/portfolio_csv_loader.dart';
import 'package:finance_app/src/engine/portfolio_decision_engine.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';
import 'package:finance_app/src/models/market_intelligence.dart';
import 'package:finance_app/src/models/portfolio_models.dart';
import 'package:finance_app/src/presentation/views/decision_desk_view.dart';
import 'package:finance_app/src/presentation/views/market_radar_view.dart';
import 'package:finance_app/src/presentation/views/sell_alerts_view.dart';
import 'package:finance_app/src/theme/app_theme.dart';

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
    expect(find.text('Decision Desk'), findsWidgets);
    await tester.tap(find.text('Market Radar').first);
    await tester.pumpAndSettle();

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

    await tester.tap(find.text('Market Radar').first);
    await tester.pumpAndSettle();

    expect(find.text('Plain-English guide'), findsOneWidget);

    await tester.tap(find.text('Plain-English guide'));
    await tester.pumpAndSettle();

    expect(find.text('Market regime'), findsOneWidget);
    expect(find.text('Alpha and drawdown'), findsOneWidget);
  });

  testWidgets('market radar header follows the detected regime', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final state = await FixtureMarketRepository().loadState();
    final riskOffRadar = state.snapshot.marketRadar.copyWith(
      regime: MarketRegimeType.riskOff,
      regimeConfidence: 81,
      internalHealth: InternalHealthType.hiddenBreakdown,
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.build(),
        home: Scaffold(
          body: MarketRadarView(
            radar: riskOffRadar,
            dataStatus: state.dataStatus,
            engineStatus: state.engineStatus,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text(
        'The market is defensive, so capital preservation comes first.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('Risk-off with 81% confidence'), findsOneWidget);
  });

  testWidgets('sell alert board counts de-risk separately', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.build(),
        home: Scaffold(
          body: SellAlertsView(
            alerts: [
              _alert('TRIM', RecommendationAction.trim),
              _alert('RISK', RecommendationAction.deRisk),
              _alert('EXIT', RecommendationAction.exit),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Trim candidates'), findsOneWidget);
    expect(find.text('De-risk alerts'), findsOneWidget);
    expect(find.text('Exit alerts'), findsOneWidget);
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

    expect(find.text('New buy ideas'), findsWidgets);
    expect(find.text('Portfolio import'), findsOneWidget);

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

    expect(find.text('1 holding imported, 0 skipped.'), findsOneWidget);
    expect(find.textContaining('NVDA'), findsWidgets);
    expect(find.textContaining('2 shares'), findsWidgets);
  });

  testWidgets('imports a Fidelity CSV through the file chooser flow', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 1080));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final state = await FixtureMarketRepository().loadState();
    var portfolioState = PortfolioState.empty;

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.build(),
        home: StatefulBuilder(
          builder: (context, setState) {
            final report = const PortfolioDecisionEngine().build(
              snapshot: state.snapshot,
              portfolio: portfolioState,
            );
            return Scaffold(
              body: DecisionDeskView(
                snapshot: state.snapshot,
                portfolioState: portfolioState,
                report: report,
                portfolioCsvLoader: const _FakePortfolioCsvLoader(),
                onPortfolioChanged: (next) {
                  setState(() {
                    portfolioState = next;
                  });
                },
                onOpenStock: (_) {},
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.ensureVisible(
      find.byKey(const ValueKey('pick-portfolio-file-button')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pick-portfolio-file-button')));
    await tester.pumpAndSettle();

    expect(
      find.text('Last imported file: Portfolio_Positions_Apr-23-2026.csv'),
      findsOneWidget,
    );
    expect(
      find.text('1 holding imported, cash \$286850.51 captured, 0 skipped.'),
      findsOneWidget,
    );
    expect(find.text('Capital plan'), findsOneWidget);
    expect(find.text('Imported cash balance'), findsOneWidget);
    expect(find.textContaining('IONQ'), findsWidgets);
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

class _FakePortfolioCsvLoader implements PortfolioCsvLoader {
  const _FakePortfolioCsvLoader();

  @override
  Future<PortfolioCsvSelection?> pickCsv() async {
    return const PortfolioCsvSelection(
      fileName: 'Portfolio_Positions_Apr-23-2026.csv',
      rawCsv:
          'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Type\n'
          'X85989591,Individual - TOD,SPAXX**,HELD IN MONEY MARKET,,,\$286850.51,,,Cash,\n'
          'X85989591,Individual - TOD,IONQ,IONQ INC COM,136,\$43.46,\$5910.56,\$1053.49,\$7.75,Equity,\n',
    );
  }
}

SellAlert _alert(String ticker, RecommendationAction action) {
  return SellAlert(
    ticker: ticker,
    company: '$ticker Test Co',
    action: action,
    severity: action == RecommendationAction.exit
        ? AlertSeverity.critical
        : AlertSeverity.high,
    thesisDamageScore: action == RecommendationAction.exit ? 88 : 72,
    clusterCount: 4,
    summary: 'Multiple deterioration signals are now aligned.',
    triggers: const [
      'Relative strength rolled over.',
      'Options stress increased.',
    ],
    nextCheck: 'Re-check after the next market refresh.',
    effectiveClusterWeight: 3.6,
    exitProbability: 64,
  );
}
