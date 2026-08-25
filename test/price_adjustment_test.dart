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

    test(
      'a null-price row with real volume is kept and rejects the window',
      () {
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
      },
    );

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

    test('an in-progress session bar is excluded and counted', () {
      // Mirrors the live ABCB failure of 2026-08-25: the session that was
      // still running got served as the newest daily bar, with an open above
      // its own high. Kept, that row lands inside the latest-200 window and
      // disqualifies the entire symbol from scoring.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final opens = List<double?>.filled(220, 49)..[219] = 51.5;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          rawOpens: opens,
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(219));
      expect(series.excludedInProgressSessionBars, 1);
      expect(series.excludedProviderPlaceholderRows, 0);
      // The newest stored bar is now the last COMPLETED session.
      expect(
        series.bars.last.date,
        sessionOpen.subtract(const Duration(days: 1)),
      );
      expect(series.bars.last.rawOpen, 49);
      expect(series.incompleteProviderBarCount, 0);
      expect(series.currentAnalyticsGapCount, 0);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNotNull);
    });

    test('after the close the same response keeps every bar', () {
      // The same bytes, read after 20:00Z. The session is finished, so
      // nothing is excluded and an impossible bar stays as impossible as it
      // was before this rule existed.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final opens = List<double?>.filled(220, 49)..[219] = 51.5;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 21, 5),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          rawOpens: opens,
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
      expect(
        series.bars.last.providerRowStatus,
        'invalid-or-incomplete-yahoo-ohlcv',
      );
      expect(series.hasAdjustedTotalReturnPrices, isFalse);
    });

    test('a stale last bar is untouched while the session runs', () {
      // A halted name whose newest bar is days old. The session is open, but
      // that bar is a finished day and real data: never drop it.
      final lastCompletedSession = DateTime.utc(2026, 8, 20, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'HALT',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(
            220,
            lastSessionOpen: lastCompletedSession,
          ),
          meta: _yahooSessionMeta(
            sessionOpen: DateTime.utc(2026, 8, 25, 13, 30),
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, lastCompletedSession);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('missing or malformed session metadata changes nothing', () {
      // Without usable metadata the parser cannot know whether a session is
      // running, so it keeps what it was sent instead of guessing.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final metas = <Map<String, Object?>?>[
        null,
        {'exchangeName': 'NYQ', 'regularMarketTime': 1787671000},
        {'currentTradingPeriod': <String, Object?>{}},
        {
          'currentTradingPeriod': {
            'regular': {'start': 'not-a-number', 'end': null},
          },
        },
      ];
      for (var index = 0; index < metas.length; index++) {
        final series = DecisionPriceSeries.fromYahooChart(
          symbol: 'TEST',
          fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(220, 50),
            adjustedCloses: List<double>.filled(220, 50),
            timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
            meta: metas[index],
          ),
          maxBars: 0,
        );

        expect(series.bars, hasLength(220), reason: 'meta variant $index');
        expect(
          series.excludedInProgressSessionBars,
          0,
          reason: 'meta variant $index',
        );
        expect(series.bars.last.date, sessionOpen);
      }
    });

    test('the in-progress exclusion count survives a cache round trip', () {
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );
      expect(series.toJson()['excludedInProgressSessionBars'], 1);

      final restored = DecisionPriceSeries.fromJson(
        jsonDecode(jsonEncode(series.toJson())) as Map<String, dynamic>,
      );
      expect(restored.excludedInProgressSessionBars, 1);
      expect(restored.excludedProviderPlaceholderRows, 0);
      expect(restored.bars, hasLength(219));
      expect(restored.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('a placeholder row and an in-progress bar are counted apart', () {
      // Both exclusions can happen in one response, and each keeps its own
      // count.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final closes = List<double?>.filled(221, 50)..[100] = null;
      final volumes = List<double?>.filled(221, 1000)..[100] = null;
      final opens = List<double?>.filled(221, 49)
        ..[100] = null
        ..[220] = 51.5;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: closes,
          adjustedCloses: closes,
          rawOpens: opens,
          rawVolumes: volumes,
          timestamps: _sessionTimestamps(221, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(219));
      expect(series.excludedProviderPlaceholderRows, 1);
      expect(series.excludedInProgressSessionBars, 1);
      expect(series.incompleteProviderBarCount, 0);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('the in-progress bar is dropped before the 320-bar trim', () {
      // The live sync path parses with the DEFAULT maxBars, so this test
      // leaves it alone on purpose. Order matters here and nothing else
      // pins it: trim first and the newest completed bar falls off the end,
      // leaving 319 kept sessions instead of 320.
      const providerRows = 400;
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final opens = List<double?>.filled(providerRows, 49)
        ..[providerRows - 1] = 51.5;
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(providerRows, 50),
          adjustedCloses: List<double>.filled(providerRows, 50),
          rawOpens: opens,
          timestamps: _sessionTimestamps(
            providerRows,
            lastSessionOpen: sessionOpen,
          ),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
      );

      expect(series.bars, hasLength(320));
      expect(series.excludedInProgressSessionBars, 1);
      // Newest kept bar is the last COMPLETED session, and the window still
      // reaches a full 320 completed sessions back.
      expect(
        series.bars.last.date,
        sessionOpen.subtract(const Duration(days: 1)),
      );
      expect(
        series.bars.first.date,
        sessionOpen.subtract(const Duration(days: 320)),
      );
      expect(series.bars.last.rawOpen, 49);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('the same 320-bar trim keeps every bar once the session ends', () {
      // The companion case: after the close nothing is excluded, so the trim
      // keeps the newest 320 rows exactly as it always did.
      const providerRows = 400;
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'ABCB',
        fetchedAt: DateTime.utc(2026, 8, 25, 21, 5),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(providerRows, 50),
          adjustedCloses: List<double>.filled(providerRows, 50),
          timestamps: _sessionTimestamps(
            providerRows,
            lastSessionOpen: sessionOpen,
          ),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
      );

      expect(series.bars, hasLength(320));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
      expect(
        series.bars.first.date,
        sessionOpen.subtract(const Duration(days: 319)),
      );
    });

    test('a session window reaching back over finished days is ignored', () {
      // The genuine data-loss case a reviewer found: Yahoo sends a start of
      // 0 with a plausible end, so the "session running right now" appears
      // to stretch back years and swallows a real, finished bar from days
      // ago. The window is not a trading day, so nothing may be dropped.
      final lastCompletedSession = DateTime.utc(2026, 8, 20, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'HALT',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(
            220,
            lastSessionOpen: lastCompletedSession,
          ),
          meta: _yahooSessionMeta(
            sessionOpen: DateTime.utc(1970),
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, lastCompletedSession);
      expect(series.hasAdjustedTotalReturnPrices, isTrue);
    });

    test('a session window longer than the duration bound is ignored', () {
      // Fifteen hours is longer than any exchange's regular session, so the
      // window is metadata this parser will not act on — even though the
      // clock and the bar both sit inside it.
      final windowStart = DateTime.utc(2026, 8, 25, 6);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: windowStart),
          meta: _yahooSessionMeta(
            sessionOpen: windowStart,
            sessionClose: DateTime.utc(2026, 8, 25, 21),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, windowStart);
    });

    test('the duration bound sits at twelve hours', () {
      // Pins the constant from both sides so nobody tightens it into a real
      // exchange or loosens it back toward a whole day.
      final sessionOpen = DateTime.utc(2026, 8, 25, 8);
      DecisionPriceSeries parseWith(DateTime sessionClose) {
        return DecisionPriceSeries.fromYahooChart(
          symbol: 'TEST',
          fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(220, 50),
            adjustedCloses: List<double>.filled(220, 50),
            timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
            meta: _yahooSessionMeta(
              sessionOpen: sessionOpen,
              sessionClose: sessionClose,
            ),
          ),
          maxBars: 0,
        );
      }

      final atBound = parseWith(DateTime.utc(2026, 8, 25, 20));
      expect(atBound.bars, hasLength(219));
      expect(atBound.excludedInProgressSessionBars, 1);

      final justOver = parseWith(DateTime.utc(2026, 8, 25, 20, 1));
      expect(justOver.bars, hasLength(220));
      expect(justOver.excludedInProgressSessionBars, 0);
    });

    test('a long European session still drops its in-progress bar', () {
      // London runs 08:00 to 16:30 local, the longest regular session this
      // rule can meet. The bound has to stay generous enough for it.
      final sessionOpen = DateTime.utc(2026, 8, 25, 7);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 12),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 15, 30),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(219));
      expect(series.excludedInProgressSessionBars, 1);
      expect(
        series.bars.last.date,
        sessionOpen.subtract(const Duration(days: 1)),
      );
    });

    test('a five-minute session window changes nothing', () {
      // Too short to be any exchange's trading day, so it is degenerate
      // metadata and no bar may be dropped on the strength of it.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 13, 32),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 13, 35),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
    });

    test('a session that ends exactly when it starts changes nothing', () {
      // Two separate things refuse this window: the duration test, and the
      // fact that the open-session check needs the clock to be strictly
      // before the end. Either one alone is enough, so this pins the pair —
      // it goes red only if both are weakened.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 13, 30),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: sessionOpen,
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
    });

    test('an inverted session window changes nothing', () {
      // End before start. Read literally it covers no time at all, and
      // three separate checks each refuse it on their own, so no single
      // deletion can make this test go red. It is the tripwire for a
      // well-meaning "fix" that sorts the two ends into a range instead:
      // do that and the window silently becomes a real one, covering the
      // clock and a bar that is already finished.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: DateTime.utc(2026, 8, 25, 20),
            sessionClose: sessionOpen,
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
    });

    test('a session start sent as text changes nothing', () {
      // The sneaky one: a start that LOOKS like an epoch second but arrives
      // as a string. It is not a number, so the window is unusable.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooMetaWithRegular({
            'start': '${_epochSeconds(sessionOpen)}',
            'end': _epochSeconds(DateTime.utc(2026, 8, 25, 20)),
          }),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
    });

    test('a regular block sent as a list changes nothing', () {
      // Yahoo returns `regular` as an object. A list carrying the same
      // numbers is a shape this parser must refuse to read.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'TEST',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(220, 50),
          adjustedCloses: List<double>.filled(220, 50),
          timestamps: _sessionTimestamps(220, lastSessionOpen: sessionOpen),
          meta: _yahooMetaWithRegular([
            {
              'start': _epochSeconds(sessionOpen),
              'end': _epochSeconds(DateTime.utc(2026, 8, 25, 20)),
            },
          ]),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, sessionOpen);
    });

    test('an unbounded session window changes nothing', () {
      // Yahoo numbers are JSON, and a JSON exponent big enough to overflow
      // decodes to infinity rather than failing (measured: Dart's jsonDecode
      // turns 1e400 into Infinity). An infinite window covers every instant
      // there is, so it would read as open forever and swallow this halted
      // name's last real bar. The finite check and the duration test each
      // stop it on their own; this goes red when both are gone.
      final lastCompletedSession = DateTime.utc(2026, 8, 20, 13, 30);
      // Dart cannot encode an infinite double back into JSON, so the
      // overflowing literals are spliced into the encoded body the way a
      // provider would have sent them.
      final body =
          _yahooChartBody(
                rawCloses: List<double>.filled(220, 50),
                adjustedCloses: List<double>.filled(220, 50),
                timestamps: _sessionTimestamps(
                  220,
                  lastSessionOpen: lastCompletedSession,
                ),
                meta: _yahooMetaWithRegular({'start': -1, 'end': -2}),
              )
              .replaceAll('"start":-1', '"start":-1e400')
              .replaceAll('"end":-2', '"end":1e400');

      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'HALT',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: body,
        maxBars: 0,
      );

      expect(series.bars, hasLength(220));
      expect(series.excludedInProgressSessionBars, 0);
      expect(series.bars.last.date, lastCompletedSession);
    });

    test('five provider rows in an open session store four bars', () {
      // A brand-new ticker with barely any history. Dropping the running
      // session leaves four completed bars, and the response is stored
      // rather than failing the sync — the same bytes must not parse after
      // the close and throw during the session.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: 'NEWCO',
        fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
        body: _yahooChartBody(
          rawCloses: List<double>.filled(5, 50),
          adjustedCloses: List<double>.filled(5, 50),
          timestamps: _sessionTimestamps(5, lastSessionOpen: sessionOpen),
          meta: _yahooSessionMeta(
            sessionOpen: sessionOpen,
            sessionClose: DateTime.utc(2026, 8, 25, 20),
          ),
        ),
        maxBars: 0,
      );

      expect(series.bars, hasLength(4));
      expect(series.excludedInProgressSessionBars, 1);
      expect(
        series.bars.last.date,
        sessionOpen.subtract(const Duration(days: 1)),
      );
      // Four bars are far below the 200-row analytics window, so the series
      // is stored honestly and stays unscoreable.
      expect(series.hasAdjustedTotalReturnPrices, isFalse);
      expect(DecisionPriceMetrics.fromSeriesOrNull(series), isNull);
    });

    test('four provider rows still fail as too few bars', () {
      // The floor itself is unchanged: a response that really is too short
      // is still rejected, session open or not.
      final sessionOpen = DateTime.utc(2026, 8, 25, 13, 30);
      expect(
        () => DecisionPriceSeries.fromYahooChart(
          symbol: 'NEWCO',
          fetchedAt: DateTime.utc(2026, 8, 25, 18, 16),
          body: _yahooChartBody(
            rawCloses: List<double>.filled(4, 50),
            adjustedCloses: List<double>.filled(4, 50),
            timestamps: _sessionTimestamps(4, lastSessionOpen: sessionOpen),
            meta: _yahooSessionMeta(
              sessionOpen: sessionOpen,
              sessionClose: DateTime.utc(2026, 8, 25, 20),
            ),
          ),
          maxBars: 0,
        ),
        throwsA(isA<FormatException>()),
      );
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
  Map<String, Object?>? meta,
}) {
  final result = <String, Object?>{
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
          'volume': rawVolumes ?? List<double>.filled(rawCloses.length, 1000),
        },
      ],
      if (adjustedCloses != null)
        'adjclose': [
          {'adjclose': adjustedCloses},
        ],
    },
  };
  // Yahoo carries the exchange's own session clock here. Only the tests that
  // need the parser to know whether a session is running supply it.
  if (meta != null) {
    result['meta'] = meta;
  }
  return jsonEncode({
    'chart': {
      'result': [result],
      'error': null,
    },
  });
}

/// Yahoo stamps each daily bar with the epoch second its regular session
/// opened, so a bar for a day still in progress carries that day's open time.
List<int> _sessionTimestamps(int count, {required DateTime lastSessionOpen}) {
  final lastEpoch = lastSessionOpen.toUtc().millisecondsSinceEpoch ~/ 1000;
  return [
    for (var index = 0; index < count; index++)
      lastEpoch - (count - 1 - index) * 86400,
  ];
}

/// The session block Yahoo returns in `chart.result[0].meta`, shaped like the
/// live NYSE response measured on 2026-08-25 (13:30Z to 20:00Z).
Map<String, Object?> _yahooSessionMeta({
  required DateTime sessionOpen,
  required DateTime sessionClose,
}) {
  final startEpoch = sessionOpen.toUtc().millisecondsSinceEpoch ~/ 1000;
  final endEpoch = sessionClose.toUtc().millisecondsSinceEpoch ~/ 1000;
  return {
    'exchangeName': 'NYQ',
    'exchangeTimezoneName': 'America/New_York',
    'gmtoffset': -14400,
    'regularMarketTime': startEpoch + 3600,
    'currentTradingPeriod': {
      'pre': {'start': startEpoch - 19800, 'end': startEpoch},
      'regular': {
        'timezone': 'EDT',
        'start': startEpoch,
        'end': endEpoch,
        'gmtoffset': -14400,
      },
      'post': {'start': endEpoch, 'end': endEpoch + 14400},
    },
  };
}

int _epochSeconds(DateTime moment) =>
    moment.toUtc().millisecondsSinceEpoch ~/ 1000;

/// The same meta envelope Yahoo sends, with the `regular` block replaced
/// wholesale so a test can hand the parser a malformed one.
Map<String, Object?> _yahooMetaWithRegular(Object? regular) {
  return {
    'exchangeName': 'NYQ',
    'exchangeTimezoneName': 'America/New_York',
    'gmtoffset': -14400,
    'currentTradingPeriod': {'regular': regular},
  };
}

List<int> _dailyTimestamps(int count) {
  final firstEpoch = DateTime.utc(2024, 1, 2).millisecondsSinceEpoch ~/ 1000;
  return [
    for (var index = 0; index < count; index++) firstEpoch + index * 86400,
  ];
}
