import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

class FredMacroFeedProvider implements MarketEnvironmentProvider {
  FredMacroFeedProvider({
    required this.apiKey,
    required MarketEnvironmentProvider fallbackProvider,
    http.Client? client,
  }) : _fallbackProvider = fallbackProvider,
       _client = client ?? http.Client();

  final String? apiKey;
  final MarketEnvironmentProvider _fallbackProvider;
  final http.Client _client;

  bool get isConfigured => apiKey != null && apiKey!.trim().isNotEmpty;

  @override
  Future<FeedSlice<RawMarketEnvironment>> loadMarketEnvironment() async {
    final fallback = await _fallbackProvider.loadMarketEnvironment();
    if (!isConfigured) {
      return fallback;
    }

    final observations = <String, double>{};
    for (final seriesId in const [
      'VIXCLS',
      'T10Y2Y',
      'BAA10Y',
      'NFCI',
      'T10YIE',
    ]) {
      final value = await _latestObservation(seriesId);
      if (value != null) {
        observations[seriesId] = value;
      }
    }

    if (observations.length < 3) {
      return FeedSlice(
        name: fallback.name,
        source: '${fallback.source}+fred-unavailable',
        asOf: DateTime.now(),
        data: fallback.data,
        availability: fallback.availability,
        refreshCadence: fallback.refreshCadence,
        detail:
            '${fallback.detail} FRED was configured, but not enough macro series returned to override the fallback regime inputs.',
      );
    }

    final vix = observations['VIXCLS'];
    final yieldCurve = observations['T10Y2Y'];
    final creditSpread = observations['BAA10Y'];
    final financialConditions = observations['NFCI'];
    final breakeven = observations['T10YIE'];
    final base = fallback.data;
    final environment = RawMarketEnvironment(
      indexTrend: base.indexTrend,
      realizedVolatility: base.realizedVolatility,
      impliedVolatility: vix == null
          ? base.impliedVolatility
          : _clampScore(18 + (vix - 10) * 3.1),
      creditStress: creditSpread == null
          ? base.creditStress
          : _clampScore(18 + creditSpread * 12),
      financialConditions: financialConditions == null
          ? base.financialConditions
          : _clampScore(58 - financialConditions * 22),
      growthLeadership: base.growthLeadership,
      defensiveLeadership: base.defensiveLeadership,
      smallCapLeadership: base.smallCapLeadership,
      inflationPressure: breakeven == null
          ? base.inflationPressure
          : _clampScore(35 + (breakeven - 2.0) * 24),
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
      yieldCurveSlope: yieldCurve ?? base.yieldCurveSlope,
      breadthByPhase: base.breadthByPhase,
    );

    return FeedSlice(
      name: 'FRED macro and credit',
      source: 'fred-macro',
      asOf: DateTime.now(),
      data: environment,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.daily,
      detail:
          'FRED supplied ${observations.length}/5 macro series: VIX, 10y-2y curve, Baa spread, financial conditions, and 10y breakeven inflation.',
    );
  }

  Future<double?> _latestObservation(String seriesId) async {
    final uri = Uri.https('api.stlouisfed.org', '/fred/series/observations', {
      'series_id': seriesId,
      'api_key': apiKey ?? '',
      'file_type': 'json',
      'sort_order': 'desc',
      'limit': '8',
    });
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) {
        return null;
      }
      final decoded = jsonDecode(response.body) as Map<String, dynamic>;
      final observations =
          decoded['observations'] as List<dynamic>? ?? const [];
      for (final raw in observations) {
        if (raw is! Map<String, dynamic>) {
          continue;
        }
        final value = raw['value'] as String?;
        if (value == null || value == '.') {
          continue;
        }
        final parsed = double.tryParse(value);
        if (parsed != null) {
          return parsed;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  double _clampScore(double value) {
    if (value < 0) {
      return 0;
    }
    if (value > 100) {
      return 100;
    }
    return value;
  }
}

class FredMacroStatusProvider {
  const FredMacroStatusProvider({required this.apiKey});

  final String? apiKey;

  DataFeedStatus status() {
    final configured = apiKey != null && apiKey!.trim().isNotEmpty;
    return DataFeedStatus(
      name: 'FRED macro and credit',
      availability: configured
          ? FeedAvailability.planned
          : FeedAvailability.missing,
      refreshCadence: FeedRefreshCadence.daily,
      detail: configured
          ? 'FRED key is configured. The macro provider will attempt to pull VIX, yield curve, credit spread, financial conditions, and inflation breakevens on refresh.'
          : 'FRED key not set. Add ORACLE_FRED_API_KEY or kFredApiKey to activate real macro and credit inputs.',
      lastUpdated: null,
    );
  }
}
