/**
 * Direct market-data fetchers, routed through the backend cache's
 * /proxy?url= endpoint for CORS safety + TTL caching.
 *
 * The backend allowlists Yahoo Finance, GDELT, and SEC EDGAR. We call
 * each provider directly with their public API, but every request is
 * pinned through the proxy so we get cached responses across reloads.
 *
 * Each fetcher fails soft: a provider outage returns null/empty, never
 * throws to the caller.
 */

import { loadProviderCapabilities } from './providerCapabilities'

const DEFAULT_BACKEND = 'http://127.0.0.1:8787'

function backendUrl() {
  return import.meta.env?.VITE_ORACLE_BACKEND_URL ?? DEFAULT_BACKEND
}

function proxied(externalUrl: string) {
  return `${backendUrl()}/proxy?url=${encodeURIComponent(externalUrl)}`
}

async function safeJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/* =========================================================================
   Yahoo Finance — daily bars for the price chart
   ========================================================================= */
export type DailyBar = {
  date: string
  /**
   * Split- and distribution-adjusted OHLC used by every return/model path.
   * Yahoo supplies the total-return close in indicators.adjclose; the same
   * per-day factor is applied to O/H/L so the bar remains internally
   * consistent across splits and cash distributions.
   */
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** Raw exchange-price fields retained for execution/live-price display. */
  rawOpen?: number
  rawHigh?: number
  rawLow?: number
  rawClose?: number
  adjustmentFactor?: number
  priceBasis?: 'adjusted-total-return'
  adjustmentSource?: 'yahoo-chart-adjclose'
}

async function safeJsonWithCacheState<T>(
  url: string,
  timeoutMs = 8000,
): Promise<{ payload: T; cacheState: string } | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    return {
      payload: (await response.json()) as T,
      cacheState: response.headers.get('X-Finance-Oracle-Cache') ?? 'UNKNOWN',
    }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

export type DailyBarAdjustmentSummary = {
  priceBasis: 'adjusted-total-return'
  source: 'yahoo-chart-adjclose'
  sourceField: 'chart.result[0].indicators.adjclose[0].adjclose'
  /** Timestamped rows returned by Yahoo before any local validation. */
  sourceRows: number
  /** Source rows rejected because timestamp or raw OHLCV was invalid/missing. */
  invalidRawBars: number
  eligibleRawBars: number
  adjustedBars: number
  missingAdjustedBars: number
  /** All rejected source rows, including invalid raw data and missing adjclose. */
  rejectedBars: number
  coveragePct: number
}

/** Array-compatible result with auditable Yahoo adjustment coverage. */
export type DailyBarSeries = DailyBar[] & {
  adjustment: DailyBarAdjustmentSummary
}

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
          volume?: Array<number | null>
        }>
        adjclose?: Array<{
          adjclose?: Array<number | null>
        }>
      }
    }>
    error?: { code?: string; description?: string } | null
  }
}

/** Years of history per range token. Yahoo SILENTLY DOWNGRADES the
 * interval for long named ranges (range=max&interval=1d returns ~monthly
 * bars), so all fetches use explicit period1/period2 epochs instead —
 * those keep true daily granularity back decades. */
const RANGE_YEARS: Record<string, number> = {
  '1mo': 1 / 12,
  '3mo': 0.25,
  '6mo': 0.5,
  '1y': 1,
  '2y': 2,
  '5y': 5,
  '10y': 10,
  max: 40,
}

function withAdjustmentSummary(
  bars: DailyBar[],
  sourceRows: number,
  eligibleRawBars: number,
  invalidRawBars: number,
): DailyBarSeries {
  const adjustedBars = bars.length
  return Object.assign(bars, {
    adjustment: {
      priceBasis: 'adjusted-total-return' as const,
      source: 'yahoo-chart-adjclose' as const,
      sourceField: 'chart.result[0].indicators.adjclose[0].adjclose' as const,
      sourceRows,
      invalidRawBars,
      eligibleRawBars,
      adjustedBars,
      missingAdjustedBars: Math.max(0, eligibleRawBars - adjustedBars),
      rejectedBars: Math.max(0, sourceRows - adjustedBars),
      coveragePct: sourceRows > 0 ? (adjustedBars / sourceRows) * 100 : 0,
    },
  })
}

/**
 * Parse Yahoo chart bars fail-closed for research use: a row without a valid
 * adjclose is excluded instead of silently substituting the raw close. The
 * raw fields remain attached to every accepted bar for live-price display.
 */
export function parseYahooDailyBars(payload: YahooChartResponse | null): DailyBarSeries {
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp
  const quote = result?.indicators?.quote?.[0]
  const adjustedCloses = result?.indicators?.adjclose?.[0]?.adjclose
  if (!timestamps || !quote) return withAdjustmentSummary([], 0, 0, 0)

  // Trading-day horizons require a strictly increasing source clock. Do not
  // sort/dedupe locally: either would hide a provider defect and compress the
  // meaning of 20/60/120 observations.
  let previousTimestamp = Number.NEGATIVE_INFINITY
  for (const timestamp of timestamps) {
    if (!Number.isFinite(timestamp) || (timestamp as number) <= previousTimestamp) {
      return withAdjustmentSummary([], timestamps.length, 0, timestamps.length)
    }
    previousTimestamp = timestamp as number
  }

  const bars: DailyBar[] = []
  let eligibleRawBars = 0
  let invalidRawBars = 0
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i]
    const date = new Date((timestamp ?? Number.NaN) * 1000)
    const rawClose = quote.close?.[i]
    const rawOpen = quote.open?.[i]
    const rawHigh = quote.high?.[i]
    const rawLow = quote.low?.[i]
    const volume = quote.volume?.[i]
    if (
      rawClose == null ||
      rawOpen == null ||
      rawHigh == null ||
      rawLow == null ||
      volume == null ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(date.getTime()) ||
      !Number.isFinite(rawClose) ||
      !Number.isFinite(rawOpen) ||
      !Number.isFinite(rawHigh) ||
      !Number.isFinite(rawLow) ||
      !Number.isFinite(volume) ||
      rawOpen <= 0 ||
      rawHigh <= 0 ||
      rawLow <= 0 ||
      rawClose <= 0 ||
      rawHigh < Math.max(rawOpen, rawClose, rawLow) ||
      rawLow > Math.min(rawOpen, rawClose, rawHigh) ||
      volume < 0
    ) {
      invalidRawBars++
      continue
    }
    eligibleRawBars++

    // Yahoo Finance chart API live-data provenance: adjclose is its
    // split-and-cash-distribution-adjusted total-return price series.
    const adjustedClose = adjustedCloses?.[i]
    if (adjustedClose == null || !Number.isFinite(adjustedClose) || adjustedClose <= 0) {
      continue
    }
    const adjustmentFactor = adjustedClose / rawClose
    if (!Number.isFinite(adjustmentFactor) || adjustmentFactor <= 0) continue

    bars.push({
      date: date.toISOString().slice(0, 10),
      open: rawOpen * adjustmentFactor,
      high: rawHigh * adjustmentFactor,
      low: rawLow * adjustmentFactor,
      close: adjustedClose,
      volume,
      rawOpen,
      rawHigh,
      rawLow,
      rawClose,
      adjustmentFactor,
      priceBasis: 'adjusted-total-return',
      adjustmentSource: 'yahoo-chart-adjclose',
    })
  }
  return withAdjustmentSummary(bars, timestamps.length, eligibleRawBars, invalidRawBars)
}

/** Yahoo encodes class-share separators with a dash (BRK-B), while the
 * product keeps the conventional display symbol (BRK.B). */
export function normalizeYahooSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().replaceAll('.', '-').replaceAll('/', '-')
}

export async function fetchDailyBars(
  ticker: string,
  range: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'max' = '3mo',
): Promise<DailyBarSeries> {
  const years = RANGE_YEARS[range] ?? 0.25
  // Anchor period2 to the next UTC midnight so the URL — and therefore
  // the proxy cache key — is stable within a day while still including
  // today's bar.
  const period2 = Math.ceil(Date.now() / 86_400_000) * 86_400
  const period1 = period2 - Math.round(years * 365.25 * 86_400)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    normalizeYahooSymbol(ticker),
  )}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div,splits`
  const payload = await safeJson<YahooChartResponse>(proxied(url))
  return parseYahooDailyBars(payload)
}

/* =========================================================================
   GDELT — recent news per ticker (company name search)
   ========================================================================= */
export type NewsArticle = {
  title: string
  url: string
  source: string
  publishedAt: string
  language?: string
  tone?: number
}

type GdeltDocResponse = {
  articles?: Array<{
    url?: string
    title?: string
    seendate?: string
    domain?: string
    language?: string
    tone?: number | string
  }>
}

export async function fetchNewsForTicker(
  ticker: string,
  companyName: string,
  limit = 8,
): Promise<NewsArticle[]> {
  const query = `("${companyName}" OR "${ticker}")`
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query,
  )}&mode=ArtList&maxrecords=${limit}&format=json&sort=DateDesc`
  const payload = await safeJson<GdeltDocResponse>(proxied(url))
  const articles = payload?.articles
  if (!Array.isArray(articles)) return []
  return articles
    .map((article) => {
      if (!article.title || !article.url) return null
      return {
        title: article.title,
        url: article.url,
        source: article.domain ?? 'unknown',
        publishedAt: parseGdeltDate(article.seendate),
        language: article.language,
        tone: typeof article.tone === 'number' ? article.tone : Number(article.tone) || undefined,
      } as NewsArticle
    })
    .filter((article): article is NewsArticle => article !== null)
}

function parseGdeltDate(seendate?: string): string {
  if (!seendate) return new Date().toISOString()
  // GDELT format: YYYYMMDDTHHMMSSZ
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(seendate)
  if (!match) return new Date().toISOString()
  const [, y, m, d, hh, mm, ss] = match
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`
}

/* =========================================================================
   SEC EDGAR — next-earnings date (8-K + 10-Q filing pattern)
   -------------------------------------------------------------------------
   SEC doesn't expose a forward calendar, but the cadence of 10-Q filings
   gives us a reasonable +90d estimate from the last filing. Yahoo's
   calendar v1 endpoint fills in better when reachable; if both fail we
   return null and the UI just hides the chip.
   ========================================================================= */
export type EarningsEstimate = {
  ticker: string
  nextEarningsDate?: string
  daysUntil?: number
  source: 'yahoo' | 'sec-cadence' | 'none'
}

type YahooQuoteSummary = {
  quoteSummary?: {
    result?: Array<{
      calendarEvents?: {
        earnings?: {
          earningsDate?: Array<{ raw?: number; fmt?: string }>
        }
      }
    }>
    error?: { code?: string } | null
  }
}

export async function fetchNextEarnings(ticker: string): Promise<EarningsEstimate> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    normalizeYahooSymbol(ticker),
  )}?modules=calendarEvents`
  const payload = await safeJson<YahooQuoteSummary>(proxied(url))
  const raw = payload?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]
  if (raw?.raw) {
    const date = new Date(raw.raw * 1000)
    if (!Number.isNaN(date.getTime())) {
      const daysUntil = Math.round((date.getTime() - Date.now()) / 86_400_000)
      return {
        ticker,
        nextEarningsDate: date.toISOString().slice(0, 10),
        daysUntil,
        source: 'yahoo',
      }
    }
  }
  return { ticker, source: 'none' }
}

/* =========================================================================
   Cache keyed by ticker — avoid hammering proxies on every render.
   Each helper memoizes per ticker for the given TTL.
   ========================================================================= */

const cache = new Map<string, { ttl: number; expires: number; value: unknown }>()

function memoize<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const existing = cache.get(key)
  if (existing && existing.expires > now) {
    return Promise.resolve(existing.value as T)
  }
  return factory().then((value) => {
    // Never cache a null/empty failed result: a single transient provider failure
    // (common during the 224-ticker burst of a backtest build) would
    // otherwise poison the key for the full TTL — which is exactly how the
    // SPY regime fetch silently returned [] and collapsed every window to
    // low-vol. Empty bar arrays are retried on the next call.
    const isFailedResult =
      value == null ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' && value !== null && 'stale' in value && value.stale === true)
    if (!isFailedResult) {
      cache.set(key, { ttl: ttlMs, expires: now + ttlMs, value })
    }
    return value
  })
}

export const cachedFetchDailyBars = (ticker: string, range: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'max' = '3mo') =>
  memoize(`bars:${ticker}:${range}`, 5 * 60 * 1000, () => fetchDailyBars(ticker, range))

export const cachedFetchNews = (ticker: string, name: string, limit = 8) =>
  memoize(`news:${ticker}`, 10 * 60 * 1000, () => fetchNewsForTicker(ticker, name, limit))

export const cachedFetchEarnings = (ticker: string) =>
  memoize(`earnings:${ticker}`, 60 * 60 * 1000, () => fetchNextEarnings(ticker))

/* =========================================================================
   FRED — risk-free rate (DGS1MO = 1-month Treasury constant maturity)
   -------------------------------------------------------------------------
   Source: Federal Reserve Bank of St. Louis, https://fred.stlouisfed.org/series/DGS1MO.
   The 1-month T-bill is the standard short-rate proxy for BSM and Kelly.

   Cached for 24 hours since this is a daily-published series.
   ========================================================================= */

type FredObservation = { date?: string; value?: string }
type FredResponse = { observations?: FredObservation[] }

export type RiskFreeRateEvidence = {
  rate: number
  observationDate: string
  ageDays: number
  cacheState: string
  stale: boolean
}

export async function fetchRiskFreeRate(): Promise<RiskFreeRateEvidence | null> {
  const providers = await loadProviderCapabilities()
  if (!providers.fred) return null
  // The local backend injects its server-held key only on the FRED host. The
  // browser bundle and proxy URL/cache key never contain the secret.
  const url = 'https://api.stlouisfed.org/fred/series/observations?series_id=DGS1MO&file_type=json&limit=10&sort_order=desc'
  const result = await safeJsonWithCacheState<FredResponse>(proxied(url))
  const obs = result?.payload.observations ?? []
  for (const observation of obs) {
    const value = observation.value
    const observationDate = observation.date
    if (value && value !== '.' && Number.isFinite(Number(value)) && observationDate) {
      const observedAt = Date.parse(`${observationDate}T00:00:00Z`)
      if (!Number.isFinite(observedAt)) continue
      const ageDays = Math.floor((Date.now() - observedAt) / 86_400_000)
      // FRED returns rates in percent; convert to decimal
      return {
        rate: Number(value) / 100,
        observationDate,
        ageDays,
        cacheState: result?.cacheState ?? 'UNKNOWN',
        // No guessed calendar-age threshold: the proxy knows whether it had
        // to serve beyond its provider-specific TTL. The exact source date
        // and age remain visible even for a cache HIT/MISS.
        stale: ageDays < 0 || result?.cacheState === 'STALE',
      }
    }
  }
  return null
}

export const cachedFetchRiskFreeRate = () =>
  memoize('rfr:DGS1MO', 24 * 60 * 60 * 1000, () => fetchRiskFreeRate())

/** Test isolation for the real recovery path; production code never clears
 * successful values before their evidence-aligned TTL expires. */
export function clearRiskFreeRateCacheForTests(): void {
  cache.delete('rfr:DGS1MO')
}

/* =========================================================================
   Yahoo — per-stock dividend yield from quoteSummary
   -------------------------------------------------------------------------
   Replaces the hardcoded 1.5% so BSM is evaluated with the actual dividend
   yield each stock pays. ETFs and non-payers correctly come back as 0.
   ========================================================================= */

type YahooSummaryDetail = {
  quoteSummary?: {
    result?: Array<{
      summaryDetail?: {
        dividendYield?: { raw?: number }
        trailingAnnualDividendYield?: { raw?: number }
      }
      defaultKeyStatistics?: {
        beta?: { raw?: number }
      }
    }>
  }
}

export type StockFundamentals = {
  ticker: string
  dividendYield: number  // decimal, 0 if not paying
  beta?: number          // CAPM beta vs S&P 500, when Yahoo provides it
  source: 'yahoo' | 'none'
}

export async function fetchStockFundamentals(ticker: string): Promise<StockFundamentals> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    normalizeYahooSymbol(ticker),
  )}?modules=summaryDetail,defaultKeyStatistics`
  const payload = await safeJson<YahooSummaryDetail>(proxied(url))
  const result = payload?.quoteSummary?.result?.[0]
  const detail = result?.summaryDetail
  const stats = result?.defaultKeyStatistics
  const dividendYieldRaw =
    detail?.dividendYield?.raw ?? detail?.trailingAnnualDividendYield?.raw
  const beta = stats?.beta?.raw
  return {
    ticker,
    dividendYield: typeof dividendYieldRaw === 'number' && Number.isFinite(dividendYieldRaw)
      ? dividendYieldRaw
      : 0,
    beta: typeof beta === 'number' && Number.isFinite(beta) ? beta : undefined,
    source: typeof dividendYieldRaw === 'number' ? 'yahoo' : 'none',
  }
}

export const cachedFetchStockFundamentals = (ticker: string) =>
  memoize(`fundamentals:${ticker}`, 24 * 60 * 60 * 1000, () => fetchStockFundamentals(ticker))
