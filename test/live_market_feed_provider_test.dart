import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:finance_app/src/data/live_market_feed_provider.dart';
import 'package:finance_app/src/data/market_data_configuration.dart';
import 'package:finance_app/src/data/market_feed_provider.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  test('configuration parses mode aliases', () {
    expect(
      MarketDataConfiguration.parseMode('fixture'),
      MarketDataMode.fixtureOnly,
    );
    expect(
      MarketDataConfiguration.parseMode('live-preferred'),
      MarketDataMode.livePreferred,
    );
    expect(
      MarketDataConfiguration.parseMode('live_required'),
      MarketDataMode.liveRequired,
    );
  });

  test(
    'live preferred provider falls back to fixture data when base url is missing',
    () async {
      final provider = LiveMarketFeedProvider(
        configuration: const MarketDataConfiguration(
          mode: MarketDataMode.livePreferred,
        ),
        fallbackProvider: FixtureMarketFeedProvider(),
      );

      final feed = await provider.loadMarketEnvironment();

      expect(feed.availability, FeedAvailability.fixture);
      expect(feed.source, contains('fallback'));
      expect(feed.detail, contains('Live adapter fallback'));
    },
  );

  test('live required provider throws when base url is missing', () async {
    final provider = LiveMarketFeedProvider(
      configuration: const MarketDataConfiguration(
        mode: MarketDataMode.liveRequired,
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
    );

    expect(provider.loadMarketEnvironment(), throwsStateError);
  });

  test('live provider parses a connected environment endpoint', () async {
    final client = MockClient((request) async {
      expect(
        request.url.toString(),
        'https://oracle.example/market/environment',
      );
      return http.Response(
        '''
        {
          "asOf": "2026-04-22T10:15:00.000Z",
          "source": "oracle-live",
          "detail": "Connected market environment feed.",
          "data": {
            "indexTrend": 81,
            "realizedVolatility": 54,
            "impliedVolatility": 52,
            "creditStress": 28,
            "financialConditions": 73,
            "growthLeadership": 77,
            "defensiveLeadership": 34,
            "smallCapLeadership": 49,
            "inflationPressure": 37,
            "breadth": 72,
            "advanceDecline": 70,
            "newHighLow": 67,
            "percentAboveMajorAverages": 75,
            "equalWeightConfirmation": 61,
            "sectorParticipation": 71,
            "correlation": 43,
            "dispersion": 58,
            "volumeConcentration": 60
          }
        }
        ''',
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final provider = LiveMarketFeedProvider(
      configuration: const MarketDataConfiguration(
        mode: MarketDataMode.livePreferred,
        baseUrl: 'https://oracle.example',
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
    );

    final feed = await provider.loadMarketEnvironment();

    expect(feed.availability, FeedAvailability.connected);
    expect(feed.source, 'oracle-live');
    expect(feed.data.indexTrend, 81);
  });
}
