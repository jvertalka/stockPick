import 'package:flutter/material.dart';

import '../data/app_settings_store.dart';
import '../data/portfolio_store.dart';
import '../data/recommendation_ledger_store.dart';
import '../data/user_workflow_store.dart';
import '../engine/portfolio_decision_engine.dart';
import '../engine/portfolio_universe_expander.dart';
import '../models/app_settings_models.dart';
import '../models/intelligence_app_state.dart';
import '../models/market_intelligence.dart';
import '../models/portfolio_models.dart';
import '../models/recommendation_ledger_models.dart';
import '../models/workflow_models.dart';
import '../theme/app_theme.dart';
import 'views/daily_decision_brief_view.dart';
import 'views/decision_desk_view.dart';
import 'views/market_radar_view.dart';
import 'views/opportunity_board_view.dart';
import 'views/scenario_lab_view.dart';
import 'views/sell_alerts_view.dart';
import 'views/settings_view.dart';
import 'views/stock_intelligence_view.dart';
import 'views/workflow_hub_view.dart';
import 'widgets/insight_widgets.dart';

enum AppView {
  dailyBrief,
  marketRadar,
  decisionDesk,
  opportunityBoard,
  stockIntelligence,
  sellAlerts,
  scenarioLab,
  workflowHub,
  settings,
}

extension AppViewMeta on AppView {
  String get label => switch (this) {
    AppView.dailyBrief => 'Daily Brief',
    AppView.marketRadar => 'Market Radar',
    AppView.decisionDesk => 'Decision Desk',
    AppView.opportunityBoard => 'Opportunity Board',
    AppView.stockIntelligence => 'Stock Intelligence',
    AppView.sellAlerts => 'Sell Alerts',
    AppView.scenarioLab => 'Scenario Lab',
    AppView.workflowHub => 'Workflow Hub',
    AppView.settings => 'Settings',
  };

  IconData get icon => switch (this) {
    AppView.dailyBrief => Icons.today_rounded,
    AppView.marketRadar => Icons.radar_rounded,
    AppView.decisionDesk => Icons.fact_check_rounded,
    AppView.opportunityBoard => Icons.view_list_rounded,
    AppView.stockIntelligence => Icons.insights_rounded,
    AppView.sellAlerts => Icons.warning_amber_rounded,
    AppView.scenarioLab => Icons.science_rounded,
    AppView.workflowHub => Icons.bookmarks_rounded,
    AppView.settings => Icons.tune_rounded,
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
  AppView _selectedView = AppView.dailyBrief;
  String? _selectedTicker;
  ScenarioType? _selectedScenario;
  final AppSettingsStore _settingsStore = SharedPreferencesAppSettingsStore();
  final RecommendationLedgerStore _ledgerStore =
      SharedPreferencesRecommendationLedgerStore();
  final UserWorkflowStore _workflowStore = SharedPreferencesUserWorkflowStore();
  final PortfolioStore _portfolioStore = SharedPreferencesPortfolioStore();
  final PortfolioDecisionEngine _decisionEngine =
      const PortfolioDecisionEngine();
  final PortfolioUniverseExpander _universeExpander =
      const PortfolioUniverseExpander();
  WorkflowState _workflowState = WorkflowState.empty;
  PortfolioState _portfolioState = PortfolioState.empty;
  AppSettings _appSettings = AppSettings.empty;
  RecommendationLedger _recommendationLedger = RecommendationLedger.empty;

  MarketIntelligenceSnapshot _expandedSnapshot() {
    return _universeExpander.expand(widget.state.snapshot, [
      ..._portfolioState.holdings.map((h) => h.ticker),
      ..._appSettings.customUniverseTickers,
    ]);
  }

  @override
  void initState() {
    super.initState();
    final snapshot = _expandedSnapshot();
    _selectedTicker = _defaultTicker(snapshot);
    _selectedScenario = _defaultScenario(snapshot);
    _loadAppSettings();
    _loadRecommendationLedger();
    _loadWorkflowState();
    _loadPortfolioState();
  }

  @override
  void didUpdateWidget(covariant HomeShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    final snapshot = _expandedSnapshot();
    if (_selectedTicker == null ||
        !snapshot.rankedUniverse.any(
          (stock) => stock.ticker == _selectedTicker,
        )) {
      _selectedTicker = _defaultTicker(snapshot);
    }
    if (_selectedScenario == null ||
        !snapshot.scenarios.any(
          (scenario) => scenario.type == _selectedScenario,
        )) {
      _selectedScenario = _defaultScenario(snapshot);
    }
    if (oldWidget.state.snapshot.asOf != widget.state.snapshot.asOf) {
      _recordRecommendationSnapshot();
    }
  }

  String? _defaultTicker(MarketIntelligenceSnapshot snapshot) {
    if (snapshot.rankedUniverse.isEmpty) {
      return null;
    }
    return snapshot.rankedUniverse.first.ticker;
  }

  ScenarioType? _defaultScenario(MarketIntelligenceSnapshot snapshot) {
    if (snapshot.scenarios.isEmpty) {
      return null;
    }
    return snapshot.scenarios.first.type;
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _expandedSnapshot();
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
                                child: _buildView(snapshot),
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
                          child: _buildView(snapshot),
                        ),
                      ),
                    ),
                  ],
                ),
        ),
        bottomNavigationBar: showRail
            ? null
            : _MobileNavBar(
                selectedView: _selectedView,
                onSelect: _handleViewChange,
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

  Future<void> _loadAppSettings() async {
    final settings = await _settingsStore.load();
    if (!mounted) {
      return;
    }
    setState(() {
      _appSettings = settings;
    });
  }

  Future<void> _persistAppSettings(AppSettings settings) async {
    setState(() {
      _appSettings = settings;
    });
    await _settingsStore.save(settings);
  }

  Future<void> _loadRecommendationLedger() async {
    final ledger = await _ledgerStore.load();
    if (!mounted) {
      return;
    }
    final next = ledger.upsertSnapshot(widget.state.snapshot);
    setState(() {
      _recommendationLedger = next;
    });
    await _ledgerStore.save(next);
  }

  Future<void> _recordRecommendationSnapshot() async {
    final next = _recommendationLedger.upsertSnapshot(widget.state.snapshot);
    if (!mounted) {
      return;
    }
    setState(() {
      _recommendationLedger = next;
    });
    await _ledgerStore.save(next);
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

  Widget _buildView(MarketIntelligenceSnapshot snapshot) {
    switch (_selectedView) {
      case AppView.dailyBrief:
        final report = _decisionEngine.build(
          snapshot: snapshot,
          portfolio: _portfolioState,
        );
        return DailyDecisionBriefView(
          snapshot: snapshot,
          report: report,
          ledger: _recommendationLedger,
          onOpenStock: _openStock,
        );
      case AppView.marketRadar:
        return MarketRadarView(
          radar: snapshot.marketRadar,
          dataStatus: widget.state.dataStatus,
          engineStatus: widget.state.engineStatus,
        );
      case AppView.decisionDesk:
        final report = _decisionEngine.build(
          snapshot: snapshot,
          portfolio: _portfolioState,
        );
        return DecisionDeskView(
          snapshot: snapshot,
          portfolioState: _portfolioState,
          report: report,
          onPortfolioChanged: (state) {
            _persistPortfolioState(state);
          },
          onOpenStock: _openStock,
        );
      case AppView.opportunityBoard:
        return OpportunityBoardView(
          stocks: snapshot.rankedUniverse,
          highlightedTickers: snapshot.opportunities
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
        );
      case AppView.stockIntelligence:
        return StockIntelligenceView(
          stocks: snapshot.rankedUniverse,
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
        );
      case AppView.sellAlerts:
        return SellAlertsView(alerts: snapshot.sellAlerts);
      case AppView.scenarioLab:
        return ScenarioLabView(
          scenarios: snapshot.scenarios,
          selectedScenario: _selectedScenario,
          rankedUniverse: snapshot.rankedUniverse,
          onSelectScenario: (scenario) {
            setState(() {
              _selectedScenario = scenario;
            });
          },
        );
      case AppView.workflowHub:
        return WorkflowHubView(
          snapshot: snapshot,
          workflowState: _workflowState,
          ledger: _recommendationLedger,
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
        );
      case AppView.settings:
        return SettingsView(
          settings: _appSettings,
          dataStatus: widget.state.dataStatus,
          engineStatus: widget.state.engineStatus,
          onSettingsChanged: _persistAppSettings,
        );
    }
  }
}

class _MobileNavBar extends StatelessWidget {
  const _MobileNavBar({required this.selectedView, required this.onSelect});

  final AppView selectedView;
  final ValueChanged<AppView> onSelect;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        height: 86,
        decoration: BoxDecoration(
          color: AppTheme.surface.withValues(alpha: 0.96),
          border: Border(
            top: BorderSide(color: Colors.white.withValues(alpha: 0.08)),
          ),
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            children: AppView.values
                .map(
                  (view) => _MobileNavItem(
                    view: view,
                    selected: view == selectedView,
                    onTap: () => onSelect(view),
                  ),
                )
                .toList(),
          ),
        ),
      ),
    );
  }
}

class _MobileNavItem extends StatelessWidget {
  const _MobileNavItem({
    required this.view,
    required this.selected,
    required this.onTap,
  });

  final AppView view;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppTheme.mint : AppTheme.textMuted;

    return Tooltip(
      message: view.label,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            width: 74,
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
            decoration: BoxDecoration(
              color: selected
                  ? AppTheme.mint.withValues(alpha: 0.14)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: selected
                    ? AppTheme.mint.withValues(alpha: 0.25)
                    : Colors.transparent,
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(view.icon, size: 22, color: color),
                const SizedBox(height: 5),
                Text(
                  view.label,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: color,
                    fontSize: 10.5,
                    height: 1.1,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
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
