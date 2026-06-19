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
import { crossSectionalNormalizeServingBatch } from './mlModelService'

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
