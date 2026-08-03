/** Focused tests for evidence-vs-baseline CIs and fail-closed model promotion. */
import {
  applyCrossSectionalNormalization,
  assessModelPromotion,
  buildHistoricalDataset,
  computeBaselineEvidence,
  imputeMissingWithDateMedians,
  measuredOverlapBlockLength,
  type BacktestDatasetQuality,
  type HistoricalSample,
} from './historicalBacktest'

type TestResult = { name: string; passed: boolean; detail?: string }

function overlapDates(index: number) {
  const start = new Date(Date.UTC(2020, 0, 1 + index * 7))
  const labelEnd = new Date(start.getTime() + 20 * 86_400_000)
  return {
    testStartDate: start.toISOString().slice(0, 10),
    testLabelEndDate: labelEnd.toISOString().slice(0, 10),
  }
}

function completeQuality(): BacktestDatasetQuality {
  return {
    schemaVersion: 1,
    universe: {
      pointInTimeMembership: true,
      includesDelistedSecurities: true,
      includesDelistingReturns: true,
      survivorshipBiasControlled: true,
      intendedMemberCount: 10,
      membersWithUsablePriceHistory: 10,
      membersWithExplicitNoHistoryOutcome: 0,
      memberOutcomeCoverage: 1,
      limitation: 'complete',
    },
    returns: {
      labelPriceField: 'close',
      labelAdjustment: 'total-return',
      barsObserved: 100,
      sourceRowsObserved: 100,
      sourceInvalidRawBars: 0,
      sourceRowAcceptanceCoverage: 1,
      sourceEligibleRawBars: 100,
      sourceMissingAdjustedBars: 0,
      sourceAdjustmentCoverage: 1,
      barsWithAdjustedCloseAvailable: 100,
      adjustedCloseAvailabilityCoverage: 1,
      adjustedReturnLabelCoverage: 1,
      totalReturnLabelCoverage: 1,
      dividendsIncludedInLabels: true,
      limitation: 'complete',
    },
    fundamentals: {
      source: 'SEC EDGAR XBRL companyfacts',
      alignedByFiledDate: true,
      tickersWithTimeline: 10,
      usableTickers: 10,
      tickerTimelineCoverage: 1,
      samplesWithPointInTimeSnapshot: 100,
      totalSamples: 100,
      sampleSnapshotCoverage: 1,
      observedFeatureCells: 1300,
      totalFeatureCells: 1300,
      observedFeatureCellCoverage: 1,
      limitation: 'complete',
    },
    evaluation: {
      purgedWalkForwardSupported: true,
      embargoSupported: true,
      foldLocalPreprocessing: true,
      lockedPostSelectionHoldout: true,
      limitation: 'complete',
    },
  }
}

function strongEvidence() {
  return computeBaselineEvidence(
    Array.from({ length: 12 }, (_, index) => ({
      informationCoefficient: 0.12 + index * 0.001,
      baselineRandomIc: 0.01 + index * 0.0002,
      baselineMomentumIc: 0.04 + index * 0.0003,
      ...overlapDates(index),
    })),
    1000,
  )
}

export async function runHistoricalBacktestQualityTests(): Promise<TestResult[]> {
  const results: TestResult[] = []

  {
    const evidence = strongEvidence()
    const passed =
      evidence.random.pairedStepCount === 12 &&
      evidence.momentum.pairedStepCount === 12 &&
      evidence.random.ciClearOfZero &&
      evidence.momentum.ciClearOfZero &&
      (evidence.random.ci95?.lower ?? 0) > 0 &&
      (evidence.momentum.ci95?.lower ?? 0) > 0
    results.push({
      name: 'baseline evidence: paired bootstrap CIs clear zero for proven edge',
      passed,
      detail: passed ? undefined : JSON.stringify(evidence),
    })
  }

  {
    const first = strongEvidence()
    const second = strongEvidence()
    const passed = JSON.stringify(first) === JSON.stringify(second)
    results.push({
      name: 'baseline evidence: identical data produces identical bootstrap CIs',
      passed,
      detail: passed ? undefined : `${JSON.stringify(first)} != ${JSON.stringify(second)}`,
    })
  }

  {
    const evidence = computeBaselineEvidence(
      Array.from({ length: 10 }, (_, index) => ({
        informationCoefficient: 0.01,
        baselineRandomIc: 0.03 + index * 0.001,
        baselineMomentumIc: Number.NaN,
        ...overlapDates(index),
      })),
      100,
    )
    const passed =
      !evidence.random.ciClearOfZero &&
      evidence.momentum.pairedStepCount === 0 &&
      evidence.momentum.ci95 === null &&
      !evidence.momentum.ciClearOfZero
    results.push({
      name: 'baseline evidence: negative or unavailable edge never passes',
      passed,
      detail: passed ? undefined : JSON.stringify(evidence),
    })
  }

  {
    const steps = Array.from({ length: 8 }, (_, index) => overlapDates(index))
    const measured = measuredOverlapBlockLength(steps)
    const passed = measured === 3
    results.push({
      name: 'baseline evidence: block length is measured from exact label overlap',
      passed,
      detail: passed ? undefined : `measured=${measured}`,
    })
  }

  {
    const quality = completeQuality()
    quality.universe.pointInTimeMembership = false
    quality.universe.includesDelistedSecurities = false
    quality.universe.includesDelistingReturns = false
    quality.universe.survivorshipBiasControlled = false
    quality.universe.limitation = 'current survivors only'
    quality.evaluation.lockedPostSelectionHoldout = false
    quality.evaluation.limitation = 'no locked holdout'
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable &&
      assessment.status === 'advisory-only' &&
      assessment.blockerCodes.includes('POINT_IN_TIME_UNIVERSE_AND_DELISTINGS') &&
      assessment.blockerCodes.includes('LOCKED_POST_SELECTION_HOLDOUT') &&
      assessment.reasons.every((reason) => reason.title.length > 0 && reason.detail.length > 0)
    results.push({
      name: 'promotion: current-universe and no locked holdout are hard blockers',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment),
    })
  }

  {
    const assessment = assessModelPromotion(completeQuality(), strongEvidence())
    const passed =
      assessment.promotable &&
      assessment.status === 'promotable' &&
      assessment.blockerCodes.length === 0 &&
      assessment.reasons.every((reason) => reason.status === 'pass')
    results.push({
      name: 'promotion: complete provenance plus both positive baseline CIs passes',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment),
    })
  }

  {
    const quality = completeQuality()
    quality.evaluation.foldLocalPreprocessing = false
    quality.evaluation.limitation = 'global fallback statistics are fit before folds'
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable &&
      assessment.blockerCodes.includes('FOLD_LOCAL_PREPROCESSING')
    results.push({
      name: 'promotion: dataset-wide preprocessing is a hard blocker',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment),
    })
  }

  {
    const quality = completeQuality()
    quality.returns.labelAdjustment = 'unadjusted-close'
    quality.returns.adjustedReturnLabelCoverage = 0
    quality.returns.totalReturnLabelCoverage = 0
    quality.returns.dividendsIncludedInLabels = false
    quality.returns.limitation = 'raw close labels'
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable && assessment.blockerCodes.includes('TOTAL_RETURN_LABELS')
    results.push({
      name: 'promotion: raw-close returns are a hard blocker',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment),
    })
  }

  {
    const quality = completeQuality()
    quality.returns.sourceEligibleRawBars = 101
    quality.returns.sourceMissingAdjustedBars = 1
    quality.returns.sourceAdjustmentCoverage = 100 / 101
    quality.returns.limitation = 'one otherwise-valid source row lacked adjclose'
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable && assessment.blockerCodes.includes('TOTAL_RETURN_LABELS')
    results.push({
      name: 'promotion: incomplete source adjustment coverage fails closed',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment),
    })
  }

  {
    let rejected = false
    try {
      await buildHistoricalDataset(['BRK.B', 'brk/b'])
    } catch (error) {
      rejected = error instanceof Error && /provider aliases/.test(error.message)
    }
    results.push({
      name: 'dataset universe: Yahoo-equivalent aliases are rejected before fetch',
      passed: rejected,
      detail: rejected ? undefined : 'BRK.B and BRK/B were not rejected as duplicates',
    })
  }

  // --- Causal preprocessing (the fixed promotion BLOCK) -------------------
  // The fallback statistics used to pool over ALL dates; these tests pin the
  // causal behavior with hand-computed values AND prove future data cannot
  // reach past samples.
  const preprocSample = (asOf: string, rawFeatures: number[]): HistoricalSample =>
    ({
      asOf,
      rawFeatures: [...rawFeatures],
      features: [...rawFeatures],
    }) as unknown as HistoricalSample
  const approx = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol

  // Qc1 — imputation fallback is the CAUSAL median, not the global one.
  // Dates: A observes {10, 20}; B is entirely missing; C observes {1000, 2000}.
  // Causal median at B = median{10,20} = 20. The old global median over all
  // four values was 1000 — a future-contaminated fill.
  {
    const rows = [
      preprocSample('2020-01-01', [10]),
      preprocSample('2020-01-01', [20]),
      preprocSample('2020-01-02', [Number.NaN]),
      preprocSample('2020-01-02', [Number.NaN]),
      preprocSample('2020-01-03', [1000]),
      preprocSample('2020-01-03', [2000]),
    ]
    imputeMissingWithDateMedians(rows)
    const ok =
      approx(rows[2].rawFeatures[0], 20) &&
      approx(rows[3].rawFeatures[0], 20) &&
      rows[2].imputedMask?.[0] === true
    results.push({
      name: 'causal preprocessing: empty-date imputation uses past-only median (20, not 1000)',
      passed: ok,
      detail: ok ? undefined : `imputed=${rows[2].rawFeatures[0]}`,
    })
  }

  // Qc2 — perturbing the FUTURE cannot change a past imputation.
  {
    const build = (futureScale: number) => {
      const rows = [
        preprocSample('2020-01-01', [10]),
        preprocSample('2020-01-01', [20]),
        preprocSample('2020-01-02', [Number.NaN]),
        preprocSample('2020-01-03', [1000 * futureScale]),
      ]
      imputeMissingWithDateMedians(rows)
      return rows[2].rawFeatures[0]
    }
    const ok = approx(build(1), build(1000)) && approx(build(1), 20)
    results.push({
      name: 'causal preprocessing: imputation invariant under future perturbation',
      passed: ok,
      detail: ok ? undefined : `base=${build(1)} perturbed=${build(1000)}`,
    })
  }

  // Qc3 — sparse-date Z uses the expanding window (own date included).
  // Dense A = {1..5} (mean 3, popstd √2 → the 5 maps to +1.414214…).
  // Sparse B = {3}; expanding pool {1,2,3,4,5,3}: mean 3 → B's Z is exactly 0.
  {
    const rows = [
      preprocSample('2020-01-01', [1]),
      preprocSample('2020-01-01', [2]),
      preprocSample('2020-01-01', [3]),
      preprocSample('2020-01-01', [4]),
      preprocSample('2020-01-01', [5]),
      preprocSample('2020-01-02', [3]),
    ]
    applyCrossSectionalNormalization(rows)
    const ok =
      approx(rows[4].features[0], 2 / Math.SQRT2, 1e-6) &&
      approx(rows[5].features[0], 0, 1e-6)
    results.push({
      name: 'causal preprocessing: sparse-date Z from expanding window (hand-computed)',
      passed: ok,
      detail: ok ? undefined : `dense5=${rows[4].features[0]} sparseB=${rows[5].features[0]}`,
    })
  }

  // Qc4 — future dates cannot move a past sparse-date Z. Adding a later
  // date of huge values (old global fallback would have dragged B's Z
  // strongly negative) leaves B at exactly 0.
  {
    const rows = [
      preprocSample('2020-01-01', [1]),
      preprocSample('2020-01-01', [2]),
      preprocSample('2020-01-01', [3]),
      preprocSample('2020-01-01', [4]),
      preprocSample('2020-01-01', [5]),
      preprocSample('2020-01-02', [3]),
      preprocSample('2020-01-03', [100]),
      preprocSample('2020-01-03', [100]),
      preprocSample('2020-01-03', [100]),
      preprocSample('2020-01-03', [100]),
      preprocSample('2020-01-03', [100]),
    ]
    applyCrossSectionalNormalization(rows)
    const ok = approx(rows[5].features[0], 0, 1e-6)
    results.push({
      name: 'causal preprocessing: sparse-date Z invariant under future perturbation',
      passed: ok,
      detail: ok ? undefined : `sparseB=${rows[5].features[0]} (should be 0)`,
    })
  }

  return results
}
