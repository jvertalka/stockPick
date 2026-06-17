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
    this.rankedUniverse = const <StockInsight>[],
  });

  final List<ScenarioOutcome> scenarios;
  final ScenarioType? selectedScenario;
  final ValueChanged<ScenarioType> onSelectScenario;
  final List<StockInsight> rankedUniverse;

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
              if (scenario.probability > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 18),
                  child: InsightCard(
                    child: Row(
                      children: [
                        const Icon(Icons.casino_outlined,
                            color: AppTheme.amber, size: 22),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'Scenario probability: ${scenario.probability.toStringAsFixed(0)}%. This is the rough odds the scenario becomes reality from here — not a forecast of when.',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
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
                    if (scenario.fullBoardImpacts.length >
                        scenario.stockImpacts.length)
                      _FullBoardExpander(
                          impacts: scenario.fullBoardImpacts),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              CustomScenarioBuilder(universe: rankedUniverse),
            ],
          );
        },
      ),
    );
  }
}

class _FullBoardExpander extends StatelessWidget {
  const _FullBoardExpander({required this.impacts});

  final List<ScenarioStockImpact> impacts;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        leading: const Icon(Icons.unfold_more_rounded, color: AppTheme.sky),
        title: Text(
          'Full board impacts (${impacts.length} names)',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        children: impacts
            .map(
              (impact) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Row(
                  children: [
                    SizedBox(
                      width: 70,
                      child: Text(
                        impact.ticker,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ),
                    Expanded(
                      child: Text(
                        impact.action,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    SizedBox(
                      width: 64,
                      child: Text(
                        impact.deltaOpportunity >= 0
                            ? '+${impact.deltaOpportunity.toStringAsFixed(1)}'
                            : impact.deltaOpportunity.toStringAsFixed(1),
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                              color: impact.deltaOpportunity >= 0
                                  ? AppTheme.mint
                                  : AppTheme.coral,
                            ),
                        textAlign: TextAlign.right,
                      ),
                    ),
                  ],
                ),
              ),
            )
            .toList(),
      ),
    );
  }
}

/// User-supplied shock builder. Re-ranks the passed universe in-view using a
/// lightweight formula so the user can play with scenarios without a repo
/// round-trip.
class CustomScenarioBuilder extends StatefulWidget {
  const CustomScenarioBuilder({super.key, required this.universe});

  final List<StockInsight> universe;

  @override
  State<CustomScenarioBuilder> createState() => _CustomScenarioBuilderState();
}

class _CustomScenarioBuilderState extends State<CustomScenarioBuilder> {
  double _creditShock = 0;
  double _volShock = 0;
  double _growthShock = 0;
  double _rateShock = 0;
  double _breadthShock = 0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (widget.universe.isEmpty) return const SizedBox.shrink();

    final impacts = widget.universe.map(_computeImpact).toList()
      ..sort((a, b) =>
          b.deltaOpportunity.abs().compareTo(a.deltaOpportunity.abs()));

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.tune_rounded, color: AppTheme.mint, size: 22),
              const SizedBox(width: 8),
              Text('Custom scenario builder',
                  style: theme.textTheme.headlineMedium),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Drag the sliders to shock credit, vol, factor leadership, rates, and breadth. The board re-ranks in place. Positive deltas mean the name looks better under the shock.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          _ShockSlider(
            label: 'Credit stress shock',
            value: _creditShock,
            onChanged: (v) => setState(() => _creditShock = v),
          ),
          _ShockSlider(
            label: 'Implied volatility shock',
            value: _volShock,
            onChanged: (v) => setState(() => _volShock = v),
          ),
          _ShockSlider(
            label: 'Growth leadership shock',
            value: _growthShock,
            onChanged: (v) => setState(() => _growthShock = v),
          ),
          _ShockSlider(
            label: 'Rate shock (bps-equivalent)',
            value: _rateShock,
            range: 100,
            onChanged: (v) => setState(() => _rateShock = v),
          ),
          _ShockSlider(
            label: 'Breadth shock',
            value: _breadthShock,
            onChanged: (v) => setState(() => _breadthShock = v),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              TextButton.icon(
                onPressed: () {
                  setState(() {
                    _creditShock = 0;
                    _volShock = 0;
                    _growthShock = 0;
                    _rateShock = 0;
                    _breadthShock = 0;
                  });
                },
                icon: const Icon(Icons.refresh_rounded, size: 18),
                label: const Text('Reset'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Top moves under this scenario',
            style: theme.textTheme.titleLarge,
          ),
          const SizedBox(height: 10),
          ...impacts.take(10).map(
                (impact) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 64,
                        child: Text(impact.ticker,
                            style: theme.textTheme.titleSmall),
                      ),
                      Expanded(
                        child: Text(
                          impact.rationale,
                          style: theme.textTheme.bodySmall,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      SizedBox(
                        width: 64,
                        child: Text(
                          impact.deltaOpportunity >= 0
                              ? '+${impact.deltaOpportunity.toStringAsFixed(1)}'
                              : impact.deltaOpportunity.toStringAsFixed(1),
                          style: theme.textTheme.titleSmall?.copyWith(
                            color: impact.deltaOpportunity >= 0
                                ? AppTheme.mint
                                : AppTheme.coral,
                          ),
                          textAlign: TextAlign.right,
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

  ScenarioStockImpact _computeImpact(StockInsight stock) {
    // Delta model mirrors the engine's preset scenarios with summed weights.
    final delta = 0.08 *
            (_creditShock.abs() >= 0.1
                ? -_creditShock * _riskAlignment(stock)
                : 0) +
        0.09 *
            (_volShock.abs() >= 0.1
                ? -_volShock * stock.fragilityScore / 100
                : 0) +
        0.10 *
            (_growthShock.abs() >= 0.1
                ? _growthShock *
                    (stock.regimeFit + stock.trendQuality - 100) /
                    100
                : 0) +
        0.07 *
            (_rateShock.abs() >= 0.1
                ? _rateShock / 100 * _rateAlignment(stock)
                : 0) +
        0.08 *
            (_breadthShock.abs() >= 0.1
                ? _breadthShock * stock.convictionScore / 100
                : 0);
    final action = _actionFor(delta);
    final rationale = _rationaleFor(stock, delta);
    return ScenarioStockImpact(
      ticker: stock.ticker,
      action: action,
      deltaOpportunity: delta,
      rationale: rationale,
    );
  }

  double _riskAlignment(StockInsight stock) {
    return (stock.riskScore - 50) / 50;
  }

  double _rateAlignment(StockInsight stock) {
    // Crude proxy: stocks with better conviction + lower fragility benefit
    // more from rate easing.
    return ((stock.convictionScore - stock.fragilityScore) / 100)
        .clamp(-1.0, 1.0);
  }

  String _actionFor(double delta) {
    if (delta >= 6) return 'Up-rank';
    if (delta >= 2) return 'Hold firmer';
    if (delta <= -6) return 'Cut risk';
    if (delta <= -2) return 'De-risk';
    return 'Hold neutral';
  }

  String _rationaleFor(StockInsight stock, double delta) {
    if (delta >= 2) {
      return '${stock.sector} fit softens the shock';
    }
    if (delta <= -2) {
      return '${stock.sector} exposure gets hit harder than average';
    }
    return '${stock.sector} — roughly neutral';
  }
}

class _ShockSlider extends StatelessWidget {
  const _ShockSlider({
    required this.label,
    required this.value,
    required this.onChanged,
    this.range = 20,
  });

  final String label;
  final double value;
  final ValueChanged<double> onChanged;
  final double range;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(label, style: theme.textTheme.titleSmall),
              ),
              Text(
                value >= 0
                    ? '+${value.toStringAsFixed(1)}'
                    : value.toStringAsFixed(1),
                style: theme.textTheme.titleSmall,
              ),
            ],
          ),
          Slider(
            value: value,
            min: -range,
            max: range,
            divisions: (range * 4).toInt(),
            onChanged: onChanged,
          ),
        ],
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
