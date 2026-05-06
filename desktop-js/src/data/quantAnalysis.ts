import type { DecisionSignal } from './decisionEngine'
import { cachedFetchDailyBars } from './marketData'
import { fetchOptionsSnapshot, type OptionsSnapshot } from './optionsAdapter'
import {
  bsmCallPrice,
  callGreeks,
  conditionalVaR,
  fitGarch,
  garchVolatilityForecast,
  historicalVaR,
  inverseNormalCdf,
  kellyFraction,
  logReturns,
  monteCarloForecast,
  normalCdf,
  riskNeutralProbAbove,
  riskNeutralReturnDistribution,
  sharpeRatio,
  sortinoRatio,
  type Greeks,
  type MonteCarloResult,
} from './quantMath'

/**
 * Per-ticker quantitative analysis. Combines:
 *   - Yahoo OHLCV history → log returns → GARCH volatility forecast
 *   - Tradier options chain → BSM Greeks + risk-neutral probabilities
 *   - Monte Carlo simulation → forward return distribution + tail probs
 *   - Risk metrics (VaR, CVaR, Sortino, Sharpe)
 *   - Kelly Criterion → optimal capital fraction
 */

const RISK_FREE_RATE = 0.045 // ~current 1Y Treasury yield; could fetch from FRED
const DIVIDEND_YIELD_DEFAULT = 0.015

export type QuantAnalysis = {
  ticker: string
  asOf: string
  dataSource: 'live' | 'partial' | 'unavailable'

  // Volatility forecasts
  realizedVol30d: number     // annualized, from sample stddev of last 30d returns
  garchForecastVol: number   // annualized, GARCH(1,1) one-step-ahead
  optionsImpliedVol?: number // from Tradier ATM 30d IV

  // Forward return distribution from Monte Carlo
  monteCarlo: MonteCarloResult

  // Risk-neutral probabilities from BSM (when options data exists)
  riskNeutral?: {
    probUp: number
    probUp5pct: number
    probDown5pct: number
    probDown8pct: number
    quantiles: { p05: number; p25: number; p50: number; p75: number; p95: number }
  }

  // Greeks at ATM strike (when options data exists)
  greeksATM?: Greeks

  // Risk metrics on the realized return series
  var95: number              // 1-day 95% historical VaR
  var99: number              // 1-day 99% historical VaR
  cvar95: number             // 1-day 95% Expected Shortfall
  sortino: number            // annualized Sortino ratio
  sharpe: number             // annualized Sharpe ratio

  // Position sizing
  kellyFull: number          // 0-1, full Kelly fraction
  kellyHalf: number          // 0-1, half Kelly (industry-conservative)
  kellyQuarter: number       // 0-1, quarter Kelly (very conservative)

  // Diagnostic
  barsAvailable: number
  hasOptionsData: boolean
}

/**
 * Compute the full quantitative analysis for a single ticker. This is
 * the heavy lift — fetches bars + options + runs Monte Carlo. Cache
 * aggressively at the call site.
 */
export async function computeQuantAnalysis(
  signal: DecisionSignal,
): Promise<QuantAnalysis | null> {
  const ticker = signal.ticker
  const bars = await cachedFetchDailyBars(ticker, '1y')
  if (bars.length < 30) {
    return null // not enough data for any of the math to be meaningful
  }
  const closes = bars.map((bar) => bar.close)
  const returns = logReturns(closes)
  const lastPrice = closes[closes.length - 1]

  // Fit GARCH(1,1) on the returns and forecast next-period volatility
  const garchParams = fitGarch(returns)
  const garchVol = garchVolatilityForecast(returns, garchParams)

  // Realized volatility from the last 30 days
  const recent = returns.slice(-30)
  const meanRecent = recent.reduce((sum, value) => sum + value, 0) / recent.length
  const variance =
    recent.reduce((sum, value) => sum + (value - meanRecent) ** 2, 0) / Math.max(1, recent.length - 1)
  const realizedVol30d = Math.sqrt(variance * 252)

  // Try to fetch options snapshot for BSM-based work
  let optionsSnapshot: OptionsSnapshot | null
  try {
    optionsSnapshot = await fetchOptionsSnapshot(ticker)
  } catch {
    optionsSnapshot = null
  }
  const optionsImpliedVol = optionsSnapshot ? optionsSnapshot.atm30dIv / 100 : undefined

  // Monte Carlo: 5,000 paths over 20 trading days. Drift comes from the
  // engine's composite alpha translated to expected log return; vol comes
  // from GARCH (preferred) or implied vol (fallback).
  const drift = signal.compositeAlphaZ * 0.05 // alpha Z scaled to annual return
  const volForMc = optionsImpliedVol ?? garchVol
  // Jump diffusion: more aggressive when event risk + skew are elevated
  const jumpIntensity =
    signal.eventRisk > 65 || signal.skewRisk > 65
      ? Math.min(4, signal.eventRisk / 30 + signal.skewRisk / 50)
      : 0
  const monteCarlo = monteCarloForecast({
    spot: lastPrice,
    drift,
    volatility: volForMc,
    horizonDays: 20,
    paths: 5000,
    jumpIntensity,
    jumpMean: -0.04, // average jumps slightly negative (skew)
    jumpVol: 0.08,
    seed: hashSeed(ticker),
  })

  // Risk-neutral probabilities — only computable when we have IV
  let riskNeutral: QuantAnalysis['riskNeutral']
  let greeksATM: Greeks | undefined
  if (optionsImpliedVol && optionsImpliedVol > 0.01) {
    const T = 30 / 365
    const v = optionsImpliedVol
    riskNeutral = {
      probUp: riskNeutralProbAbove({
        spot: lastPrice,
        strike: lastPrice,
        timeToExpiry: T,
        riskFreeRate: RISK_FREE_RATE,
        dividendYield: DIVIDEND_YIELD_DEFAULT,
        volatility: v,
      }),
      probUp5pct: riskNeutralProbAbove({
        spot: lastPrice,
        strike: lastPrice * 1.05,
        timeToExpiry: T,
        riskFreeRate: RISK_FREE_RATE,
        dividendYield: DIVIDEND_YIELD_DEFAULT,
        volatility: v,
      }),
      probDown5pct: 1 -
        riskNeutralProbAbove({
          spot: lastPrice,
          strike: lastPrice * 0.95,
          timeToExpiry: T,
          riskFreeRate: RISK_FREE_RATE,
          dividendYield: DIVIDEND_YIELD_DEFAULT,
          volatility: v,
        }),
      probDown8pct: 1 -
        riskNeutralProbAbove({
          spot: lastPrice,
          strike: lastPrice * 0.92,
          timeToExpiry: T,
          riskFreeRate: RISK_FREE_RATE,
          dividendYield: DIVIDEND_YIELD_DEFAULT,
          volatility: v,
        }),
      quantiles: (() => {
        const q = riskNeutralReturnDistribution(
          lastPrice,
          RISK_FREE_RATE,
          DIVIDEND_YIELD_DEFAULT,
          v,
          T,
        )
        return {
          p05: q[0].returnPct,
          p25: q[1].returnPct,
          p50: q[2].returnPct,
          p75: q[3].returnPct,
          p95: q[4].returnPct,
        }
      })(),
    }
    greeksATM = callGreeks({
      spot: lastPrice,
      strike: lastPrice,
      timeToExpiry: T,
      riskFreeRate: RISK_FREE_RATE,
      dividendYield: DIVIDEND_YIELD_DEFAULT,
      volatility: v,
    })
  }

  // Risk metrics on daily returns (convert to %)
  const dailyPctReturns = returns.map((value) => value * 100)
  const var95 = historicalVaR(dailyPctReturns, 0.95)
  const var99 = historicalVaR(dailyPctReturns, 0.99)
  const cvar95 = conditionalVaR(dailyPctReturns, 0.95)
  const sortino = sortinoRatio(dailyPctReturns) * Math.sqrt(252) // annualize
  const sharpe = sharpeRatio(returns, RISK_FREE_RATE)

  // Kelly: μ = MC mean (annualized from 20d), σ² = MC sigma squared (annualized)
  const annualizedMcReturn = (monteCarlo.meanReturnPct / 100) * (252 / 20)
  const annualizedMcVar = ((monteCarlo.sigmaReturnPct / 100) ** 2) * (252 / 20)
  const fullKelly = kellyFraction(annualizedMcReturn, annualizedMcVar, RISK_FREE_RATE)

  return {
    ticker,
    asOf: new Date().toISOString(),
    dataSource: optionsSnapshot ? 'live' : 'partial',
    realizedVol30d,
    garchForecastVol: garchVol,
    optionsImpliedVol,
    monteCarlo,
    riskNeutral,
    greeksATM,
    var95,
    var99,
    cvar95,
    sortino,
    sharpe,
    kellyFull: fullKelly,
    kellyHalf: fullKelly * 0.5,
    kellyQuarter: fullKelly * 0.25,
    barsAvailable: bars.length,
    hasOptionsData: optionsSnapshot != null,
  }
}

/** Cheap deterministic hash to seed Monte Carlo per ticker. */
function hashSeed(ticker: string): number {
  let hash = 2166136261
  for (let i = 0; i < ticker.length; i++) {
    hash ^= ticker.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Cache by ticker. Quant analysis is expensive (20-50ms per ticker)
 * so cache for 5 minutes per ticker — same TTL as the options adapter.
 */
const cache = new Map<string, { expires: number; value: Promise<QuantAnalysis | null> }>()

export function cachedComputeQuantAnalysis(signal: DecisionSignal): Promise<QuantAnalysis | null> {
  const now = Date.now()
  const existing = cache.get(signal.ticker)
  if (existing && existing.expires > now) return existing.value
  const value = computeQuantAnalysis(signal)
  cache.set(signal.ticker, { expires: now + 5 * 60 * 1000, value })
  return value
}

/* Re-export the inverseNormalCdf so the BSM helpers stay self-contained
 * even when imported only from this orchestrator. */
export { inverseNormalCdf, normalCdf, bsmCallPrice }
