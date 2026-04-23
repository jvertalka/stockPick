import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class ScenarioLabView extends StatelessWidget {
  const ScenarioLabView({
    super.key,
    required this.scenarios,
    required this.selectedScenario,
    required this.onSelectScenario,
  });

  final List<ScenarioOutcome> scenarios;
  final ScenarioType? selectedScenario;
  final ValueChanged<ScenarioType> onSelectScenario;

  @override
  Widget build(BuildContext context) {
    if (scenarios.isEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
        child: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ViewHeader(
              eyebrow: 'Scenario Lab',
              title:
                  'Stress testing comes online once the current board exists.',
              subtitle:
                  'Scenario re-ranking depends on a populated opportunity set, so this view stays in standby until the repository can produce one.',
              trailing: TonePill(
                label: 'Awaiting scenarios',
                tone: SignalTone.neutral,
              ),
            ),
            PlainEnglishGuideCard(
              summary:
                  'This screen answers a simple what-if question: if the market mood changes, which kinds of stocks should become more or less attractive?',
              entries: _scenarioLabGuideEntries,
            ),
            SizedBox(height: 18),
            HowThisIsCalculatedCard(
              summary:
                  'Scenario scores re-rank the same opportunity set under alternate market conditions rather than inventing a separate stock list.',
              entries: _scenarioCalculationEntries,
            ),
            SizedBox(height: 18),
            EmptyStateCard(
              icon: Icons.science_rounded,
              title: 'No scenario outputs yet.',
              message:
                  'The lab will populate after the engine can score stocks and translate them into scenario-specific deltas.',
            ),
          ],
        ),
      );
    }

    final scenario = scenarios.firstWhere(
      (item) => item.type == selectedScenario,
      orElse: () => scenarios.first,
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
                eyebrow: 'Scenario Lab',
                title: 'Stress the thesis before the market does it for you.',
                subtitle:
                    'Ask how the board changes if credit widens, volatility reprices, or factor leadership rotates away from what is working now.',
                trailing: TonePill(
                  label: scenario.type.label,
                  tone: SignalTone.neutral,
                ),
              ),
              const PlainEnglishGuideCard(
                summary:
                    'This screen answers a simple what-if question: if the market mood changes, which kinds of stocks should become more or less attractive?',
                entries: _scenarioLabGuideEntries,
              ),
              const SizedBox(height: 18),
              const HowThisIsCalculatedCard(
                summary:
                    'Scenario sensitivity shows how violently the ranked board would change if a given macro shock became real.',
                entries: _scenarioCalculationEntries,
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: scenarios
                    .map(
                      (item) => ChoiceChip(
                        selected: item.type == selectedScenario,
                        label: Text(item.type.label),
                        onSelected: (_) => onSelectScenario(item.type),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 18),
              InsightCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      scenario.title,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      scenario.description,
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Regime implication',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      scenario.regimeImpact,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              MetricTile(
                label: 'Scenario sensitivity',
                value: scenario.sensitivityScore.toStringAsFixed(1),
                detail:
                    'Average size of the opportunity-score changes this scenario would create across the board.',
                tone: SignalTone.caution,
                trend: scenario.sensitivityTrend,
                definition:
                    'Higher sensitivity means this scenario would reshuffle the board more aggressively.',
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
                            'Favored exposures',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          BulletList(
                            items: scenario.favoredExposures,
                            accent: AppTheme.mint,
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
                            'Vulnerable exposures',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 14),
                          BulletList(
                            items: scenario.vulnerableExposures,
                            accent: AppTheme.coral,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              InsightCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Re-ranked names',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 14),
                    ...scenario.stockImpacts.map(
                      (impact) => Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    impact.ticker,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.titleLarge,
                                  ),
                                ),
                                Text(
                                  impact.action,
                                  style: Theme.of(context).textTheme.titleMedium
                                      ?.copyWith(
                                        color: impact.deltaOpportunity >= 0
                                            ? AppTheme.mint
                                            : AppTheme.coral,
                                      ),
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  impact.deltaOpportunity >= 0
                                      ? '+${impact.deltaOpportunity.round()}'
                                      : '${impact.deltaOpportunity.round()}',
                                  style: Theme.of(context).textTheme.titleMedium
                                      ?.copyWith(
                                        color: impact.deltaOpportunity >= 0
                                            ? AppTheme.mint
                                            : AppTheme.coral,
                                      ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              impact.rationale,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

const _scenarioLabGuideEntries = [
  GuideEntry(
    term: 'Scenario',
    definition:
        'A scenario is a stress test. The app imagines a market change and asks how today’s opportunity board would look in that alternate world.',
  ),
  GuideEntry(
    term: 'Favored exposures',
    definition:
        'These are the kinds of businesses or styles that should hold up better if that scenario plays out.',
  ),
  GuideEntry(
    term: 'Vulnerable exposures',
    definition:
        'These are the setups most likely to struggle if the assumed scenario becomes real.',
  ),
  GuideEntry(
    term: 'Re-ranked names',
    definition:
        'The same stocks are rescored under the new scenario so you can see which ideas would likely rise or fall in priority.',
  ),
  GuideEntry(
    term: 'Delta opportunity',
    definition:
        'This is the change in attractiveness under the scenario. Positive means the setup would likely look better; negative means worse.',
  ),
];

const _scenarioCalculationEntries = [
  CalculationEntry(
    title: 'Scenario sensitivity',
    summary:
        'A simple stress-intensity score based on how much the ranked names would move up or down under the scenario.',
    drivers: [
      'Change in opportunity score for the impacted names',
      'How broad the repricing is across the board',
      'How severe the regime change is for the current leaders',
    ],
    interpretation:
        'Higher means the scenario would force a larger rethink of the board. Lower means the ranking is more stable under that shock.',
  ),
  CalculationEntry(
    title: 'Favored and vulnerable exposures',
    summary:
        'Each scenario defines the business styles that should benefit or suffer if the stress becomes real.',
    drivers: [
      'Credit sensitivity and balance-sheet quality',
      'Growth versus defensive exposure',
      'Expected stability and crowding sensitivity',
    ],
    interpretation:
        'These are structural tendencies, not hard predictions about a single stock on a single day.',
  ),
];
