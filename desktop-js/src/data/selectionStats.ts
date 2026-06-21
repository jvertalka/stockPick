/**
 * Selection-inflation statistics — tools to measure how much of a backtest's
 * headline performance is an artifact of searching many features / configs
 * rather than real signal.
 *
 *  - Benjamini-Hochberg FDR control (Benjamini-Hochberg 1995) for the multiple
 *    hypothesis tests implicit in screening a feature zoo.
 *  - Probabilistic & Deflated Sharpe Ratio (Bailey & López de Prado 2014,
 *    "The Deflated Sharpe Ratio", J. Portfolio Management): the PSR adjusts the
 *    Sharpe for sample length + non-normal returns; the DSR additionally
 *    deflates it by the expected MAXIMUM Sharpe achievable across N trials
 *    under the null (true SR = 0), so a strategy that merely won a big search
 *    no longer looks significant.
 *
 * All functions are pure; the math is unit-tested in selectionStats.tests.ts.
 */
import { normalCdf, inverseNormalCdf } from './quantMath'

const EULER_MASCHERONI = 0.5772156649015329

/**
 * Benjamini-Hochberg false-discovery-rate control. Given p-values for m
 * hypotheses and a target FDR q, returns a boolean mask (in the INPUT order)
 * marking which hypotheses are rejected (i.e. discoveries). Controls the
 * expected fraction of false positives among discoveries at q.
 */
export function benjaminiHochberg(pValues: number[], q = 0.1): boolean[] {
  const m = pValues.length
  const reject = new Array<boolean>(m).fill(false)
  if (m === 0) return reject
  // sort indices by p-value ascending
  const order = pValues.map((p, i) => [p, i] as [number, number]).sort((a, b) => a[0] - b[0])
  // largest k with p_(k) <= (k/m) q  (k is 1-based rank)
  let kMax = 0
  for (let rank = 1; rank <= m; rank++) {
    if (order[rank - 1][0] <= (rank / m) * q) kMax = rank
  }
  for (let rank = 1; rank <= kMax; rank++) reject[order[rank - 1][1]] = true
  return reject
}

/**
 * Probabilistic Sharpe Ratio: the probability that the TRUE Sharpe exceeds the
 * benchmark `srStar`, given an observed Sharpe `srHat` over `n` returns with
 * sample skewness `skew` and EXCESS kurtosis `exKurt`. Sharpe must be in the
 * SAME periodicity as `n` (i.e. non-annualized: mean/std of the n returns).
 *
 * PSR = Φ( (srHat − srStar)·√(n−1) / √(1 − skew·srHat + (kurt−1)/4·srHat²) ),
 * where kurt is the FULL kurtosis = exKurt + 3 (Bailey-López de Prado 2014 eq. 3).
 */
export function probabilisticSharpeRatio(
  srHat: number,
  n: number,
  skew: number,
  exKurt: number,
  srStar = 0,
): number {
  if (n < 2) return Number.NaN
  const kurtFull = exKurt + 3
  const denomVar = 1 - skew * srHat + ((kurtFull - 1) / 4) * srHat * srHat
  if (denomVar <= 0) return Number.NaN
  const z = ((srHat - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denomVar)
  return normalCdf(z)
}

/**
 * Expected MAXIMUM Sharpe across `nTrials` independent strategies whose true
 * Sharpe is 0, given the cross-trial variance of the Sharpe estimates `varSr`.
 * This is the benchmark a real strategy must beat (Bailey-López de Prado 2014
 * eq. 5, the order-statistic approximation for the max of N Gaussians):
 *   E[max] ≈ √varSr · [ (1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e)) ],  γ = Euler-Mascheroni.
 */
export function expectedMaxSharpe(nTrials: number, varSr: number): number {
  if (nTrials <= 1 || varSr <= 0) return 0
  const a = inverseNormalCdf(1 - 1 / nTrials)
  const b = inverseNormalCdf(1 - 1 / (nTrials * Math.E))
  return Math.sqrt(varSr) * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b)
}

/**
 * Deflated Sharpe Ratio: PSR evaluated against the expected-max-of-N-trials
 * benchmark instead of 0. DSR > 0.95 ⇒ the observed Sharpe is unlikely to be
 * the lucky best of `nTrials` searches. Returns { sr0, psr0, dsr }.
 */
export function deflatedSharpeRatio(args: {
  srHat: number
  n: number
  skew: number
  exKurt: number
  nTrials: number
  varSrAcrossTrials: number
}): { sr0: number; psr0: number; dsr: number } {
  const { srHat, n, skew, exKurt, nTrials, varSrAcrossTrials } = args
  const sr0 = expectedMaxSharpe(nTrials, varSrAcrossTrials)
  const dsr = probabilisticSharpeRatio(srHat, n, skew, exKurt, sr0)
  const psr0 = probabilisticSharpeRatio(srHat, n, skew, exKurt, 0)
  return { sr0, psr0, dsr }
}
