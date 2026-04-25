import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import 'insight_widgets.dart';

/// Shows probabilistic forecasts for a single stock — explicit probabilities +
/// forward-return band.
class ProbabilityForecastCard extends StatelessWidget {
  const ProbabilityForecastCard({super.key, required this.forecasts});

  final ForecastPack forecasts;

  @override
  Widget build(BuildContext context) {
    if (forecasts.isEmpty) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.insights_outlined, color: AppTheme.sky, size: 22),
              const SizedBox(width: 8),
              Text(
                'Probabilistic forecast',
                style: theme.textTheme.headlineMedium,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Not a point prediction — a band of outcomes and their probabilities, updated with the snapshot.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          _ProbabilityRow(
            label: 'Outperform sector (20d)',
            probability: forecasts.outperformSectorProbability,
            positive: true,
          ),
          _ProbabilityRow(
            label: 'Drawdown > 8% (20d)',
            probability: forecasts.drawdownOver8pctProbability,
            positive: false,
          ),
          _ProbabilityRow(
            label: 'Earnings gap > implied move',
            probability: forecasts.earningsGapExceedsImpliedProbability,
            positive: false,
          ),
          _ProbabilityRow(
            label: 'Leadership rotation away',
            probability: forecasts.leadershipRotationProbability,
            positive: false,
          ),
          _ProbabilityRow(
            label: 'Breakout persistence',
            probability: forecasts.breakoutPersistenceProbability,
            positive: true,
          ),
          const SizedBox(height: 18),
          Text('Forward return band', style: theme.textTheme.titleLarge),
          const SizedBox(height: 10),
          _DistributionBar(
            label: '20d',
            distribution: forecasts.forwardReturn20d,
          ),
          const SizedBox(height: 10),
          _DistributionBar(
            label: '60d',
            distribution: forecasts.forwardReturn60d,
          ),
        ],
      ),
    );
  }
}

class _ProbabilityRow extends StatelessWidget {
  const _ProbabilityRow({
    required this.label,
    required this.probability,
    required this.positive,
  });

  final String label;
  final double probability;
  final bool positive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final fill = (probability / 100).clamp(0.0, 1.0);
    final tone = positive
        ? (probability >= 60
            ? SignalTone.positive
            : probability >= 40
                ? SignalTone.neutral
                : SignalTone.caution)
        : (probability >= 55
            ? SignalTone.caution
            : probability >= 35
                ? SignalTone.neutral
                : SignalTone.positive);
    final color = _toneColor(tone);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(label, style: theme.textTheme.bodyMedium),
              ),
              Text(
                '${probability.toStringAsFixed(0)}%',
                style: theme.textTheme.titleMedium?.copyWith(color: color),
              ),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              value: fill,
              minHeight: 6,
              backgroundColor: Colors.white.withValues(alpha: 0.08),
              valueColor: AlwaysStoppedAnimation(color),
            ),
          ),
        ],
      ),
    );
  }
}

class _DistributionBar extends StatelessWidget {
  const _DistributionBar({
    required this.label,
    required this.distribution,
  });

  final String label;
  final ProbabilityDistribution distribution;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(label, style: theme.textTheme.titleMedium),
            const SizedBox(width: 8),
            Text(
              'median ${_fmt(distribution.p50)}${distribution.unit}',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
        const SizedBox(height: 6),
        LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth;
            final minV = distribution.p10 - 2;
            final maxV = distribution.p90 + 2;
            final range = (maxV - minV).abs().clamp(0.5, 1e6);
            double posFor(double value) => ((value - minV) / range) * width;
            return Stack(
              children: [
                Container(
                  height: 14,
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
                Positioned(
                  left: posFor(distribution.p10),
                  width: posFor(distribution.p90) - posFor(distribution.p10),
                  child: Container(
                    height: 14,
                    decoration: BoxDecoration(
                      color: AppTheme.sky.withValues(alpha: 0.25),
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                ),
                Positioned(
                  left: posFor(distribution.p25),
                  width: posFor(distribution.p75) - posFor(distribution.p25),
                  child: Container(
                    height: 14,
                    decoration: BoxDecoration(
                      color: AppTheme.sky.withValues(alpha: 0.55),
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                ),
                Positioned(
                  left: posFor(distribution.p50) - 1.5,
                  child: Container(
                    width: 3,
                    height: 14,
                    color: Colors.white,
                  ),
                ),
              ],
            );
          },
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('p10 ${_fmt(distribution.p10)}${distribution.unit}',
                style: theme.textTheme.bodySmall),
            Text('p90 ${_fmt(distribution.p90)}${distribution.unit}',
                style: theme.textTheme.bodySmall),
          ],
        ),
      ],
    );
  }

  String _fmt(double v) => v >= 0
      ? '+${v.toStringAsFixed(1)}'
      : v.toStringAsFixed(1);
}

/// Confidence breakdown with multi-component bars + conflict flag.
class ConfidenceBreakdownCard extends StatelessWidget {
  const ConfidenceBreakdownCard({super.key, required this.breakdown});

  final ConfidenceBreakdown breakdown;

  @override
  Widget build(BuildContext context) {
    if (breakdown.components.isEmpty) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final conflictColor = breakdown.isConflicted
        ? AppTheme.amber
        : breakdown.tier == ConfidenceTier.high
            ? AppTheme.mint
            : AppTheme.sky;

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.gpp_good_outlined, color: conflictColor, size: 22),
              const SizedBox(width: 8),
              Text(
                'Confidence breakdown',
                style: theme.textTheme.headlineMedium,
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: conflictColor.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  breakdown.tier.label,
                  style: theme.textTheme.labelLarge?.copyWith(color: conflictColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(breakdown.summary, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 16),
          ...breakdown.components.map(
            (component) => _ConfidenceComponentRow(component: component),
          ),
          if (breakdown.conflictScore > 30) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.amber.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded,
                      color: AppTheme.amber, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Conflict score ${breakdown.conflictScore.toStringAsFixed(0)}%: supporting and opposing components are roughly balanced. Treat the headline score as uncertain.',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ConfidenceComponentRow extends StatelessWidget {
  const _ConfidenceComponentRow({required this.component});

  final ConfidenceComponent component;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tone = component.supporting ? AppTheme.mint : AppTheme.amber;
    final fill = (component.value / 100).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(component.label,
                    style: theme.textTheme.titleMedium),
              ),
              Text(
                'weight ${(component.weight * 100).round()}%',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(width: 8),
              Text(
                component.value.toStringAsFixed(0),
                style: theme.textTheme.titleMedium?.copyWith(color: tone),
              ),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              value: fill,
              minHeight: 5,
              backgroundColor: Colors.white.withValues(alpha: 0.06),
              valueColor: AlwaysStoppedAnimation(tone),
            ),
          ),
          if (component.rationale.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(component.rationale, style: theme.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// Counterfactual sensitivity table: "what happens if X moves by Y?"
class CounterfactualSensitivityCard extends StatelessWidget {
  const CounterfactualSensitivityCard({
    super.key,
    required this.counterfactuals,
  });

  final List<CounterfactualSensitivity> counterfactuals;

  @override
  Widget build(BuildContext context) {
    if (counterfactuals.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.rule_rounded, color: AppTheme.amber, size: 22),
              const SizedBox(width: 8),
              Text(
                'What-if sensitivity',
                style: theme.textTheme.headlineMedium,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'How the opportunity score and rank would move if one component shifted. Sorted by impact.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          ...counterfactuals.map(_buildRow),
        ],
      ),
    );
  }

  Widget _buildRow(CounterfactualSensitivity c) {
    return Builder(
      builder: (context) {
        final theme = Theme.of(context);
        final positive = c.deltaOpportunity >= 0;
        final color = positive ? AppTheme.mint : AppTheme.amber;
        final flip = c.flipAction != null
            ? ' → action flips to ${c.flipAction!.label}'
            : '';
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 48,
                padding: const EdgeInsets.symmetric(vertical: 4),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                alignment: Alignment.center,
                child: Text(
                  '${positive ? '+' : ''}${c.deltaOpportunity.toStringAsFixed(1)}',
                  style: theme.textTheme.titleMedium?.copyWith(color: color),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      c.component +
                          (c.deltaInput >= 0
                              ? ' +${c.deltaInput.abs().round()}'
                              : ' −${c.deltaInput.abs().round()}') +
                          flip,
                      style: theme.textTheme.titleSmall,
                    ),
                    const SizedBox(height: 2),
                    Text(c.narrative, style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Peer-contrast card: how this name stacks up vs. the sector median.
class PeerContrastCard extends StatelessWidget {
  const PeerContrastCard({super.key, required this.contrasts});

  final List<PeerContrast> contrasts;

  @override
  Widget build(BuildContext context) {
    if (contrasts.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.people_alt_outlined,
                  color: AppTheme.sky, size: 22),
              const SizedBox(width: 8),
              Text('Explain by contrast', style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Where this name is an edge or a drag vs. the sector median — not in the abstract.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          ...contrasts.map((c) => _ContrastRow(contrast: c)),
        ],
      ),
    );
  }
}

class _ContrastRow extends StatelessWidget {
  const _ContrastRow({required this.contrast});

  final PeerContrast contrast;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final gap = contrast.gap;
    final positive = gap > 0;
    final color = positive ? AppTheme.mint : AppTheme.amber;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(contrast.axis, style: theme.textTheme.titleMedium),
              ),
              Text(
                '#${contrast.rankInPeerGroup}/${contrast.totalPeers}',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(width: 8),
              Text(
                '${positive ? '+' : ''}${gap.toStringAsFixed(1)}',
                style: theme.textTheme.titleMedium?.copyWith(color: color),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(contrast.narrative, style: theme.textTheme.bodySmall),
          const SizedBox(height: 4),
          LayoutBuilder(
            builder: (context, c) {
              final width = c.maxWidth;
              final scale = (contrast.selfValue / 100).clamp(0.0, 1.0);
              final medianScale = (contrast.peerMedian / 100).clamp(0.0, 1.0);
              return SizedBox(
                height: 8,
                child: Stack(
                  children: [
                    Container(
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.06),
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    Container(
                      width: scale * width,
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: 0.55),
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    Positioned(
                      left: medianScale * width - 1,
                      child: Container(
                        width: 2,
                        height: 8,
                        color: Colors.white70,
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

/// Options depth card: term structure, gamma, flow, pinning.
class OptionsDepthCard extends StatelessWidget {
  const OptionsDepthCard({super.key, required this.signal});

  final OptionsSignal signal;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.show_chart, color: AppTheme.amber, size: 22),
              const SizedBox(width: 8),
              Text('Options depth', style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(signal.commentary, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          Text(signal.flowCommentary, style: theme.textTheme.bodySmall),
          const SizedBox(height: 14),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              _MetricChip(
                label: 'IV rank',
                value: '${signal.ivRank.round()}',
                tone: signal.ivRank >= 70
                    ? SignalTone.caution
                    : signal.ivRank <= 30
                        ? SignalTone.positive
                        : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Term structure',
                value: signal.termStructureSlope >= 0
                    ? '+${signal.termStructureSlope.toStringAsFixed(1)} contango'
                    : '${signal.termStructureSlope.toStringAsFixed(1)} backward.',
                tone: signal.isBackwardated
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Front/back skew',
                value:
                    '${signal.frontMonthSkew.round()} / ${signal.backMonthSkew.round()}',
                tone: signal.frontMonthSkew - signal.backMonthSkew > 10
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Gamma exposure',
                value: signal.gammaExposure.toStringAsFixed(0),
                tone: signal.dealerShort
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Pinning risk',
                value: '${signal.pinningRisk.round()}',
                tone: signal.isPinningLikely
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Unusual flow',
                value: '${signal.unusualFlowRatio.toStringAsFixed(2)}×',
                tone: signal.hasUnusualFlow
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Put/call',
                value: signal.putCallRatio.toStringAsFixed(2),
                tone: signal.putCallRatio > 1.2
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
              _MetricChip(
                label: 'Dealer pos.',
                value: signal.dealerPositioning.toStringAsFixed(0),
                tone: signal.dealerShort
                    ? SignalTone.caution
                    : SignalTone.neutral,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MetricChip extends StatelessWidget {
  const _MetricChip({
    required this.label,
    required this.value,
    required this.tone,
  });

  final String label;
  final String value;
  final SignalTone tone;

  @override
  Widget build(BuildContext context) {
    final color = _toneColor(tone);
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: theme.textTheme.labelSmall?.copyWith(color: color)),
          const SizedBox(height: 2),
          Text(value, style: theme.textTheme.titleMedium),
        ],
      ),
    );
  }
}

/// Regime transition panel — current regime distribution + what could flip it.
class RegimeTransitionCard extends StatelessWidget {
  const RegimeTransitionCard({
    super.key,
    required this.distribution,
    required this.transition,
    required this.stability,
  });

  final List<RegimeProbability> distribution;
  final RegimeTransition? transition;
  final double stability;

  @override
  Widget build(BuildContext context) {
    if (distribution.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final stabilityTone = stability >= 70
        ? SignalTone.positive
        : stability >= 50
            ? SignalTone.neutral
            : SignalTone.caution;
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.swap_horiz_rounded,
                  color: AppTheme.sky, size: 22),
              const SizedBox(width: 8),
              Text('Regime transition radar',
                  style: theme.textTheme.headlineMedium),
              const Spacer(),
              TonePill(
                label: 'Stability ${stability.round()}',
                tone: stabilityTone,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text('Probabilities across all regime classes — not just the winner.',
              style: theme.textTheme.bodyMedium),
          const SizedBox(height: 14),
          ...distribution.take(5).map(_buildProbRow),
          if (transition != null) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.amber.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Watch for a shift to ${transition!.toRegime.label}',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(color: AppTheme.amber),
                  ),
                  const SizedBox(height: 4),
                  Text(transition!.rationale, style: theme.textTheme.bodySmall),
                  const SizedBox(height: 8),
                  ...transition!.triggers.map(
                    (trigger) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('• ',
                              style: TextStyle(color: AppTheme.amber)),
                          Expanded(
                            child: Text(trigger,
                                style: theme.textTheme.bodySmall),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildProbRow(RegimeProbability prob) {
    return Builder(
      builder: (context) {
        final theme = Theme.of(context);
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            children: [
              Expanded(
                child: Text(prob.regime.label, style: theme.textTheme.bodyMedium),
              ),
              SizedBox(
                width: 120,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: LinearProgressIndicator(
                    value: (prob.probability / 100).clamp(0.0, 1.0),
                    minHeight: 6,
                    backgroundColor: Colors.white.withValues(alpha: 0.06),
                    valueColor: const AlwaysStoppedAnimation(AppTheme.sky),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 42,
                child: Text('${prob.probability.toStringAsFixed(0)}%',
                    style: theme.textTheme.titleSmall,
                    textAlign: TextAlign.right),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Sector breadth decomposition row list.
class BreadthDecompositionCard extends StatelessWidget {
  const BreadthDecompositionCard({super.key, required this.rows});

  final List<SectorBreadthRow> rows;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.stacked_bar_chart_rounded,
                  color: AppTheme.mint, size: 22),
              const SizedBox(width: 8),
              Text('Breadth decomposition',
                  style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Which sectors are pulling breadth up vs. which are dragging.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          ...rows.take(10).map(
            (row) => Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(row.sector, style: theme.textTheme.titleSmall),
                  ),
                  SizedBox(
                    width: 60,
                    child: Text(
                      'part ${row.participation.round()}',
                      style: theme.textTheme.bodySmall,
                      textAlign: TextAlign.right,
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 60,
                    child: Text(
                      'lead ${row.leadership.round()}',
                      style: theme.textTheme.bodySmall,
                      textAlign: TextAlign.right,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: _toneColor(row.tone).withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      row.divergence >= 0
                          ? 'div +${row.divergence.toStringAsFixed(1)}'
                          : 'div ${row.divergence.toStringAsFixed(1)}',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: _toneColor(row.tone)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Macro-gate indicator list used by sell alerts and stock insights.
class MacroGatesCard extends StatelessWidget {
  const MacroGatesCard({super.key, required this.gates});

  final List<MacroGate> gates;

  @override
  Widget build(BuildContext context) {
    if (gates.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.rule_folder_outlined,
                  color: AppTheme.sky, size: 22),
              const SizedBox(width: 8),
              Text('Macro gates', style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Rules that must hold for the action to apply. When a gate fails, the recommendation is softened instead of fired blindly.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          ...gates.map(
            (gate) => Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    gate.isSatisfied
                        ? Icons.check_circle_outline
                        : Icons.error_outline,
                    color: gate.isSatisfied ? AppTheme.mint : AppTheme.amber,
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(gate.label, style: theme.textTheme.titleSmall),
                        const SizedBox(height: 2),
                        Text(gate.rationale,
                            style: theme.textTheme.bodySmall),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Decayed-signal timeline for sell alerts — shows freshness per trigger.
class DecayedTriggersCard extends StatelessWidget {
  const DecayedTriggersCard({super.key, required this.signals});

  final List<DecayedSignal> signals;

  @override
  Widget build(BuildContext context) {
    if (signals.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.schedule_rounded,
                  color: AppTheme.amber, size: 22),
              const SizedBox(width: 8),
              Text('Deterioration with decay',
                  style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Fresh signals weight more than stale ones. A signal older than ~12 sessions is treated as noise.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          ...signals.map(
            (signal) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(signal.label,
                            style: theme.textTheme.titleSmall),
                      ),
                      Container(
                        padding:
                            const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: signal.isFresh
                              ? AppTheme.amber.withValues(alpha: 0.2)
                              : signal.isStale
                                  ? Colors.white.withValues(alpha: 0.08)
                                  : AppTheme.sky.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          signal.isFresh
                              ? 'fresh (${signal.ageInSessions}d)'
                              : signal.isStale
                                  ? 'stale (${signal.ageInSessions}d)'
                                  : '${signal.ageInSessions}d old',
                          style: theme.textTheme.labelSmall,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: LinearProgressIndicator(
                            value: signal.weight.clamp(0.0, 1.0),
                            minHeight: 6,
                            backgroundColor:
                                Colors.white.withValues(alpha: 0.06),
                            valueColor:
                                const AlwaysStoppedAnimation(AppTheme.amber),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text('w ${signal.weight.toStringAsFixed(2)}',
                          style: theme.textTheme.bodySmall),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Correlation cluster card: named cohort + tickers moving together.
class CorrelationClusterCard extends StatelessWidget {
  const CorrelationClusterCard({super.key, required this.cluster});

  final CorrelationCluster cluster;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = cluster.isConcentrated ? AppTheme.amber : AppTheme.sky;
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.hub_outlined, color: color, size: 22),
              const SizedBox(width: 8),
              Text('Correlation cluster',
                  style: theme.textTheme.headlineMedium),
              const Spacer(),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  'ρ ${cluster.correlationStrength.round()}',
                  style: theme.textTheme.labelLarge?.copyWith(color: color),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(cluster.label, style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(cluster.narrative, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: cluster.tickers
                .map(
                  (ticker) => Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.06),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(ticker,
                        style: theme.textTheme.labelLarge
                            ?.copyWith(color: color)),
                  ),
                )
                .toList(),
          ),
        ],
      ),
    );
  }
}

/// A screen-ready feed of every stock in the universe grouped by its
/// recommended action. Gives the user a clear Buy / Accumulate / Hold / Watch
/// / Trim / De-risk / Exit view without needing a portfolio import.
class UniverseActionFeed extends StatefulWidget {
  const UniverseActionFeed({
    super.key,
    required this.universe,
    required this.onOpenStock,
    this.ownedTickers = const <String>{},
  });

  final List<StockInsight> universe;
  final ValueChanged<String> onOpenStock;
  final Set<String> ownedTickers;

  @override
  State<UniverseActionFeed> createState() => _UniverseActionFeedState();
}

class _UniverseActionFeedState extends State<UniverseActionFeed> {
  RecommendationAction? _selectedAction;

  static const List<RecommendationAction> _order = [
    RecommendationAction.buy,
    RecommendationAction.accumulate,
    RecommendationAction.hold,
    RecommendationAction.watch,
    RecommendationAction.trim,
    RecommendationAction.deRisk,
    RecommendationAction.exit,
    RecommendationAction.avoidForNow,
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (widget.universe.isEmpty) {
      return const SizedBox.shrink();
    }
    final byAction = <RecommendationAction, List<StockInsight>>{};
    for (final stock in widget.universe) {
      byAction.putIfAbsent(stock.action, () => <StockInsight>[]).add(stock);
    }
    for (final entries in byAction.values) {
      entries.sort(
        (a, b) => b.opportunityScore.compareTo(a.opportunityScore),
      );
    }
    final filteredStocks = _selectedAction == null
        ? widget.universe.toList()
        : (byAction[_selectedAction] ?? const <StockInsight>[]);
    filteredStocks.sort(
      (a, b) => b.opportunityScore.compareTo(a.opportunityScore),
    );

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.checklist_rtl_rounded,
                  color: AppTheme.mint, size: 22),
              const SizedBox(width: 8),
              Text('Universe action feed',
                  style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Every name in the ranked universe grouped by the action the engine would take right now. Tap a group to filter; tap a ticker to open its stock intelligence page.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _ActionChip(
                label: 'All',
                count: widget.universe.length,
                selected: _selectedAction == null,
                color: AppTheme.sky,
                onTap: () => setState(() => _selectedAction = null),
              ),
              for (final action in _order)
                if ((byAction[action] ?? const []).isNotEmpty)
                  _ActionChip(
                    label: action.label,
                    count: byAction[action]!.length,
                    selected: _selectedAction == action,
                    color: _actionColor(action),
                    onTap: () => setState(() => _selectedAction = action),
                  ),
            ],
          ),
          const SizedBox(height: 16),
          ...filteredStocks.take(20).map(
                (stock) => _UniverseRow(
                  stock: stock,
                  onOpenStock: widget.onOpenStock,
                  isOwned: widget.ownedTickers.contains(stock.ticker),
                ),
              ),
          if (filteredStocks.length > 20)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '+${filteredStocks.length - 20} more — filter by action to narrow the list.',
                style: theme.textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  const _ActionChip({
    required this.label,
    required this.count,
    required this.selected,
    required this.color,
    required this.onTap,
  });

  final String label;
  final int count;
  final bool selected;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final background = selected ? color.withValues(alpha: 0.32) : color.withValues(alpha: 0.12);
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? color : color.withValues(alpha: 0.3),
            width: selected ? 1.4 : 1.0,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: theme.textTheme.labelLarge?.copyWith(color: color),
            ),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                '$count',
                style: theme.textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _UniverseRow extends StatelessWidget {
  const _UniverseRow({
    required this.stock,
    required this.onOpenStock,
    this.isOwned = false,
  });

  final StockInsight stock;
  final ValueChanged<String> onOpenStock;
  final bool isOwned;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = _actionColor(stock.action);
    final conflict = stock.confidenceBreakdown.isConflicted;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => onOpenStock(stock.ticker),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(
          children: [
            Container(
              width: 70,
              padding: const EdgeInsets.symmetric(vertical: 4),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(8),
              ),
              alignment: Alignment.center,
              child: Text(
                stock.action.label,
                style: theme.textTheme.labelSmall?.copyWith(color: color),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 86,
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      stock.ticker,
                      style: theme.textTheme.titleMedium,
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                    ),
                  ),
                  if (isOwned) ...[
                    const SizedBox(width: 4),
                    const Icon(Icons.account_balance_wallet_rounded,
                        size: 12, color: AppTheme.mint),
                  ],
                ],
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${isOwned ? "OWNED · " : ""}${stock.company} · ${stock.sector}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: isOwned ? AppTheme.mint : null,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        'opp ${stock.opportunityScore.round()}',
                        style: theme.textTheme.labelSmall,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'fit ${stock.regimeFit.round()}',
                        style: theme.textTheme.labelSmall,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'frag ${stock.fragilityScore.round()}',
                        style: theme.textTheme.labelSmall
                            ?.copyWith(color: AppTheme.amber),
                      ),
                      const SizedBox(width: 8),
                      if (conflict)
                        Text(
                          'conflict',
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: AppTheme.amber),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            SizedBox(
              width: 72,
              child: Text(
                '${stock.forecasts.outperformSectorProbability.round()}%',
                style: theme.textTheme.titleSmall?.copyWith(color: color),
                textAlign: TextAlign.right,
              ),
            ),
            const Icon(Icons.chevron_right_rounded, size: 18),
          ],
        ),
      ),
    );
  }
}

Color _actionColor(RecommendationAction action) {
  switch (action) {
    case RecommendationAction.buy:
    case RecommendationAction.accumulate:
      return AppTheme.mint;
    case RecommendationAction.hold:
      return AppTheme.sky;
    case RecommendationAction.watch:
      return AppTheme.sky;
    case RecommendationAction.trim:
      return AppTheme.amber;
    case RecommendationAction.deRisk:
    case RecommendationAction.exit:
      return const Color(0xFFEC6C6C);
    case RecommendationAction.avoidForNow:
      return const Color(0xFFEC6C6C);
  }
}

Color _toneColor(SignalTone tone) {
  switch (tone) {
    case SignalTone.positive:
      return AppTheme.mint;
    case SignalTone.neutral:
      return AppTheme.sky;
    case SignalTone.caution:
      return AppTheme.amber;
    case SignalTone.negative:
      return const Color(0xFFEC6C6C);
  }
}
