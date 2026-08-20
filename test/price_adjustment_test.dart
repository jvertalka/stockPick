import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import '../tool/backend_cache_server.dart';

void main() {
  group('Yahoo adjusted-total-return ingestion', () {
    test('uses adjclose for returns while retaining raw quote prices', () {
      final rawCloses = <double>[100, ...List<double>.filled(219, 50)];
      final adjustedCloses = List<double>.filled(220, 50);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: rawCloses,
          adjustedCloses: adjustedCloses,
        ),
        maxBars: 0,
      );

      expect(series.priceBasis, 'adjusted-total-return');
      expect(series.adjustedBarCount, 220);
      expect(series.unadjustedBarCount, 0);
      expect(series.adjustmentCoveragePct, 100);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);

      final preSplit = series.bars.first;
      expect(preSplit.close, 50);
      expect(preSplit.rawClose, 100);
      expect(preSplit.adjustmentFactor, 0.5);
      expect(preSplit.open, 49);
      expect(preSplit.rawOpen, 98);

      final metrics = DecisionPriceMetrics.fromSeries(series);
      // A raw-close series would report -50%; adjclose correctly reports 0%.
      expect(metrics.return20d, closeTo(0, 1e-12));
      expect(metrics.priceBasis, 'adjusted-total-return');
      expect(metrics.lastPrice, 50);
      expect(metrics.barCount, DecisionPriceSeries.analyticsWindowSize);
    });

    test('allows an older gap but uses only the contiguous 200-row tail', () {
      final adjusted = List<double?>.filled(221, 50)..[0] = null;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(221, 50),
          adjustedCloses: adjusted,
        ),
        maxBars: 0,
      );

      expect(series.priceBasis, 'mixed-adjusted-and-unadjusted');
      expect(series.adjustedBarCount, 220);
      expect(series.unadjustedBarCount, 1);
      expect(series.adjustmentCoveragePct, closeTo(100 * 220 / 221, 1e-12));
      expect(
        series.bars.first.adjustmentSource,
        'yahoo-close-missing-adjclose',
      );
      expect(series.hasOlderAnalyticalGaps, isTrue);
      expect(series.currentAnalyticsGapCount, 0);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);

      final metrics = DecisionPriceMetrics.fromSeries(series);
      expect(metrics.barCount, 200);
      expect(
        metrics.warnings,
        contains(
          'Provider gaps exist before the current 200-row analytics window; '
          'metrics use only the contiguous adjusted tail.',
        ),
      );
    });

    test('a gap inside the current 200 provider rows rejects metrics', () {
      final adjusted = List<double?>.filled(220, 50)..[100] = null;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: adjusted,
        ),
        maxBars: 0,
      );

      expect(series.adjustedBarCount, 219);
      expect(series.currentAnalyticsGapCount, 1);
      expect(series.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNull);

      final eligible = DecisionPriceSeries.fromYahooChart(
        symbol: 'GOOD',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
        ),
        maxBars: 0,
      );
      final coverage = DecisionPriceCoverage.fromState(
        DecisionPriceHistoryState(
          lastSyncAt: DateTime.utc(2024, 2, 1),
          seriesBySymbol: {'GOOD': eligible, 'TEST': series},
        ),
        selectedSymbols: const ['GOOD', 'TEST'],
        usableSymbols: 1,
        anchor: eligible.bars.last.date,
      );
      expect(coverage.analyticalBarCount, 200);
      expect(coverage.adjustedInventoryBarCount, 439);
      expect(coverage.structurallyUsableSeriesCount, 1);
      expect(coverage.currentAnalyticsGapSeriesCount, 1);
      expect(coverage.freshSymbolCount, 1);
      expect(coverage.latestPriceDate, eligible.bars.last.date);
      expect(
        coverage.oldestPriceDate,
        eligible.bars[eligible.bars.length - 200].date,
      );
    });

    test('fully-null provider placeholder rows are dropped and counted', () {
      // Yahoo has served rows where every field including volume is null
      // (fleet-wide for the 2026-07-21/22/31 sessions). Such a row carries
      // zero information, so it is dropped like a market holiday and the
      // exclusion is counted for provenance.
      final closes = List<double?>.filled(221, 50)..[100] = null;
      final volumes = List<double?>.filled(221, 1000)..[100] = null;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: closes,
          adjustedCloses: closes,
          rawVolumes: volumes,
        ),
        maxBars: 0,
      );

      expect(series.bars.length, 220);
      expect(series.excludedProviderPlaceholderRows, 1);
      expect(series.incompleteProviderBarCount, 0);
      expect(series.currentAnalyticsGapCount, 0);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNotNull);

      final restored = DecisionPriceSeries.fromJson(
        jsonDecode(jsonEncode(series.toJson())) as Map<String, dynamic>,
      );
      expect(restored.excludedProviderPlaceholderRows, 1);
      expect(restored.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('a null-price row with real volume is kept and rejects the window', () {
      // Real volume means the provider had SOME data for the session, so the
      // row is not a placeholder: it stays as an ineligible bar and the
      // series goes back to the refresh queue.
      final closes = List<double?>.filled(220, 50)..[100] = null;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(rawCloses: closes, adjustedCloses: closes),
        maxBars: 0,
      );

      expect(series.bars.length, 220);
      expect(series.excludedProviderPlaceholderRows, 0);
      expect(series.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNull);
    });

    test('missing Yahoo OHLCV stays as a marked non-analytical row', () {
      final opens = List<double?>.filled(220, 49)..[219] = null;
      final volumes = List<double?>.filled(220, 1000)..[218] = null;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          rawOpens: opens,
          rawVolumes: volumes,
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.incompleteProviderBarCount, 2);
      expect(series.adjustedBarCount, 218);
      expect(series.currentAnalyticsGapCount, 2);
      expect(series.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNull);

      final missingOpen = series.bars.last;
      expect(missingOpen.rawOpen, isNull);
      expect(missingOpen.open, 0);
      expect(
        missingOpen.providerRowStatus,
        'invalid-or-incomplete-yahoo-ohlcv',
      );
      expect(missingOpen.isAdjustedTotalReturn, isFalse);
    });

    test('impossible Yahoo OHLC bounds are display-only', () {
      final highs = List<double?>.filled(220, 51)..[219] = 49;
      final lows = List<double?>.filled(220, 48)..[218] = 51;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          rawHighs: highs,
          rawLows: lows,
        ),
        maxBars: 0,
      );

      expect(series.bars.last.rawHigh, 49);
      expect(
        series.bars.last.providerRowStatus,
        'invalid-or-incomplete-yahoo-ohlcv',
      );
      expect(series.bars.last.isAdjustedTotalReturn, isFalse);
      expect(
        series.bars[218].providerRowStatus,
        'invalid-or-incomplete-yahoo-ohlcv',
      );
      expect(series.currentAnalyticsGapCount, 2);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNull);
    });

    test(
      'legacy cached bars stay explicitly raw and analytically ineligible',
      () {
        final legacy = DecisionPriceSeries.fromJson({
          'symbol': 'TEST',
          'source': 'yahoo-finance',
          'fetchedAt': '2024-02-01T00:00:00Z',
          'bars': [
            for (var index = 0; index < 5; index++)
              {
                'date':
                    '2024-01-${(index + 1).toString().padLeft(2, '0')}T00:00:00Z',
                'open': 100,
                'high': 101,
                'low': 99,
                'close': 100,
                'volume': 1000,
              },
          ],
        });

        expect(legacy.priceBasis, 'unadjusted-close');
        expect(legacy.adjustmentSource, 'legacy-unadjusted-close');
        expect(legacy.hasAdjustedTotalReturnPrices, isFalse);
        expect(DecisionPriceMetrics.fromSeriesOrNull(legacy), isNull);

        final migratedJson = legacy.toJson();
        expect(
          migratedJson['schemaVersion'],
          DecisionPriceSeries.currentSchemaVersion,
        );
        expect(migratedJson['adjustedBarCount'], 0);
        expect(migratedJson['unadjustedBarCount'], 5);
      },
    );

    test('a missing provider-row marker fails closed even in schema v3', () {
      final source = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(200, 50),
          adjustedCloses: List<double>.filled(200, 50),
        ),
        maxBars: 0,
      );
      final payload = source.toJson();
      for (final bar
          in (payload['bars'] as List).cast<Map<String, Object?>>()) {
        bar.remove('providerRowStatus');
      }

      final restored = DecisionPriceSeries.fromJson(payload);
      expect(restored.bars.first.providerRowStatus, 'legacy-unverified');
      expect(restored.adjustedBarCount, 0);
      expect(restored.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(restored), isNull);
    });

    test('cached provider order is validated rather than sorted', () {
      final source = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2024, 2, 1),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(200, 50),
          adjustedCloses: List<double>.filled(200, 50),
        ),
        maxBars: 0,
      );
      final payload = source.toJson();
      final bars = payload['bars'] as List<Object?>;
      final last = bars.last;
      bars[bars.length - 1] = bars[bars.length - 2];
      bars[bars.length - 2] = last;

      final restored = DecisionPriceSeries.fromJson(payload);
      expect(
        restored.bars[restored.bars.length - 2].date.isAfter(
          restored.bars.last.date,
        ),
        isTrue,
      );
      expect(restored.currentAnalyticsGapCount, 1);
      expect(restored.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(restored), isNull);
    });

    test('rejects a Yahoo response with no adjclose series', () {
      expect(
        () => DecisionPriceSeries.fromYahooChart(
          symbol: 'TEST',
          fetchedAt: DateTime.utc(2024, 2, 1),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(5, 50),
            adjustedCloses: null,
          ),
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects duplicate Yahoo timestamps in provider order', () {
      final timestamps = _dailyTimestamps(220);
      timestamps[150] = timestamps[149];

      expect(
        () => DecisionPriceSeries.fromYahooChart(
          symbol: 'TEST',
          fetchedAt: DateTime.utc(2024, 2, 1),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(220, 50),
            adjustedCloses: List<double>.filled(220, 50),
            timestamps: timestamps,
          ),
          maxBars: 0,
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects reversed Yahoo timestamps instead of sorting them', () {
      final timestamps = _dailyTimestamps(220);
      timestamps[150] = timestamps[149] - 1;

      expect(
        () => DecisionPriceSeries.fromYahooChart(
          symbol: 'TEST',
          fetchedAt: DateTime.utc(2024, 2, 1),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(220, 50),
            adjustedCloses: List<double>.filled(220, 50),
            timestamps: timestamps,
          ),
          maxBars: 0,
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects malformed and non-finite Yahoo timestamps', () {
      final malformed = <Object?>[..._dailyTimestamps(220)];
      malformed[150] = null;
      final overflow = <Object?>[..._dailyTimestamps(220)];
      overflow[150] = 'NON_FINITE_TIMESTAMP';

      for (final body in [
        _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: malformed,
        ),
        _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: overflow,
        ).replaceFirst('"NON_FINITE_TIMESTAMP"', '1e999'),
      ]) {
        expect(
          () => DecisionPriceSeries.fromYahooChart(
            symbol: 'TEST',
            fetchedAt: DateTime.utc(2024, 2, 1),
            body: body,
            maxBars: 0,
          ),
          throwsA(isA<FormatException>()),
        );
      }
    });
  });
}

String _yahooChartBody({
  required List<double?> rawCloses,
  required List<double?>? adjustedCloses,
  List<double?>? rawOpens,
  List<double?>? rawHighs,
  List<double?>? rawLows,
  List<double?>? rawVolumes,
  List<Object?>? timestamps,
}) {
  return jsonEncode({
    'chart': {
      'result': [
        {
          'timestamp': timestamps ?? _dailyTimestamps(rawCloses.length),
          'indicators': {
            'quote': [
              {
                'open':
                    rawOpens ??
                    rawCloses
                        .map((close) => close == null ? null : close * 0.98)
                        .toList(),
                'high':
                    rawHighs ??
                    rawCloses
                        .map((close) => close == null ? null : close * 1.02)
                        .toList(),
                'low':
                    rawLows ??
                    rawCloses
                        .map((close) => close == null ? null : close * 0.97)
                        .toList(),
                'close': rawCloses,
                'volume':
                    rawVolumes ?? List<double>.filled(rawCloses.length, 1000),
              },
            ],
            if (adjustedCloses != null)
              'adjclose': [
                {'adjclose': adjustedCloses},
              ],
          },
        },
      ],
      'error': null,
    },
  });
}

List<int> _dailyTimestamps(int count) {
  final firstEpoch = DateTime.utc(2024, 1, 2).millisecondsSinceEpoch ~/ 1000;
  return [
    for (var index = 0; index < count; index++) firstEpoch + index * 86400,
  ];
}
