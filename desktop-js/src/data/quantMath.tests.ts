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
  fitGradientBoosting,
  fitHarRv,
  fitMarkovRegime,
  fitRidge,
  garchVolatilityForecast,
  gjrGarchVolatilityForecast,
  harRvForecast,
  hestonCallPrice,
  impliedVolatility,
  inverseNormalCdf,
  normalCdf,
  predictGradientBoosting,
  predictRidge,
  putGreeks,
  quasiUniform,
  RIDGE_LAMBDA_GRID_MULTIPLIERS,
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

// Fixed xorshift32 stream: startup self-tests must produce the same result in
// development, CI, and the packaged runtime.
let testRandomState = 0x6f726163
function testRandom(): number {
  testRandomState ^= testRandomState << 13
  testRandomState ^= testRandomState >>> 17
  testRandomState ^= testRandomState << 5
  return (testRandomState >>> 0) / 0x1_0000_0000
}

// Deterministic ridge fixture: three quasi-random features on [-1, 1] and a
// noise-free linear target, y = 1.5 + 2 x0 - 3 x1 + 0.5 x2.
function ridgeFixture(rows = 200): { features: number[][]; targets: number[] } {
  const features: number[][] = []
  const targets: number[] = []
  for (let i = 0; i < rows; i++) {
    const x0 = quasiUniform(i * 3 + 1) * 2 - 1
    const x1 = quasiUniform(i * 3 + 2) * 2 - 1
    const x2 = quasiUniform(i * 3 + 3) * 2 - 1
    features.push([x0, x1, x2])
    targets.push(1.5 + 2 * x0 - 3 * x1 + 0.5 * x2)
  }
  return { features, targets }
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
    const returns = Array.from({ length: 250 }, () => (testRandom() - 0.5) * 0.04)
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
    const returns = Array.from({ length: 300 }, () => (testRandom() - 0.5) * 0.04)
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
    const returns = Array.from({ length: 200 }, () => (testRandom() - 0.5) * 0.03)
    const vol = garchVolatilityForecast(returns)
    return {
      name: 'GARCH vol forecast is positive',
      passed: vol > 0 && vol < 5,
      detail: `vol = ${vol.toFixed(4)}`,
    }
  },

  () => {
    // GJR-GARCH vol forecast is positive
    const returns = Array.from({ length: 200 }, () => (testRandom() - 0.5) * 0.03)
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
    const calmReturns = Array.from({ length: 250 }, () => (testRandom() - 0.5) * 0.01)
    const stats = empiricalJumpStats(calmReturns, 4)
    return {
      name: 'Empirical jump stats: calm series detects few jumps',
      passed: stats.intensity < 5,  // < 5 jumps/year on a calm series
      detail: `intensity=${stats.intensity.toFixed(2)}, observed=${stats.jumpsObserved}`,
    }
  },

  () => {
    // Empirical jump stats: a series WITH a big shock should detect it
    const shockyReturns = Array.from({ length: 250 }, () => (testRandom() - 0.5) * 0.01)
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
    const returns = Array.from({ length: 300 }, () => (testRandom() - 0.5) * 0.025)
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
    const returns = Array.from({ length: 200 }, () => (testRandom() - 0.5) * 0.02)
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
      for (let i = 0; i < 12; i++) value += testRandom()
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
    const returns = Array.from({ length: 300 }, () => (testRandom() - 0.5) * 0.01)
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
    const returns = Array.from({ length: 300 }, () => (testRandom() - 0.5) * 0.005)
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
    for (let i = 0; i < 200; i++) returns.push((testRandom() - 0.5) * 0.005)
    for (let i = 0; i < 50; i++) returns.push((testRandom() - 0.5) * 0.04)
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

  () => {
    // GBT (histogram splits) recovers a known linear signal: y = 3·x0 − 2·x1 + ε.
    // In-sample correlation should be high and quantile heads must order
    // p10 ≤ p50 ≤ p90 on average (pinball loss, Friedman 2001; histogram
    // split finding per Ke et al. 2017).
    const n = 600
    const features: number[][] = []
    const targets: number[] = []
    for (let i = 0; i < n; i++) {
      const x0 = quasiUniform(i * 3 + 1) * 4 - 2
      const x1 = quasiUniform(i * 3 + 2) * 4 - 2
      const noise = (quasiUniform(i * 3 + 3) - 0.5) * 1.5
      features.push([x0, x1, quasiUniform(i * 7 + 5)])
      targets.push(3 * x0 - 2 * x1 + noise)
    }
    const median = fitGradientBoosting(features, targets, { numTrees: 60, depth: 3, learningRate: 0.1 })
    const p10 = fitGradientBoosting(features, targets, { numTrees: 60, depth: 3, learningRate: 0.1, quantile: 0.1 })
    const p90 = fitGradientBoosting(features, targets, { numTrees: 60, depth: 3, learningRate: 0.1, quantile: 0.9 })
    const predictions = features.map((row) => predictGradientBoosting(median, row))
    const meanP = predictions.reduce((s, v) => s + v, 0) / n
    const meanT = targets.reduce((s, v) => s + v, 0) / n
    let cov = 0
    let varP = 0
    let varT = 0
    for (let i = 0; i < n; i++) {
      cov += (predictions[i] - meanP) * (targets[i] - meanT)
      varP += (predictions[i] - meanP) ** 2
      varT += (targets[i] - meanT) ** 2
    }
    const correlation = cov / Math.sqrt(Math.max(1e-12, varP * varT))
    let ordered = 0
    for (let i = 0; i < n; i++) {
      const lo = predictGradientBoosting(p10, features[i])
      const hi = predictGradientBoosting(p90, features[i])
      if (lo <= predictions[i] + 0.5 && predictions[i] - 0.5 <= hi && lo < hi) ordered++
    }
    const orderedShare = ordered / n
    return {
      name: 'GBT recovers linear signal (r > 0.9) with ordered quantile heads',
      passed: correlation > 0.9 && orderedShare > 0.9,
      detail: `r=${correlation.toFixed(3)}, quantile-ordered=${(orderedShare * 100).toFixed(0)}%`,
    }
  },
  () => {
    // Ridge at lambda = 0 is ordinary least squares, so a noise-free linear
    // target must return its generating coefficients (Hoerl and Kennard
    // 1970 reduces to OLS at zero penalty).
    const { features, targets } = ridgeFixture()
    const model = fitRidge(features, targets, 0)
    const maxError = Math.max(
      Math.abs(model.intercept - 1.5),
      Math.abs(model.coefficients[0] - 2),
      Math.abs(model.coefficients[1] + 3),
      Math.abs(model.coefficients[2] - 0.5),
    )
    const prediction = model.predict([0.2, -0.4, 0.6])
    const serialisedPrediction = predictRidge(model, [0.2, -0.4, 0.6])
    const expected = 1.5 + 2 * 0.2 - 3 * -0.4 + 0.5 * 0.6
    return {
      name: 'Ridge at lambda=0 recovers known coefficients (OLS limit)',
      passed: maxError < 1e-9 && approx(prediction, expected, 1e-9) && serialisedPrediction === prediction,
      detail: `max coefficient error=${maxError.toExponential(2)}, predict=${prediction.toFixed(6)} vs ${expected.toFixed(6)}`,
    }
  },

  () => {
    // The ridge coefficient norm falls monotonically as lambda rises and is
    // driven almost to zero by a very large penalty (Hoerl and Kennard 1970).
    const { features, targets } = ridgeFixture()
    const lambdas = [0, 1, 10, 100, 1e4, 1e7]
    const norms = lambdas.map((lambda) => Math.hypot(...fitRidge(features, targets, lambda).coefficients))
    const strictlyDecreasing = norms.every((norm, i) => i === 0 || norm < norms[i - 1])
    return {
      name: 'Ridge coefficients shrink toward zero as lambda grows',
      passed: strictlyDecreasing && norms[norms.length - 1] < 1e-3 * norms[0],
      detail: `norms=${norms.map((norm) => norm.toFixed(5)).join(' > ')}`,
    }
  },

  () => {
    // Centring keeps the intercept out of the penalty (ESL section 3.4.1):
    // adding a constant to every target moves the intercept by exactly that
    // constant and leaves the slopes untouched, and under a crushing penalty
    // the intercept is simply the target mean.
    const { features, targets } = ridgeFixture()
    const shift = 7
    const base = fitRidge(features, targets, 10)
    const shifted = fitRidge(features, targets.map((t) => t + shift), 10)
    const slopeDrift = Math.max(...base.coefficients.map((c, j) => Math.abs(c - shifted.coefficients[j])))
    const interceptMove = shifted.intercept - base.intercept
    const crushed = fitRidge(features, targets, 1e12)
    const targetMean = targets.reduce((s, v) => s + v, 0) / targets.length
    const crushedSlopeNorm = Math.hypot(...crushed.coefficients)
    return {
      name: 'Ridge intercept is unpenalised (target shift moves only the intercept)',
      passed:
        slopeDrift < 1e-9 &&
        approx(interceptMove, shift, 1e-9) &&
        approx(crushed.intercept, targetMean, 1e-6) &&
        crushedSlopeNorm < 1e-6,
      detail: `slope drift=${slopeDrift.toExponential(2)}, intercept moved ${interceptMove.toFixed(9)}, crushed intercept minus mean=${(crushed.intercept - targetMean).toExponential(2)}`,
    }
  },

  () => {
    // A duplicated column and an all-zero column make the Gram matrix
    // singular (rank 3 of 5). With lambda > 0 the penalised system is still
    // positive definite, so the fit must be finite, the two identical
    // columns must share the weight equally (the ridge minimiser is unique
    // and symmetric in them), and a column with no variation must get zero
    // weight. At lambda = 0 the pivoted fallback must still return a finite
    // fit that reproduces the noise-free target.
    const { features, targets } = ridgeFixture()
    const singular = features.map(([x0, x1, x2]) => [x0, x1, x2, x0, 0])
    const model = fitRidge(singular, targets, 1)
    const finite = Number.isFinite(model.intercept) && model.coefficients.every(Number.isFinite)
    const duplicatesShare = approx(model.coefficients[0], model.coefficients[3], 1e-9)
    const flatColumnZero = approx(model.coefficients[4], 0, 1e-12)
    const inSampleError = Math.max(...singular.map((row, i) => Math.abs(model.predict(row) - targets[i])))
    const unpenalised = fitRidge(singular, targets, 0)
    const fallbackFinite = Number.isFinite(unpenalised.intercept) && unpenalised.coefficients.every(Number.isFinite)
    const fallbackError = Math.max(...singular.map((row, i) => Math.abs(unpenalised.predict(row) - targets[i])))
    return {
      name: 'Ridge handles a singular Gram matrix: finite at lambda>0, pivoted fallback at lambda=0',
      passed: finite && duplicatesShare && flatColumnZero && inSampleError < 0.25 && fallbackFinite && fallbackError < 1e-8,
      detail: `lambda=1 coefficients=[${model.coefficients.map((c) => c.toFixed(4)).join(', ')}], max in-sample error=${inSampleError.toFixed(4)}; lambda=0 coefficients=[${unpenalised.coefficients.map((c) => c.toFixed(4)).join(', ')}], max error=${fallbackError.toExponential(2)}`,
    }
  },

  () => {
    // The hat-matrix leave-one-out shortcut (Allen 1974; ESL equation 7.64)
    // must agree with brute-force refits that drop one row at a time,
    // including the intercept's 1/n share of the leverage. The chosen
    // lambda must be a grid point with the lowest held-out error, and the
    // returned model must equal a direct fit at that lambda.
    const n = 40
    const features: number[][] = []
    const targets: number[] = []
    for (let i = 0; i < n; i++) {
      const x0 = quasiUniform(i * 3 + 1) * 2 - 1
      const x1 = quasiUniform(i * 3 + 2) * 2 - 1
      const x2 = quasiUniform(i * 3 + 3) * 2 - 1
      const noise = (quasiUniform(i, 1) - 0.5) * 2
      features.push([x0, x1, x2])
      targets.push(0.5 * x0 - 0.3 * x1 + noise)
    }
    const model = fitRidge(features, targets)
    const selection = model.lambdaSelection
    const name = 'Ridge leave-one-out matches brute-force refits and picks the grid minimum'
    if (selection.method !== 'leave-one-out') {
      return { name, passed: false, detail: `lambda selection method was ${selection.method}` }
    }
    let maxRelativeGap = 0
    for (const point of selection.grid) {
      let press = 0
      for (let holdOut = 0; holdOut < n; holdOut++) {
        const trainX = features.filter((_, i) => i !== holdOut)
        const trainY = targets.filter((_, i) => i !== holdOut)
        const refit = fitRidge(trainX, trainY, point.lambda)
        press += (refit.predict(features[holdOut]) - targets[holdOut]) ** 2
      }
      const bruteForce = press / n
      maxRelativeGap = Math.max(maxRelativeGap, Math.abs(bruteForce - point.leaveOneOutMse) / bruteForce)
    }
    const chosen = selection.grid.find((point) => point.lambda === model.lambda)
    const onGrid = chosen !== undefined && RIDGE_LAMBDA_GRID_MULTIPLIERS.some((m) => m * 3 === model.lambda)
    const isMinimum = chosen !== undefined && selection.grid.every((point) => point.leaveOneOutMse >= chosen.leaveOneOutMse)
    const direct = fitRidge(features, targets, model.lambda)
    const sameFit =
      approx(direct.intercept, model.intercept, 1e-12) &&
      direct.coefficients.every((c, j) => approx(c, model.coefficients[j], 1e-12))
    return {
      name,
      passed: maxRelativeGap < 1e-8 && onGrid && isMinimum && sameFit,
      detail: `max relative gap vs brute force=${maxRelativeGap.toExponential(2)}, chosen lambda=${model.lambda}, grid=${selection.grid.map((point) => `${point.lambda}:${point.leaveOneOutMse.toFixed(4)}`).join(' ')}`,
    }
  },

  () => {
    // Two cases where the leave-one-out choice is forced by construction. A
    // noise-free linear target has bias as its only held-out error, and that
    // bias grows with lambda, so the smallest grid point must win. A target
    // the centred features cannot explain at all (noise residualised against
    // them, so Xc'y = 0) has ridge coefficients of zero at every lambda and a
    // held-out error of y_i / (1 - S_ii), which falls as lambda shrinks the
    // leverage S_ii, so the largest grid point must win.
    const { features, targets } = ridgeFixture()
    const clean = fitRidge(features, targets)
    const noise = targets.map((_, i) => (quasiUniform(i, 1) - 0.5) * 4)
    const noiseFit = fitRidge(features, noise, 0)
    const unexplainable = noise.map((value, i) => value - noiseFit.predict(features[i]))
    const hopeless = fitRidge(features, unexplainable)
    const p = 3
    const smallestOnGrid = RIDGE_LAMBDA_GRID_MULTIPLIERS[0] * p
    const largestOnGrid = RIDGE_LAMBDA_GRID_MULTIPLIERS[RIDGE_LAMBDA_GRID_MULTIPLIERS.length - 1] * p
    const hopelessSlopeNorm = Math.hypot(...hopeless.coefficients)
    return {
      name: 'Ridge leave-one-out picks least shrinkage for a clean signal and most for an unexplainable target',
      passed: clean.lambda === smallestOnGrid && hopeless.lambda === largestOnGrid && hopelessSlopeNorm < 1e-9,
      detail: `clean lambda=${clean.lambda}, unexplainable lambda=${hopeless.lambda}, its slope norm=${hopelessSlopeNorm.toExponential(2)}`,
    }
  },
]

let alreadyRun = false

export function runQuantSelfTests(): TestResult[] {
  if (alreadyRun) return []
  alreadyRun = true
  testRandomState = 0x6f726163
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
