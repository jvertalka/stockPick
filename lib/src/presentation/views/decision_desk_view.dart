import 'package:flutter/material.dart';

import '../../engine/portfolio_decision_engine.dart';
import '../../models/market_intelligence.dart';
import '../../models/portfolio_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';

class DecisionDeskView extends StatefulWidget {
  const DecisionDeskView({
    super.key,
    required this.snapshot,
    required this.portfolioState,
    required this.report,
    required this.onPortfolioChanged,
    required this.onOpenStock,
  });

  final MarketIntelligenceSnapshot snapshot;
  final PortfolioState portfolioState;
  final PortfolioDecisionReport report;
  final ValueChanged<PortfolioState> onPortfolioChanged;
  final ValueChanged<String> onOpenStock;

  @override
  State<DecisionDeskView> createState() => _DecisionDeskViewState();
}

class _DecisionDeskViewState extends State<DecisionDeskView> {
  final TextEditingController _csvController = TextEditingController();
  final TextEditingController _tickerController = TextEditingController();
  final TextEditingController _sharesController = TextEditingController();
  final TextEditingController _costController = TextEditingController();
  PortfolioImportResult? _lastImport;
  String? _manualError;

  @override
  void dispose() {
    _csvController.dispose();
    _tickerController.dispose();
    _sharesController.dispose();
    _costController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hasPortfolio = widget.portfolioState.holdings.isNotEmpty;
    final riskDecisions = [
      ...widget.report.sellDecisions,
      ...widget.report.trimDecisions,
    ];

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
                eyebrow: 'Decision Desk',
                title: 'Buy, hold, trim, and sell in plain English.',
                subtitle:
                    'This turns the insight dashboard into an investing workflow: what looks attractive, what you already own, what needs patience, and what deserves risk control.',
                trailing: TonePill(
                  label: hasPortfolio
                      ? '${widget.portfolioState.holdings.length} holdings imported'
                      : 'Import holdings to personalize',
                  tone: hasPortfolio ? SignalTone.positive : SignalTone.neutral,
                ),
              ),
              const PlainEnglishGuideCard(
                summary:
                    'The Decision Desk is a research assistant. It creates clear decision points, but it does not place trades and it should not replace your own judgment.',
                entries: _decisionGuideEntries,
              ),
              const SizedBox(height: 18),
              const HowThisIsCalculatedCard(
                summary:
                    'Decisions are derived from opportunity, regime fit, confidence, fragility, risk, and active sell-alert evidence.',
                entries: _decisionCalculationEntries,
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Buy candidates',
                      value: '${widget.report.buyCandidates.length}',
                      detail:
                          'Unowned names with enough opportunity, regime fit, and confidence to research for purchase.',
                      tone: SignalTone.positive,
                      definition:
                          'A buy candidate is a research shortlist item. It means the setup clears the app threshold, not that you should submit an order blindly.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Hold decisions',
                      value: '${widget.report.holdDecisions.length}',
                      detail:
                          'Imported holdings where the thesis still looks intact and risk has not crossed the reduction line.',
                      tone: SignalTone.neutral,
                      definition:
                          'Hold means the app does not see enough new damage to reduce the position right now.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Trim / sell',
                      value: '${widget.report.riskDecisionCount}',
                      detail:
                          'Owned names where risk control now matters more than simply waiting.',
                      tone: widget.report.riskDecisionCount > 0
                          ? SignalTone.caution
                          : SignalTone.neutral,
                      definition:
                          'Trim means reduce exposure. Sell means thesis damage is high enough that the app would prioritize exiting.',
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'Portfolio matched',
                      value: '${widget.report.ownedDecisionCount}',
                      detail:
                          'Imported holdings the app could match to the current research universe.',
                      tone: hasPortfolio
                          ? SignalTone.positive
                          : SignalTone.neutral,
                      definition:
                          'Matched holdings are the tickers that exist in both your imported positions and the app research universe.',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              _NarrativeCard(report: widget.report),
              const SizedBox(height: 18),
              _buildPortfolioControls(context),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: _DecisionSection(
                      title: 'Buy candidates',
                      icon: Icons.trending_up_rounded,
                      decisions: widget.report.buyCandidates,
                      emptyTitle: 'No buy candidates cleared the bar.',
                      emptyMessage:
                          'The app is waiting for cleaner upside, better regime fit, or lower fragility before surfacing new buys.',
                      onOpenStock: widget.onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _DecisionSection(
                      title: 'Hold',
                      icon: Icons.pause_circle_outline_rounded,
                      decisions: widget.report.holdDecisions,
                      emptyTitle: 'No hold decisions yet.',
                      emptyMessage:
                          'Import holdings to see which owned names still have an intact thesis.',
                      onOpenStock: widget.onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _DecisionSection(
                      title: 'Trim / sell review',
                      icon: Icons.shield_outlined,
                      decisions: riskDecisions,
                      emptyTitle: 'No urgent risk-control decisions.',
                      emptyMessage:
                          'Owned names will appear here when sell alerts, fragility, or risk scores cross the reduction line.',
                      onOpenStock: widget.onOpenStock,
                    ),
                  ),
                  SizedBox(
                    width: sectionWidth,
                    child: _DecisionSection(
                      title: 'Watch',
                      icon: Icons.visibility_outlined,
                      decisions: widget.report.watchDecisions,
                      emptyTitle: 'No watch items yet.',
                      emptyMessage:
                          'Names that are interesting but not decisive will land here.',
                      onOpenStock: widget.onOpenStock,
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

  Widget _buildPortfolioControls(BuildContext context) {
    final holdings = widget.portfolioState.holdings;
    final unmatched = widget.report.unmatchedHoldings;
    final import = _lastImport;

    return InsightCard(
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
                      'Portfolio input',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Paste a Fidelity-style positions CSV or add a ticker manually. Everything stays local in this app; there is no Fidelity login, scraping, or trade execution.',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              const TonePill(label: 'Local only', tone: SignalTone.neutral),
            ],
          ),
          const SizedBox(height: 16),
          TextField(
            key: const ValueKey('portfolio-csv-input'),
            controller: _csvController,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(
              labelText: 'Paste positions CSV',
              hintText:
                  'Symbol,Quantity,Average Cost\nNVDA,3,820.10\nMSFT,5,410.00',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              FilledButton.icon(
                key: const ValueKey('import-portfolio-button'),
                onPressed: _importCsv,
                icon: const Icon(Icons.upload_file_rounded),
                label: const Text('Import holdings'),
              ),
              FilledButton.tonalIcon(
                onPressed: holdings.isEmpty ? null : _clearPortfolio,
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Clear holdings'),
              ),
            ],
          ),
          if (import != null) ...[
            const SizedBox(height: 10),
            Text(
              '${import.importedCount} imported, ${import.skippedRows} skipped.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: import.importedAny ? AppTheme.mint : AppTheme.amber,
              ),
            ),
          ],
          const SizedBox(height: 18),
          Text(
            'Quick manual add',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              SizedBox(
                width: 150,
                child: TextField(
                  controller: _tickerController,
                  decoration: const InputDecoration(
                    labelText: 'Ticker',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              SizedBox(
                width: 150,
                child: TextField(
                  controller: _sharesController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Shares',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              SizedBox(
                width: 170,
                child: TextField(
                  controller: _costController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Avg cost',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              FilledButton.tonalIcon(
                onPressed: _addManualHolding,
                icon: const Icon(Icons.add_rounded),
                label: const Text('Add holding'),
              ),
            ],
          ),
          if (_manualError != null) ...[
            const SizedBox(height: 8),
            Text(
              _manualError!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppTheme.coral),
            ),
          ],
          const SizedBox(height: 18),
          if (holdings.isEmpty)
            const EmptyStateCard(
              icon: Icons.account_balance_wallet_outlined,
              title: 'No imported holdings yet.',
              message:
                  'Without holdings, the app can still show buy candidates. With holdings, it can separate buy, hold, trim, and sell decisions.',
            )
          else
            _HoldingsList(
              holdings: holdings,
              unmatchedHoldings: unmatched,
              onRemoveHolding: _removeHolding,
            ),
        ],
      ),
    );
  }

  void _importCsv() {
    final result = parsePortfolioHoldingsCsv(
      _csvController.text,
      existing: widget.portfolioState,
    );
    setState(() {
      _lastImport = result;
      _manualError = null;
    });
    if (result.importedAny) {
      widget.onPortfolioChanged(result.state);
      _csvController.clear();
    }
  }

  void _addManualHolding() {
    final ticker = normalizePortfolioTicker(_tickerController.text);
    final shares = _parseNumber(_sharesController.text);
    final costBasis = _parseNumber(_costController.text);

    if (ticker.isEmpty || shares == null || shares <= 0) {
      setState(() {
        _manualError = 'Enter a ticker and a share quantity above zero.';
      });
      return;
    }

    final next = widget.portfolioState.upsertHolding(
      PortfolioHolding(
        ticker: ticker,
        shares: shares,
        averageCostBasis: costBasis,
        addedAt: DateTime.now(),
      ),
    );
    widget.onPortfolioChanged(next);
    setState(() {
      _manualError = null;
      _lastImport = null;
    });
    _tickerController.clear();
    _sharesController.clear();
    _costController.clear();
  }

  void _removeHolding(String ticker) {
    widget.onPortfolioChanged(widget.portfolioState.removeHolding(ticker));
    setState(() {
      _lastImport = null;
      _manualError = null;
    });
  }

  void _clearPortfolio() {
    widget.onPortfolioChanged(PortfolioState.empty);
    setState(() {
      _lastImport = null;
      _manualError = null;
    });
  }

  double? _parseNumber(String raw) {
    final cleaned = raw.trim().replaceAll(RegExp(r'[\$,%\s]'), '');
    if (cleaned.isEmpty) {
      return null;
    }
    return double.tryParse(cleaned.replaceAll(',', ''));
  }
}

class _NarrativeCard extends StatelessWidget {
  const _NarrativeCard({required this.report});

  final PortfolioDecisionReport report;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: AppTheme.mint.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: AppTheme.mint.withValues(alpha: 0.28),
                  ),
                ),
                child: const Icon(Icons.route_rounded, color: AppTheme.mint),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  'Decision narrative',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(report.summary, style: Theme.of(context).textTheme.bodyLarge),
        ],
      ),
    );
  }
}

class _HoldingsList extends StatelessWidget {
  const _HoldingsList({
    required this.holdings,
    required this.unmatchedHoldings,
    required this.onRemoveHolding,
  });

  final List<PortfolioHolding> holdings;
  final List<PortfolioHolding> unmatchedHoldings;
  final ValueChanged<String> onRemoveHolding;

  @override
  Widget build(BuildContext context) {
    final unmatchedTickers = unmatchedHoldings
        .map((holding) => holding.ticker)
        .toSet();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Imported holdings',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: holdings
              .map(
                (holding) => _HoldingChip(
                  holding: holding,
                  isUnmatched: unmatchedTickers.contains(holding.ticker),
                  onRemove: () => onRemoveHolding(holding.ticker),
                ),
              )
              .toList(),
        ),
      ],
    );
  }
}

class _HoldingChip extends StatelessWidget {
  const _HoldingChip({
    required this.holding,
    required this.isUnmatched,
    required this.onRemove,
  });

  final PortfolioHolding holding;
  final bool isUnmatched;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: (isUnmatched ? AppTheme.amber : AppTheme.mint).withValues(
            alpha: 0.24,
          ),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                holding.ticker,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text(
                '${_formatShares(holding.shares)} shares'
                '${holding.averageCostBasis == null ? '' : ' | avg ${_formatMoney(holding.averageCostBasis!)}'}'
                '${isUnmatched ? ' | not matched' : ''}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          const SizedBox(width: 8),
          IconButton(
            tooltip: 'Remove ${holding.ticker}',
            onPressed: onRemove,
            icon: const Icon(Icons.close_rounded),
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}

class _DecisionSection extends StatelessWidget {
  const _DecisionSection({
    required this.title,
    required this.icon,
    required this.decisions,
    required this.emptyTitle,
    required this.emptyMessage,
    required this.onOpenStock,
  });

  final String title;
  final IconData icon;
  final List<PortfolioDecision> decisions;
  final String emptyTitle;
  final String emptyMessage;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: AppTheme.sky),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
              ),
              TonePill(label: '${decisions.length}', tone: SignalTone.neutral),
            ],
          ),
          const SizedBox(height: 14),
          if (decisions.isEmpty)
            EmptyStateCard(icon: icon, title: emptyTitle, message: emptyMessage)
          else
            ...decisions.map(
              (decision) => Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: _DecisionCard(
                  decision: decision,
                  onOpenStock: onOpenStock,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DecisionCard extends StatelessWidget {
  const _DecisionCard({required this.decision, required this.onOpenStock});

  final PortfolioDecision decision;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final tone = _toneForAction(decision.action);
    final color = toneColor(tone);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: color.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              TonePill(label: decision.action.label, tone: tone),
              if (decision.isOwned)
                const TonePill(label: 'Owned', tone: SignalTone.neutral),
              if (decision.alert != null)
                TonePill(
                  label: '${decision.alert!.severity.label} alert',
                  tone: SignalTone.caution,
                ),
            ],
          ),
          const SizedBox(height: 12),
          Text(decision.title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(
            '${decision.stock.company} | ${decision.stock.industry}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          Text(
            decision.narrative,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          _ScoreStrip(decision: decision),
          const SizedBox(height: 14),
          Text(
            'Why this decision',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          BulletList(items: decision.reasons, accent: color),
          const SizedBox(height: 10),
          Text(
            'What would change it',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          BulletList(items: decision.watchItems, accent: AppTheme.amber),
          const SizedBox(height: 10),
          LabelValueRow(
            label: 'Next check',
            value: decision.nextCheck,
            highlight: AppTheme.sky,
          ),
          const SizedBox(height: 12),
          FilledButton.tonalIcon(
            onPressed: () => onOpenStock(decision.stock.ticker),
            icon: const Icon(Icons.insights_rounded),
            label: const Text('Open stock intelligence'),
          ),
        ],
      ),
    );
  }
}

class _ScoreStrip extends StatelessWidget {
  const _ScoreStrip({required this.decision});

  final PortfolioDecision decision;

  @override
  Widget build(BuildContext context) {
    final stock = decision.stock;
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        _MiniScore(
          label: 'Decision',
          value: decision.score,
          color: AppTheme.mint,
        ),
        _MiniScore(
          label: 'Opportunity',
          value: stock.opportunityScore,
          color: AppTheme.mint,
        ),
        _MiniScore(label: 'Fit', value: stock.regimeFit, color: AppTheme.sky),
        _MiniScore(
          label: 'Fragility',
          value: stock.fragilityScore,
          color: AppTheme.amber,
        ),
        _MiniScore(
          label: 'Risk',
          value: stock.riskScore,
          color: AppTheme.coral,
        ),
      ],
    );
  }
}

class _MiniScore extends StatelessWidget {
  const _MiniScore({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final double value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 96,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value.round().toString(),
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(color: color),
          ),
          const SizedBox(height: 2),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

SignalTone _toneForAction(PortfolioDecisionAction action) {
  return switch (action) {
    PortfolioDecisionAction.buy => SignalTone.positive,
    PortfolioDecisionAction.hold => SignalTone.neutral,
    PortfolioDecisionAction.watch => SignalTone.neutral,
    PortfolioDecisionAction.trim => SignalTone.caution,
    PortfolioDecisionAction.sell => SignalTone.negative,
  };
}

String _formatShares(double value) {
  if (value == value.roundToDouble()) {
    return value.round().toString();
  }
  return value.toStringAsFixed(2);
}

String _formatMoney(double value) {
  return '\$${value.toStringAsFixed(2)}';
}

const _decisionGuideEntries = [
  GuideEntry(
    term: 'Buy candidate',
    definition:
        'A stock you do not own yet that clears the app threshold for opportunity, regime fit, confidence, and manageable risk. It is a research prompt, not an automatic order.',
  ),
  GuideEntry(
    term: 'Hold',
    definition:
        'An owned stock where the thesis still looks intact. The app does not see enough evidence to reduce or exit right now.',
  ),
  GuideEntry(
    term: 'Trim',
    definition:
        'A risk-control action. It means the app sees enough fragility, risk, or alert pressure to consider reducing position size without necessarily abandoning the thesis.',
  ),
  GuideEntry(
    term: 'Sell',
    definition:
        'A stronger risk-control action. It means thesis damage is high enough that capital protection matters more than waiting for the idea to recover.',
  ),
  GuideEntry(
    term: 'Watch',
    definition:
        'A wait-for-clarity bucket. The setup is not clean enough to buy or add, but not damaged enough to sell by rule.',
  ),
  GuideEntry(
    term: 'Fidelity CSV import',
    definition:
        'A local portfolio input. You can paste exported positions so the app can separate new buy ideas from decisions on what you already own.',
  ),
];

const _decisionCalculationEntries = [
  CalculationEntry(
    title: 'Buy candidate',
    summary:
        'A name must clear minimum opportunity, regime fit, confidence, fragility, and risk thresholds before it appears as a buy candidate.',
    drivers: [
      'Opportunity, regime fit, trend quality, conviction, and confidence',
      'Penalty from fragility and risk',
      'Exclusion when the current action is trim, de-risk, exit, or avoid',
    ],
    interpretation:
        'Higher means the stock is more worth researching for purchase, but position sizing and timing still need your judgment.',
  ),
  CalculationEntry(
    title: 'Hold',
    summary:
        'An owned name becomes a hold when opportunity remains healthy, confidence is adequate, and risk signals have not crossed the trim/sell line.',
    drivers: [
      'Opportunity above the durability threshold',
      'Confidence and regime fit still supportive',
      'No severe active sell alert',
    ],
    interpretation:
        'Hold means do not overreact. The app is saying the original thesis has not broken enough to force action.',
  ),
  CalculationEntry(
    title: 'Trim and sell',
    summary:
        'Risk-control decisions rise when thesis damage, fragility, risk, or sell-alert severity become the dominant signal.',
    drivers: [
      'Active sell-alert severity and thesis damage',
      'Fragility and risk scores',
      'Opportunity failing to offset the deterioration',
    ],
    interpretation:
        'Trim is partial defense. Sell is stronger thesis failure. Both are designed to keep losses from becoming narrative-driven.',
  ),
];
