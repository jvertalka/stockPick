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
    expect(
      MarketDataConfiguration.parseMode('alpha-vantage'),
      MarketDataMode.alphaVantage,
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

  test('live provider requests the configured stock-universe limit', () async {
    final client = MockClient((request) async {
      expect(
        request.url.toString(),
        'https://oracle.example/market/stocks?limit=25',
      );
      return http.Response(
        '''
        {
          "asOf": "2026-04-22T10:15:00.000Z",
          "source": "oracle-live",
          "data": [
            {
              "ticker": "NVDA",
              "company": "NVIDIA",
              "sector": "Technology",
              "industry": "Semiconductors",
              "shortTrend": 91,
              "mediumTrend": 89,
              "longTrend": 87,
              "residualStrength": 92,
              "momentumPersistence": 88,
              "breakoutQuality": 84,
              "volumeSupport": 82,
              "earningsRevisions": 87,
              "earningsSurprise": 83,
              "marginTrend": 80,
              "revenueTrend": 89,
              "freeCashFlowTrend": 82,
              "balanceSheetQuality": 84,
              "profitability": 93,
              "leverageQuality": 81,
              "earningsStability": 78,
              "valuationSupport": 60,
              "crowdingRisk": 76,
              "impliedVolRank": 69,
              "realizedImpliedGap": 7,
              "putSkewChange": 62,
              "eventPremium": 58,
              "downsideProtectionDemand": 65,
              "relativeStrengthDelta": 64,
              "sectorBreadthDelta": 62,
              "revisionDelta": 68,
              "priceResponse": 59,
              "abnormalDownVolume": 41,
              "volatilityRepricing": 47,
              "peerLeadership": 77,
              "growthExposure": 92,
              "defensiveExposure": 16,
              "creditSensitivity": 33,
              "rateSensitivity": 70,
              "expectedStability": 72,
              "peers": []
            }
          ]
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
        stockUniverseLimit: 25,
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
    );

    final feed = await provider.loadStockSignals();

    expect(feed.availability, FeedAvailability.connected);
    expect(feed.data, hasLength(1));
    expect(feed.data.first.ticker, 'NVDA');
  });

  test('live provider parses a connected historical market endpoint', () async {
    final client = MockClient((request) async {
      expect(
        request.url.toString(),
        'https://oracle.example/market/history?limit=180',
      );
      return http.Response(
        '''
        {
          "asOf": "2026-04-22T10:15:00.000Z",
          "source": "oracle-history",
          "data": [
            {
              "asOf": "2026-04-21T10:15:00.000Z",
              "environment": {
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
              },
              "styles": [
                {
                  "style": "Large-cap growth",
                  "strength": 80,
                  "note": "Connected style feed."
                }
              ],
              "sectors": [
                {
                  "sector": "Technology",
                  "strength": 88,
                  "breadth": 81,
                  "revisions": 83,
                  "sponsorship": 86,
                  "crowdingRisk": 72,
                  "note": "Connected sector feed."
                }
              ],
              "stocks": [
                {
                  "ticker": "NVDA",
                  "company": "NVIDIA",
                  "sector": "Technology",
                  "industry": "Semiconductors",
                  "shortTrend": 91,
                  "mediumTrend": 89,
                  "longTrend": 87,
                  "residualStrength": 92,
                  "momentumPersistence": 88,
                  "breakoutQuality": 84,
                  "volumeSupport": 82,
                  "earningsRevisions": 87,
                  "earningsSurprise": 83,
                  "marginTrend": 80,
                  "revenueTrend": 89,
                  "freeCashFlowTrend": 82,
                  "balanceSheetQuality": 84,
                  "profitability": 93,
                  "leverageQuality": 81,
                  "earningsStability": 78,
                  "valuationSupport": 60,
                  "crowdingRisk": 76,
                  "impliedVolRank": 69,
                  "realizedImpliedGap": 7,
                  "putSkewChange": 62,
                  "eventPremium": 58,
                  "downsideProtectionDemand": 65,
                  "relativeStrengthDelta": 64,
                  "sectorBreadthDelta": 62,
                  "revisionDelta": 68,
                  "priceResponse": 59,
                  "abnormalDownVolume": 41,
                  "volatilityRepricing": 47,
                  "peerLeadership": 77,
                  "growthExposure": 92,
                  "defensiveExposure": 16,
                  "creditSensitivity": 33,
                  "rateSensitivity": 70,
                  "expectedStability": 72,
                  "peers": []
                }
              ]
            }
          ]
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
        historicalSnapshotLimit: 180,
      ),
      fallbackProvider: FixtureMarketFeedProvider(),
      client: client,
    );

    final feed = await provider.loadHistoricalMarketStates();

    expect(feed.availability, FeedAvailability.connected);
    expect(feed.source, 'oracle-history');
    expect(feed.data, hasLength(1));
    expect(feed.data.first.asOf, DateTime.parse('2026-04-21T10:15:00.000Z'));
  });
}
