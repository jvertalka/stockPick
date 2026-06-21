/**
 * Self-tests for selection-inflation stats. Expectations are hand-computed
 * (BH step-up by hand; PSR via Φ of a closed-form z) so they're independent of
 * the implementation's own arithmetic.
 */
import {
  benjaminiHochberg,
  probabilisticSharpeRatio,
  expectedMaxSharpe,
  deflatedSharpeRatio,
} from './selectionStats'

type TestResult = { name: string; passed: boolean; detail?: string }
function approx(a: number, b: number, tol = 2e-3): boolean {
  return Math.abs(a - b) < tol
}

export function runSelectionStatsTests(): TestResult[] {
  const r: TestResult[] = []

  // BH-A: partial rejection. p=[.001,.01,.5,.7,.9], m=5, q=.05.
  // step-up: .001<=.01✓ .01<=.02✓ .5<=.03✗ => kMax=2 => reject first two.
  {
    const mask = benjaminiHochberg([0.001, 0.01, 0.5, 0.7, 0.9], 0.05)
    const ok = JSON.stringify(mask) === JSON.stringify([true, true, false, false, false])
    r.push({ name: 'BH: partial rejection (2 of 5)', passed: ok, detail: ok ? undefined : JSON.stringify(mask) })
  }
  // BH-B: order preserved when input is shuffled. Same values, different order.
  {
    const mask = benjaminiHochberg([0.5, 0.001, 0.9, 0.01, 0.7], 0.05)
    const ok = JSON.stringify(mask) === JSON.stringify([false, true, false, true, false])
    r.push({ name: 'BH: rejection mask tracks input order', passed: ok, detail: ok ? undefined : JSON.stringify(mask) })
  }
  // BH-C: nothing significant => all false.
  {
    const mask = benjaminiHochberg([0.4, 0.6, 0.8, 0.95], 0.1)
    const ok = mask.every((x) => !x)
    r.push({ name: 'BH: no discoveries when all p large', passed: ok, detail: ok ? undefined : JSON.stringify(mask) })
  }

  // PSR-A: srHat=0 => z=0 => PSR(0)=0.5 exactly.
  {
    const psr = probabilisticSharpeRatio(0, 100, 0, 0, 0)
    r.push({ name: 'PSR: zero Sharpe => 0.5', passed: approx(psr, 0.5), detail: `${psr}` })
  }
  // PSR-B: srHat=0.2, n=101, normal. denomVar=1.02, z=2/√1.02=1.9803, Φ≈0.9762.
  {
    const psr = probabilisticSharpeRatio(0.2, 101, 0, 0, 0)
    r.push({ name: 'PSR: 0.2 Sharpe over 101 obs ≈ 0.976', passed: approx(psr, 0.9762, 3e-3), detail: `${psr}` })
  }
  // PSR-C: monotone increasing in srHat.
  {
    const lo = probabilisticSharpeRatio(0.1, 80, 0, 0, 0)
    const hi = probabilisticSharpeRatio(0.3, 80, 0, 0, 0)
    r.push({ name: 'PSR: increasing in Sharpe', passed: hi > lo && lo > 0.5, detail: `lo=${lo.toFixed(3)} hi=${hi.toFixed(3)}` })
  }

  // EMax-A: increasing in trial count.
  {
    const few = expectedMaxSharpe(10, 0.01)
    const many = expectedMaxSharpe(200, 0.01)
    r.push({ name: 'expectedMaxSharpe: rises with N', passed: many > few && few > 0, detail: `N10=${few.toFixed(3)} N200=${many.toFixed(3)}` })
  }
  // EMax-B: hand value. N=10, varSr=0.01 => √v=0.1; a=Φ⁻¹(0.9)=1.2816,
  // b=Φ⁻¹(0.96321)=1.7905; 0.1*((0.4228)(1.2816)+(0.5772)(1.7905))≈0.1575.
  {
    const e = expectedMaxSharpe(10, 0.01)
    r.push({ name: 'expectedMaxSharpe: N=10 ≈ 0.158', passed: approx(e, 0.158, 8e-3), detail: `${e}` })
  }

  // DSR-A: deflating raises the bar, so DSR < PSR(0).
  {
    const { dsr, psr0, sr0 } = deflatedSharpeRatio({ srHat: 0.25, n: 70, skew: -0.3, exKurt: 2, nTrials: 50, varSrAcrossTrials: 0.02 })
    const ok = sr0 > 0 && dsr < psr0 && dsr >= 0 && dsr <= 1
    r.push({ name: 'DSR: deflation lowers it below PSR(0)', passed: ok, detail: `sr0=${sr0.toFixed(3)} psr0=${psr0.toFixed(3)} dsr=${dsr.toFixed(3)}` })
  }
  // DSR-B: more trials => lower DSR (harder to beat the max-of-N bar).
  {
    const a = deflatedSharpeRatio({ srHat: 0.25, n: 70, skew: 0, exKurt: 0, nTrials: 10, varSrAcrossTrials: 0.02 }).dsr
    const b = deflatedSharpeRatio({ srHat: 0.25, n: 70, skew: 0, exKurt: 0, nTrials: 500, varSrAcrossTrials: 0.02 }).dsr
    r.push({ name: 'DSR: falls as trial count grows', passed: b < a, detail: `N10=${a.toFixed(3)} N500=${b.toFixed(3)}` })
  }

  return r
}
