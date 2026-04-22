import 'package:flutter/material.dart';

import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class SellAlertsView extends StatelessWidget {
  const SellAlertsView({super.key, required this.alerts});

  final List<SellAlert> alerts;

  @override
  Widget build(BuildContext context) {
    final trimCount = alerts
        .where((alert) => alert.action == RecommendationAction.trim)
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
            maxColumns: 3,
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
                    ),
                  ),
                  SizedBox(
                    width: statWidth,
                    child: MetricTile(
                      label: 'Exit alerts',
                      value: '$exitCount',
                      detail: 'Theses that now look broken or unrewarding.',
                      tone: SignalTone.negative,
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
                        const SizedBox(height: 8),
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
