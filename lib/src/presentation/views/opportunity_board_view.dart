import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class OpportunityBoardView extends StatelessWidget {
  const OpportunityBoardView({
    super.key,
    required this.stocks,
    required this.onOpenStock,
  });

  final List<StockInsight> stocks;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final hasStocks = stocks.isNotEmpty;
    final topIdeas = stocks.take(3).map((stock) => stock.ticker).join(' | ');

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
              label: hasStocks ? 'Top board: $topIdeas' : 'Awaiting ranked stocks',
              tone: hasStocks ? SignalTone.positive : SignalTone.neutral,
            ),
          ),
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
                  onOpen: () => onOpenStock(stock.ticker),
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
  const _OpportunityCard({required this.stock, required this.onOpen});

  final StockInsight stock;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
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
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Trend quality',
                        value: stock.trendQuality,
                        color: AppTheme.mint,
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Revision trend',
                        value: stock.revisionTrend,
                        color: AppTheme.amber,
                      ),
                    ),
                    SizedBox(
                      width: 160,
                      child: ScoreBar(
                        label: 'Fragility',
                        value: stock.fragilityScore,
                        color: AppTheme.coral,
                      ),
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
