import '../models/intelligence_app_state.dart';
import '../models/market_intelligence.dart';

class RecommendationTrustGate {
  const RecommendationTrustGate();

  MarketIntelligenceSnapshot apply({
    required MarketIntelligenceSnapshot snapshot,
    required List<DataFeedStatus> feeds,
  }) {
    final components = _componentsFor(feeds);
    final rankedUniverse = snapshot.rankedUniverse
        .map((stock) => _applyToStock(stock, components))
        .toList();
    final opportunities = snapshot.opportunities
        .map(
          (stock) => rankedUniverse.firstWhere(
            (candidate) => candidate.ticker == stock.ticker,
            orElse: () => _applyToStock(stock, components),
          ),
        )
        .toList();

    return snapshot.copyWith(
      rankedUniverse: rankedUniverse,
      opportunities: opportunities,
    );
  }

  List<SignalProvenanceComponent> _componentsFor(List<DataFeedStatus> feeds) {
    final market = _find(feeds, 'Market and breadth');
    final stock = _find(feeds, 'Stock, revisions, and options signals');
    final style = _find(feeds, 'Style and factor rotation');
    final sector = _find(feeds, 'Sector sponsorship');
    final validation = _find(feeds, 'Research labels and windows');
    final finnhub = _find(feeds, 'Finnhub fundamentals');
    final fred = _find(feeds, 'FRED macro');

    final priceProvenance = _availabilityToProvenance(stock?.availability);
    final macroProvenance = fred?.availability == FeedAvailability.connected
        ? SignalProvenance.live
        : _macroProvenance(market);
    final fundamentalsProvenance =
        finnhub?.availability == FeedAvailability.connected
        ? SignalProvenance.live
        : _fallbackProvenance(stock);
    final revisionProvenance =
        finnhub?.availability == FeedAvailability.connected
        ? SignalProvenance.live
        : _fallbackProvenance(stock);
    final optionsProvenance = _optionsProvenance(feeds);

    return [
      SignalProvenanceComponent(
        label: 'Price and volume',
        provenance: priceProvenance,
        detail:
            stock?.detail ??
            'No stock price feed was reported for this snapshot.',
        blocksStrongActions: !priceProvenance.isReal,
      ),
      SignalProvenanceComponent(
        label: 'Macro and regime',
        provenance: macroProvenance,
        detail:
            fred?.detail ??
            market?.detail ??
            'No macro provider was reported for this snapshot.',
      ),
      SignalProvenanceComponent(
        label: 'Style rotation',
        provenance: _availabilityToProvenance(style?.availability),
        detail:
            style?.detail ??
            'No style provider was reported for this snapshot.',
      ),
      SignalProvenanceComponent(
        label: 'Sector sponsorship',
        provenance: _availabilityToProvenance(sector?.availability),
        detail:
            sector?.detail ??
            'No sector provider was reported for this snapshot.',
      ),
      SignalProvenanceComponent(
        label: 'Fundamentals',
        provenance: fundamentalsProvenance,
        detail:
            finnhub?.detail ??
            'Fundamental fields are still fallback or derived estimates.',
        blocksStrongActions: !fundamentalsProvenance.isReal,
      ),
      SignalProvenanceComponent(
        label: 'Estimate revisions',
        provenance: revisionProvenance,
        detail:
            finnhub?.detail ??
            'Revision fields are still fallback or derived estimates.',
        blocksStrongActions: !revisionProvenance.isReal,
      ),
      SignalProvenanceComponent(
        label: 'Options surface',
        provenance: optionsProvenance,
        detail:
            'Options risk is currently an inferred surface until a chain, skew, or volatility provider is connected.',
        blocksStrongActions: !optionsProvenance.isReal,
      ),
      SignalProvenanceComponent(
        label: 'Forward outcomes',
        provenance: _availabilityToProvenance(validation?.availability),
        detail:
            validation?.detail ??
            'No point-in-time outcome label provider was reported.',
      ),
    ];
  }

  StockInsight _applyToStock(
    StockInsight stock,
    List<SignalProvenanceComponent> components,
  ) {
    final blockers = components
        .where((component) => component.blocksStrongActions)
        .toList();
    final missingCritical = blockers
        .where(
          (component) =>
              component.provenance == SignalProvenance.missing ||
              component.provenance == SignalProvenance.fixture,
        )
        .length;
    final level = missingCritical >= 3
        ? DecisionTrustLevel.insufficientData
        : blockers.isNotEmpty
        ? DecisionTrustLevel.researchOnly
        : DecisionTrustLevel.actionable;

    final gatedAction = _gatedAction(stock.action, level);
    final confidenceCap = switch (level) {
      DecisionTrustLevel.actionable => 100.0,
      DecisionTrustLevel.researchOnly => 59.0,
      DecisionTrustLevel.insufficientData => 44.0,
    };
    final cappedConfidence = stock.confidenceScore
        .clamp(0, confidenceCap)
        .toDouble();
    final trust = DecisionTrustReport(
      level: level,
      originalAction: stock.action,
      gatedAction: gatedAction,
      components: components,
      summary: _summaryFor(
        level: level,
        originalAction: stock.action,
        gatedAction: gatedAction,
        blockers: blockers,
      ),
    );

    return stock.copyWith(
      action: gatedAction,
      confidenceScore: cappedConfidence,
      confidenceBreakdown: _gateConfidenceBreakdown(
        stock.confidenceBreakdown,
        level,
        cappedConfidence,
      ),
      forecasts: _gateForecasts(stock.forecasts, level),
      decisionTrust: trust,
    );
  }

  ConfidenceBreakdown _gateConfidenceBreakdown(
    ConfidenceBreakdown breakdown,
    DecisionTrustLevel level,
    double cappedConfidence,
  ) {
    if (level == DecisionTrustLevel.actionable) {
      return breakdown;
    }
    final tier = level == DecisionTrustLevel.insufficientData
        ? ConfidenceTier.low
        : ConfidenceTier.moderate;
    final prefix = level == DecisionTrustLevel.insufficientData
        ? 'Confidence is capped because critical data is missing.'
        : 'Confidence is capped because key inputs are still research-only.';
    return ConfidenceBreakdown(
      composite: cappedConfidence,
      tier: tier,
      components: breakdown.components,
      conflictScore: breakdown.conflictScore,
      summary: '$prefix ${breakdown.summary}',
    );
  }

  ForecastPack _gateForecasts(
    ForecastPack forecasts,
    DecisionTrustLevel level,
  ) {
    if (forecasts.isEmpty || level == DecisionTrustLevel.actionable) {
      return forecasts;
    }
    final cap = level == DecisionTrustLevel.insufficientData ? 50.0 : 58.0;
    return forecasts.copyWith(
      outperformSectorProbability: forecasts.outperformSectorProbability
          .clamp(0, cap)
          .toDouble(),
      breakoutPersistenceProbability: forecasts.breakoutPersistenceProbability
          .clamp(0, cap)
          .toDouble(),
    );
  }

  RecommendationAction _gatedAction(
    RecommendationAction action,
    DecisionTrustLevel level,
  ) {
    if (level == DecisionTrustLevel.actionable) {
      return action;
    }
    return switch (action) {
      RecommendationAction.buy ||
      RecommendationAction.accumulate => RecommendationAction.watch,
      RecommendationAction.exit => RecommendationAction.deRisk,
      _ => action,
    };
  }

  String _summaryFor({
    required DecisionTrustLevel level,
    required RecommendationAction originalAction,
    required RecommendationAction gatedAction,
    required List<SignalProvenanceComponent> blockers,
  }) {
    final blockedLabels = blockers.map((b) => b.label.toLowerCase()).join(', ');
    final actionText = originalAction == gatedAction
        ? ''
        : ' The raw ${originalAction.label} action was gated to ${gatedAction.label}.';
    return switch (level) {
      DecisionTrustLevel.actionable =>
        'The required price, fundamental, revision, and options inputs are sufficiently covered for this action.',
      DecisionTrustLevel.researchOnly =>
        'Treat this as research-only until $blockedLabels are upgraded to connected or cached feeds.$actionText',
      DecisionTrustLevel.insufficientData =>
        'Insufficient critical coverage: $blockedLabels are missing, fixture-backed, or derived. Use this as a tracking stub, not a trade signal.$actionText',
    };
  }

  DataFeedStatus? _find(List<DataFeedStatus> feeds, String name) {
    for (final feed in feeds) {
      if (feed.name.toLowerCase().contains(name.toLowerCase())) {
        return feed;
      }
    }
    return null;
  }

  SignalProvenance _macroProvenance(DataFeedStatus? feed) {
    if (feed == null) {
      return SignalProvenance.missing;
    }
    if (feed.availability == FeedAvailability.connected &&
        feed.detail.toLowerCase().contains('macro fields still carried')) {
      return SignalProvenance.derived;
    }
    return _availabilityToProvenance(feed.availability);
  }

  SignalProvenance _fallbackProvenance(DataFeedStatus? stock) {
    if (stock == null) {
      return SignalProvenance.missing;
    }
    final detail = stock.detail.toLowerCase();
    if (detail.contains('fallback') || detail.contains('derived')) {
      return SignalProvenance.derived;
    }
    return _availabilityToProvenance(stock.availability);
  }

  SignalProvenance _optionsProvenance(List<DataFeedStatus> feeds) {
    final options = _find(feeds, 'Options surface');
    if (options != null) {
      return _availabilityToProvenance(options.availability);
    }
    return SignalProvenance.derived;
  }

  SignalProvenance _availabilityToProvenance(FeedAvailability? availability) {
    return switch (availability) {
      FeedAvailability.connected => SignalProvenance.live,
      FeedAvailability.fixture => SignalProvenance.fixture,
      FeedAvailability.planned => SignalProvenance.missing,
      FeedAvailability.missing => SignalProvenance.missing,
      null => SignalProvenance.missing,
    };
  }
}
