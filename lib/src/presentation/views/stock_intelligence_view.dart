import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../models/workflow_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class StockIntelligenceView extends StatelessWidget {
  const StockIntelligenceView({
    super.key,
    required this.stocks,
    required this.selectedTicker,
    required this.onSelectTicker,
    required this.workflowState,
    required this.onToggleWatchlist,
    required this.onToggleSavedIdea,
    required this.onToggleAlertSubscription,
  });

  final List<StockInsight> stocks;
  final String? selectedTicker;
  final ValueChanged<String> onSelectTicker;
  final WorkflowState workflowState;
  final ValueChanged<String> onToggleWatchlist;
  final ValueChanged<String> onToggleSavedIdea;
  final ValueChanged<String> onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    if (stocks.isEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
        child: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ViewHeader(
              eyebrow: 'Stock Intelligence',
              title:
                  'Explanation follows the board once the board has names to explain.',
              subtitle:
                  'This view is ready, but the repository has not returned any ranked opportunities for the current snapshot yet.',
              trailing: TonePill(
                label: 'Awaiting ranked stocks',
                tone: SignalTone.neutral,
              ),
            ),
            PlainEnglishGuideCard(
              summary:
                  'This page slows the ranking down and explains the setup like an analyst note instead of a black-box score.',
              entries: _stockIntelligenceGuideEntries,
            ),
            SizedBox(height: 18),
            HowThisIsCalculatedCard(
              summary:
                  'The stock sheet blends market fit, business momentum, and fragility into a ranked setup instead of one headline score.',
              entries: _stockCalculationEntries,
            ),
            SizedBox(height: 18),
            EmptyStateCard(
              icon: Icons.insights_rounded,
              title: 'No stock intelligence yet.',
              message:
                  'Connect a stock feed or refresh into a richer snapshot to inspect thesis support, fragility, options signals, and invalidation rules here.',
            ),
          ],
        ),
      );
    }

    final selected = stocks.firstWhere(
      (stock) => stock.ticker == selectedTicker,
      orElse: () => stocks.first,
    );
    final isWatched = workflowState.watchlistTickers.contains(selected.ticker);
    final isSaved = workflowState.savedIdeas.contains(selected.ticker);
    final isSubscribed = workflowState.alertSubscriptions.contains(
      selected.ticker,
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
              const PlainEnglishGuideCard(
                summary:
                    'This page slows the ranking down and explains the setup like an analyst note instead of a black-box score.',
                entries: _stockIntelligenceGuideEntries,
              ),
              const SizedBox(height: 18),
              const HowThisIsCalculatedCard(
                summary:
                    'These scores are deterministic committee outputs. The card below shows the main ingredients and how to interpret them.',
                entries: _stockCalculationEntries,
              ),
              const SizedBox(height: 18),
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
              const SizedBox(height: 14),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilterChip(
                    selected: isWatched,
                    label: const Text('Watchlist'),
                    avatar: Icon(
                      isWatched
                          ? Icons.star_rounded
                          : Icons.star_border_rounded,
                      size: 18,
                    ),
                    onSelected: (_) => onToggleWatchlist(selected.ticker),
                  ),
                  FilterChip(
                    selected: isSaved,
                    label: const Text('Save idea'),
                    avatar: Icon(
                      isSaved
                          ? Icons.bookmark_rounded
                          : Icons.bookmark_border_rounded,
                      size: 18,
                    ),
                    onSelected: (_) => onToggleSavedIdea(selected.ticker),
                  ),
                  FilterChip(
                    selected: isSubscribed,
                    label: const Text('Sell alerts'),
                    avatar: Icon(
                      isSubscribed
                          ? Icons.notifications_active_rounded
                          : Icons.notifications_none_rounded,
                      size: 18,
                    ),
                    onSelected: (_) =>
                        onToggleAlertSubscription(selected.ticker),
                  ),
                ],
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
                    child: MetricTile(
                      label: 'Opportunity trend',
                      value: selected.opportunityScore.round().toString(),
                      detail:
                          'How the total attractiveness score has been moving through the archived history.',
                      tone: SignalTone.positive,
                      trend: selected.opportunityTrend,
                      definition:
                          'The all-in stock ranking after balancing upside, fit, and fragility.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Regime-fit trend',
                      value: selected.regimeFit.round().toString(),
                      detail:
                          'Tracks whether this stock has become a better or worse fit for the current market style over time.',
                      tone: SignalTone.neutral,
                      trend: selected.regimeFitTrend,
                      definition:
                          'How naturally this stock fits the current kind of market rather than some other environment.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Conviction trend',
                      value: selected.convictionScore.round().toString(),
                      detail:
                          'Shows whether the supporting evidence has been aligning more cleanly or becoming less consistent.',
                      tone: SignalTone.positive,
                      trend: selected.convictionTrend,
                      definition:
                          'How strongly the separate pieces of evidence agree on the setup.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Fragility trend',
                      value: selected.fragilityScore.round().toString(),
                      detail:
                          'A historical read on how easily this thesis could crack if the tape or positioning turns against it.',
                      tone: SignalTone.caution,
                      trend: selected.fragilityTrend,
                      definition:
                          'How easy it would be for the thesis to break if the tape or positioning turns against it.',
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
                            definition:
                                'The overall “how attractive is this setup right now?” score after balancing upside, fit, and risk.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Regime fit',
                            value: selected.regimeFit,
                            color: AppTheme.sky,
                            definition:
                                'How naturally this stock fits the current kind of market rather than some other environment.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Trend quality',
                            value: selected.trendQuality,
                            color: AppTheme.mint,
                            definition:
                                'Whether the move looks sturdy and well-supported instead of stretched or sloppy.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Revision trend',
                            value: selected.revisionTrend,
                            color: AppTheme.amber,
                            definition:
                                'Whether expectations around earnings and business momentum are getting better or worse.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Conviction',
                            value: selected.convictionScore,
                            color: AppTheme.sky,
                            definition:
                                'How strongly different pieces of evidence agree on the setup.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Fragility',
                            value: selected.fragilityScore,
                            color: AppTheme.coral,
                            definition:
                                'How easy it would be for the thesis to break if the tape or positioning turns against it.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Asymmetry',
                            value: selected.asymmetryScore,
                            color: AppTheme.amber,
                            definition:
                                'Whether the upside looks meaningfully larger than the downside risk.',
                          ),
                          const SizedBox(height: 14),
                          ScoreBar(
                            label: 'Risk score',
                            value: selected.riskScore,
                            color: AppTheme.coral,
                            definition:
                                'A simple stress meter for how punishing this setup could be if things go wrong.',
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
                            definition:
                                'How expensive options are today compared with this stock’s own recent history.',
                          ),
                          LabelValueRow(
                            label: 'Realized vs implied gap',
                            value:
                                '${selected.optionsSignal.realizedGap.round()} pts',
                            highlight: AppTheme.sky,
                            definition:
                                'The gap between how much the stock has actually moved and how much options traders are pricing in.',
                          ),
                          LabelValueRow(
                            label: 'Skew change',
                            value:
                                '${selected.optionsSignal.skewChange.round()} bps',
                            highlight: AppTheme.amber,
                            definition:
                                'Whether traders are paying more than usual for downside protection, which can hint at growing caution.',
                          ),
                          LabelValueRow(
                            label: 'Event premium',
                            value:
                                '${selected.optionsSignal.eventPremium.toStringAsFixed(1)}%',
                            highlight: AppTheme.coral,
                            definition:
                                'The extra option cost being charged around a known catalyst like earnings or product news.',
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
                                          definition:
                                              'How well this peer has been performing compared with similar stocks.',
                                        ),
                                      ),
                                      const SizedBox(width: 16),
                                      Expanded(
                                        child: ScoreBar(
                                          label: 'Revision trend',
                                          value: peer.revisionTrend,
                                          color: AppTheme.sky,
                                          definition:
                                              'Whether expectations for this peer are improving or fading.',
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

const _stockIntelligenceGuideEntries = [
  GuideEntry(
    term: 'Signal health',
    definition:
        'A plain-English read on whether the setup still looks stable or whether it now needs much more caution.',
  ),
  GuideEntry(
    term: 'Conviction and asymmetry',
    definition:
        'Conviction asks how strongly the evidence agrees. Asymmetry asks whether the upside still looks worth the downside risk.',
  ),
  GuideEntry(
    term: 'IV rank',
    definition:
        'IV rank is options jargon for how expensive volatility is versus this stock’s own history, not versus the whole market.',
  ),
  GuideEntry(
    term: 'Realized vs implied gap',
    definition:
        'This compares actual recent movement with the movement options traders are betting on next.',
  ),
  GuideEntry(
    term: 'Skew and event premium',
    definition:
        'Skew shows how much investors are paying for downside protection. Event premium is the extra options cost around a known catalyst.',
  ),
  GuideEntry(
    term: 'Thesis invalidation',
    definition:
        'These are the concrete signs that would tell you to stop trusting the original idea instead of rationalizing the trade.',
  ),
];

const _stockCalculationEntries = [
  CalculationEntry(
    title: 'Opportunity score',
    summary:
        'The headline ranking blends trend quality, revisions, regime fit, valuation support, and fragility.',
    drivers: [
      'Trend quality and revision trend',
      'Regime fit and macro alignment',
      'Valuation support minus fragility drag',
    ],
    interpretation:
        'Higher means the setup looks more attractive right now, not that it is guaranteed to work.',
  ),
  CalculationEntry(
    title: 'Regime fit',
    summary:
        'This measures whether the stock naturally matches the market style currently being rewarded.',
    drivers: [
      'Sector strength and breadth',
      'Style alignment to the current regime',
      'Macro alignment to credit, rates, and stability conditions',
    ],
    interpretation:
        'A good stock can still score poorly here if the market is in the wrong mood for that kind of setup.',
  ),
  CalculationEntry(
    title: 'Fragility',
    summary:
        'Fragility rises when crowding, downside hedging, bad price response, and weak peer leadership all point to a thinner setup.',
    drivers: [
      'Options stress and downside protection demand',
      'Poor price response to good news',
      'Weakening peer leadership and valuation cushion',
    ],
    interpretation:
        'Higher fragility means less room for error. It is a warning on durability, not a direct sell signal by itself.',
  ),
  CalculationEntry(
    title: 'Conviction and asymmetry',
    summary:
        'Conviction asks whether the evidence agrees. Asymmetry asks whether the upside still looks worth the downside risk.',
    drivers: [
      'Agreement across opportunity, quality, and regime evidence',
      'Expected stability and balance-sheet resilience',
      'Downside penalty from fragility',
    ],
    interpretation:
        'The best setups usually pair decent conviction with manageable fragility rather than simply maxing one score.',
  ),
];
