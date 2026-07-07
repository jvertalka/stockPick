/**
 * Exit-rule event study — pure math (no I/O), unit-testable.
 *
 * The question this answers: when the decision engine FLIPS a name's action
 * (especially a downgrade out of Buy Now/Accumulate), does the name then
 * underperform its peers — i.e. was the flip worth acting on — or is the
 * flip just noise? Entries were validated by the ML walk-forward; the action
 * rules (and exits in particular) never were, until this.
 *
 * Design mirrors the live scorecard's honesty rules:
 *  - Everything is measured RELATIVE to the same-date cross-section, so
 *    market-wide moves cancel and a bear-market "sell everything" day can't
 *    fake exit skill.
 *  - Confidence intervals bootstrap over DATES (cluster bootstrap), not over
 *    individual events — events on the same day share the market and are not
 *    independent samples.
 */

export type StudyAction =
  | 'Buy Now'
  | 'Accumulate'
  | 'Hold'
  | 'Watch'
  | 'Trim'
  | 'Sell'
  | 'Avoid'

/** One sampled date's engine output for one ticker. */
export type StudySample = {
  ticker: string
  action: StudyAction
  lastPrice: number
}

/** Per sampled date: map ticker → sample. Dates ascending. */
export type StudyDate = {
  date: string
  byTicker: Map<string, StudySample>
}

const BULLISH = new Set<StudyAction>(['Buy Now', 'Accumulate'])
const BEARISH = new Set<StudyAction>(['Trim', 'Sell', 'Avoid'])

export function sideOf(action: StudyAction): 'bullish' | 'bearish' | 'neutral' {
  if (BULLISH.has(action)) return 'bullish'
  if (BEARISH.has(action)) return 'bearish'
  return 'neutral'
}

export type TransitionKind =
  | 'exit'            // bullish -> bearish (the flip the user would SELL on)
  | 'soften'          // bullish -> neutral
  | 'entry'           // neutral|bearish -> bullish
  | 'warn'            // neutral -> bearish
  | 'stay-bullish'
  | 'stay-neutral'
  | 'stay-bearish'
  | 'other'

export function classifyTransition(from: StudyAction, to: StudyAction): TransitionKind {
  const a = sideOf(from)
  const b = sideOf(to)
  if (a === b) {
    if (a === 'bullish') return 'stay-bullish'
    if (a === 'bearish') return 'stay-bearish'
    return 'stay-neutral'
  }
  if (a === 'bullish' && b === 'bearish') return 'exit'
  if (a === 'bullish' && b === 'neutral') return 'soften'
  if (b === 'bullish') return 'entry'
  if (a === 'neutral' && b === 'bearish') return 'warn'
  return 'other'
}

export type StudyEvent = {
  ticker: string
  date: string          // the date the new action was first seen
  dateIndex: number
  from: StudyAction
  to: StudyAction
  kind: TransitionKind
  /** Relative forward returns (%, demeaned vs the same-date cross-section),
   * keyed by horizon in sampled steps (1 step = one sampling interval). */
  relForward: Record<number, number | null>
}

/**
 * Forward return for a ticker from date index i over `steps` sampling
 * intervals, from the SAME lastPrice series the signals were built on.
 * Null when the ticker is absent at either end or prices are unusable.
 */
export function forwardReturnPct(
  dates: StudyDate[],
  ticker: string,
  fromIndex: number,
  steps: number,
): number | null {
  const start = dates[fromIndex]?.byTicker.get(ticker)
  const end = dates[fromIndex + steps]?.byTicker.get(ticker)
  if (!start || !end) return null
  if (!(start.lastPrice > 0) || !(end.lastPrice > 0)) return null
  return ((end.lastPrice - start.lastPrice) / start.lastPrice) * 100
}

/**
 * Cross-sectional mean forward return at a date for one horizon — the
 * benchmark every event return is demeaned against. Only names present at
 * both ends count (same filter as the events themselves).
 */
export function crossSectionMeanForward(
  dates: StudyDate[],
  fromIndex: number,
  steps: number,
): number | null {
  const date = dates[fromIndex]
  if (!date) return null
  let sum = 0
  let n = 0
  for (const ticker of date.byTicker.keys()) {
    const r = forwardReturnPct(dates, ticker, fromIndex, steps)
    if (r != null && Number.isFinite(r)) {
      sum += r
      n++
    }
  }
  return n >= 10 ? sum / n : null // too thin a cross-section = no benchmark
}

/**
 * Detect every action transition (and stay) between consecutive sampled
 * dates, and attach demeaned forward returns for the given horizons.
 */
export function detectEvents(
  dates: StudyDate[],
  horizonsInSteps: number[],
): StudyEvent[] {
  const events: StudyEvent[] = []
  // Pre-compute cross-section means per (dateIndex, horizon) — O(dates × names).
  const csMean = new Map<string, number | null>()
  for (let i = 1; i < dates.length; i++) {
    for (const h of horizonsInSteps) {
      csMean.set(`${i}|${h}`, crossSectionMeanForward(dates, i, h))
    }
  }
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1]
    const curr = dates[i]
    for (const [ticker, sample] of curr.byTicker) {
      const before = prev.byTicker.get(ticker)
      if (!before) continue // not evaluable on both dates — no transition
      const kind = classifyTransition(before.action, sample.action)
      const relForward: Record<number, number | null> = {}
      for (const h of horizonsInSteps) {
        const raw = forwardReturnPct(dates, ticker, i, h)
        const mean = csMean.get(`${i}|${h}`) ?? null
        relForward[h] = raw != null && mean != null ? raw - mean : null
      }
      events.push({
        ticker,
        date: curr.date,
        dateIndex: i,
        from: before.action,
        to: sample.action,
        kind,
        relForward,
      })
    }
  }
  return events
}

export type GroupStats = {
  kind: TransitionKind
  horizonSteps: number
  n: number
  dates: number
  meanRelPct: number | null
  medianRelPct: number | null
  /** 95% CI of the mean from a cluster bootstrap over dates. */
  ci95: [number, number] | null
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Deterministic PRNG (mulberry32) so study runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Mean + cluster-bootstrap CI for one transition kind at one horizon.
 * Clusters = event dates: resample DATES with replacement, take all of a
 * sampled date's events each time it is drawn.
 */
export function groupStats(
  events: StudyEvent[],
  kind: TransitionKind,
  horizonSteps: number,
  bootstrapIters = 2000,
  seed = 42,
): GroupStats {
  const byDate = new Map<string, number[]>()
  const all: number[] = []
  for (const e of events) {
    if (e.kind !== kind) continue
    const r = e.relForward[horizonSteps]
    if (r == null || !Number.isFinite(r)) continue
    all.push(r)
    const arr = byDate.get(e.date) ?? []
    arr.push(r)
    byDate.set(e.date, arr)
  }
  if (all.length === 0) {
    return { kind, horizonSteps, n: 0, dates: 0, meanRelPct: null, medianRelPct: null, ci95: null }
  }
  const clusters = [...byDate.values()]
  let ci: [number, number] | null = null
  if (clusters.length >= 8) {
    const rand = mulberry32(seed)
    const means: number[] = []
    for (let iter = 0; iter < bootstrapIters; iter++) {
      let sum = 0
      let n = 0
      for (let k = 0; k < clusters.length; k++) {
        const cluster = clusters[Math.floor(rand() * clusters.length)]
        for (const v of cluster) {
          sum += v
          n++
        }
      }
      if (n > 0) means.push(sum / n)
    }
    means.sort((a, b) => a - b)
    ci = [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]]
  }
  return {
    kind,
    horizonSteps,
    n: all.length,
    dates: byDate.size,
    meanRelPct: mean(all),
    medianRelPct: median(all),
    ci95: ci,
  }
}

/** Per exact from→to pair: count + mean 4-step (≈20d) relative return. */
export function pairMatrix(
  events: StudyEvent[],
  horizonSteps: number,
): Array<{ from: StudyAction; to: StudyAction; n: number; meanRelPct: number }> {
  const byPair = new Map<string, number[]>()
  for (const e of events) {
    if (e.from === e.to) continue
    const r = e.relForward[horizonSteps]
    if (r == null || !Number.isFinite(r)) continue
    const key = `${e.from}→${e.to}`
    const arr = byPair.get(key) ?? []
    arr.push(r)
    byPair.set(key, arr)
  }
  return [...byPair.entries()]
    .map(([key, rs]) => {
      const [from, to] = key.split('→') as [StudyAction, StudyAction]
      return { from, to, n: rs.length, meanRelPct: mean(rs) }
    })
    .sort((a, b) => b.n - a.n)
}
