import '../engine/market_intelligence_engine.dart';
import '../engine/validation_engine.dart';
import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'market_intelligence_repository.dart';
import 'market_snapshot_archive.dart';
import 'raw_market_data.dart';

class ProviderMarketRepository implements MarketIntelligenceRepository {
  ProviderMarketRepository({
    required MarketEnvironmentProvider marketEnvironmentProvider,
    required StyleSignalProvider styleSignalProvider,
    required SectorSignalProvider sectorSignalProvider,
    required StockSignalProvider stockSignalProvider,
    required ValidationWindowProvider validationWindowProvider,
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
  }) : _marketEnvironmentProvider = marketEnvironmentProvider,
       _styleSignalProvider = styleSignalProvider,
       _sectorSignalProvider = sectorSignalProvider,
       _stockSignalProvider = stockSignalProvider,
       _validationWindowProvider = validationWindowProvider,
       _archive = archive ?? SharedPreferencesMarketSnapshotArchive(),
       _engine = engine ?? MarketIntelligenceEngine(),
       _validationEngine = ValidationEngine(
         engine: engine ?? MarketIntelligenceEngine(),
       );

  factory ProviderMarketRepository.fixtureBacked({
    MarketSnapshotArchive? archive,
    MarketIntelligenceEngine? engine,
  }) {
    final provider = FixtureMarketFeedProvider();
    return ProviderMarketRepository(
      marketEnvironmentProvider: provider,
      styleSignalProvider: provider,
      sectorSignalProvider: provider,
      stockSignalProvider: provider,
      validationWindowProvider: provider,
      archive: archive,
      engine: engine,
    );
  }

  final MarketEnvironmentProvider _marketEnvironmentProvider;
  final StyleSignalProvider _styleSignalProvider;
  final SectorSignalProvider _sectorSignalProvider;
  final StockSignalProvider _stockSignalProvider;
  final ValidationWindowProvider _validationWindowProvider;
  final MarketSnapshotArchive _archive;
  final MarketIntelligenceEngine _engine;
  final ValidationEngine _validationEngine;

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

    final evaluation = _engine.evaluate(currentState);
    final sourceSummary = {
      environmentFeed.source,
      styleFeed.source,
      sectorFeed.source,
      stockFeed.source,
    }.join(', ');
    final archiveSummary = await _archive.saveSnapshot(
      currentState,
      source: sourceSummary,
    );
    final validation = _validationEngine.validate(
      validationFeed.data,
      archivedSnapshotCount: archiveSummary.snapshotCount,
    );
    final feeds = [
      environmentFeed,
      styleFeed,
      sectorFeed,
      stockFeed,
      validationFeed,
    ];

    return IntelligenceAppState(
      snapshot: evaluation.snapshot,
      dataStatus: DataStatusReport(
        title: 'Provider-backed research repository',
        summary:
            'The app now runs through pluggable feed providers for market, style, sector, stock, and research windows. The current adapters are still fixture-backed, but live vendors can now replace them without changing the engine contract.',
        lastRefresh: syncTime,
        archiveSummary: archiveSummary.summaryText,
        archiveSnapshotCount: archiveSummary.snapshotCount,
        latestArchive: archiveSummary.latestSnapshotAsOf,
        feeds: [
          ...feeds.map(
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
                ? 'Snapshots from the provider-backed repository are being archived locally for future replay.'
                : 'Archive wiring exists, but no provider-backed snapshots have been stored yet.',
            lastUpdated: archiveSummary.latestSnapshotAsOf,
          ),
          DataFeedStatus(
            name: 'Live vendor adapters',
            availability: _adapterAvailability(feeds),
            refreshCadence:
                _adapterAvailability(feeds) == FeedAvailability.connected
                ? FeedRefreshCadence.intraday
                : FeedRefreshCadence.planned,
            detail:
                'Provider contracts are ready for live vendors, but the current adapters are still fixture-backed.',
            lastUpdated: _latestOptionalAsOf(feeds.map((feed) => feed.asOf)),
          ),
        ],
      ),
      engineStatus: EngineStatusReport(
        title: 'Deterministic committee engine',
        summary:
            'A rules-based ensemble now consumes provider-backed feeds to derive the regime read, stock ranking, sell alerts, and scenarios. The feed architecture is ready for live vendors, but the engine itself is still not trained.',
        isTrained: false,
        validationStage: _validationStageFor(validationFeed),
        validationReport: validation,
        caveats: const [
          'This is still not a trained model stack.',
          'The provider layer is live-ready, but the current adapters still point at fixture data.',
          'Validation remains vendor-free until real point-in-time feeds are connected.',
          'Probabilities in the UI are still implied by rules, not calibrated forecasts.',
        ],
        nextSteps: const [
          'Implement connected providers for market, fundamentals, and options data.',
          'Promote the local archive into a durable point-in-time history store.',
          'Run leakage-safe backtests and shadow mode on connected feeds before training ML models.',
        ],
      ),
    );
  }

  @override
  Future<IntelligenceAppState> refreshState() {
    return loadState();
  }

  FeedAvailability _adapterAvailability(List<FeedSlice<Object>> feeds) {
    if (feeds.every(
      (feed) => feed.availability == FeedAvailability.connected,
    )) {
      return FeedAvailability.connected;
    }
    if (feeds.any((feed) => feed.availability == FeedAvailability.fixture)) {
      return FeedAvailability.fixture;
    }
    if (feeds.any((feed) => feed.availability == FeedAvailability.missing)) {
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
