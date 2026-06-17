import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';
import '../widgets/oracle_widgets.dart';

class SellAlertsView extends StatelessWidget {
  const SellAlertsView({super.key, required this.alerts});

  final List<SellAlert> alerts;

  @override
  Widget build(BuildContext context) {
    if (alerts.isEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
        child: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ViewHeader(
              eyebrow: 'Sell Alerts',
              title:
                  'Clusters of deterioration matter more than one indicator.',
              subtitle:
                  'This board stays quiet until enough evidence accumulates to justify trimming, de-risking, or exiting.',
              trailing: TonePill(
                label: '0 active alerts',
                tone: SignalTone.neutral,
              ),
            ),
            PlainEnglishGuideCard(
              summary:
                  'This screen is about protecting discipline. It waits for several warning signs to agree before telling you to trim, de-risk, or leave.',
              entries: _sellAlertsGuideEntries,
            ),
            SizedBox(height: 18),
            EmptyStateCard(
              icon: Icons.warning_amber_rounded,
              title: 'No sell alerts yet.',
              message:
                  'That usually means the current snapshot has not produced a strong enough deterioration cluster to escalate.',
            ),
          ],
        ),
      );
    }

    final trimCount = alerts
        .where((alert) => alert.action == RecommendationAction.trim)
        .length;
    final deRiskCount = alerts
        .where((alert) => alert.action == RecommendationAction.deRisk)
        .length;
    final exitCount = alerts
        .where((alert) => alert.action == RecommendationAction.exit)
        .length;
    final avgClusters =
        alerts.fold<int>(0, (sum, alert) => sum + alert.clusterCount) /
        alerts.length;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final statWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 4,
            minWidth: 220,
          );

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ViewHeader(
                eyebrow: 'Sell Alerts',
                title:
                    'Clusters of deterioration matter more than one indicator.',
                subtitle:
                    'This board is designed to protect discipline. It only escalates when multiple pieces of evidence start leaning the same way.',
                trailing: TonePill(
                  label: '${alerts.length} active alerts',
                  tone: SignalTone.caution,
                ),
              ),
              const PlainEnglishGuideCard(
                summary:
                    'This screen is about protecting discipline. It waits for several warning signs to agree before telling you to trim, de-risk, or leave.',
                entries: _sellAlertsGuideEntries,
              ),
              const SizedBox(height: 18),
              InsightCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Sell discipline engine',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'The engine distinguishes between trimming, de-risking, and full exits. It avoids reacting to one moving average break or one scary headline, and instead waits for a cluster: relative strength rollover, sector breadth damage, volatility repricing, and price-response failure.',
                      style: Theme.of(context).textTheme.bodyLarge,
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
                    width: statWidth,
                    child: MetricTile(
                      label: 'Trim candidates',
                      value: '$trimCount',
                      detail:
                          'Stories that still work, but with less upside than before.',
                      tone: SignalTone.caution,
                      definition:
                          'Ideas where the thesis is not fully broken, but the reward has shrunk enough that smaller size makes more sense.',
                    ),
                  ),
                  SizedBox(
                    width: statWidth,
                    child: MetricTile(
                      label: 'De-risk alerts',
                      value: '$deRiskCount',
                      detail:
                          'Stories where the evidence has weakened enough to cut exposure more meaningfully.',
                      tone: deRiskCount > 0
                          ? SignalTone.caution
                          : SignalTone.neutral,
                      definition:
                          'De-risk means the thesis still has pieces working, but the cluster of warnings is now strong enough to reduce exposure aggressively.',
                    ),
                  ),
                  SizedBox(
                    width: statWidth,
                    child: MetricTile(
                      label: 'Exit alerts',
                      value: '$exitCount',
                      detail: 'Theses that now look broken or unrewarding.',
                      tone: SignalTone.negative,
                      definition:
                          'Ideas where enough evidence has gone wrong that the app no longer sees a good reason to stay in the trade.',
                    ),
                  ),
                  SizedBox(
                    width: statWidth,
                    child: MetricTile(
                      label: 'Average cluster size',
                      value: avgClusters.toStringAsFixed(1),
                      detail:
                          'How many deterioration signals tend to agree before the board escalates.',
                      tone: SignalTone.neutral,
                      definition:
                          'A cluster is a group of separate warning signs pointing the same way. Bigger clusters mean the warning is broader, not just louder.',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              ...alerts.map(
                (alert) => Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: InsightCard(
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
                                  Row(
                                    children: [
                                      Text(
                                        alert.ticker,
                                        style: Theme.of(context)
                                            .textTheme
                                            .displayMedium
                                            ?.copyWith(fontSize: 34),
                                      ),
                                      const SizedBox(width: 12),
                                      ActionBadge(action: alert.action),
                                    ],
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    alert.company,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.titleMedium,
                                  ),
                                  const SizedBox(height: 12),
                                  Text(
                                    alert.summary,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.bodyLarge,
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 16),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                SeverityBadge(severity: alert.severity),
                                const SizedBox(height: 12),
                                Text(
                                  '${alert.thesisDamageScore.round()}',
                                  style: Theme.of(context)
                                      .textTheme
                                      .displayMedium
                                      ?.copyWith(
                                        fontSize: 40,
                                        color: AppTheme.coral,
                                      ),
                                ),
                                Text(
                                  'Damage score',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ],
                        ),
                        const SizedBox(height: 18),
                        LabelValueRow(
                          label: 'Deterioration cluster count',
                          value: '${alert.clusterCount}',
                          highlight: AppTheme.amber,
                          definition:
                              'How many separate warning signs agreed strongly enough to trigger this alert.',
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Trigger cluster',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 10),
                        BulletList(
                          items: alert.triggers,
                          accent: AppTheme.coral,
                        ),
                        const SizedBox(height: 10),
                        LabelValueRow(
                          label: 'Effective cluster weight',
                          value: alert.effectiveClusterWeight.toStringAsFixed(
                            2,
                          ),
                          highlight: AppTheme.amber,
                          definition:
                              'Time-decayed sum of deterioration signal weights. A fresh signal contributes ~1.0; a signal older than ~7 sessions contributes ~0.5.',
                        ),
                        LabelValueRow(
                          label: 'Exit probability',
                          value: '${alert.exitProbability.round()}%',
                          highlight: AppTheme.coral,
                          definition:
                              'Rough probability that this turns into an outright exit within the next few sessions given current evidence.',
                        ),
                        const SizedBox(height: 12),
                        if (alert.decayedTriggers.isNotEmpty) ...[
                          DecayedTriggersCard(signals: alert.decayedTriggers),
                          const SizedBox(height: 12),
                        ],
                        if (alert.macroGates.isNotEmpty) ...[
                          MacroGatesCard(gates: alert.macroGates),
                          const SizedBox(height: 12),
                        ],
                        if (alert.correlationCluster != null) ...[
                          CorrelationClusterCard(
                            cluster: alert.correlationCluster!,
                          ),
                          const SizedBox(height: 12),
                        ],
                        Text(
                          'Next check: ${alert.nextCheck}',
                          style: Theme.of(
                            context,
                          ).textTheme.bodyMedium?.copyWith(color: AppTheme.sky),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

const _sellAlertsGuideEntries = [
  GuideEntry(
    term: 'Deterioration cluster',
    definition:
        'A cluster means several independent warning signs are leaning negative at the same time, which is more trustworthy than one scary signal by itself.',
  ),
  GuideEntry(
    term: 'Trim, de-risk, exit',
    definition:
        'These are escalating actions. Trim means reduce a winner. De-risk means cut exposure more meaningfully. Exit means the thesis now looks broken or not worth the pain.',
  ),
  GuideEntry(
    term: 'Damage score',
    definition:
        'A quick summary of how badly the evidence is hurting the original story. Higher means the setup is under more pressure.',
  ),
  GuideEntry(
    term: 'Trigger cluster',
    definition:
        'These are the exact signs that caused the alert, such as weakening price response, fading breadth, or rising options stress.',
  ),
  GuideEntry(
    term: 'Next check',
    definition:
        'The follow-up clue that would help decide whether the setup is stabilizing or still getting worse.',
  ),
];
