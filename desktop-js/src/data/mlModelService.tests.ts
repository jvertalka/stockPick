/**
 * Self-tests for SERVE-TIME CROSS-SECTIONAL normalization (Improvement #2).
 *
 * crossSectionalNormalizeServingBatch is the live counterpart of training's
 * imputeMissingWithDateMedians + applyCrossSectionalNormalization. These
 * cases use HAND-COMPUTED expectations (medians, means, stds worked out by
 * hand) so they are independent of the implementation's own arithmetic — a
 * copy-the-logic reference would not catch a logic bug.
 *
 * Coverage: basic cross-sectional Z, small-batch frozen fallback, NaN→median
 * imputation, all-missing-column frozen fallback, and the centering property
 * (cross-sectional Z-scores sum to ~0) that makes live forecasts comparable.
 */
import {
  computeLiveScorecard,
  crossSectionalNormalizeServingBatch,
  type LoggedPrediction,
} from './mlModelService'

type TestResult = { name: string; passed: boolean; detail?: string }

function approx(a: number, b: number, tol = 1e-7): boolean {
  return Math.abs(a - b) < tol
}

export function runServingNormTests(): TestResult[] {
  const results: TestResult[] = []
  const SQRT2 = Math.SQRT2

  // A — basic cross-sectional Z-score (no missing, breadth met).
  // column [1,2,3,4,5]: mean 3, variance 2, std √2.
  {
    const raw = new Map<string, number[]>([
      ['A', [1]], ['B', [2]], ['C', [3]], ['D', [4]], ['E', [5]],
    ])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [0], stds: [1] })
    const ok =
      approx(out.get('A')![0], -SQRT2) &&
      approx(out.get('B')![0], -SQRT2 / 2) &&
      approx(out.get('C')![0], 0) &&
      approx(out.get('E')![0], SQRT2)
    results.push({
      name: 'A: cross-sectional Z-score',
      passed: ok,
      detail: ok ? undefined : `A=${out.get('A')![0]} C=${out.get('C')![0]} E=${out.get('E')![0]}`,
    })
  }

  // B — small-batch (< CROSS_SECTION_MIN_BREADTH=5) falls back to frozen
  // stats. frozen mean 10, std 5: (10,20,30) -> (0, 2, 4).
  {
    const raw = new Map<string, number[]>([['A', [10]], ['B', [20]], ['C', [30]]])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [10], stds: [5] })
    const ok =
      approx(out.get('A')![0], 0) && approx(out.get('B')![0], 2) && approx(out.get('C')![0], 4)
    results.push({
      name: 'B: small-batch frozen fallback',
      passed: ok,
      detail: ok ? undefined : `A=${out.get('A')![0]} B=${out.get('B')![0]} C=${out.get('C')![0]}`,
    })
  }

  // C — NaN imputes to the cross-sectional MEDIAN, then Z-scores over the
  // completed column. present=[1,2,4,5] -> median 4; imputed=[1,2,4,4,5];
  // mean 3.2, variance 2.16, std √2.16.
  {
    const raw = new Map<string, number[]>([
      ['A', [1]], ['B', [2]], ['C', [Number.NaN]], ['D', [4]], ['E', [5]],
    ])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [0], stds: [1] })
    const std = Math.sqrt(2.16)
    const ok =
      approx(out.get('C')![0], (4 - 3.2) / std) &&
      approx(out.get('A')![0], (1 - 3.2) / std) &&
      approx(out.get('E')![0], (5 - 3.2) / std)
    results.push({
      name: 'C: NaN -> cross-sectional median impute',
      passed: ok,
      detail: ok ? undefined : `C=${out.get('C')![0]} expected=${(4 - 3.2) / std}`,
    })
  }

  // D — a feature missing for EVERY name has no live cross-section, so it
  // falls back to frozen for that column only. Column 1 frozen mean 7 ->
  // every NaN imputes to 7 -> Z 0. Column 0 still cross-sectional.
  {
    const raw = new Map<string, number[]>([
      ['A', [1, Number.NaN]], ['B', [2, Number.NaN]], ['C', [3, Number.NaN]],
      ['D', [4, Number.NaN]], ['E', [5, Number.NaN]],
    ])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [0, 7], stds: [1, 2] })
    const col1AllZero = ['A', 'B', 'C', 'D', 'E'].every((t) => approx(out.get(t)![1], 0))
    const col0Ok = approx(out.get('A')![0], -SQRT2) && approx(out.get('E')![0], SQRT2)
    const ok = col1AllZero && col0Ok
    results.push({
      name: 'D: all-missing column -> frozen fallback',
      passed: ok,
      detail: ok ? undefined : `col1AllZero=${col1AllZero} col0Ok=${col0Ok}`,
    })
  }

  // E — cross-sectional output is centered: the Z-scores across the batch
  // sum to ~0. This is the property that makes live "+x% vs peers" forecasts
  // comparable and prevents a frozen-mean offset from skewing every name.
  {
    const raw = new Map<string, number[]>([
      ['A', [3]], ['B', [7]], ['C', [11]], ['D', [13]], ['E', [17]], ['F', [19]],
    ])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [0], stds: [1] })
    let sum = 0
    for (const v of out.values()) sum += v[0]
    const ok = Math.abs(sum) < 1e-7
    results.push({
      name: 'E: cross-section centered (sum Z ~ 0)',
      passed: ok,
      detail: ok ? undefined : `sum=${sum}`,
    })
  }

  // F — a ±Infinity raw value is treated as MISSING (non-finite), imputed to
  // the cross-sectional median, and does NOT poison the whole column to NaN.
  // Same column as C once Infinity is dropped: present=[1,2,4,5] median 4.
  {
    const raw = new Map<string, number[]>([
      ['A', [1]], ['B', [2]], ['C', [Number.POSITIVE_INFINITY]], ['D', [4]], ['E', [5]],
    ])
    const out = crossSectionalNormalizeServingBatch(raw, { means: [0], stds: [1] })
    const std = Math.sqrt(2.16)
    const noNaN = ['A', 'B', 'C', 'D', 'E'].every((t) => Number.isFinite(out.get(t)![0]))
    const ok =
      noNaN &&
      approx(out.get('C')![0], (4 - 3.2) / std) &&
      approx(out.get('A')![0], (1 - 3.2) / std)
    results.push({
      name: 'F: Infinity treated as missing (no column poisoning)',
      passed: ok,
      detail: ok ? undefined : `noNaN=${noNaN} C=${out.get('C')![0]}`,
    })
  }

  return results
}

/* =========================================================================
   Live prediction scorecard tests — hand-computed expectations.

   The load-bearing case is S2: the OLD live-IC pooled every realized entry
   across dates and correlated relative forecasts against absolute returns,
   so a market-wide move injected correlation the model never earned. The
   hand-worked numbers show pooled r ≈ 0.849 on data whose true within-date
   IC is exactly 0 — the per-date scorecard must report 0.
   ========================================================================= */

function entry(
  ticker: string,
  asOf: string,
  predicted: number,
  realized?: number,
  p10?: number,
  p90?: number,
): LoggedPrediction {
  return {
    ticker,
    asOf,
    predictedReturn20d: predicted,
    realizedReturn20d: realized,
    p10Return20d: p10,
    p90Return20d: p90,
  }
}

export function runScorecardTests(): TestResult[] {
  const results: TestResult[] = []

  // S1 — per-date perfect monotone agreement, with a +8% market shift on the
  // second date. Per-date IC is 1 on both days regardless of the shift.
  {
    const log: LoggedPrediction[] = []
    const preds = [1, 2, 3, 4, 5]
    preds.forEach((p, i) => log.push(entry(`A${i}`, '2026-01-05', p, 2 * p)))
    preds.forEach((p, i) => log.push(entry(`A${i}`, '2026-01-06', p, 2 * p + 8)))
    const card = computeLiveScorecard(log)
    const ok =
      card.datesUsed === 2 &&
      card.realizedUsed === 10 &&
      card.meanIc != null && approx(card.meanIc, 1) &&
      card.meanRankIc != null && approx(card.meanRankIc, 1) &&
      card.hitRate != null && approx(card.hitRate, 1) &&
      card.windowOldest === '2026-01-05' &&
      card.windowNewest === '2026-01-06'
    results.push({
      name: 'S1: per-date IC immune to market drift',
      passed: ok,
      detail: ok ? undefined : `ic=${card.meanIc} rank=${card.meanRankIc} hit=${card.hitRate} dates=${card.datesUsed}`,
    })
  }

  // S2 — THE FIXED BUG. Within each date the prediction has EXACTLY zero
  // correlation with the outcome. But the model was more bullish on date 2
  // AND the whole market rose +8% that day, so the old pooled calculation
  // reads r = 100/√(82.5·168) ≈ 0.849 — confidence the model never earned.
  {
    const d1p = [-2, -1, 0, 1, 2]
    const d1a = [1, -1, 0, -1, 1]        // cov vs d1p = 0 by hand
    const d2p = [3, 4, 5, 6, 7]
    const d2a = [9, 7, 8, 7, 9]          // demeaned [1,-1,0,-1,1]; cov = 0
    const log: LoggedPrediction[] = []
    d1p.forEach((p, i) => log.push(entry(`B${i}`, '2026-02-02', p, d1a[i])))
    d2p.forEach((p, i) => log.push(entry(`B${i}`, '2026-02-03', p, d2a[i])))
    const card = computeLiveScorecard(log)
    // Reproduce the old pooled number inline to prove the contrast.
    const all = log
    const pm = all.reduce((s, e) => s + e.predictedReturn20d, 0) / all.length
    const am = all.reduce((s, e) => s + e.realizedReturn20d!, 0) / all.length
    let cov = 0, vp = 0, va = 0
    for (const e of all) {
      cov += (e.predictedReturn20d - pm) * (e.realizedReturn20d! - am)
      vp += (e.predictedReturn20d - pm) ** 2
      va += (e.realizedReturn20d! - am) ** 2
    }
    const pooled = cov / Math.sqrt(vp * va)
    const ok =
      card.meanIc != null && approx(card.meanIc, 0) &&
      approx(pooled, 100 / Math.sqrt(82.5 * 168), 1e-9) &&
      pooled > 0.8
    results.push({
      name: 'S2: pooled-absolute IC was spurious (0.849 on true-zero data); per-date reports 0',
      passed: ok,
      detail: ok ? undefined : `meanIc=${card.meanIc} pooled=${pooled}`,
    })
  }

  // S3 — breadth floor: a 4-name date has no meaningful cross-section.
  {
    const log = [1, 2, 3, 4].map((p, i) => entry(`C${i}`, '2026-03-02', p, p))
    const card = computeLiveScorecard(log)
    const ok =
      card.datesUsed === 0 && card.meanIc === null &&
      card.realizedTotal === 4 && card.realizedUsed === 0
    results.push({
      name: 'S3: dates below 5-name breadth floor are excluded',
      passed: ok,
      detail: ok ? undefined : `dates=${card.datesUsed} ic=${card.meanIc} total=${card.realizedTotal}`,
    })
  }

  // S4 — quintile spread, hand-worked: n=10, k=2; realized mean 2.8;
  // top-2 mean 4.5 → demeaned +1.7; bottom-2 mean 0.5 → demeaned −2.3;
  // spread = 4.0 exactly.
  {
    const preds = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    const acts = [5, 4, 3, 3, 3, 3, 3, 3, 1, 0]
    const log = preds.map((p, i) => entry(`D${i}`, '2026-04-06', p, acts[i]))
    const card = computeLiveScorecard(log)
    const ok = card.quintileSpreadPct != null && approx(card.quintileSpreadPct, 4.0)
    results.push({
      name: 'S4: top-vs-bottom quintile spread (hand-computed 4.0%)',
      passed: ok,
      detail: ok ? undefined : `spread=${card.quintileSpreadPct}`,
    })
  }

  // S5 — interval coverage against the DEMEANED realized return (the
  // relative units the quantile models were trained in): 3 of 5 covered.
  {
    const acts = [1, 2, 3, 4, 5] // mean 3 → demeaned [-2,-1,0,1,2]
    const bounds: Array<[number, number]> = [
      [-3, -1],   // covers −2
      [0, 1],     // misses −1
      [-1, 1],    // covers 0
      [0.5, 2],   // covers 1
      [3, 4],     // misses 2
    ]
    const log = acts.map((a, i) =>
      entry(`E${i}`, '2026-05-04', i + 1, a, bounds[i][0], bounds[i][1]),
    )
    const card = computeLiveScorecard(log)
    const ok =
      card.intervalSamples === 5 &&
      card.intervalCoverage != null && approx(card.intervalCoverage, 0.6)
    results.push({
      name: 'S5: 80%-interval coverage scored in demeaned units (3/5)',
      passed: ok,
      detail: ok ? undefined : `cov=${card.intervalCoverage} n=${card.intervalSamples}`,
    })
  }

  // S6 — pending accounting: nothing realized, nextEvaluable = earliest
  // asOf + 30 days.
  {
    const log = [
      entry('F0', '2026-06-25', 1),
      entry('F1', '2026-06-20', 2),
    ]
    const card = computeLiveScorecard(log)
    const ok =
      card.pendingTotal === 2 && card.datesUsed === 0 &&
      card.meanIc === null && card.nextEvaluable === '2026-07-20'
    results.push({
      name: 'S6: pending counts + first-scoreable date (asOf + 30d)',
      passed: ok,
      detail: ok ? undefined : `pending=${card.pendingTotal} next=${card.nextEvaluable}`,
    })
  }

  // S7 — a non-finite realized value drops that entry; the date then falls
  // below the breadth floor and is excluded entirely.
  {
    const log = [1, 2, 3, 4].map((p, i) => entry(`G${i}`, '2026-06-01', p, p))
    log.push(entry('G4', '2026-06-01', 5, Number.NaN))
    const card = computeLiveScorecard(log)
    const ok = card.datesUsed === 0 && card.realizedTotal === 4
    results.push({
      name: 'S7: non-finite realized values are filtered before breadth check',
      passed: ok,
      detail: ok ? undefined : `dates=${card.datesUsed} total=${card.realizedTotal}`,
    })
  }

  // S8 — recentDates caps at the 12 most recent participating dates.
  {
    const log: LoggedPrediction[] = []
    for (let d = 1; d <= 14; d++) {
      const date = `2026-01-${String(d).padStart(2, '0')}`
      ;[1, 2, 3, 4, 5].forEach((p, i) => log.push(entry(`H${i}`, date, p, p)))
    }
    const card = computeLiveScorecard(log)
    const ok =
      card.datesUsed === 14 &&
      card.recentDates.length === 12 &&
      card.recentDates[0].date === '2026-01-03' &&
      card.recentDates[11].date === '2026-01-14'
    results.push({
      name: 'S8: recent-dates list caps at 12, keeps the newest',
      passed: ok,
      detail: ok ? undefined : `dates=${card.datesUsed} recent=${card.recentDates.length} first=${card.recentDates[0]?.date}`,
    })
  }

  // S9 — rank IC handles ties via average ranks: tied predictions with tied
  // outcomes in the same places still score a perfect 1.
  {
    const preds = [1, 1, 2, 3, 4]
    const acts = [2, 2, 4, 6, 8]
    const log = preds.map((p, i) => entry(`I${i}`, '2026-03-09', p, acts[i]))
    const card = computeLiveScorecard(log)
    const ok = card.meanRankIc != null && approx(card.meanRankIc, 1)
    results.push({
      name: 'S9: rank IC with ties (average ranks)',
      passed: ok,
      detail: ok ? undefined : `rank=${card.meanRankIc}`,
    })
  }

  return results
}
