import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

class TreasuryFiscalFeedProvider implements MarketEnvironmentProvider {
  TreasuryFiscalFeedProvider({
    required MarketEnvironmentProvider fallbackProvider,
    http.Client? client,
  }) : _fallbackProvider = fallbackProvider,
       _client = client ?? http.Client();

  final MarketEnvironmentProvider _fallbackProvider;
  final http.Client _client;

  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() async {
    final fallback = await _fallbackProvider.loadMarketEnvironment();
    final rates = await loadAverageInterestRates();
    if (rates == null || !rates.hasUsableRates) {
      return fallback;
    }

    final base = fallback.data;
    final ratePressure = _ratePressureScore(rates);
    final billRate = rates.rateFor('Treasury Bills');
    final noteRate = rates.rateFor('Treasury Notes');
    final slopeProxy = billRate == null || noteRate == null
        ? base.yieldCurveSlope
        : noteRate - billRate;
    final tightenedConditions =
        (base.financialConditions - (ratePressure - 50).clamp(0, 50) * 0.18)
            .clamp(0, 100)
            .toDouble();
    final inflationPressure =
        (base.inflationPressure + (rates.averageRate - 3.5).clamp(0, 5) * 4)
            .clamp(0, 100)
            .toDouble();

    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source}+treasury-fiscal',
      asOf: rates.asOf,
      data: RawMarketEnvironment(
        indexTrend: base.indexTrend,
        realizedVolatility: base.realizedVolatility,
        impliedVolatility: base.impliedVolatility,
        creditStress: base.creditStress,
        financialConditions: tightenedConditions,
        growthLeadership: base.growthLeadership,
        defensiveLeadership: base.defensiveLeadership,
        smallCapLeadership: base.smallCapLeadership,
        inflationPressure: inflationPressure,
        breadth: base.breadth,
        advanceDecline: base.advanceDecline,
        newHighLow: base.newHighLow,
        percentAboveMajorAverages: base.percentAboveMajorAverages,
        equalWeightConfirmation: base.equalWeightConfirmation,
        sectorParticipation: base.sectorParticipation,
        correlation: base.correlation,
        dispersion: base.dispersion,
        volumeConcentration: base.volumeConcentration,
        regimeStability: base.regimeStability,
        regimePersistenceSessions: base.regimePersistenceSessions,
        volTermStructure: base.volTermStructure,
        yieldCurveSlope: slopeProxy,
        breadthByPhase: base.breadthByPhase,
      ),
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          '${fallback.detail} U.S. Treasury Fiscal Data confirmed average marketable debt rate pressure at ${rates.averageRate.toStringAsFixed(2)}%.',
    );
  }

  Future<TreasuryAverageRates?> loadAverageInterestRates() async {
    final uri = Uri.https(
      'api.fiscaldata.treasury.gov',
      '/services/api/fiscal_service/v2/accounting/od/avg_interest_rates',
      {
        'fields': 'record_date,security_desc,avg_interest_rate_amt',
        'sort': '-record_date',
        'page[size]': '100',
        'format': 'json',
      },
    );

    try {
      final response = await _client
          .get(uri, headers: const {'Accept': 'application/json'})
          .timeout(const Duration(seconds: 10));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic>) {
        return null;
      }
      final rows = decoded['data'];
      if (rows is! List<dynamic>) {
        return null;
      }

      DateTime? latestDate;
      final rates = <String, double>{};
      for (final row in rows.whereType<Map<String, dynamic>>()) {
        final recordDate = DateTime.tryParse(
          row['record_date'] as String? ?? '',
        );
        if (recordDate == null) {
          continue;
        }
        latestDate ??= recordDate;
        if (recordDate != latestDate) {
          continue;
        }
        final desc = row['security_desc'] as String? ?? '';
        final rate = _asDouble(row['avg_interest_rate_amt']);
        if (desc.isEmpty || rate == null) {
          continue;
        }
        rates[desc] = rate;
      }
      if (latestDate == null || rates.isEmpty) {
        return null;
      }
      return TreasuryAverageRates(asOf: latestDate, ratesBySecurity: rates);
    } catch (_) {
      return null;
    }
  }

  Future<DataFeedStatus> status() async {
    final rates = await loadAverageInterestRates();
    if (rates == null || !rates.hasUsableRates) {
      return const DataFeedStatus(
        name: 'U.S. Treasury Fiscal Data',
        availability: FeedAvailability.missing,
        refreshCadence: FeedRefreshCadence.daily,
        detail:
            'Treasury Fiscal Data did not respond. The app will rely on FRED and price-derived rate proxies.',
      );
    }
    return DataFeedStatus(
      name: 'U.S. Treasury Fiscal Data',
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'Treasury average interest-rate data is connected. Latest average marketable debt rate is ${rates.averageRate.toStringAsFixed(2)}%.',
      lastUpdated: rates.asOf,
    );
  }

  double _ratePressureScore(TreasuryAverageRates rates) {
    return (35 + rates.averageRate * 9).clamp(0, 100).toDouble();
  }
}

class TreasuryAverageRates {
  const TreasuryAverageRates({
    required this.asOf,
    required this.ratesBySecurity,
  });

  final DateTime asOf;
  final Map<String, double> ratesBySecurity;

  bool get hasUsableRates => ratesBySecurity.length >= 2;

  double get averageRate {
    if (ratesBySecurity.isEmpty) {
      return 0;
    }
    return ratesBySecurity.values.reduce((a, b) => a + b) /
        ratesBySecurity.length;
  }

  double? rateFor(String label) {
    for (final entry in ratesBySecurity.entries) {
      if (entry.key.toLowerCase().contains(label.toLowerCase())) {
        return entry.value;
      }
    }
    return null;
  }
}

double? _asDouble(dynamic value) {
  if (value is num) {
    return value.toDouble();
  }
  if (value is String) {
    return double.tryParse(value);
  }
  return null;
}
