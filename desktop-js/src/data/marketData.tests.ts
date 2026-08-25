import {
  cachedFetchRiskFreeRate,
  clearRiskFreeRateCacheForTests,
  fetchDailyBars,
  fetchNextEarnings,
  fetchStockFundamentals,
  normalizeYahooSymbol,
  parseYahooDailyBars,
  type DailyBar,
} from './marketData'
import { priceChartCurrencyDisplay } from './priceDisplay'
import { resolveTradableSpot } from './quantAnalysis'

type TestResult = { name: string; passed: boolean; detail?: string }

function approx(left: number, right: number, tolerance = 1e-10): boolean {
  return Math.abs(left - right) <= tolerance
}

function yahooPayload(rawCloses: number[], adjustedCloses?: Array<number | null>) {
  const firstEpoch = Date.UTC(2024, 0, 2) / 1000
  return {
    chart: {
      result: [{
        timestamp: rawCloses.map((_, index) => firstEpoch + index * 86_400),
        indicators: {
          quote: [{
            open: rawCloses.map((close) => close * 0.98),
            high: rawCloses.map((close) => close * 1.02),
            low: rawCloses.map((close) => close * 0.97),
            close: rawCloses,
            volume: rawCloses.map(() => 1_000),
          }],
          ...(adjustedCloses ? { adjclose: [{ adjclose: adjustedCloses }] } : {}),
        },
      }],
      error: null,
    },
  }
}

/* The instrument's regular session on 2026-08-25, the day the half-finished
 * bars below were measured live: 13:30Z to 20:00Z. Yahoo stamps every daily
 * bar with the moment its session opened, so a bar for the day in progress
 * carries the session start as its timestamp. */
const SESSION_START_SECONDS = Date.UTC(2026, 7, 25, 13, 30) / 1000
const SESSION_END_SECONDS = Date.UTC(2026, 7, 25, 20, 0) / 1000
const OPEN_REGULAR_SESSION = { start: SESSION_START_SECONDS, end: SESSION_END_SECONDS }
/** 18:16Z: mid-session, the instant ABCB reported an open above its own high. */
const MID_SESSION_MS = Date.UTC(2026, 7, 25, 18, 16)
const BEFORE_SESSION_MS = Date.UTC(2026, 7, 25, 12, 0)
const AFTER_SESSION_MS = Date.UTC(2026, 7, 25, 21, 0)

type SessionRow = { open: number; high: number; low: number; close: number }

/** Four finished sessions. Nothing about these rows is unusual. */
const COMPLETED_ROWS: SessionRow[] = [
  { open: 85.1, high: 85.9, low: 84.8, close: 85.6 },
  { open: 85.55, high: 86.2, low: 85.3, close: 86.05 },
  { open: 86.0, high: 86.35, low: 85.4, close: 85.75 },
  { open: 85.7, high: 86.1, low: 85.2, close: 85.95 },
]
/** ABCB as Yahoo served it at 18:16Z on 2026-08-25: an open of 86.10 above its
 * own high of 85.99, which no finished session can produce. */
const IN_PROGRESS_ABCB_ROW: SessionRow = { open: 86.1, high: 85.99, low: 85.55, close: 85.72 }
/** The same trailing row after the session has settled and reconciles. */
const SETTLED_LAST_ROW: SessionRow = { open: 85.8, high: 86.4, low: 85.6, close: 86.2 }

/** Daily bars ending at [lastTimestampSeconds], one calendar day apart, with
 * adjclose equal to the raw close so the adjustment factor stays 1. */
function sessionPayload(rows: SessionRow[], lastTimestampSeconds = SESSION_START_SECONDS) {
  return {
    chart: {
      result: [{
        timestamp: rows.map(
          (_, index) => lastTimestampSeconds - (rows.length - 1 - index) * 86_400,
        ),
        indicators: {
          quote: [{
            open: rows.map((row) => row.open),
            high: rows.map((row) => row.high),
            low: rows.map((row) => row.low),
            close: rows.map((row) => row.close),
            volume: rows.map(() => 1_000),
          }],
          adjclose: [{ adjclose: rows.map((row) => row.close) }],
        },
      }],
      error: null,
    },
  }
}

/** Attach any session block to a payload, including shapes Yahoo should never
 * send, so the parser's tolerance for junk metadata can be tested. */
function withMeta<T>(payload: T, meta: unknown): T {
  const entry = (payload as unknown as {
    chart: { result: Array<Record<string, unknown>> }
  }).chart.result[0]
  entry.meta = meta
  return payload
}

function withRegularSession<T>(payload: T, regular: unknown): T {
  return withMeta(payload, { currentTradingPeriod: { regular } })
}

export async function runMarketDataAdjustmentTests(): Promise<TestResult[]> {
  const results: TestResult[] = []

  {
    const bars = parseYahooDailyBars(yahooPayload([100, 50], [50, 50]))
    const first = bars[0]
    const passed =
      bars.length === 2 &&
      first.close === 50 &&
      first.rawClose === 100 &&
      first.rawOpen === 98 &&
      approx(first.open, 49) &&
      first.adjustmentFactor === 0.5 &&
      bars.adjustment.priceBasis === 'adjusted-total-return' &&
      bars.adjustment.coveragePct === 100
    results.push({
      name: 'Yahoo adjclose drives analytical OHLC while raw quotes survive',
      passed,
      detail: passed ? undefined : JSON.stringify({ first, adjustment: bars.adjustment }),
    })
  }

  {
    const bars = parseYahooDailyBars(yahooPayload([50, 50, 50], [50, null, 50]))
    const passed =
      bars.length === 2 &&
      bars.adjustment.eligibleRawBars === 3 &&
      bars.adjustment.adjustedBars === 2 &&
      bars.adjustment.missingAdjustedBars === 1 &&
      approx(bars.adjustment.coveragePct, 100 * 2 / 3)
    results.push({
      name: 'missing adjclose rows fail closed with explicit coverage',
      passed,
      detail: passed ? undefined : JSON.stringify(bars.adjustment),
    })
  }

  {
    const bars = parseYahooDailyBars(yahooPayload([50, 51, 52]))
    const passed =
      bars.length === 0 &&
      bars.adjustment.eligibleRawBars === 3 &&
      bars.adjustment.missingAdjustedBars === 3 &&
      bars.adjustment.coveragePct === 0
    results.push({
      name: 'absent adjclose cannot silently become raw-return history',
      passed,
      detail: passed ? undefined : JSON.stringify(bars.adjustment),
    })
  }

  {
    const payload = yahooPayload([50, 51, 52], [50, 51, 52])
    payload.chart.result[0].indicators.quote[0].high[1] = Number.NaN
    const bars = parseYahooDailyBars(payload)
    const crossedPayload = yahooPayload([50, 51, 52], [50, 51, 52])
    crossedPayload.chart.result[0].indicators.quote[0].high[1] = 49
    const crossedBars = parseYahooDailyBars(crossedPayload)
    const passed =
      bars.length === 2 &&
      bars.adjustment.sourceRows === 3 &&
      bars.adjustment.eligibleRawBars === 2 &&
      bars.adjustment.invalidRawBars === 1 &&
      bars.adjustment.rejectedBars === 1 &&
      approx(bars.adjustment.coveragePct, 100 * 2 / 3) &&
      crossedBars.length === 2 &&
      crossedBars.adjustment.invalidRawBars === 1
    results.push({
      name: 'invalid source OHLCV rows are rejected and remain in coverage denominator',
      passed,
      detail: passed ? undefined : JSON.stringify(bars.adjustment),
    })
  }

  {
    const duplicate = yahooPayload([50, 51, 52], [50, 51, 52])
    duplicate.chart.result[0].timestamp[2] = duplicate.chart.result[0].timestamp[1]
    const reversed = yahooPayload([50, 51, 52], [50, 51, 52])
    reversed.chart.result[0].timestamp[2] = reversed.chart.result[0].timestamp[0] - 86_400
    const duplicateBars = parseYahooDailyBars(duplicate)
    const reversedBars = parseYahooDailyBars(reversed)
    const passed =
      duplicateBars.length === 0 &&
      reversedBars.length === 0 &&
      duplicateBars.adjustment.invalidRawBars === 3 &&
      reversedBars.adjustment.invalidRawBars === 3
    results.push({
      name: 'duplicate or nonmonotonic Yahoo clocks fail the whole analytical series',
      passed,
      detail: passed
        ? undefined
        : JSON.stringify({ duplicate: duplicateBars.adjustment, reversed: reversedBars.adjustment }),
    })
  }

  {
    const bars = parseYahooDailyBars(yahooPayload([100, 102], [50, 51]))
    const spot = resolveTradableSpot(bars, 103)
    const passed = spot === 102
    results.push({
      name: 'quant analysis resolves raw tradable spot instead of adjusted close',
      passed,
      detail: passed ? undefined : JSON.stringify({ spot, latest: bars[bars.length - 1] }),
    })
  }

  {
    const adjustedOnlyBars: DailyBar[] = [{
      date: '2024-01-02',
      open: 49,
      high: 51,
      low: 48,
      close: 50,
      volume: 1_000,
    }]
    const withSignalFallback = resolveTradableSpot(adjustedOnlyBars, 101)
    const withoutRawSpot = resolveTradableSpot(adjustedOnlyBars)
    const passed = withSignalFallback === 101 && withoutRawSpot === null
    results.push({
      name: 'signal live price is the only fallback for a missing raw spot',
      passed,
      detail: passed ? undefined : JSON.stringify({ withSignalFallback, withoutRawSpot }),
    })
  }

  {
    const bars = parseYahooDailyBars(yahooPayload([100, 102], [50, 51]))
    const display = priceChartCurrencyDisplay(bars)
    const passed = display.lastClose === 102 && display.low60 === 50 && display.high60 === 51
    results.push({
      name: 'price chart currency labels use raw exchange closes',
      passed,
      detail: passed ? undefined : JSON.stringify(display),
    })
  }

  {
    const originalFetch = globalThis.fetch
    const upstreamRequests: string[] = []
    globalThis.fetch = async (input) => {
      const proxyUrl = new URL(String(input))
      const upstream = proxyUrl.searchParams.get('url') ?? ''
      upstreamRequests.push(upstream)
      if (upstream.includes('/chart/')) {
        return new Response(JSON.stringify(yahooPayload([100], [100])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ quoteSummary: { result: [], error: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    try {
      const bars = await fetchDailyBars('BRK.B', '1mo')
      const earnings = await fetchNextEarnings('BRK.B')
      const fundamentals = await fetchStockFundamentals('BRK.B')
      const passed =
        normalizeYahooSymbol('BRK.B') === 'BRK-B' &&
        normalizeYahooSymbol(' brk/b ') === 'BRK-B' &&
        upstreamRequests.length === 3 &&
        upstreamRequests.every((url) => url.includes('/BRK-B?')) &&
        bars.length === 1 &&
        earnings.ticker === 'BRK.B' &&
        fundamentals.ticker === 'BRK.B'
      results.push({
        name: 'Yahoo adapters request BRK-B while retaining display ticker BRK.B',
        passed,
        detail: passed
          ? undefined
          : JSON.stringify({ upstreamRequests, bars: bars.length, earnings, fundamentals }),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  {
    const originalFetch = globalThis.fetch
    let fredAttempts = 0
    clearRiskFreeRateCacheForTests()
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/config/providers')) {
        return new Response(JSON.stringify({ fred: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/proxy?url=')) {
        fredAttempts++
        if (fredAttempts === 1) return new Response(null, { status: 503 })
        return new Response(JSON.stringify({ observations: [{ date: '2026-07-09', value: '5.25' }] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Finance-Oracle-Cache': fredAttempts === 2 ? 'STALE' : 'MISS',
          },
        })
      }
      throw new Error(`Unexpected test fetch: ${url}`)
    }
    try {
      const failed = await cachedFetchRiskFreeRate()
      const stale = await cachedFetchRiskFreeRate()
      const recovered = await cachedFetchRiskFreeRate()
      const cachedRecovery = await cachedFetchRiskFreeRate()
      const passed =
        failed === null &&
        stale?.stale === true &&
        recovered?.rate === 0.0525 &&
        recovered.observationDate === '2026-07-09' &&
        recovered.cacheState === 'MISS' &&
        recovered.stale === false &&
        cachedRecovery === recovered &&
        fredAttempts === 3
      results.push({
        name: 'failed FRED result is retried and successful recovery is cached',
        passed,
        detail: passed
          ? undefined
          : JSON.stringify({ failed, stale, recovered, cachedRecovery, fredAttempts }),
      })
    } finally {
      globalThis.fetch = originalFetch
      clearRiskFreeRateCacheForTests()
    }
  }

  {
    const abcbRows = [...COMPLETED_ROWS, IN_PROGRESS_ABCB_ROW]
    const withSessionBlock = parseYahooDailyBars(
      withRegularSession(sessionPayload(abcbRows), OPEN_REGULAR_SESSION),
      MID_SESSION_MS,
    )
    // The same response without the session block is the behaviour we had
    // before: the half-finished row reaches the validator, fails the OHLC
    // bounds check, and leaves a rejected row that disqualifies the symbol.
    const withoutSessionBlock = parseYahooDailyBars(sessionPayload(abcbRows), MID_SESSION_MS)
    const passed =
      withSessionBlock.length === 4 &&
      withSessionBlock[3].date === '2026-08-24' &&
      withSessionBlock.adjustment.excludedInProgressSessionBars === 1 &&
      withSessionBlock.adjustment.sourceRows === 4 &&
      withSessionBlock.adjustment.invalidRawBars === 0 &&
      withSessionBlock.adjustment.rejectedBars === 0 &&
      withSessionBlock.adjustment.coveragePct === 100 &&
      withoutSessionBlock.length === 4 &&
      withoutSessionBlock.adjustment.excludedInProgressSessionBars === 0 &&
      withoutSessionBlock.adjustment.invalidRawBars === 1 &&
      withoutSessionBlock.adjustment.rejectedBars === 1
    results.push({
      name: 'the bar for a session still running is excluded, keeping the symbol scoreable',
      passed,
      detail: passed
        ? undefined
        : JSON.stringify({
            withSessionBlock: withSessionBlock.adjustment,
            withoutSessionBlock: withoutSessionBlock.adjustment,
          }),
    })
  }

  {
    const settledRows = [...COMPLETED_ROWS, SETTLED_LAST_ROW]
    const afterClose = parseYahooDailyBars(
      withRegularSession(sessionPayload(settledRows), OPEN_REGULAR_SESSION),
      AFTER_SESSION_MS,
    )
    const beforeOpen = parseYahooDailyBars(
      withRegularSession(sessionPayload(settledRows), OPEN_REGULAR_SESSION),
      BEFORE_SESSION_MS,
    )
    // The closing bell itself is outside the session: the bar it completed is
    // a finished bar.
    const atClosingBell = parseYahooDailyBars(
      withRegularSession(sessionPayload(settledRows), OPEN_REGULAR_SESSION),
      SESSION_END_SECONDS * 1_000,
    )
    const noMetadata = parseYahooDailyBars(sessionPayload(settledRows), AFTER_SESSION_MS)
    const passed =
      afterClose.length === 5 &&
      beforeOpen.length === 5 &&
      atClosingBell.length === 5 &&
      afterClose.adjustment.excludedInProgressSessionBars === 0 &&
      JSON.stringify(afterClose) === JSON.stringify(noMetadata) &&
      JSON.stringify(afterClose.adjustment) === JSON.stringify(noMetadata.adjustment)
    results.push({
      name: 'a closed session leaves the series exactly as it was parsed before',
      passed,
      detail: passed
        ? undefined
        : JSON.stringify({
            afterClose: afterClose.adjustment,
            beforeOpen: beforeOpen.length,
            atClosingBell: atClosingBell.length,
            noMetadata: noMetadata.adjustment,
          }),
    })
  }

  {
    // A halted or stale symbol: the market is open, but this instrument's
    // newest bar is from an earlier day, so nothing about it is in progress.
    const staleBars = parseYahooDailyBars(
      withRegularSession(
        sessionPayload([...COMPLETED_ROWS, SETTLED_LAST_ROW], SESSION_START_SECONDS - 86_400),
        OPEN_REGULAR_SESSION,
      ),
      MID_SESSION_MS,
    )
    const passed =
      staleBars.length === 5 &&
      staleBars[4].date === '2026-08-24' &&
      staleBars.adjustment.excludedInProgressSessionBars === 0 &&
      staleBars.adjustment.sourceRows === 5 &&
      staleBars.adjustment.rejectedBars === 0
    results.push({
      name: 'an open market never costs a halted symbol its newest completed bar',
      passed,
      detail: passed ? undefined : JSON.stringify(staleBars.adjustment),
    })
  }

  {
    const abcbRows = [...COMPLETED_ROWS, IN_PROGRESS_ABCB_ROW]
    const noMeta = parseYahooDailyBars(sessionPayload(abcbRows), MID_SESSION_MS)
    const emptyMeta = parseYahooDailyBars(
      withMeta(sessionPayload(abcbRows), {}),
      MID_SESSION_MS,
    )
    const noTradingPeriod = parseYahooDailyBars(
      withMeta(sessionPayload(abcbRows), { exchangeName: 'NYQ' }),
      MID_SESSION_MS,
    )
    const noRegular = parseYahooDailyBars(
      withMeta(sessionPayload(abcbRows), { currentTradingPeriod: { pre: OPEN_REGULAR_SESSION } }),
      MID_SESSION_MS,
    )
    // Every one of these still sees the in-progress row, so it still fails the
    // OHLC bounds check: missing metadata changes nothing at all.
    const untouched = [noMeta, emptyMeta, noTradingPeriod, noRegular]
    const passed = untouched.every(
      (series) =>
        series.adjustment.excludedInProgressSessionBars === 0 &&
        series.adjustment.sourceRows === 5 &&
        series.adjustment.invalidRawBars === 1,
    )
    results.push({
      name: 'a response without session metadata keeps every row it came with',
      passed,
      detail: passed
        ? undefined
        : JSON.stringify(untouched.map((series) => series.adjustment)),
    })
  }

  {
    // The data-loss case, stated on its own because it is the one that costs a
    // real bar rather than merely failing to drop one. Every row here is a
    // finished session and the newest is days old, so nothing may be excluded
    // no matter what the session block claims.
    const settled = sessionPayload(
      [...COMPLETED_ROWS, SETTLED_LAST_ROW],
      SESSION_START_SECONDS - 5 * 86_400,
    )
    const series = parseYahooDailyBars(
      withRegularSession(settled, { start: 0, end: SESSION_END_SECONDS }),
      MID_SESSION_MS,
    )
    const passed =
      series.adjustment.excludedInProgressSessionBars === 0 && series.length === 5
    results.push({
      name: 'a degenerate session window never deletes a completed bar',
      passed,
      detail: passed
        ? undefined
        : JSON.stringify({ bars: series.length, adjustment: series.adjustment }),
    })
  }

  {
    const abcbRows = [...COMPLETED_ROWS, IN_PROGRESS_ABCB_ROW]
    const malformedSessions: unknown[] = [
      { start: SESSION_START_SECONDS, end: SESSION_START_SECONDS },
      { start: SESSION_END_SECONDS, end: SESSION_START_SECONDS },
      { start: String(SESSION_START_SECONDS), end: String(SESSION_END_SECONDS) },
      { start: Number.NaN, end: SESSION_END_SECONDS },
      { start: SESSION_START_SECONDS },
      null,
      [SESSION_START_SECONDS, SESSION_END_SECONDS],
      // A degenerate start with a believable end. Without a duration bound this
      // window stretches back to 1970, so a bar that finished days ago reads as
      // "inside the open session" and gets deleted. This is the data-loss case.
      { start: 0, end: SESSION_END_SECONDS },
      { start: -1, end: SESSION_END_SECONDS },
      // Longer than any real trading day: a full 24 hours, and 12h + 1 minute
      // just past the bound.
      { start: SESSION_END_SECONDS - 86_400, end: SESSION_END_SECONDS },
      { start: SESSION_END_SECONDS - (12 * 60 * 60 + 60), end: SESSION_END_SECONDS },
      // Shorter than any real session.
      { start: SESSION_END_SECONDS - 60, end: SESSION_END_SECONDS },
    ]
    const parsed = malformedSessions.map((regular) =>
      parseYahooDailyBars(
        withRegularSession(sessionPayload(abcbRows), regular),
        MID_SESSION_MS,
      ),
    )
    const passed = parsed.every(
      (series) =>
        series.adjustment.excludedInProgressSessionBars === 0 &&
        series.adjustment.sourceRows === 5 &&
        series.adjustment.invalidRawBars === 1,
    )
    results.push({
      name: 'malformed session bounds are never read as an open session',
      passed,
      detail: passed ? undefined : JSON.stringify(parsed.map((series) => series.adjustment)),
    })
  }

  return results
}
