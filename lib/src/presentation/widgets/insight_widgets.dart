import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';

class ViewHeader extends StatelessWidget {
  const ViewHeader({
    super.key,
    required this.eyebrow,
    required this.title,
    required this.subtitle,
    this.trailing,
  });

  final String eyebrow;
  final String title;
  final String subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  eyebrow.toUpperCase(),
                  style: theme.textTheme.labelLarge?.copyWith(
                    letterSpacing: 1.4,
                    color: AppTheme.mint,
                  ),
                ),
                const SizedBox(height: 8),
                Text(title, style: theme.textTheme.headlineLarge),
                const SizedBox(height: 8),
                Text(subtitle, style: theme.textTheme.bodyLarge),
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 16), trailing!],
        ],
      ),
    );
  }
}

class InsightCard extends StatelessWidget {
  const InsightCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: LinearGradient(
          colors: [
            AppTheme.surface.withValues(alpha: 0.96),
            AppTheme.surfaceAlt.withValues(alpha: 0.92),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 18,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Padding(padding: padding, child: child),
    );
  }
}

class TonePill extends StatelessWidget {
  const TonePill({super.key, required this.label, required this.tone});

  final String label;
  final SignalTone tone;

  @override
  Widget build(BuildContext context) {
    final color = toneColor(tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(color: color),
      ),
    );
  }
}

class ActionBadge extends StatelessWidget {
  const ActionBadge({super.key, required this.action});

  final RecommendationAction action;

  @override
  Widget build(BuildContext context) {
    final color = actionColor(action);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(actionIcon(action), size: 14, color: color),
          const SizedBox(width: 6),
          Text(
            action.label,
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}

class SeverityBadge extends StatelessWidget {
  const SeverityBadge({super.key, required this.severity});

  final AlertSeverity severity;

  @override
  Widget build(BuildContext context) {
    final color = severityColor(severity);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Text(
        severity.label,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(color: color),
      ),
    );
  }
}

class MetricTile extends StatelessWidget {
  const MetricTile({
    super.key,
    required this.label,
    required this.value,
    required this.detail,
    required this.tone,
  });

  final String label;
  final String value;
  final String detail;
  final SignalTone tone;

  @override
  Widget build(BuildContext context) {
    final color = toneColor(tone);
    return InsightCard(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TonePill(label: label, tone: tone),
          const SizedBox(height: 18),
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.displayMedium?.copyWith(fontSize: 34, color: color),
          ),
          const SizedBox(height: 10),
          Text(detail, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}

class ScoreBar extends StatelessWidget {
  const ScoreBar({
    super.key,
    required this.label,
    required this.value,
    this.detail,
    this.color,
  });

  final String label;
  final double value;
  final String? detail;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final barColor = color ?? AppTheme.mint;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text(label, style: theme.textTheme.titleMedium)),
            Text(
              value.round().toString(),
              style: theme.textTheme.titleMedium?.copyWith(color: barColor),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: value / 100,
            minHeight: 10,
            backgroundColor: Colors.white.withValues(alpha: 0.08),
            valueColor: AlwaysStoppedAnimation<Color>(barColor),
          ),
        ),
        if (detail != null) ...[
          const SizedBox(height: 8),
          Text(detail!, style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}

class BulletList extends StatelessWidget {
  const BulletList({
    super.key,
    required this.items,
    this.emptyLabel = 'No items',
    this.accent = AppTheme.mint,
  });

  final List<String> items;
  final String emptyLabel;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (items.isEmpty) {
      return Text(emptyLabel, style: theme.textTheme.bodyMedium);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 7),
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: accent,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(item, style: theme.textTheme.bodyMedium),
                  ),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}

class LabelValueRow extends StatelessWidget {
  const LabelValueRow({
    super.key,
    required this.label,
    required this.value,
    this.highlight = AppTheme.textPrimary,
  });

  final String label;
  final String value;
  final Color highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(child: Text(label, style: theme.textTheme.bodyMedium)),
          Text(
            value,
            style: theme.textTheme.titleMedium?.copyWith(color: highlight),
          ),
        ],
      ),
    );
  }
}

Color toneColor(SignalTone tone) => switch (tone) {
  SignalTone.positive => AppTheme.mint,
  SignalTone.caution => AppTheme.amber,
  SignalTone.negative => AppTheme.coral,
  SignalTone.neutral => AppTheme.sky,
};

Color actionColor(RecommendationAction action) => switch (action) {
  RecommendationAction.buy => AppTheme.mint,
  RecommendationAction.accumulate => AppTheme.sky,
  RecommendationAction.hold => AppTheme.amber,
  RecommendationAction.watch => Colors.white70,
  RecommendationAction.trim => AppTheme.amber,
  RecommendationAction.deRisk => const Color(0xFFFFA05F),
  RecommendationAction.exit => AppTheme.coral,
  RecommendationAction.avoidForNow => AppTheme.coral,
};

IconData actionIcon(RecommendationAction action) => switch (action) {
  RecommendationAction.buy => Icons.trending_up_rounded,
  RecommendationAction.accumulate => Icons.add_chart_rounded,
  RecommendationAction.hold => Icons.horizontal_rule_rounded,
  RecommendationAction.watch => Icons.visibility_outlined,
  RecommendationAction.trim => Icons.content_cut_rounded,
  RecommendationAction.deRisk => Icons.shield_outlined,
  RecommendationAction.exit => Icons.logout_rounded,
  RecommendationAction.avoidForNow => Icons.block_rounded,
};

Color severityColor(AlertSeverity severity) => switch (severity) {
  AlertSeverity.low => AppTheme.sky,
  AlertSeverity.moderate => AppTheme.amber,
  AlertSeverity.high => const Color(0xFFFFA05F),
  AlertSeverity.critical => AppTheme.coral,
};

int adaptiveColumns(
  double maxWidth, {
  int maxColumns = 3,
  double minWidth = 280,
  double spacing = 16,
}) {
  final raw = ((maxWidth + spacing) / (minWidth + spacing)).floor();
  return math.max(1, math.min(maxColumns, raw));
}

double adaptivePanelWidth(
  double maxWidth, {
  int maxColumns = 3,
  double minWidth = 280,
  double spacing = 16,
}) {
  final columns = adaptiveColumns(
    maxWidth,
    maxColumns: maxColumns,
    minWidth: minWidth,
    spacing: spacing,
  );
  final totalSpacing = spacing * (columns - 1);
  return (maxWidth - totalSpacing) / columns;
}

String formatAsOf(DateTime value) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final month = months[value.month - 1];
  final hour = value.hour == 0
      ? 12
      : value.hour > 12
      ? value.hour - 12
      : value.hour;
  final minute = value.minute.toString().padLeft(2, '0');
  final period = value.hour >= 12 ? 'PM' : 'AM';
  return '$month ${value.day}, ${value.year} | $hour:$minute $period';
}
