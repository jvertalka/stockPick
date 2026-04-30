import '../models/market_intelligence.dart';
import '../models/recommendation_ledger_models.dart';
import 'portfolio_decision_engine.dart';

class DailyDecisionBrief {
  const DailyDecisionBrief({
    required this.asOf,
    required this.headline,
    required this.summary,
    required this.postureTone,
    required this.priorityActions,
    required this.buyIdeas,
    required this.holdFocus,
    required this.sellFocus,
    required this.changes,
    required this.agenda,
    required this.riskWarnings,
    required this.buyCount,
    required this.holdCount,
    required this.watchCount,
    required this.trimCount,
    required this.sellCount,
  });

  final DateTime asOf;
  final String headline;
  final String summary;
  final SignalTone postureTone;
  final List<DailyBriefAction> priorityActions;
  final List<DailyBriefAction> buyIdeas;
  final List<DailyBriefAction> holdFocus;
  final List<DailyBriefAction> sellFocus;
  final List<DailyBriefChange> changes;
  final List<String> agenda;
  final List<String> riskWarnings;
  final int buyCount;
  final int holdCount;
  final int watchCount;
  final int trimCount;
  final int sellCount;

  int get riskControlCount => trimCount + sellCount;
}

class DailyBriefAction {
  const DailyBriefAction({
    required this.action,
    required this.stock,
    required this.title,
    required this.narrative,
    required this.reasons,
    required this.nextCheck,
    required this.score,
    required this.tone,
    required this.source,
    this.decision,
  });

  final PortfolioDecisionAction action;
  final StockInsight stock;
  final String title;
  final String narrative;
  final List<String> reasons;
  final String nextCheck;
  final double score;
  final SignalTone tone;
  final String source;
  final PortfolioDecision? decision;

  bool get isRiskControl =>
      action == PortfolioDecisionAction.trim ||
      action == PortfolioDecisionAction.sell;
}

class DailyBriefChange {
  const DailyBriefChange({
    required this.stock,
    required this.previousAction,
    required this.currentAction,
    required this.opportunityDelta,
    required this.confidenceDelta,
    required this.summary,
    required this.tone,
  });

  final StockInsight stock;
  final RecommendationAction previousAction;
  final RecommendationAction currentAction;
  final double opportunityDelta;
  final double confidenceDelta;
  final String summary;
  final SignalTone tone;

  bool get actionChanged => previousAction != currentAction;
}

class DailyDecisionBriefEngine {
  const DailyDecisionBriefEngine();

  DailyDecisionBrief build({
    required MarketIntelligenceSnapshot snapshot,
    required PortfolioDecisionReport report,
    required RecommendationLedger ledger,
  }) {
    final buyIdeas = _buyIdeas(snapshot, report);
    final holdFocus = _holdFocus(snapshot, report);
    final sellFocus = _sellFocus(snapshot, report);
    final changes = _changes(snapshot, ledger);
    final priorityActions = _priorityActions(
      buyIdeas: buyIdeas,
      holdFocus: holdFocus,
      sellFocus: sellFocus,
      changes: changes,
    );
    final postureTone = _postureTone(snapshot, sellFocus.length);
    final headline = _headlineFor(
      snapshot: snapshot,
      buyCount: buyIdeas.length,
      riskCount: sellFocus.length,
      changeCount: changes.length,
    );
    final watchCount = report.watchDecisions.length;
    final holdCount = holdFocus.length;
    final riskWarnings = _riskWarnings(snapshot, sellFocus);

    return DailyDecisionBrief(
      asOf: snapshot.asOf,
      headline: headline,
      summary: _summaryFor(
        snapshot: snapshot,
        report: report,
        buyCount: buyIdeas.length,
        holdCount: holdCount,
        sellCount: sellFocus
            .where((action) => action.action == PortfolioDecisionAction.sell)
            .length,
        trimCount: sellFocus
            .where((action) => action.action == PortfolioDecisionAction.trim)
            .length,
        changeCount: changes.length,
      ),
      postureTone: postureTone,
      priorityActions: priorityActions,
      buyIdeas: buyIdeas,
      holdFocus: holdFocus,
      sellFocus: sellFocus,
      changes: changes,
      agenda: _agendaFor(
        snapshot: snapshot,
        report: report,
        buyCount: buyIdeas.length,
        holdCount: holdCount,
        riskCount: sellFocus.length,
        changeCount: changes.length,
      ),
      riskWarnings: riskWarnings,
      buyCount: buyIdeas.length,
      holdCount: holdCount,
      watchCount: watchCount,
      trimCount: sellFocus
          .where((action) => action.action == PortfolioDecisionAction.trim)
          .length,
      sellCount: sellFocus
          .where((action) => action.action == PortfolioDecisionAction.sell)
          .length,
    );
  }

  List<DailyBriefAction> _buyIdeas(
    MarketIntelligenceSnapshot snapshot,
    PortfolioDecisionReport report,
  ) {
    final ideas = report.buyCandidates
        .map((decision) => _fromDecision(decision, source: 'Portfolio-aware'))
        .toList();
    final existingTickers = ideas.map((idea) => idea.stock.ticker).toSet();
    final remainingSlots = ideas.length >= 5 ? 0 : 5 - ideas.length;

    ideas.addAll(
      snapshot.rankedUniverse
          .where(
            (stock) =>
                !existingTickers.contains(stock.ticker) &&
                stock.decisionTrust.isActionable &&
                (stock.action == RecommendationAction.buy ||
                    stock.action == RecommendationAction.accumulate) &&
                stock.opportunityScore >= 70 &&
                stock.riskScore <= 72,
          )
          .take(remainingSlots)
          .map(
            (stock) => _fromStock(
              stock,
              action: PortfolioDecisionAction.buy,
              source: 'Universe rank',
            ),
          ),
    );

    return (_sortActions(ideas)).take(5).toList();
  }

  List<DailyBriefAction> _holdFocus(
    MarketIntelligenceSnapshot snapshot,
    PortfolioDecisionReport report,
  ) {
    final owned =
        [
              ...report.holdDecisions,
              ...report.watchDecisions.where((decision) => decision.isOwned),
            ]
            .map(
              (decision) => _fromDecision(decision, source: 'Imported holding'),
            )
            .toList();
    final existingTickers = owned.map((idea) => idea.stock.ticker).toSet();
    final remainingSlots = owned.length >= 5 ? 0 : 5 - owned.length;

    owned.addAll(
      snapshot.rankedUniverse
          .where(
            (stock) =>
                !existingTickers.contains(stock.ticker) &&
                (stock.action == RecommendationAction.hold ||
                    stock.action == RecommendationAction.watch) &&
                stock.confidenceScore >= 50,
          )
          .take(remainingSlots)
          .map(
            (stock) => _fromStock(
              stock,
              action: stock.action == RecommendationAction.hold
                  ? PortfolioDecisionAction.hold
                  : PortfolioDecisionAction.watch,
              source: 'Universe rank',
            ),
          ),
    );

    return (_sortActions(owned)).take(5).toList();
  }

  List<DailyBriefAction> _sellFocus(
    MarketIntelligenceSnapshot snapshot,
    PortfolioDecisionReport report,
  ) {
    final actions = [
      ...report.sellDecisions.map(
        (decision) => _fromDecision(decision, source: 'Imported holding'),
      ),
      ...report.trimDecisions.map(
        (decision) => _fromDecision(decision, source: 'Imported holding'),
      ),
    ];
    final existingTickers = actions.map((idea) => idea.stock.ticker).toSet();
    final stockByTicker = {
      for (final stock in snapshot.rankedUniverse) stock.ticker: stock,
    };

    for (final alert in snapshot.sellAlerts) {
      if (existingTickers.contains(alert.ticker)) {
        continue;
      }
      final stock = stockByTicker[alert.ticker];
      if (stock == null) {
        continue;
      }
      actions.add(_fromSellAlert(stock, alert));
      existingTickers.add(stock.ticker);
    }

    final remainingSlots = actions.length >= 5 ? 0 : 5 - actions.length;
    actions.addAll(
      snapshot.rankedUniverse
          .where(
            (stock) =>
                !existingTickers.contains(stock.ticker) &&
                (stock.action == RecommendationAction.exit ||
                    stock.action == RecommendationAction.avoidForNow ||
                    stock.action == RecommendationAction.deRisk ||
                    stock.action == RecommendationAction.trim ||
                    (stock.fragilityScore >= 75 &&
                        stock.opportunityScore < 62)),
          )
          .take(remainingSlots)
          .map(
            (stock) => _fromStock(
              stock,
              action:
                  stock.action == RecommendationAction.exit ||
                      stock.action == RecommendationAction.avoidForNow
                  ? PortfolioDecisionAction.sell
                  : PortfolioDecisionAction.trim,
              source: 'Universe risk',
            ),
          ),
    );

    return (_sortRiskActions(actions)).take(5).toList();
  }

  DailyBriefAction _fromDecision(
    PortfolioDecision decision, {
    required String source,
  }) {
    return DailyBriefAction(
      action: decision.action,
      stock: decision.stock,
      title: decision.title,
      narrative: decision.narrative,
      reasons: decision.reasons,
      nextCheck: decision.nextCheck,
      score: decision.score,
      tone: _toneForDecision(decision.action),
      source: source,
      decision: decision,
    );
  }

  DailyBriefAction _fromSellAlert(StockInsight stock, SellAlert alert) {
    final action =
        alert.action == RecommendationAction.exit ||
            alert.severity == AlertSeverity.critical
        ? PortfolioDecisionAction.sell
        : PortfolioDecisionAction.trim;
    return DailyBriefAction(
      action: action,
      stock: stock,
      title: '${stock.ticker}: ${action.label.toLowerCase()} review',
      narrative:
          '${alert.summary} This alert is visible even if the ticker is not in your imported portfolio, so it can guide avoid, trim, or exit research.',
      reasons: [
        '${alert.severity.label} sell alert with thesis damage ${alert.thesisDamageScore.round()}.',
        ...alert.triggers.take(3),
      ],
      nextCheck: alert.nextCheck,
      score: alert.thesisDamageScore.clamp(0, 100),
      tone: action == PortfolioDecisionAction.sell
          ? SignalTone.negative
          : SignalTone.caution,
      source: 'Sell alert',
    );
  }

  DailyBriefAction _fromStock(
    StockInsight stock, {
    required PortfolioDecisionAction action,
    required String source,
  }) {
    return DailyBriefAction(
      action: action,
      stock: stock,
      title: '${stock.ticker}: ${_stockTitle(action)}',
      narrative: stock.summary,
      reasons: [
        'Opportunity ${stock.opportunityScore.round()}, confidence ${stock.confidenceScore.round()}, risk ${stock.riskScore.round()}.',
        ...stock.whyItRanks.take(2),
        if (action == PortfolioDecisionAction.trim ||
            action == PortfolioDecisionAction.sell)
          ...stock.whatCouldGoWrong.take(2),
      ],
      nextCheck: stock.invalidationSignals.isEmpty
          ? 'Re-check after the next market refresh.'
          : stock.invalidationSignals.first,
      score: _stockScore(action, stock),
      tone: _toneForDecision(action),
      source: source,
    );
  }

  List<DailyBriefAction> _priorityActions({
    required List<DailyBriefAction> buyIdeas,
    required List<DailyBriefAction> holdFocus,
    required List<DailyBriefAction> sellFocus,
    required List<DailyBriefChange> changes,
  }) {
    final actions = <DailyBriefAction>[
      ...sellFocus.take(3),
      ...buyIdeas.take(sellFocus.isEmpty ? 4 : 2),
    ];
    if (actions.length < 4) {
      final tickers = actions.map((action) => action.stock.ticker).toSet();
      actions.addAll(
        holdFocus
            .where((action) => !tickers.contains(action.stock.ticker))
            .take(4 - actions.length),
      );
    }
    if (actions.isEmpty && changes.isNotEmpty) {
      actions.add(
        _fromStock(
          changes.first.stock,
          action: _portfolioActionFor(changes.first.currentAction),
          source: 'Changed signal',
        ),
      );
    }
    return actions.take(5).toList();
  }

  List<DailyBriefChange> _changes(
    MarketIntelligenceSnapshot snapshot,
    RecommendationLedger ledger,
  ) {
    final previousByTicker = <String, RecommendationRecord>{};
    for (final record in ledger.recent) {
      if (!record.asOf.isBefore(snapshot.asOf)) {
        continue;
      }
      previousByTicker.putIfAbsent(record.ticker, () => record);
    }

    final changes = <DailyBriefChange>[];
    for (final stock in snapshot.rankedUniverse) {
      final previous = previousByTicker[stock.ticker];
      if (previous == null) {
        continue;
      }
      final opportunityDelta =
          stock.opportunityScore - previous.opportunityScore;
      final confidenceDelta = stock.confidenceScore - previous.confidenceScore;
      final actionChanged = previous.action != stock.action;
      if (!actionChanged &&
          opportunityDelta.abs() < 5 &&
          confidenceDelta.abs() < 5) {
        continue;
      }

      changes.add(
        DailyBriefChange(
          stock: stock,
          previousAction: previous.action,
          currentAction: stock.action,
          opportunityDelta: opportunityDelta,
          confidenceDelta: confidenceDelta,
          summary: _changeSummary(
            previous.action,
            stock.action,
            opportunityDelta,
            confidenceDelta,
          ),
          tone: _changeTone(
            previous.action,
            stock.action,
            opportunityDelta,
            confidenceDelta,
          ),
        ),
      );
    }

    changes.sort((left, right) {
      final actionSort = (right.actionChanged ? 1 : 0).compareTo(
        left.actionChanged ? 1 : 0,
      );
      if (actionSort != 0) {
        return actionSort;
      }
      final rightMagnitude =
          right.opportunityDelta.abs() + right.confidenceDelta.abs();
      final leftMagnitude =
          left.opportunityDelta.abs() + left.confidenceDelta.abs();
      return rightMagnitude.compareTo(leftMagnitude);
    });
    return changes.take(8).toList();
  }

  List<String> _riskWarnings(
    MarketIntelligenceSnapshot snapshot,
    List<DailyBriefAction> sellFocus,
  ) {
    final warnings = <String>[
      ...snapshot.marketRadar.warnings.take(3),
      ...sellFocus
          .where((action) => action.isRiskControl)
          .take(2)
          .map(
            (action) =>
                '${action.stock.ticker}: ${action.stock.whatCouldGoWrong.isEmpty ? action.nextCheck : action.stock.whatCouldGoWrong.first}',
          ),
    ];
    return warnings.take(5).toList();
  }

  List<String> _agendaFor({
    required MarketIntelligenceSnapshot snapshot,
    required PortfolioDecisionReport report,
    required int buyCount,
    required int holdCount,
    required int riskCount,
    required int changeCount,
  }) {
    final agenda = <String>[];
    if (riskCount > 0) {
      agenda.add('Start with $riskCount trim or sell review items.');
    }
    if (buyCount > 0) {
      agenda.add(
        'Research the top $buyCount buy ideas against position size and event risk.',
      );
    }
    if (holdCount > 0) {
      agenda.add(
        'Scan $holdCount hold or watch names for thesis damage before adding.',
      );
    }
    if (changeCount > 0) {
      agenda.add(
        'Review $changeCount signal changes from the recommendation ledger.',
      );
    }
    if (report.ownedDecisionCount == 0) {
      agenda.add(
        'Import holdings when ready so the hold, trim, and sell layer can score your real book.',
      );
    }
    agenda.add(
      'Keep the regime filter in view: ${snapshot.marketRadar.regime.label}, risk ${snapshot.marketRadar.riskScore.round()}.',
    );
    return agenda.take(5).toList();
  }

  String _headlineFor({
    required MarketIntelligenceSnapshot snapshot,
    required int buyCount,
    required int riskCount,
    required int changeCount,
  }) {
    if (riskCount > 0) {
      return 'Risk control leads today.';
    }
    if (buyCount > 0 && snapshot.marketRadar.riskScore < 62) {
      return 'Selective buying has enough evidence to review.';
    }
    if (changeCount > 0) {
      return 'Signal changes deserve the first pass.';
    }
    if (snapshot.marketRadar.riskScore >= 70) {
      return 'Patience is the edge while risk stays elevated.';
    }
    return 'Stay selective and let the evidence update.';
  }

  String _summaryFor({
    required MarketIntelligenceSnapshot snapshot,
    required PortfolioDecisionReport report,
    required int buyCount,
    required int holdCount,
    required int trimCount,
    required int sellCount,
    required int changeCount,
  }) {
    final radar = snapshot.marketRadar;
    final riskText = trimCount + sellCount == 0
        ? 'no immediate trim or sell reviews'
        : '$trimCount trim and $sellCount sell reviews';
    final portfolioText = report.ownedDecisionCount == 0
        ? 'The app can still rank the universe, but importing holdings will unlock true position-level hold and exit calls.'
        : '${report.ownedDecisionCount} imported holdings are being scored.';
    return '${radar.regime.label} regime, ${radar.regimeConfidence.round()}% confidence, market score ${radar.marketScore.round()}, risk ${radar.riskScore.round()}. Today shows $buyCount buy candidates, $holdCount hold or watch names, $riskText, and $changeCount changed signals. $portfolioText';
  }

  SignalTone _postureTone(
    MarketIntelligenceSnapshot snapshot,
    int riskControlCount,
  ) {
    if (riskControlCount > 0 || snapshot.marketRadar.riskScore >= 72) {
      return SignalTone.negative;
    }
    if (snapshot.marketRadar.riskScore >= 58 ||
        snapshot.marketRadar.internalHealth ==
            InternalHealthType.weakeningInternals ||
        snapshot.marketRadar.internalHealth ==
            InternalHealthType.narrowLeadership) {
      return SignalTone.caution;
    }
    if (snapshot.marketRadar.marketScore >= 62) {
      return SignalTone.positive;
    }
    return SignalTone.neutral;
  }

  List<DailyBriefAction> _sortActions(List<DailyBriefAction> actions) {
    return actions..sort((a, b) => b.score.compareTo(a.score));
  }

  List<DailyBriefAction> _sortRiskActions(List<DailyBriefAction> actions) {
    return actions..sort((a, b) {
      final actionOrder = _riskActionRank(
        b.action,
      ).compareTo(_riskActionRank(a.action));
      if (actionOrder != 0) {
        return actionOrder;
      }
      return b.score.compareTo(a.score);
    });
  }

  SignalTone _toneForDecision(PortfolioDecisionAction action) {
    return switch (action) {
      PortfolioDecisionAction.buy => SignalTone.positive,
      PortfolioDecisionAction.hold => SignalTone.neutral,
      PortfolioDecisionAction.watch => SignalTone.caution,
      PortfolioDecisionAction.trim => SignalTone.caution,
      PortfolioDecisionAction.sell => SignalTone.negative,
    };
  }

  String _stockTitle(PortfolioDecisionAction action) {
    return switch (action) {
      PortfolioDecisionAction.buy => 'buy candidate',
      PortfolioDecisionAction.hold => 'hold candidate',
      PortfolioDecisionAction.watch => 'watch for confirmation',
      PortfolioDecisionAction.trim => 'trim review',
      PortfolioDecisionAction.sell => 'sell review',
    };
  }

  double _stockScore(PortfolioDecisionAction action, StockInsight stock) {
    return switch (action) {
      PortfolioDecisionAction.buy =>
        stock.opportunityScore * 0.42 +
            stock.regimeFit * 0.18 +
            stock.confidenceScore * 0.18 +
            stock.asymmetryScore * 0.12 -
            stock.riskScore * 0.05 -
            stock.fragilityScore * 0.05,
      PortfolioDecisionAction.hold =>
        stock.opportunityScore * 0.34 +
            stock.confidenceScore * 0.24 +
            stock.regimeFit * 0.16 +
            (100 - stock.fragilityScore) * 0.14 +
            (100 - stock.riskScore) * 0.12,
      PortfolioDecisionAction.watch =>
        stock.opportunityScore * 0.3 +
            stock.confidenceScore * 0.24 +
            stock.regimeFit * 0.16 +
            stock.trendQuality * 0.12 -
            stock.fragilityScore * 0.04 -
            stock.riskScore * 0.04,
      PortfolioDecisionAction.trim =>
        stock.fragilityScore * 0.38 +
            stock.riskScore * 0.34 +
            (100 - stock.opportunityScore) * 0.18 +
            (100 - stock.confidenceScore) * 0.1,
      PortfolioDecisionAction.sell =>
        stock.fragilityScore * 0.4 +
            stock.riskScore * 0.36 +
            (100 - stock.opportunityScore) * 0.16 +
            (100 - stock.confidenceScore) * 0.08,
    }.clamp(0, 100);
  }

  PortfolioDecisionAction _portfolioActionFor(RecommendationAction action) {
    return switch (action) {
      RecommendationAction.buy ||
      RecommendationAction.accumulate => PortfolioDecisionAction.buy,
      RecommendationAction.hold => PortfolioDecisionAction.hold,
      RecommendationAction.watch => PortfolioDecisionAction.watch,
      RecommendationAction.trim ||
      RecommendationAction.deRisk => PortfolioDecisionAction.trim,
      RecommendationAction.exit ||
      RecommendationAction.avoidForNow => PortfolioDecisionAction.sell,
    };
  }

  String _changeSummary(
    RecommendationAction previous,
    RecommendationAction current,
    double opportunityDelta,
    double confidenceDelta,
  ) {
    final actionText = previous == current
        ? current.label
        : '${previous.label} to ${current.label}';
    return '$actionText, opportunity ${_formatDelta(opportunityDelta)}, confidence ${_formatDelta(confidenceDelta)}.';
  }

  SignalTone _changeTone(
    RecommendationAction previous,
    RecommendationAction current,
    double opportunityDelta,
    double confidenceDelta,
  ) {
    final previousRisk = _recommendationRiskRank(previous);
    final currentRisk = _recommendationRiskRank(current);
    if (currentRisk > previousRisk + 1 ||
        current == RecommendationAction.exit ||
        current == RecommendationAction.avoidForNow) {
      return SignalTone.negative;
    }
    if (currentRisk > previousRisk || opportunityDelta < -7) {
      return SignalTone.caution;
    }
    if (currentRisk < previousRisk || opportunityDelta > 7) {
      return SignalTone.positive;
    }
    return confidenceDelta < -7 ? SignalTone.caution : SignalTone.neutral;
  }

  int _recommendationRiskRank(RecommendationAction action) {
    return switch (action) {
      RecommendationAction.buy || RecommendationAction.accumulate => 0,
      RecommendationAction.hold => 1,
      RecommendationAction.watch => 2,
      RecommendationAction.trim || RecommendationAction.deRisk => 3,
      RecommendationAction.exit || RecommendationAction.avoidForNow => 4,
    };
  }

  int _riskActionRank(PortfolioDecisionAction action) {
    return switch (action) {
      PortfolioDecisionAction.sell => 4,
      PortfolioDecisionAction.trim => 3,
      PortfolioDecisionAction.watch => 2,
      PortfolioDecisionAction.hold => 1,
      PortfolioDecisionAction.buy => 0,
    };
  }

  String _formatDelta(double value) {
    if (value > 0) {
      return '+${value.toStringAsFixed(1)}';
    }
    return value.toStringAsFixed(1);
  }
}
