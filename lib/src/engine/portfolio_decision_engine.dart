import 'dart:math' as math;

import '../models/market_intelligence.dart';
import '../models/portfolio_models.dart';

enum PortfolioDecisionAction { buy, hold, watch, trim, sell }

extension PortfolioDecisionActionLabel on PortfolioDecisionAction {
  String get label => switch (this) {
    PortfolioDecisionAction.buy => 'New buy idea',
    PortfolioDecisionAction.hold => 'Hold',
    PortfolioDecisionAction.watch => 'Watch',
    PortfolioDecisionAction.trim => 'Trim',
    PortfolioDecisionAction.sell => 'Sell',
  };
}

class PortfolioDecision {
  const PortfolioDecision({
    required this.action,
    required this.stock,
    required this.score,
    required this.title,
    required this.narrative,
    required this.reasons,
    required this.watchItems,
    required this.nextCheck,
    this.holding,
    this.alert,
    this.buyPlan,
  });

  final PortfolioDecisionAction action;
  final StockInsight stock;
  final PortfolioHolding? holding;
  final SellAlert? alert;
  final double score;
  final String title;
  final String narrative;
  final List<String> reasons;
  final List<String> watchItems;
  final String nextCheck;
  final BuyAllocationPlan? buyPlan;

  bool get isOwned => holding != null;
}

class BuyAllocationPlan {
  const BuyAllocationPlan({
    required this.priorityRank,
    required this.allocationScore,
    required this.suggestedDollars,
    required this.buyNowBudgetShare,
    required this.sizingLabel,
    required this.rationale,
    this.targetAccountWeight,
    this.existingSectorWeight,
  });

  final int priorityRank;
  final double allocationScore;
  final double suggestedDollars;
  final double buyNowBudgetShare;
  final double? targetAccountWeight;
  final double? existingSectorWeight;
  final String sizingLabel;
  final String rationale;
}

class PortfolioCapitalPlan {
  const PortfolioCapitalPlan({
    required this.cashBalance,
    required this.reserveCash,
    required this.holdBackCash,
    required this.buyNowBudget,
    required this.maxStarterPosition,
    required this.summary,
    required this.guardrails,
    this.trackedAccountValue,
    this.largestExistingPositionWeight,
    this.crowdedSector,
    this.crowdedSectorWeight,
  });

  final double cashBalance;
  final double reserveCash;
  final double holdBackCash;
  final double buyNowBudget;
  final double maxStarterPosition;
  final double? trackedAccountValue;
  final double? largestExistingPositionWeight;
  final String? crowdedSector;
  final double? crowdedSectorWeight;
  final String summary;
  final List<String> guardrails;
}

class PortfolioDecisionReport {
  const PortfolioDecisionReport({
    required this.buyCandidates,
    required this.holdDecisions,
    required this.watchDecisions,
    required this.trimDecisions,
    required this.sellDecisions,
    required this.unmatchedHoldings,
    required this.summary,
    this.capitalPlan,
  });

  final List<PortfolioDecision> buyCandidates;
  final List<PortfolioDecision> holdDecisions;
  final List<PortfolioDecision> watchDecisions;
  final List<PortfolioDecision> trimDecisions;
  final List<PortfolioDecision> sellDecisions;
  final List<PortfolioHolding> unmatchedHoldings;
  final String summary;
  final PortfolioCapitalPlan? capitalPlan;

  int get ownedDecisionCount =>
      holdDecisions.length +
      watchDecisions.where((decision) => decision.isOwned).length +
      trimDecisions.length +
      sellDecisions.length;

  int get riskDecisionCount => trimDecisions.length + sellDecisions.length;
}

class PortfolioDecisionEngine {
  const PortfolioDecisionEngine();

  PortfolioDecisionReport build({
    required MarketIntelligenceSnapshot snapshot,
    required PortfolioState portfolio,
  }) {
    final stockByTicker = {
      for (final stock in snapshot.rankedUniverse) stock.ticker: stock,
    };
    final alertByTicker = {
      for (final alert in snapshot.sellAlerts) alert.ticker: alert,
    };

    final holdDecisions = <PortfolioDecision>[];
    final watchDecisions = <PortfolioDecision>[];
    final trimDecisions = <PortfolioDecision>[];
    final sellDecisions = <PortfolioDecision>[];
    final unmatchedHoldings = <PortfolioHolding>[];

    for (final holding in portfolio.holdings) {
      final stock = stockByTicker[holding.ticker];
      if (stock == null) {
        unmatchedHoldings.add(holding);
        continue;
      }

      final alert = alertByTicker[holding.ticker];
      final action = _classifyOwnedHolding(stock, alert);
      final decision = _decisionFor(
        action: action,
        stock: stock,
        holding: holding,
        alert: alert,
      );

      switch (action) {
        case PortfolioDecisionAction.hold:
          holdDecisions.add(decision);
        case PortfolioDecisionAction.watch:
          watchDecisions.add(decision);
        case PortfolioDecisionAction.trim:
          trimDecisions.add(decision);
        case PortfolioDecisionAction.sell:
          sellDecisions.add(decision);
        case PortfolioDecisionAction.buy:
          break;
      }
    }

    final ownedTickers = portfolio.tickers;
    final unownedRanked = snapshot.rankedUniverse.where(
      (stock) => !ownedTickers.contains(stock.ticker),
    );

    final rawBuyCandidates = unownedRanked
        .where(_isBuyCandidate)
        .take(5)
        .map(
          (stock) => _decisionFor(
            action: PortfolioDecisionAction.buy,
            stock: stock,
            alert: alertByTicker[stock.ticker],
          ),
        )
        .toList();
    final capitalPlan = _buildCapitalPlan(
      snapshot: snapshot,
      portfolio: portfolio,
      buyCandidates: rawBuyCandidates,
      stockByTicker: stockByTicker,
    );
    final buyCandidates = capitalPlan == null
        ? _sortByScore(rawBuyCandidates)
        : _applyBuyPlans(
            buyCandidates: rawBuyCandidates,
            capitalPlan: capitalPlan,
            portfolio: portfolio,
            stockByTicker: stockByTicker,
          );

    final buyTickers = buyCandidates.map((decision) => decision.stock.ticker);
    watchDecisions.addAll(
      unownedRanked
          .where((stock) => !buyTickers.contains(stock.ticker))
          .take(4)
          .map(
            (stock) => _decisionFor(
              action: PortfolioDecisionAction.watch,
              stock: stock,
              alert: alertByTicker[stock.ticker],
            ),
          ),
    );

    return PortfolioDecisionReport(
      buyCandidates: buyCandidates,
      holdDecisions: _sortByScore(holdDecisions),
      watchDecisions: _sortByScore(watchDecisions),
      trimDecisions: _sortByScore(trimDecisions),
      sellDecisions: _sortByScore(sellDecisions),
      unmatchedHoldings: unmatchedHoldings,
      capitalPlan: capitalPlan,
      summary: _summaryFor(
        portfolio: portfolio,
        matchedHoldingCount:
            holdDecisions.length +
            watchDecisions.where((decision) => decision.isOwned).length +
            trimDecisions.length +
            sellDecisions.length,
        unmatchedHoldingCount: unmatchedHoldings.length,
        buyCandidateCount: buyCandidates.length,
        riskDecisionCount: trimDecisions.length + sellDecisions.length,
        capitalPlan: capitalPlan,
      ),
    );
  }

  PortfolioDecisionAction _classifyOwnedHolding(
    StockInsight stock,
    SellAlert? alert,
  ) {
    if (stock.decisionTrust.isInsufficient) {
      return PortfolioDecisionAction.watch;
    }
    if (alert != null &&
        (alert.action == RecommendationAction.exit ||
            alert.severity == AlertSeverity.critical ||
            alert.thesisDamageScore >= 82)) {
      return stock.decisionTrust.isActionable
          ? PortfolioDecisionAction.sell
          : PortfolioDecisionAction.trim;
    }
    if (stock.action == RecommendationAction.exit ||
        stock.action == RecommendationAction.avoidForNow ||
        (stock.opportunityScore < 55 && stock.fragilityScore >= 70)) {
      return stock.decisionTrust.isActionable
          ? PortfolioDecisionAction.sell
          : PortfolioDecisionAction.trim;
    }
    if (alert != null &&
        (alert.action == RecommendationAction.deRisk ||
            alert.action == RecommendationAction.trim ||
            alert.severity == AlertSeverity.high ||
            alert.thesisDamageScore >= 64)) {
      return PortfolioDecisionAction.trim;
    }
    if ((stock.fragilityScore >= 72 || stock.riskScore >= 72) &&
        stock.opportunityScore < 74) {
      return PortfolioDecisionAction.trim;
    }
    if (stock.opportunityScore >= 72 &&
        stock.confidenceScore >= 60 &&
        stock.fragilityScore < 68 &&
        stock.action != RecommendationAction.trim &&
        stock.action != RecommendationAction.deRisk) {
      return PortfolioDecisionAction.hold;
    }
    return PortfolioDecisionAction.watch;
  }

  bool _isBuyCandidate(StockInsight stock) {
    return stock.decisionTrust.isActionable &&
        stock.opportunityScore >= 74 &&
        stock.regimeFit >= 58 &&
        stock.fragilityScore <= 70 &&
        stock.riskScore <= 70 &&
        stock.confidenceScore >= 56 &&
        stock.action != RecommendationAction.exit &&
        stock.action != RecommendationAction.avoidForNow &&
        stock.action != RecommendationAction.trim &&
        stock.action != RecommendationAction.deRisk;
  }

  PortfolioDecision _decisionFor({
    required PortfolioDecisionAction action,
    required StockInsight stock,
    PortfolioHolding? holding,
    SellAlert? alert,
    BuyAllocationPlan? buyPlan,
  }) {
    return PortfolioDecision(
      action: action,
      stock: stock,
      holding: holding,
      alert: alert,
      score: _scoreFor(action, stock, alert),
      title: _titleFor(action, stock),
      narrative: _narrativeFor(action, stock, holding, alert),
      reasons: _reasonsFor(action, stock, alert),
      watchItems: _watchItemsFor(stock, alert),
      nextCheck: alert?.nextCheck ?? 'Next market refresh or weekly review.',
      buyPlan: buyPlan,
    );
  }

  PortfolioCapitalPlan? _buildCapitalPlan({
    required MarketIntelligenceSnapshot snapshot,
    required PortfolioState portfolio,
    required List<PortfolioDecision> buyCandidates,
    required Map<String, StockInsight> stockByTicker,
  }) {
    final cashBalance = portfolio.cashBalance;
    if (cashBalance == null || cashBalance <= 0 || buyCandidates.isEmpty) {
      return null;
    }

    final reserveRatio = _reserveRatio(snapshot.marketRadar);
    final reserveCash = cashBalance * reserveRatio;
    final deployableCash = math.max(0, cashBalance - reserveCash);
    if (deployableCash <= 0) {
      return null;
    }

    final buyNowBudget = deployableCash * 0.6;
    final holdBackCash = deployableCash - buyNowBudget;
    final trackedAccountValue = portfolio.trackedAccountValue;
    final accountBase = trackedAccountValue ?? cashBalance;
    final maxStarterPosition = math.min(buyNowBudget * 0.5, accountBase * 0.08);
    final largestExistingPositionWeight = _largestExistingPositionWeight(
      portfolio,
      trackedAccountValue,
    );
    final sectorWeights = _sectorWeights(
      portfolio: portfolio,
      stockByTicker: stockByTicker,
    );
    final crowdedSectorEntry = sectorWeights.entries.isEmpty
        ? null
        : sectorWeights.entries.reduce(
            (left, right) => left.value >= right.value ? left : right,
          );

    return PortfolioCapitalPlan(
      cashBalance: cashBalance,
      reserveCash: reserveCash,
      holdBackCash: holdBackCash,
      buyNowBudget: buyNowBudget,
      maxStarterPosition: maxStarterPosition,
      trackedAccountValue: trackedAccountValue,
      largestExistingPositionWeight: largestExistingPositionWeight,
      crowdedSector: crowdedSectorEntry?.key,
      crowdedSectorWeight: crowdedSectorEntry?.value,
      summary:
          'Imported cash gives you ${_formatMoney(reserveCash)} in reserve and about ${_formatMoney(buyNowBudget)} to put to work now. Another ${_formatMoney(holdBackCash)} stays staged for later adds, and any one new position starts near or below ${_formatMoney(maxStarterPosition)} while market risk is ${snapshot.marketRadar.riskScore.round()}.',
      guardrails: [
        'Keep at least ${_formatMoney(reserveCash)} in reserve until the market backdrop improves or your top adds confirm.',
        'Start any one new position below ${trackedAccountValue == null || trackedAccountValue <= 0 ? 'half of the buy-now budget' : '${(maxStarterPosition / trackedAccountValue * 100).toStringAsFixed(1)}% of tracked account value'} to avoid oversized first entries.',
        if (crowdedSectorEntry != null)
          '${crowdedSectorEntry.key} already represents ${(crowdedSectorEntry.value * 100).toStringAsFixed(1)}% of tracked invested capital, so fresh adds there should begin smaller.',
      ],
    );
  }

  List<PortfolioDecision> _applyBuyPlans({
    required List<PortfolioDecision> buyCandidates,
    required PortfolioCapitalPlan capitalPlan,
    required PortfolioState portfolio,
    required Map<String, StockInsight> stockByTicker,
  }) {
    final sectorWeights = _sectorWeights(
      portfolio: portfolio,
      stockByTicker: stockByTicker,
    );

    final ranked =
        buyCandidates
            .map(
              (decision) => _AllocationCandidate(
                decision: decision,
                existingSectorWeight: sectorWeights[decision.stock.sector] ?? 0,
                allocationScore: _allocationScore(
                  decision: decision,
                  existingSectorWeight:
                      sectorWeights[decision.stock.sector] ?? 0,
                ),
              ),
            )
            .toList()
          ..sort((a, b) => b.allocationScore.compareTo(a.allocationScore));

    final planned = ranked.take(math.min(3, ranked.length)).toList();
    final plannedScoreTotal = planned.fold<double>(
      0,
      (sum, candidate) => sum + math.max(candidate.allocationScore, 1),
    );

    final planByTicker = <String, BuyAllocationPlan>{};
    for (var index = 0; index < planned.length; index++) {
      final candidate = planned[index];
      final rawBudget =
          capitalPlan.buyNowBudget *
          (math.max(candidate.allocationScore, 1) / plannedScoreTotal);
      final suggestedDollars = math.min<double>(
        rawBudget,
        capitalPlan.maxStarterPosition,
      );
      final buyNowBudgetShare = capitalPlan.buyNowBudget <= 0
          ? 0.0
          : suggestedDollars / capitalPlan.buyNowBudget;
      final targetAccountWeight =
          capitalPlan.trackedAccountValue == null ||
              capitalPlan.trackedAccountValue! <= 0
          ? null
          : suggestedDollars / capitalPlan.trackedAccountValue!;

      planByTicker[candidate.decision.stock.ticker] = BuyAllocationPlan(
        priorityRank: index + 1,
        allocationScore: candidate.allocationScore,
        suggestedDollars: suggestedDollars,
        buyNowBudgetShare: buyNowBudgetShare,
        targetAccountWeight: targetAccountWeight,
        existingSectorWeight: candidate.existingSectorWeight,
        sizingLabel: _sizingLabel(
          priorityRank: index + 1,
          buyNowBudgetShare: buyNowBudgetShare,
        ),
        rationale: _buyPlanRationale(
          stock: candidate.decision.stock,
          capitalPlan: capitalPlan,
          existingSectorWeight: candidate.existingSectorWeight,
        ),
      );
    }

    final plannedDecisions =
        buyCandidates
            .map(
              (decision) => _decisionFor(
                action: decision.action,
                stock: decision.stock,
                holding: decision.holding,
                alert: decision.alert,
                buyPlan: planByTicker[decision.stock.ticker],
              ),
            )
            .toList()
          ..sort((left, right) {
            final leftPlan = left.buyPlan;
            final rightPlan = right.buyPlan;
            if (leftPlan != null && rightPlan != null) {
              return leftPlan.priorityRank.compareTo(rightPlan.priorityRank);
            }
            if (leftPlan != null) {
              return -1;
            }
            if (rightPlan != null) {
              return 1;
            }
            return right.score.compareTo(left.score);
          });

    return plannedDecisions;
  }

  double _scoreFor(
    PortfolioDecisionAction action,
    StockInsight stock,
    SellAlert? alert,
  ) {
    final upsideScore =
        stock.opportunityScore * 0.32 +
        stock.regimeFit * 0.18 +
        stock.convictionScore * 0.18 +
        stock.trendQuality * 0.12 +
        stock.confidenceScore * 0.12 +
        stock.asymmetryScore * 0.08 -
        stock.fragilityScore * 0.09 -
        stock.riskScore * 0.07;
    final thesisDamage =
        alert?.thesisDamageScore ??
        math.max(stock.fragilityScore, stock.riskScore);

    final score = switch (action) {
      PortfolioDecisionAction.buy => upsideScore,
      PortfolioDecisionAction.hold => upsideScore + 4,
      PortfolioDecisionAction.watch => upsideScore - 8,
      PortfolioDecisionAction.trim =>
        thesisDamage * 0.62 +
            stock.riskScore * 0.18 +
            stock.fragilityScore * 0.2,
      PortfolioDecisionAction.sell =>
        thesisDamage * 0.68 +
            stock.riskScore * 0.17 +
            stock.fragilityScore * 0.15,
    };
    return score.clamp(0, 100);
  }

  String _titleFor(PortfolioDecisionAction action, StockInsight stock) {
    return switch (action) {
      PortfolioDecisionAction.buy => '${stock.ticker}: potential new position',
      PortfolioDecisionAction.hold => '${stock.ticker}: thesis still intact',
      PortfolioDecisionAction.watch => '${stock.ticker}: wait for clarity',
      PortfolioDecisionAction.trim => '${stock.ticker}: reduce exposure',
      PortfolioDecisionAction.sell => '${stock.ticker}: exit candidate',
    };
  }

  String _narrativeFor(
    PortfolioDecisionAction action,
    StockInsight stock,
    PortfolioHolding? holding,
    SellAlert? alert,
  ) {
    final ownership = holding == null
        ? 'You do not currently have this in the imported portfolio.'
        : 'Your imported portfolio shows ${_formatShares(holding.shares)} shares.';
    final alertText = alert == null
        ? 'There is no active sell alert attached to the name.'
        : 'A ${alert.severity.label.toLowerCase()} sell alert is active: ${alert.summary}';

    return switch (action) {
      PortfolioDecisionAction.buy =>
        '$ownership The setup earns new-buy status because opportunity, regime fit, and confidence are strong enough while risk is still controlled. Treat this as a research shortlist item for a potential new position, not an automatic trade.',
      PortfolioDecisionAction.hold =>
        '$ownership Hold means the thesis still looks alive: opportunity remains high enough, the regime still fits, and deterioration has not crossed the trim/sell line. $alertText',
      PortfolioDecisionAction.watch =>
        '$ownership Watch means the signal is not bad enough to sell and not clean enough to buy more. The right move is patience: wait for either improving confirmation or clearer thesis damage.',
      PortfolioDecisionAction.trim =>
        '$ownership Trim means reduce position size before the story gets worse. The app sees enough risk, fragility, or alert pressure to protect capital while keeping some exposure if the thesis recovers.',
      PortfolioDecisionAction.sell =>
        '$ownership Sell means thesis damage is now the dominant signal. The model is prioritizing capital protection over waiting for a rebound. $alertText',
    };
  }

  List<String> _reasonsFor(
    PortfolioDecisionAction action,
    StockInsight stock,
    SellAlert? alert,
  ) {
    final reasons = <String>[
      'Opportunity ${stock.opportunityScore.round()}, regime fit ${stock.regimeFit.round()}, confidence ${stock.confidenceScore.round()}.',
      'Fragility ${stock.fragilityScore.round()} and risk ${stock.riskScore.round()} show how much can go wrong if the setup weakens.',
      ...stock.whyItRanks.take(2),
    ];

    if (alert != null) {
      reasons.insert(
        0,
        '${alert.severity.label} alert with thesis damage ${alert.thesisDamageScore.round()}: ${alert.summary}',
      );
      reasons.addAll(alert.triggers.take(2));
    }

    if (action == PortfolioDecisionAction.trim ||
        action == PortfolioDecisionAction.sell) {
      reasons.add(
        'Risk control matters more when fragility or thesis damage outruns the opportunity score.',
      );
    }

    return reasons.take(6).toList();
  }

  List<String> _watchItemsFor(StockInsight stock, SellAlert? alert) {
    final items = <String>[
      ...stock.invalidationSignals.take(2),
      ...stock.whatCouldGoWrong.take(1),
    ];
    if (alert != null) {
      items.addAll(alert.triggers.take(2));
    }
    items.add('Re-check after the next market refresh or material news.');
    return items.take(5).toList();
  }

  List<PortfolioDecision> _sortByScore(List<PortfolioDecision> decisions) {
    return decisions..sort((a, b) => b.score.compareTo(a.score));
  }

  String _summaryFor({
    required PortfolioState portfolio,
    required int matchedHoldingCount,
    required int unmatchedHoldingCount,
    required int buyCandidateCount,
    required int riskDecisionCount,
    required PortfolioCapitalPlan? capitalPlan,
  }) {
    if (portfolio.isEmpty) {
      return 'No portfolio is imported yet, so the desk can only rank outside-portfolio buy ideas and watchlist ideas. Import Fidelity positions to unlock hold, trim, and sell decisions for what you already own.';
    }
    final baseSummary =
        '$matchedHoldingCount imported holdings matched the current research universe, $unmatchedHoldingCount did not match yet, $buyCandidateCount outside-portfolio buy ideas are available, and $riskDecisionCount owned names need trim or sell review.';
    if (capitalPlan == null) {
      return baseSummary;
    }
    return '$baseSummary Imported cash of ${_formatMoney(capitalPlan.cashBalance)} supports about ${_formatMoney(capitalPlan.buyNowBudget)} of fresh-buy budget now while keeping ${_formatMoney(capitalPlan.reserveCash)} in reserve.';
  }

  String _formatShares(double value) {
    if (value == value.roundToDouble()) {
      return value.round().toString();
    }
    return value.toStringAsFixed(2);
  }

  double _reserveRatio(MarketRadar radar) {
    if (radar.regime == MarketRegimeType.riskOff || radar.riskScore >= 72) {
      return 0.40;
    }
    if (radar.riskScore >= 60) {
      return 0.32;
    }
    if (radar.regime == MarketRegimeType.neutral || radar.riskScore >= 50) {
      return 0.26;
    }
    return 0.20;
  }

  double _largestExistingPositionWeight(
    PortfolioState portfolio,
    double? trackedAccountValue,
  ) {
    if (trackedAccountValue == null || trackedAccountValue <= 0) {
      return 0;
    }
    final positionValues = portfolio.holdings
        .map((holding) => holding.currentValue ?? 0)
        .where((value) => value > 0);
    if (positionValues.isEmpty) {
      return 0;
    }
    return positionValues.reduce(math.max) / trackedAccountValue;
  }

  Map<String, double> _sectorWeights({
    required PortfolioState portfolio,
    required Map<String, StockInsight> stockByTicker,
  }) {
    final investedValue = portfolio.trackedHoldingsValue;
    if (investedValue <= 0) {
      return const <String, double>{};
    }

    final sectorValues = <String, double>{};
    for (final holding in portfolio.holdings) {
      final currentValue = holding.currentValue;
      final stock = stockByTicker[holding.ticker];
      if (currentValue == null || currentValue <= 0 || stock == null) {
        continue;
      }
      sectorValues.update(
        stock.sector,
        (existing) => existing + currentValue,
        ifAbsent: () => currentValue,
      );
    }
    return {
      for (final entry in sectorValues.entries)
        entry.key: entry.value / investedValue,
    };
  }

  double _allocationScore({
    required PortfolioDecision decision,
    required double existingSectorWeight,
  }) {
    final stock = decision.stock;
    final diversificationBonus = switch (existingSectorWeight) {
      >= 0.30 => -14.0,
      >= 0.22 => -8.0,
      >= 0.14 => -2.0,
      <= 0.04 => 10.0,
      <= 0.10 => 5.0,
      _ => 0.0,
    };
    final actionBonus = switch (stock.action) {
      RecommendationAction.accumulate => 6.0,
      RecommendationAction.buy => 4.0,
      RecommendationAction.hold => -3.0,
      RecommendationAction.watch => -2.0,
      _ => 0.0,
    };

    return (decision.score * 0.58 +
            stock.confidenceScore * 0.16 +
            stock.opportunityScore * 0.12 +
            stock.regimeFit * 0.08 -
            stock.fragilityScore * 0.06 -
            stock.riskScore * 0.04 +
            diversificationBonus +
            actionBonus)
        .clamp(0, 100);
  }

  String _sizingLabel({
    required int priorityRank,
    required double buyNowBudgetShare,
  }) {
    if (priorityRank == 1 && buyNowBudgetShare >= 0.30) {
      return 'Core starter';
    }
    if (buyNowBudgetShare >= 0.18) {
      return 'Starter';
    }
    return 'Nibble';
  }

  String _buyPlanRationale({
    required StockInsight stock,
    required PortfolioCapitalPlan capitalPlan,
    required double existingSectorWeight,
  }) {
    final diversificationText = existingSectorWeight >= 0.22
        ? '${stock.sector} already accounts for ${(existingSectorWeight * 100).toStringAsFixed(1)}% of tracked invested capital, so this name starts smaller until that exposure comes down.'
        : existingSectorWeight <= 0.08
        ? '${stock.sector} is still a light exposure in the tracked portfolio, so the app is willing to start this one a bit larger.'
        : '${stock.sector} is not overcrowded in the tracked portfolio, so size can mostly follow signal quality.';
    final reserveText = capitalPlan.reserveCash / capitalPlan.cashBalance >= 0.3
        ? 'Market risk is still elevated enough that the app keeps a larger reserve, so this stays a staged entry instead of a full-size swing.'
        : 'The market backdrop allows a cleaner starter size, but the plan still leaves dry powder for pullbacks or confirmation adds.';
    return '$diversificationText $reserveText';
  }

  String _formatMoney(double value) {
    final absolute = value.abs();
    if (absolute >= 1000000) {
      return '\$${(value / 1000000).toStringAsFixed(2)}M';
    }
    if (absolute >= 1000) {
      return '\$${(value / 1000).toStringAsFixed(1)}k';
    }
    return '\$${value.toStringAsFixed(0)}';
  }
}

class _AllocationCandidate {
  const _AllocationCandidate({
    required this.decision,
    required this.allocationScore,
    required this.existingSectorWeight,
  });

  final PortfolioDecision decision;
  final double allocationScore;
  final double existingSectorWeight;
}
