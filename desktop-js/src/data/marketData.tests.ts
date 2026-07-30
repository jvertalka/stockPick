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

  return results
}
