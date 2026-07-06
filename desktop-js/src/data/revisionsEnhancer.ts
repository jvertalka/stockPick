import { kvGet, kvSet } from './storage'
import { providerConfigured } from './providerCapabilities'
import type { RawSignal } from './decisionEngine'

/**
 * Analyst estimate-revisions overlay (Finnhub free tier).
 *
 * Activates the dormant `revisionTrend` and `surpriseMomentum` fields —
 * 2 of the 4 inputs to the engine's growth factor (FACTOR_INPUTS.growth),
 * which sit at neutral 50 with no feed connected. Same playbook that woke
 * up quality/value/growth when EDGAR fundamentals went live: fetch raw
 * data per ticker, reduce to a signal, cross-sectionally percentile-rank,
 * and let scoreUniverse Z-score the 0-100 ranks.
 *
 * Two free-tier endpoints, both real:
 *   - /stock/recommendation : monthly analyst counts (strongBuy..strongSell).
 *     revisionTrend = month-over-month change in consensus (Chan-Jegadeesh-
 *     Lakonishok 1996 revision momentum — the SIGNAL is the change, not the
 *     level). Recommendation revisions are a coarser proxy than dollar EPS-
 *     estimate revisions; honest free starting point.
 *   - /stock/earnings : quarterly actual vs estimate. surpriseMomentum =
 *     mean recent earnings surprise % (Bernard-Thomas 1989 SUE / post-
 *     earnings-announcement drift).
 *
 * The token lives SERVER-SIDE (backend local_secrets.dart `kFinnhubApiKey`
 * or the FINNHUB_TOKEN env var); the proxy injects it toward finnhub.io only.
 * It never enters this bundle. The frontend just checks the backend capability
 * map (providerConfigured('finnhub')) to know whether the feed is live. Free
 * tier is 60 req/min, so fetches are throttled and IDB-cached for 12h.
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
/** Cross-sectional rank needs breadth to mean anything (matches the
 * backend's EDGAR floor). */
const MIN_RANK_BREADTH = 20

function backendUrl(): string {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
}
function proxied(externalUrl: string): string {
  return `${backendUrl()}/proxy?url=${encodeURIComponent(externalUrl)}`
}

export function revisionsConfigured(): boolean {
  return providerConfigured('finnhub')
}

export type RevisionRaw = {
  ticker: string
  /** Consensus change over ~3 months; >0 = analysts upgrading. */
  revisionMomentum: number | null
  /** Mean of recent quarterly surprise %; >0 = beating estimates. */
  surprise: number | null
  asOf: string
}

export type RevisionRanks = Map<
  string,
  { revisionTrend: number; surpriseMomentum: number }
>

type RecRow = {
  period: string
  strongBuy: number
  buy: number
  hold: number
  sell: number
  strongSell: number
}
type EarnRow = { period: string; surprisePercent: number | null }

async function safeJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 9000,
): Promise<T | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', ...headers },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Net consensus on [-2, +2]: strongBuy=+2 … strongSell=-2, analyst-weighted. */
function consensusScore(row: RecRow): number | null {
  const total = row.strongBuy + row.buy + row.hold + row.sell + row.strongSell
  if (total <= 0) return null
  return (2 * row.strongBuy + row.buy - row.sell - 2 * row.strongSell) / total
}

/** Return the IDB-cached raw if still fresh, else null — no network. Lets
 * the caller seed instant signal on repeat sessions and throttle only the
 * genuinely uncached names. */
export async function getCachedRevisionRaw(
  ticker: string,
): Promise<RevisionRaw | null> {
  const cached = await kvGet<RevisionRaw>(`finnhub:rev:${ticker}`)
  if (cached && Date.now() - new Date(cached.asOf).getTime() < CACHE_TTL_MS) {
    return cached
  }
  return null
}

export async function fetchRevisionRaw(
  ticker: string,
): Promise<RevisionRaw> {
  const fresh = await getCachedRevisionRaw(ticker)
  if (fresh) return fresh
  const cacheKey = `finnhub:rev:${ticker}`

  const enc = encodeURIComponent(ticker)
  // The Finnhub token is injected by the backend proxy server-side (onto the
  // X-Finnhub-Token header, forwarded to finnhub.io only). It never enters
  // this bundle and never lands in a URL, cache filename, or log line.
  const [rec, earn] = await Promise.all([
    safeJson<RecRow[]>(
      proxied(`${FINNHUB_BASE}/stock/recommendation?symbol=${enc}`),
    ),
    safeJson<EarnRow[]>(
      proxied(`${FINNHUB_BASE}/stock/earnings?symbol=${enc}`),
    ),
  ])

  // Sort newest-first DEFENSIVELY by period — never assume Finnhub's order.
  // If the endpoint ever returned oldest-first, an unsorted consensus
  // delta would flip SIGN (revision momentum → anti-momentum, pushing the
  // growth factor exactly backwards) and the surprise slice would take the
  // oldest quarters. The period field is a sortable YYYY-MM-DD date.
  if (rec) rec.sort((a, b) => b.period.localeCompare(a.period))
  if (earn) earn.sort((a, b) => b.period.localeCompare(a.period))

  // Revision momentum: consensus now minus consensus ~3 months back.
  let revisionMomentum: number | null = null
  if (rec && rec.length >= 2) {
    const current = consensusScore(rec[0])
    const backIndex = Math.min(3, rec.length - 1)
    const past = consensusScore(rec[backIndex])
    if (current != null && past != null) revisionMomentum = current - past
  }

  // Surprise momentum: MEDIAN of the last 4 quarters' surprise %, each
  // winsorized to ±50%. surprisePercent = surprise/estimate explodes when
  // the estimate is near zero (a penny beat on a $0.01 estimate reads as
  // +1000%+), so a raw mean would let one near-zero-denominator quarter
  // dominate and spuriously top the cross-sectional rank. Winsorizing
  // kills the artifact; the median is robust to a single blow-up quarter.
  let surprise: number | null = null
  if (earn && earn.length > 0) {
    const recent = earn
      .slice(0, 4)
      .map((e) => e.surprisePercent)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      .map((v) => Math.max(-50, Math.min(50, v)))
    if (recent.length > 0) {
      const sorted = [...recent].sort((a, b) => a - b)
      surprise = sorted[Math.floor(sorted.length / 2)]
    }
  }

  const result: RevisionRaw = {
    ticker,
    revisionMomentum,
    surprise,
    asOf: new Date().toISOString(),
  }
  // Cache only when BOTH endpoints returned a real HTTP body (an empty
  // array is genuine "no analyst coverage" and SHOULD be cached). A null
  // means a transport failure — 429 rate-limit, bad token, or timeout —
  // which is NOT a no-data name; caching it would pin the ticker to
  // neutral 50 for 12h and never retry. The first warm of a cold universe
  // is exactly when the rate ceiling gets brushed, so this matters. On
  // failure we still return the partial signal for THIS session but leave
  // the cache empty so the next session retries.
  if (rec !== null && earn !== null) {
    await kvSet(cacheKey, result)
  }
  return result
}

/**
 * Throttled batch fetch respecting Finnhub free tier (60 req/min, and
 * each ticker is 2 calls). Default ~3 tickers / 7s ≈ 50 calls/min. IDB
 * cache absorbs repeat sessions, so the slow warm happens at most once
 * per 12h.
 */
export async function fetchRevisionsBatched(
  tickers: string[],
  onProgress?: (done: number, total: number) => void,
  batchSize = 3,
  delayMs = 7000,
): Promise<Map<string, RevisionRaw>> {
  const out = new Map<string, RevisionRaw>()
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map((t) => fetchRevisionRaw(t).catch(() => null)),
    )
    results.forEach((r) => {
      if (r) out.set(r.ticker, r)
    })
    onProgress?.(Math.min(i + batchSize, tickers.length), tickers.length)
    if (i + batchSize < tickers.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return out
}

/** Mid-rank percentiles on [0, 100]; empty below the breadth floor. */
function percentileRanks(pairs: Array<[string, number]>): Map<string, number> {
  const out = new Map<string, number>()
  if (pairs.length < MIN_RANK_BREADTH) return out
  const sorted = [...pairs].sort((a, b) => a[1] - b[1])
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++
    const pct = ((i + j) / 2 / (sorted.length - 1)) * 100
    for (let k = i; k <= j; k++) out.set(sorted[k][0], pct)
    i = j + 1
  }
  return out
}

/** Cross-sectionally rank raw revision/surprise into 0-100; names with no
 * data (or below the breadth floor) get neutral 50 — never simulated. */
export function rankRevisions(raws: Map<string, RevisionRaw>): RevisionRanks {
  const revPairs: Array<[string, number]> = []
  const surPairs: Array<[string, number]> = []
  for (const r of raws.values()) {
    if (r.revisionMomentum != null && Number.isFinite(r.revisionMomentum)) {
      revPairs.push([r.ticker, r.revisionMomentum])
    }
    if (r.surprise != null && Number.isFinite(r.surprise)) {
      surPairs.push([r.ticker, r.surprise])
    }
  }
  const revRank = percentileRanks(revPairs)
  const surRank = percentileRanks(surPairs)
  const out: RevisionRanks = new Map()
  for (const ticker of raws.keys()) {
    out.set(ticker, {
      revisionTrend: revRank.get(ticker) ?? 50,
      surpriseMomentum: surRank.get(ticker) ?? 50,
    })
  }
  return out
}

export function applyRevisionsOverlay(
  signal: RawSignal,
  ranks: { revisionTrend: number; surpriseMomentum: number },
): RawSignal {
  return {
    ...signal,
    revisionTrend: ranks.revisionTrend,
    surpriseMomentum: ranks.surpriseMomentum,
  }
}
