import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/alpha_vantage_market_feed_provider.dart';
import 'package:finance_app/src/data/market_data_configuration.dart';
import 'package:finance_app/src/data/market_feed_provider.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'Alpha Vantage daily prices build connected stocks and history',
    () async {
      final requests = <Uri>[];
      final client = MockClient((request) async {
        requests.add(request.url);
        expect(request.url.queryParameters['function'], 'TIME_SERIES_DAILY');
        expect(request.url.queryParameters['outputsize'], 'compact');
        expect(request.url.queryParameters['apikey'], 'demo-key');

        final symbol = request.url.queryParameters['symbol'];
        return http.Response(
          _dailySeriesJson(
            symbol: symbol!,
            startClose: symbol == 'SPY' ? 400 : 100,
            dailyStep: symbol == 'SPY' ? 0.35 : 1.15,
          ),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final provider = AlphaVantageMarketFeedProvider(
        configuration: const MarketDataConfiguration(
          mode: MarketDataMode.alphaVantage,
          alphaVantageApiKey: 'demo-key',
          alphaVantageSymbols: ['NVDA'],
          alphaVantageBenchmarkSymbol: 'SPY',
          stockUniverseLimit: 1,
          historicalSnapshotLimit: 65,
        ),
        fallbackProvider: FixtureMarketFeedProvider(
          stockUniverseLimit: 10,
          historicalSnapshotLimit: 65,
        ),
        client: client,
        cacheStore: AlphaVantagePriceCacheStore(
          priceCacheKey: 'test_alpha_vantage_price_cache',
          quotaCacheKey: 'test_alpha_vantage_quota',
        ),
      );

      final stockFeed = await provider.loadStockSignals();
      final historyFeed = await provider.loadHistoricalMarketStates();
      final supplementalFeeds = await provider.loadSupplementalFeedStatuses();

      expect(stockFeed.availability, FeedAvailability.connected);
      expect(stockFeed.source, 'alpha-vantage-daily-prices');
      expect(stockFeed.data, hasLength(1));
      expect(stockFeed.data.single.ticker, 'NVDA');
      expect(stockFeed.data.single.shortTrend, greaterThan(50));
      expect(stockFeed.data.single.residualStrength, greaterThan(50));
      expect(historyFeed.availability, FeedAvailability.connected);
      expect(historyFeed.source, 'alpha-vantage-price-history');
      expect(historyFeed.data, hasLength(65));
      expect(
        supplementalFeeds.any(
          (feed) =>
              feed.name == 'Alpha Vantage local store' &&
              feed.availability == FeedAvailability.connected,
        ),
        isTrue,
      );
      expect(requests.map((uri) => uri.queryParameters['symbol']), [
        'SPY',
        'NVDA',
      ]);
    },
  );

  test(
    'Alpha Vantage mode keeps fixture fallback when API key is missing',
    () async {
      final client = MockClient((_) async {
        fail('Provider should not request Alpha Vantage without an API key.');
      });

      final provider = AlphaVantageMarketFeedProvider(
        configuration: const MarketDataConfiguration(
          mode: MarketDataMode.alphaVantage,
          alphaVantageSymbols: ['NVDA'],
        ),
        fallbackProvider: FixtureMarketFeedProvider(),
        client: client,
        cacheStore: AlphaVantagePriceCacheStore(
          priceCacheKey: 'test_missing_key_price_cache',
          quotaCacheKey: 'test_missing_key_quota',
        ),
      );

      final feed = await provider.loadStockSignals();

      expect(feed.availability, FeedAvailability.fixture);
      expect(feed.source, contains('alpha-vantage fallback'));
      expect(feed.data, isNotEmpty);
    },
  );

  test('Alpha Vantage mode can route requests through a local proxy', () async {
    final requests = <Uri>[];
    final client = MockClient((request) async {
      requests.add(request.url);
      return http.Response(
        _dailySeriesJson(
          symbol: request.url.queryParameters['symbol']!,
          startClose: 120,
          dailyStep: 0.8,
        ),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final provider = AlphaVantageMarketFeedProvider(
      configuration: const MarketDataConfiguration(
        mode: MarketDataMode.alphaVantage,
        alphaVantageApiKey: 'demo-key',
        alphaVantageProxyUrl: 'http://127.0.0.1:8081/query',
        alphaVantageSymbols: ['NVDA'],
        alphaVantageBenchmarkSymbol: 'SPY',
        stockUniverseLimit: 1,
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
      cacheStore: AlphaVantagePriceCacheStore(
        priceCacheKey: 'test_proxy_price_cache',
        quotaCacheKey: 'test_proxy_quota',
      ),
    );

    await provider.loadStockSignals();

    expect(requests, isNotEmpty);
    expect(
      requests.first.toString(),
      startsWith('http://127.0.0.1:8081/query?'),
    );
    expect(requests.first.queryParameters['function'], 'TIME_SERIES_DAILY');
    expect(requests.first.queryParameters['apikey'], 'demo-key');
  });

  test('Alpha Vantage keeps core ETFs inside capped active scans', () async {
    final requests = <Uri>[];
    final client = MockClient((request) async {
      requests.add(request.url);
      return http.Response(
        _dailySeriesJson(
          symbol: request.url.queryParameters['symbol']!,
          startClose: 100,
          dailyStep: 0.7,
        ),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final provider = AlphaVantageMarketFeedProvider(
      configuration: const MarketDataConfiguration(
        mode: MarketDataMode.alphaVantage,
        alphaVantageApiKey: 'demo-key',
        alphaVantageSymbols: ['AAPL', 'MSFT', 'QQQ', 'XLK'],
        alphaVantageBenchmarkSymbol: 'SPY',
        stockUniverseLimit: 2,
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
      cacheStore: AlphaVantagePriceCacheStore(
        priceCacheKey: 'test_core_etf_priority_price_cache',
        quotaCacheKey: 'test_core_etf_priority_quota',
      ),
    );

    final feed = await provider.loadStockSignals();

    expect(feed.data.map((stock) => stock.ticker), ['QQQ', 'XLK']);
    expect(requests.map((uri) => uri.queryParameters['symbol']), [
      'SPY',
      'QQQ',
      'XLK',
    ]);
  });

  test('Alpha Vantage sync cooldown avoids repeated quota burns', () async {
    var requestCount = 0;
    final client = MockClient((request) async {
      requestCount++;
      return http.Response(
        _dailySeriesJson(
          symbol: request.url.queryParameters['symbol']!,
          startClose: 100,
          dailyStep: 1,
        ),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final cacheStore = AlphaVantagePriceCacheStore(
      priceCacheKey: 'test_sync_cooldown_store',
    );
    final configuration = const MarketDataConfiguration(
      mode: MarketDataMode.alphaVantage,
      alphaVantageApiKey: 'demo-key',
      alphaVantageSymbols: ['NVDA'],
      alphaVantageBenchmarkSymbol: 'SPY',
      alphaVantageDailyRequestLimit: 1,
      alphaVantageSyncIntervalMinutes: 60,
      stockUniverseLimit: 1,
    );

    final firstProvider = AlphaVantageMarketFeedProvider(
      configuration: configuration,
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
      cacheStore: cacheStore,
    );
    await firstProvider.loadStockSignals();

    final secondProvider = AlphaVantageMarketFeedProvider(
      configuration: configuration,
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
      cacheStore: cacheStore,
    );
    await secondProvider.loadStockSignals();

    expect(requestCount, 1);
  });
}

String _dailySeriesJson({
  required String symbol,
  required double startClose,
  required double dailyStep,
}) {
  final series = <String, Map<String, String>>{};
  for (var index = 0; index < 75; index++) {
    final date = DateTime.utc(2026, 1, 1).add(Duration(days: index));
    final close = startClose + dailyStep * index;
    series[_dateKey(date)] = {
      '1. open': (close - 0.4).toStringAsFixed(2),
      '2. high': (close + 0.8).toStringAsFixed(2),
      '3. low': (close - 1.2).toStringAsFixed(2),
      '4. close': close.toStringAsFixed(2),
      '5. volume': (1000000 + index * 10000).toString(),
    };
  }

  return jsonEncode({
    'Meta Data': {'2. Symbol': symbol},
    'Time Series (Daily)': series,
  });
}

String _dateKey(DateTime date) {
  return [
    date.year.toString().padLeft(4, '0'),
    date.month.toString().padLeft(2, '0'),
    date.day.toString().padLeft(2, '0'),
  ].join('-');
}
