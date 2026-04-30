import 'package:flutter/material.dart';

import '../../engine/daily_decision_brief_engine.dart';
import '../../engine/portfolio_decision_engine.dart';
import '../../models/market_intelligence.dart';
import '../../models/recommendation_ledger_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class DailyDecisionBriefView extends StatelessWidget {
  const DailyDecisionBriefView({
    super.key,
    required this.snapshot,
    required this.report,
    required this.ledger,
    required this.onOpenStock,
  });

  final MarketIntelligenceSnapshot snapshot;
  final PortfolioDecisionReport report;
  final RecommendationLedger ledger;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final brief = const DailyDecisionBriefEngine().build(
      snapshot: snapshot,
      report: report,
      ledger: ledger,
    );

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final isCompact = constraints.maxWidth < 720;
          final sectionWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 2,
            minWidth: 340,
          );
          final metricWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 4,
            minWidth: 230,
          );

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ViewHeader(
                eyebrow: 'Daily Brief',
                title: brief.headline,
                subtitle: brief.summary,
                trailing: isCompact
                    ? null
                    : TonePill(
                        label: 'As of ${formatAsOf(brief.asOf)}',
                        tone: brief.postureTone,
                      ),
              ),
              if (isCompact) ...[
                TonePill(
                  label: 'As of ${formatAsOf(brief.asOf)}',
                  tone: brief.postureTone,
                ),
                const SizedBox(height: 18),
              ],
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: metricWidth,
                    child: MetricTile(
                      label: 'Buy',
                      value: '${brief.buyCount}',
                      detail:
                          'Names with the best current mix of opportunity, regime fit, confidence, and controlled risk.',
                      tone: brief.buyCount > 0
                          ? SignalTone.positive
                          : SignalTone.neutral,
                    ),
                  ),
                  SizedBox(
                    width: metricWidth,
                    child: MetricTile(
                      label: 'Hold / watch',
                      value: '${brief.holdCount + brief.watchCount}',
                      detail:
                          'Names where the evidence is intact or interesting but not clean enough for a fresh buy.',
                      tone: SignalTone.neutral,
                    ),
                  ),
                  SizedBox(
                    width: metricWidth,
                    child: MetricTile(
                      label: 'Trim / sell',
                      value: '${brief.riskControlCount}',
                      detail:
                          'Stocks where deterioration, risk, or alert pressure deserves capital-protection review.',
                      tone: brief.riskControlCount > 0
                          ? SignalTone.caution
                          : SignalTone.neutral,
                    ),
                  ),
                  SizedBox(
                    width: metricWidth,
                    child: MetricTile(
                      label: 'Changed',
                      value: '${brief.changes.length}',
                      detail:
                          'Action, opportunity, or confidence changes since the prior recommendation snapshot.',
                      tone: brief.changes.isEmpty
                          ? SignalTone.neutral
                          : SignalTone.caution,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              _PriorityCard(brief: brief, onOpenStock: onOpenStock),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: _ActionSection(
                      title: 'Buy',
                      icon: Icons.trending_up_rounded,
                      items: brief.buyIdeas,
                      emptyTitle: 'No buy candidates cleared the bar.',
                      emptyMessage:
                          'The app is waiting for cleaner upside, better regime fit, or lower fragility before raising fresh-buy ideas.',
                      onOpenStock: onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _ActionSection(
                      title: 'Hold',
                      icon: Icons.pause_circle_outline_rounded,
                      items: brief.holdFocus,
                      emptyTitle: 'No hold candidates yet.',
                      emptyMessage:
                          'Import holdings to separate true holds from general watchlist names.',
                      onOpenStock: onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _ActionSection(
                      title: 'Sell / trim',
                      icon: Icons.shield_outlined,
                      items: brief.sellFocus,
                      emptyTitle: 'No trim or sell reviews right now.',
                      emptyMessage:
                          'Risk-control names will appear when thesis damage, fragility, or sell-alert clusters rise.',
                      onOpenStock: onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _ChangedSignalsCard(
                      changes: brief.changes,
                      onOpenStock: onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _BriefListCard(
                      title: 'Today',
                      icon: Icons.checklist_rounded,
                      items: brief.agenda,
                      accent: AppTheme.mint,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _BriefListCard(
                      title: 'Risk',
                      icon: Icons.report_problem_outlined,
                      items: brief.riskWarnings,
                      emptyLabel: 'No major warnings in the current brief.',
                      accent: AppTheme.amber,
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

class _PriorityCard extends StatelessWidget {
  const _PriorityCard({required this.brief, required this.onOpenStock});

  final DailyDecisionBrief brief;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionHeader(
            icon: Icons.bolt_rounded,
            title: 'First pass',
            trailing: TonePill(
              label: '${brief.priorityActions.length} actions',
              tone: brief.postureTone,
            ),
          ),
          const SizedBox(height: 14),
          if (brief.priorityActions.isEmpty)
            Text(
              'No priority actions yet. Refresh market data or import holdings to sharpen the decision layer.',
              style: Theme.of(context).textTheme.bodyMedium,
            )
          else
            ...brief.priorityActions.map(
              (item) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _ActionRow(item: item, onOpenStock: onOpenStock),
              ),
            ),
        ],
      ),
    );
  }
}

class _ActionSection extends StatelessWidget {
  const _ActionSection({
    required this.title,
    required this.icon,
    required this.items,
    required this.emptyTitle,
    required this.emptyMessage,
    required this.onOpenStock,
  });

  final String title;
  final IconData icon;
  final List<DailyBriefAction> items;
  final String emptyTitle;
  final String emptyMessage;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return EmptyStateCard(
        icon: icon,
        title: emptyTitle,
        message: emptyMessage,
      );
    }

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionHeader(
            icon: icon,
            title: title,
            trailing: TonePill(
              label: '${items.length}',
              tone: items.any((item) => item.tone == SignalTone.negative)
                  ? SignalTone.negative
                  : items.any((item) => item.tone == SignalTone.positive)
                  ? SignalTone.positive
                  : SignalTone.neutral,
            ),
          ),
          const SizedBox(height: 14),
          ...items.map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _ActionRow(item: item, onOpenStock: onOpenStock),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.item, required this.onOpenStock});

  final DailyBriefAction item;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = toneColor(item.tone);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => onOpenStock(item.stock.ticker),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.035),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: color.withValues(alpha: 0.18)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _TickerIcon(
                    ticker: item.stock.ticker,
                    icon: _actionIcon(item.action),
                    color: color,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item.title, style: theme.textTheme.titleLarge),
                        const SizedBox(height: 4),
                        Text(
                          '${item.stock.company} | ${item.stock.sector}',
                          style: theme.textTheme.bodySmall,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  _ScoreChip(score: item.score, color: color),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  TonePill(label: item.action.label, tone: item.tone),
                  TonePill(label: item.source, tone: SignalTone.neutral),
                  DecisionTrustBadge(trust: item.stock.decisionTrust),
                ],
              ),
              const SizedBox(height: 12),
              Text(item.narrative, style: theme.textTheme.bodyMedium),
              if (item.reasons.isNotEmpty) ...[
                const SizedBox(height: 12),
                BulletList(items: item.reasons.take(3).toList(), accent: color),
              ],
              const SizedBox(height: 10),
              _ForecastStrip(stock: item.stock),
              const SizedBox(height: 10),
              Text(
                item.nextCheck,
                style: theme.textTheme.bodySmall?.copyWith(color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ChangedSignalsCard extends StatelessWidget {
  const _ChangedSignalsCard({required this.changes, required this.onOpenStock});

  final List<DailyBriefChange> changes;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    if (changes.isEmpty) {
      return const EmptyStateCard(
        icon: Icons.compare_arrows_rounded,
        title: 'No major signal changes.',
        message:
            'The latest recommendation snapshot did not cross action or score-change thresholds.',
      );
    }

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionHeader(
            icon: Icons.compare_arrows_rounded,
            title: 'Changed signals',
          ),
          const SizedBox(height: 14),
          ...changes.map(
            (change) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _ChangeRow(change: change, onOpenStock: onOpenStock),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChangeRow extends StatelessWidget {
  const _ChangeRow({required this.change, required this.onOpenStock});

  final DailyBriefChange change;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final color = toneColor(change.tone);
    final theme = Theme.of(context);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => onOpenStock(change.stock.ticker),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.035),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: color.withValues(alpha: 0.18)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  _TickerIcon(
                    ticker: change.stock.ticker,
                    icon: Icons.trending_flat_rounded,
                    color: color,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      change.stock.company,
                      style: theme.textTheme.titleMedium,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ActionBadge(action: change.previousAction),
                  const Icon(
                    Icons.arrow_forward_rounded,
                    size: 18,
                    color: AppTheme.textMuted,
                  ),
                  ActionBadge(action: change.currentAction),
                ],
              ),
              const SizedBox(height: 10),
              Text(change.summary, style: theme.textTheme.bodyMedium),
            ],
          ),
        ),
      ),
    );
  }
}

class _BriefListCard extends StatelessWidget {
  const _BriefListCard({
    required this.title,
    required this.icon,
    required this.items,
    required this.accent,
    this.emptyLabel = 'No items.',
  });

  final String title;
  final IconData icon;
  final List<String> items;
  final Color accent;
  final String emptyLabel;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionHeader(icon: icon, title: title),
          const SizedBox(height: 14),
          BulletList(items: items, emptyLabel: emptyLabel, accent: accent),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.title,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: AppTheme.mint, size: 22),
        const SizedBox(width: 10),
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.headlineMedium),
        ),
        if (trailing != null) ...[const SizedBox(width: 10), trailing!],
      ],
    );
  }
}

class _TickerIcon extends StatelessWidget {
  const _TickerIcon({
    required this.ticker,
    required this.icon,
    required this.color,
  });

  final String ticker;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 58,
      height: 58,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: color, size: 18),
          const SizedBox(height: 3),
          Text(
            ticker,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
              color: color,
              fontSize: ticker.length > 4 ? 11 : 12,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class _ScoreChip extends StatelessWidget {
  const _ScoreChip({required this.score, required this.color});

  final double score;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 58,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Column(
        children: [
          Text(
            score.round().toString(),
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(color: color, fontSize: 17),
          ),
          Text(
            'score',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: color.withValues(alpha: 0.82),
              fontSize: 10,
            ),
          ),
        ],
      ),
    );
  }
}

class _ForecastStrip extends StatelessWidget {
  const _ForecastStrip({required this.stock});

  final StockInsight stock;

  @override
  Widget build(BuildContext context) {
    final forecasts = stock.forecasts;
    if (forecasts.isEmpty) {
      return Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _MiniStat(
            label: 'Opportunity',
            value: stock.opportunityScore.round().toString(),
          ),
          _MiniStat(
            label: 'Fragility',
            value: stock.fragilityScore.round().toString(),
          ),
          _MiniStat(label: 'Risk', value: stock.riskScore.round().toString()),
        ],
      );
    }

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _MiniStat(
          label: 'Outperform',
          value: _formatProbability(forecasts.outperformSectorProbability),
        ),
        _MiniStat(
          label: '20d p50',
          value: _formatSignedPercent(forecasts.forwardReturn20d.p50),
        ),
        _MiniStat(
          label: 'Drawdown',
          value: _formatProbability(forecasts.drawdownOver8pctProbability),
        ),
      ],
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(width: 6),
          Text(value, style: Theme.of(context).textTheme.labelLarge),
        ],
      ),
    );
  }
}

IconData _actionIcon(PortfolioDecisionAction action) {
  return switch (action) {
    PortfolioDecisionAction.buy => Icons.trending_up_rounded,
    PortfolioDecisionAction.hold => Icons.pause_circle_outline_rounded,
    PortfolioDecisionAction.watch => Icons.visibility_outlined,
    PortfolioDecisionAction.trim => Icons.shield_outlined,
    PortfolioDecisionAction.sell => Icons.logout_rounded,
  };
}

String _formatProbability(double value) {
  final percent = value <= 1 ? value * 100 : value;
  return '${percent.round()}%';
}

String _formatSignedPercent(double value) {
  final prefix = value > 0 ? '+' : '';
  return '$prefix${value.toStringAsFixed(1)}%';
}
