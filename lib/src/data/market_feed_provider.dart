import '../models/intelligence_app_state.dart';
import 'fixture_market_repository.dart';
import 'raw_market_data.dart';

class FeedSlice<T> {
  const FeedSlice({
    required this.name,
    required this.source,
    required this.asOf,
    required this.data,
    required this.availability,
    required this.refreshCadence,
    required this.detail,
  });

  final String name;
  final String source;
  final DateTime asOf;
  final T data;
  final FeedAvailability availability;
  final FeedRefreshCadence refreshCadence;
  final String detail;
}

abstract class MarketEnvironmentProvider {
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment();
}

abstract class StyleSignalProvider {
  Future<FeedSlice<List<RawStyleSignal>>> loadStyleSignals();
}

abstract class SectorSignalProvider {
  Future<FeedSlice<List<RawSectorSignal>>> loadSectorSignals();
}

abstract class StockSignalProvider {
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals();
}

abstract class ValidationWindowProvider {
  Future<FeedSlice<List<ValidationWindow>>> loadValidationWindows();
}

abstract class HistoricalMarketStateProvider {
  Future<FeedSlice<List<RawMarketState>>> loadHistoricalMarketStates();
}

class FixtureMarketFeedProvider
    implements
        MarketEnvironmentProvider,
        StyleSignalProvider,
        SectorSignalProvider,
        StockSignalProvider,
        ValidationWindowProvider,
        HistoricalMarketStateProvider {
  FixtureMarketFeedProvider({
    FixtureMarketRepository? repository,
    int stockUniverseLimit = 40,
    int historicalSnapshotLimit = 240,
  }) : _repository =
           repository ??
           FixtureMarketRepository(
             stockUniverseLimit: stockUniverseLimit,
             historicalSnapshotLimit: historicalSnapshotLimit,
           );

  final FixtureMarketRepository _repository;

  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() async {
    final state = _repository.currentMarketState();
    return FeedSlice(
      name: 'Market and breadth',
      source: 'fixture-market-feed',
      asOf: state.asOf,
      data: state.environment,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.intraday,
      detail:
          'Regime, breadth, volatility, and macro-condition inputs are coming through a fixture-backed provider.',
    );
  }

  @override
  Future<FeedSlice<List<RawStyleSignal>>> loadStyleSignals() async {
    final state = _repository.currentMarketState();
    return FeedSlice(
      name: 'Style and factor rotation',
      source: 'fixture-style-feed',
      asOf: state.asOf,
      data: state.styles,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.intraday,
      detail:
          'Style leadership and factor-rotation inputs are fixture-backed, but now arrive through a provider contract.',
    );
  }

  @override
  Future<FeedSlice<List<RawSectorSignal>>> loadSectorSignals() async {
    final state = _repository.currentMarketState();
    return FeedSlice(
      name: 'Sector sponsorship',
      source: 'fixture-sector-feed',
      asOf: state.asOf,
      data: state.sectors,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.intraday,
      detail:
          'Sector strength, breadth, revisions, and crowding data are fixture-backed today.',
    );
  }

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() async {
    final state = _repository.currentMarketState();
    return FeedSlice(
      name: 'Stock, revisions, and options signals',
      source: 'fixture-stock-feed',
      asOf: state.asOf,
      data: state.stocks,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Single-name trend, revisions, quality, valuation, peer, and options-style inputs are still fixture-backed.',
    );
  }

  @override
  Future<FeedSlice<List<ValidationWindow>>> loadValidationWindows() async {
    final windows = _repository.validationWindows();
    final asOf = windows.isEmpty
        ? _repository.currentMarketState().asOf
        : windows.last.asOf;
    return FeedSlice(
      name: 'Research labels and windows',
      source: 'fixture-validation-feed',
      asOf: asOf,
      data: windows,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.onDemand,
      detail:
          'Train-style and holdout-style validation windows still come from fixture research data, and fixture mode uses them to prime the local research replay archive.',
    );
  }

  @override
  Future<FeedSlice<List<RawMarketState>>> loadHistoricalMarketStates() async {
    final history = _repository.historicalReplayStates();
    final asOf = history.isEmpty
        ? _repository.currentMarketState().asOf
        : history.last.asOf;
    return FeedSlice(
      name: 'Historical market states',
      source: 'fixture-history-replay',
      asOf: asOf,
      data: history,
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Fixture mode exposes a broader historical replay timeline that can backfill the local archive until real connected history is available.',
    );
  }
}
