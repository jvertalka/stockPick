/**
 * Self-tests for calibration + sizing. Expectations hand-computed (PAVA pools
 * by hand; Brier by the closed form; Kelly by f=λμ/σ²).
 */
import {
  isotonicRegression,
  applyIsotonic,
  brierScore,
  fractionalKelly,
} from './calibration'

type TestResult = { name: string; passed: boolean; detail?: string }
function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) < tol
}

export function runCalibrationTests(): TestResult[] {
  const r: TestResult[] = []

  // ISO-A: already monotone → unchanged.
  {
    const f = isotonicRegression([1, 2, 3], [0.1, 0.2, 0.3])
    const ok = approx(f.y[0], 0.1) && approx(f.y[1], 0.2) && approx(f.y[2], 0.3)
    r.push({ name: 'isotonic: monotone input unchanged', passed: ok, detail: JSON.stringify(f.y) })
  }
  // ISO-B: violator pooled. y=[.1,.5,.3] → per-point fitted [.1,.4,.4], and
  // the calibrated value at the pooled x=2 must be .4 (not interpolated 0.25).
  {
    const f = isotonicRegression([1, 2, 3], [0.1, 0.5, 0.3])
    const ok =
      approx(f.y[0], 0.1) && approx(f.y[1], 0.4) && approx(f.y[2], 0.4) &&
      approx(applyIsotonic(f, 2), 0.4)
    r.push({ name: 'isotonic: pools adjacent violators', passed: ok, detail: JSON.stringify(f.y) })
  }
  // ISO-C: fully decreasing → single block at the mean.
  {
    const f = isotonicRegression([1, 2, 3], [3, 2, 1])
    const ok = f.y.every((v) => approx(v, 2))
    r.push({ name: 'isotonic: decreasing → pooled mean', passed: ok, detail: JSON.stringify(f.y) })
  }
  // APP-A: linear interpolation between knots.
  {
    const f = { x: [1, 2, 3], y: [0.1, 0.4, 0.4] }
    const ok =
      approx(applyIsotonic(f, 1.5), 0.25) &&
      approx(applyIsotonic(f, 0), 0.1) &&
      approx(applyIsotonic(f, 5), 0.4) &&
      approx(applyIsotonic(f, 2.5), 0.4)
    r.push({ name: 'applyIsotonic: interpolate + clamp', passed: ok })
  }
  // APP-B: empty fit → 0.5.
  {
    const ok = approx(applyIsotonic({ x: [], y: [] }, 0.3), 0.5)
    r.push({ name: 'applyIsotonic: empty → 0.5', passed: ok })
  }

  // BRIER
  {
    const ok =
      approx(brierScore([1, 0], [1, 0]), 0) &&
      approx(brierScore([0.5, 0.5], [1, 0]), 0.25) &&
      approx(brierScore([0, 1], [1, 0]), 1)
    r.push({ name: 'brierScore: perfect/half/wrong', passed: ok })
  }

  // KELLY
  {
    const ok =
      approx(fractionalKelly(0.02, 0.2, 0.5), 0.25) &&
      approx(fractionalKelly(0.1, 0.2, 0.5, 1), 1) && // 1.25 clamped to cap 1
      approx(fractionalKelly(-0.02, 0.2, 0.5), -0.25) &&
      fractionalKelly(0.02, 0, 0.5) === 0 &&
      fractionalKelly(Number.NaN, 0.2, 0.5) === 0
    r.push({ name: 'fractionalKelly: f=λμ/σ², clamp, guards', passed: ok })
  }

  return r
}
