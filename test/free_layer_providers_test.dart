import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:finance_app/src/data/gdelt_event_feed_provider.dart';
import 'package:finance_app/src/data/market_feed_provider.dart';
import 'package:finance_app/src/data/raw_market_data.dart';
import 'package:finance_app/src/data/sec_edgar_feed_provider.dart';
import 'package:finance_app/src/data/treasury_fiscal_feed_provider.dart';
import 'package:finance_app/src/models/intelligence_app_state.dart';

void main() {
  test('SEC EDGAR provider derives fundamentals and filing risk', () async {
    final client = MockClient((request) async {
      final url = request.url.toString();
      if (url.contains('company_tickers.json')) {
        return http.Response(
          '{"0":{"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."}}',
          200,
        );
      }
      if (url.contains('companyfacts')) {
        return http.Response(_secFactsJson, 200);
      }
      if (url.contains('submissions')) {
        return http.Response(_secSubmissionsJson, 200);
      }
      return http.Response('{}', 404);
    });

    final provider = SecEdgarFeedProvider(
      symbols: const ['AAPL'],
      client: client,
    );
    final evidence = await provider.loadCompanyEvidence('AAPL');

    expect(evidence, isNotNull);
    expect(evidence!.symbol, 'AAPL');
    expect(evidence.revenueTrendScore, greaterThan(50));
    expect(evidence.marginTrendScore, greaterThan(50));
    expect(evidence.freeCashFlowTrendScore, greaterThan(50));
    expect(evidence.recent8KCount, greaterThanOrEqualTo(1));
  });

  test('GDELT provider converts articles into event-risk pressure', () async {
    final client = MockClient((request) async {
      return http.Response(_gdeltJson, 200);
    });
    final provider = GdeltEventFeedProvider(
      symbols: const ['AAPL'],
      client: client,
    );

    final signal = await provider.loadEventSignal(
      symbol: 'AAPL',
      companyName: 'Apple Inc.',
    );

    expect(signal, isNotNull);
    expect(signal!.articleCount, 2);
    expect(signal.negativeArticleCount, 1);
    expect(signal.eventRiskScore, greaterThan(50));
  });

  test('Treasury provider parses average rate pressure', () async {
    final client = MockClient((request) async {
      return http.Response(_treasuryJson, 200);
    });
    final provider = TreasuryFiscalFeedProvider(
      fallbackProvider: _FakeMarketEnvironmentProvider(),
      client: client,
    );

    final rates = await provider.loadAverageInterestRates();

    expect(rates, isNotNull);
    expect(rates!.hasUsableRates, isTrue);
    expect(rates.averageRate, closeTo(4.25, 0.1));
    expect(rates.rateFor('Treasury Bills'), 5.0);
  });
}

const _secFactsJson = '''
{
  "facts": {
    "us-gaap": {
      "Revenues": {
        "units": {
          "USD": [
            {"val": 100000000, "end": "2024-12-31", "filed": "2025-02-01", "form": "10-K"},
            {"val": 120000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "NetIncomeLoss": {
        "units": {
          "USD": [
            {"val": 12000000, "end": "2024-12-31", "filed": "2025-02-01", "form": "10-K"},
            {"val": 24000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "NetCashProvidedByUsedInOperatingActivities": {
        "units": {
          "USD": [
            {"val": 28000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "PaymentsToAcquirePropertyPlantAndEquipment": {
        "units": {
          "USD": [
            {"val": 6000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "Assets": {
        "units": {
          "USD": [
            {"val": 300000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "Liabilities": {
        "units": {
          "USD": [
            {"val": 120000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      },
      "LongTermDebtNoncurrent": {
        "units": {
          "USD": [
            {"val": 30000000, "end": "2025-12-31", "filed": "2026-02-01", "form": "10-K"}
          ]
        }
      }
    }
  }
}
''';

const _secSubmissionsJson = '''
{
  "filings": {
    "recent": {
      "form": ["8-K", "10-K", "4"],
      "filingDate": ["2026-04-20", "2026-02-01", "2026-04-18"],
      "accessionNumber": ["0001", "0002", "0003"]
    }
  }
}
''';

const _gdeltJson = '''
{
  "articles": [
    {"title": "Apple faces lawsuit pressure after guidance warning", "seendate": "20260424120000", "tone": -4.2},
    {"title": "Apple supplier demand improves", "seendate": "20260423120000", "tone": 1.2}
  ]
}
''';

const _treasuryJson = '''
{
  "data": [
    {"record_date": "2026-03-31", "security_desc": "Treasury Bills", "avg_interest_rate_amt": "5.0"},
    {"record_date": "2026-03-31", "security_desc": "Treasury Notes", "avg_interest_rate_amt": "4.0"},
    {"record_date": "2026-03-31", "security_desc": "Treasury Bonds", "avg_interest_rate_amt": "3.75"},
    {"record_date": "2026-02-28", "security_desc": "Treasury Bills", "avg_interest_rate_amt": "4.8"}
  ]
}
''';

class _FakeMarketEnvironmentProvider implements MarketEnvironmentProvider {
  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() async {
    return FeedSlice(
      name: 'Market and breadth',
      source: 'test',
      asOf: DateTime(2026, 3, 31),
      data: const RawMarketEnvironment(
        indexTrend: 55,
        realizedVolatility: 45,
        impliedVolatility: 45,
        creditStress: 35,
        financialConditions: 65,
        growthLeadership: 60,
        defensiveLeadership: 45,
        smallCapLeadership: 50,
        inflationPressure: 45,
        breadth: 60,
        advanceDecline: 60,
        newHighLow: 55,
        percentAboveMajorAverages: 58,
        equalWeightConfirmation: 57,
        sectorParticipation: 60,
        correlation: 45,
        dispersion: 55,
        volumeConcentration: 45,
      ),
      availability: FeedAvailability.fixture,
      refreshCadence: FeedRefreshCadence.daily,
      detail: 'Fixture fallback.',
    );
  }
}
