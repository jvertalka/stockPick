/** Focused tests for evidence-vs-baseline CIs and fail-closed model promotion. */
import {
  applyCrossSectionalNormalization,
  assessModelPromotion,
  buildHistoricalDataset,
  COMPANY_DESCRIPTOR_FEATURE_COUNT,
  computeBaselineEvidence,
  computeFeaturesAtDate,
  FundamentalsTimeline,
  HISTORICAL_FEATURE_NAMES,
  imputeMissingWithDateMedians,
  measuredOverlapBlockLength,
  type BacktestDatasetQuality,
  type DailyBar,
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
    // Updated 2026-08-19 with the check's severity re-scope: rows lacking
    // adjclose are excluded fail-closed UPSTREAM and never become labels,
    // so a small disclosed exclusion warns; a MATERIAL missing-adjclose
    // rate (>1% of source rows) still fails closed — heavy exclusion can
    // bias which names and periods the panel represents.
    const quality = completeQuality()
    quality.returns.sourceRowsObserved = 100
    quality.returns.sourceEligibleRawBars = 100
    quality.returns.sourceMissingAdjustedBars = 5
    quality.returns.sourceAdjustmentCoverage = 95 / 100
    quality.returns.limitation = 'five otherwise-valid source rows lacked adjclose'
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable && assessment.blockerCodes.includes('TOTAL_RETURN_LABELS')
    results.push({
      name: 'promotion: material missing-adjclose exclusion fails closed',
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

  // --- Total-return label check severity (fixed 2026-08-19) ---------------
  // The check verifies the LABELS' basis; correctly-rejected source rows
  // never become labels, so a tiny disclosed exclusion rate warns instead
  // of blocking forever, while material exclusion (>1%) still blocks.
  {
    const quality = completeQuality()
    quality.returns.sourceRowsObserved = 1000
    quality.returns.sourceInvalidRawBars = 3
    quality.returns.sourceRowAcceptanceCoverage = 997 / 1000
    const assessment = assessModelPromotion(quality, strongEvidence())
    const reason = assessment.reasons.find((r) => r.code === 'TOTAL_RETURN_LABELS')
    const passed =
      assessment.promotable &&
      !assessment.blockerCodes.includes('TOTAL_RETURN_LABELS') &&
      reason?.status === 'warning' &&
      reason.detail.includes('excluded fail-closed')
    results.push({
      name: 'promotion: clean labels + minor disclosed exclusions warn, never block',
      passed,
      detail: passed ? undefined : JSON.stringify(reason ?? assessment.blockerCodes),
    })
  }

  {
    const quality = completeQuality()
    quality.returns.sourceRowsObserved = 1000
    quality.returns.sourceInvalidRawBars = 50
    quality.returns.sourceRowAcceptanceCoverage = 950 / 1000
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable &&
      assessment.blockerCodes.includes('TOTAL_RETURN_LABELS')
    results.push({
      name: 'promotion: material source-row exclusion (5%) blocks',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment.blockerCodes),
    })
  }

  {
    const quality = completeQuality()
    quality.returns.adjustedReturnLabelCoverage = 0.99
    quality.returns.totalReturnLabelCoverage = 0.99
    quality.returns.dividendsIncludedInLabels = false
    const assessment = assessModelPromotion(quality, strongEvidence())
    const passed =
      !assessment.promotable &&
      assessment.blockerCodes.includes('TOTAL_RETURN_LABELS')
    results.push({
      name: 'promotion: any unadjusted label still hard-blocks',
      passed,
      detail: passed ? undefined : JSON.stringify(assessment.blockerCodes),
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

  /* =====================================================================
     Company-type descriptors (added 2026-09-10)
     ---------------------------------------------------------------------
     Three descriptors read out of the price and filing record. The tests
     below pin each value by hand on a small fixture, prove that nothing dated
     after a sample can change that sample's answers, and check that a name
     with no filings is handled as an honest "unknown" rather than a silent
     zero.
     ===================================================================== */

  const indexOfFeature = (name: string): number => HISTORICAL_FEATURE_NAMES.indexOf(name)

  /** A synthetic price history long enough for the 252-day windows. Every bar
   * closes at the same price, so the ordinary price features stay flat and any
   * movement we see comes from the thing actually under test. */
  const descriptorBars = (
    count: number,
    factorAt: ((index: number) => number) | null,
    rawCloseAt: (index: number) => number = () => 100,
  ): DailyBar[] => {
    const bars: DailyBar[] = []
    for (let index = 0; index < count; index++) {
      const factor = factorAt ? factorAt(index) : undefined
      const rawClose = rawCloseAt(index)
      bars.push({
        date: new Date(Date.UTC(2015, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000_000,
        rawOpen: rawClose,
        rawHigh: rawClose * 1.01,
        rawLow: rawClose * 0.99,
        rawClose,
        ...(factor === undefined ? {} : { adjustmentFactor: factor }),
        priceBasis: 'adjusted-total-return',
        adjustmentSource: 'yahoo-chart-adjclose',
      })
    }
    return bars
  }

  /** Three annual filings for one imaginary company: flat revenue, rising
   * capital spending, and a loss in the most recent year. */
  const filingRows = (extraFutureFiling: boolean) => {
    const revenue = [
      { end: '2012-12-31', filed: '2013-02-15', value: 1000, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 1000, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: 1000, span: 'annual' },
    ]
    const capex = [
      { end: '2012-12-31', filed: '2013-02-15', value: 100, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 200, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: 300, span: 'annual' },
    ]
    const netIncome = [
      { end: '2012-12-31', filed: '2013-02-15', value: 10, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 20, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: -50, span: 'annual' },
    ]
    if (extraFutureFiling) {
      // Filed on 2016-02-15, which is AFTER the 2015-10-28 sample date the
      // tests below use. Huge revenue, huge capital spending, huge profit —
      // if any of it reached the sample, the descriptors would move visibly.
      revenue.push({ end: '2015-12-31', filed: '2016-02-15', value: 500_000, span: 'annual' })
      capex.push({ end: '2015-12-31', filed: '2016-02-15', value: 400_000, span: 'annual' })
      netIncome.push({ end: '2015-12-31', filed: '2016-02-15', value: 250_000, span: 'annual' })
    }
    return FundamentalsTimeline.fromHistory({ series: { revenue, capex, netIncome } })
  }

  // A filing lodged RIGHT NEXT TO the sample date, which is what the ordinary
  // leakage fixture cannot catch. Its "future" filing sits on 2016-02-15,
  // 110 days after the 2015-10-28 sample, so a forward look shorter than that
  // lands in the gap between two annual filings and changes no descriptor at
  // all. A three-month look-ahead is exactly the size of a reporting quarter,
  // so that blind spot is the one a real bug would hide in. These rows sit 0
  // and 3 days out, so any forward look whatsoever crosses them.
  //
  // offsetDays 0 also pins the point-in-time boundary itself: a filing lodged
  // ON the sample date is not yet knowable and must be excluded, which is the
  // difference between "filed < sample" and "filed <= sample".
  const filingRowsWithTripwire = (offsetDays: number) => {
    const revenue = [
      { end: '2012-12-31', filed: '2013-02-15', value: 1000, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 1000, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: 1000, span: 'annual' },
    ]
    const capex = [
      { end: '2012-12-31', filed: '2013-02-15', value: 100, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 200, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: 300, span: 'annual' },
    ]
    const netIncome = [
      { end: '2012-12-31', filed: '2013-02-15', value: 10, span: 'annual' },
      { end: '2013-12-31', filed: '2014-02-15', value: 20, span: 'annual' },
      { end: '2014-12-31', filed: '2015-02-15', value: -50, span: 'annual' },
    ]
    const tripwire = new Date(Date.UTC(2015, 9, 28) + offsetDays * 86_400_000)
      .toISOString()
      .slice(0, 10)
    revenue.push({ end: '2015-09-30', filed: tripwire, value: 900_000, span: 'annual' })
    capex.push({ end: '2015-09-30', filed: tripwire, value: 800_000, span: 'annual' })
    netIncome.push({ end: '2015-09-30', filed: tripwire, value: 700_000, span: 'annual' })
    return FundamentalsTimeline.fromHistory({ series: { revenue, capex, netIncome } })
  }

  // Qd0 — the emitted vector still lines up with the registered names, and the
  // descriptor block is the three columns it claims to be. A mis-ordered
  // append would silently shift every column after it, and a descriptor added
  // in one place but not the other would show up here as a width mismatch.
  {
    const features = computeFeaturesAtDate(descriptorBars(400, () => 1), 300, null)
    const descriptorNames = HISTORICAL_FEATURE_NAMES.slice(-COMPANY_DESCRIPTOR_FEATURE_COUNT)
    const ok =
      features != null &&
      features.length === HISTORICAL_FEATURE_NAMES.length &&
      COMPANY_DESCRIPTOR_FEATURE_COUNT === 3 &&
      descriptorNames.join(',') ===
        'payout_yield_252d,filing_cadence_3y,capital_intensity_3y'
    results.push({
      name: 'company descriptors: feature vector length still matches the registered names',
      passed: ok,
      detail: ok
        ? undefined
        : `emitted=${features?.length} names=${HISTORICAL_FEATURE_NAMES.length} descriptors=${descriptorNames.join(',')}`,
    })
  }

  // Qd1 — payout yield, hand-computed. The bar a year before the sample
  // carries an adjustment factor of 0.96 and the sample's own bar carries 1.0,
  // so 4.166…% was paid out in between: (1 / 0.96 − 1) × 100.
  {
    const bars = descriptorBars(400, (index) => (index < 100 ? 0.96 : 1))
    const features = computeFeaturesAtDate(bars, 300, null)
    const value = features?.[indexOfFeature('payout_yield_252d')] ?? Number.NaN
    const ok = approx(value, (1 / 0.96 - 1) * 100, 1e-9)
    results.push({
      name: 'company descriptors: payout yield is the ratio of two historical adjustment factors',
      passed: ok,
      detail: ok ? undefined : `payout=${value} expected=${(1 / 0.96 - 1) * 100}`,
    })
  }

  // Qd2 — a name that distributes nothing reads exactly zero, and splits in
  // the raw exchange prices cannot fake a distribution: the value is built
  // only from the two adjustment factors, so a ten-for-one price change in
  // every raw close leaves it untouched.
  {
    const flat = computeFeaturesAtDate(descriptorBars(400, () => 1), 300, null)
    const split = computeFeaturesAtDate(
      descriptorBars(400, () => 1, (index) => (index < 150 ? 1000 : 100)),
      300,
      null,
    )
    const payoutIndex = indexOfFeature('payout_yield_252d')
    const ok =
      approx(flat?.[payoutIndex] ?? Number.NaN, 0, 1e-12) &&
      approx(split?.[payoutIndex] ?? Number.NaN, 0, 1e-12)
    results.push({
      name: 'company descriptors: no distributions reads zero and a raw-price split cannot fake one',
      passed: ok,
      detail: ok ? undefined : `flat=${flat?.[payoutIndex]} split=${split?.[payoutIndex]}`,
    })
  }

  // Qd3 — the two filing descriptors, hand-computed at the 2015-10-28 sample
  // date. The latest filing visible then is the 2015-02-15 one, so:
  //   filing_cadence_3y    = 1 (three filings across three years — the shape
  //                             of a foreign issuer, not a quarterly filer)
  //   capital_intensity_3y = 20 (600 of capital spending on 3,000 of revenue)
  {
    const bars = descriptorBars(400, () => 1)
    const features = computeFeaturesAtDate(bars, 300, filingRows(false))
    const read = (name: string) => features?.[indexOfFeature(name)] ?? Number.NaN
    const ok =
      bars[300].date === '2015-10-28' &&
      approx(read('filing_cadence_3y'), 1) &&
      approx(read('capital_intensity_3y'), 20, 1e-9)
    results.push({
      name: 'company descriptors: filing descriptors match hand-computed values',
      passed: ok,
      detail: ok
        ? undefined
        : `date=${bars[300].date} cadence=${read('filing_cadence_3y')} intensity=${read('capital_intensity_3y')}`,
    })
  }

  // Qd4 — THE LEAKAGE TEST. Wreck everything dated after the sample: every
  // price bar past the sample's own bar, and a whole extra annual filing
  // lodged four months later. Not one descriptor may move.
  {
    const sampleIndex = 300
    const base = descriptorBars(400, (index) => (index < 100 ? 0.96 : 1))
    const perturbed = base.map((bar, index) =>
      index > sampleIndex
        ? {
            ...bar,
            open: bar.open * 9,
            high: bar.high * 9,
            low: bar.low * 9,
            close: bar.close * 9,
            volume: bar.volume * 40,
            rawClose: (bar.rawClose ?? 100) * 9,
            adjustmentFactor: 0.05,
          }
        : bar,
    )
    const before = computeFeaturesAtDate(base, sampleIndex, filingRows(false))
    const after = computeFeaturesAtDate(perturbed, sampleIndex, filingRows(true))
    const descriptorNames = ['payout_yield_252d', 'filing_cadence_3y', 'capital_intensity_3y']
    const moved = descriptorNames.filter((name) => {
      const index = indexOfFeature(name)
      const a = before?.[index] ?? Number.NaN
      const b = after?.[index] ?? Number.NaN
      if (Number.isNaN(a) && Number.isNaN(b)) return false
      return !approx(a, b, 1e-12)
    })
    const ok = before != null && after != null && moved.length === 0
    results.push({
      name: 'company descriptors: invariant under perturbation of every later bar and later filing',
      passed: ok,
      detail: ok ? undefined : `moved=${moved.join(',')}`,
    })
  }

  // Qd4b — THE TIGHT LEAKAGE TEST. Qd4 above only proves a descriptor cannot
  // see 110 days into the future, because that is where its extra filing sits.
  // A forward look shorter than one reporting quarter slipped through it
  // silently. These two cases close that: a filing lodged ON the sample date
  // and one lodged three days later must both be invisible, so any forward
  // look at all is caught.
  for (const offsetDays of [0, 3]) {
    const bars = descriptorBars(400, (index) => (index < 100 ? 0.96 : 1))
    const clean = computeFeaturesAtDate(bars, 300, filingRows(false))
    const tripped = computeFeaturesAtDate(bars, 300, filingRowsWithTripwire(offsetDays))
    const descriptorNames = ['filing_cadence_3y', 'capital_intensity_3y']
    const moved = descriptorNames.filter((name) => {
      const index = indexOfFeature(name)
      const a = clean?.[index] ?? Number.NaN
      const b = tripped?.[index] ?? Number.NaN
      if (Number.isNaN(a) && Number.isNaN(b)) return false
      return !approx(a, b, 1e-12)
    })
    const ok = clean != null && tripped != null && moved.length === 0
    results.push({
      name: `company descriptors: a filing lodged ${offsetDays} days from the sample stays invisible`,
      passed: ok,
      detail: ok ? undefined : `moved=${moved.join(',')}`,
    })
  }

  // Qd4c — capital spending reported as a negative cash outflow. Filers tag
  // capital expenditure both ways, and the absolute value in the sum is what
  // stops a capital-hungry company being read as capital-light. Without it the
  // sum goes negative and clamps to zero, which is the reading a utility and a
  // software firm would then share.
  {
    const negativeCapex = FundamentalsTimeline.fromHistory({
      series: {
        revenue: [
          { end: '2012-12-31', filed: '2013-02-15', value: 1000, span: 'annual' },
          { end: '2013-12-31', filed: '2014-02-15', value: 1000, span: 'annual' },
          { end: '2014-12-31', filed: '2015-02-15', value: 1000, span: 'annual' },
        ],
        capex: [
          { end: '2012-12-31', filed: '2013-02-15', value: -100, span: 'annual' },
          { end: '2013-12-31', filed: '2014-02-15', value: -200, span: 'annual' },
          { end: '2014-12-31', filed: '2015-02-15', value: -300, span: 'annual' },
        ],
        netIncome: [
          { end: '2014-12-31', filed: '2015-02-15', value: -50, span: 'annual' },
        ],
      },
    })
    const bars = descriptorBars(400, () => 1)
    const signed = computeFeaturesAtDate(bars, 300, negativeCapex)
    const positive = computeFeaturesAtDate(bars, 300, filingRows(false))
    const index = indexOfFeature('capital_intensity_3y')
    const a = signed?.[index] ?? Number.NaN
    const b = positive?.[index] ?? Number.NaN
    const ok = signed != null && positive != null && approx(a, b, 1e-9) && a > 0
    results.push({
      name: 'capital_intensity_3y: capex tagged negative reads the same as capex tagged positive',
      passed: ok,
      detail: ok ? undefined : `negative=${a} positive=${b}`,
    })
  }

  // Qd4d — one odd reporting year must not define a company's type. The
  // descriptor requires at least two matched years; with a single year on file
  // it has to read unknown and reach the ordinary imputation, not invent a
  // number from one observation.
  {
    const oneYear = FundamentalsTimeline.fromHistory({
      series: {
        revenue: [{ end: '2014-12-31', filed: '2015-02-15', value: 1000, span: 'annual' }],
        capex: [{ end: '2014-12-31', filed: '2015-02-15', value: 300, span: 'annual' }],
        netIncome: [{ end: '2014-12-31', filed: '2015-02-15', value: -50, span: 'annual' }],
      },
    })
    const features = computeFeaturesAtDate(descriptorBars(400, () => 1), 300, oneYear)
    const value = features?.[indexOfFeature('capital_intensity_3y')] ?? 0
    const ok = features != null && Number.isNaN(value)
    results.push({
      name: 'capital_intensity_3y: a single reporting year reads unknown, not a number',
      passed: ok,
      detail: ok ? undefined : `value=${value}`,
    })
  }

  // Qd4e — the payout clamp. The 0-to-20 band is the deliberate defence
  // against the price provider restating its split adjustment, which would
  // otherwise surface as an enormous fake dividend. Pin both ends.
  {
    const huge = computeFeaturesAtDate(
      descriptorBars(400, (index) => (index < 100 ? 0.2 : 1)),
      300,
      null,
    )
    const falling = computeFeaturesAtDate(
      descriptorBars(400, (index) => (index < 100 ? 1.4 : 1)),
      300,
      null,
    )
    const index = indexOfFeature('payout_yield_252d')
    const high = huge?.[index] ?? Number.NaN
    const low = falling?.[index] ?? Number.NaN
    const ok = huge != null && falling != null && approx(high, 20, 1e-9) && approx(low, 0, 1e-9)
    results.push({
      name: 'payout_yield_252d: clamped to the 0-to-20 band at both ends',
      passed: ok,
      detail: ok ? undefined : `high=${high} low=${low}`,
    })
  }

  // Qd5 — a name with no filings at all. "Files nothing" is an observed fact
  // about what kind of thing this is and reads a real zero; the two measured
  // descriptors read "unknown" and must reach the ordinary imputation with the
  // gap recorded, never a silent zero the model would take for a reading.
  {
    const features = computeFeaturesAtDate(descriptorBars(400, null), 300, null)
    const read = (name: string) => features?.[indexOfFeature(name)] ?? 0
    const intensityIndex = indexOfFeature('capital_intensity_3y')
    const observedZero = approx(read('filing_cadence_3y'), 0)
    const honestlyMissing =
      Number.isNaN(read('capital_intensity_3y')) && Number.isNaN(read('payout_yield_252d'))

    // The missing intensity must impute like every other gap and be flagged.
    const width = HISTORICAL_FEATURE_NAMES.length
    const row = (value: number): HistoricalSample => {
      const raw = new Array(width).fill(0)
      raw[intensityIndex] = value
      return { asOf: '2020-01-01', rawFeatures: raw, features: [...raw] } as unknown as HistoricalSample
    }
    const rows = [row(10), row(20), row(30), row(Number.NaN)]
    imputeMissingWithDateMedians(rows)
    const imputedHonestly =
      approx(rows[3].rawFeatures[intensityIndex], 20) &&
      rows[3].imputedMask?.[intensityIndex] === true

    const ok = observedZero && honestlyMissing && imputedHonestly
    results.push({
      name: 'company descriptors: a non-filer reads an observed zero, unknowns impute and are flagged',
      passed: ok,
      detail: ok
        ? undefined
        : `observedZero=${observedZero} honestlyMissing=${honestlyMissing} imputed=${imputedHonestly}`,
    })
  }

  return results
}
