import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../models/workflow_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class OpportunityBoardView extends StatelessWidget {
  const OpportunityBoardView({
    super.key,
    required this.stocks,
    required this.highlightedTickers,
    required this.workflowState,
    required this.onOpenStock,
    required this.onToggleWatchlist,
    required this.onToggleSavedIdea,
    required this.onToggleAlertSubscription,
  });

  final List<StockInsight> stocks;
  final Set<String> highlightedTickers;
  final WorkflowState workflowState;
  final ValueChanged<String> onOpenStock;
  final ValueChanged<String> onToggleWatchlist;
  final ValueChanged<String> onToggleSavedIdea;
  final ValueChanged<String> onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    final hasStocks = stocks.isNotEmpty;
    final topIdeas = stocks.take(3).map((stock) => stock.ticker).join(' | ');
    final boardLabel = hasStocks
        ? '${stocks.length} ranked names | top: $topIdeas'
        : 'Awaiting ranked stocks';

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ViewHeader(
            eyebrow: 'Opportunity Board',
            title: 'Conditional opportunity, not generic stock picking.',
            subtitle:
                'Each name is ranked inside the current market regime, then stress-tested for crowding, fragility, and thesis invalidation.',
            trailing: TonePill(
              label: boardLabel,
              tone: hasStocks ? SignalTone.positive : SignalTone.neutral,
            ),
          ),
          const PlainEnglishGuideCard(
            summary:
                'This board is less about predicting the future perfectly and more about comparing which setups look strongest right now after adjusting for market conditions.',
            entries: _opportunityBoardGuideEntries,
          ),
          const SizedBox(height: 18),
          if (!hasStocks)
            const EmptyStateCard(
              icon: Icons.query_stats_rounded,
              title: 'No ranked opportunities yet.',
              message:
                  'This board will populate after stock signals arrive and the engine has enough data to score them for the current regime.',
            )
          else ...[
            InsightCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Board read',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'The current board favors quality growth with healthy internal sponsorship. Semiconductors offer the most raw upside, cybersecurity offers a cleaner balance of upside and fragility, and defensive growth remains useful if the tape loses confidence.',
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
            ...stocks.map(
              (stock) => Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: _OpportunityCard(
                  stock: stock,
                  isHighlighted: highlightedTickers.contains(stock.ticker),
                  workflowState: workflowState,
                  onOpen: () => onOpenStock(stock.ticker),
                  onToggleWatchlist: () => onToggleWatchlist(stock.ticker),
                  onToggleSavedIdea: () => onToggleSavedIdea(stock.ticker),
                  onToggleAlertSubscription: () =>
                      onToggleAlertSubscription(stock.ticker),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _OpportunityCard extends StatelessWidget {
  const _OpportunityCard({
    required this.stock,
    required this.isHighlighted,
    required this.workflowState,
    required this.onOpen,
    required this.onToggleWatchlist,
    required this.onToggleSavedIdea,
    required this.onToggleAlertSubscription,
  });

  final StockInsight stock;
  final bool isHighlighted;
  final WorkflowState workflowState;
  final VoidCallback onOpen;
  final VoidCallback onToggleWatchlist;
  final VoidCallback onToggleSavedIdea;
  final VoidCallback onToggleAlertSubscription;

  @override
  Widget build(BuildContext context) {
    final isWatched = workflowState.watchlistTickers.contains(stock.ticker);
    final isSaved = workflowState.savedIdeas.contains(stock.ticker);
    final isSubscribed = workflowState.alertSubscriptions.contains(
      stock.ticker,
    );
    return InkWell(
      borderRadius: BorderRadius.circular(28),
      onTap: onOpen,
      child: InsightCard(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final twoColumn = constraints.maxWidth > 760;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                stock.ticker,
                                style: Theme.of(context).textTheme.displayMedium
                                    ?.copyWith(fontSize: 34),
                              ),
                              const SizedBox(width: 12),
                              if (isHighlighted) ...[
                                const TonePill(
                                  label: 'Top surface',
                                  tone: SignalTone.positive,
                                ),
                                const SizedBox(width: 12),
                              ],
                              ActionBadge(action: stock.action),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            '${stock.company} | ${stock.industry}',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            stock.summary,
                            style: Theme.of(context).textTheme.bodyLarge,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 16),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          stock.confidenceLabel,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(color: AppTheme.sky),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          '${stock.opportunityScore.round()}',
                          style: Theme.of(context).textTheme.displayMedium
                              ?.copyWith(fontSize: 42, color: AppTheme.mint),
                        ),
                        Text(
                          'Opportunity score',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Wrap(
                  spacing: 14,
                  runSpacing: 14,
                  children: [
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Regime fit',
                        value: stock.regimeFit,
                        color: AppTheme.sky,
                        definition:
                            'How well this stock matches the kind of market we are in right now.',
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Trend quality',
                        value: stock.trendQuality,
                        color: AppTheme.mint,
                        definition:
                            'Whether the price trend looks healthy and supported, not just whether the stock has gone up lately.',
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Revision trend',
                        value: stock.revisionTrend,
                        color: AppTheme.amber,
                        definition:
                            'Whether earnings and business expectations are improving or drifting lower.',
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Fragility',
                        value: stock.fragilityScore,
                        color: AppTheme.coral,
                        definition:
                            'How easily this thesis could crack if sentiment, options positioning, or price behavior turns against it.',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
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
                      onSelected: (_) => onToggleWatchlist(),
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
                      onSelected: (_) => onToggleSavedIdea(),
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
                      onSelected: (_) => onToggleAlertSubscription(),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                if (twoColumn)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: _BulletSection(
                          title: 'Why it ranks',
                          items: stock.whyItRanks,
                          accent: AppTheme.mint,
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: _BulletSection(
                          title: 'What could go wrong',
                          items: stock.whatCouldGoWrong,
                          accent: AppTheme.amber,
                        ),
                      ),
                    ],
                  )
                else
                  Column(
                    children: [
                      _BulletSection(
                        title: 'Why it ranks',
                        items: stock.whyItRanks,
                        accent: AppTheme.mint,
                      ),
                      const SizedBox(height: 16),
                      _BulletSection(
                        title: 'What could go wrong',
                        items: stock.whatCouldGoWrong,
                        accent: AppTheme.amber,
                      ),
                    ],
                  ),
                const SizedBox(height: 16),
                FilledButton.tonalIcon(
                  onPressed: onOpen,
                  icon: const Icon(Icons.insights_rounded),
                  label: const Text('Open stock intelligence'),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

const _opportunityBoardGuideEntries = [
  GuideEntry(
    term: 'Opportunity score',
    definition:
        'The app’s overall read on how attractive a setup looks right now after blending upside, quality, regime fit, and downside risk.',
  ),
  GuideEntry(
    term: 'Regime fit',
    definition:
        'A stock can be good in general but still be a poor fit for the current market. This asks whether the setup matches today’s environment.',
  ),
  GuideEntry(
    term: 'Trend quality',
    definition:
        'This looks at how healthy the move is. Strong trend quality means the price action has support instead of feeling thin or forced.',
  ),
  GuideEntry(
    term: 'Revision trend',
    definition:
        'This is the direction of analyst and business expectations. Improving revisions usually help a thesis stay alive.',
  ),
  GuideEntry(
    term: 'Fragility',
    definition:
        'Fragility is the “how easily could this break?” score. Higher fragility means less room for error.',
  ),
  GuideEntry(
    term: 'Why it ranks vs what could go wrong',
    definition:
        'The left column summarizes the evidence supporting the setup. The right column highlights the most likely ways the story could disappoint.',
  ),
];

class _BulletSection extends StatelessWidget {
  const _BulletSection({
    required this.title,
    required this.items,
    required this.accent,
  });

  final String title;
  final List<String> items;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 10),
        BulletList(items: items, accent: accent),
      ],
    );
  }
}
