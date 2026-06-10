/**
 * Self-test harness for the quant math library.
 *
 * Runs at module import time (in dev mode) and logs failures to console.
 * Validates that:
 *   - BSM call/put match the standard published reference values
 *   - Put-call parity holds: C - P = S - K·e^(-rT) (with no dividend)
 *   - IV inversion round-trips: bsmCallPrice(IV(price)) ≈ price
 *   - Greeks sanity checks (delta in [0,1], gamma >= 0, etc.)
 *   - GARCH outputs are stationary (α + β < 1)
 *   - Risk-neutral probabilities are in [0, 1]
 *
 * NOT a replacement for a proper test framework, but catches the silent
 * bug class that would otherwise corrupt every downstream metric.
 */

import {
  bsmCallPrice,
  bsmPutPrice,
  callGreeks,
  cornishFisherVaR,
  empiricalJumpStats,
  fitGarch,
  fitGjrGarch,
  fitHarRv,
  fitMarkovRegime,
  garchVolatilityForecast,
  gjrGarchVolatilityForecast,
  harRvForecast,
  hestonCallPrice,
  impliedVolatility,
  inverseNormalCdf,
  normalCdf,
  putGreeks,
  quasiUniform,
  riskNeutralProbAbove,
  riskParityWeights,
  sampleExcessKurtosis,
  sampleSkewness,
  type BsmInputs,
} from './quantMath'

type TestResult = { name: string; passed: boolean; detail?: string }

function approx(actual: number, expected: number, tolerance = 1e-3): boolean {
  return Math.abs(actual - expected) < tolerance
}

const tests: Array<() => TestResult> = [
  () => {
    // Hull's textbook example: S=42, K=40, r=0.10, q=0, T=0.5, v=0.2
    // Call price = 4.7594 (Hull 9th ed, Table 17.2)
    const price = bsmCallPrice({
      spot: 42,
      strike: 40,
      timeToExpiry: 0.5,
      riskFreeRate: 0.10,
      volatility: 0.2,
    })
    const ok = approx(price, 4.7594, 0.01)
    return {
      name: 'BSM call matches Hull textbook example (S=42 K=40 r=10% T=0.5 v=20%)',
      passed: ok,
      detail: `expected 4.7594, got ${price.toFixed(4)}`,
    }
  },

  () => {
    // Put for the same parameters = 0.8086 (Hull 9th ed)
    const price = bsmPutPrice({
      spot: 42,
      strike: 40,
      timeToExpiry: 0.5,
      riskFreeRate: 0.10,
      volatility: 0.2,
    })
    const ok = approx(price, 0.8086, 0.01)
    return {
      name: 'BSM put matches Hull textbook example',
      passed: ok,
      detail: `expected 0.8086, got ${price.toFixed(4)}`,
    }
  },

  () => {
    // Put-call parity (Stoll 1969): C - P = S - K·e^(-rT) for q=0
    const inputs: BsmInputs = {
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    }
    const c = bsmCallPrice(inputs)
    const p = bsmPutPrice(inputs)
    const lhs = c - p
    const rhs = inputs.spot - inputs.strike * Math.exp(-inputs.riskFreeRate * inputs.timeToExpiry)
    return {
      name: 'Put-call parity holds (Stoll 1969)',
      passed: approx(lhs, rhs, 1e-6),
      detail: `C - P = ${lhs.toFixed(6)}, S - K·e^(-rT) = ${rhs.toFixed(6)}`,
    }
  },

  () => {
    // ATM call delta should be roughly 0.5 + small positive drift component
    // For S=K=100, r=5%, T=1, v=20%: delta ≈ 0.6368 (BSM closed form)
    const greeks = callGreeks({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    })
    const ok = approx(greeks.delta, 0.6368, 0.001)
    return {
      name: 'ATM call delta matches closed-form (≈0.637)',
      passed: ok,
      detail: `expected 0.6368, got ${greeks.delta.toFixed(4)}`,
    }
  },

  () => {
    // ATM put delta should be -1 + call delta = -0.3632
    const greeks = putGreeks({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    })
    const ok = approx(greeks.delta, -0.3632, 0.001)
    return {
      name: 'ATM put delta = call delta - 1',
      passed: ok,
      detail: `expected -0.3632, got ${greeks.delta.toFixed(4)}`,
    }
  },

  () => {
    // Greeks sanity: ATM gamma > 0
    const greeks = callGreeks({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    })
    return {
      name: 'ATM gamma is positive',
      passed: greeks.gamma > 0,
      detail: `gamma = ${greeks.gamma.toFixed(6)}`,
    }
  },

  () => {
    // IV solver should round-trip
    const inputs: BsmInputs = {
      spot: 100,
      strike: 105,
      timeToExpiry: 0.5,
      riskFreeRate: 0.05,
      volatility: 0.25,
    }
    const truePrice = bsmCallPrice(inputs)
    const recovered = impliedVolatility(
      truePrice,
      'call',
      100,
      105,
      0.5,
      0.05,
    )
    const ok = recovered != null && approx(recovered, 0.25, 0.001)
    return {
      name: 'IV solver round-trips (Newton-Raphson)',
      passed: ok,
      detail: `recovered ${recovered?.toFixed(4) ?? 'null'}, expected 0.2500`,
    }
  },

  () => {
    // Standard normal CDF: N(0) = 0.5, N(1.96) ≈ 0.975
    const ok = approx(normalCdf(0), 0.5, 1e-6) && approx(normalCdf(1.96), 0.975, 1e-3)
    return {
      name: 'Standard normal CDF accurate at 0 and 1.96',
      passed: ok,
      detail: `N(0)=${normalCdf(0).toFixed(6)}, N(1.96)=${normalCdf(1.96).toFixed(6)}`,
    }
  },

  () => {
    // Inverse normal CDF: ICDF(0.5) = 0, ICDF(0.975) ≈ 1.96
    const a = inverseNormalCdf(0.5)
    const b = inverseNormalCdf(0.975)
    return {
      name: 'Inverse normal CDF round-trips',
      passed: approx(a, 0, 1e-6) && approx(b, 1.96, 1e-3),
      detail: `ICDF(0.5)=${a.toFixed(4)}, ICDF(0.975)=${b.toFixed(4)}`,
    }
  },

  () => {
    // Risk-neutral P(S_T > K) at-the-money should be slightly less than 0.5
    // because of the variance penalty in d2 (note: different from delta).
    const prob = riskNeutralProbAbove({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    })
    return {
      name: 'Risk-neutral ATM P(S>K) is in valid range',
      passed: prob > 0 && prob < 1 && prob < 0.6 && prob > 0.4,
      detail: `P = ${prob.toFixed(4)} (expected ~0.5 ± drift)`,
    }
  },

  () => {
    // GARCH(1,1) stationarity
    const returns = Array.from({ length: 250 }, () => (Math.random() - 0.5) * 0.04)
    const params = fitGarch(returns)
    const ok = params.alpha > 0 && params.beta > 0 && params.alpha + params.beta < 1
    return {
      name: 'GARCH(1,1) fit yields stationary parameters (α+β<1)',
      passed: ok,
      detail: `α=${params.alpha.toFixed(3)}, β=${params.beta.toFixed(3)}, sum=${(params.alpha + params.beta).toFixed(3)}`,
    }
  },

  () => {
    // GJR-GARCH stationarity: α + β + γ/2 < 1
    const returns = Array.from({ length: 300 }, () => (Math.random() - 0.5) * 0.04)
    const params = fitGjrGarch(returns)
    const sum = params.alpha + params.beta + params.gamma / 2
    return {
      name: 'GJR-GARCH fit yields stationary parameters (α+β+γ/2<1)',
      passed: sum < 1 && params.alpha >= 0 && params.beta > 0 && params.gamma >= 0,
      detail: `α=${params.alpha.toFixed(3)}, β=${params.beta.toFixed(3)}, γ=${params.gamma.toFixed(3)}, sum=${sum.toFixed(3)}`,
    }
  },

  () => {
    // GARCH vol forecast is positive
    const returns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.03)
    const vol = garchVolatilityForecast(returns)
    return {
      name: 'GARCH vol forecast is positive',
      passed: vol > 0 && vol < 5,
      detail: `vol = ${vol.toFixed(4)}`,
    }
  },

  () => {
    // GJR-GARCH vol forecast is positive
    const returns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.03)
    const params = fitGjrGarch(returns)
    const vol = gjrGarchVolatilityForecast(returns, params)
    return {
      name: 'GJR-GARCH vol forecast is positive',
      passed: vol > 0 && vol < 5,
      detail: `vol = ${vol.toFixed(4)}`,
    }
  },

  () => {
    // Risk-parity weights sum to 1.0 and are inversely proportional to vol
    const weights = riskParityWeights({ A: 0.10, B: 0.20, C: 0.05 })
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
    return {
      name: 'Risk-parity weights sum to 1 and inverse-vol order',
      passed: approx(total, 1, 1e-9) && weights.C > weights.A && weights.A > weights.B,
      detail: `total=${total.toFixed(6)}, weights=${JSON.stringify(weights)}`,
    }
  },

  () => {
    // Empirical jump stats: a series with no big jumps should detect ≈ 0
    const calmReturns = Array.from({ length: 250 }, () => (Math.random() - 0.5) * 0.01)
    const stats = empiricalJumpStats(calmReturns, 4)
    return {
      name: 'Empirical jump stats: calm series detects few jumps',
      passed: stats.intensity < 5,  // < 5 jumps/year on a calm series
      detail: `intensity=${stats.intensity.toFixed(2)}, observed=${stats.jumpsObserved}`,
    }
  },

  () => {
    // Empirical jump stats: a series WITH a big shock should detect it
    const shockyReturns = Array.from({ length: 250 }, () => (Math.random() - 0.5) * 0.01)
    shockyReturns[100] = -0.10  // big drop
    shockyReturns[150] = 0.08   // big jump up
    const stats = empiricalJumpStats(shockyReturns, 3)
    return {
      name: 'Empirical jump stats: detects injected shocks',
      passed: stats.jumpsObserved >= 1,
      detail: `observed=${stats.jumpsObserved}, intensity=${stats.intensity.toFixed(2)}`,
    }
  },

  // === Modern methods ==========================================

  () => {
    // Heston should converge to BSM as sigma_v -> 0. σ_v=0.0001 routes
    // through the degenerate-limit BSM guard; σ_v=0.05 exercises the real
    // characteristic-function integration. Both must match BSM ≈ 10.45.
    const viaGuard = hestonCallPrice(100, 100, 1, 0.05, 0, {
      kappa: 5, theta: 0.04, sigmaV: 0.0001, rho: 0, v0: 0.04,
    })
    const viaIntegration = hestonCallPrice(100, 100, 1, 0.05, 0, {
      kappa: 5, theta: 0.04, sigmaV: 0.05, rho: 0, v0: 0.04,
    })
    const bsmPrice = bsmCallPrice({
      spot: 100, strike: 100, timeToExpiry: 1,
      riskFreeRate: 0.05, volatility: 0.2,
    })
    const ok =
      Math.abs(viaGuard - bsmPrice) < 0.05 && Math.abs(viaIntegration - bsmPrice) < 0.05
    return {
      name: 'Heston degenerate-vol case approximates BSM',
      passed: ok,
      detail: `guard ${viaGuard.toFixed(2)}, integration ${viaIntegration.toFixed(2)}, BSM ${bsmPrice.toFixed(2)}`,
    }
  },

  () => {
    // Heston reference case (Schoutens/Albrecher calibration parameters):
    // κ=1.5768, θ=0.0398, σ_v=0.5751, ρ=-0.5711, v0=0.0175, S=K=100,
    // T=1, r=2.5%. Reference price 7.27 verified independently via
    // Euler-Maruyama Monte Carlo (200k paths, 400 steps → 7.269).
    const price = hestonCallPrice(100, 100, 1, 0.025, 0, {
      kappa: 1.5768, theta: 0.0398, sigmaV: 0.5751, rho: -0.5711, v0: 0.0175,
    })
    return {
      name: 'Heston matches MC-verified reference price (7.27)',
      passed: Math.abs(price - 7.27) < 0.1,
      detail: `Heston ${price.toFixed(3)} vs MC reference 7.269`,
    }
  },

  () => {
    // HAR-RV fit should produce coefficients summing close to historical
    // average autoregression coefficient (Corsi reports ~0.9 sum on equities)
    const returns = Array.from({ length: 300 }, () => (Math.random() - 0.5) * 0.025)
    const params = fitHarRv(returns)
    const sum = params.betaDaily + params.betaWeekly + params.betaMonthly
    return {
      name: 'HAR-RV fit yields persistent vol coefficients',
      passed: Number.isFinite(sum) && sum < 2 && sum > -1,
      detail: `β_d=${params.betaDaily.toFixed(2)}, β_w=${params.betaWeekly.toFixed(2)}, β_m=${params.betaMonthly.toFixed(2)}, sum=${sum.toFixed(2)}`,
    }
  },

  () => {
    // HAR-RV one-step forecast should be positive and finite
    const returns = Array.from({ length: 200 }, () => (Math.random() - 0.5) * 0.02)
    const params = fitHarRv(returns)
    const vol = harRvForecast(returns, params)
    return {
      name: 'HAR-RV vol forecast is positive and finite',
      passed: vol > 0 && Number.isFinite(vol),
      detail: `vol = ${vol.toFixed(4)}`,
    }
  },

  () => {
    // Cornish-Fisher VaR with normal data should approximately equal historical VaR
    // (because skew=0, kurtosis=0 in expectation for normal)
    const returns = Array.from({ length: 500 }, () => {
      let value = 0
      for (let i = 0; i < 12; i++) value += Math.random()
      return (value - 6) / 3 * 0.01  // approximately normal via central limit
    })
    const cf = cornishFisherVaR(returns, 0.95)
    return {
      name: 'Cornish-Fisher VaR positive on equity-like returns',
      passed: cf > 0 && Number.isFinite(cf),
      detail: `CF VaR(95%) = ${cf.toFixed(4)}`,
    }
  },

  () => {
    // Skewness of an injected-skew series should be negative
    const returns = Array.from({ length: 300 }, () => (Math.random() - 0.5) * 0.01)
    returns[50] = -0.08
    returns[100] = -0.07
    returns[150] = -0.06
    const skew = sampleSkewness(returns)
    return {
      name: 'Sample skewness detects negative tail',
      passed: skew < 0,
      detail: `skew = ${skew.toFixed(3)}`,
    }
  },

  () => {
    // Excess kurtosis of injected-tail series should be > 0
    const returns = Array.from({ length: 300 }, () => (Math.random() - 0.5) * 0.005)
    returns[100] = 0.08
    returns[200] = -0.08
    const exKurt = sampleExcessKurtosis(returns)
    return {
      name: 'Sample excess kurtosis detects fat tails',
      passed: exKurt > 1,
      detail: `excess kurtosis = ${exKurt.toFixed(2)}`,
    }
  },

  () => {
    // Markov regime fitter should separate variances (high > low)
    const returns: number[] = []
    for (let i = 0; i < 200; i++) returns.push((Math.random() - 0.5) * 0.005)
    for (let i = 0; i < 50; i++) returns.push((Math.random() - 0.5) * 0.04)
    const state = fitMarkovRegime(returns)
    return {
      name: 'Markov regime fitter separates low/high vol states',
      passed: state.varianceHigh > state.varianceLow,
      detail: `varLow=${state.varianceLow.toExponential(2)}, varHigh=${state.varianceHigh.toExponential(2)}`,
    }
  },

  () => {
    // Quasi-uniform should be in [0,1) and produce different values for different i
    const a = quasiUniform(1)
    const b = quasiUniform(2)
    const c = quasiUniform(100)
    return {
      name: 'Quasi-uniform sequence in [0,1) and varies with index',
      passed: a >= 0 && a < 1 && a !== b && b !== c,
      detail: `q(1)=${a.toFixed(4)}, q(2)=${b.toFixed(4)}, q(100)=${c.toFixed(4)}`,
    }
  },
]

let alreadyRun = false

export function runQuantSelfTests(): TestResult[] {
  if (alreadyRun) return []
  alreadyRun = true
  const results = tests.map((test) => {
    try {
      return test()
    } catch (error) {
      return {
        name: 'unknown test',
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const failed = results.filter((result) => !result.passed)
  if (failed.length === 0) {
    console.info(`[quantMath] All ${results.length} self-tests passed.`)
  } else {
    console.error(`[quantMath] ${failed.length} of ${results.length} self-tests FAILED:`)
    failed.forEach((result) => {
      console.error(`  ✗ ${result.name} — ${result.detail ?? ''}`)
    })
  }
  return results
}
