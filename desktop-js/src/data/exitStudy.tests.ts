/**
 * Exit-study math tests — hand-computed expectations, independent of the
 * implementation's own arithmetic.
 */
import {
  classifyTransition,
  crossSectionMeanForward,
  detectEvents,
  forwardReturnPct,
  groupStats,
  mulberry32,
  pairMatrix,
  type StudyAction,
  type StudyDate,
} from './exitStudy'

type TestResult = { name: string; passed: boolean; detail?: string }

function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) < tol
}

function mkDate(date: string, rows: Array<[string, StudyAction, number]>): StudyDate {
  return {
    date,
    byTicker: new Map(rows.map(([ticker, action, lastPrice]) => [ticker, { ticker, action, lastPrice }])),
  }
}

export function runExitStudyTests(): TestResult[] {
  const results: TestResult[] = []

  // X1 — transition taxonomy, every side pairing.
  {
    const cases: Array<[StudyAction, StudyAction, string]> = [
      ['Buy Now', 'Sell', 'exit'],
      ['Accumulate', 'Trim', 'exit'],
      ['Buy Now', 'Hold', 'soften'],
      ['Hold', 'Buy Now', 'entry'],
      ['Sell', 'Accumulate', 'entry'],
      ['Watch', 'Avoid', 'warn'],
      ['Buy Now', 'Accumulate', 'stay-bullish'],
      ['Hold', 'Watch', 'stay-neutral'],
      ['Sell', 'Trim', 'stay-bearish'],
    ]
    const failed = cases.filter(([f, t, want]) => classifyTransition(f, t) !== want)
    results.push({
      name: 'X1: transition taxonomy',
      passed: failed.length === 0,
      detail: failed.map(([f, t, want]) => `${f}->${t} wanted ${want} got ${classifyTransition(f, t)}`).join('; '),
    })
  }

  // X2 — forward return from the sampled price series: 100 -> 110 = +10%.
  {
    const dates = [
      mkDate('2020-01-01', [['A', 'Hold', 100]]),
      mkDate('2020-01-08', [['A', 'Hold', 110]]),
    ]
    const r = forwardReturnPct(dates, 'A', 0, 1)
    const missing = forwardReturnPct(dates, 'B', 0, 1)
    results.push({
      name: 'X2: forward return +10%, missing ticker -> null',
      passed: r != null && approx(r, 10) && missing === null,
      detail: `r=${r} missing=${missing}`,
    })
  }

  // X3 — cross-section mean needs >=10 names; hand value with 10 names.
  // 9 names flat (0%), one +10% -> mean = 1%.
  {
    const row0: Array<[string, StudyAction, number]> = []
    const row1: Array<[string, StudyAction, number]> = []
    for (let i = 0; i < 9; i++) {
      row0.push([`F${i}`, 'Hold', 100])
      row1.push([`F${i}`, 'Hold', 100])
    }
    row0.push(['UP', 'Hold', 100])
    row1.push(['UP', 'Hold', 110])
    const dates = [mkDate('d0', row0), mkDate('d1', row1)]
    const m = crossSectionMeanForward(dates, 0, 1)
    // thin cross-section: only 9 names -> null
    const thin = crossSectionMeanForward(
      [mkDate('t0', row0.slice(0, 9)), mkDate('t1', row1.slice(0, 9))],
      0,
      1,
    )
    results.push({
      name: 'X3: cross-section mean (1%) + 10-name floor',
      passed: m != null && approx(m, 1) && thin === null,
      detail: `mean=${m} thin=${thin}`,
    })
  }

  // X4 — detectEvents demeans: the flipped name fell -10% while 9 peers were
  // flat, so cross-mean = -1% and its relative return = -9%.
  {
    const row0: Array<[string, StudyAction, number]> = [['X', 'Buy Now', 100]]
    const row1: Array<[string, StudyAction, number]> = [['X', 'Sell', 100]]
    const row2: Array<[string, StudyAction, number]> = [['X', 'Sell', 90]]
    for (let i = 0; i < 9; i++) {
      row0.push([`P${i}`, 'Hold', 50])
      row1.push([`P${i}`, 'Hold', 50])
      row2.push([`P${i}`, 'Hold', 50])
    }
    const dates = [mkDate('d0', row0), mkDate('d1', row1), mkDate('d2', row2)]
    const events = detectEvents(dates, [1])
    const exit = events.find((e) => e.ticker === 'X' && e.dateIndex === 1)
    const ok =
      exit != null &&
      exit.kind === 'exit' &&
      exit.relForward[1] != null &&
      approx(exit.relForward[1]!, -9)
    results.push({
      name: 'X4: exit event demeaned vs peers (-9%)',
      passed: ok,
      detail: exit ? `kind=${exit.kind} rel=${exit.relForward[1]}` : 'event missing',
    })
  }

  // X5 — groupStats mean/median/n/dates; CI suppressed under 8 date clusters.
  {
    const events = [
      { ticker: 'A', date: 'd1', dateIndex: 1, from: 'Buy Now' as StudyAction, to: 'Sell' as StudyAction, kind: 'exit' as const, relForward: { 1: -4 } },
      { ticker: 'B', date: 'd1', dateIndex: 1, from: 'Buy Now' as StudyAction, to: 'Trim' as StudyAction, kind: 'exit' as const, relForward: { 1: -2 } },
      { ticker: 'C', date: 'd2', dateIndex: 2, from: 'Accumulate' as StudyAction, to: 'Avoid' as StudyAction, kind: 'exit' as const, relForward: { 1: 3 } },
    ]
    const s = groupStats(events, 'exit', 1)
    const ok =
      s.n === 3 &&
      s.dates === 2 &&
      s.meanRelPct != null && approx(s.meanRelPct, -1) &&
      s.medianRelPct != null && approx(s.medianRelPct, -2) &&
      s.ci95 === null
    results.push({
      name: 'X5: group stats (mean -1, median -2, CI suppressed <8 dates)',
      passed: ok,
      detail: `n=${s.n} dates=${s.dates} mean=${s.meanRelPct} med=${s.medianRelPct} ci=${s.ci95}`,
    })
  }

  // X6 — bootstrap: deterministic under a seed, and the CI brackets the mean
  // on a 10-cluster set.
  {
    const events = []
    for (let d = 0; d < 10; d++) {
      events.push({
        ticker: `T${d}`, date: `day${d}`, dateIndex: d + 1,
        from: 'Buy Now' as StudyAction, to: 'Sell' as StudyAction, kind: 'exit' as const,
        relForward: { 1: d % 2 === 0 ? -3 : 1 }, // mean = -1
      })
    }
    const a = groupStats(events, 'exit', 1, 500, 7)
    const b = groupStats(events, 'exit', 1, 500, 7)
    const ok =
      a.ci95 != null && b.ci95 != null &&
      approx(a.ci95[0], b.ci95[0]) && approx(a.ci95[1], b.ci95[1]) &&
      a.meanRelPct != null && approx(a.meanRelPct, -1) &&
      a.ci95[0] <= -1 && -1 <= a.ci95[1]
    results.push({
      name: 'X6: cluster bootstrap deterministic + brackets the mean',
      passed: ok,
      detail: a.ci95 ? `ci=[${a.ci95[0].toFixed(3)}, ${a.ci95[1].toFixed(3)}]` : 'no CI',
    })
  }

  // X7 — mulberry32 outputs stay in [0,1) and repeat under the same seed.
  {
    const r1 = mulberry32(123)
    const r2 = mulberry32(123)
    let ok = true
    for (let i = 0; i < 100; i++) {
      const v1 = r1()
      const v2 = r2()
      if (v1 !== v2 || v1 < 0 || v1 >= 1) ok = false
    }
    results.push({ name: 'X7: PRNG deterministic in [0,1)', passed: ok })
  }

  // X8 — pair matrix counts exact from→to pairs, skips stays.
  {
    const events = [
      { ticker: 'A', date: 'd1', dateIndex: 1, from: 'Buy Now' as StudyAction, to: 'Sell' as StudyAction, kind: 'exit' as const, relForward: { 1: -4 } },
      { ticker: 'B', date: 'd2', dateIndex: 2, from: 'Buy Now' as StudyAction, to: 'Sell' as StudyAction, kind: 'exit' as const, relForward: { 1: -2 } },
      { ticker: 'C', date: 'd2', dateIndex: 2, from: 'Hold' as StudyAction, to: 'Hold' as StudyAction, kind: 'stay-neutral' as const, relForward: { 1: 5 } },
    ]
    const pairs = pairMatrix(events, 1)
    const ok =
      pairs.length === 1 &&
      pairs[0].from === 'Buy Now' && pairs[0].to === 'Sell' &&
      pairs[0].n === 2 && approx(pairs[0].meanRelPct, -3)
    results.push({
      name: 'X8: pair matrix (Buy Now→Sell ×2, mean -3)',
      passed: ok,
      detail: JSON.stringify(pairs),
    })
  }

  return results
}
