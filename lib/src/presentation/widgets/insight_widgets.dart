import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';

class GuideEntry {
  const GuideEntry({required this.term, required this.definition});

  final String term;
  final String definition;
}

class CalculationEntry {
  const CalculationEntry({
    required this.title,
    required this.summary,
    required this.drivers,
    required this.interpretation,
  });

  final String title;
  final String summary;
  final List<String> drivers;
  final String interpretation;
}

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

class PlainEnglishGuideCard extends StatelessWidget {
  const PlainEnglishGuideCard({
    super.key,
    required this.summary,
    required this.entries,
  });

  final String summary;
  final List<GuideEntry> entries;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: EdgeInsets.zero,
          leading: const Icon(Icons.menu_book_rounded, color: AppTheme.sky),
          title: Text(
            'Plain-English guide',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(summary, style: Theme.of(context).textTheme.bodyMedium),
          ),
          children: [
            const SizedBox(height: 12),
            ...entries.map(
              (entry) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _GuideEntryCard(entry: entry),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class HowThisIsCalculatedCard extends StatelessWidget {
  const HowThisIsCalculatedCard({
    super.key,
    required this.summary,
    required this.entries,
  });

  final String summary;
  final List<CalculationEntry> entries;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: EdgeInsets.zero,
          leading: const Icon(Icons.functions_rounded, color: AppTheme.amber),
          title: Text(
            'How this is calculated',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(summary, style: Theme.of(context).textTheme.bodyMedium),
          ),
          children: [
            const SizedBox(height: 12),
            ...entries.map(
              (entry) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _CalculationEntryCard(entry: entry),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CalculationEntryCard extends StatelessWidget {
  const _CalculationEntryCard({required this.entry});

  final CalculationEntry entry;

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
          Text(entry.title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(entry.summary, style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 10),
          Text(
            'Built from',
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(color: AppTheme.sky),
          ),
          const SizedBox(height: 6),
          BulletList(items: entry.drivers, accent: AppTheme.sky),
          const SizedBox(height: 10),
          Text(
            'How to read it',
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(color: AppTheme.amber),
          ),
          const SizedBox(height: 6),
          Text(
            entry.interpretation,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _GuideEntryCard extends StatelessWidget {
  const _GuideEntryCard({required this.entry});

  final GuideEntry entry;

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
          Text(entry.term, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(entry.definition, style: Theme.of(context).textTheme.bodyMedium),
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

class EmptyStateCard extends StatelessWidget {
  const EmptyStateCard({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: AppTheme.sky.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: AppTheme.sky.withValues(alpha: 0.28)),
            ),
            child: Icon(icon, color: AppTheme.sky),
          ),
          const SizedBox(height: 18),
          Text(title, style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 10),
          Text(message, style: Theme.of(context).textTheme.bodyLarge),
        ],
      ),
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

class DecisionTrustBadge extends StatelessWidget {
  const DecisionTrustBadge({super.key, required this.trust});

  final DecisionTrustReport trust;

  @override
  Widget build(BuildContext context) {
    final color = decisionTrustColor(trust.level);
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
          Icon(decisionTrustIcon(trust.level), size: 14, color: color),
          const SizedBox(width: 6),
          Text(
            trust.level.label,
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}

class DecisionTrustCard extends StatelessWidget {
  const DecisionTrustCard({super.key, required this.trust});

  final DecisionTrustReport trust;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = decisionTrustColor(trust.level);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(decisionTrustIcon(trust.level), color: color, size: 22),
              const SizedBox(width: 8),
              Text('Decision trust', style: theme.textTheme.headlineMedium),
              const Spacer(),
              DecisionTrustBadge(trust: trust),
            ],
          ),
          const SizedBox(height: 10),
          Text(trust.summary, style: theme.textTheme.bodyMedium),
          if (trust.actionWasGated) ...[
            const SizedBox(height: 10),
            Text(
              'Raw action: ${trust.originalAction!.label} | gated action: ${trust.gatedAction!.label}',
              style: theme.textTheme.bodySmall?.copyWith(color: color),
            ),
          ],
          const SizedBox(height: 14),
          ...trust.components.map(
            (component) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _ProvenanceComponentRow(component: component),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProvenanceComponentRow extends StatelessWidget {
  const _ProvenanceComponentRow({required this.component});

  final SignalProvenanceComponent component;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = signalProvenanceColor(component.provenance);
    return Container(
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
              Expanded(
                child: Text(component.label, style: theme.textTheme.titleSmall),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  component.provenance.label,
                  style: theme.textTheme.labelSmall?.copyWith(color: color),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(component.detail, style: theme.textTheme.bodySmall),
        ],
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
    this.definition,
    this.trend,
  });

  final String label;
  final String value;
  final String detail;
  final SignalTone tone;
  final String? definition;
  final MetricTrend? trend;

  @override
  Widget build(BuildContext context) {
    final color = toneColor(tone);
    return InsightCard(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: TonePill(label: label, tone: tone),
                ),
              ),
              if (definition != null) ...[
                const SizedBox(width: 8),
                DefinitionInfoButton(title: label, definition: definition!),
              ],
            ],
          ),
          const SizedBox(height: 18),
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.displayMedium?.copyWith(fontSize: 34, color: color),
          ),
          if (trend != null) ...[
            const SizedBox(height: 12),
            _MetricTrendLegend(trend: trend!),
            const SizedBox(height: 10),
            SizedBox(
              height: 84,
              width: double.infinity,
              child: _MetricTrendChart(trend: trend!, lineColor: color),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 10,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  '${trend!.lookbackCount} / 60 points in the rolling window',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                _HistoryProvenancePill(provenance: trend!.provenance),
              ],
            ),
          ],
          const SizedBox(height: 10),
          Text(detail, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}

class _MetricTrendLegend extends StatelessWidget {
  const _MetricTrendLegend({required this.trend});

  final MetricTrend trend;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 10,
      runSpacing: 6,
      children: [
        _TrendLabel(label: 'Trend', color: Colors.white70),
        _TrendLabel(
          label: '60 mean ${trend.mean60.toStringAsFixed(1)}',
          color: AppTheme.mint,
        ),
        _TrendLabel(
          label: '60 median ${trend.median60.toStringAsFixed(1)}',
          color: AppTheme.amber,
        ),
      ],
    );
  }
}

class _TrendLabel extends StatelessWidget {
  const _TrendLabel({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 14,
          height: 2,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(999),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: color),
        ),
      ],
    );
  }
}

class _HistoryProvenancePill extends StatelessWidget {
  const _HistoryProvenancePill({required this.provenance});

  final HistoryProvenance provenance;

  @override
  Widget build(BuildContext context) {
    final color = switch (provenance) {
      HistoryProvenance.live => AppTheme.mint,
      HistoryProvenance.archived => AppTheme.sky,
      HistoryProvenance.researchReplay => AppTheme.amber,
      HistoryProvenance.mixed => AppTheme.coral,
      HistoryProvenance.missing => Colors.white38,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Text(
        provenance.label,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(color: color),
      ),
    );
  }
}

class _MetricTrendChart extends StatelessWidget {
  const _MetricTrendChart({required this.trend, required this.lineColor});

  final MetricTrend trend;
  final Color lineColor;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _MetricTrendPainter(trend: trend, lineColor: lineColor),
    );
  }
}

class _MetricTrendPainter extends CustomPainter {
  const _MetricTrendPainter({required this.trend, required this.lineColor});

  final MetricTrend trend;
  final Color lineColor;

  @override
  void paint(Canvas canvas, Size size) {
    final values = [
      ...trend.points.map((point) => point.value),
      trend.mean60,
      trend.median60,
    ];
    if (values.isEmpty) {
      return;
    }

    var minValue = values.reduce(math.min);
    var maxValue = values.reduce(math.max);
    if (minValue == maxValue) {
      minValue -= 1;
      maxValue += 1;
    }
    final range = maxValue - minValue;

    final backgroundPaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.04)
      ..style = PaintingStyle.fill;
    final borderPaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.08)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final meanPaint = Paint()
      ..color = AppTheme.mint.withValues(alpha: 0.9)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final medianPaint = Paint()
      ..color = AppTheme.amber.withValues(alpha: 0.9)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final linePaint = Paint()
      ..color = lineColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final rect = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(14),
    );
    canvas.drawRRect(rect, backgroundPaint);
    canvas.drawRRect(rect, borderPaint);

    final chartLeft = 10.0;
    final chartRight = size.width - 10;
    final chartTop = 10.0;
    final chartBottom = size.height - 10;
    final chartWidth = chartRight - chartLeft;
    final chartHeight = chartBottom - chartTop;

    double yFor(double value) {
      final normalized = (value - minValue) / range;
      return chartBottom - (normalized * chartHeight);
    }

    final meanY = yFor(trend.mean60);
    final medianY = yFor(trend.median60);
    canvas.drawLine(
      Offset(chartLeft, meanY),
      Offset(chartRight, meanY),
      meanPaint,
    );
    canvas.drawLine(
      Offset(chartLeft, medianY),
      Offset(chartRight, medianY),
      medianPaint,
    );

    final points = trend.points;
    if (points.isEmpty) {
      return;
    }

    final path = Path();
    for (var index = 0; index < points.length; index++) {
      final dx = points.length == 1
          ? chartLeft + chartWidth / 2
          : chartLeft + (chartWidth * index / (points.length - 1));
      final dy = yFor(points[index].value);
      if (index == 0) {
        path.moveTo(dx, dy);
      } else {
        path.lineTo(dx, dy);
      }
    }
    canvas.drawPath(path, linePaint);

    final lastPoint = points.last;
    final lastDx = points.length == 1 ? chartLeft + chartWidth / 2 : chartRight;
    final lastDy = yFor(lastPoint.value);
    final dotPaint = Paint()..color = lineColor;
    canvas.drawCircle(Offset(lastDx, lastDy), 3.5, dotPaint);
  }

  @override
  bool shouldRepaint(covariant _MetricTrendPainter oldDelegate) {
    return oldDelegate.trend != trend || oldDelegate.lineColor != lineColor;
  }
}

class ScoreBar extends StatelessWidget {
  const ScoreBar({
    super.key,
    required this.label,
    required this.value,
    this.detail,
    this.color,
    this.definition,
  });

  final String label;
  final double value;
  final String? detail;
  final Color? color;
  final String? definition;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final barColor = color ?? AppTheme.mint;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(label, style: theme.textTheme.titleMedium),
                  ),
                  if (definition != null) ...[
                    const SizedBox(width: 6),
                    DefinitionInfoButton(title: label, definition: definition!),
                  ],
                ],
              ),
            ),
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
    this.definition,
  });

  final String label;
  final String value;
  final Color highlight;
  final String? definition;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Flexible(child: Text(label, style: theme.textTheme.bodyMedium)),
                if (definition != null) ...[
                  const SizedBox(width: 6),
                  DefinitionInfoButton(title: label, definition: definition!),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: theme.textTheme.titleMedium?.copyWith(color: highlight),
            ),
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

Color decisionTrustColor(DecisionTrustLevel level) => switch (level) {
  DecisionTrustLevel.actionable => AppTheme.mint,
  DecisionTrustLevel.researchOnly => AppTheme.amber,
  DecisionTrustLevel.insufficientData => AppTheme.coral,
};

IconData decisionTrustIcon(DecisionTrustLevel level) => switch (level) {
  DecisionTrustLevel.actionable => Icons.verified_rounded,
  DecisionTrustLevel.researchOnly => Icons.manage_search_rounded,
  DecisionTrustLevel.insufficientData => Icons.report_problem_outlined,
};

Color signalProvenanceColor(SignalProvenance provenance) =>
    switch (provenance) {
      SignalProvenance.live => AppTheme.mint,
      SignalProvenance.cached => AppTheme.sky,
      SignalProvenance.derived => AppTheme.amber,
      SignalProvenance.fixture => const Color(0xFFFFA05F),
      SignalProvenance.missing => AppTheme.coral,
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

class DefinitionInfoButton extends StatelessWidget {
  const DefinitionInfoButton({
    super.key,
    required this.title,
    required this.definition,
  });

  final String title;
  final String definition;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Explain $title',
      child: IconButton(
        onPressed: () => _showDefinitionSheet(context),
        icon: const Icon(Icons.help_outline_rounded, size: 18),
        color: AppTheme.sky,
        visualDensity: VisualDensity.compact,
        splashRadius: 18,
      ),
    );
  }

  Future<void> _showDefinitionSheet(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: AppTheme.surface,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 12),
              Text(definition, style: Theme.of(context).textTheme.bodyLarge),
            ],
          ),
        ),
      ),
    );
  }
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
