import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class StockIntelligenceView extends StatelessWidget {
  const StockIntelligenceView({
    super.key,
    required this.stocks,
    required this.selectedTicker,
    required this.onSelectTicker,
  });

  final List<StockInsight> stocks;
  final String selectedTicker;
  final ValueChanged<String> onSelectTicker;

  @override
  Widget build(BuildContext context) {
    final selected = stocks.firstWhere(
      (stock) => stock.ticker == selectedTicker,
      orElse: () => stocks.first,
    );

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
                eyebrow: 'Stock Intelligence',
                title: '${selected.ticker} inside its current regime context.',
                subtitle:
                    'This page explains why the stock ranks where it does, what assumptions support the thesis, and what evidence would tell you the story is breaking.',
                trailing: ActionBadge(action: selected.action),
              ),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: stocks
                    .map(
                      (stock) => ChoiceChip(
                        selected: stock.ticker == selected.ticker,
                        label: Text(stock.ticker),
                        onSelected: (_) => onSelectTicker(stock.ticker),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 18),
              InsightCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${selected.company} | ${selected.industry}',
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                selected.summary,
                                style: Theme.of(context).textTheme.bodyLarge,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 18),
                        TonePill(
                          label: selected.confidenceLabel,
                          tone: selected.confidenceScore >= 80
                              ? SignalTone.positive
                              : SignalTone.caution,
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Text(
                      'Signal health',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      selected.stabilitySummary,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
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
                            'Hierarchical scoring',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Opportunity score',
                            value: selected.opportunityScore,
                            color: AppTheme.mint,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Regime fit',
                            value: selected.regimeFit,
                            color: AppTheme.sky,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Trend quality',
                            value: selected.trendQuality,
                            color: AppTheme.mint,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Revision trend',
                            value: selected.revisionTrend,
                            color: AppTheme.amber,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Conviction',
                            value: selected.convictionScore,
                            color: AppTheme.sky,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Fragility',
                            value: selected.fragilityScore,
                            color: AppTheme.coral,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Asymmetry',
                            value: selected.asymmetryScore,
                            color: AppTheme.amber,
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Risk score',
                            value: selected.riskScore,
                            color: AppTheme.coral,
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: Column(
                      children: [
                        InsightCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Why it ranks',
                                style: Theme.of(
                                  context,
                                ).textTheme.headlineMedium,
                              ),
                              const SizedBox(height: 14),
                              BulletList(items: selected.whyItRanks),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        InsightCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'What could go wrong',
                                style: Theme.of(
                                  context,
                                ).textTheme.headlineMedium,
                              ),
                              const SizedBox(height: 14),
                              BulletList(
                                items: selected.whatCouldGoWrong,
                                accent: AppTheme.amber,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Options and derivatives',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          LabelValueRow(
                            label: 'IV rank',
                            value: selected.optionsSignal.ivRank
                                .round()
                                .toString(),
                            highlight: AppTheme.mint,
                          ),
                          LabelValueRow(
                            label: 'Realized vs implied gap',
                            value:
                                '${selected.optionsSignal.realizedGap.round()} pts',
                            highlight: AppTheme.sky,
                          ),
                          LabelValueRow(
                            label: 'Skew change',
                            value:
                                '${selected.optionsSignal.skewChange.round()} bps',
                            highlight: AppTheme.amber,
                          ),
                          LabelValueRow(
                            label: 'Event premium',
                            value:
                                '${selected.optionsSignal.eventPremium.toStringAsFixed(1)}%',
                            highlight: AppTheme.coral,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            selected.optionsSignal.commentary,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: Column(
                      children: [
                        InsightCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Thesis invalidation',
                                style: Theme.of(
                                  context,
                                ).textTheme.headlineMedium,
                              ),
                              const SizedBox(height: 14),
                              BulletList(
                                items: selected.invalidationSignals,
                                accent: AppTheme.coral,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        InsightCard(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Recent changes',
                                style: Theme.of(
                                  context,
                                ).textTheme.headlineMedium,
                              ),
                              const SizedBox(height: 14),
                              BulletList(
                                items: selected.recentChanges,
                                accent: AppTheme.sky,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(
                    width: constraints.maxWidth,
                    child: InsightCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Peer comparison',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          ...selected.peers.map(
                            (peer) => Padding(
                              padding: const EdgeInsets.only(bottom: 14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          '${peer.ticker} | ${peer.company}',
                                          style: Theme.of(
                                            context,
                                          ).textTheme.titleLarge,
                                        ),
                                      ),
                                      Text(
                                        'Crowding ${peer.crowdingScore.round()}',
                                        style: Theme.of(
                                          context,
                                        ).textTheme.bodySmall,
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 10),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: ScoreBar(
                                          label: 'Relative strength',
                                          value: peer.relativeStrength,
                                          color: AppTheme.mint,
                                        ),
                                      ),
                                      const SizedBox(width: 16),
                                      Expanded(
                                        child: ScoreBar(
                                          label: 'Revision trend',
                                          value: peer.revisionTrend,
                                          color: AppTheme.sky,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
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
