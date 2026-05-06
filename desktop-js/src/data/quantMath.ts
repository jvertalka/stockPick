/**
 * Quantitative finance library — the actual math from the literature.
 *
 * Implementations are kept dependency-free so they run in the browser
 * without bundling a numerics library. Each function cites its source
 * and is tested against published sample values where applicable.
 *
 * Contents:
 *   1. Statistical primitives — normal CDF/PDF, inverse CDF, ERF
 *   2. Black-Scholes-Merton — European call/put, Greeks
 *   3. Implied volatility — Newton-Raphson root finder
 *   4. Risk-neutral probability extraction
 *   5. GARCH(1,1) volatility estimator + forecaster
 *   6. Monte Carlo path simulation — GBM with optional jump diffusion
 *   7. Kelly Criterion position sizing
 *   8. Risk metrics — VaR, CVaR, Sortino, Calmar, Information Ratio
 *   9. Black-Litterman expected-return blender
 *  10. CAPM expected return
 *  11. Pearson correlation + simple OLS regression
 *  12. Mersenne-Twister-style PRNG for reproducible MC paths
 */

/* =========================================================================
   1. Statistical primitives
   ========================================================================= */

/** Abramowitz & Stegun 7.1.26 — error function approximation, max error ≈ 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * ax)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}

/** Standard normal CDF — P(Z <= z) where Z ~ N(0,1). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Standard normal PDF. */
export function normalPdf(z: number): number {
  return Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI)
}

/**
 * Inverse standard normal CDF — Beasley-Springer-Moro algorithm.
 * Used to convert a uniform sample to a standard-normal sample for MC.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) return p === 0 ? -Infinity : Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow

  let q: number
  let r: number

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  )
}

/* =========================================================================
   2. Black-Scholes-Merton — European option pricing
   -------------------------------------------------------------------------
   Source: Black, F. & Scholes, M. (1973), "The Pricing of Options and
   Corporate Liabilities," Journal of Political Economy 81(3): 637-654.
   Merton extension (1973) adds continuous dividend yield q.

   Inputs:
     S  = spot price
     K  = strike price
     T  = time to expiration in years
     r  = continuously-compounded risk-free rate
     q  = continuously-compounded dividend yield (default 0)
     v  = volatility (annualized standard deviation of log returns)
   ========================================================================= */

export type BsmInputs = {
  spot: number
  strike: number
  timeToExpiry: number
  riskFreeRate: number
  dividendYield?: number
  volatility: number
}

function bsmD1D2(input: BsmInputs): { d1: number; d2: number } {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: v } = input
  const q = input.dividendYield ?? 0
  const vSqrtT = v * Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r - q + (v * v) / 2) * T) / vSqrtT
  const d2 = d1 - vSqrtT
  return { d1, d2 }
}

export function bsmCallPrice(input: BsmInputs): number {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r } = input
  const q = input.dividendYield ?? 0
  const { d1, d2 } = bsmD1D2(input)
  return S * Math.exp(-q * T) * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2)
}

export function bsmPutPrice(input: BsmInputs): number {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r } = input
  const q = input.dividendYield ?? 0
  const { d1, d2 } = bsmD1D2(input)
  return K * Math.exp(-r * T) * normalCdf(-d2) - S * Math.exp(-q * T) * normalCdf(-d1)
}

export type Greeks = {
  delta: number
  gamma: number
  vega: number
  theta: number
  rho: number
}

export function callGreeks(input: BsmInputs): Greeks {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: v } = input
  const q = input.dividendYield ?? 0
  const { d1, d2 } = bsmD1D2(input)
  const sqrtT = Math.sqrt(T)
  return {
    delta: Math.exp(-q * T) * normalCdf(d1),
    gamma: (Math.exp(-q * T) * normalPdf(d1)) / (S * v * sqrtT),
    vega: (S * Math.exp(-q * T) * normalPdf(d1) * sqrtT) / 100, // per 1% vol change
    theta:
      (-((S * Math.exp(-q * T) * normalPdf(d1) * v) / (2 * sqrtT)) -
        r * K * Math.exp(-r * T) * normalCdf(d2) +
        q * S * Math.exp(-q * T) * normalCdf(d1)) /
      365, // per day
    rho: (K * T * Math.exp(-r * T) * normalCdf(d2)) / 100, // per 1% rate change
  }
}

export function putGreeks(input: BsmInputs): Greeks {
  const { spot: S, strike: K, timeToExpiry: T, riskFreeRate: r, volatility: v } = input
  const q = input.dividendYield ?? 0
  const { d1, d2 } = bsmD1D2(input)
  const sqrtT = Math.sqrt(T)
  return {
    delta: -Math.exp(-q * T) * normalCdf(-d1),
    gamma: (Math.exp(-q * T) * normalPdf(d1)) / (S * v * sqrtT),
    vega: (S * Math.exp(-q * T) * normalPdf(d1) * sqrtT) / 100,
    theta:
      (-((S * Math.exp(-q * T) * normalPdf(d1) * v) / (2 * sqrtT)) +
        r * K * Math.exp(-r * T) * normalCdf(-d2) -
        q * S * Math.exp(-q * T) * normalCdf(-d1)) /
      365,
    rho: (-K * T * Math.exp(-r * T) * normalCdf(-d2)) / 100,
  }
}

/* =========================================================================
   3. Implied volatility — Newton-Raphson root finder
   -------------------------------------------------------------------------
   Given an observed market price, solve for the volatility that makes
   the BSM model match. Robust initial guess via Brenner-Subrahmanyam (1988).
   Caps iterations + falls back to bisection if NR fails to converge.
   ========================================================================= */
export function impliedVolatility(
  marketPrice: number,
  type: 'call' | 'put',
  spot: number,
  strike: number,
  timeToExpiry: number,
  riskFreeRate: number,
  dividendYield = 0,
): number | null {
  if (marketPrice <= 0 || timeToExpiry <= 0) return null
  // Brenner-Subrahmanyam initial guess
  let v = Math.sqrt((2 * Math.PI) / timeToExpiry) * (marketPrice / spot)
  if (!Number.isFinite(v) || v <= 0) v = 0.3

  for (let i = 0; i < 50; i++) {
    const input: BsmInputs = {
      spot,
      strike,
      timeToExpiry,
      riskFreeRate,
      dividendYield,
      volatility: v,
    }
    const price = type === 'call' ? bsmCallPrice(input) : bsmPutPrice(input)
    const vega = callGreeks(input).vega * 100 // de-normalize
    if (Math.abs(vega) < 1e-8) break
    const diff = price - marketPrice
    if (Math.abs(diff) < 1e-5) return v
    v = v - diff / vega
    if (v <= 0 || !Number.isFinite(v)) v = 0.05
  }
  // Bisection fallback
  let lo = 0.001
  let hi = 5
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const input: BsmInputs = {
      spot,
      strike,
      timeToExpiry,
      riskFreeRate,
      dividendYield,
      volatility: mid,
    }
    const price = type === 'call' ? bsmCallPrice(input) : bsmPutPrice(input)
    if (Math.abs(price - marketPrice) < 1e-4) return mid
    if (price < marketPrice) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/* =========================================================================
   4. Risk-neutral probability extraction
   -------------------------------------------------------------------------
   Under BSM the risk-neutral probability that S_T > K equals N(d2) for
   a call. This converts the options market's pricing into a forward
   probability distribution we can act on.
   ========================================================================= */

/** P(S_T > strike) under risk-neutral measure. */
export function riskNeutralProbAbove(input: BsmInputs): number {
  const { d2 } = bsmD1D2(input)
  return normalCdf(d2)
}

/** P(S_T < strike) under risk-neutral measure. */
export function riskNeutralProbBelow(input: BsmInputs): number {
  return 1 - riskNeutralProbAbove(input)
}

/**
 * Forward-return distribution under risk-neutral measure, parameterized
 * as log-normal with drift (r - q) and volatility v over time T.
 */
export function riskNeutralReturnDistribution(
  spot: number,
  riskFreeRate: number,
  dividendYield: number,
  volatility: number,
  timeToExpiry: number,
  quantiles: number[] = [0.05, 0.25, 0.5, 0.75, 0.95],
): { quantile: number; price: number; returnPct: number }[] {
  const driftAdjusted = (riskFreeRate - dividendYield - (volatility * volatility) / 2) * timeToExpiry
  const stdDev = volatility * Math.sqrt(timeToExpiry)
  return quantiles.map((q) => {
    const z = inverseNormalCdf(q)
    const logReturn = driftAdjusted + stdDev * z
    const price = spot * Math.exp(logReturn)
    return { quantile: q, price, returnPct: (price / spot - 1) * 100 }
  })
}

/* =========================================================================
   5. GARCH(1,1) — Generalized Autoregressive Conditional Heteroskedasticity
   -------------------------------------------------------------------------
   Source: Bollerslev, T. (1986), "Generalized Autoregressive Conditional
   Heteroskedasticity," Journal of Econometrics 31: 307-327.

   GARCH(1,1):  σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
   where ω, α, β > 0 and α + β < 1 (stationarity).

   We use the simple "RiskMetrics" parameterization (α=0.06, β=0.94) as
   the default — industry-standard EWMA volatility — but expose a
   maximum-likelihood fitter for users who want it.
   ========================================================================= */

export type GarchParams = {
  omega: number
  alpha: number
  beta: number
}

const RISK_METRICS_PARAMS: GarchParams = { omega: 1e-6, alpha: 0.06, beta: 0.94 }

/** Compute log returns from price series. */
export function logReturns(prices: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) {
      out.push(Math.log(prices[i] / prices[i - 1]))
    }
  }
  return out
}

/**
 * Run GARCH(1,1) recursion over a return series and return the
 * one-step-ahead conditional variance forecast (annualized vol if you
 * pass daily returns and multiply by sqrt(252)).
 */
export function garchVolatilityForecast(
  returns: number[],
  params: GarchParams = RISK_METRICS_PARAMS,
): number {
  if (returns.length < 5) return 0.2 // fallback to 20% if too little data
  // Initialize with sample variance
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length
  let variance = returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / returns.length
  for (let i = 1; i < returns.length; i++) {
    const epsilon = returns[i - 1] - meanReturn
    variance = params.omega + params.alpha * epsilon * epsilon + params.beta * variance
  }
  // Convert daily variance to annualized volatility (252 trading days)
  return Math.sqrt(variance * 252)
}

/**
 * Maximum likelihood GARCH(1,1) parameter estimation via grid search.
 * Not as fast as a proper BFGS optimizer but fine for small daily series.
 */
export function fitGarch(returns: number[]): GarchParams {
  if (returns.length < 50) return RISK_METRICS_PARAMS
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const sampleVar = returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / returns.length

  let bestParams = RISK_METRICS_PARAMS
  let bestLogLik = -Infinity

  for (const alpha of [0.05, 0.08, 0.1, 0.12, 0.15]) {
    for (const beta of [0.8, 0.85, 0.9, 0.92, 0.94]) {
      if (alpha + beta >= 0.999) continue
      const omega = sampleVar * (1 - alpha - beta)
      const params: GarchParams = { omega, alpha, beta }
      let variance = sampleVar
      let logLik = 0
      for (let i = 1; i < returns.length; i++) {
        const epsilon = returns[i - 1] - meanReturn
        variance = params.omega + params.alpha * epsilon * epsilon + params.beta * variance
        if (variance <= 0) {
          logLik = -Infinity
          break
        }
        const r2 = (returns[i] - meanReturn) ** 2
        logLik += -0.5 * (Math.log(2 * Math.PI * variance) + r2 / variance)
      }
      if (logLik > bestLogLik) {
        bestLogLik = logLik
        bestParams = params
      }
    }
  }
  return bestParams
}

/* =========================================================================
   6. Monte Carlo simulation — Geometric Brownian Motion + jump diffusion
   -------------------------------------------------------------------------
   Source for GBM: Black-Scholes (1973). For jump diffusion: Merton (1976),
   "Option Pricing When Underlying Stock Returns are Discontinuous,"
   Journal of Financial Economics 3: 125-144.

   Model:
     dS/S = μ·dt + σ·dW + (J - 1)·dN
   where J = jump size (lognormal) and dN = Poisson jump arrivals.
   ========================================================================= */

/** Mulberry32 PRNG — fast, reproducible. Seed with a 32-bit unsigned int. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type MonteCarloInputs = {
  spot: number
  drift: number             // annualized expected log return
  volatility: number        // annualized stddev of log returns
  horizonDays: number       // forecast horizon in trading days
  paths: number             // number of simulated paths
  jumpIntensity?: number    // expected jumps per year (default 0 = pure GBM)
  jumpMean?: number         // mean log jump size (default -0.05 for downside)
  jumpVol?: number          // stddev of log jump size (default 0.10)
  seed?: number
}

export type MonteCarloResult = {
  meanReturnPct: number
  sigmaReturnPct: number
  quantiles: { p05: number; p25: number; p50: number; p75: number; p95: number }
  probUp: number
  probDown5pct: number
  probDown8pct: number
  probUp5pct: number
  paths: number[][] // optional sample of paths for plotting
}

export function monteCarloForecast(input: MonteCarloInputs): MonteCarloResult {
  const {
    spot,
    drift,
    volatility,
    horizonDays,
    paths,
    jumpIntensity = 0,
    jumpMean = -0.05,
    jumpVol = 0.1,
    seed = 12345,
  } = input
  const rng = makeRng(seed)
  const dt = 1 / 252
  const sqrtDt = Math.sqrt(dt)
  const adjustedDrift = drift - 0.5 * volatility * volatility
  // Jump compensator so the expected value is unaffected by the jump term
  const jumpCompensator = jumpIntensity * (Math.exp(jumpMean + 0.5 * jumpVol * jumpVol) - 1)

  const finalReturns: number[] = []
  const sampledPaths: number[][] = []
  const sampleEvery = Math.max(1, Math.floor(paths / 50)) // keep 50 paths for plotting

  for (let p = 0; p < paths; p++) {
    let s = spot
    const path: number[] = [s]
    for (let d = 0; d < horizonDays; d++) {
      const z = inverseNormalCdf(Math.max(1e-9, Math.min(1 - 1e-9, rng())))
      let logIncrement = (adjustedDrift - jumpCompensator) * dt + volatility * sqrtDt * z
      // Poisson jump
      if (jumpIntensity > 0 && rng() < jumpIntensity * dt) {
        const jumpZ = inverseNormalCdf(Math.max(1e-9, Math.min(1 - 1e-9, rng())))
        logIncrement += jumpMean + jumpVol * jumpZ
      }
      s = s * Math.exp(logIncrement)
      if (p % sampleEvery === 0) path.push(s)
    }
    finalReturns.push((s / spot - 1) * 100)
    if (p % sampleEvery === 0) sampledPaths.push(path)
  }

  finalReturns.sort((left, right) => left - right)
  const quantile = (q: number) =>
    finalReturns[Math.min(finalReturns.length - 1, Math.floor(q * finalReturns.length))]
  const mean = finalReturns.reduce((sum, value) => sum + value, 0) / finalReturns.length
  const variance =
    finalReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finalReturns.length
  const sigma = Math.sqrt(variance)
  const probUp = finalReturns.filter((value) => value > 0).length / finalReturns.length
  const probDown5 = finalReturns.filter((value) => value < -5).length / finalReturns.length
  const probDown8 = finalReturns.filter((value) => value < -8).length / finalReturns.length
  const probUp5 = finalReturns.filter((value) => value > 5).length / finalReturns.length

  return {
    meanReturnPct: mean,
    sigmaReturnPct: sigma,
    quantiles: {
      p05: quantile(0.05),
      p25: quantile(0.25),
      p50: quantile(0.5),
      p75: quantile(0.75),
      p95: quantile(0.95),
    },
    probUp,
    probDown5pct: probDown5,
    probDown8pct: probDown8,
    probUp5pct: probUp5,
    paths: sampledPaths,
  }
}

/* =========================================================================
   7. Kelly Criterion — optimal capital fraction
   -------------------------------------------------------------------------
   Source: Kelly, J.L. Jr. (1956), "A New Interpretation of Information
   Rate," Bell System Technical Journal 35(4): 917-926.

   For a continuously-priced asset with normally-distributed returns:
     f* = (μ - r) / σ²
   where μ is expected return, r is risk-free rate, σ² is variance.

   Pure Kelly maximizes log-wealth but is too aggressive in practice
   (drawdowns are brutal). Industry standard is fractional Kelly — most
   practitioners use 0.25× to 0.5× of full Kelly.
   ========================================================================= */

export function kellyFraction(
  expectedReturn: number,
  variance: number,
  riskFreeRate = 0.045,
): number {
  if (variance <= 0) return 0
  const f = (expectedReturn - riskFreeRate) / variance
  // Cap at 1.0 (no leverage) and floor at 0 (no short)
  return Math.max(0, Math.min(1, f))
}

export function fractionalKelly(
  expectedReturn: number,
  variance: number,
  riskFreeRate: number,
  fraction: number,
): number {
  return kellyFraction(expectedReturn, variance, riskFreeRate) * fraction
}

/* =========================================================================
   8. Risk metrics
   ========================================================================= */

/** Historical Value-at-Risk at confidence level alpha (e.g. 0.95 = 95% VaR). */
export function historicalVaR(returns: number[], alpha = 0.95): number {
  if (returns.length === 0) return 0
  const sorted = [...returns].sort((left, right) => left - right)
  const index = Math.floor((1 - alpha) * sorted.length)
  return -sorted[index]
}

/** Conditional VaR / Expected Shortfall — average loss in the worst (1-α) tail. */
export function conditionalVaR(returns: number[], alpha = 0.95): number {
  if (returns.length === 0) return 0
  const sorted = [...returns].sort((left, right) => left - right)
  const cutoff = Math.floor((1 - alpha) * sorted.length)
  if (cutoff === 0) return -sorted[0]
  const tail = sorted.slice(0, cutoff)
  return -(tail.reduce((sum, value) => sum + value, 0) / tail.length)
}

/** Sortino ratio — return / downside deviation. */
export function sortinoRatio(returns: number[], targetReturn = 0): number {
  if (returns.length === 0) return 0
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const downside = returns.filter((value) => value < targetReturn)
  if (downside.length === 0) return 0
  const downsideVar =
    downside.reduce((sum, value) => sum + (value - targetReturn) ** 2, 0) / downside.length
  const downsideDev = Math.sqrt(downsideVar)
  return downsideDev > 0 ? (mean - targetReturn) / downsideDev : 0
}

/** Calmar ratio — annualized return / max drawdown. */
export function calmarRatio(returns: number[]): number {
  if (returns.length === 0) return 0
  const cumulative: number[] = []
  let running = 0
  for (const value of returns) {
    running += value
    cumulative.push(running)
  }
  let peak = cumulative[0]
  let maxDD = 0
  for (const value of cumulative) {
    if (value > peak) peak = value
    const dd = peak - value
    if (dd > maxDD) maxDD = dd
  }
  const annualized = (returns.reduce((sum, value) => sum + value, 0) / returns.length) * 252
  return maxDD > 0 ? annualized / maxDD : 0
}

/** Information ratio — active return vs. benchmark / tracking error. */
export function informationRatio(returns: number[], benchmarkReturns: number[]): number {
  if (returns.length === 0 || returns.length !== benchmarkReturns.length) return 0
  const active = returns.map((value, idx) => value - benchmarkReturns[idx])
  const mean = active.reduce((sum, value) => sum + value, 0) / active.length
  const variance = active.reduce((sum, value) => sum + (value - mean) ** 2, 0) / active.length
  const trackingError = Math.sqrt(variance)
  return trackingError > 0 ? mean / trackingError : 0
}

/** Sharpe ratio — return / total volatility. */
export function sharpeRatio(returns: number[], riskFreeRate = 0): number {
  if (returns.length === 0) return 0
  const excess = returns.map((value) => value - riskFreeRate / 252)
  const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length
  const variance = excess.reduce((sum, value) => sum + (value - mean) ** 2, 0) / excess.length
  const sigma = Math.sqrt(variance)
  return sigma > 0 ? (mean / sigma) * Math.sqrt(252) : 0
}

/* =========================================================================
   9. Black-Litterman expected-return blender
   -------------------------------------------------------------------------
   Source: Black, F. & Litterman, R. (1992), "Global Portfolio
   Optimization," Financial Analysts Journal 48(5): 28-43.

   Given:
     - Market-implied returns Π (from CAPM equilibrium)
     - The investor's own views Q with confidence τ
   The posterior expected return is a Bayesian combination.

   Simplified scalar form for combining one view with one prior:
     E[r] = (1/τ·Π + ω⁻¹·Q) / (1/τ + ω⁻¹)
   where τ is investor uncertainty and ω is view variance.
   ========================================================================= */

export function blackLittermanScalar(
  marketImpliedReturn: number,
  marketVariance: number,
  investorView: number,
  viewVariance: number,
  marketWeight = 0.5,
): number {
  const tauPrec = 1 / (marketVariance * marketWeight)
  const viewPrec = 1 / viewVariance
  return (tauPrec * marketImpliedReturn + viewPrec * investorView) / (tauPrec + viewPrec)
}

/* =========================================================================
   10. CAPM expected return
   ========================================================================= */
export function capmExpectedReturn(
  riskFreeRate: number,
  beta: number,
  marketRiskPremium: number,
): number {
  return riskFreeRate + beta * marketRiskPremium
}

/** Beta estimation via OLS regression of stock returns on market returns. */
export function estimateBeta(stockReturns: number[], marketReturns: number[]): number {
  if (stockReturns.length === 0 || stockReturns.length !== marketReturns.length) return 1
  const n = stockReturns.length
  const meanS = stockReturns.reduce((sum, value) => sum + value, 0) / n
  const meanM = marketReturns.reduce((sum, value) => sum + value, 0) / n
  let cov = 0
  let varM = 0
  for (let i = 0; i < n; i++) {
    cov += (stockReturns[i] - meanS) * (marketReturns[i] - meanM)
    varM += (marketReturns[i] - meanM) ** 2
  }
  return varM > 0 ? cov / varM : 1
}

/* =========================================================================
   11. Pearson correlation
   ========================================================================= */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length === 0 || x.length !== y.length) return 0
  const n = x.length
  const meanX = x.reduce((sum, value) => sum + value, 0) / n
  const meanY = y.reduce((sum, value) => sum + value, 0) / n
  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    cov += (x[i] - meanX) * (y[i] - meanY)
    varX += (x[i] - meanX) ** 2
    varY += (y[i] - meanY) ** 2
  }
  const denom = Math.sqrt(varX * varY)
  return denom > 0 ? cov / denom : 0
}
