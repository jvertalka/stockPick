import 'package:flutter/material.dart';

import '../../data/portfolio_csv_loader.dart';
import '../../engine/portfolio_decision_engine.dart';
import '../../models/market_intelligence.dart';
import '../../models/portfolio_models.dart';
import '../../theme/app_theme.dart';
import '../widgets/insight_widgets.dart';
import '../widgets/oracle_widgets.dart';

class DecisionDeskView extends StatefulWidget {
  const DecisionDeskView({
    super.key,
    required this.snapshot,
    required this.portfolioState,
    required this.report,
    required this.onPortfolioChanged,
    required this.onOpenStock,
    this.portfolioCsvLoader = const FilePickerPortfolioCsvLoader(),
  });

  final MarketIntelligenceSnapshot snapshot;
  final PortfolioState portfolioState;
  final PortfolioDecisionReport report;
  final ValueChanged<PortfolioState> onPortfolioChanged;
  final ValueChanged<String> onOpenStock;
  final PortfolioCsvLoader portfolioCsvLoader;

  @override
  State<DecisionDeskView> createState() => _DecisionDeskViewState();
}

class _DecisionDeskViewState extends State<DecisionDeskView> {
  final TextEditingController _csvController = TextEditingController();
  final TextEditingController _tickerController = TextEditingController();
  final TextEditingController _sharesController = TextEditingController();
  final TextEditingController _costController = TextEditingController();
  PortfolioImportResult? _lastImport;
  String? _lastImportFileName;
  String? _importError;
  String? _manualError;
  bool _isPickingCsv = false;

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
    final hasPortfolio =
        widget.portfolioState.holdings.isNotEmpty ||
        widget.portfolioState.hasCashBalance;
    final capitalPlan = widget.report.capitalPlan;
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
                  label: _portfolioStatusLabel(widget.portfolioState),
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
              if (widget.report.unmatchedHoldings.isNotEmpty) ...[
                _UnmatchedHoldingsBanner(
                  unmatched: widget.report.unmatchedHoldings,
                  matchedCount:
                      widget.portfolioState.holdings.length -
                      widget.report.unmatchedHoldings.length,
                ),
                const SizedBox(height: 18),
              ],
              if (widget.portfolioState.holdings.isNotEmpty) ...[
                _PortfolioPnLCard(
                  portfolio: widget.portfolioState,
                  snapshot: widget.snapshot,
                  onOpenStock: widget.onOpenStock,
                ),
                const SizedBox(height: 18),
              ],
              UniverseActionFeed(
                universe: widget.snapshot.rankedUniverse,
                onOpenStock: widget.onOpenStock,
                ownedTickers: widget.portfolioState.holdings
                    .map((h) => h.ticker)
                    .toSet(),
              ),
              const SizedBox(height: 18),
              Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  SizedBox(
                    width: sectionWidth,
                    child: MetricTile(
                      label: 'New buy ideas',
                      value: '${widget.report.buyCandidates.length}',
                      detail:
                          'Unowned names that cleared the app threshold and deserve fresh research outside your imported portfolio.',
                      tone: SignalTone.positive,
                      definition:
                          'A new buy idea is a stock you do not currently own in the imported portfolio. It is a research shortlist item, not an automatic order.',
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
                      label: capitalPlan == null
                          ? 'Portfolio matched'
                          : 'Buy-now budget',
                      value: capitalPlan == null
                          ? '${widget.report.ownedDecisionCount}'
                          : _formatMoneyCompact(capitalPlan.buyNowBudget),
                      detail: capitalPlan == null
                          ? 'Imported holdings the app could match to the current research universe.'
                          : 'Fresh capital the app is willing to put to work now after keeping reserve cash and later-add dry powder.',
                      tone: hasPortfolio
                          ? SignalTone.positive
                          : SignalTone.neutral,
                      definition: capitalPlan == null
                          ? 'Matched holdings are the tickers that exist in both your imported positions and the app research universe.'
                          : 'The buy-now budget is the portion of imported cash the app is comfortable deploying immediately into new positions.',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              _NarrativeCard(report: widget.report),
              if (capitalPlan != null) ...[
                const SizedBox(height: 18),
                _CapitalPlanCard(plan: capitalPlan),
              ],
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
                      title: 'New buys outside portfolio',
                      icon: Icons.trending_up_rounded,
                      decisions: widget.report.buyCandidates,
                      emptyTitle: 'No outside-portfolio buys cleared the bar.',
                      emptyMessage:
                          'The app is waiting for cleaner upside, better regime fit, or lower fragility before surfacing fresh buy ideas.',
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
    final cashBalance = widget.portfolioState.cashBalance;
    final trackedAccountValue = widget.portfolioState.trackedAccountValue;

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
                      'Portfolio import',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Choose a Fidelity positions CSV or paste rows manually. Everything stays local in this app; there is no Fidelity login, scraping, or trade execution.',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              const TonePill(label: 'Local only', tone: SignalTone.neutral),
            ],
          ),
          if (cashBalance != null || trackedAccountValue != null) ...[
            const SizedBox(height: 14),
            if (cashBalance != null)
              LabelValueRow(
                label: 'Imported cash balance',
                value: _formatMoney(cashBalance),
                highlight: AppTheme.mint,
                definition:
                    'Cash captured from the Fidelity money market or cash row. This is the dry powder the app can allocate to new buys.',
              ),
            if (trackedAccountValue != null)
              LabelValueRow(
                label: 'Tracked account value',
                value: _formatMoney(trackedAccountValue),
                highlight: AppTheme.sky,
                definition:
                    'Imported cash plus holdings with current values attached. This is the base used for concentration-aware sizing.',
              ),
          ] else ...[
            const SizedBox(height: 14),
            Text(
              'Import a full Fidelity export that includes the money market cash line to unlock buy-now budgeting and starter position sizing.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            key: const ValueKey('portfolio-csv-input'),
            controller: _csvController,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(
              labelText: 'Paste positions CSV manually',
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
                key: const ValueKey('pick-portfolio-file-button'),
                onPressed: _isPickingCsv ? null : _pickCsvFile,
                icon: const Icon(Icons.folder_open_rounded),
                label: Text(
                  _isPickingCsv
                      ? 'Opening file picker...'
                      : 'Choose Fidelity CSV',
                ),
              ),
              FilledButton.icon(
                key: const ValueKey('import-portfolio-button'),
                onPressed: _importCsv,
                icon: const Icon(Icons.upload_file_rounded),
                label: const Text('Import pasted CSV'),
              ),
              FilledButton.tonalIcon(
                onPressed:
                    holdings.isEmpty && !widget.portfolioState.hasCashBalance
                    ? null
                    : _clearPortfolio,
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Clear holdings'),
              ),
            ],
          ),
          if (_lastImportFileName != null) ...[
            const SizedBox(height: 10),
            Text(
              'Last imported file: $_lastImportFileName',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (import != null) ...[
            const SizedBox(height: 10),
            Text(
              _importSummary(import),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: import.importedAny ? AppTheme.mint : AppTheme.amber,
              ),
            ),
          ],
          if (_importError != null) ...[
            const SizedBox(height: 8),
            Text(
              _importError!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppTheme.coral),
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
                  'Without holdings, the app can still show new buy ideas. With holdings and imported cash, it can separate outside-portfolio buys from decisions on what you already own and suggest starter sizes.',
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
    _applyCsvImport(_csvController.text, clearPastedText: true);
  }

  Future<void> _pickCsvFile() async {
    if (_isPickingCsv) {
      return;
    }

    setState(() {
      _isPickingCsv = true;
      _importError = null;
      _manualError = null;
    });

    try {
      final selection = await widget.portfolioCsvLoader.pickCsv();
      if (!mounted || selection == null) {
        return;
      }
      _applyCsvImport(selection.rawCsv, fileName: selection.fileName);
    } catch (_) {
      if (!mounted) {
        return;
      }
      setState(() {
        _importError =
            'Unable to read that CSV file. Try exporting positions again or paste the rows manually.';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isPickingCsv = false;
        });
      }
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
      _lastImportFileName = null;
      _importError = null;
    });
    _tickerController.clear();
    _sharesController.clear();
    _costController.clear();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: AppTheme.mint,
          content: Text(
            'Added $ticker (${shares.toStringAsFixed(shares.truncateToDouble() == shares ? 0 : 2)} shares) to your portfolio.',
          ),
        ),
      );
    }
  }

  void _removeHolding(String ticker) {
    widget.onPortfolioChanged(widget.portfolioState.removeHolding(ticker));
    setState(() {
      _lastImport = null;
      _manualError = null;
      _lastImportFileName = null;
      _importError = null;
    });
  }

  void _clearPortfolio() {
    widget.onPortfolioChanged(PortfolioState.empty);
    setState(() {
      _lastImport = null;
      _manualError = null;
      _lastImportFileName = null;
      _importError = null;
    });
  }

  void _applyCsvImport(
    String raw, {
    String? fileName,
    bool clearPastedText = false,
  }) {
    final result = parsePortfolioHoldingsCsv(
      raw,
      existing: widget.portfolioState,
    );
    setState(() {
      _lastImport = result;
      _lastImportFileName = fileName;
      _manualError = null;
      _importError = result.importedAny
          ? null
          : 'No holdings or cash balance were imported. Make sure the first row has headers like Symbol, Quantity, Average Cost (and optional Current Value).';
    });
    if (result.importedAny) {
      widget.onPortfolioChanged(result.state);
      if (clearPastedText) {
        _csvController.clear();
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            backgroundColor: AppTheme.mint,
            content: Text(
              'Imported ${result.importedCount} holding(s)'
              '${result.importedCashBalance != null ? ' + cash ${_formatMoney(result.importedCashBalance!)}' : ''}'
              '${result.skippedRows > 0 ? '. Skipped ${result.skippedRows} row(s).' : '.'}',
            ),
          ),
        );
      }
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: AppTheme.coral,
          content: Text(
            _importError ??
                'Nothing imported. Check headers (Symbol, Quantity, Average Cost) and try again.',
          ),
          duration: const Duration(seconds: 6),
        ),
      );
    }
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

class _CapitalPlanCard extends StatelessWidget {
  const _CapitalPlanCard({required this.plan});

  final PortfolioCapitalPlan plan;

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
                  color: AppTheme.sky.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: AppTheme.sky.withValues(alpha: 0.28),
                  ),
                ),
                child: const Icon(
                  Icons.account_balance_wallet_rounded,
                  color: AppTheme.sky,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  'Capital plan',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(plan.summary, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 16),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              _CapitalMetricChip(
                label: 'Cash',
                value: _formatMoneyCompact(plan.cashBalance),
                color: AppTheme.mint,
              ),
              _CapitalMetricChip(
                label: 'Reserve',
                value: _formatMoneyCompact(plan.reserveCash),
                color: AppTheme.amber,
              ),
              _CapitalMetricChip(
                label: 'Buy now',
                value: _formatMoneyCompact(plan.buyNowBudget),
                color: AppTheme.sky,
              ),
              _CapitalMetricChip(
                label: 'Max starter',
                value: _formatMoneyCompact(plan.maxStarterPosition),
                color: AppTheme.coral,
              ),
            ],
          ),
          const SizedBox(height: 14),
          if (plan.trackedAccountValue != null)
            LabelValueRow(
              label: 'Tracked account value',
              value: _formatMoney(plan.trackedAccountValue!),
              highlight: AppTheme.sky,
            ),
          if (plan.largestExistingPositionWeight != null &&
              plan.largestExistingPositionWeight! > 0)
            LabelValueRow(
              label: 'Largest tracked position',
              value: _formatPercent(plan.largestExistingPositionWeight!),
              highlight: AppTheme.amber,
            ),
          if (plan.crowdedSector != null && plan.crowdedSectorWeight != null)
            LabelValueRow(
              label: 'Most crowded tracked sector',
              value:
                  '${plan.crowdedSector} (${_formatPercent(plan.crowdedSectorWeight!)})',
              highlight: AppTheme.coral,
            ),
          const SizedBox(height: 10),
          Text('Guardrails', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          BulletList(items: plan.guardrails, accent: AppTheme.sky),
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
                '${holding.currentValue == null ? '' : ' | value ${_formatMoney(holding.currentValue!)}'}'
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
              DecisionTrustBadge(trust: decision.stock.decisionTrust),
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
          if (decision.buyPlan != null) ...[
            const SizedBox(height: 14),
            Text('Sizing plan', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            LabelValueRow(
              label: 'Priority',
              value:
                  '#${decision.buyPlan!.priorityRank} ${decision.buyPlan!.sizingLabel}',
              highlight: AppTheme.mint,
            ),
            LabelValueRow(
              label: 'Suggested dollars',
              value: _formatMoney(decision.buyPlan!.suggestedDollars),
              highlight: AppTheme.sky,
            ),
            LabelValueRow(
              label: 'Buy-now budget share',
              value: _formatPercent(decision.buyPlan!.buyNowBudgetShare),
              highlight: AppTheme.amber,
            ),
            if (decision.buyPlan!.targetAccountWeight != null)
              LabelValueRow(
                label: 'Tracked account weight',
                value: _formatPercent(decision.buyPlan!.targetAccountWeight!),
                highlight: AppTheme.coral,
              ),
            const SizedBox(height: 6),
            Text(
              decision.buyPlan!.rationale,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 14),
          _ScoreStrip(decision: decision),
          if (!decision.stock.forecasts.isEmpty) ...[
            const SizedBox(height: 14),
            _PredictionStrip(decision: decision),
          ],
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

class _PredictionStrip extends StatelessWidget {
  const _PredictionStrip({required this.decision});

  final PortfolioDecision decision;

  @override
  Widget build(BuildContext context) {
    final forecasts = decision.stock.forecasts;
    final forward20 = forecasts.forwardReturn20d;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Prediction read', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            _PredictionChip(
              label: 'Outperform sector',
              value: '${forecasts.outperformSectorProbability.round()}%',
              color: AppTheme.mint,
            ),
            _PredictionChip(
              label: '8% drawdown risk',
              value: '${forecasts.drawdownOver8pctProbability.round()}%',
              color: AppTheme.coral,
            ),
            _PredictionChip(
              label: 'Breakout persists',
              value: '${forecasts.breakoutPersistenceProbability.round()}%',
              color: AppTheme.sky,
            ),
            _PredictionChip(
              label: '20d median return',
              value: _formatSignedPercentValue(forward20.p50),
              color: forward20.p50 >= 0 ? AppTheme.mint : AppTheme.coral,
            ),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          decision.stock.decisionTrust.isActionable
              ? 'These are rules-engine probabilities, useful for ranking decisions today. They are not yet trained model forecasts.'
              : 'These probabilities are capped because the current evidence stack is not fully decision-ready.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _PredictionChip extends StatelessWidget {
  const _PredictionChip({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 142,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
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

class _CapitalMetricChip extends StatelessWidget {
  const _CapitalMetricChip({
    required this.label,
    required this.value,
    required this.color,
  });

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 128,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(color: color),
          ),
          const SizedBox(height: 4),
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

String _formatMoneyCompact(double value) {
  final absolute = value.abs();
  if (absolute >= 1000000) {
    return '\$${(value / 1000000).toStringAsFixed(2)}M';
  }
  if (absolute >= 1000) {
    return '\$${(value / 1000).toStringAsFixed(1)}k';
  }
  return '\$${value.toStringAsFixed(0)}';
}

String _formatPercent(double value) {
  return '${(value * 100).toStringAsFixed(1)}%';
}

String _formatSignedPercentValue(double value) {
  final sign = value > 0 ? '+' : '';
  return '$sign${value.toStringAsFixed(1)}%';
}

String _portfolioStatusLabel(PortfolioState state) {
  if (state.holdings.isNotEmpty && state.hasCashBalance) {
    return '${_holdingCountText(state.holdings.length)} + cash imported';
  }
  if (state.holdings.isNotEmpty) {
    return '${_holdingCountText(state.holdings.length)} imported';
  }
  if (state.hasCashBalance) {
    return 'Cash imported';
  }
  return 'Import holdings to personalize';
}

String _importSummary(PortfolioImportResult result) {
  final parts = <String>[];
  if (result.importedCount > 0) {
    parts.add('${_holdingCountText(result.importedCount)} imported');
  }
  if (result.importedCashBalance != null && result.importedCashBalance! > 0) {
    parts.add('cash ${_formatMoney(result.importedCashBalance!)} captured');
  }
  parts.add('${result.skippedRows} skipped');
  return '${parts.join(', ')}.';
}

String _holdingCountText(int count) {
  return '$count ${count == 1 ? 'holding' : 'holdings'}';
}

const _decisionGuideEntries = [
  GuideEntry(
    term: 'New buy idea',
    definition:
        'A stock you do not own yet that clears the app threshold for opportunity, regime fit, confidence, and manageable risk. It is a research prompt for a potential new position, not an automatic order.',
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
        'A local portfolio input. You can choose an exported positions file or paste the rows so the app can separate new buy ideas from decisions on what you already own.',
  ),
  GuideEntry(
    term: 'Buy-now budget',
    definition:
        'The part of your imported cash the app is comfortable deploying immediately. It keeps a reserve and a later-add buffer instead of assuming every dollar should be invested right now.',
  ),
];

const _decisionCalculationEntries = [
  CalculationEntry(
    title: 'New buy idea',
    summary:
        'A name must clear minimum opportunity, regime fit, confidence, fragility, and risk thresholds before it appears as a new buy idea outside your current portfolio.',
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
  CalculationEntry(
    title: 'Starter size',
    summary:
        'Starter sizes blend imported cash, current concentration, sector crowding, and market risk so the top add is not just the highest score but the best next fit for your portfolio.',
    drivers: [
      'Imported cash balance, reserve ratio, and buy-now budget',
      'Current position concentration and crowded sector exposure',
      'Candidate score quality after opportunity, confidence, fragility, and risk',
    ],
    interpretation:
        'Larger starter sizes mean the app sees room both in the setup and in the portfolio. Smaller ones usually reflect concentration or a more defensive market backdrop.',
  ),
];

class _PortfolioPnLCard extends StatelessWidget {
  const _PortfolioPnLCard({
    required this.portfolio,
    required this.snapshot,
    required this.onOpenStock,
  });

  final PortfolioState portfolio;
  final MarketIntelligenceSnapshot snapshot;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final rows = portfolio.holdings.map(_rowFor).toList()
      ..sort((a, b) => b.pnlDollars.compareTo(a.pnlDollars));
    final withPnL = rows.where((r) => r.pnlDollars != 0).toList();
    final totalCost = rows.fold<double>(
      0,
      (acc, r) => acc + (r.costBasis ?? 0),
    );
    final totalValue = rows.fold<double>(
      0,
      (acc, r) => acc + (r.marketValue ?? 0),
    );
    final totalPnL = totalValue - totalCost;
    final totalPnLPct = totalCost > 0 ? totalPnL / totalCost * 100 : 0.0;
    final winners = withPnL.where((r) => r.pnlDollars > 0).length;
    final losers = withPnL.where((r) => r.pnlDollars < 0).length;

    final pnlColor = totalPnL >= 0 ? AppTheme.mint : AppTheme.coral;

    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.trending_up_rounded,
                color: AppTheme.mint,
                size: 22,
              ),
              const SizedBox(width: 8),
              Text('Portfolio P&L', style: theme.textTheme.headlineMedium),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: pnlColor.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  '${totalPnL >= 0 ? '+' : ''}${_fmtMoney(totalPnL)}'
                  ' (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toStringAsFixed(1)}%)',
                  style: theme.textTheme.titleMedium?.copyWith(color: pnlColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'Unrealized gain/loss per position. Prices come from the last import — import again to refresh.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 18,
            runSpacing: 10,
            children: [
              _PnLStat(label: 'Cost basis', value: _fmtMoney(totalCost)),
              _PnLStat(label: 'Market value', value: _fmtMoney(totalValue)),
              _PnLStat(
                label: 'Winners',
                value: '$winners',
                color: AppTheme.mint,
              ),
              _PnLStat(
                label: 'Losers',
                value: '$losers',
                color: AppTheme.coral,
              ),
            ],
          ),
          const SizedBox(height: 14),
          ...rows
              .take(15)
              .map((row) => _PnLRow(row: row, onOpenStock: onOpenStock)),
          if (rows.length > 15) ...[
            const SizedBox(height: 6),
            Text(
              '+${rows.length - 15} more holdings not shown.',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }

  _PnLRowData _rowFor(PortfolioHolding holding) {
    final shares = holding.shares;
    final avgCost = holding.averageCostBasis;
    final currentPrice =
        holding.currentPrice ??
        (holding.currentValue != null ? holding.currentValue! / shares : null);
    final costBasis = avgCost != null ? avgCost * shares : null;
    final marketValue =
        holding.currentValue ??
        (currentPrice != null ? currentPrice * shares : null);
    double pnlDollars = 0;
    double? pnlPct;
    if (costBasis != null && marketValue != null) {
      pnlDollars = marketValue - costBasis;
      pnlPct = costBasis > 0 ? pnlDollars / costBasis * 100 : null;
    }
    return _PnLRowData(
      ticker: holding.ticker,
      shares: shares,
      averageCost: avgCost,
      currentPrice: currentPrice,
      costBasis: costBasis,
      marketValue: marketValue,
      pnlDollars: pnlDollars,
      pnlPct: pnlPct,
    );
  }

  static String _fmtMoney(double value) {
    final abs = value.abs();
    final sign = value < 0 ? '-' : '';
    if (abs >= 1000000) {
      return '$sign\$${(abs / 1000000).toStringAsFixed(2)}M';
    }
    if (abs >= 1000) {
      return '$sign\$${(abs / 1000).toStringAsFixed(1)}K';
    }
    return '$sign\$${abs.toStringAsFixed(2)}';
  }
}

class _PnLStat extends StatelessWidget {
  const _PnLStat({required this.label, required this.value, this.color});

  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: theme.textTheme.labelSmall),
        Text(value, style: theme.textTheme.titleLarge?.copyWith(color: color)),
      ],
    );
  }
}

class _PnLRowData {
  const _PnLRowData({
    required this.ticker,
    required this.shares,
    required this.averageCost,
    required this.currentPrice,
    required this.costBasis,
    required this.marketValue,
    required this.pnlDollars,
    required this.pnlPct,
  });

  final String ticker;
  final double shares;
  final double? averageCost;
  final double? currentPrice;
  final double? costBasis;
  final double? marketValue;
  final double pnlDollars;
  final double? pnlPct;
}

class _PnLRow extends StatelessWidget {
  const _PnLRow({required this.row, required this.onOpenStock});

  final _PnLRowData row;
  final ValueChanged<String> onOpenStock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final positive = row.pnlDollars >= 0;
    final color = positive ? AppTheme.mint : AppTheme.coral;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => onOpenStock(row.ticker),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        child: Row(
          children: [
            SizedBox(
              width: 70,
              child: Text(row.ticker, style: theme.textTheme.titleMedium),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${row.shares.toStringAsFixed(row.shares == row.shares.truncateToDouble() ? 0 : 2)} sh'
                    '${row.averageCost != null ? ' · avg ${_PortfolioPnLCard._fmtMoney(row.averageCost!)}' : ''}'
                    '${row.currentPrice != null ? ' · last ${_PortfolioPnLCard._fmtMoney(row.currentPrice!)}' : ''}',
                    style: theme.textTheme.bodySmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            SizedBox(
              width: 110,
              child: Text(
                row.marketValue != null
                    ? _PortfolioPnLCard._fmtMoney(row.marketValue!)
                    : '—',
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.right,
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 100,
              child: Text(
                '${positive ? '+' : ''}${_PortfolioPnLCard._fmtMoney(row.pnlDollars)}'
                '${row.pnlPct != null ? '\n${positive ? '+' : ''}${row.pnlPct!.toStringAsFixed(1)}%' : ''}',
                style: theme.textTheme.titleSmall?.copyWith(color: color),
                textAlign: TextAlign.right,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _UnmatchedHoldingsBanner extends StatelessWidget {
  const _UnmatchedHoldingsBanner({
    required this.unmatched,
    required this.matchedCount,
  });

  final List<PortfolioHolding> unmatched;
  final int matchedCount;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tickers = unmatched.map((h) => h.ticker).toList()..sort();
    final allUnmatched = matchedCount == 0;
    return InsightCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.warning_amber_rounded,
                color: AppTheme.amber,
                size: 22,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  allUnmatched
                      ? 'None of your holdings are in the analyzed universe yet.'
                      : '${unmatched.length} of ${unmatched.length + matchedCount} holdings are not in the analyzed universe.',
                  style: theme.textTheme.headlineMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            allUnmatched
                ? 'The engine has no scoring data for these tickers, so the Decision Desk will look empty until at least one of them is in the tracked universe.'
                : 'Decisions for the matched names show below. The unmatched ones are listed for reference only.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: tickers
                .map(
                  (ticker) => Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: AppTheme.amber.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      ticker,
                      style: theme.textTheme.labelLarge?.copyWith(
                        color: AppTheme.amber,
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.04),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'How to add these to the universe',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                Text(
                  'Open lib/src/data/local_secrets.dart and add the tickers above to kSymbolUniverse, then restart the app. The engine will rotate them into the next Alpha Vantage sync. The current universe is S&P 100 by default.',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
