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

const DEFAULT_BACKEND = 'http://127.0.0.1:8787'

function backendUrl() {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? DEFAULT_BACKEND
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
  open: number
  high: number
  low: number
  close: number
  volume: number
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

export async function fetchDailyBars(
  ticker: string,
  range: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'max' = '3mo',
): Promise<DailyBar[]> {
  const years = RANGE_YEARS[range] ?? 0.25
  // Anchor period2 to the next UTC midnight so the URL — and therefore
  // the proxy cache key — is stable within a day while still including
  // today's bar.
  const period2 = Math.ceil(Date.now() / 86_400_000) * 86_400
  const period1 = period2 - Math.round(years * 365.25 * 86_400)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div,splits`
  const payload = await safeJson<YahooChartResponse>(proxied(url))
  const result = payload?.chart?.result?.[0]
  const timestamps = result?.timestamp
  const quote = result?.indicators?.quote?.[0]
  if (!timestamps || !quote) return []

  const bars: DailyBar[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i]
    const open = quote.open?.[i]
    const high = quote.high?.[i]
    const low = quote.low?.[i]
    const volume = quote.volume?.[i]
    if (
      close == null ||
      open == null ||
      high == null ||
      low == null ||
      volume == null ||
      !Number.isFinite(close) ||
      !Number.isFinite(open)
    ) {
      continue
    }
    const date = new Date(timestamps[i] * 1000)
    bars.push({
      date: date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
    })
  }
  return bars
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
    ticker,
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
    // Never cache an empty/failed result: a single transient Yahoo failure
    // (common during the 224-ticker burst of a backtest build) would
    // otherwise poison the key for the full TTL — which is exactly how the
    // SPY regime fetch silently returned [] and collapsed every window to
    // low-vol. Empty bar arrays are retried on the next call.
    const isEmptyBars = Array.isArray(value) && value.length === 0
    if (!isEmptyBars) {
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

export async function fetchRiskFreeRate(): Promise<number | null> {
  const apiKey = import.meta.env.VITE_FRED_API_KEY as string | undefined
  if (!apiKey) {
    // Without a FRED key we can't fetch. Honest about that rather than guessing.
    return null
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS1MO&api_key=${apiKey}&file_type=json&limit=10&sort_order=desc`
  const payload = await safeJson<FredResponse>(proxied(url))
  const obs = payload?.observations ?? []
  for (const observation of obs) {
    const value = observation.value
    if (value && value !== '.' && Number.isFinite(Number(value))) {
      // FRED returns rates in percent; convert to decimal
      return Number(value) / 100
    }
  }
  return null
}

export const cachedFetchRiskFreeRate = () =>
  memoize('rfr:DGS1MO', 24 * 60 * 60 * 1000, () => fetchRiskFreeRate())

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
    ticker,
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
