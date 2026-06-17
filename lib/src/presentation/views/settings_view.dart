import 'package:flutter/material.dart';

import '../../models/app_settings_models.dart';
import '../../models/intelligence_app_state.dart';
import '../../models/market_intelligence.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class SettingsView extends StatefulWidget {
  const SettingsView({
    super.key,
    required this.settings,
    required this.dataStatus,
    required this.engineStatus,
    required this.onSettingsChanged,
  });

  final AppSettings settings;
  final DataStatusReport dataStatus;
  final EngineStatusReport engineStatus;
  final ValueChanged<AppSettings> onSettingsChanged;

  @override
  State<SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<SettingsView> {
  final TextEditingController _tickerController = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _tickerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final configuredFeeds = widget.dataStatus.feeds
        .where((feed) => feed.availability == FeedAvailability.connected)
        .length;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final sectionWidth = adaptivePanelWidth(
            constraints.maxWidth,
            maxColumns: 2,
            minWidth: 340,
          );
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ViewHeader(
                eyebrow: 'Settings',
                title: 'Control the universe and data readiness.',
                subtitle:
                    'Manage local tickers, see which feeds are actually connected, and keep the model-readiness gates visible before trusting stronger actions.',
                trailing: TonePill(
                  label: '$configuredFeeds connected feeds',
                  tone: configuredFeeds > 0
                      ? SignalTone.positive
                      : SignalTone.caution,
                ),
              ),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: _UniverseSettingsCard(
                      settings: widget.settings,
                      controller: _tickerController,
                      error: _error,
                      onAdd: _addTicker,
                      onRemove: _removeTicker,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _DataKeysCard(dataStatus: widget.dataStatus),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _ModelReadinessCard(
                      report: widget.engineStatus.validationReport,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _RuntimeCaveatsCard(
                      caveats: widget.engineStatus.caveats,
                      nextSteps: widget.engineStatus.nextSteps,
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

  void _addTicker() {
    final ticker = normalizeSettingsTicker(_tickerController.text);
    if (ticker.isEmpty) {
      setState(() {
        _error = 'Enter a valid ticker.';
      });
      return;
    }
    final next = widget.settings.addTicker(ticker);
    widget.onSettingsChanged(next);
    _tickerController.clear();
    setState(() {
      _error = null;
    });
  }

  void _removeTicker(String ticker) {
    widget.onSettingsChanged(widget.settings.removeTicker(ticker));
  }
}

class _UniverseSettingsCard extends StatelessWidget {
  const _UniverseSettingsCard({
    required this.settings,
    required this.controller,
    required this.onAdd,
    required this.onRemove,
    this.error,
  });

  final AppSettings settings;
  final TextEditingController controller;
  final VoidCallback onAdd;
  final ValueChanged<String> onRemove;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Universe manager',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 10),
          Text(
            'Tickers added here appear immediately in the app as tracked names. They become fully actionable only after the connected data providers return real coverage.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(
                    labelText: 'Add ticker',
                    border: const OutlineInputBorder(),
                    errorText: error,
                  ),
                  onSubmitted: (_) => onAdd(),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton.icon(
                onPressed: onAdd,
                icon: const Icon(Icons.add_rounded),
                label: const Text('Add'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (settings.customUniverseTickers.isEmpty)
            const EmptyStateCard(
              icon: Icons.playlist_add_rounded,
              title: 'No custom tickers yet.',
              message:
                  'Add tickers you want tracked even when they are not already in the configured provider universe.',
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: settings.customUniverseTickers
                  .map(
                    (ticker) => InputChip(
                      label: Text(ticker),
                      avatar: const Icon(Icons.add_chart_rounded, size: 16),
                      onDeleted: () => onRemove(ticker),
                    ),
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }
}

class _DataKeysCard extends StatelessWidget {
  const _DataKeysCard({required this.dataStatus});

  final DataStatusReport dataStatus;

  @override
  Widget build(BuildContext context) {
    final important = dataStatus.feeds
        .where(
          (feed) =>
              feed.name.contains('Alpha Vantage') ||
              feed.name.contains('Finnhub') ||
              feed.name.contains('FRED') ||
              feed.name.contains('Provider coverage'),
        )
        .toList();
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Provider readiness',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 10),
          Text(
            'Set keys with dart-defines or local_secrets.dart. Refresh after changing them so the repository can rebuild the current state.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          ...important.map(
            (feed) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _FeedReadinessRow(feed: feed),
            ),
          ),
        ],
      ),
    );
  }
}

class _FeedReadinessRow extends StatelessWidget {
  const _FeedReadinessRow({required this.feed});

  final DataFeedStatus feed;

  @override
  Widget build(BuildContext context) {
    final tone = switch (feed.availability) {
      FeedAvailability.connected => SignalTone.positive,
      FeedAvailability.fixture => SignalTone.neutral,
      FeedAvailability.planned => SignalTone.caution,
      FeedAvailability.missing => SignalTone.negative,
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.03),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  feed.name,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              TonePill(label: feed.availability.label, tone: tone),
            ],
          ),
          const SizedBox(height: 8),
          Text(feed.detail, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _ModelReadinessCard extends StatelessWidget {
  const _ModelReadinessCard({required this.report});

  final ValidationReport report;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Model readiness',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 10),
          Text(
            report.modelReadiness.summary,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          ...report.modelReadiness.gates.map(
            (gate) => LabelValueRow(
              label: gate.label,
              value: '${gate.current} / ${gate.minimum}',
              highlight: gate.passed ? AppTheme.mint : AppTheme.amber,
            ),
          ),
        ],
      ),
    );
  }
}

class _RuntimeCaveatsCard extends StatelessWidget {
  const _RuntimeCaveatsCard({required this.caveats, required this.nextSteps});

  final List<String> caveats;
  final List<String> nextSteps;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Production checklist',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 12),
          BulletList(items: caveats, accent: AppTheme.amber),
          const SizedBox(height: 12),
          Text('Next moves', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          BulletList(items: nextSteps, accent: AppTheme.mint),
        ],
      ),
    );
  }
}
