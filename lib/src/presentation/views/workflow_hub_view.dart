import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../models/recommendation_ledger_models.dart';
import '../../models/workflow_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class WorkflowHubView extends StatelessWidget {
  const WorkflowHubView({
    super.key,
    required this.snapshot,
    required this.workflowState,
    required this.ledger,
    required this.onOpenStock,
    required this.onToggleWatchlist,
    required this.onToggleSavedIdea,
    required this.onToggleAlertSubscription,
  });

  final MarketIntelligenceSnapshot snapshot;
  final WorkflowState workflowState;
  final RecommendationLedger ledger;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onToggleWatchlist;
  final ValueChanged<String> onToggleSavedIdea;
  final ValueChanged<String> onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    final stockMap = {
      for (final stock in snapshot.rankedUniverse) stock.ticker: stock,
    };
    final alertMap = {
      for (final alert in snapshot.sellAlerts) alert.ticker: alert,
    };

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final sectionWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 2,
            minWidth: 320,
          );

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ViewHeader(
                eyebrow: 'Workflow Hub',
                title: 'Turn the dashboard into a working process.',
                subtitle:
                    'Track the names you want to revisit, save the ideas worth keeping, subscribe to alerts, and keep a small action trail you can audit later.',
                trailing: TonePill(
                  label: '${workflowState.recentActions.length} recent actions',
                  tone: SignalTone.neutral,
                ),
              ),
              const PlainEnglishGuideCard(
                summary:
                    'This is the day-to-day utility layer. It helps you keep a lightweight process instead of re-reading the whole board every time.',
                entries: _workflowGuideEntries,
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Watchlist',
                      value: '${workflowState.watchlistTickers.length}',
                      detail:
                          'Names you want to keep checking even if they are not top-ranked right now.',
                      tone: SignalTone.neutral,
                      definition:
                          'The watchlist is for active monitoring, not just bookmarking. It is the shortlist you want to revisit.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Saved ideas',
                      value: '${workflowState.savedIdeas.length}',
                      detail:
                          'Setups worth preserving even if the board or regime changes later.',
                      tone: SignalTone.positive,
                      definition:
                          'Saved ideas are the names you want to keep as part of your research stack, even if you are not acting on them right now.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Alert subscriptions',
                      value: '${workflowState.alertSubscriptions.length}',
                      detail:
                          'Tickers where you want the sell-alert logic to stay in view.',
                      tone: SignalTone.caution,
                      definition:
                          'An alert subscription means you want to keep deterioration signals in front of you for that name.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Action history',
                      value: '${workflowState.recentActions.length}',
                      detail:
                          'A lightweight audit trail of what you changed inside the app.',
                      tone: SignalTone.neutral,
                      definition:
                          'This is not a trade blotter. It is a short in-app memory of watchlist, save, alert, and review actions.',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: _WorkflowTickerCard(
                      title: 'Watchlist',
                      emptyTitle: 'No watchlist names yet.',
                      emptyMessage:
                          'Star names from the opportunity board or stock sheet to keep them in your active monitoring set.',
                      tickers: workflowState.watchlistTickers.toList()..sort(),
                      stockMap: stockMap,
                      onOpenStock: onOpenStock,
                      onPrimaryAction: onToggleWatchlist,
                      primaryIcon: Icons.star_rounded,
                      primaryLabel: 'Remove',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _WorkflowTickerCard(
                      title: 'Saved ideas',
                      emptyTitle: 'No saved ideas yet.',
                      emptyMessage:
                          'Bookmark stronger setups when you want them to outlive the current board state.',
                      tickers: workflowState.savedIdeas.toList()..sort(),
                      stockMap: stockMap,
                      onOpenStock: onOpenStock,
                      onPrimaryAction: onToggleSavedIdea,
                      primaryIcon: Icons.bookmark_rounded,
                      primaryLabel: 'Remove',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _AlertSubscriptionCard(
                      tickers: workflowState.alertSubscriptions.toList()
                        ..sort(),
                      stockMap: stockMap,
                      alertMap: alertMap,
                      onOpenStock: onOpenStock,
                      onToggleAlertSubscription: onToggleAlertSubscription,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _RecentActionsCard(
                      actions: workflowState.recentActions,
                    ),
                  ),
                  SizedBox(
                    width: constraints.maxWidth,
                    child: _RecommendationLedgerCard(
                      ledger: ledger,
                      onOpenStock: onOpenStock,
                    ),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }
}

class _RecommendationLedgerCard extends StatelessWidget {
  const _RecommendationLedgerCard({
    required this.ledger,
    required this.onOpenStock,
  });

  final RecommendationLedger ledger;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final recent = ledger.recent.take(18).toList();
    final measured = ledger.records
        .where(
          (record) =>
              record.outcome5d?.status == OutcomeStatus.measured ||
              record.outcome20d?.status == OutcomeStatus.measured ||
              record.outcome60d?.status == OutcomeStatus.measured,
        )
        .length;
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.receipt_long_rounded,
                color: AppTheme.mint,
                size: 22,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Recommendation ledger',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
              ),
              TonePill(
                label: '${ledger.records.length} records | $measured measured',
                tone: SignalTone.neutral,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'Every ranked snapshot is stored locally with action, trust level, score, thesis, and later 5/20/60-day outcome slots when price coverage is available.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          if (recent.isEmpty)
            const EmptyStateCard(
              icon: Icons.receipt_long_outlined,
              title: 'No ledger records yet.',
              message:
                  'The ledger fills automatically after the first scored snapshot renders.',
            )
          else
            ...recent.map(
              (record) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _LedgerRecordRow(
                  record: record,
                  onOpenStock: onOpenStock,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _LedgerRecordRow extends StatelessWidget {
  const _LedgerRecordRow({required this.record, required this.onOpenStock});

  final RecommendationRecord record;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final actionTint = actionColor(record.action);
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => onOpenStock(record.ticker),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.03),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                SizedBox(
                  width: 78,
                  child: Text(
                    record.ticker,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                Expanded(
                  child: Text(
                    '${record.action.label} | ${record.trustLevel.label} | ${record.regime.label}',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: actionTint),
                  ),
                ),
                Text(
                  record.opportunityScore.round().toString(),
                  style: Theme.of(
                    context,
                  ).textTheme.titleMedium?.copyWith(color: AppTheme.mint),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _OutcomePill(label: '5d', outcome: record.outcome5d),
                _OutcomePill(label: '20d', outcome: record.outcome20d),
                _OutcomePill(label: '60d', outcome: record.outcome60d),
                TonePill(
                  label: formatAsOf(record.asOf),
                  tone: SignalTone.neutral,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _OutcomePill extends StatelessWidget {
  const _OutcomePill({required this.label, required this.outcome});

  final String label;
  final RecommendationOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final current = outcome;
    if (current == null) {
      return TonePill(label: '$label pending', tone: SignalTone.neutral);
    }
    if (current.status == OutcomeStatus.priceMissing) {
      return TonePill(label: '$label price missing', tone: SignalTone.caution);
    }
    final positive = current.returnPct >= 0;
    return TonePill(
      label:
          '$label ${positive ? '+' : ''}${current.returnPct.toStringAsFixed(1)}%',
      tone: positive ? SignalTone.positive : SignalTone.negative,
    );
  }
}

class _WorkflowTickerCard extends StatelessWidget {
  const _WorkflowTickerCard({
    required this.title,
    required this.emptyTitle,
    required this.emptyMessage,
    required this.tickers,
    required this.stockMap,
    required this.onOpenStock,
    required this.onPrimaryAction,
    required this.primaryIcon,
    required this.primaryLabel,
  });

  final String title;
  final String emptyTitle;
  final String emptyMessage;
  final List<String> tickers;
  final Map<String, StockInsight> stockMap;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onPrimaryAction;
  final IconData primaryIcon;
  final String primaryLabel;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 14),
          if (tickers.isEmpty)
            EmptyStateCard(
              icon: Icons.bookmarks_outlined,
              title: emptyTitle,
              message: emptyMessage,
            )
          else
            ...tickers.map(
              (ticker) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _TickerRow(
                  ticker: ticker,
                  stock: stockMap[ticker],
                  onOpenStock: onOpenStock,
                  onPrimaryAction: onPrimaryAction,
                  primaryIcon: primaryIcon,
                  primaryLabel: primaryLabel,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AlertSubscriptionCard extends StatelessWidget {
  const _AlertSubscriptionCard({
    required this.tickers,
    required this.stockMap,
    required this.alertMap,
    required this.onOpenStock,
    required this.onToggleAlertSubscription,
  });

  final List<String> tickers;
  final Map<String, StockInsight> stockMap;
  final Map<String, SellAlert> alertMap;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Alert subscriptions',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 14),
          if (tickers.isEmpty)
            const EmptyStateCard(
              icon: Icons.notifications_outlined,
              title: 'No alert subscriptions yet.',
              message:
                  'Subscribe to a ticker when you want the deterioration engine to stay in your routine.',
            )
          else
            ...tickers.map(
              (ticker) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _AlertSubscriptionRow(
                  ticker: ticker,
                  stock: stockMap[ticker],
                  alert: alertMap[ticker],
                  onOpenStock: onOpenStock,
                  onToggleAlertSubscription: onToggleAlertSubscription,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _RecentActionsCard extends StatelessWidget {
  const _RecentActionsCard({required this.actions});

  final List<WorkflowActionRecord> actions;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Recent actions',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 14),
          if (actions.isEmpty)
            const EmptyStateCard(
              icon: Icons.history_toggle_off_rounded,
              title: 'No actions yet.',
              message:
                  'As you star, save, subscribe, and open names, the app will keep a short local action trail here.',
            )
          else
            ...actions
                .take(12)
                .map(
                  (action) => Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.03),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.08),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${action.ticker} | ${action.type.label}',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            formatAsOf(action.occurredAt),
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: AppTheme.sky),
                          ),
                          if (action.note != null) ...[
                            const SizedBox(height: 6),
                            Text(
                              action.note!,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
        ],
      ),
    );
  }
}

class _TickerRow extends StatelessWidget {
  const _TickerRow({
    required this.ticker,
    required this.stock,
    required this.onOpenStock,
    required this.onPrimaryAction,
    required this.primaryIcon,
    required this.primaryLabel,
  });

  final String ticker;
  final StockInsight? stock;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onPrimaryAction;
  final IconData primaryIcon;
  final String primaryLabel;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  stock == null ? ticker : '$ticker | ${stock!.company}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (stock != null) ActionBadge(action: stock!.action),
            ],
          ),
          if (stock != null) ...[
            const SizedBox(height: 8),
            Text(
              'Opportunity ${stock!.opportunityScore.round()} | Confidence ${stock!.confidenceScore.round()}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton.tonal(
                onPressed: stock == null ? null : () => onOpenStock(ticker),
                child: const Text('Open'),
              ),
              const SizedBox(width: 10),
              FilledButton.tonalIcon(
                onPressed: () => onPrimaryAction(ticker),
                icon: Icon(primaryIcon),
                label: Text(primaryLabel),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AlertSubscriptionRow extends StatelessWidget {
  const _AlertSubscriptionRow({
    required this.ticker,
    required this.stock,
    required this.alert,
    required this.onOpenStock,
    required this.onToggleAlertSubscription,
  });

  final String ticker;
  final StockInsight? stock;
  final SellAlert? alert;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  stock == null ? ticker : '$ticker | ${stock!.company}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (alert != null) SeverityBadge(severity: alert!.severity),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            alert?.summary ??
                'No active sell alert right now. The subscription keeps this ticker in your alert workflow.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton.tonal(
                onPressed: stock == null ? null : () => onOpenStock(ticker),
                child: const Text('Open'),
              ),
              const SizedBox(width: 10),
              FilledButton.tonalIcon(
                onPressed: () => onToggleAlertSubscription(ticker),
                icon: const Icon(Icons.notifications_off_rounded),
                label: const Text('Remove'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

const _workflowGuideEntries = [
  GuideEntry(
    term: 'Watchlist',
    definition:
        'The names you want to actively revisit, even if they are not the best-ranked ideas right this minute.',
  ),
  GuideEntry(
    term: 'Saved ideas',
    definition:
        'A bookmark layer for setups worth keeping around as part of your research stack.',
  ),
  GuideEntry(
    term: 'Alert subscription',
    definition:
        'A local reminder that a ticker should stay inside the sell-discipline workflow even when it is quiet.',
  ),
  GuideEntry(
    term: 'Action history',
    definition:
        'A short local audit trail of what you changed in the app, so your workflow is easier to review later.',
  ),
];
