import 'package:flutter/material.dart';

import '../data/portfolio_store.dart';
import '../data/user_workflow_store.dart';
import '../engine/portfolio_decision_engine.dart';
import '../models/intelligence_app_state.dart';
import '../models/market_intelligence.dart';
import '../models/portfolio_models.dart';
import '../models/workflow_models.dart';
import '../theme/app_theme.dart';
import 'views/decision_desk_view.dart';
import 'views/market_radar_view.dart';
import 'views/opportunity_board_view.dart';
import 'views/scenario_lab_view.dart';
import 'views/sell_alerts_view.dart';
import 'views/stock_intelligence_view.dart';
import 'views/workflow_hub_view.dart';
import 'widgets/insight_widgets.dart';

enum AppView {
  marketRadar,
  decisionDesk,
  opportunityBoard,
  stockIntelligence,
  sellAlerts,
  scenarioLab,
  workflowHub,
}

extension AppViewMeta on AppView {
  String get label => switch (this) {
    AppView.marketRadar => 'Market Radar',
    AppView.decisionDesk => 'Decision Desk',
    AppView.opportunityBoard => 'Opportunity Board',
    AppView.stockIntelligence => 'Stock Intelligence',
    AppView.sellAlerts => 'Sell Alerts',
    AppView.scenarioLab => 'Scenario Lab',
    AppView.workflowHub => 'Workflow Hub',
  };

  IconData get icon => switch (this) {
    AppView.marketRadar => Icons.radar_rounded,
    AppView.decisionDesk => Icons.fact_check_rounded,
    AppView.opportunityBoard => Icons.view_list_rounded,
    AppView.stockIntelligence => Icons.insights_rounded,
    AppView.sellAlerts => Icons.warning_amber_rounded,
    AppView.scenarioLab => Icons.science_rounded,
    AppView.workflowHub => Icons.bookmarks_rounded,
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
  String? _selectedTicker;
  ScenarioType? _selectedScenario;
  final UserWorkflowStore _workflowStore = SharedPreferencesUserWorkflowStore();
  final PortfolioStore _portfolioStore = SharedPreferencesPortfolioStore();
  final PortfolioDecisionEngine _decisionEngine =
      const PortfolioDecisionEngine();
  WorkflowState _workflowState = WorkflowState.empty;
  PortfolioState _portfolioState = PortfolioState.empty;

  MarketIntelligenceSnapshot get _snapshot => widget.state.snapshot;

  @override
  void initState() {
    super.initState();
    _selectedTicker = _defaultTicker();
    _selectedScenario = _defaultScenario();
    _loadWorkflowState();
    _loadPortfolioState();
  }

  @override
  void didUpdateWidget(covariant HomeShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_selectedTicker == null ||
        !_snapshot.rankedUniverse.any(
          (stock) => stock.ticker == _selectedTicker,
        )) {
      _selectedTicker = _defaultTicker();
    }
    if (_selectedScenario == null ||
        !_snapshot.scenarios.any(
          (scenario) => scenario.type == _selectedScenario,
        )) {
      _selectedScenario = _defaultScenario();
    }
  }

  String? _defaultTicker() {
    if (_snapshot.rankedUniverse.isEmpty) {
      return null;
    }
    return _snapshot.rankedUniverse.first.ticker;
  }

  ScenarioType? _defaultScenario() {
    if (_snapshot.scenarios.isEmpty) {
      return null;
    }
    return _snapshot.scenarios.first.type;
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
    _recordWorkflowAction(
      WorkflowActionRecord(
        type: WorkflowActionType.stockOpened,
        ticker: ticker,
        occurredAt: DateTime.now(),
      ),
    );
  }

  Future<void> _loadWorkflowState() async {
    final state = await _workflowStore.load();
    if (!mounted) {
      return;
    }
    setState(() {
      _workflowState = state;
    });
  }

  Future<void> _persistWorkflowState(WorkflowState state) async {
    setState(() {
      _workflowState = state;
    });
    await _workflowStore.save(state);
  }

  Future<void> _loadPortfolioState() async {
    final state = await _portfolioStore.load();
    if (!mounted) {
      return;
    }
    setState(() {
      _portfolioState = state;
    });
  }

  Future<void> _persistPortfolioState(PortfolioState state) async {
    setState(() {
      _portfolioState = state;
    });
    await _portfolioStore.save(state);
  }

  Future<void> _recordWorkflowAction(WorkflowActionRecord record) async {
    final recent = [record, ..._workflowState.recentActions];
    await _persistWorkflowState(
      _workflowState.copyWith(recentActions: recent.take(24).toList()),
    );
  }

  Future<void> _toggleWatchlist(String ticker) async {
    final next = {..._workflowState.watchlistTickers};
    final added = !next.remove(ticker);
    if (added) {
      next.add(ticker);
    }
    await _persistWorkflowState(
      _workflowState.copyWith(watchlistTickers: next),
    );
    await _recordWorkflowAction(
      WorkflowActionRecord(
        type: added
            ? WorkflowActionType.watchlistAdded
            : WorkflowActionType.watchlistRemoved,
        ticker: ticker,
        occurredAt: DateTime.now(),
      ),
    );
  }

  Future<void> _toggleSavedIdea(String ticker) async {
    final next = {..._workflowState.savedIdeas};
    final added = !next.remove(ticker);
    if (added) {
      next.add(ticker);
    }
    await _persistWorkflowState(_workflowState.copyWith(savedIdeas: next));
    await _recordWorkflowAction(
      WorkflowActionRecord(
        type: added
            ? WorkflowActionType.savedIdeaAdded
            : WorkflowActionType.savedIdeaRemoved,
        ticker: ticker,
        occurredAt: DateTime.now(),
      ),
    );
  }

  Future<void> _toggleAlertSubscription(String ticker) async {
    final next = {..._workflowState.alertSubscriptions};
    final added = !next.remove(ticker);
    if (added) {
      next.add(ticker);
    }
    await _persistWorkflowState(
      _workflowState.copyWith(alertSubscriptions: next),
    );
    await _recordWorkflowAction(
      WorkflowActionRecord(
        type: added
            ? WorkflowActionType.alertSubscribed
            : WorkflowActionType.alertUnsubscribed,
        ticker: ticker,
        occurredAt: DateTime.now(),
      ),
    );
  }

  Widget _buildView() {
    return switch (_selectedView) {
      AppView.marketRadar => MarketRadarView(
        radar: _snapshot.marketRadar,
        dataStatus: widget.state.dataStatus,
        engineStatus: widget.state.engineStatus,
      ),
      AppView.decisionDesk => DecisionDeskView(
        snapshot: _snapshot,
        portfolioState: _portfolioState,
        report: _decisionEngine.build(
          snapshot: _snapshot,
          portfolio: _portfolioState,
        ),
        onPortfolioChanged: (state) {
          _persistPortfolioState(state);
        },
        onOpenStock: _openStock,
      ),
      AppView.opportunityBoard => OpportunityBoardView(
        stocks: _snapshot.rankedUniverse,
        highlightedTickers: _snapshot.opportunities
            .map((stock) => stock.ticker)
            .toSet(),
        workflowState: _workflowState,
        onOpenStock: _openStock,
        onToggleWatchlist: (ticker) {
          _toggleWatchlist(ticker);
        },
        onToggleSavedIdea: (ticker) {
          _toggleSavedIdea(ticker);
        },
        onToggleAlertSubscription: (ticker) {
          _toggleAlertSubscription(ticker);
        },
      ),
      AppView.stockIntelligence => StockIntelligenceView(
        stocks: _snapshot.rankedUniverse,
        selectedTicker: _selectedTicker,
        workflowState: _workflowState,
        onSelectTicker: (ticker) {
          setState(() {
            _selectedTicker = ticker;
          });
        },
        onToggleWatchlist: (ticker) {
          _toggleWatchlist(ticker);
        },
        onToggleSavedIdea: (ticker) {
          _toggleSavedIdea(ticker);
        },
        onToggleAlertSubscription: (ticker) {
          _toggleAlertSubscription(ticker);
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
      AppView.workflowHub => WorkflowHubView(
        snapshot: _snapshot,
        workflowState: _workflowState,
        onOpenStock: _openStock,
        onToggleWatchlist: (ticker) {
          _toggleWatchlist(ticker);
        },
        onToggleSavedIdea: (ticker) {
          _toggleSavedIdea(ticker);
        },
        onToggleAlertSubscription: (ticker) {
          _toggleAlertSubscription(ticker);
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
