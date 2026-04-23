import 'dart:math' as math;

import '../models/market_intelligence.dart';
import '../models/portfolio_models.dart';

enum PortfolioDecisionAction { buy, hold, watch, trim, sell }

extension PortfolioDecisionActionLabel on PortfolioDecisionAction {
  String get label => switch (this) {
    PortfolioDecisionAction.buy => 'Buy candidate',
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

  bool get isOwned => holding != null;
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
  });

  final List<PortfolioDecision> buyCandidates;
  final List<PortfolioDecision> holdDecisions;
  final List<PortfolioDecision> watchDecisions;
  final List<PortfolioDecision> trimDecisions;
  final List<PortfolioDecision> sellDecisions;
  final List<PortfolioHolding> unmatchedHoldings;
  final String summary;

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

    final buyCandidates = <PortfolioDecision>[];
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
          buyCandidates.add(decision);
      }
    }

    final ownedTickers = portfolio.tickers;
    final unownedRanked = snapshot.rankedUniverse.where(
      (stock) => !ownedTickers.contains(stock.ticker),
    );

    buyCandidates.addAll(
      unownedRanked
          .where(_isBuyCandidate)
          .take(5)
          .map(
            (stock) => _decisionFor(
              action: PortfolioDecisionAction.buy,
              stock: stock,
              alert: alertByTicker[stock.ticker],
            ),
          ),
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
      buyCandidates: _sortByScore(buyCandidates),
      holdDecisions: _sortByScore(holdDecisions),
      watchDecisions: _sortByScore(watchDecisions),
      trimDecisions: _sortByScore(trimDecisions),
      sellDecisions: _sortByScore(sellDecisions),
      unmatchedHoldings: unmatchedHoldings,
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
      ),
    );
  }

  PortfolioDecisionAction _classifyOwnedHolding(
    StockInsight stock,
    SellAlert? alert,
  ) {
    if (alert != null &&
        (alert.action == RecommendationAction.exit ||
            alert.severity == AlertSeverity.critical ||
            alert.thesisDamageScore >= 82)) {
      return PortfolioDecisionAction.sell;
    }
    if (stock.action == RecommendationAction.exit ||
        stock.action == RecommendationAction.avoidForNow ||
        (stock.opportunityScore < 55 && stock.fragilityScore >= 70)) {
      return PortfolioDecisionAction.sell;
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
    return stock.opportunityScore >= 74 &&
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
    );
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
      PortfolioDecisionAction.buy => '${stock.ticker}: research a new buy',
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
        '$ownership The setup earns buy-candidate status because opportunity, regime fit, and confidence are strong enough while risk is still controlled. Treat this as a research shortlist item, not an automatic trade.',
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
  }) {
    if (portfolio.isEmpty) {
      return 'No portfolio is imported yet, so the desk can only rank new buy candidates and watchlist ideas. Import Fidelity positions to unlock hold, trim, and sell decisions for what you already own.';
    }
    return '$matchedHoldingCount imported holdings matched the current research universe, $unmatchedHoldingCount did not match yet, $buyCandidateCount new buy candidates are available, and $riskDecisionCount owned names need trim or sell review.';
  }

  String _formatShares(double value) {
    if (value == value.roundToDouble()) {
      return value.round().toString();
    }
    return value.toStringAsFixed(2);
  }
}
