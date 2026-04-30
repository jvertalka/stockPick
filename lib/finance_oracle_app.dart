import 'dart:async';

import 'package:flutter/material.dart';

import 'src/data/market_data_configuration.dart';
import 'src/data/market_intelligence_repository.dart';
import 'src/data/provider_market_repository.dart';
import 'src/models/intelligence_app_state.dart';
import 'src/presentation/home_shell.dart';
import 'src/theme/app_theme.dart';

class FinanceOracleApp extends StatefulWidget {
  const FinanceOracleApp({super.key, MarketIntelligenceRepository? repository})
    : _repository = repository ?? const _DefaultRepository();

  final MarketIntelligenceRepository _repository;

  @override
  State<FinanceOracleApp> createState() => _FinanceOracleAppState();
}

class _FinanceOracleAppState extends State<FinanceOracleApp> {
  late Future<IntelligenceAppState> _stateFuture;
  bool _isRefreshing = false;
  Timer? _syncTimer;
  IntelligenceAppState? _lastGoodState;

  /// How often the app silently refreshes in the background. 20 minutes is
  /// compatible with Alpha Vantage's free 25/day quota while still feeling
  /// fresh during the trading session.
  static const Duration _autoSyncInterval = Duration(minutes: 20);
  static const Duration _interactiveLoadTimeout = Duration(seconds: 35);

  @override
  void initState() {
    super.initState();
    _stateFuture = _loadRepositoryState();
    _startAutoSync();
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    super.dispose();
  }

  void _startAutoSync() {
    _syncTimer?.cancel();
    _syncTimer = Timer.periodic(_autoSyncInterval, (_) {
      // Silently refresh in the background; failures are handled by the
      // FutureBuilder on next successful render.
      _refreshState(silent: true);
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Finance Oracle',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.build(),
      home: FutureBuilder<IntelligenceAppState>(
        future: _stateFuture,
        builder: (context, snapshot) {
          if (snapshot.hasError && !snapshot.hasData) {
            return _StatusScaffold(
              title: 'Unable to load the intelligence layer',
              body:
                  'The app shell is available, but the repository failed to build the current market state. ${snapshot.error}',
            );
          }

          if (!snapshot.hasData) {
            return const _StatusScaffold(
              title: 'Building the market state',
              body:
                  'Loading the repository, evaluating the rules engine, and assembling the current dashboard.',
              loading: true,
            );
          }

          _lastGoodState = snapshot.data!;
          return HomeShell(
            state: snapshot.data!,
            isRefreshing: _isRefreshing,
            onRefresh: _refreshState,
          );
        },
      ),
    );
  }

  Future<void> _refreshState({bool silent = false}) async {
    if (_isRefreshing) {
      return;
    }

    setState(() {
      _isRefreshing = true;
    });
    final future = _loadRepositoryState(refresh: true);
    if (!silent) {
      setState(() {
        _stateFuture = future;
      });
    }

    try {
      final result = await future;
      if (mounted && silent) {
        setState(() {
          _stateFuture = Future.value(result);
        });
      }
    } catch (_) {
      // Silent sync failures are ignored; the last good state stays visible.
    } finally {
      if (mounted) {
        setState(() {
          _isRefreshing = false;
        });
      }
    }
  }

  Future<IntelligenceAppState> _loadRepositoryState({
    bool refresh = false,
  }) async {
    try {
      final state = await Future<IntelligenceAppState>(
        () => refresh
            ? widget._repository.refreshState()
            : widget._repository.loadState(),
      ).timeout(_interactiveLoadTimeout);
      _lastGoodState = state;
      return state;
    } on TimeoutException {
      final lastGood = _lastGoodState;
      if (lastGood != null) {
        return lastGood;
      }
      return _buildFastStartFallback();
    }
  }

  Future<IntelligenceAppState> _buildFastStartFallback() async {
    final fallback = await ProviderMarketRepository.fixtureBacked(
      stockUniverseLimit: 80,
      historicalSnapshotLimit: 240,
    ).loadState();
    return IntelligenceAppState(
      snapshot: fallback.snapshot,
      dataStatus: DataStatusReport(
        title: 'Fast-start fallback',
        summary:
            'The live/free-source data layer took longer than ${_interactiveLoadTimeout.inSeconds} seconds, so the app opened with the local rules-engine fallback. Press Refresh to retry live Alpha Vantage, Treasury, SEC EDGAR, and GDELT inputs.',
        lastRefresh: DateTime.now(),
        archiveSummary: fallback.dataStatus.archiveSummary,
        archiveSnapshotCount: fallback.dataStatus.archiveSnapshotCount,
        latestArchive: fallback.dataStatus.latestArchive,
        feeds: [
          const DataFeedStatus(
            name: 'Live/free-source startup',
            availability: FeedAvailability.missing,
            refreshCadence: FeedRefreshCadence.onDemand,
            detail:
                'Initial live data load timed out before the first dashboard render. The app stayed usable and will retry on refresh.',
          ),
          ...fallback.dataStatus.feeds,
        ],
      ),
      engineStatus: fallback.engineStatus,
    );
  }
}

class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({
    required this.title,
    required this.body,
    this.loading = false,
  });

  final String title;
  final String body;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (loading) ...[
                    const CircularProgressIndicator(),
                    const SizedBox(height: 20),
                  ],
                  Text(
                    title,
                    style: Theme.of(context).textTheme.headlineMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    body,
                    style: Theme.of(context).textTheme.bodyLarge,
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DefaultRepository implements MarketIntelligenceRepository {
  const _DefaultRepository();

  @override
  Future<IntelligenceAppState> loadState() {
    final configuration = MarketDataConfiguration.fromEnvironment();
    final repository = switch (configuration.mode) {
      MarketDataMode.fixtureOnly => ProviderMarketRepository.fixtureBacked(
        stockUniverseLimit: configuration.stockUniverseLimit,
        historicalSnapshotLimit: configuration.historicalSnapshotLimit,
      ),
      MarketDataMode.alphaVantage =>
        ProviderMarketRepository.alphaVantageConfigured(
          configuration: configuration,
        ),
      MarketDataMode.livePreferred || MarketDataMode.liveRequired =>
        ProviderMarketRepository.liveConfigured(configuration: configuration),
    };
    return repository.loadState();
  }

  @override
  Future<IntelligenceAppState> refreshState() {
    return loadState();
  }
}
