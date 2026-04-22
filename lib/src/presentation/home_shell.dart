import 'package:flutter/material.dart';

import '../models/intelligence_app_state.dart';
import '../models/market_intelligence.dart';
import '../theme/app_theme.dart';
import 'views/market_radar_view.dart';
import 'views/opportunity_board_view.dart';
import 'views/scenario_lab_view.dart';
import 'views/sell_alerts_view.dart';
import 'views/stock_intelligence_view.dart';
import 'widgets/insight_widgets.dart';

enum AppView {
  marketRadar,
  opportunityBoard,
  stockIntelligence,
  sellAlerts,
  scenarioLab,
}

extension AppViewMeta on AppView {
  String get label => switch (this) {
    AppView.marketRadar => 'Market Radar',
    AppView.opportunityBoard => 'Opportunity Board',
    AppView.stockIntelligence => 'Stock Intelligence',
    AppView.sellAlerts => 'Sell Alerts',
    AppView.scenarioLab => 'Scenario Lab',
  };

  IconData get icon => switch (this) {
    AppView.marketRadar => Icons.radar_rounded,
    AppView.opportunityBoard => Icons.view_list_rounded,
    AppView.stockIntelligence => Icons.insights_rounded,
    AppView.sellAlerts => Icons.warning_amber_rounded,
    AppView.scenarioLab => Icons.science_rounded,
  };
}

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.state,
    required this.onRefresh,
    this.isRefreshing = false,
  });

  final IntelligenceAppState state;
  final Future<void> Function() onRefresh;
  final bool isRefreshing;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  AppView _selectedView = AppView.marketRadar;
  late String _selectedTicker;
  ScenarioType _selectedScenario = ScenarioType.creditWidening;

  MarketIntelligenceSnapshot get _snapshot => widget.state.snapshot;

  @override
  void initState() {
    super.initState();
    _selectedTicker = _snapshot.opportunities.first.ticker;
    _selectedScenario = _snapshot.scenarios.first.type;
  }

  @override
  void didUpdateWidget(covariant HomeShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_snapshot.opportunities.any(
      (stock) => stock.ticker == _selectedTicker,
    )) {
      _selectedTicker = _snapshot.opportunities.first.ticker;
    }
    if (!_snapshot.scenarios.any(
      (scenario) => scenario.type == _selectedScenario,
    )) {
      _selectedScenario = _snapshot.scenarios.first.type;
    }
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final showRail = width >= 1040;

    return DecoratedBox(
      decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: SafeArea(
          child: showRail
              ? Row(
                  children: [
                    _DesktopRail(
                      selectedView: _selectedView,
                      onSelect: _handleViewChange,
                    ),
                    Expanded(
                      child: Column(
                        children: [
                          _TopBanner(
                            state: widget.state,
                            onRefresh: widget.onRefresh,
                            isRefreshing: widget.isRefreshing,
                          ),
                          const Divider(height: 1),
                          Expanded(
                            child: AnimatedSwitcher(
                              duration: const Duration(milliseconds: 250),
                              child: KeyedSubtree(
                                key: ValueKey<AppView>(_selectedView),
                                child: _buildView(),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                )
              : Column(
                  children: [
                    _TopBanner(
                      state: widget.state,
                      onRefresh: widget.onRefresh,
                      isRefreshing: widget.isRefreshing,
                    ),
                    const Divider(height: 1),
                    Expanded(
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 250),
                        child: KeyedSubtree(
                          key: ValueKey<AppView>(_selectedView),
                          child: _buildView(),
                        ),
                      ),
                    ),
                  ],
                ),
        ),
        bottomNavigationBar: showRail
            ? null
            : NavigationBar(
                selectedIndex: AppView.values.indexOf(_selectedView),
                onDestinationSelected: (index) {
                  _handleViewChange(AppView.values[index]);
                },
                destinations: AppView.values
                    .map(
                      (view) => NavigationDestination(
                        icon: Icon(view.icon),
                        label: view.label,
                      ),
                    )
                    .toList(),
              ),
      ),
    );
  }

  void _handleViewChange(AppView view) {
    setState(() {
      _selectedView = view;
    });
  }

  void _openStock(String ticker) {
    setState(() {
      _selectedTicker = ticker;
      _selectedView = AppView.stockIntelligence;
    });
  }

  Widget _buildView() {
    return switch (_selectedView) {
      AppView.marketRadar => MarketRadarView(
        radar: _snapshot.marketRadar,
        dataStatus: widget.state.dataStatus,
        engineStatus: widget.state.engineStatus,
      ),
      AppView.opportunityBoard => OpportunityBoardView(
        stocks: _snapshot.opportunities,
        onOpenStock: _openStock,
      ),
      AppView.stockIntelligence => StockIntelligenceView(
        stocks: _snapshot.opportunities,
        selectedTicker: _selectedTicker,
        onSelectTicker: (ticker) {
          setState(() {
            _selectedTicker = ticker;
          });
        },
      ),
      AppView.sellAlerts => SellAlertsView(alerts: _snapshot.sellAlerts),
      AppView.scenarioLab => ScenarioLabView(
        scenarios: _snapshot.scenarios,
        selectedScenario: _selectedScenario,
        onSelectScenario: (scenario) {
          setState(() {
            _selectedScenario = scenario;
          });
        },
      ),
    };
  }
}

class _DesktopRail extends StatelessWidget {
  const _DesktopRail({required this.selectedView, required this.onSelect});

  final AppView selectedView;
  final ValueChanged<AppView> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 108,
      padding: const EdgeInsets.fromLTRB(14, 18, 14, 18),
      decoration: BoxDecoration(
        color: AppTheme.surface.withValues(alpha: 0.74),
        border: Border(
          right: BorderSide(color: Colors.white.withValues(alpha: 0.08)),
        ),
      ),
      child: Column(
        children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              gradient: const LinearGradient(
                colors: [AppTheme.mint, AppTheme.sky],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
            child: const Icon(
              Icons.auto_graph_rounded,
              color: AppTheme.background,
            ),
          ),
          const SizedBox(height: 14),
          Text('Oracle', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 18),
          Expanded(
            child: NavigationRail(
              selectedIndex: AppView.values.indexOf(selectedView),
              onDestinationSelected: (index) => onSelect(AppView.values[index]),
              labelType: NavigationRailLabelType.all,
              destinations: AppView.values
                  .map(
                    (view) => NavigationRailDestination(
                      icon: Icon(view.icon),
                      label: Text(view.label),
                    ),
                  )
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class _TopBanner extends StatelessWidget {
  const _TopBanner({
    required this.state,
    required this.onRefresh,
    required this.isRefreshing,
  });

  final IntelligenceAppState state;
  final Future<void> Function() onRefresh;
  final bool isRefreshing;

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;

    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 18),
      child: isCompact
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _BrandBlock(snapshot: state.snapshot),
                const SizedBox(height: 16),
                _StatusChips(
                  state: state,
                  onRefresh: onRefresh,
                  isRefreshing: isRefreshing,
                ),
              ],
            )
          : Row(
              children: [
                Expanded(child: _BrandBlock(snapshot: state.snapshot)),
                const SizedBox(width: 16),
                Flexible(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: _StatusChips(
                      state: state,
                      onRefresh: onRefresh,
                      isRefreshing: isRefreshing,
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

class _BrandBlock extends StatelessWidget {
  const _BrandBlock({required this.snapshot});

  final MarketIntelligenceSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Finance Oracle',
          style: Theme.of(
            context,
          ).textTheme.displayMedium?.copyWith(fontSize: 40),
        ),
        const SizedBox(height: 8),
        Text(
          'Regime detection, conditional opportunity ranking, and disciplined exits in one cross-platform control room.',
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ],
    );
  }
}

class _StatusChips extends StatelessWidget {
  const _StatusChips({
    required this.state,
    required this.onRefresh,
    required this.isRefreshing,
  });

  final IntelligenceAppState state;
  final Future<void> Function() onRefresh;
  final bool isRefreshing;

  @override
  Widget build(BuildContext context) {
    final radar = state.snapshot.marketRadar;

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        TonePill(
          label: '${radar.regime.label} | ${radar.regimeConfidence.round()}%',
          tone: SignalTone.positive,
        ),
        TonePill(label: state.dataStatus.title, tone: SignalTone.neutral),
        TonePill(
          label: state.engineStatus.isTrained ? 'Trained' : 'Not trained',
          tone: state.engineStatus.isTrained
              ? SignalTone.positive
              : SignalTone.caution,
        ),
        TonePill(
          label: state.engineStatus.validationStage.label,
          tone: SignalTone.neutral,
        ),
        TonePill(
          label: 'Synced ${formatAsOf(state.dataStatus.lastRefresh)}',
          tone: SignalTone.neutral,
        ),
        TonePill(
          label: 'As of ${formatAsOf(state.snapshot.asOf)}',
          tone: SignalTone.neutral,
        ),
        FilledButton.icon(
          onPressed: isRefreshing ? null : onRefresh,
          icon: isRefreshing
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh_rounded),
          label: Text(isRefreshing ? 'Refreshing' : 'Refresh'),
        ),
      ],
    );
  }
}
