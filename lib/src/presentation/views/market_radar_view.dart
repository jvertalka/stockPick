import 'package:flutter/material.dart';

import '../../models/intelligence_app_state.dart';
import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

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
                title:
                    'The current tape is constructive, but now the system tells the truth about itself too.',
                subtitle:
                    'This view starts with the regime and internals, then shows the current state of the data repository and the validation stack behind the dashboard.',
                trailing: TonePill(
                  label: radar.regime.label,
                  tone: SignalTone.positive,
                ),
              ),
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
                          ),
                          LabelValueRow(
                            label: 'Observations',
                            value:
                                '${engineStatus.validationReport.observationCount}',
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Top picks scored',
                            value:
                                '${engineStatus.validationReport.topPickCount}',
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Top-pick hit rate',
                            value:
                                '${engineStatus.validationReport.hitRate.toStringAsFixed(0)}%',
                            highlight: AppTheme.mint,
                          ),
                          LabelValueRow(
                            label: 'Average alpha',
                            value:
                                '${engineStatus.validationReport.averageAlpha.toStringAsFixed(1)}%',
                            highlight: AppTheme.mint,
                          ),
                          LabelValueRow(
                            label: 'Worst drawdown',
                            value:
                                '${engineStatus.validationReport.worstDrawdown.toStringAsFixed(1)}%',
                            highlight: AppTheme.coral,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            engineStatus.validationReport.verdict,
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
                          ),
                          Text(
                            engineStatus.validationReport.shadowMode.summary,
                            style: Theme.of(context).textTheme.bodySmall,
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
        ),
        const SizedBox(height: 14),
        ScoreBar(
          label: 'Risk score',
          value: radar.riskScore,
          detail: 'Higher means the environment is demanding more humility.',
          color: AppTheme.amber,
        ),
        const SizedBox(height: 14),
        ScoreBar(
          label: 'Regime confidence',
          value: radar.regimeConfidence,
          detail: radar.breadthSummary,
          color: AppTheme.sky,
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
          ),
          LabelValueRow(
            label: 'Top-pick hit rate',
            value: '${split.hitRate.toStringAsFixed(0)}%',
            highlight: split.hitRate >= 60 ? AppTheme.mint : AppTheme.amber,
          ),
          LabelValueRow(
            label: 'Average alpha',
            value: '${split.averageAlpha.toStringAsFixed(1)}%',
            highlight: split.averageAlpha >= 0 ? AppTheme.mint : AppTheme.coral,
          ),
          LabelValueRow(
            label: 'Worst drawdown',
            value: '${split.worstDrawdown.toStringAsFixed(1)}%',
            highlight: AppTheme.coral,
          ),
          const SizedBox(height: 10),
          Text(split.verdict, style: Theme.of(context).textTheme.bodySmall),
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
          ),
          LabelValueRow(
            label: 'Average alpha',
            value: '${window.averageAlpha.toStringAsFixed(1)}%',
            highlight: window.averageAlpha >= 0
                ? AppTheme.mint
                : AppTheme.coral,
          ),
          LabelValueRow(
            label: 'Worst drawdown',
            value: '${window.worstDrawdown.toStringAsFixed(1)}%',
            highlight: AppTheme.coral,
          ),
          const SizedBox(height: 10),
          Text(picks, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
