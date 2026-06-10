import type { DecisionSignal } from './decisionEngine'
import type { LivePrediction, RegimeGate } from './mlModelService'
import {
  MARKET_EQUITY_RISK_PREMIUM,
  TOP_QUINTILE_PERCENTILE,
  TRADING_DAYS_PER_YEAR,
} from './quantConfig'

/**
 * Conviction stack — six INDEPENDENT evidence layers per signal.
 *
 * The engine's composite score blends factors into one number, which makes
 * it hard to see HOW MANY independent methods agree. The stack keeps each
 * method as a separate pass/fail vote so a "Buy" backed by five methods is
 * visibly different from a "Buy" backed by one:
 *
 *   1. rules      — cross-sectional composite alpha in the top quintile
 *                   (quintile = the canonical factor-portfolio cut since
 *                   Fama-French 1992)
 *   2. ml         — walk-forward-validated GBT forecasts a positive 20d
 *                   return (Gu-Kelly-Xiu 2020)
 *   3. monteCarlo — GJR-GARCH/HAR-RV Monte Carlo expected return beats the
 *                   equity-premium pace for the horizon (Damodaran implied
 *                   ERP — anything below that pace is beta, not edge)
 *   4. options    — downside-skew pressure NOT in the riskiest quintile;
 *                   high smirk predicts underperformance (Xing-Zhang-Zhao
 *                   2010, JFQA)
 *   5. regime     — the measured ML regime gate is open (see
 *                   quantConfig.ML_REGIME_GATE for the backtest that set it)
 *   6. horizons   — supermajority sign agreement across the multi-horizon
 *                   model ensemble (5/20/60/120d medians)
 *
 * Scoring is a transparent vote count — passed / available — with NO tuned
 * weights. Layers without data report 'unavailable' and shrink the
 * denominator instead of silently passing or failing; fewer than
 * MIN_AVAILABLE_LAYERS measurable layers is labeled insufficient evidence.
 */

export type ConvictionLayerId =
  | 'rules'
  | 'ml'
  | 'monteCarlo'
  | 'options'
  | 'regime'
  | 'horizons'

export type ConvictionLayerStatus = 'pass' | 'fail' | 'unavailable'

export type ConvictionLayer = {
  id: ConvictionLayerId
  label: string
  status: ConvictionLayerStatus
  detail: string
}

export type ConvictionLabel =
  | 'High conviction'
  | 'Solid'
  | 'Mixed'
  | 'Weak'
  | 'Insufficient evidence'

export type ConvictionStack = {
  ticker: string
  layers: ConvictionLayer[]
  passed: number
  available: number
  /** passed / available, 0 when below the evidence floor */
  score: number
  label: ConvictionLabel
  tone: 'positive' | 'neutral' | 'caution' | 'danger'
}

/** Equity-premium pace for a 20-trading-day horizon, in percent.
 * MARKET_EQUITY_RISK_PREMIUM (Damodaran implied ERP, ~5.5%/yr) scaled to
 * 20/252 of a year ≈ 0.44%. A Monte Carlo mean below this is just market
 * beta — it earns no conviction credit. */
export const EQUITY_PREMIUM_PACE_20D_PCT =
  MARKET_EQUITY_RISK_PREMIUM * (20 / TRADING_DAYS_PER_YEAR) * 100

/** Below this many measurable layers the stack can't honestly be called a
 * stack: a single method agreeing with itself is not corroboration. Three
 * is the minimum for a majority to be meaningful. */
export const MIN_AVAILABLE_LAYERS = 3

/** Supermajority fraction for cross-horizon sign agreement (3 of 4 when
 * all horizons are loaded). A bare majority (2 of 4) is a tie. */
const HORIZON_SUPERMAJORITY = 0.75

export function buildConvictionStack(input: {
  signal: DecisionSignal
  mlPrediction: LivePrediction | null
  regimeGate: RegimeGate | null
  /** This name's skewRisk percentile within the scored universe (0-100),
   * null when the universe is too small to rank. */
  skewRiskPercentile: number | null
}): ConvictionStack {
  const { signal, mlPrediction, regimeGate, skewRiskPercentile } = input
  const layers: ConvictionLayer[] = []

  // 1. Rules — top-quintile composite alpha
  const alphaP = signal.alphaPercentile
  layers.push({
    id: 'rules',
    label: 'Rules engine',
    status: alphaP >= TOP_QUINTILE_PERCENTILE ? 'pass' : 'fail',
    detail: `Composite alpha P${Math.round(alphaP)} — needs top quintile (P${TOP_QUINTILE_PERCENTILE}+, Fama-French portfolio convention).`,
  })

  // 2. ML — positive walk-forward GBT forecast
  if (mlPrediction == null) {
    layers.push({
      id: 'ml',
      label: 'ML forecast',
      status: 'unavailable',
      detail: 'No live ML prediction for this name (model not trained or ticker outside the prediction set).',
    })
  } else {
    const ml = mlPrediction.predictedReturn20d
    layers.push({
      id: 'ml',
      label: 'ML forecast',
      status: ml > 0 ? 'pass' : 'fail',
      detail: `GBT 20d forecast ${ml >= 0 ? '+' : ''}${ml.toFixed(2)}%${
        mlPrediction.p10Return20d != null && mlPrediction.p90Return20d != null
          ? ` (80% interval ${mlPrediction.p10Return20d.toFixed(1)}% to ${mlPrediction.p90Return20d.toFixed(1)}%)`
          : ''
      } — regime applicability judged separately in the regime layer.`,
    })
  }

  // 3. Monte Carlo — expected return above equity-premium pace
  if (signal.monteCarloMean == null) {
    layers.push({
      id: 'monteCarlo',
      label: 'Monte Carlo',
      status: 'unavailable',
      detail: 'Quant simulation has not run for this name yet (open the detail panel to trigger it).',
    })
  } else {
    const mc = signal.monteCarloMean
    layers.push({
      id: 'monteCarlo',
      label: 'Monte Carlo',
      status: mc > EQUITY_PREMIUM_PACE_20D_PCT ? 'pass' : 'fail',
      detail: `Simulated 20d mean ${mc >= 0 ? '+' : ''}${mc.toFixed(2)}% vs equity-premium pace +${EQUITY_PREMIUM_PACE_20D_PCT.toFixed(2)}% (Damodaran implied ERP scaled to 20d) — below pace is beta, not edge.`,
    })
  }

  // 4. Options — downside-skew pressure not in the riskiest quintile
  if (skewRiskPercentile == null) {
    layers.push({
      id: 'options',
      label: 'Options skew',
      status: 'unavailable',
      detail: 'Not enough names with skew data to rank this one cross-sectionally.',
    })
  } else {
    layers.push({
      id: 'options',
      label: 'Options skew',
      status: skewRiskPercentile < TOP_QUINTILE_PERCENTILE ? 'pass' : 'fail',
      detail: `Downside-skew pressure P${Math.round(skewRiskPercentile)} of universe — top quintile (P${TOP_QUINTILE_PERCENTILE}+) predicts underperformance (Xing-Zhang-Zhao 2010).`,
    })
  }

  // 5. Regime — measured ML regime gate open
  if (regimeGate == null) {
    layers.push({
      id: 'regime',
      label: 'Regime',
      status: 'unavailable',
      detail: 'Market regime not yet determined (SPY history still loading).',
    })
  } else {
    layers.push({
      id: 'regime',
      label: 'Regime',
      status: regimeGate.gated ? 'fail' : 'pass',
      detail: regimeGate.detail,
    })
  }

  // 6. Horizons — supermajority sign agreement across the model ensemble
  const horizons = mlPrediction?.horizonReturns ?? null
  if (!horizons || horizons.length < 3) {
    layers.push({
      id: 'horizons',
      label: 'Multi-horizon',
      status: 'unavailable',
      detail:
        horizons && horizons.length > 0
          ? `Only ${horizons.length} horizon model(s) loaded — need at least 3 for an agreement vote. Re-run the backtest to train the full ensemble.`
          : 'Horizon ensemble not trained yet — run the walk-forward backtest to persist 5/20/60/120d models.',
    })
  } else {
    const positive = horizons.filter((h) => h.predictedReturnPct > 0).length
    const needed = Math.ceil(horizons.length * HORIZON_SUPERMAJORITY)
    const summary = horizons
      .map(
        (h) =>
          `${h.horizon}d ${h.predictedReturnPct >= 0 ? '+' : ''}${h.predictedReturnPct.toFixed(1)}%`,
      )
      .join(', ')
    layers.push({
      id: 'horizons',
      label: 'Multi-horizon',
      status: positive >= needed ? 'pass' : 'fail',
      detail: `${positive}/${horizons.length} horizon medians positive (${summary}) — supermajority (${needed}+) required.`,
    })
  }

  const available = layers.filter((l) => l.status !== 'unavailable').length
  const passed = layers.filter((l) => l.status === 'pass').length
  const score = available >= MIN_AVAILABLE_LAYERS ? passed / available : 0

  let label: ConvictionLabel
  let tone: ConvictionStack['tone']
  if (available < MIN_AVAILABLE_LAYERS) {
    label = 'Insufficient evidence'
    tone = 'neutral'
  } else if (passed >= 5 && available >= 5) {
    // Nearly every method measured AND nearly every method agreeing.
    label = 'High conviction'
    tone = 'positive'
  } else if (score >= 2 / 3) {
    label = 'Solid'
    tone = 'positive'
  } else if (score >= 1 / 3) {
    label = 'Mixed'
    tone = 'caution'
  } else {
    label = 'Weak'
    tone = 'danger'
  }

  return { ticker: signal.ticker, layers, passed, available, score, label, tone }
}

/**
 * Build stacks for a whole scored universe. Skew percentiles are ranked
 * cross-sectionally against the same universe (mid-rank ties).
 */
export function buildConvictionStacks(
  universe: DecisionSignal[],
  mlPredictions: Map<string, LivePrediction>,
  regimeGate: RegimeGate | null,
): Map<string, ConvictionStack> {
  const skewPercentiles = percentileRanks(
    universe.map((signal) => [signal.ticker, signal.skewRisk]),
  )
  const out = new Map<string, ConvictionStack>()
  for (const signal of universe) {
    out.set(
      signal.ticker,
      buildConvictionStack({
        signal,
        mlPrediction: mlPredictions.get(signal.ticker) ?? null,
        regimeGate,
        skewRiskPercentile: skewPercentiles.get(signal.ticker) ?? null,
      }),
    )
  }
  return out
}

/** Sort comparator: most corroborated first (passed desc, then pass-rate,
 * then opportunity score as the tiebreak). */
export function compareByConviction(
  stacks: Map<string, ConvictionStack>,
): (a: DecisionSignal, b: DecisionSignal) => number {
  return (a, b) => {
    const sa = stacks.get(a.ticker)
    const sb = stacks.get(b.ticker)
    const passedDiff = (sb?.passed ?? 0) - (sa?.passed ?? 0)
    if (passedDiff !== 0) return passedDiff
    const scoreDiff = (sb?.score ?? 0) - (sa?.score ?? 0)
    if (scoreDiff !== 0) return scoreDiff
    return b.opportunityScore - a.opportunityScore
  }
}

/** Mid-rank percentiles on [0, 100]; needs at least 20 names (same
 * cross-sectional breadth floor the backend uses) to mean anything. */
function percentileRanks(
  pairs: Array<[string, number]>,
): Map<string, number> {
  const out = new Map<string, number>()
  if (pairs.length < 20) return out
  const sorted = [...pairs].sort((a, b) => a[1] - b[1])
  let index = 0
  while (index < sorted.length) {
    let j = index
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[index][1]) j++
    const pct = ((index + j) / 2 / (sorted.length - 1)) * 100
    for (let k = index; k <= j; k++) out.set(sorted[k][0], pct)
    index = j + 1
  }
  return out
}
