import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_data_configuration.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

class LiveMarketFeedProvider
    implements
        MarketEnvironmentProvider,
        StyleSignalProvider,
        SectorSignalProvider,
        StockSignalProvider,
        ValidationWindowProvider,
        HistoricalMarketStateProvider {
  LiveMarketFeedProvider({
    required MarketDataConfiguration configuration,
    required FixtureMarketFeedProvider fallbackProvider,
    http.Client? client,
  }) : _configuration = configuration,
       _fallbackProvider = fallbackProvider,
       _client = client ?? http.Client();

  final MarketDataConfiguration _configuration;
  final FixtureMarketFeedProvider _fallbackProvider;
  final http.Client _client;

  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() {
    return _loadFeed(
      path: '/market/environment',
      feedName: 'Market and breadth',
      refreshCadence: FeedRefreshCadence.intraday,
      parser: (data) =>
          RawMarketEnvironment.fromJson(data as Map<String, dynamic>),
      fallbackLoader: _fallbackProvider.loadMarketEnvironment,
      successDetail:
          'Connected live market environment data is flowing through the provider contract.',
    );
  }

  @override
  Future<FeedSlice<List<RawStyleSignal>>> loadStyleSignals() {
    return _loadFeed(
      path: '/market/styles',
      feedName: 'Style and factor rotation',
      refreshCadence: FeedRefreshCadence.intraday,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawStyleSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
      fallbackLoader: _fallbackProvider.loadStyleSignals,
      successDetail:
          'Connected live style and factor rotation data is available.',
    );
  }

  @override
  Future<FeedSlice<List<RawSectorSignal>>> loadSectorSignals() {
    return _loadFeed(
      path: '/market/sectors',
      feedName: 'Sector sponsorship',
      refreshCadence: FeedRefreshCadence.intraday,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawSectorSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
      fallbackLoader: _fallbackProvider.loadSectorSignals,
      successDetail: 'Connected live sector sponsorship data is available.',
    );
  }

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() {
    return _loadFeed(
      path: '/market/stocks',
      queryParameters: {
        'limit': _configuration.stockUniverseLimit.toString(),
      },
      feedName: 'Stock, revisions, and options signals',
      refreshCadence: FeedRefreshCadence.daily,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawStockSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
      fallbackLoader: _fallbackProvider.loadStockSignals,
      successDetail:
          'Connected live stock, revisions, and options-style data is available.',
    );
  }

  @override
  Future<FeedSlice<List<ValidationWindow>>> loadValidationWindows() {
    return _loadFeed(
      path: '/research/validation-windows',
      feedName: 'Research labels and windows',
      refreshCadence: FeedRefreshCadence.onDemand,
      parser: (data) => (data as List<dynamic>)
          .map(
            (item) => ValidationWindow.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
      fallbackLoader: _fallbackProvider.loadValidationWindows,
      successDetail:
          'Connected live research windows are available for point-in-time validation.',
    );
  }

  @override
  Future<FeedSlice<List<RawMarketState>>> loadHistoricalMarketStates() {
    return _loadFeed(
      path: '/market/history',
      queryParameters: {
        'limit': _configuration.historicalSnapshotLimit.toString(),
      },
      feedName: 'Historical market states',
      refreshCadence: FeedRefreshCadence.daily,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawMarketState.fromJson(item as Map<String, dynamic>))
          .toList(),
      fallbackLoader: _fallbackProvider.loadHistoricalMarketStates,
      successDetail:
          'Connected historical market snapshots are available for point-in-time charting and archive hydration.',
    );
  }

  Future<FeedSlice<T>> _loadFeed<T>({
    required String path,
    required String feedName,
    required FeedRefreshCadence refreshCadence,
    required T Function(Object? data) parser,
    required Future<FeedSlice<T>> Function() fallbackLoader,
    required String successDetail,
    Map<String, String>? queryParameters,
  }) async {
    if (!_configuration.hasBaseUrl) {
      return _resolveFallback(
        fallbackLoader,
        reason:
            'Live base URL is not configured. Set ORACLE_DATA_BASE_URL to enable live adapters.',
      );
    }

    final baseUri = Uri.parse(_configuration.baseUrl!).resolve(path);
    final uri = queryParameters == null || queryParameters.isEmpty
        ? baseUri
        : baseUri.replace(
            queryParameters: {
              ...baseUri.queryParameters,
              ...queryParameters,
            },
          );
    try {
      final response = await _client.get(uri, headers: _headers());
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return _resolveFallback(
          fallbackLoader,
          reason:
              'Live request for $feedName returned HTTP ${response.statusCode}.',
        );
      }

      final decoded = jsonDecode(response.body);
      final envelope =
          decoded is Map<String, dynamic> && decoded.containsKey('data')
          ? decoded
          : <String, dynamic>{'data': decoded};

      return FeedSlice(
        name: feedName,
        source: (envelope['source'] as String?) ?? 'live-api',
        asOf: envelope['asOf'] is String
            ? DateTime.parse(envelope['asOf'] as String)
            : DateTime.now(),
        data: parser(envelope['data']),
        availability: FeedAvailability.connected,
        refreshCadence: refreshCadence,
        detail: (envelope['detail'] as String?) ?? successDetail,
      );
    } catch (error) {
      return _resolveFallback(
        fallbackLoader,
        reason: 'Live request for $feedName failed: $error',
      );
    }
  }

  Future<FeedSlice<T>> _resolveFallback<T>(
    Future<FeedSlice<T>> Function() fallbackLoader, {
    required String reason,
  }) async {
    if (_configuration.mode == MarketDataMode.liveRequired) {
      throw StateError(reason);
    }

    final fallback = await fallbackLoader();
    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source} (fallback)',
      asOf: fallback.asOf,
      data: fallback.data,
      availability: fallback.availability,
      refreshCadence: fallback.refreshCadence,
      detail: '${fallback.detail} Live adapter fallback: $reason',
    );
  }

  Map<String, String> _headers() {
    final token = _configuration.apiToken;
    if (token == null || token.isEmpty) {
      return const {'Accept': 'application/json'};
    }
    return {'Accept': 'application/json', 'Authorization': 'Bearer $token'};
  }
}
