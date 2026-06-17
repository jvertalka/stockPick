import type { RawSignal } from './decisionEngine'
import { fetchOptionsSnapshot, type OptionsSnapshot } from './optionsAdapter'

/**
 * Overlays a Tradier (or other provider) options snapshot onto a
 * rawSignal so the engine's scoreUniverse computes Buy/Hold/Sell using
 * REAL implied vol + skew instead of the price-derived proxies that
 * ship in the backend payload.
 *
 * Only the fields we have ground truth for are overwritten:
 *   - impliedVolRank: directly from snapshot
 *   - skewRisk:       derived from 25-delta put skew (vol pts)
 *   - eventRisk:      lifted when put/call OI ratio is extreme
 *
 * Crowding, drawdownRisk, and realizedVol stay as-is — they're price-
 * derived signals that don't have a clean options counterpart.
 */

export function applyOptionsOverlay(
  signal: RawSignal,
  snapshot: OptionsSnapshot,
): RawSignal {
  const next: RawSignal = { ...signal }

  // Implied vol rank: snapshot is already 0-100 from the adapter
  next.impliedVolRank = clamp(snapshot.impliedVolRank)

  // 25-delta put skew → 0-100 risk score.
  // Vol-point ranges (rough heuristic from equity options tape):
  //   ≤ 0    : flat / inverted  → 30 (low concern)
  //   2 vol pts : healthy normal → 50
  //   5 vol pts : elevated       → 70
  //   8+ vol pts: hedging panic  → 85+
  const skewBase = 50 + snapshot.put25DeltaSkew * 4
  next.skewRisk = clamp(skewBase)

  // Put/call OI ratio: > 1.5 means heavy put positioning (bearish), < 0.5
  // means call dominance (bullish or speculative). Both extremes raise
  // event risk; neutral 0.5-1.5 leaves it alone.
  if (snapshot.putCallOiRatio != null) {
    const ratio = snapshot.putCallOiRatio
    if (ratio > 1.5) {
      next.eventRisk = clamp(Math.max(signal.eventRisk, 60 + (ratio - 1.5) * 12))
    } else if (ratio < 0.5) {
      next.eventRisk = clamp(Math.max(signal.eventRisk, 55 + (0.5 - ratio) * 20))
    }
  }

  return next
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Picks which tickers to enhance. We can't blast 250 chains at the
 * Tradier free tier (60 req/min, 3 calls per ticker), so we prioritize
 * what the user is most likely to look at:
 *
 *   1. Owned positions (always, capped at 12)
 *   2. Watchlist names (next 4)
 *   3. Top buy candidates from the universe (filling the rest up to 20)
 *
 * Returns a deduped, ordered list.
 */
export function pickTickersToEnhance(
  rankedUniverse: ReadonlyArray<RawSignal & { action?: string; opportunityScore?: number }>,
  ownedTickers: Set<string>,
  watchTickers: Set<string>,
  budget = 20,
): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()

  function push(ticker: string) {
    if (seen.has(ticker)) return
    if (ordered.length >= budget) return
    seen.add(ticker)
    ordered.push(ticker)
  }

  // 1. Owned (capped at 12 of the budget)
  const ownedRows = rankedUniverse.filter((row) => ownedTickers.has(row.ticker))
  ownedRows.slice(0, Math.min(12, budget)).forEach((row) => push(row.ticker))

  // 2. Watchlist (next 4)
  const watchRows = rankedUniverse.filter(
    (row) => watchTickers.has(row.ticker) && !ownedTickers.has(row.ticker),
  )
  watchRows.slice(0, 4).forEach((row) => push(row.ticker))

  // 3. Top buy candidates from anywhere else
  const buyRows = rankedUniverse.filter(
    (row) =>
      !ownedTickers.has(row.ticker) &&
      !watchTickers.has(row.ticker) &&
      (row.action === 'Buy Now' || row.action === 'Accumulate'),
  )
  buyRows.forEach((row) => push(row.ticker))

  return ordered
}

/**
 * Fetches snapshots for the given tickers in rate-limited batches.
 * Tradier free tier is ~60 req/min; each ticker = 3 calls. Batch of 5
 * tickers = 15 calls per second, well under the limit, and the adapter
 * has its own 5-min cache so subsequent refreshes mostly hit cache.
 */
export async function fetchSnapshotsBatched(
  tickers: string[],
  onTickerFetched?: (ticker: string, snapshot: OptionsSnapshot | null) => void,
  batchSize = 5,
  delayMs = 1000,
): Promise<Map<string, OptionsSnapshot>> {
  const results = new Map<string, OptionsSnapshot>()
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map((ticker) =>
        fetchOptionsSnapshot(ticker)
          .then((value) => ({ ticker, value }))
          .catch(() => ({ ticker, value: null as OptionsSnapshot | null })),
      ),
    )
    batchResults.forEach(({ ticker, value }) => {
      if (value) results.set(ticker, value)
      onTickerFetched?.(ticker, value)
    })
    if (i + batchSize < tickers.length) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  return results
}
