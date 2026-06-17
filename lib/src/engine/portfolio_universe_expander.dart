import '../models/market_intelligence.dart';

/// Injects a neutral `StockInsight` stub into a snapshot for every portfolio
/// ticker that isn't already in `rankedUniverse`. This lets the Decision Desk
/// and universe action feed represent every imported position — the stubs
/// carry watch-level defaults because the engine has no real signals for
/// them yet, so the action feed honestly reports uncertainty rather than
/// hiding the position entirely.
class PortfolioUniverseExpander {
  const PortfolioUniverseExpander();

  MarketIntelligenceSnapshot expand(
    MarketIntelligenceSnapshot snapshot,
    Iterable<String> portfolioTickers, {
    String defaultSector = 'Portfolio-only',
  }) {
    final existing = {
      for (final stock in snapshot.rankedUniverse) stock.ticker,
    };
    final missing = portfolioTickers
        .map((ticker) => ticker.trim().toUpperCase())
        .where((ticker) => ticker.isNotEmpty && !existing.contains(ticker))
        .toSet();

    if (missing.isEmpty) return snapshot;

    final stubs = missing
        .map((ticker) => _buildStub(ticker, defaultSector))
        .toList();
    final mergedUniverse = [...snapshot.rankedUniverse, ...stubs];

    return snapshot.copyWith(rankedUniverse: mergedUniverse);
  }

  StockInsight _buildStub(String ticker, String defaultSector) {
    return StockInsight(
      ticker: ticker,
      company: ticker,
      sector: defaultSector,
      industry: 'Unclassified',
      action: RecommendationAction.watch,
      opportunityScore: 50,
      regimeFit: 50,
      trendQuality: 50,
      revisionTrend: 50,
      convictionScore: 50,
      fragilityScore: 50,
      asymmetryScore: 50,
      riskScore: 50,
      confidenceScore: 40,
      summary:
          'This ticker is in your portfolio but not yet in the analyzed universe, so signals are neutral until a data feed backfills it.',
      whyItRanks: const [
        'Your portfolio includes this name — the app is tracking it for ownership but has no real signal data yet.',
      ],
      whatCouldGoWrong: const [
        'Signals are neutral placeholders. Real conviction/fragility reads require price, revision, and options data for this ticker.',
      ],
      invalidationSignals: const [
        'Any directional call on this name should wait until real signals arrive.',
      ],
      recentChanges: const [
        'No change history available — ticker was added through portfolio import.',
      ],
      stabilitySummary:
          'Treat this as a watch-only position until the data pipeline catches up with it.',
      optionsSignal: const OptionsSignal(
        ivRank: 50,
        realizedGap: 0,
        skewChange: 50,
        eventPremium: 0,
        commentary:
            'No options data available for portfolio-only tickers until a dedicated options feed is connected.',
      ),
      peers: const [],
      confidenceBreakdown: const ConfidenceBreakdown(
        composite: 40,
        tier: ConfidenceTier.low,
        components: [
          ConfidenceComponent(
            label: 'Data coverage',
            weight: 1.0,
            value: 40,
            supporting: false,
            rationale: 'Portfolio-only ticker has no real signal coverage yet.',
          ),
        ],
        conflictScore: 0,
        summary:
            'Confidence is low because the engine has no primary data for this ticker. Add it to kSymbolUniverse in local_secrets.dart to start tracking it.',
      ),
      decisionTrust: const DecisionTrustReport(
        level: DecisionTrustLevel.insufficientData,
        summary:
            'This ticker is being tracked locally, but it has no connected signal coverage yet.',
        components: [
          SignalProvenanceComponent(
            label: 'Price and volume',
            provenance: SignalProvenance.missing,
            detail:
                'No connected price feed has produced a scored signal for this ticker yet.',
            blocksStrongActions: true,
          ),
          SignalProvenanceComponent(
            label: 'Fundamentals',
            provenance: SignalProvenance.missing,
            detail:
                'No fundamental provider has produced a scored signal for this ticker yet.',
            blocksStrongActions: true,
          ),
          SignalProvenanceComponent(
            label: 'Options surface',
            provenance: SignalProvenance.missing,
            detail:
                'No options provider has produced a scored signal for this ticker yet.',
            blocksStrongActions: true,
          ),
        ],
      ),
    );
  }
}
