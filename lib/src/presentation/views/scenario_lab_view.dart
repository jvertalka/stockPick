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
  final ScenarioType selectedScenario;
  final ValueChanged<ScenarioType> onSelectScenario;

  @override
  Widget build(BuildContext context) {
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
