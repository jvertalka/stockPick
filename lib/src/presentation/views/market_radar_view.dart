import 'package:flutter/material.dart';

import '../../models/intelligence_app_state.dart';
import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';
import '../widgets/oracle_widgets.dart';

class MarketRadarView extends StatelessWidget {
  const MarketRadarView({
    super.key,
    required this.radar,
    required this.dataStatus,
    required this.engineStatus,
  });

  final MarketRadar radar;
  final DataStatusReport dataStatus;
  final EngineStatusReport engineStatus;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final metricWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 3,
            minWidth: 240,
          );
          final sectionWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 2,
            minWidth: 320,
          );
          final heroWide = constraints.maxWidth > 900;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ViewHeader(
                eyebrow: 'Market Radar',
                title: _radarHeaderTitle(radar),
                subtitle: _radarHeaderSubtitle(radar),
                trailing: TonePill(
                  label: radar.regime.label,
                  tone: _regimeTone(radar.regime),
                ),
              ),
              const PlainEnglishGuideCard(
                summary:
                    'Use this screen to answer three simple questions: what kind of market are we in, how broad is the strength, and how trustworthy is the data behind the read?',
                entries: _marketRadarGuideEntries,
              ),
              const SizedBox(height: 18),
              const HowThisIsCalculatedCard(
                summary:
                    'The radar is a rules-based summary of market internals, not a black box. These are the main ingredients and how to read them.',
                entries: _marketRadarCalculationEntries,
              ),
              const SizedBox(height: 18),
              InsightCard(
                child: heroWide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(child: _NarrativeBlock(radar: radar)),
                          const SizedBox(width: 20),
                          SizedBox(
                            width: 280,
                            child: _ScoreStack(radar: radar),
                          ),
                        ],
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _NarrativeBlock(radar: radar),
                          const SizedBox(height: 20),
                          _ScoreStack(radar: radar),
                        ],
                      ),
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: radar.metrics
                    .map(
                      (metric) => SizedBox(
                        width: metricWidth,
                        child: MetricTile(
                          label: metric.label,
                          value: metric.value,
                          detail: metric.detail,
                          tone: metric.tone,
                          definition: _metricDefinition(metric.label),
                          trend: metric.trend,
                        ),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Style rotation',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          ...radar.styleRotation.map(
                            (style) => Padding(
                              padding: const EdgeInsets.only(bottom: 14),
                              child: ScoreBar(
                                label: style.style,
                                value: style.score,
                                detail: style.note,
                                color: toneColor(style.tone),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Sector sponsorship',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          ...radar.sectorRotation.map(
                            (sector) => Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          sector.sector,
                                          style: Theme.of(
                                            context,
                                          ).textTheme.titleLarge,
                                        ),
                                      ),
                                      TonePill(
                                        label: sector.sponsorship,
                                        tone: sector.tone,
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 10),
                                  ScoreBar(
                                    label: 'Rotation score',
                                    value: sector.score,
                                    detail: sector.note,
                                    color: toneColor(sector.tone),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Data readiness',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            dataStatus.summary,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          const SizedBox(height: 16),
                          LabelValueRow(
                            label: 'Repository sync',
                            value: formatAsOf(dataStatus.lastRefresh),
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Archived snapshots',
                            value: '${dataStatus.archiveSnapshotCount}',
                            highlight: dataStatus.archiveSnapshotCount > 0
                                ? AppTheme.mint
                                : AppTheme.amber,
                          ),
                          if (dataStatus.latestArchive != null)
                            LabelValueRow(
                              label: 'Latest archived as-of',
                              value: formatAsOf(dataStatus.latestArchive!),
                              highlight: AppTheme.sky,
                            ),
                          const SizedBox(height: 14),
                          Text(
                            dataStatus.archiveSummary,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 16),
                          ...dataStatus.feeds.map(
                            (feed) => Padding(
                              padding: const EdgeInsets.only(bottom: 14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          feed.name,
                                          style: Theme.of(
                                            context,
                                          ).textTheme.titleLarge,
                                        ),
                                      ),
                                      TonePill(
                                        label: feed.availability.label,
                                        tone: _feedTone(feed.availability),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: [
                                      TonePill(
                                        label: feed.refreshCadence.label,
                                        tone: SignalTone.neutral,
                                      ),
                                      if (feed.lastUpdated != null)
                                        TonePill(
                                          label:
                                              'Updated ${formatAsOf(feed.lastUpdated!)}',
                                          tone: SignalTone.neutral,
                                        ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    feed.detail,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.bodySmall,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Engine validation',
                                  style: Theme.of(
                                    context,
                                  ).textTheme.headlineMedium,
                                ),
                              ),
                              TonePill(
                                label: engineStatus.validationStage.label,
                                tone: SignalTone.neutral,
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Text(
                            engineStatus.summary,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                          const SizedBox(height: 16),
                          LabelValueRow(
                            label: 'Research coverage',
                            value:
                                '${engineStatus.validationReport.coverageStart == null ? 'N/A' : formatAsOf(engineStatus.validationReport.coverageStart!)} - ${engineStatus.validationReport.coverageEnd == null ? 'N/A' : formatAsOf(engineStatus.validationReport.coverageEnd!)}',
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Training status',
                            value: engineStatus.isTrained
                                ? 'Trained'
                                : 'Not trained',
                            highlight: engineStatus.isTrained
                                ? AppTheme.mint
                                : AppTheme.amber,
                          ),
                          LabelValueRow(
                            label: 'Validation windows',
                            value:
                                '${engineStatus.validationReport.windowCount}',
                            highlight: AppTheme.sky,
                            definition:
                                'A validation window is one historical snapshot where the engine made picks and we later checked how those picks actually behaved.',
                          ),
                          LabelValueRow(
                            label: 'Observations',
                            value:
                                '${engineStatus.validationReport.observationCount}',
                            highlight: AppTheme.sky,
                            definition:
                                'Observations are the individual stock outcomes the app used to judge whether its scores were directionally useful.',
                          ),
                          LabelValueRow(
                            label: 'Top picks scored',
                            value:
                                '${engineStatus.validationReport.topPickCount}',
                            highlight: AppTheme.sky,
                            definition:
                                'This counts how many of the engine’s highest-ranked ideas were later measured against real outcomes.',
                          ),
                          LabelValueRow(
                            label: 'Top-pick hit rate',
                            value:
                                '${engineStatus.validationReport.hitRate.toStringAsFixed(0)}%',
                            highlight: AppTheme.mint,
                            definition:
                                'Hit rate is the share of top-ranked ideas that went on to outperform their sector after the snapshot date.',
                          ),
                          LabelValueRow(
                            label: 'Average alpha',
                            value:
                                '${engineStatus.validationReport.averageAlpha.toStringAsFixed(1)}%',
                            highlight: AppTheme.mint,
                            definition:
                                'Alpha is how much the picks beat or lagged their sector, not just whether they went up on their own.',
                          ),
                          LabelValueRow(
                            label: 'Worst drawdown',
                            value:
                                '${engineStatus.validationReport.worstDrawdown.toStringAsFixed(1)}%',
                            highlight: AppTheme.coral,
                            definition:
                                'Drawdown is the worst drop after the signal. It shows how painful the ride got before the trade either worked or failed.',
                          ),
                          const SizedBox(height: 14),
                          Text(
                            engineStatus.validationReport.verdict,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            'Calibration bands',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          ...engineStatus.validationReport.calibrationBands.map(
                            (band) => Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _CalibrationBandRow(band: band),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'Research integrity',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            engineStatus.validationReport.integrity.summary,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 10),
                          ...engineStatus.validationReport.integrity.checks.map(
                            (check) => Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _IntegrityCheckRow(check: check),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'Robustness',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          LabelValueRow(
                            label: 'Positive windows',
                            value:
                                '${engineStatus.validationReport.robustness.positiveWindowRate.toStringAsFixed(0)}%',
                            highlight: AppTheme.mint,
                          ),
                          LabelValueRow(
                            label: 'Median window alpha',
                            value:
                                '${engineStatus.validationReport.robustness.medianWindowAlpha.toStringAsFixed(1)}%',
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Worst window alpha',
                            value:
                                '${engineStatus.validationReport.robustness.worstWindowAlpha.toStringAsFixed(1)}%',
                            highlight: AppTheme.coral,
                          ),
                          LabelValueRow(
                            label: 'Average top-pick count',
                            value: engineStatus
                                .validationReport
                                .robustness
                                .averageTopPickCount
                                .toStringAsFixed(1),
                            highlight: AppTheme.amber,
                          ),
                          Text(
                            engineStatus.validationReport.robustness.summary,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            'Research splits',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          _SplitSummaryCard(
                            split: engineStatus.validationReport.trainSplit,
                          ),
                          const SizedBox(height: 12),
                          _SplitSummaryCard(
                            split: engineStatus.validationReport.testSplit,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            'Shadow readiness',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          LabelValueRow(
                            label: 'Archived snapshots',
                            value:
                                '${engineStatus.validationReport.shadowMode.archivedSnapshotCount} / ${engineStatus.validationReport.shadowMode.minimumSnapshotCount}',
                            highlight:
                                engineStatus.validationReport.shadowMode.isReady
                                ? AppTheme.mint
                                : AppTheme.amber,
                            definition:
                                'Shadow readiness is a progress check for whether the app has stored enough snapshots to quietly track live calls before trusting them.',
                          ),
                          Text(
                            engineStatus.validationReport.shadowMode.summary,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            'Model readiness',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          TonePill(
                            label:
                                engineStatus
                                    .validationReport
                                    .modelReadiness
                                    .isReady
                                ? 'ML-ready'
                                : 'Not ML-ready',
                            tone:
                                engineStatus
                                    .validationReport
                                    .modelReadiness
                                    .isReady
                                ? SignalTone.positive
                                : SignalTone.caution,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            engineStatus
                                .validationReport
                                .modelReadiness
                                .summary,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 10),
                          ...engineStatus.validationReport.modelReadiness.gates
                              .map(
                                (gate) => Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: _ReadinessGateRow(gate: gate),
                                ),
                              ),
                          const SizedBox(height: 14),
                          Text(
                            'Window breakdown',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          ...engineStatus.validationReport.windows.map(
                            (window) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _WindowSummaryCard(window: window),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Caveats',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 10),
                          BulletList(
                            items: engineStatus.caveats,
                            accent: AppTheme.amber,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              RegimeTransitionCard(
                distribution: radar.regimeDistribution,
                transition: radar.regimeTransition,
                stability: radar.regimeStability,
              ),
              const SizedBox(height: 18),
              BreadthDecompositionCard(rows: radar.breadthDecomposition),
            ],
          );
        },
      ),
    );
  }
}

class _NarrativeBlock extends StatelessWidget {
  const _NarrativeBlock({required this.radar});

  final MarketRadar radar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            TonePill(
              label: radar.internalHealth.label,
              tone: SignalTone.positive,
            ),
            const SizedBox(width: 10),
            TonePill(label: 'Breadth in focus', tone: SignalTone.neutral),
          ],
        ),
        const SizedBox(height: 18),
        Text(radar.headline, style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 12),
        Text(radar.summary, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: 18),
        Text(
          'What supports the regime',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 10),
        BulletList(items: radar.supportingSignals),
        const SizedBox(height: 8),
        Text(
          'What could invalidate it',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 10),
        BulletList(items: radar.warnings, accent: AppTheme.amber),
      ],
    );
  }
}

class _ScoreStack extends StatelessWidget {
  const _ScoreStack({required this.radar});

  final MarketRadar radar;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Regime stack', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 14),
        ScoreBar(
          label: 'Market score',
          value: radar.marketScore,
          detail: 'How favorable the present environment is for taking risk.',
          color: AppTheme.mint,
          definition:
              'Think of this as the market weather score. Higher means the overall backdrop is more supportive for taking risk.',
        ),
        const SizedBox(height: 14),
        ScoreBar(
          label: 'Risk score',
          value: radar.riskScore,
          detail: 'Higher means the environment is demanding more humility.',
          color: AppTheme.amber,
          definition:
              'This is the stress meter. Higher means the market is less forgiving and mistakes can get punished faster.',
        ),
        const SizedBox(height: 14),
        ScoreBar(
          label: 'Regime confidence',
          value: radar.regimeConfidence,
          detail: radar.breadthSummary,
          color: AppTheme.sky,
          definition:
              'This measures how strongly the evidence agrees on the current market regime instead of giving a mixed signal.',
        ),
      ],
    );
  }
}

SignalTone _feedTone(FeedAvailability availability) => switch (availability) {
  FeedAvailability.fixture => SignalTone.neutral,
  FeedAvailability.connected => SignalTone.positive,
  FeedAvailability.planned => SignalTone.caution,
  FeedAvailability.missing => SignalTone.negative,
};

SignalTone _regimeTone(MarketRegimeType regime) => switch (regime) {
  MarketRegimeType.riskOn ||
  MarketRegimeType.washoutRecovery => SignalTone.positive,
  MarketRegimeType.neutral => SignalTone.neutral,
  MarketRegimeType.euphoricMeltUp ||
  MarketRegimeType.inflationStress ||
  MarketRegimeType.growthScare => SignalTone.caution,
  MarketRegimeType.riskOff ||
  MarketRegimeType.creditDeterioration => SignalTone.negative,
};

String _radarHeaderTitle(MarketRadar radar) {
  return switch (radar.regime) {
    MarketRegimeType.riskOn =>
      'Risk appetite is still in control, but confirmation matters.',
    MarketRegimeType.neutral =>
      'The tape is mixed enough that selectivity matters most.',
    MarketRegimeType.riskOff =>
      'The market is defensive, so capital preservation comes first.',
    MarketRegimeType.inflationStress =>
      'Inflation stress is reshaping the opportunity set.',
    MarketRegimeType.growthScare =>
      'Growth fear is rising, and fragile upside needs proof.',
    MarketRegimeType.creditDeterioration =>
      'Credit deterioration is forcing the market to care about balance-sheet risk.',
    MarketRegimeType.euphoricMeltUp =>
      'Momentum is powerful, but crowding is becoming the tax.',
    MarketRegimeType.washoutRecovery =>
      'Recovery signals are appearing, but the repair still needs confirmation.',
  };
}

String _radarHeaderSubtitle(MarketRadar radar) {
  return 'Current read: ${radar.regime.label} with ${radar.regimeConfidence.round()}% confidence and ${radar.internalHealth.label.toLowerCase()} underneath. This view ties the regime and internals to the repository coverage and validation stack behind the dashboard.';
}

class _SplitSummaryCard extends StatelessWidget {
  const _SplitSummaryCard({required this.split});

  final ValidationSplitReport split;

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
              TonePill(label: split.label, tone: SignalTone.neutral),
              const SizedBox(width: 10),
              TonePill(
                label: '${split.windowCount} windows',
                tone: SignalTone.neutral,
              ),
            ],
          ),
          const SizedBox(height: 12),
          LabelValueRow(
            label: 'Observations',
            value: '${split.observationCount}',
            highlight: AppTheme.sky,
            definition:
                'Observations are the individual stock results used to judge whether the scoring method had any real separation power.',
          ),
          LabelValueRow(
            label: 'Top-pick hit rate',
            value: '${split.hitRate.toStringAsFixed(0)}%',
            highlight: split.hitRate >= 60 ? AppTheme.mint : AppTheme.amber,
            definition:
                'This is the share of the split’s top ideas that outperformed their sector.',
          ),
          LabelValueRow(
            label: 'Average alpha',
            value: '${split.averageAlpha.toStringAsFixed(1)}%',
            highlight: split.averageAlpha >= 0 ? AppTheme.mint : AppTheme.coral,
            definition:
                'Alpha shows whether the picks beat their sector on average, not just whether the whole market was rising.',
          ),
          LabelValueRow(
            label: 'Worst drawdown',
            value: '${split.worstDrawdown.toStringAsFixed(1)}%',
            highlight: AppTheme.coral,
            definition:
                'The deepest drop the picks experienced during that split before recovering or failing.',
          ),
          const SizedBox(height: 10),
          Text(split.verdict, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _CalibrationBandRow extends StatelessWidget {
  const _CalibrationBandRow({required this.band});

  final CalibrationBandReport band;

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
              TonePill(label: band.label, tone: SignalTone.neutral),
              const SizedBox(width: 10),
              Text(
                '${band.observationCount} obs',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          const SizedBox(height: 10),
          LabelValueRow(
            label: 'Hit rate',
            value: '${band.hitRate.toStringAsFixed(0)}%',
            highlight: band.hitRate >= 55 ? AppTheme.mint : AppTheme.amber,
          ),
          LabelValueRow(
            label: 'Average alpha',
            value: '${band.averageAlpha.toStringAsFixed(1)}%',
            highlight: band.averageAlpha >= 0 ? AppTheme.mint : AppTheme.coral,
          ),
          LabelValueRow(
            label: 'Average score',
            value: band.averageScore.toStringAsFixed(1),
            highlight: AppTheme.sky,
          ),
        ],
      ),
    );
  }
}

class _IntegrityCheckRow extends StatelessWidget {
  const _IntegrityCheckRow({required this.check});

  final ResearchIntegrityCheck check;

  @override
  Widget build(BuildContext context) {
    final tone = check.passed ? SignalTone.positive : SignalTone.caution;
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
              TonePill(label: check.label, tone: tone),
              const SizedBox(width: 10),
              Icon(
                check.passed
                    ? Icons.verified_rounded
                    : Icons.error_outline_rounded,
                size: 18,
                color: check.passed ? AppTheme.mint : AppTheme.amber,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(check.detail, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _ReadinessGateRow extends StatelessWidget {
  const _ReadinessGateRow({required this.gate});

  final ReadinessGateReport gate;

  @override
  Widget build(BuildContext context) {
    final tone = gate.passed ? SignalTone.positive : SignalTone.caution;
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
                child: TonePill(label: gate.label, tone: tone),
              ),
              const SizedBox(width: 10),
              Text(
                '${gate.current} / ${gate.minimum}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: gate.passed ? AppTheme.mint : AppTheme.amber,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(gate.detail, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _WindowSummaryCard extends StatelessWidget {
  const _WindowSummaryCard({required this.window});

  final ValidationWindowReport window;

  @override
  Widget build(BuildContext context) {
    final picks = window.topPicks.isEmpty
        ? 'No ranked picks with outcomes.'
        : window.topPicks
              .map(
                (pick) =>
                    '${pick.ticker} ${pick.alpha >= 0 ? '+' : ''}${pick.alpha.toStringAsFixed(1)}% alpha',
              )
              .join(' | ');

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
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              TonePill(
                label: formatAsOf(window.asOf),
                tone: SignalTone.neutral,
              ),
              TonePill(label: window.regimeLabel, tone: SignalTone.neutral),
            ],
          ),
          const SizedBox(height: 12),
          LabelValueRow(
            label: 'Hit rate',
            value: '${window.hitRate.toStringAsFixed(0)}%',
            highlight: window.hitRate >= 50 ? AppTheme.mint : AppTheme.amber,
            definition:
                'The share of this window’s top picks that went on to outperform their sector.',
          ),
          LabelValueRow(
            label: 'Average alpha',
            value: '${window.averageAlpha.toStringAsFixed(1)}%',
            highlight: window.averageAlpha >= 0
                ? AppTheme.mint
                : AppTheme.coral,
            definition:
                'How much the window’s picks beat or lagged their sector on average.',
          ),
          LabelValueRow(
            label: 'Worst drawdown',
            value: '${window.worstDrawdown.toStringAsFixed(1)}%',
            highlight: AppTheme.coral,
            definition:
                'The worst peak-to-trough drop seen after the picks from this snapshot were made.',
          ),
          const SizedBox(height: 10),
          Text(picks, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

const _marketRadarGuideEntries = [
  GuideEntry(
    term: 'Market regime',
    definition:
        'The app’s read on the current market mood. Risk-on means buyers are comfortable taking chances; risk-off means investors are more defensive.',
  ),
  GuideEntry(
    term: 'Breadth',
    definition:
        'Breadth asks whether many stocks are participating in the move or only a few big names. Strong breadth usually makes a rally healthier.',
  ),
  GuideEntry(
    term: 'Style rotation',
    definition:
        'This shows which kinds of stocks are leading right now, such as growth, defensives, or cyclicals.',
  ),
  GuideEntry(
    term: 'Sector sponsorship',
    definition:
        'Sponsorship is a plain-English way of saying where money appears to be flowing with conviction, not just bouncing briefly.',
  ),
  GuideEntry(
    term: 'Alpha and drawdown',
    definition:
        'Alpha means performance versus a fair comparison group like the stock’s sector. Drawdown means the worst drop along the way, even if the idea later recovered.',
  ),
  GuideEntry(
    term: 'Data readiness',
    definition:
        'This tells you whether the app is reading fixtures, connected feeds, or a synced local market-data store, plus how much history and sync coverage it already has on hand.',
  ),
];

const _marketRadarCalculationEntries = [
  CalculationEntry(
    title: 'Market score',
    summary:
        'A broad market weather score that rewards supportive trend, breadth, and financial conditions.',
    drivers: [
      'Index trend, breadth, and sector participation',
      'Credit calm and easier financial conditions',
      'Style leadership that matches the current tape',
    ],
    interpretation:
        'Higher is better for taking risk. A high score does not guarantee upside, but it means the backdrop is less hostile.',
  ),
  CalculationEntry(
    title: 'Risk score',
    summary:
        'A stress meter that rises when volatility, credit pressure, and crowding become harder to ignore.',
    drivers: [
      'Realized and implied volatility',
      'Credit stress and correlation',
      'Crowding and fragile price response',
    ],
    interpretation:
        'Higher means the market is less forgiving. It is a warning flag, not a directional call on its own.',
  ),
  CalculationEntry(
    title: 'Breadth health',
    summary:
        'A participation check built from advance-decline strength, new highs versus new lows, and percent-above-average confirmation.',
    drivers: [
      'Advance-decline line and new high-low data',
      'Equal-weight confirmation',
      'Percent of stocks above key averages',
    ],
    interpretation:
        'Higher means the move is being confirmed by more than a small handful of names.',
  ),
  CalculationEntry(
    title: 'Validation metrics',
    summary:
        'The research card compares the engine’s historical rankings with later outcomes to see whether higher scores actually separated better ideas from worse ones.',
    drivers: [
      'Top-pick hit rate versus sector-relative alpha',
      'Train and holdout splits kept in time order',
      'Calibration bands and integrity checks',
    ],
    interpretation:
        'Strong metrics are only useful when the chronology and holdout checks also pass. Good headline numbers with weak integrity still deserve caution.',
  ),
];

String? _metricDefinition(String label) {
  return switch (label) {
    'Index trend' =>
      'A quick read on whether the major indexes are still behaving like an uptrend or starting to weaken.',
    'Realized volatility' =>
      'How much the market has actually been swinging recently. Higher means the ride has been bumpier in real life.',
    'Credit pulse' =>
      'A stress check on the credit market. Calm credit often supports risk-taking; stressed credit can be an early warning sign.',
    'Breadth health' =>
      'How widely the current move is being confirmed across the market instead of relying on only a handful of winners.',
    'Leadership quality' =>
      'Whether the market’s strongest names look healthy and broad-based rather than narrow and fragile.',
    'Crowding risk' =>
      'How packed the trade looks. High crowding means lots of investors may already be leaning the same way, which can make reversals sharper.',
    _ => null,
  };
}
