import 'dart:async';

import '../engine/market_intelligence_engine.dart';
import '../engine/market_metric_history_builder.dart';
import '../engine/validation_engine.dart';
import '../engine/recommendation_trust_gate.dart';
import '../models/intelligence_app_state.dart';
import 'alpha_vantage_market_feed_provider.dart';
import 'finnhub_feed_provider.dart';
import 'fred_macro_feed_provider.dart';
import 'gdelt_event_feed_provider.dart';
import 'live_market_feed_provider.dart';
import 'local_secrets.dart' as local;
import 'market_data_configuration.dart';
import 'market_feed_provider.dart';
import 'market_intelligence_repository.dart';
import 'market_snapshot_archive.dart';
import 'market_snapshot_archive_factory.dart';
import 'raw_market_data.dart';
import 'sec_edgar_feed_provider.dart';
import 'stooq_feed_provider.dart';
import 'treasury_fiscal_feed_provider.dart';
import 'yahoo_finance_feed_provider.dart';

class ProviderMarketRepository implements MarketIntelligenceRepository {
  ProviderMarketRepository({
    required MarketEnvironmentProvider marketEnvironmentProvider,
    required StyleSignalProvider styleSignalProvider,
    required SectorSignalProvider sectorSignalProvider,
    required StockSignalProvider stockSignalProvider,
    required ValidationWindowProvider validationWindowProvider,
    required HistoricalMarketStateProvider historicalMarketStateProvider,
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
    Future<List<DataFeedStatus>> Function()? supplementalFeedStatusesLoader,
    this.dataTitle = 'Provider-backed research repository',
    this.dataSummary =
        'The app now runs through pluggable feed providers for market, style, sector, stock, and research windows. The current adapters are still fixture-backed, but live vendors can now replace them without changing the engine contract.',
    this.engineSummary =
        'A rules-based ensemble now consumes provider-backed feeds to derive the regime read, stock ranking, sell alerts, and scenarios. The feed architecture is ready for live vendors, but the engine itself is still not trained.',
    this.engineCaveats = const [
      'This is still not a trained model stack.',
      'The provider layer is live-ready, but the current adapters still point at fixture data.',
      'Validation remains vendor-free until real point-in-time feeds are connected.',
      'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
    ],
    this.engineNextSteps = const [
      'Implement connected providers for market, fundamentals, and options data.',
      'Promote the local archive into a durable point-in-time history store.',
      'Run leakage-safe backtests and shadow mode on connected feeds before training ML models.',
    ],
  }) : _marketEnvironmentProvider = marketEnvironmentProvider,
       _styleSignalProvider = styleSignalProvider,
       _sectorSignalProvider = sectorSignalProvider,
       _stockSignalProvider = stockSignalProvider,
       _validationWindowProvider = validationWindowProvider,
       _historicalMarketStateProvider = historicalMarketStateProvider,
       _archive = archive ?? createDefaultMarketSnapshotArchive(),
       _engine = engine ?? MarketIntelligenceEngine(),
       _supplementalFeedStatusesLoader = supplementalFeedStatusesLoader,
       _validationEngine = ValidationEngine(
         engine: engine ?? MarketIntelligenceEngine(),
       );

  factory ProviderMarketRepository.fixtureBacked({
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
    int stockUniverseLimit = 40,
    int historicalSnapshotLimit = 240,
  }) {
    final provider = FixtureMarketFeedProvider(
      stockUniverseLimit: stockUniverseLimit,
      historicalSnapshotLimit: historicalSnapshotLimit,
    );
    return ProviderMarketRepository(
      marketEnvironmentProvider: provider,
      styleSignalProvider: provider,
      sectorSignalProvider: provider,
      stockSignalProvider: provider,
      validationWindowProvider: provider,
      historicalMarketStateProvider: provider,
      archive:
          archive ??
          createDefaultMarketSnapshotArchive(
            maxSnapshots: historicalSnapshotLimit,
          ),
      engine: engine,
      dataSummary:
          'The app now runs through pluggable feed providers for market, style, sector, stock, and research windows. In fixture mode, the local archive is primed with research replay history so trend charts read from durable history instead of transient interpolation, and the screened universe expands beyond the original hand-picked sample.',
    );
  }

  factory ProviderMarketRepository.liveConfigured({
    required MarketDataConfiguration configuration,
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
  }) {
    final fixtureProvider = FixtureMarketFeedProvider(
      stockUniverseLimit: configuration.stockUniverseLimit,
      historicalSnapshotLimit: configuration.historicalSnapshotLimit,
    );
    final liveProvider = LiveMarketFeedProvider(
      configuration: configuration,
      fallbackProvider: fixtureProvider,
    );
    final finnhubProvider = FinnhubFeedProvider(
      apiKey: configuration.finnhubApiKey ?? local.kFinnhubApiKey,
      symbols: configuration.alphaVantageSymbols.isNotEmpty
          ? configuration.alphaVantageSymbols.take(20).toList()
          : const <String>['AAPL', 'MSFT', 'SPY'],
    );
    final macroProvider = FredMacroFeedProvider(
      apiKey: configuration.fredApiKey ?? local.kFredApiKey,
      fallbackProvider: liveProvider,
    );
    final treasuryProvider = TreasuryFiscalFeedProvider(
      fallbackProvider: macroProvider,
    );
    final symbols = configuration.alphaVantageSymbols.isNotEmpty
        ? configuration.alphaVantageSymbols
        : const <String>['AAPL', 'MSFT', 'SPY'];
    final secProvider = SecEdgarFeedProvider(
      symbols: symbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final gdeltProvider = GdeltEventFeedProvider(
      symbols: symbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final finnhubStockProvider = FinnhubFundamentalsOverlayStockProvider(
      fallbackProvider: liveProvider,
      finnhubProvider: finnhubProvider,
    );
    final secStockProvider = SecEdgarFundamentalsOverlayStockProvider(
      fallbackProvider: finnhubStockProvider,
      secProvider: secProvider,
    );
    final stockProvider = GdeltEventRiskOverlayStockProvider(
      fallbackProvider: secStockProvider,
      gdeltProvider: gdeltProvider,
    );

    final dataTitle = switch (configuration.mode) {
      MarketDataMode.fixtureOnly => 'Provider-backed research repository',
      MarketDataMode.livePreferred => 'Live-preferred market repository',
      MarketDataMode.liveRequired => 'Live-required market repository',
      MarketDataMode.alphaVantage => 'Alpha Vantage price spine',
    };

    final dataSummary = switch (configuration.mode) {
      MarketDataMode.fixtureOnly =>
        'The app is running through provider-backed contracts, but explicitly in fixture mode.',
      MarketDataMode.livePreferred =>
        'The app is attempting to use live feed adapters first and falls back to fixtures when a live endpoint is not configured or unavailable.',
      MarketDataMode.liveRequired =>
        'The app is configured to require live feed adapters. If a live endpoint is missing or unhealthy, the repository will fail fast instead of silently using fixtures.',
      MarketDataMode.alphaVantage =>
        'The app is configured for Alpha Vantage daily price history. Use ProviderMarketRepository.alphaVantageConfigured so the price-spine adapter is selected.',
    };

    final engineCaveats = switch (configuration.mode) {
      MarketDataMode.fixtureOnly => const [
        'This is still not a trained model stack.',
        'The provider layer is live-ready, but the current run is explicitly fixture-only.',
        'Validation remains vendor-free until real point-in-time feeds are connected.',
        'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
      ],
      MarketDataMode.livePreferred => const [
        'This is still not a trained model stack.',
        'Live mode is preferred, but any missing endpoint can still fall back to fixtures.',
        'Validation is only point-in-time once connected research windows arrive from a live source.',
        'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
      ],
      MarketDataMode.liveRequired => const [
        'This is still not a trained model stack.',
        'Live-required mode fails fast when a live adapter is missing or unhealthy.',
        'Point-in-time validation is only as honest as the connected research feed.',
        'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
      ],
      MarketDataMode.alphaVantage => const [
        'This is still not a trained model stack.',
        'Alpha Vantage mode should use the dedicated price-spine repository factory.',
        'Fundamentals, revisions, options-style fields, and validation labels still need connected feeds.',
        'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
      ],
    };

    return ProviderMarketRepository(
      marketEnvironmentProvider: treasuryProvider,
      styleSignalProvider: liveProvider,
      sectorSignalProvider: liveProvider,
      stockSignalProvider: stockProvider,
      validationWindowProvider: liveProvider,
      historicalMarketStateProvider: liveProvider,
      archive:
          archive ??
          createDefaultMarketSnapshotArchive(
            maxSnapshots: configuration.historicalSnapshotLimit,
          ),
      engine: engine,
      dataTitle: dataTitle,
      dataSummary: dataSummary,
      engineSummary:
          'A rules-based ensemble now consumes provider-backed feeds plus the free macro, SEC, Treasury, and event-risk layer to derive regime reads, stock rankings, buy/hold/sell guidance, sell alerts, and scenarios.',
      engineCaveats: engineCaveats,
      engineNextSteps: const [
        'Promote the free-source overlays into a server-backed cache so daily decisions are faster and less exposed to browser CORS limits.',
        'Connect a real options endpoint for IV skew, term structure, and flow confirmation.',
        'Promote the local archive into a durable point-in-time history store.',
      ],
    );
  }

  factory ProviderMarketRepository.alphaVantageConfigured({
    required MarketDataConfiguration configuration,
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
  }) {
    final fixtureProvider = FixtureMarketFeedProvider(
      stockUniverseLimit: configuration.stockUniverseLimit,
      historicalSnapshotLimit: configuration.historicalSnapshotLimit,
    );
    final alphaVantageProvider = AlphaVantageMarketFeedProvider(
      configuration: configuration,
      fallbackProvider: fixtureProvider,
    );

    // Probe Yahoo + Stooq with a small sample of the universe so the UI shows
    // their availability. These are not yet wired into the scoring pipeline;
    // they prove the app can reach them and records the connection for later.
    final probeSymbols = configuration.alphaVantageSymbols.isNotEmpty
        ? configuration.alphaVantageSymbols.take(5).toList()
        : const <String>['AAPL', 'MSFT', 'SPY'];
    final yahooProvider = YahooFinanceFeedProvider(
      symbols: probeSymbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final stooqProvider = StooqFeedProvider(
      symbols: probeSymbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final finnhubProvider = FinnhubFeedProvider(
      apiKey: configuration.finnhubApiKey ?? local.kFinnhubApiKey,
      symbols: probeSymbols,
    );
    final macroProvider = FredMacroFeedProvider(
      apiKey: configuration.fredApiKey ?? local.kFredApiKey,
      fallbackProvider: alphaVantageProvider,
    );
    final treasuryProvider = TreasuryFiscalFeedProvider(
      fallbackProvider: macroProvider,
    );
    final secProvider = SecEdgarFeedProvider(
      symbols: probeSymbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final gdeltProvider = GdeltEventFeedProvider(
      symbols: probeSymbols,
      corsProxyPrefix: configuration.corsProxyPrefix,
    );
    final finnhubStockProvider = FinnhubFundamentalsOverlayStockProvider(
      fallbackProvider: alphaVantageProvider,
      finnhubProvider: finnhubProvider,
    );
    final secStockProvider = SecEdgarFundamentalsOverlayStockProvider(
      fallbackProvider: finnhubStockProvider,
      secProvider: secProvider,
    );
    final stockProvider = GdeltEventRiskOverlayStockProvider(
      fallbackProvider: secStockProvider,
      gdeltProvider: gdeltProvider,
    );

    Future<List<DataFeedStatus>> supplementalLoader() async {
      final primary = await alphaVantageProvider.loadSupplementalFeedStatuses();
      final extra = <DataFeedStatus>[];
      try {
        final yahooSlice = await yahooProvider.loadUniverse(rangeDays: 60);
        extra.add(
          DataFeedStatus(
            name: 'Yahoo Finance (secondary)',
            availability: yahooSlice.availability,
            refreshCadence: yahooSlice.refreshCadence,
            detail: yahooSlice.detail,
            lastUpdated: yahooSlice.asOf,
          ),
        );
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'Yahoo Finance (secondary)',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.daily,
            detail:
                'Yahoo Finance is unreachable. Configure kCorsProxyPrefix in local_secrets.dart or run the app server-side.',
          ),
        );
      }
      try {
        final stooqSlice = await stooqProvider.loadUniverse();
        extra.add(
          DataFeedStatus(
            name: 'Stooq (secondary)',
            availability: stooqSlice.availability,
            refreshCadence: stooqSlice.refreshCadence,
            detail: stooqSlice.detail,
            lastUpdated: stooqSlice.asOf,
          ),
        );
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'Stooq (secondary)',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.daily,
            detail:
                'Stooq did not respond. May be rate-limited or temporarily unavailable.',
          ),
        );
      }
      try {
        final finnhubSlice = await finnhubProvider.probe();
        extra.add(
          DataFeedStatus(
            name: 'Finnhub fundamentals',
            availability: finnhubSlice.availability,
            refreshCadence: finnhubSlice.refreshCadence,
            detail: finnhubSlice.detail,
            lastUpdated: finnhubSlice.asOf,
          ),
        );
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'Finnhub fundamentals',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.intraday,
            detail:
                'Finnhub request failed. Check the API key and rate limits.',
          ),
        );
      }
      extra.add(
        FredMacroStatusProvider(
          apiKey: configuration.fredApiKey ?? local.kFredApiKey,
        ).status(),
      );
      try {
        extra.add(await treasuryProvider.status());
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'U.S. Treasury Fiscal Data',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.daily,
            detail:
                'Treasury Fiscal Data did not respond. FRED and price-derived rate proxies remain active.',
          ),
        );
      }
      try {
        final secSlice = await secProvider.probe();
        extra.add(
          DataFeedStatus(
            name: 'SEC EDGAR fundamentals',
            availability: secSlice.availability,
            refreshCadence: secSlice.refreshCadence,
            detail: secSlice.detail,
            lastUpdated: secSlice.asOf,
          ),
        );
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'SEC EDGAR fundamentals',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.eventDriven,
            detail:
                'SEC EDGAR request failed. Browser builds may need kCorsProxyPrefix because data.sec.gov does not support browser CORS.',
          ),
        );
      }
      try {
        final gdeltSlice = await gdeltProvider.probe();
        extra.add(
          DataFeedStatus(
            name: 'GDELT event risk',
            availability: gdeltSlice.availability,
            refreshCadence: gdeltSlice.refreshCadence,
            detail: gdeltSlice.detail,
            lastUpdated: gdeltSlice.asOf,
          ),
        );
      } catch (_) {
        extra.add(
          const DataFeedStatus(
            name: 'GDELT event risk',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.eventDriven,
            detail:
                'GDELT request failed. Event-risk scoring will rely on price, SEC filings, and existing risk fields.',
          ),
        );
      }
      return [...primary, ...extra];
    }

    return ProviderMarketRepository(
      marketEnvironmentProvider: treasuryProvider,
      styleSignalProvider: alphaVantageProvider,
      sectorSignalProvider: alphaVantageProvider,
      stockSignalProvider: stockProvider,
      validationWindowProvider: alphaVantageProvider,
      historicalMarketStateProvider: alphaVantageProvider,
      supplementalFeedStatusesLoader: supplementalLoader,
      archive:
          archive ??
          createDefaultMarketSnapshotArchive(
            maxSnapshots: configuration.historicalSnapshotLimit,
          ),
      engine: engine,
      dataTitle: 'Alpha Vantage price spine',
      dataSummary:
          'Daily OHLCV prices from Alpha Vantage drive the real price-history spine when an API key and quota are available. The app syncs that history into a local store first, then layers in the free-source macro, Treasury, SEC EDGAR, and GDELT evidence where reachable; options-style signals remain inferred until an options chain provider is connected.',
      engineSummary:
          'A rules-based ensemble now consumes Alpha Vantage price history plus free macro, filing, and event-risk evidence where available to derive regime reads, stock rankings, buy/hold/sell guidance, sell alerts, and scenario views. It is decision-ready as a rules engine, but not yet a trained or calibrated ML stack.',
      engineCaveats: const [
        'This is still not a trained model stack.',
        'Free-source SEC and GDELT coverage can be delayed or blocked by browser CORS unless a proxy/server layer is used.',
        'Options-style fields remain inferred until a real options provider is connected.',
        'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
      ],
      engineNextSteps: const [
        'Use the Decision Desk daily: review new buys, holds, trims, exits, and the evidence that would change them.',
        'Move free-source SEC, Treasury, and GDELT calls behind a backend cache for reliability.',
        'Connect a paid options provider when IV skew, term structure, and flow need to stop being inferred.',
      ],
    );
  }

  final MarketEnvironmentProvider _marketEnvironmentProvider;
  final StyleSignalProvider _styleSignalProvider;
  final SectorSignalProvider _sectorSignalProvider;
  final StockSignalProvider _stockSignalProvider;
  final ValidationWindowProvider _validationWindowProvider;
  final HistoricalMarketStateProvider _historicalMarketStateProvider;
  final MarketSnapshotArchive _archive;
  final MarketIntelligenceEngine _engine;
  final Future<List<DataFeedStatus>> Function()?
  _supplementalFeedStatusesLoader;
  final ValidationEngine _validationEngine;
  final String dataTitle;
  final String dataSummary;
  final String engineSummary;
  final List<String> engineCaveats;
  final List<String> engineNextSteps;
  static const Duration _supplementalFeedStatusTimeout = Duration(seconds: 12);
  static const int _mediumUniverseStockThreshold = 250;
  static const int _largeUniverseStockThreshold = 500;
  static const int _mediumUniverseHistoryLimit = 120;
  static const int _largeUniverseHistoryLimit = 75;

  @override
  Future<IntelligenceAppState> loadState() async {
    final syncTime = DateTime.now();
    final environmentFeedFuture = _marketEnvironmentProvider
        .loadMarketEnvironment();
    final styleFeedFuture = _styleSignalProvider.loadStyleSignals();
    final sectorFeedFuture = _sectorSignalProvider.loadSectorSignals();
    final stockFeedFuture = _stockSignalProvider.loadStockSignals();
    final validationFeedFuture = _validationWindowProvider
        .loadValidationWindows();
    final historicalFeedFuture = _historicalMarketStateProvider
        .loadHistoricalMarketStates();

    final environmentFeed = await environmentFeedFuture;
    final styleFeed = await styleFeedFuture;
    final sectorFeed = await sectorFeedFuture;
    final stockFeed = await stockFeedFuture;
    final validationFeed = await validationFeedFuture;
    final historicalFeed = await historicalFeedFuture;

    final currentState = RawMarketState(
      asOf: _latestAsOf([
        environmentFeed.asOf,
        styleFeed.asOf,
        sectorFeed.asOf,
        stockFeed.asOf,
      ]),
      environment: environmentFeed.data,
      styles: styleFeed.data,
      sectors: sectorFeed.data,
      stocks: stockFeed.data,
    );

    final historicalStates = historicalFeed.data
        .where((state) => state.asOf.isBefore(currentState.asOf))
        .toList();
    if (historicalStates.isNotEmpty) {
      await _archive.saveSnapshots(
        historicalStates,
        source: historicalFeed.source,
      );
    }

    final evaluation = _engine.evaluate(currentState);
    final sourceSummary = {
      environmentFeed.source,
      styleFeed.source,
      sectorFeed.source,
      stockFeed.source,
    }.join(', ');
    final archiveSummary = await _archive.saveSnapshot(
      currentState,
      source: 'provider-current:$sourceSummary',
    );
    final validation = _validationEngine.validate(
      validationFeed.data,
      archivedSnapshotCount: archiveSummary.snapshotCount,
      stockUniverseCount: currentState.stocks.length,
    );
    final archivedSnapshots = await _archive.loadSnapshots();
    final historyEvaluationLimit = _historyEvaluationLimitFor(
      currentState.stocks.length,
    );
    final snapshotWithHistory = withHistoricalInsights(
      snapshot: evaluation.snapshot,
      historicalSnapshots: archivedSnapshots,
      engine: _engine,
      maxHistoryPoints: historyEvaluationLimit,
    );
    final feedStatuses = [
      environmentFeed,
      styleFeed,
      sectorFeed,
      stockFeed,
      validationFeed,
      historicalFeed,
    ];
    final adapterAvailability = _adapterAvailability(
      feedStatuses.map((feed) => feed.availability),
    );
    final supplementalFeedStatuses = await _loadSupplementalFeedStatuses();
    final primaryDataFeedStatuses = feedStatuses
        .map(
          (feed) => DataFeedStatus(
            name: feed.name,
            availability: feed.availability,
            refreshCadence: feed.refreshCadence,
            detail: feed.detail,
            lastUpdated: feed.asOf,
          ),
        )
        .toList();
    final archiveStatus = DataFeedStatus(
      name: 'Point-in-time archive',
      availability: archiveSummary.hasSnapshots
          ? FeedAvailability.connected
          : FeedAvailability.missing,
      refreshCadence: FeedRefreshCadence.onDemand,
      detail: archiveSummary.hasSnapshots
          ? 'Snapshots from the provider-backed repository are archived locally, and fixture mode primes that archive with research replay history so trends have durable local depth.'
          : 'Archive wiring exists, but no provider-backed snapshots have been stored yet.',
      lastUpdated: archiveSummary.latestSnapshotAsOf,
    );
    final providerCoverageStatus = DataFeedStatus(
      name: 'Provider coverage',
      availability: adapterAvailability,
      refreshCadence: adapterAvailability == FeedAvailability.connected
          ? FeedRefreshCadence.intraday
          : FeedRefreshCadence.planned,
      detail:
          'Overall coverage across the feed rows above. Connected means every required feed is live; Fixture means at least one input is still using fixture or fallback data.',
      lastUpdated: _latestOptionalAsOf(feedStatuses.map((feed) => feed.asOf)),
    );
    final dataFeedStatuses = [
      ...primaryDataFeedStatuses,
      archiveStatus,
      providerCoverageStatus,
      ...supplementalFeedStatuses,
    ];
    final snapshot = const RecommendationTrustGate().apply(
      snapshot: snapshotWithHistory,
      feeds: dataFeedStatuses,
    );
    final hydratedHistoryCount = historicalStates.length;
    final runtimeSummary =
        '$dataSummary The current run scored ${evaluation.scoredStocks.length} stocks and hydrated $hydratedHistoryCount historical market snapshots before archiving the latest state.';

    return IntelligenceAppState(
      snapshot: snapshot,
      dataStatus: DataStatusReport(
        title: dataTitle,
        summary: runtimeSummary,
        lastRefresh: syncTime,
        archiveSummary: archiveSummary.summaryText,
        archiveSnapshotCount: archiveSummary.snapshotCount,
        latestArchive: archiveSummary.latestSnapshotAsOf,
        feeds: dataFeedStatuses,
      ),
      engineStatus: EngineStatusReport(
        title: 'Deterministic committee engine',
        summary: engineSummary,
        isTrained: false,
        validationStage: _validationStageFor(validationFeed),
        validationReport: validation,
        caveats: engineCaveats,
        nextSteps: engineNextSteps,
      ),
    );
  }

  @override
  Future<IntelligenceAppState> refreshState() {
    return loadState();
  }

  int _historyEvaluationLimitFor(int stockCount) {
    if (stockCount >= _largeUniverseStockThreshold) {
      return _largeUniverseHistoryLimit;
    }
    if (stockCount >= _mediumUniverseStockThreshold) {
      return _mediumUniverseHistoryLimit;
    }
    return 240;
  }

  Future<List<DataFeedStatus>> _loadSupplementalFeedStatuses() async {
    final loader = _supplementalFeedStatusesLoader;
    if (loader == null) {
      return const <DataFeedStatus>[];
    }
    try {
      return await loader().timeout(_supplementalFeedStatusTimeout);
    } on TimeoutException {
      return const [
        DataFeedStatus(
          name: 'Supplemental free-source status probes',
          availability: FeedAvailability.missing,
          refreshCadence: FeedRefreshCadence.onDemand,
          detail:
              'Free-source status probes took longer than 12 seconds. The decision layer loaded without waiting and will try those checks again on refresh.',
        ),
      ];
    } catch (_) {
      return const [
        DataFeedStatus(
          name: 'Supplemental free-source status probes',
          availability: FeedAvailability.missing,
          refreshCadence: FeedRefreshCadence.onDemand,
          detail:
              'Free-source status probes failed. The decision layer loaded from the primary market state and available overlays.',
        ),
      ];
    }
  }

  FeedAvailability _adapterAvailability(
    Iterable<FeedAvailability> availabilities,
  ) {
    final values = availabilities.toList();
    if (values.every(
      (availability) => availability == FeedAvailability.connected,
    )) {
      return FeedAvailability.connected;
    }
    if (values.any(
      (availability) => availability == FeedAvailability.fixture,
    )) {
      return FeedAvailability.fixture;
    }
    if (values.any(
      (availability) => availability == FeedAvailability.missing,
    )) {
      return FeedAvailability.missing;
    }
    return FeedAvailability.planned;
  }

  ValidationStage _validationStageFor(FeedSlice<List<ValidationWindow>> feed) {
    return switch (feed.availability) {
      FeedAvailability.connected => ValidationStage.pointInTimeBacktest,
      FeedAvailability.fixture => ValidationStage.fixtureWalkForward,
      FeedAvailability.planned ||
      FeedAvailability.missing => ValidationStage.none,
    };
  }

  DateTime _latestAsOf(List<DateTime> values) {
    return values.reduce((left, right) => left.isAfter(right) ? left : right);
  }

  DateTime? _latestOptionalAsOf(Iterable<DateTime> values) {
    if (values.isEmpty) {
      return null;
    }
    return values.reduce((left, right) => left.isAfter(right) ? left : right);
  }
}
