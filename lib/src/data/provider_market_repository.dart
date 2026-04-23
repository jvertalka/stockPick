import '../engine/market_intelligence_engine.dart';
import '../engine/market_metric_history_builder.dart';
import '../engine/validation_engine.dart';
import '../models/intelligence_app_state.dart';
import 'live_market_feed_provider.dart';
import 'market_data_configuration.dart';
import 'market_feed_provider.dart';
import 'market_intelligence_repository.dart';
import 'market_snapshot_archive.dart';
import 'market_snapshot_archive_factory.dart';
import 'raw_market_data.dart';

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

    final dataTitle = switch (configuration.mode) {
      MarketDataMode.fixtureOnly => 'Provider-backed research repository',
      MarketDataMode.livePreferred => 'Live-preferred market repository',
      MarketDataMode.liveRequired => 'Live-required market repository',
    };

    final dataSummary = switch (configuration.mode) {
      MarketDataMode.fixtureOnly =>
        'The app is running through provider-backed contracts, but explicitly in fixture mode.',
      MarketDataMode.livePreferred =>
        'The app is attempting to use live feed adapters first and falls back to fixtures when a live endpoint is not configured or unavailable.',
      MarketDataMode.liveRequired =>
        'The app is configured to require live feed adapters. If a live endpoint is missing or unhealthy, the repository will fail fast instead of silently using fixtures.',
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
    };

    return ProviderMarketRepository(
      marketEnvironmentProvider: liveProvider,
      styleSignalProvider: liveProvider,
      sectorSignalProvider: liveProvider,
      stockSignalProvider: liveProvider,
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
          'A rules-based ensemble now consumes provider-backed feeds to derive the regime read, stock ranking, sell alerts, and scenarios. Live adapters can now sit in front of the same engine contract.',
      engineCaveats: engineCaveats,
      engineNextSteps: const [
        'Connect real market, fundamental, and options endpoints to the live provider contract.',
        'Promote the local archive into a durable point-in-time history store.',
        'Run leakage-safe backtests and shadow mode on connected feeds before training ML models.',
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
  final ValidationEngine _validationEngine;
  final String dataTitle;
  final String dataSummary;
  final String engineSummary;
  final List<String> engineCaveats;
  final List<String> engineNextSteps;

  @override
  Future<IntelligenceAppState> loadState() async {
    final syncTime = DateTime.now();
    final environmentFeed = await _marketEnvironmentProvider
        .loadMarketEnvironment();
    final styleFeed = await _styleSignalProvider.loadStyleSignals();
    final sectorFeed = await _sectorSignalProvider.loadSectorSignals();
    final stockFeed = await _stockSignalProvider.loadStockSignals();
    final validationFeed = await _validationWindowProvider
        .loadValidationWindows();
    final historicalFeed = await _historicalMarketStateProvider
        .loadHistoricalMarketStates();

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
    final snapshot = withHistoricalInsights(
      snapshot: evaluation.snapshot,
      historicalSnapshots: archivedSnapshots,
      engine: _engine,
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
        feeds: [
          ...feedStatuses.map(
            (feed) => DataFeedStatus(
              name: feed.name,
              availability: feed.availability,
              refreshCadence: feed.refreshCadence,
              detail: feed.detail,
              lastUpdated: feed.asOf,
            ),
          ),
          DataFeedStatus(
            name: 'Point-in-time archive',
            availability: archiveSummary.hasSnapshots
                ? FeedAvailability.connected
                : FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.onDemand,
            detail: archiveSummary.hasSnapshots
                ? 'Snapshots from the provider-backed repository are archived locally, and fixture mode primes that archive with research replay history so trends have durable local depth.'
                : 'Archive wiring exists, but no provider-backed snapshots have been stored yet.',
            lastUpdated: archiveSummary.latestSnapshotAsOf,
          ),
          DataFeedStatus(
            name: 'Live vendor adapters',
            availability: adapterAvailability,
            refreshCadence: adapterAvailability == FeedAvailability.connected
                ? FeedRefreshCadence.intraday
                : FeedRefreshCadence.planned,
            detail:
                'Provider contracts now support both broader stock-universe requests and point-in-time historical feeds, even when the current run falls back to fixtures.',
            lastUpdated: _latestOptionalAsOf(
              feedStatuses.map((feed) => feed.asOf),
            ),
          ),
        ],
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
