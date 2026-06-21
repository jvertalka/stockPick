/**
 * Probability calibration + position sizing.
 *
 * The model emits a relative-return score; nothing downstream is a calibrated
 * probability, and the conformal intervals never size a position. This module:
 *   - isotonicRegression / applyIsotonic — map the raw score to a calibrated
 *     P(outperform) via the pool-adjacent-violators algorithm (a monotone,
 *     non-parametric fit; Zadrozny-Elkan 2002, Niculescu-Mizil-Caruana 2005).
 *   - brierScore — proper scoring rule to verify the calibration helps.
 *   - fractionalKelly — continuous-Kelly position weight f = λ·μ/σ² from an
 *     expected edge μ and its uncertainty σ (Kelly 1956; fractional λ and a cap
 *     for the well-known full-Kelly over-betting risk, MacLean-Thorp-Ziemba 2010).
 *
 * All pure; unit-tested in calibration.tests.ts.
 */

export type IsotonicFit = { x: number[]; y: number[] }

/**
 * Isotonic (monotone non-decreasing) regression by Pool Adjacent Violators.
 * Returns knots (sorted x, non-decreasing fitted y) defining a piecewise-linear
 * calibration curve. y are typically {0,1} outcomes → fitted y is P(outcome=1).
 */
export function isotonicRegression(x: number[], y: number[]): IsotonicFit {
  const n = x.length
  if (n === 0) return { x: [], y: [] }
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b])
  const xs = order.map((i) => x[i])
  const ys = order.map((i) => y[i])
  // PAVA blocks: pooled value + member count.
  const val: number[] = []
  const cnt: number[] = []
  for (let i = 0; i < n; i++) {
    let v = ys[i]
    let c = 1
    while (val.length > 0 && val[val.length - 1] > v) {
      const pv = val.pop()!
      const pc = cnt.pop()!
      v = (pv * pc + v * c) / (pc + c)
      c = pc + c
    }
    val.push(v)
    cnt.push(c)
  }
  // Expand blocks back to per-point fitted values (non-decreasing), so the
  // knots keep each block's full x-range — interpolating between block right
  // edges alone would wrongly slope through a flat pooled block.
  const fitted: number[] = []
  for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]; k++) fitted.push(val[b])
  return { x: xs, y: fitted }
}

/** Evaluate the isotonic fit at `value` (clamped at the ends, linear between
 * knots). Empty fit → 0.5 (no information). */
export function applyIsotonic(fit: IsotonicFit, value: number): number {
  const { x, y } = fit
  if (x.length === 0) return 0.5
  if (value <= x[0]) return y[0]
  if (value >= x[x.length - 1]) return y[y.length - 1]
  // binary search for the bracket
  let lo = 0
  let hi = x.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (x[mid] <= value) lo = mid
    else hi = mid
  }
  const span = x[hi] - x[lo]
  if (span <= 0) return y[lo]
  const t = (value - x[lo]) / span
  return y[lo] + t * (y[hi] - y[lo])
}

/** Mean squared error between predicted probabilities and {0,1} outcomes.
 * Lower is better; a base-rate-constant forecaster scores p(1-p). */
export function brierScore(probs: number[], outcomes: number[]): number {
  const n = probs.length
  if (n === 0) return Number.NaN
  let s = 0
  for (let i = 0; i < n; i++) s += (probs[i] - outcomes[i]) ** 2
  return s / n
}

/**
 * Fractional-Kelly weight for an expected edge `mu` (e.g. expected relative
 * return) with uncertainty `sigma`. f = clamp(λ·μ/σ², -cap, +cap). λ<1 (e.g.
 * 0.5 = half-Kelly) guards against the full-Kelly over-bet; cap bounds a single
 * name's weight. Sign carries the direction (long if μ>0, short if μ<0).
 */
export function fractionalKelly(mu: number, sigma: number, lambda = 0.5, cap = 1): number {
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) return 0
  const f = (lambda * mu) / (sigma * sigma)
  return Math.max(-cap, Math.min(cap, f))
}
