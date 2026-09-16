/** Focused tests for evidence-vs-baseline CIs and fail-closed model promotion. */
import {
  applyCrossSectionalNormalization,
  assessModelPromotion,
  BLEND_MOMENTUM_WEIGHT_GRID,
  buildCalendarWindows,
  buildHistoricalDataset,
  COMPANY_DESCRIPTOR_FEATURE_COUNT,
  computeBaselineEvidence,
  computeFeaturesAtDate,
  computeMomentum12to1AtDate,
  costTierMarketCapUsd,
  DEFAULT_BACKTEST_TICKERS,
  DEFAULT_GATE_CORRELATION,
  DEFAULT_GATE_MOMENTUM_BASELINE,
  DEFAULT_WINDOW_RULE,
  describeUniverseAttrition,
  EXCLUDED_UNFETCHABLE,
  FROZEN_HYPERPARAMETERS,
  FundamentalsTimeline,
  HISTORICAL_FEATURE_NAMES,
  imputeMissingWithDateMedians,
  indexSamples,
  measuredOverlapBlockLength,
  measureMomentumBlend,
  normalizeMomentum12to1ByDate,
  planUniverseFetch,
  renameContinuityProblem,
  renameHasHistoryContinuity,
  resolveFetchSymbol,
  resolveWindowRule,
  runWalkForwardBacktest,
  selectBlendWeight,
  spearmanCorrelation,
  summarizeCalendarWindows,
  TICKER_RENAMES,
  UNFETCHABLE_RESOLVED_ON,
  unresolvedExclusion,
  walkForwardStep,
  windowRows,
  type BacktestDatasetQuality,
  type DailyBar,
  type HistoricalSample,
  type TickerRename,
} from './historicalBacktest'
import {
  fitBaggedGradientBoosting,
  fitRidge,
  pearsonCorrelation,
  predictBaggedGradientBoosting,
} from './quantMath'
import {
  DOLLAR_VOLUME_SIZE_PROXY,
  SIZE_TIERED_BORROW_FEE_ANNUAL,
  SIZE_TIERED_TRADING_COST,
} from './quantConfig'

type TestResult = { name: string; passed: boolean; detail?: string }

/** Consecutive weekdays from `startIso`: a stand-in for the exchange calendar. */
function weekdayCalendar(startIso: string, count: number): string[] {
  const out: string[] = []
  const cursor = new Date(`${startIso}T00:00:00Z`)
  while (out.length < count) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Rows for the window helper, which reads only ticker, asOf and labelEnd20d.
 * One row per name on every `cadence`-th calendar day from `firstIndex` up
 * to (not including) `lastIndexExclusive`; the label closes `labelBars`
 * calendar days later. Returned sorted by date, as the walk-forward sees them.
 */
function windowFixtureRows(
  tickers: readonly string[],
  calendar: readonly string[],
  spec: { firstIndex: number; lastIndexExclusive: number; cadence: number; labelBars: number },
): HistoricalSample[] {
  const rows: HistoricalSample[] = []
  for (let i = spec.firstIndex; i < spec.lastIndexExclusive; i += spec.cadence) {
    const labelEnd20d = calendar[Math.min(calendar.length - 1, i + spec.labelBars)]
    for (const ticker of tickers) {
      rows.push({ ticker, asOf: calendar[i], labelEnd20d } as unknown as HistoricalSample)
    }
  }
  return rows
}

/** A full row the model can train on: three features, a target that
 * follows the first one, and every label date the ensemble reads. */
function trainableRow(
  ticker: string,
  calendar: readonly string[],
  index: number,
  nextRandom: () => number,
): HistoricalSample {
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, nextRandom()))) * Math.cos(2 * Math.PI * nextRandom())
  const features = [gaussian(), gaussian(), gaussian()]
  const target = 0.4 * features[0] + 0.6 * gaussian()
  // A stand-in for the 12-1 momentum yardstick, already Z-scored: it shares
  // part of the target's signal so the blend has something real to weigh.
  const momentum12to1 = 0.5 * features[0] + 0.5 * gaussian()
  const labelAt = (bars: number) => calendar[Math.min(calendar.length - 1, index + bars)]
  return {
    ticker,
    asOf: calendar[index],
    asOfIndex: index,
    features: [...features],
    rawFeatures: [...features],
    momentum12to1Raw: momentum12to1,
    momentum12to1,
    forwardReturn5d: target / 2,
    forwardReturn20d: target,
    forwardReturn60d: target * 1.5,
    forwardReturn120d: target * 2,
    forwardReturn5dRel: target / 2,
    forwardReturn20dRel: target,
    forwardReturn60dRel: target * 1.5,
    forwardReturn120dRel: target * 2,
    labelEnd5d: labelAt(5),
    labelEnd20d: labelAt(20),
    labelEnd60d: labelAt(60),
    labelEnd120d: labelAt(120),
    logMarketCap: Math.log(5e10),
  } as unknown as HistoricalSample
}

/** Seeded xorshift32 so the end-to-end window test never flakes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

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

/** Twelve windows where the trees beat every yardstick under both
 * correlations and both momentum definitions, with the ridge and blend
 * alternatives filled in, so the record carries every optional field. */
function strongEvidenceSteps() {
  return Array.from({ length: 12 }, (_, index) => ({
    informationCoefficient: 0.12 + index * 0.001,
    spearmanIc: 0.11 + index * 0.001,
    baselineRandomIc: 0.01 + index * 0.0002,
    baselineMomentumIc: 0.04 + index * 0.0003,
    baselineMomentumSpearmanIc: 0.035 + index * 0.0003,
    baselineMomentum12to1Ic: 0.05 + index * 0.0003,
    baselineMomentum12to1SpearmanIc: 0.045 + index * 0.0003,
    ridgeIc: 0.06 + index * 0.0004,
    ridgeSpearmanIc: 0.055 + index * 0.0004,
    ridgeLambda: 30,
    blendIc: 0.1 + index * 0.0005,
    blendSpearmanIc: 0.09 + index * 0.0005,
    blendWeight: 0.25,
    ...overlapDates(index),
  }))
}

function strongEvidence() {
  return computeBaselineEvidence(strongEvidenceSteps(), 1000)
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
        baselineMomentum12to1Ic: Number.NaN,
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

  // ---- Calendar-defined walk-forward windows ------------------------------
  // The windows used to be slices of the row list by count (70 of them by a
  // hard-coded target in the CLI, a floor of 60 rows in the app). They are
  // now blocks of trading days, so the window count is a fact about the
  // calendar and the two entry points agree.

  // Three names on every weekday for 600 days, 20-day windows after a
  // one-year burn-in. From 2015-01-05 the burn-in ends on 2016-01-05, which
  // is the 262nd weekday, so 339 dates remain: 16 full windows of 20, and a
  // 19-date remainder that is dropped so every window covers the same span.
  const denseCalendar = weekdayCalendar('2015-01-05', 620)
  const denseRows = windowFixtureRows(['AAA', 'BBB', 'CCC'], denseCalendar, {
    firstIndex: 0,
    lastIndexExclusive: 600,
    cadence: 1,
    labelBars: 20,
  })
  {
    const windows = buildCalendarWindows(denseRows, { stepTradingDays: 20, burnInYears: 1 })
    let contiguous = true
    let allNames = true
    let adjacent = true
    windows.forEach((window, i) => {
      const { test } = windowRows(denseRows, window)
      const startIdx = denseCalendar.indexOf(window.testStartDate)
      const expectedDates = denseCalendar.slice(startIdx, startIdx + 20)
      const seenDates = [...new Set(test.map((row) => row.asOf))].sort()
      if (JSON.stringify(seenDates) !== JSON.stringify(expectedDates)) contiguous = false
      if (test.length !== 60 || new Set(test.map((row) => row.ticker)).size !== 3) allNames = false
      if (window.testRowCount !== 60 || window.testNameCount !== 3) allNames = false
      if (i > 0 && startIdx !== denseCalendar.indexOf(windows[i - 1].testEndDate) + 1) adjacent = false
    })
    const passed =
      windows.length === 16 &&
      windows[0].testStartDate === '2016-01-05' &&
      windows[0].testEndDate === '2016-02-01' &&
      windows[15].testEndDate === '2017-03-27' &&
      contiguous &&
      allNames &&
      adjacent
    results.push({
      name: 'calendar windows: 3 names x 600 dates give 16 date-contiguous 20-day windows holding every name',
      passed,
      detail: passed
        ? undefined
        : `count=${windows.length} first=${windows[0]?.testStartDate}..${windows[0]?.testEndDate} ` +
          `last=${windows[windows.length - 1]?.testEndDate} contiguous=${contiguous} allNames=${allNames} adjacent=${adjacent}`,
    })
  }

  // Purge: no training row's 20-day label may close on or after the window
  // opens. With 20-day labels and a 5-day embargo the purge is the binding
  // cut, so the newest training row sits 21 trading days before the window.
  {
    const windows = buildCalendarWindows(denseRows, { stepTradingDays: 20, burnInYears: 1 })
    let holds = true
    let newestTrainingRowRight = true
    let expanding = true
    let previousTrainSize = 0
    for (const window of windows) {
      const { train } = windowRows(denseRows, window)
      if (train.length === 0 || !train.every((row) => row.labelEnd20d < window.testStartDate)) holds = false
      const startIdx = denseCalendar.indexOf(window.testStartDate)
      const newest = train.reduce((latest, row) => (row.asOf > latest ? row.asOf : latest), '')
      if (newest !== denseCalendar[startIdx - 21]) newestTrainingRowRight = false
      if (train.length <= previousTrainSize) expanding = false
      previousTrainSize = train.length
    }
    const passed = windows.length === 16 && holds && newestTrainingRowRight && expanding
    results.push({
      name: 'calendar windows: no training label reaches a window start, and training expands window by window',
      passed,
      detail: passed
        ? undefined
        : `holds=${holds} newestRight=${newestTrainingRowRight} expanding=${expanding}`,
    })
  }

  // Embargo counted in trading days. Labels here close the next day so the
  // purge only removes the row one day before the window; the embargo then
  // decides the rest: with 5, the row exactly 5 trading days before the
  // window is out and the row 6 days before is in. With 0, the 5-day row is
  // back in and only the purge remains.
  {
    const shortLabelRows = windowFixtureRows(['AAA', 'BBB', 'CCC'], denseCalendar, {
      firstIndex: 0,
      lastIndexExclusive: 600,
      cadence: 1,
      labelBars: 1,
    })
    const embargoed = buildCalendarWindows(shortLabelRows, {
      stepTradingDays: 20,
      burnInYears: 1,
      embargoTradingDays: 5,
    })
    const unembargoed = buildCalendarWindows(shortLabelRows, {
      stepTradingDays: 20,
      burnInYears: 1,
      embargoTradingDays: 0,
    })
    const window = embargoed[3]
    const startIdx = denseCalendar.indexOf(window.testStartDate)
    const trainDates = new Set(windowRows(shortLabelRows, window).train.map((row) => row.asOf))
    const fiveBefore = denseCalendar[startIdx - 5]
    const sixBefore = denseCalendar[startIdx - 6]
    const withoutEmbargo = new Set(windowRows(shortLabelRows, unembargoed[3]).train.map((row) => row.asOf))
    const passed =
      window.trainAsOfCutoff === sixBefore &&
      !trainDates.has(fiveBefore) &&
      trainDates.has(sixBefore) &&
      withoutEmbargo.has(fiveBefore) &&
      withoutEmbargo.has(denseCalendar[startIdx - 2]) &&
      !withoutEmbargo.has(denseCalendar[startIdx - 1])
    results.push({
      name: 'calendar windows: the embargo is counted in trading days (5 before is out, 6 before is in)',
      passed,
      detail: passed
        ? undefined
        : `cutoff=${window.trainAsOfCutoff} sixBefore=${sixBefore} has5=${trainDates.has(fiveBefore)} ` +
          `has6=${trainDates.has(sixBefore)} noEmbargoHas5=${withoutEmbargo.has(fiveBefore)}`,
    })
  }

  // The 15-year, 224-name fixture, shaped like the real dataset: every name
  // trimmed to the same 3,780 bars, sampled every 10th bar from bar 252 up
  // to 120 bars before the end, 20-bar labels. The old CLI rule produced
  // exactly 70 windows on this shape whatever the data said. With the
  // trading calendar and the default rule (20 days, 10-year burn-in from the
  // first sample date of 2011-12-21), the test period opens 2021-12-21 and
  // closes with the block that holds the last sample date, 2025-01-01: 40
  // windows, each holding all 224 names on two sample dates (448 rows).
  // Without the calendar, the sample dates alone are one trading day in ten
  // and the same rule gives only 4 windows of 200 trading days, which is why
  // the dataset builder now hands the calendar over.
  const fifteenYearCalendar = weekdayCalendar('2011-01-03', 3780)
  const fifteenYearRows = windowFixtureRows(
    Array.from({ length: 224 }, (_, i) => `N${String(i).padStart(3, '0')}`),
    fifteenYearCalendar,
    { firstIndex: 252, lastIndexExclusive: 3780 - 120, cadence: 10, labelBars: 20 },
  )
  {
    const withCalendar = buildCalendarWindows(fifteenYearRows, { tradingDates: fifteenYearCalendar })
    const withoutCalendar = buildCalendarWindows(fifteenYearRows)
    const summary = summarizeCalendarWindows(fifteenYearRows, withCalendar, resolveWindowRule())
    const passed =
      withCalendar.length !== 70 &&
      withoutCalendar.length !== 70 &&
      withCalendar.length === 40 &&
      withoutCalendar.length === 4 &&
      withCalendar[0].testStartDate === '2021-12-21' &&
      summary.windowsBuilt === 40 &&
      summary.namesPerWindow.min === 224 &&
      summary.namesPerWindow.max === 224 &&
      summary.rowsPerWindow.min === 448 &&
      summary.rowsPerWindow.max === 448 &&
      summary.firstSampleDate === '2011-12-21' &&
      summary.lastSampleDate === '2025-01-01' &&
      summary.firstTestDate === '2021-12-21' &&
      summary.lastTestDate === '2025-01-13'
    results.push({
      name: 'calendar windows: the 15-year, 224-name shape gives 40 windows, not the hard-coded 70',
      passed,
      detail: passed
        ? undefined
        : `withCalendar=${withCalendar.length} withoutCalendar=${withoutCalendar.length} ${JSON.stringify(summary)}`,
    })
  }

  // The CLI resolves the rule from its flags (absent here, so undefined) and
  // the worker resolves it with no overrides at all. Both must be the one
  // published default and must cut identical windows on the same data.
  {
    const cliRule = resolveWindowRule({ stepTradingDays: undefined, burnInYears: undefined })
    const workerRule = resolveWindowRule()
    const cliWindows = buildCalendarWindows(fifteenYearRows, { ...cliRule, tradingDates: fifteenYearCalendar })
    const workerWindows = buildCalendarWindows(fifteenYearRows, { ...workerRule, tradingDates: fifteenYearCalendar })
    let rejectsBadFlag = false
    try {
      resolveWindowRule({ stepTradingDays: Number('twenty') })
    } catch {
      rejectsBadFlag = true
    }
    const passed =
      JSON.stringify(cliRule) === JSON.stringify(workerRule) &&
      JSON.stringify(cliRule) === JSON.stringify(DEFAULT_WINDOW_RULE) &&
      DEFAULT_WINDOW_RULE.stepTradingDays === 20 &&
      DEFAULT_WINDOW_RULE.burnInYears === 10 &&
      DEFAULT_WINDOW_RULE.embargoTradingDays === 5 &&
      cliWindows.length === 40 &&
      JSON.stringify(cliWindows) === JSON.stringify(workerWindows) &&
      rejectsBadFlag
    results.push({
      name: 'calendar windows: the CLI path and the worker path cut identical windows from the one default rule',
      passed,
      detail: passed
        ? undefined
        : `cli=${JSON.stringify(cliRule)} worker=${JSON.stringify(workerRule)} ` +
          `cliWindows=${cliWindows.length} workerWindows=${workerWindows.length} rejectsBadFlag=${rejectsBadFlag}`,
    })
  }

  // End to end through runWalkForwardBacktest, the function both the CLI
  // and the worker call: the scored steps must line up one-to-one with the
  // calendar windows, each holding all 60 rows (3 names x 20 days).
  {
    const nextRandom = seededRandom(0x5eed)
    const rows: HistoricalSample[] = []
    for (let i = 0; i < 600; i++) {
      for (const ticker of ['AAA', 'BBB', 'CCC']) rows.push(trainableRow(ticker, denseCalendar, i, nextRandom))
    }
    const result = runWalkForwardBacktest(rows, {
      stepTradingDays: 20,
      burnInYears: 1,
      modelOptions: { numTrees: 5, depth: 2, learningRate: 0.1 },
      baselineMomentumFeatureIndex: 1,
    })
    const windows = buildCalendarWindows(rows, { stepTradingDays: 20, burnInYears: 1 })
    const stepsMatchWindows =
      result != null &&
      result.steps.length === windows.length &&
      result.steps.every(
        (step, i) =>
          step.testStartDate === windows[i].testStartDate &&
          step.testEndDate === windows[i].testEndDate &&
          step.testSize === 60,
      )
    const passed =
      result != null &&
      stepsMatchWindows &&
      result.windowSummary.windowsBuilt === 16 &&
      result.windowSummary.windowsScored === 16 &&
      result.windowSummary.rule.embargoTradingDays === 5 &&
      result.embargoDaysUsed === 5
    results.push({
      name: 'calendar windows: runWalkForwardBacktest scores one step per calendar window',
      passed,
      detail: passed
        ? undefined
        : `result=${result == null ? 'null' : `${result.steps.length} steps`} windows=${windows.length} ` +
          `summary=${result ? JSON.stringify(result.windowSummary) : 'n/a'}`,
    })
  }

  /* =====================================================================
     Cost model, momentum definitions, and the alternative models
     (added 2026-09-16)
     ---------------------------------------------------------------------
     One end-to-end run on the three-name fixture feeds several checks:
     the round-trip cost, the paired intervals for every alternative model,
     the out-of-bag blend weight, and the frozen hyperparameters.
     ===================================================================== */

  const alternativesRows: HistoricalSample[] = []
  {
    const nextRandom = seededRandom(0xa17e)
    for (let i = 0; i < 600; i++) {
      for (const ticker of ['AAA', 'BBB', 'CCC']) {
        alternativesRows.push(trainableRow(ticker, denseCalendar, i, nextRandom))
      }
    }
  }
  const smallTrees = { numTrees: 5, depth: 2, learningRate: 0.1 }
  const alternativesResult = runWalkForwardBacktest(alternativesRows, {
    stepTradingDays: 20,
    burnInYears: 1,
    modelOptions: smallTrees,
    baselineMomentumFeatureIndex: 1,
  })

  // Cost: every window rebalances the whole book, so each side pays the
  // one-way cost on entry AND on exit. The fixture's names carry a log
  // market cap of ln($50B), and exp(ln(5e10)) lands a hair BELOW the $50B
  // mega line in floating point, so the tier lookup (quantConfig
  // SIZE_TIERED_TRADING_COST) charges the large tier, 6 bps one way: four
  // legs cost 24 bps, plus the general-collateral borrow fee of 30 bps a
  // year pro-rated over 20 of 252 trading days. The entry-only figure the
  // model charged until now was 12. The expected tier is read from the same
  // table the model reads, so the check states the numbers rather than
  // assuming a tier.
  {
    const cap = Math.exp(alternativesRows[0].logMarketCap)
    const costTier =
      SIZE_TIERED_TRADING_COST.find((tier) => cap >= tier.minMarketCapUsd) ??
      SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1]
    const borrowTier =
      SIZE_TIERED_BORROW_FEE_ANNUAL.find((tier) => cap >= tier.minMarketCapUsd) ??
      SIZE_TIERED_BORROW_FEE_ANNUAL[SIZE_TIERED_BORROW_FEE_ANNUAL.length - 1]
    const oneWay = costTier.oneWayBps
    const borrow = (borrowTier.annualBps * 20) / 252
    const steps = alternativesResult?.steps ?? []
    const passed =
      steps.length > 0 &&
      steps.every((step) => {
        const cost = step.costBreakdownBps
        return (
          cost != null &&
          approx(cost.longEntry, oneWay) &&
          approx(cost.longExit, oneWay) &&
          approx(cost.shortEntry, oneWay) &&
          approx(cost.shortExit, oneWay) &&
          approx(cost.shortBorrow, borrow) &&
          // The realized cost minus borrow is exactly twice the entry-only figure.
          approx(step.realizedCostBps - cost.shortBorrow, 2 * (cost.longEntry + cost.shortEntry)) &&
          approx(step.realizedCostBps, 4 * oneWay + borrow) &&
          approx(step.longShortReturnNet, step.longShortReturnGross - step.realizedCostBps / 100)
        )
      })
    results.push({
      name: 'cost model: each window charges entry and exit on both sides, so cost minus borrow is twice the entry-only figure',
      passed,
      detail: passed
        ? undefined
        : `expected oneWay=${oneWay} borrow=${borrow} got ${JSON.stringify(steps[0]?.costBreakdownBps ?? 'no steps')}`,
    })
  }

  // Momentum 12-1 versus 12-0 on price bars with a known last-month
  // reversal. Ten names; the first bar of the yardstick's year is 100 for
  // every name, a month before the sample each name has drifted to
  // 100 x (1 + d), and by the sample date the move has fully reversed to
  // 100 x (1 - d), with d running from -0.3 to +0.3 across names. The 12-1
  // reading is d; the 12-0 reading, which includes the reversal month, is
  // -d. So for the winner 12-0 sits BELOW 12-1, for the loser it sits ABOVE,
  // and when the outcome continues the eleven-month trend the 12-1 baseline
  // scores a positive IC while the 12-0 baseline scores a negative one.
  {
    const names = 10
    const sampleIndex = 300
    const yearStart = sampleIndex - 253 // bar 47: the close 252 bars before the last window bar
    const monthBack = sampleIndex - 22 // bar 278: the close 21 bars before it
    const drifts = Array.from({ length: names }, (_, k) => -0.3 + (0.6 * k) / (names - 1))
    const barsFor = (drift: number): DailyBar[] => {
      const bars: DailyBar[] = []
      for (let i = 0; i < sampleIndex + 30; i++) {
        let close = 100
        if (i > yearStart && i <= monthBack) {
          close = 100 * (1 + (drift * (i - yearStart)) / (monthBack - yearStart))
        } else if (i > monthBack) {
          const progress = Math.min(1, (i - monthBack) / (sampleIndex - 1 - monthBack))
          close = 100 * (1 + drift) + (100 * (1 - drift) - 100 * (1 + drift)) * progress
        }
        bars.push({
          date: new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume: 1_000_000,
          rawClose: close,
          priceBasis: 'adjusted-total-return',
          adjustmentSource: 'yahoo-chart-adjclose',
        })
      }
      return bars
    }
    const momentumIndex = HISTORICAL_FEATURE_NAMES.indexOf('momentum_252d')
    const twelveZero: number[] = []
    const twelveOne: number[] = []
    for (const drift of drifts) {
      const bars = barsFor(drift)
      const features = computeFeaturesAtDate(bars, sampleIndex, null)
      twelveZero.push(features?.[momentumIndex] ?? Number.NaN)
      twelveOne.push(computeMomentum12to1AtDate(bars, sampleIndex) ?? Number.NaN)
    }
    const winner = names - 1
    const loser = 0
    const continuation = drifts.map((drift) => drift * 100)
    const icTwelveOne = pearsonCorrelation(twelveOne, continuation)
    const icTwelveZero = pearsonCorrelation(twelveZero, continuation)
    const passed =
      approx(twelveOne[winner], 30, 1e-9) &&
      approx(twelveZero[winner], -30, 1e-9) &&
      twelveZero[winner] < twelveOne[winner] &&
      twelveZero[loser] > twelveOne[loser] &&
      icTwelveOne > 0.99 &&
      icTwelveZero < -0.99 &&
      computeMomentum12to1AtDate(barsFor(0.1), 251) === null
    results.push({
      name: 'momentum baselines: after a last-month reversal 12-1 keeps the trend and 12-0 flips against it',
      passed,
      detail: passed
        ? undefined
        : `winner 12-0=${twelveZero[winner]} 12-1=${twelveOne[winner]} loser 12-0=${twelveZero[loser]} ` +
          `12-1=${twelveOne[loser]} IC(12-1)=${icTwelveOne} IC(12-0)=${icTwelveZero}`,
    })
  }

  // The 12-1 yardstick is Z-scored within its date the way the feature
  // columns are: a dense date over its own cross-section, a sparse date over
  // the expanding pool. Hand-computed on the same numbers as the causal
  // preprocessing check: dense {1..5} maps 5 to +1.414..., and the sparse
  // {3} on the next date lands exactly on the pool mean, so 0.
  {
    const row = (asOf: string, raw: number): HistoricalSample =>
      ({ asOf, momentum12to1Raw: raw, features: [], rawFeatures: [] }) as unknown as HistoricalSample
    const rows = [1, 2, 3, 4, 5].map((value) => row('2020-01-01', value))
    rows.push(row('2020-01-02', 3))
    rows.push({ asOf: '2020-01-02', features: [], rawFeatures: [] } as unknown as HistoricalSample)
    normalizeMomentum12to1ByDate(rows)
    const passed =
      approx(rows[4].momentum12to1 ?? Number.NaN, 2 / Math.SQRT2, 1e-6) &&
      approx(rows[5].momentum12to1 ?? Number.NaN, 0, 1e-6) &&
      rows[6].momentum12to1 === undefined
    results.push({
      name: 'momentum baselines: the 12-1 yardstick is Z-scored per date like a feature column, rows without it stay empty',
      passed,
      detail: passed ? undefined : `dense5=${rows[4].momentum12to1} sparse=${rows[5].momentum12to1} missing=${rows[6].momentum12to1}`,
    })
  }

  // The gate baseline is selectable and both definitions are always
  // reported. Trees at 0.05 every window; 12-0 momentum at -0.10 (the
  // reversal month hurt it), 12-1 at +0.02. Under the default the gate slot
  // says momentum_12_1 with a +0.03 edge and the 12-0 reading sits beside it
  // at +0.15; asking for 12-0 swaps the two.
  {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      informationCoefficient: 0.05,
      spearmanIc: 0.04,
      baselineRandomIc: 0,
      baselineMomentumIc: -0.1 + index * 0.0001,
      baselineMomentum12to1Ic: 0.02 + index * 0.0001,
      ...overlapDates(index),
    }))
    const byDefault = computeBaselineEvidence(steps, 200)
    const twelveZero = computeBaselineEvidence(steps, 200, { momentumBaseline: '12-0' })
    const passed =
      DEFAULT_GATE_MOMENTUM_BASELINE === '12-1' &&
      DEFAULT_GATE_CORRELATION === 'pearson' &&
      byDefault.gate?.momentumBaseline === '12-1' &&
      byDefault.gate?.correlation === 'pearson' &&
      byDefault.momentum.baseline === 'momentum_12_1' &&
      approx(byDefault.momentum.meanDifference ?? Number.NaN, 0.05 - 0.02 - 0.00055, 1e-9) &&
      byDefault.momentumByDefinition?.['12-0'].baseline === 'momentum_252d' &&
      approx(byDefault.momentumByDefinition?.['12-0'].meanDifference ?? Number.NaN, 0.05 + 0.1 - 0.00055, 1e-9) &&
      byDefault.momentumByDefinition?.['12-1'] === byDefault.momentum &&
      twelveZero.gate?.momentumBaseline === '12-0' &&
      twelveZero.momentum.baseline === 'momentum_252d' &&
      approx(twelveZero.momentum.meanDifference ?? Number.NaN, 0.05 + 0.1 - 0.00055, 1e-9) &&
      twelveZero.momentumByDefinition?.['12-1'].baseline === 'momentum_12_1' &&
      // Spearman on the trees is carried where asked, and the random
      // comparison then reads the rank IC.
      approx(
        computeBaselineEvidence(steps, 200, { correlation: 'spearman' }).random.meanDifference ?? Number.NaN,
        0.04,
        1e-12,
      )
    results.push({
      name: 'momentum baselines: the gate definition is selectable and both definitions are always reported',
      passed,
      detail: passed ? undefined : JSON.stringify({ byDefault: byDefault.momentum, other: byDefault.momentumByDefinition }),
    })
  }

  // Alternative models: every window carries a ridge IC, a blend IC and both
  // momentum ICs, and the paired block-bootstrap intervals exist for
  // trees-minus-ridge, trees-minus-momentum and blend-minus-momentum under
  // Pearson and Spearman, each over all 16 windows with a measured block.
  {
    const evidence = alternativesResult?.baselineEvidence
    const comparisons = evidence?.alternatives?.comparisons ?? []
    const expected = ['trees-minus-ridge', 'trees-minus-momentum', 'blend-minus-momentum']
    const complete = (['pearson', 'spearman'] as const).every((correlation) =>
      expected.every((label) => {
        const found = comparisons.find((c) => c.comparison === label && c.correlation === correlation)
        return (
          found != null &&
          found.ci95 != null &&
          found.pairedStepCount === 16 &&
          found.blockLength != null &&
          found.blockLength >= 1 &&
          found.blockLength < 16 &&
          found.bootstrapIterations >= 1000 &&
          Number.isFinite(found.ci95.lower) &&
          found.ci95.lower <= found.ci95.mean &&
          found.ci95.mean <= found.ci95.upper &&
          (label === 'trees-minus-ridge' ? found.momentumBaseline === null : found.momentumBaseline === '12-1')
        )
      }),
    )
    const models = evidence?.alternatives?.models ?? []
    const everyModelScored =
      models.length === 5 &&
      models.every(
        (entry) =>
          entry.windows === 16 &&
          Number.isFinite(entry.meanPearsonIc ?? Number.NaN) &&
          Number.isFinite(entry.meanSpearmanIc ?? Number.NaN),
      )
    const steps = alternativesResult?.steps ?? []
    const everyStepComplete =
      steps.length === 16 &&
      steps.every(
        (step) =>
          Number.isFinite(step.ridgeIc) &&
          Number.isFinite(step.ridgeSpearmanIc) &&
          Number.isFinite(step.blendIc) &&
          Number.isFinite(step.blendSpearmanIc) &&
          Number.isFinite(step.baselineMomentum12to1Ic) &&
          Number.isFinite(step.baselineMomentum12to1SpearmanIc) &&
          Number.isFinite(step.baselineMomentumSpearmanIc) &&
          step.ridgeFailure === undefined &&
          step.blendWeightBasis === 'out-of-bag' &&
          step.blendWeight != null &&
          BLEND_MOMENTUM_WEIGHT_GRID.includes(step.blendWeight) &&
          (step.blendWeightRows ?? 0) > 0,
      )
    const passed =
      comparisons.length === 6 &&
      complete &&
      everyModelScored &&
      everyStepComplete &&
      evidence?.alternatives?.ridge.failedWindows === 0 &&
      evidence?.alternatives?.blend.windowsWithWeight === 16 &&
      Number.isFinite(alternativesResult?.meanRidgeIc) &&
      Number.isFinite(alternativesResult?.meanBlendIc) &&
      Number.isFinite(alternativesResult?.meanBaselineMomentum12to1Ic)
    results.push({
      name: 'alternative models: ridge, momentum and blend are scored every window with paired intervals for each comparison',
      passed,
      detail: passed
        ? undefined
        : `comparisons=${comparisons.length} complete=${complete} models=${everyModelScored} steps=${everyStepComplete} ` +
          JSON.stringify(evidence?.alternatives?.ridge),
    })
  }

  // The blend weight is measured on training rows only. Wreck the test
  // window: scramble its features, flip its outcomes, and hand it a momentum
  // reading that predicts those outcomes perfectly. A weight that peeked
  // would jump to "all momentum"; the measured weight must not move at all,
  // while the test-row ICs must, proving the perturbation reached the window.
  {
    const sorted = indexSamples(alternativesRows)
    const windows = buildCalendarWindows(alternativesRows, { stepTradingDays: 20, burnInYears: 1 })
    const window = windows[5]
    const options = { modelOptions: smallTrees, baselineMomentumFeatureIndex: 1 }
    const before = walkForwardStep(sorted, window, options)
    const perturbed = sorted.map((sample) =>
      sample.asOf >= window.testStartDate && sample.asOf <= window.testEndDate
        ? {
            ...sample,
            features: sample.features.map((value, k) => (k === 0 ? -value : value * 3 + 1)),
            forwardReturn20dRel: -sample.forwardReturn20dRel,
            forwardReturn20d: -sample.forwardReturn20d,
            momentum12to1: -sample.forwardReturn20dRel * 10,
          }
        : sample,
    )
    const after = walkForwardStep(perturbed, window, options)
    const passed =
      before != null &&
      after != null &&
      before.blendWeightBasis === 'out-of-bag' &&
      before.blendWeight === after.blendWeight &&
      before.blendWeightRows === after.blendWeightRows &&
      before.trainSize === after.trainSize &&
      before.informationCoefficient !== after.informationCoefficient &&
      before.baselineMomentum12to1Ic !== after.baselineMomentum12to1Ic &&
      approx(after.baselineMomentum12to1Ic ?? Number.NaN, 1, 1e-9)
    results.push({
      name: 'alternative models: the blend weight comes from training rows only (test rows perturbed, weight unchanged)',
      passed,
      detail: passed
        ? undefined
        : `before=${before?.blendWeight}/${before?.blendWeightRows}/${before?.blendWeightBasis} after=${after?.blendWeight}/${after?.blendWeightRows} ` +
          `ic=${before?.informationCoefficient}->${after?.informationCoefficient} mom12-1=${after?.baselineMomentum12to1Ic}`,
    })
  }

  // Spearman reads only the ordering. On a monotone but curved relation the
  // rank correlation is exactly 1 while Pearson is not, and cubing one side
  // (rank-preserving) leaves Spearman untouched while Pearson moves.
  {
    const x = Array.from({ length: 40 }, (_, i) => i + 1)
    const y = x.map((value) => Math.exp(value / 8))
    const yCubed = y.map((value) => value ** 3)
    const passed =
      approx(spearmanCorrelation(x, y), 1, 1e-12) &&
      pearsonCorrelation(x, y) < 0.99 &&
      approx(spearmanCorrelation(x, yCubed), spearmanCorrelation(x, y), 1e-12) &&
      Math.abs(pearsonCorrelation(x, yCubed) - pearsonCorrelation(x, y)) > 0.05
    results.push({
      name: 'correlations: Spearman equals Pearson on a rank-preserving transform where Pearson does not',
      passed,
      detail: passed
        ? undefined
        : `spearman=${spearmanCorrelation(x, y)} pearson=${pearsonCorrelation(x, y)} pearsonCubed=${pearsonCorrelation(x, yCubed)}`,
    })
  }

  // Hyperparameters are frozen at the pre-registered values unless the
  // caller unfreezes them; the nested search stays available behind the flag.
  {
    const nextRandom = seededRandom(0xf20)
    const rows: HistoricalSample[] = []
    for (let i = 0; i < 420; i++) {
      for (const ticker of ['AAA', 'BBB']) rows.push(trainableRow(ticker, denseCalendar, i, nextRandom))
    }
    const frozen = runWalkForwardBacktest(rows, { stepTradingDays: 20, burnInYears: 1, baselineMomentumFeatureIndex: 1 })
    const searched = runWalkForwardBacktest(rows, {
      stepTradingDays: 20,
      burnInYears: 1,
      baselineMomentumFeatureIndex: 1,
      freezeHyperparameters: false,
    })
    const passed =
      FROZEN_HYPERPARAMETERS.numTrees === 50 &&
      FROZEN_HYPERPARAMETERS.depth === 3 &&
      FROZEN_HYPERPARAMETERS.learningRate === 0.1 &&
      frozen != null &&
      frozen.hyperparameterSelection === 'frozen' &&
      JSON.stringify(frozen.hyperparameters) === JSON.stringify(FROZEN_HYPERPARAMETERS) &&
      frozen.gateMomentumBaseline === '12-1' &&
      frozen.gateCorrelation === 'pearson' &&
      searched != null &&
      searched.hyperparameterSelection === 'nested-search' &&
      alternativesResult?.hyperparameterSelection === 'caller-supplied'
    results.push({
      name: 'hyperparameters: frozen at 50 trees / depth 3 / rate 0.1 by default, nested search only behind the flag',
      passed,
      detail: passed
        ? undefined
        : `frozen=${JSON.stringify(frozen?.hyperparameters)}/${frozen?.hyperparameterSelection} searched=${searched?.hyperparameterSelection}`,
    })
  }

  /* =====================================================================
     Review defects D1 to D6 (2026-09-16)
     ---------------------------------------------------------------------
     Each block pins one thing a mutation of the model code slipped past:
     the cost tier of a name with no filed cap, the ridge being fitted on
     training rows, the block length the paired interval really uses, a
     fixture that crosses 70 windows, the blend weight's out-of-bag mask
     (and its tie rule), and listing age at the fetch boundary.
     ===================================================================== */

  // D1. A name with no filed market cap is sized by its trailing 20-day
  // dollar volume and looked up in the same tier table, and every window
  // reports how many charged names were sized that way. At the documented
  // 1 percent daily turnover, $200M a day is a $20B cap equivalent: the
  // LARGE tier ($10B to $50B), not the bottom tier the model charged until
  // now. Withhold the stand-in and the same rows fall to the bottom tier
  // again, while the IC does not move, because the tier only reaches the
  // net return.
  {
    const proxyCap = 2e8 / DOLLAR_VOLUME_SIZE_PROXY.dailyTurnoverOfMarketCap
    const largeTier =
      SIZE_TIERED_TRADING_COST.find((tier) => proxyCap >= tier.minMarketCapUsd) ??
      SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1]
    const largeBorrow =
      SIZE_TIERED_BORROW_FEE_ANNUAL.find((tier) => proxyCap >= tier.minMarketCapUsd) ??
      SIZE_TIERED_BORROW_FEE_ANNUAL[SIZE_TIERED_BORROW_FEE_ANNUAL.length - 1]
    const bottomTier = SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1]
    const unit = {
      proxied: costTierMarketCapUsd(Number.NaN, 2e8),
      filed: costTierMarketCapUsd(5e10, 2e8),
      neither: costTierMarketCapUsd(Number.NaN, undefined),
      zeroVolume: costTierMarketCapUsd(Number.NaN, 0),
    }
    const nextRandom = seededRandom(0xd1)
    const rows: HistoricalSample[] = []
    for (let i = 0; i < 420; i++) {
      for (const ticker of ['AAA', 'BBB', 'CCC']) {
        rows.push({
          ...trainableRow(ticker, denseCalendar, i, nextRandom),
          logMarketCap: Number.NaN,
          avgDollarVolume20d: 2e8,
        })
      }
    }
    const sorted = indexSamples(rows)
    const windows = buildCalendarWindows(rows, { stepTradingDays: 20, burnInYears: 1 })
    const window = windows[3]
    const options = { modelOptions: smallTrees, baselineMomentumFeatureIndex: 1 }
    const proxied = walkForwardStep(sorted, window, options)
    const withheld = walkForwardStep(
      sorted.map((sample) => ({ ...sample, avgDollarVolume20d: undefined })),
      window,
      options,
    )
    // One name filed, two proxied: the per-window counts must add up.
    const mixed = walkForwardStep(
      sorted.map((sample) =>
        sample.ticker === 'AAA' ? { ...sample, logMarketCap: Math.log(5e10) } : sample,
      ),
      window,
      options,
    )
    const cost = proxied?.costBreakdownBps
    const basis = proxied?.costTierBasis
    const mixedBasis = mixed?.costTierBasis
    const passed =
      unit.proxied.basis === 'dollar-volume-proxy' &&
      approx(unit.proxied.capUsd, 2e10) &&
      unit.filed.basis === 'filed-cap' &&
      unit.filed.capUsd === 5e10 &&
      unit.neither.basis === 'unavailable' &&
      unit.zeroVolume.basis === 'unavailable' &&
      largeTier.minMarketCapUsd === 10e9 &&
      largeTier.oneWayBps === 6 &&
      proxied != null &&
      cost != null &&
      basis != null &&
      approx(cost.longEntry, largeTier.oneWayBps) &&
      approx(cost.longExit, largeTier.oneWayBps) &&
      approx(cost.shortEntry, largeTier.oneWayBps) &&
      approx(cost.shortExit, largeTier.oneWayBps) &&
      approx(cost.shortBorrow, (largeBorrow.annualBps * 20) / 252) &&
      basis.chargedNames > 0 &&
      basis.dollarVolumeProxy === basis.chargedNames &&
      basis.filedCap === 0 &&
      basis.unavailable === 0 &&
      withheld?.costBreakdownBps != null &&
      withheld.costTierBasis != null &&
      approx(withheld.costBreakdownBps.longEntry, bottomTier.oneWayBps) &&
      approx(withheld.costBreakdownBps.shortExit, bottomTier.oneWayBps) &&
      withheld.costTierBasis.unavailable === withheld.costTierBasis.chargedNames &&
      withheld.costTierBasis.dollarVolumeProxy === 0 &&
      withheld.realizedCostBps > proxied.realizedCostBps &&
      proxied.informationCoefficient === withheld.informationCoefficient &&
      proxied.longShortReturnGross === withheld.longShortReturnGross &&
      mixedBasis != null &&
      mixedBasis.unavailable === 0 &&
      mixedBasis.filedCap + mixedBasis.dollarVolumeProxy === mixedBasis.chargedNames &&
      mixedBasis.chargedNames === basis.chargedNames
    results.push({
      name: 'cost model: no filed cap but $200M a day of volume is charged the large tier, and the proxied count is reported per window',
      passed,
      detail: passed
        ? undefined
        : `unit=${JSON.stringify(unit)} cost=${JSON.stringify(cost)} basis=${JSON.stringify(basis)} ` +
          `withheld=${JSON.stringify(withheld?.costBreakdownBps)}/${JSON.stringify(withheld?.costTierBasis)} ` +
          `mixed=${JSON.stringify(mixedBasis)}`,
    })
  }

  // D2. The ridge is fitted on the window's TRAINING rows. The fixture's
  // training rows keep their relation (the target rises with the first
  // feature); the test rows are given the exact opposite. A ridge fitted
  // on training rows then predicts the wrong way round on the test rows
  // and scores a strongly negative IC. A ridge fitted on the test rows
  // would score close to +1, so that mutation fails here.
  {
    const sorted = indexSamples(alternativesRows)
    const windows = buildCalendarWindows(alternativesRows, { stepTradingDays: 20, burnInYears: 1 })
    const window = windows[5]
    const options = { modelOptions: smallTrees, baselineMomentumFeatureIndex: 1 }
    const flipped = sorted.map((sample) =>
      sample.asOf >= window.testStartDate && sample.asOf <= window.testEndDate
        ? {
            ...sample,
            forwardReturn20dRel: -sample.features[0],
            forwardReturn20d: -sample.features[0],
          }
        : sample,
    )
    const step = walkForwardStep(flipped, window, options)
    // The two relations, read directly off the rows the window hands out.
    const { train, test } = windowRows(flipped, window)
    const trainedOnTrain = fitRidge(
      train.map((sample) => sample.features),
      train.map((sample) => sample.forwardReturn20dRel),
    )
    const trainedOnTest = fitRidge(
      test.map((sample) => sample.features),
      test.map((sample) => sample.forwardReturn20dRel),
    )
    const passed =
      step != null &&
      step.ridgeFailure == null &&
      Number.isFinite(step.ridgeIc ?? Number.NaN) &&
      (step.ridgeIc ?? 0) < -0.5 &&
      (step.ridgeSpearmanIc ?? 0) < -0.5 &&
      trainedOnTrain.coefficients[0] > 0 &&
      trainedOnTest.coefficients[0] < 0
    results.push({
      name: 'alternative models: the ridge follows the TRAINING relation on test rows built with the opposite one',
      passed,
      detail: passed
        ? undefined
        : `ridgeIc=${step?.ridgeIc} spearman=${step?.ridgeSpearmanIc} failure=${step?.ridgeFailure} ` +
          `trainSlope=${trainedOnTrain.coefficients[0]} testSlope=${trainedOnTest.coefficients[0]}`,
    })
  }

  // D3. The paired interval really uses the measured block length. Sixty
  // windows whose model-minus-random differences swing on a twelve-window
  // cycle, so neighbours move together. On windows every 7 days with
  // 20-day labels three consecutive windows share label space (k = 3); the
  // same differences on windows 30 days apart share nothing (k = 1), and
  // there the block bootstrap is the plain one-at-a-time bootstrap. The
  // record must carry k, and the k = 3 interval must be wider, because
  // resampling in blocks keeps the swing that one-at-a-time draws destroy.
  {
    const count = 60
    const treesIc = Array.from(
      { length: count },
      (_, i) => 0.05 + 0.06 * Math.sin((2 * Math.PI * i) / 12),
    )
    const stepsOn = (dates: (i: number) => { testStartDate: string; testLabelEndDate: string }) =>
      treesIc.map((ic, i) => ({
        informationCoefficient: ic,
        baselineRandomIc: 0,
        baselineMomentumIc: Number.NaN,
        baselineMomentum12to1Ic: Number.NaN,
        ...dates(i),
      }))
    const spacedDates = (i: number) => {
      const start = new Date(Date.UTC(2020, 0, 1 + i * 30))
      const labelEnd = new Date(start.getTime() + 20 * 86_400_000)
      return {
        testStartDate: start.toISOString().slice(0, 10),
        testLabelEndDate: labelEnd.toISOString().slice(0, 10),
      }
    }
    const overlapping = computeBaselineEvidence(stepsOn(overlapDates), 1000)
    const spaced = computeBaselineEvidence(stepsOn(spacedDates), 1000)
    const width = (ci: { lower: number; upper: number } | null) =>
      ci ? ci.upper - ci.lower : Number.NaN
    const overlappingWidth = width(overlapping.random.ci95)
    const spacedWidth = width(spaced.random.ci95)
    const passed =
      measuredOverlapBlockLength(stepsOn(overlapDates)) === 3 &&
      measuredOverlapBlockLength(stepsOn(spacedDates)) === 1 &&
      overlapping.random.blockLength === 3 &&
      spaced.random.blockLength === 1 &&
      overlapping.random.pairedStepCount === count &&
      spaced.random.pairedStepCount === count &&
      approx(overlapping.random.meanDifference ?? Number.NaN, spaced.random.meanDifference ?? 0) &&
      Number.isFinite(overlappingWidth) &&
      Number.isFinite(spacedWidth) &&
      overlappingWidth > 1.2 * spacedWidth
    results.push({
      name: 'baseline evidence: the paired interval uses the measured block length (k = 3) and widens against the one-at-a-time bootstrap',
      passed,
      detail: passed
        ? undefined
        : `block=${overlapping.random.blockLength}/${spaced.random.blockLength} ` +
          `width=${overlappingWidth} vs ${spacedWidth} mean=${overlapping.random.meanDifference}/${spaced.random.meanDifference}`,
    })
  }

  // D4. A fixture that crosses 70 windows. Thirty years of weekdays, three
  // names sampled every tenth day from bar 252 to 120 bars before the end,
  // under the default rule (20-day windows, 10-year burn-in, 5-day
  // embargo). The count is worked by hand from the rule: windows start on
  // the first trading day ten years after the first sample date and follow
  // every 20 trading days for as long as a window opens on or before the
  // last sample date. That is 243 windows here; a cap at 70 fails.
  {
    const thirtyYearCalendar = weekdayCalendar('1990-01-01', 30 * 261)
    const lastBar = thirtyYearCalendar.length
    const rows = windowFixtureRows(['AAA', 'BBB', 'CCC'], thirtyYearCalendar, {
      firstIndex: 252,
      lastIndexExclusive: lastBar - 120,
      cadence: 10,
      labelBars: 20,
    })
    const rule = resolveWindowRule()
    const windows = buildCalendarWindows(rows, { tradingDates: thirtyYearCalendar })
    const firstSample = thirtyYearCalendar[252]
    const burnInEnd = `${Number(firstSample.slice(0, 4)) + rule.burnInYears}${firstSample.slice(4)}`
    const startIdx = thirtyYearCalendar.findIndex((date) => date >= burnInEnd)
    const lastSampleIdx = 252 + 10 * Math.floor((lastBar - 120 - 1 - 252) / 10)
    const expected = Math.floor((lastSampleIdx - startIdx) / rule.stepTradingDays) + 1
    // Sample dates inside a window: every tenth bar from 252 that falls in
    // its 20 days. Two for every window but possibly the last, which can
    // open after the second-to-last sample date and hold only one.
    const sampleDatesIn = (start: number) => {
      let dates = 0
      for (let i = start; i < start + rule.stepTradingDays; i++) {
        if (i >= 252 && i <= lastSampleIdx && (i - 252) % 10 === 0) dates++
      }
      return dates
    }
    const passed =
      rule.stepTradingDays === 20 &&
      rule.burnInYears === 10 &&
      expected === 243 &&
      expected > 70 &&
      windows.length === expected &&
      windows[0].testStartDate === thirtyYearCalendar[startIdx] &&
      windows.every(
        (window, i) => window.testStartDate === thirtyYearCalendar[startIdx + i * rule.stepTradingDays],
      ) &&
      windows.every(
        (window, i) =>
          window.testNameCount === 3 &&
          window.testRowCount === 3 * sampleDatesIn(startIdx + i * rule.stepTradingDays),
      ) &&
      windows.slice(0, -1).every((window) => window.testRowCount === 6) &&
      windows[windows.length - 1].testStartDate <= thirtyYearCalendar[lastSampleIdx]
    results.push({
      name: 'calendar windows: a 30-year, 3-name fixture gives exactly 243 windows under the default rule, well past 70',
      passed,
      detail: passed
        ? undefined
        : `windows=${windows.length} expected=${expected} startIdx=${startIdx} lastSampleIdx=${lastSampleIdx} ` +
          `first=${windows[0]?.testStartDate} last=${windows[windows.length - 1]?.testStartDate}`,
    })
  }

  // D5. The blend weight is scored out-of-bag. Features here are pure
  // noise and the target follows an independent momentum reading, so the
  // trees have nothing real to learn. Scored on the rows they trained on
  // they still look good, because boosted trees memorise their own rows,
  // and an in-bag scoring would hand them part of the weight. Scored only
  // by the members that never saw each row they look like the noise they
  // are, and the weight goes to momentum. The same bag is rebuilt here
  // from the window's seed, scored both ways, and the weight the step
  // reports must be the out-of-bag one.
  {
    const nextRandom = seededRandom(0x0b0b)
    const gaussian = () =>
      Math.sqrt(-2 * Math.log(Math.max(1e-12, nextRandom()))) * Math.cos(2 * Math.PI * nextRandom())
    const rows: HistoricalSample[] = []
    for (let i = 0; i < 420; i++) {
      for (const ticker of ['AAA', 'BBB', 'CCC']) {
        const base = trainableRow(ticker, denseCalendar, i, nextRandom)
        const features = [gaussian(), gaussian(), gaussian()]
        const momentum = gaussian()
        const target = 0.6 * momentum + 0.8 * gaussian()
        rows.push({
          ...base,
          features: [...features],
          rawFeatures: [...features],
          momentum12to1Raw: momentum,
          momentum12to1: momentum,
          forwardReturn20dRel: target,
          forwardReturn20d: target,
        })
      }
    }
    const overfitTrees = { numTrees: 30, depth: 3, learningRate: 0.1 }
    const sorted = indexSamples(rows)
    const windows = buildCalendarWindows(rows, { stepTradingDays: 20, burnInYears: 1 })
    const window = windows[4]
    const { train, test } = windowRows(sorted, window)
    const trainFeatures = train.map((sample) => sample.features)
    const trainTargets = train.map((sample) => sample.forwardReturn20dRel)
    const seed = (Date.parse(window.testStartDate) / 86_400_000) | 0
    const masks: Array<Uint8Array | null> = []
    const bag = fitBaggedGradientBoosting(trainFeatures, trainTargets, {
      ...overfitTrees,
      bags: 5,
      sampleFraction: 0.8,
      seed,
      onMemberRows: (memberIndex, rowIndices) => {
        if (rowIndices == null) {
          masks[memberIndex] = null
          return
        }
        const mask = new Uint8Array(train.length)
        for (const row of rowIndices) mask[row] = 1
        masks[memberIndex] = mask
      },
    })
    const shared = {
      trainSamples: train,
      trainTargets,
      bag,
      testSamples: test,
      testTreePredictions: test.map((sample) => predictBaggedGradientBoosting(bag, sample.features)),
      momentumOf: (sample: HistoricalSample) => sample.momentum12to1,
      correlation: 'pearson' as const,
      seedSalt: seed,
    }
    const outOfBag = measureMomentumBlend({ ...shared, memberRowMasks: masks })
    // Masks that mark no row as in-bag: every member scores every row, which
    // is what the 'in-bag members scored' and 'empty member index lists'
    // mutations amount to.
    const inBag = measureMomentumBlend({
      ...shared,
      memberRowMasks: masks.map((mask) => (mask ? new Uint8Array(mask.length) : null)),
    })
    const step = walkForwardStep(sorted, window, {
      modelOptions: overfitTrees,
      baselineMomentumFeatureIndex: 1,
    })
    const passed =
      masks.length === 5 &&
      masks.every((mask) => mask != null) &&
      outOfBag.basis === 'out-of-bag' &&
      inBag.basis === 'out-of-bag' &&
      outOfBag.weight != null &&
      inBag.weight != null &&
      outOfBag.weight !== inBag.weight &&
      outOfBag.weight > inBag.weight &&
      step != null &&
      step.blendWeightBasis === 'out-of-bag' &&
      step.blendWeight === outOfBag.weight &&
      step.blendWeightRows === outOfBag.rows
    results.push({
      name: 'alternative models: the blend weight is the out-of-bag one where in-bag scoring would choose differently',
      passed,
      detail: passed
        ? undefined
        : `outOfBag=${outOfBag.weight}/${outOfBag.rows} inBag=${inBag.weight}/${inBag.rows} ` +
          `step=${step?.blendWeight}/${step?.blendWeightRows}/${step?.blendWeightBasis} masks=${masks.length}`,
    })
  }

  // D5, tie rule. Two signals with the same ordering but different shapes:
  // under Spearman every mix of them has identical ranks, so all five grid
  // weights score exactly the same and the tie must go to MORE momentum
  // (weight 1). Under Pearson the mixes differ and "all trees" wins
  // outright, which shows the weight of 1 above came from the tie rule.
  {
    const x = Array.from({ length: 40 }, (_, i) => i + 1)
    const standardize = (values: number[]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
      return values.map((value) => (value - mean) / std)
    }
    const zTree = standardize(x)
    const zMomentum = standardize(x.map((value) => value * value))
    const tied = selectBlendWeight(zTree, zMomentum, x, 'spearman')
    const untied = selectBlendWeight(zTree, zMomentum, x, 'pearson')
    const spearmanScores = BLEND_MOMENTUM_WEIGHT_GRID.map((weight) =>
      spearmanCorrelation(
        zTree.map((value, k) => (1 - weight) * value + weight * zMomentum[k]),
        x,
      ),
    )
    const passed =
      tied != null &&
      tied.weight === 1 &&
      spearmanScores.every((score) => score === spearmanScores[0]) &&
      untied != null &&
      untied.weight === 0 &&
      approx(untied.score, 1, 1e-12)
    results.push({
      name: 'alternative models: a blend-weight tie goes to more momentum (weight 1), and only a tie does',
      passed,
      detail: passed
        ? undefined
        : `tied=${JSON.stringify(tied)} untied=${JSON.stringify(untied)} spearman=${spearmanScores.join(',')}`,
    })
  }

  // D6. Listing age at the fetch boundary. A name whose first bar sits on
  // the start of the fetch window (or within the week after it, the room a
  // weekend and a holiday need) had its history cut there, so its age
  // reads as the missing sentinel; a name whose first bar comes later
  // reads its true age; and without a boundary the first bar is taken at
  // face value. Nothing else in the vector changes. The sentinel then
  // flows through the causal imputation, which fills it from the names
  // whose age is known and flags the cell in the imputed mask.
  {
    const dayMs = 86_400_000
    const fetchWindowStartMs = Date.UTC(1986, 0, 6)
    const barsFrom = (firstDayOffset: number, count: number): DailyBar[] =>
      Array.from({ length: count }, (_, i) => {
        const close = 100 + 5 * Math.sin(i / 7)
        return {
          date: new Date(fetchWindowStartMs + (firstDayOffset + i) * dayMs).toISOString().slice(0, 10),
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume: 1_000_000,
          rawClose: close,
          priceBasis: 'adjusted-total-return',
          adjustmentSource: 'yahoo-chart-adjclose',
        } as DailyBar
      })
    const ageIdx = HISTORICAL_FEATURE_NAMES.indexOf('listing_age_years')
    const sampleAt = 300
    const featuresOf = (bars: DailyBar[], withBoundary: boolean) =>
      computeFeaturesAtDate(bars, sampleAt, null, {
        firstBarDateMs: Date.parse(bars[0].date),
        ...(withBoundary ? { fetchWindowStartMs } : {}),
      })
    const onBoundary = featuresOf(barsFrom(0, 400), true)
    const justAfter = featuresOf(barsFrom(3, 400), true)
    const pastTolerance = featuresOf(barsFrom(8, 400), true)
    const listedLater = featuresOf(barsFrom(730, 400), true)
    const noBoundary = featuresOf(barsFrom(0, 400), false)
    const trueAge = sampleAt / 365.25
    const sampleOf = (features: number[] | null, ticker: string) =>
      ({
        ticker,
        asOf: '2000-01-03',
        features: [...(features ?? [])],
        rawFeatures: [...(features ?? [])],
      }) as unknown as HistoricalSample
    const samples = [sampleOf(onBoundary, 'CUT'), sampleOf(listedLater, 'NEW')]
    imputeMissingWithDateMedians(samples)
    const passed =
      ageIdx >= 0 &&
      onBoundary != null &&
      justAfter != null &&
      pastTolerance != null &&
      listedLater != null &&
      noBoundary != null &&
      Number.isNaN(onBoundary[ageIdx]) &&
      Number.isNaN(justAfter[ageIdx]) &&
      approx(pastTolerance[ageIdx], trueAge) &&
      approx(listedLater[ageIdx], trueAge) &&
      approx(noBoundary[ageIdx], trueAge) &&
      onBoundary.length === noBoundary.length &&
      onBoundary.every((value, k) => (k === ageIdx ? Number.isNaN(value) : Object.is(value, noBoundary[k]))) &&
      samples[0].imputedMask?.[ageIdx] === true &&
      samples[1].imputedMask?.[ageIdx] !== true &&
      approx(samples[0].rawFeatures[ageIdx], trueAge) &&
      approx(samples[0].features[ageIdx], trueAge)
    results.push({
      name: 'listing age: a first bar on the fetch boundary reads missing (then imputed and flagged), a later listing reads its true age',
      passed,
      detail: passed
        ? undefined
        : `onBoundary=${onBoundary?.[ageIdx]} justAfter=${justAfter?.[ageIdx]} pastTolerance=${pastTolerance?.[ageIdx]} ` +
          `listedLater=${listedLater?.[ageIdx]} noBoundary=${noBoundary?.[ageIdx]} expected=${trueAge} ` +
          `imputed=${samples[0].imputedMask?.[ageIdx]}/${samples[1].imputedMask?.[ageIdx]} filled=${samples[0].rawFeatures[ageIdx]}`,
    })
  }

  /* --- Names Yahoo no longer serves: the two ledgers ---------------------
     The pre-registered list is never edited. Renamed names are fetched under
     their successor and keep their own symbol; names that left the market
     are set aside before any fetch and recorded as registered but excluded.
     ----------------------------------------------------------------------- */
  const isoDate = /^\d{4}-\d{2}-\d{2}$/

  // The ledgers themselves: 18 renames and 50 exclusions, every one a
  // registered name, none in both, no successor that is already registered
  // (the same history would enter twice), every exclusion dated and reasoned.
  {
    const renamed = Object.keys(TICKER_RENAMES)
    const excluded = EXCLUDED_UNFETCHABLE.map((entry) => entry.ticker)
    const registered = new Set(DEFAULT_BACKTEST_TICKERS)
    const overlap = renamed.filter((ticker) => excluded.includes(ticker))
    const notRegistered = [...renamed, ...excluded].filter((ticker) => !registered.has(ticker))
    const successorsRegistered = renamed.filter((ticker) => registered.has(TICKER_RENAMES[ticker].successor))
    const undated = EXCLUDED_UNFETCHABLE.filter((entry) => entry.delistingDate == null || !isoDate.test(entry.delistingDate))
    const unexplained = EXCLUDED_UNFETCHABLE.filter((entry) => entry.reason.trim().length === 0 || entry.evidence.trim().length === 0)
    const passed =
      renamed.length === 18 &&
      excluded.length === 50 &&
      new Set(excluded).size === 50 &&
      overlap.length === 0 &&
      notRegistered.length === 0 &&
      successorsRegistered.length === 0 &&
      undated.length === 0 &&
      unexplained.length === 0
    results.push({
      name: 'unfetchable ledgers: 18 renames and 50 exclusions, all registered, none in both, no successor already registered, every exclusion dated and reasoned',
      passed,
      detail: passed ? undefined : JSON.stringify({ renamed: renamed.length, excluded: excluded.length, overlap, notRegistered, successorsRegistered, undated: undated.map((entry) => entry.ticker), unexplained: unexplained.map((entry) => entry.ticker) }),
    })
  }

  // The two recycled symbols. PARA and B answer Yahoo with long charts, so
  // neither stub rule sees them; each is excluded with the SEC Form 25 date
  // of the registered company, a reason that says what happened to it, a
  // `recycledBy` that names the company now holding the symbol (with its
  // CIK), and evidence that cites both CIKs. PSKY is a new registrant, so
  // PARA is a merger in the exclusion ledger, not a rename. Only these two
  // carry `recycledBy`, and the fetch plan sets both aside before any fetch.
  {
    const excludedByTicker = new Map(EXCLUDED_UNFETCHABLE.map((entry) => [entry.ticker, entry]))
    const para = excludedByTicker.get('PARA')
    const b = excludedByTicker.get('B')
    const withRecycledBy = EXCLUDED_UNFETCHABLE.filter((entry) => entry.recycledBy != null).map((entry) => entry.ticker)
    const plan = planUniverseFetch(['WBD', 'PARA', 'AUR', 'B'])
    const passed =
      para != null &&
      para.delistingDate === '2025-08-07' &&
      /Paramount Skydance/.test(para.reason) && /Banzai/.test(para.reason) &&
      /Banzai International/.test(para.recycledBy ?? '') && /1826011/.test(para.recycledBy ?? '') &&
      /813828/.test(para.evidence) && /2041610/.test(para.evidence) && /Form 25-NSE filed 2025-08-07/.test(para.evidence) && /merger, not a rename/.test(para.evidence) &&
      !(('PARA' in TICKER_RENAMES) || ('PSKY' in TICKER_RENAMES)) &&
      b != null &&
      b.delistingDate === '2025-01-27' &&
      /Apollo/.test(b.reason) && /Barrick/.test(b.reason) &&
      /Barrick Mining/.test(b.recycledBy ?? '') && /756894/.test(b.recycledBy ?? '') &&
      /CIK 9984/.test(b.evidence) && /Form 25-NSE filed 2025-01-27/.test(b.evidence) && /Apollo Global Management/.test(b.evidence) &&
      withRecycledBy.join(',') === 'PARA,B' &&
      plan.fetch.map((entry) => entry.ticker).join(',') === 'WBD,AUR' &&
      plan.excluded.map((entry) => `${entry.ticker}:${entry.recycledBy == null ? 'none' : 'recycled'}`).join(',') === 'PARA:recycled,B:recycled'
    results.push({
      name: 'recycled symbols: PARA (Paramount Global, merged 2025-08-07, now Banzai) and B (Barnes Group, taken private 2025-01-27, now Barrick) are dated, reasoned, cite both CIKs, carry recycledBy, and are set aside before any fetch',
      passed,
      detail: passed ? undefined : JSON.stringify({ para, b, withRecycledBy, fetch: plan.fetch, excluded: plan.excluded.map((entry) => entry.ticker) }),
    })
  }

  // History continuity: every rename's successor chart starts no later than
  // the company's own listing day (originalFirstTrade, from Alpha Vantage's
  // listing dates, not the successor chart) and before the change took
  // effect, at the first trade dates the resolution recorded, and the
  // effective date is never after the day the names were resolved.
  {
    const expected: Record<string, [successor: string, firstTrade: string, originalFirstTrade: string]> = {
      SQ: ['XYZ', '2015-11-19', '2015-11-19'], BK: ['BNY', '1973-05-03', '1973-05-03'], MMC: ['MRSH', '1973-02-21', '1987-12-30'], FI: ['FISV', '1986-09-25', '1990-03-26'],
      BGNE: ['ONC', '2016-02-03', '2016-02-03'], IAC: ['PPLI', '1993-01-19', '1993-01-19'], ZI: ['GTM', '2020-06-04', '2020-06-04'], YY: ['JOYY', '2012-11-21', '2012-11-21'],
      ATGE: ['CVSA', '1991-06-21', '1991-06-28'], KAR: ['OPLN', '2009-12-11', '2009-12-11'], VSCO: ['VSXY', '2021-07-21', '2021-07-21'], FDP: ['DMC', '1997-10-24', '1997-10-24'],
      LANC: ['MZTI', '1980-03-17', '1990-03-26'], CSWI: ['CSW', '2015-09-30', '2015-10-01'], ERJ: ['EMBJ', '2000-07-21', '2000-07-21'], JBT: ['JBTM', '2008-07-22', '2008-07-22'],
      EQR: ['VMRK', '1993-08-12', '1993-08-12'], SGMO: ['SGMOQ', '2000-04-06', '2000-04-06'],
    }
    const mismatched = Object.entries(expected).filter(([original, [successor, firstTrade, originalFirstTrade]]) => {
      const rename = TICKER_RENAMES[original]
      return rename == null || rename.successor !== successor || rename.successorFirstTrade !== firstTrade || rename.originalFirstTrade !== originalFirstTrade
    }).map(([original]) => original)
    const withoutContinuity = Object.entries(TICKER_RENAMES).filter(([, rename]) => !renameHasHistoryContinuity(rename)).map(([original]) => original)
    const badEffectiveDate = Object.entries(TICKER_RENAMES)
      .filter(([, rename]) => !isoDate.test(rename.effectiveDate) || rename.effectiveDate > UNFETCHABLE_RESOLVED_ON || rename.successorFirstTrade >= rename.effectiveDate)
      .map(([original]) => original)
    const badListingDate = Object.entries(TICKER_RENAMES)
      .filter(([, rename]) => !isoDate.test(rename.originalFirstTrade) || rename.successorFirstTrade > rename.originalFirstTrade)
      .map(([original]) => original)
    const notApplied = Object.keys(TICKER_RENAMES).filter((original) => resolveFetchSymbol(original) !== TICKER_RENAMES[original].successor)
    const untouched = resolveFetchSymbol('aapl') === 'AAPL'
    const passed =
      Object.keys(expected).length === 18 &&
      Object.keys(TICKER_RENAMES).length === 18 &&
      mismatched.length === 0 &&
      withoutContinuity.length === 0 &&
      badEffectiveDate.length === 0 &&
      badListingDate.length === 0 &&
      notApplied.length === 0 &&
      untouched
    results.push({
      name: 'ticker renames: every successor history starts by the company\'s own listing day and before the rename took effect (the recorded dates), so each of the 18 is applied',
      passed,
      detail: passed ? undefined : JSON.stringify({ mismatched, withoutContinuity, badEffectiveDate, badListingDate, notApplied, untouched }),
    })
  }

  // The two renames this pass added, and the eight names it excluded. SGMO
  // is a Chapter 11 name whose shares keep trading under SGMOQ with the
  // whole history: a rename, not an exclusion. EQR became VMRK under the
  // same SEC registrant. The eight (seven acquired or taken private, plus
  // WOLF, whose registered shares were cancelled) are excluded with a date
  // and a reason that names what happened.
  {
    const excludedByTicker = new Map(EXCLUDED_UNFETCHABLE.map((entry) => [entry.ticker, entry]))
    const sgmo = TICKER_RENAMES.SGMO
    const eqr = TICKER_RENAMES.EQR
    const eight: Record<string, [date: string, reasonPattern: RegExp]> = {
      EA: ['2026-08-04', /Public Investment Fund/],
      IAS: ['2025-12-23', /Novacap/],
      CPRX: ['2026-07-16', /Angelini/],
      NSA: ['2026-07-22', /Public Storage/],
      AVB: ['2026-08-17', /Equity Residential|Vivmark/],
      WBS: ['2026-08-20', /Santander/],
      CRNX: ['2026-09-01', /Vertex/],
      WOLF: ['2025-09-26', /Chapter 11/],
    }
    const wrongExclusions = Object.entries(eight).filter(([ticker, [date, pattern]]) => {
      const entry = excludedByTicker.get(ticker)
      return entry == null || entry.delistingDate !== date || !pattern.test(entry.reason) || !/8-K/.test(entry.evidence)
    }).map(([ticker]) => ticker)
    const passed =
      sgmo != null &&
      sgmo.successor === 'SGMOQ' &&
      sgmo.note.startsWith('Chapter 11 2026-06-23; still files; history continues under SGMOQ') &&
      sgmo.effectiveDate === '2026-06-23' &&
      resolveFetchSymbol('SGMO') === 'SGMOQ' &&
      !excludedByTicker.has('SGMO') &&
      eqr != null &&
      eqr.successor === 'VMRK' &&
      /906107/.test(eqr.note) &&
      resolveFetchSymbol('EQR') === 'VMRK' &&
      !excludedByTicker.has('EQR') &&
      wrongExclusions.length === 0 &&
      planUniverseFetch(['EQR', 'AVB', 'SGMO', 'EA', 'WOLF']).fetch.map((entry) => `${entry.ticker}>${entry.fetchedAs}`).join(',') === 'EQR>VMRK,SGMO>SGMOQ'
    results.push({
      name: 'stub-probe resolution: SGMO -> SGMOQ and EQR -> VMRK are renames; EA, IAS, CPRX, NSA, AVB, WBS, CRNX and WOLF are dated, reasoned exclusions',
      passed,
      detail: passed ? undefined : JSON.stringify({ sgmo, eqr, wrongExclusions }),
    })
  }

  // A rename whose successor chart starts on or after the change would be a
  // fresh listing, not the same series; it is refused, not applied.
  {
    const fresh: TickerRename = {
      successor: 'NEWCO',
      effectiveDate: '2024-06-01',
      effectiveDateBasis: 'sec-filing',
      successorFirstTrade: '2024-06-03',
      originalFirstTrade: '2024-06-03',
      note: 'a listing that starts after the change',
    }
    let refused = ''
    try {
      planUniverseFetch(['OLDCO'], { renames: { OLDCO: fresh }, excluded: [] })
    } catch (error) {
      refused = (error as Error).message
    }
    const sameDay = renameHasHistoryContinuity({ successorFirstTrade: '2024-06-01', effectiveDate: '2024-06-01', originalFirstTrade: '2024-06-01' })
    const dayBefore = renameHasHistoryContinuity({ successorFirstTrade: '2024-05-31', effectiveDate: '2024-06-01', originalFirstTrade: '2024-05-31' })
    const malformed = renameHasHistoryContinuity({ successorFirstTrade: '2024/05/31', effectiveDate: '2024-06-01', originalFirstTrade: '2024-05-31' })
    const passed = /continuity/.test(refused) && /NEWCO/.test(refused) && /fresh listing/.test(refused) && !sameDay && dayBefore && !malformed
    results.push({
      name: 'ticker renames: a successor whose history starts on or after the change is refused as a fresh listing',
      passed,
      detail: passed ? undefined : JSON.stringify({ refused, sameDay, dayBefore, malformed }),
    })
  }

  // A recycled symbol: the successor's chart exists and starts before the
  // resolution day, so the old "earlier than today" comparison would have
  // let it through, but it starts a decade after the company's own listing
  // (2015-11-19), so it cannot carry the history the original symbol would
  // have contributed. It is refused, and the message says why.
  {
    const recycled: TickerRename = {
      successor: 'RCYC',
      effectiveDate: '2026-03-02',
      effectiveDateBasis: 'sec-filing',
      successorFirstTrade: '2026-01-05',
      originalFirstTrade: '2015-11-19',
      note: 'a symbol reused by a 2026 listing',
    }
    let refused = ''
    try {
      planUniverseFetch(['OLDCO'], { renames: { OLDCO: recycled }, excluded: [] })
    } catch (error) {
      refused = (error as Error).message
    }
    const problem = renameContinuityProblem(recycled) ?? ''
    const oldGuardWouldPass = recycled.successorFirstTrade < UNFETCHABLE_RESOLVED_ON && recycled.successorFirstTrade < recycled.effectiveDate
    const genuine = renameContinuityProblem({ successorFirstTrade: '2015-11-19', effectiveDate: '2026-03-02', originalFirstTrade: '2015-11-19' })
    const passed =
      /continuity/.test(refused) && /RCYC/.test(refused) && /recycled/.test(refused) && /2015-11-19/.test(refused) &&
      /recycled/.test(problem) && oldGuardWouldPass && genuine == null && !renameHasHistoryContinuity(recycled)
    results.push({
      name: 'ticker renames: a recycled symbol (successor first trade 2026, company listed 2015) is refused, although it starts before today',
      passed,
      detail: passed ? undefined : JSON.stringify({ refused, problem, oldGuardWouldPass, genuine }),
    })
  }

  // The fetch plan: excluded names are set aside with their status and
  // reason (an unresolved one says when it was left open), renamed names
  // fetch under the successor, everything else fetches as itself, and the
  // registered list stays in its given order. Two names that would fetch
  // the same symbol, or a name in both ledgers, are refused.
  {
    const ledger = {
      renames: {
        OLDA: { successor: 'NEWA', effectiveDate: '2025-01-02', effectiveDateBasis: 'sec-filing', successorFirstTrade: '2010-01-04', originalFirstTrade: '2010-01-04', note: 'test rename' },
      } as Record<string, TickerRename>,
      excluded: [
        { ticker: 'GONE', delistingDate: '2025-03-03', reason: 'acquired by Test Co', evidence: 'test filing' },
        unresolvedExclusion('lost', 'no answer from any source'),
      ],
    }
    const plan = planUniverseFetch(['AAA', 'olda', 'GONE', 'LOST', 'ZZZZBOGUS'], ledger)
    const fetchPairs = plan.fetch.map((entry) => `${entry.ticker}>${entry.fetchedAs}`).join(',')
    const excludedNames = plan.excluded.map((entry) => `${entry.ticker}:${entry.status}:${entry.reason}`).join(',')
    let collision = ''
    try {
      planUniverseFetch(['OLDA', 'NEWA'], ledger)
    } catch (error) {
      collision = (error as Error).message
    }
    let inBoth = ''
    try {
      planUniverseFetch(['AAA'], { renames: ledger.renames, excluded: [{ ticker: 'OLDA', delistingDate: null, reason: 'x', evidence: 'x' }] })
    } catch (error) {
      inBoth = (error as Error).message
    }
    const passed =
      fetchPairs === 'AAA>AAA,OLDA>NEWA,ZZZZBOGUS>ZZZZBOGUS' &&
      excludedNames === `GONE:registered but excluded:acquired by Test Co,LOST:registered but excluded:unresolved on ${UNFETCHABLE_RESOLVED_ON}` &&
      plan.registered.join(',') === 'AAA,OLDA,GONE,LOST,ZZZZBOGUS' &&
      plan.renamed.length === 1 &&
      plan.renamed[0].original === 'OLDA' &&
      plan.renamed[0].fetchedAs === 'NEWA' &&
      plan.attrition.registeredNames === 5 &&
      plan.attrition.excludedNames === 2 &&
      Math.abs(plan.attrition.excludedShare - 0.4) < 1e-12 &&
      /twice/.test(collision) &&
      /both/.test(inBoth)
    results.push({
      name: 'fetch plan: excluded names are set aside with status and reason, renames fetch under the successor, collisions and double-listed names are refused',
      passed,
      detail: passed ? undefined : JSON.stringify({ fetchPairs, excludedNames, registered: plan.registered, renamed: plan.renamed, attrition: plan.attrition, collision, inBoth }),
    })
  }

  // The attrition sentence the run prints and the artifact stores.
  {
    const attrition = describeUniverseAttrition(1073, 57)
    const empty = describeUniverseAttrition(0, 0)
    const passed =
      attrition.statement ===
        '57 of 1073 registered names (5.3%) left the market during the window and could not be included: no free source serves their price history, or the business continues only under a new SEC registrant; results are survivor-biased by at least this share.' &&
      Math.abs(attrition.excludedShare - 57 / 1073) < 1e-12 &&
      empty.excludedShare === 0 &&
      empty.statement.startsWith('0 of 0 registered names (0.0%)')
    results.push({ name: 'universe attrition is worded as the count, the share and the survivorship consequence', passed, detail: passed ? undefined : JSON.stringify({ attrition, empty }) })
  }

  // The dataset builder end to end, with the network replaced: an excluded
  // name never reaches the fetch, a renamed name is requested under its
  // successor and its rows keep the original symbol, and the provenance
  // carries the registered list as given plus both ledgers' outcomes.
  {
    const originalFetch = globalThis.fetch
    const requested: string[] = []
    const chartPayload = (symbol: string, count: number) => {
      // A gently trending random walk, seeded from the symbol so the two
      // names differ and the cross-sectional steps have something to rank.
      let state = 0
      for (const char of symbol) state = (state * 31 + char.charCodeAt(0)) >>> 0
      const next = () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 0x1_0000_0000
      }
      const closes: number[] = []
      let price = 100
      for (let i = 0; i < count; i++) {
        price *= 1 + (next() - 0.49) * 0.03
        closes.push(Number(price.toFixed(4)))
      }
      const firstEpoch = Date.UTC(2022, 0, 3) / 1000
      return {
        chart: {
          result: [{
            timestamp: closes.map((_, index) => firstEpoch + index * 86_400),
            indicators: {
              quote: [{
                open: closes.map((close) => close * 0.99),
                high: closes.map((close) => close * 1.02),
                low: closes.map((close) => close * 0.98),
                close: closes,
                volume: closes.map(() => 1_000_000),
              }],
              adjclose: [{ adjclose: closes }],
            },
          }],
          error: null,
        },
      }
    }
    globalThis.fetch = async (input) => {
      const url = String(input)
      const upstream = new URL(url).searchParams.get('url') ?? url
      requested.push(upstream)
      const chart = upstream.match(/\/v8\/finance\/chart\/([^?]+)/)
      if (chart) {
        return new Response(JSON.stringify(chartPayload(decodeURIComponent(chart[1]), 420)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // Fundamentals: the backend's "files nothing" answer.
      return new Response(null, { status: 404 })
    }
    try {
      const built = await buildHistoricalDataset(['SQ', 'PXD', 'AAPL'], { range: 'max', minBars: 300 })
      const asked = (pattern: RegExp) => requested.some((url) => pattern.test(url))
      const excludedRecord = built.provenance.universeExcluded?.[0]
      const renameRecord = built.provenance.universeRenames?.[0]
      const tickersInRows = [...new Set(built.samples.map((sample) => sample.ticker))].sort().join(',')
      const summary = built.diagnostics.perTickerSummary
      const passed =
        !asked(/chart\/PXD\?/) &&
        !asked(/symbol=PXD/) &&
        !asked(/chart\/SQ\?/) &&
        !asked(/symbol=SQ(&|$)/) &&
        asked(/chart\/XYZ\?/) &&
        asked(/symbol=XYZ/) &&
        asked(/chart\/AAPL\?/) &&
        built.provenance.universeTickers.join(',') === 'SQ,PXD,AAPL' &&
        built.provenance.universeExcluded?.length === 1 &&
        excludedRecord?.ticker === 'PXD' &&
        excludedRecord?.status === 'registered but excluded' &&
        excludedRecord?.delistingDate === '2024-05-03' &&
        excludedRecord?.reason === 'acquired by Exxon Mobil' &&
        built.provenance.universeRenames?.length === 1 &&
        renameRecord?.original === 'SQ' &&
        renameRecord?.fetchedAs === 'XYZ' &&
        built.provenance.universeAttrition?.registeredNames === 3 &&
        built.provenance.universeAttrition?.excludedNames === 1 &&
        built.diagnostics.tickersAttempted === 2 &&
        built.diagnostics.tickersRenamed === 1 &&
        built.diagnostics.excludedBeforeFetch?.map((entry) => entry.ticker).join(',') === 'PXD' &&
        summary.map((entry) => entry.ticker).join(',') === 'SQ,AAPL' &&
        summary[0].fetchedAs === 'XYZ' &&
        summary[1].fetchedAs === undefined &&
        built.samples.length > 0 &&
        tickersInRows === 'AAPL,SQ' &&
        built.quality.universe.intendedMemberCount === 3 &&
        built.quality.universe.membersWithExplicitNoHistoryOutcome === 1 &&
        built.quality.universe.memberOutcomeCoverage === 1 &&
        built.quality.universe.limitation.includes('1 of 3 registered names (33.3%)')
      results.push({
        name: 'dataset build: an excluded name never reaches the fetch, a renamed name fetches under its successor and keeps its own symbol, and the provenance carries both ledgers',
        passed,
        detail: passed
          ? undefined
          : JSON.stringify({
              requested,
              universeTickers: built.provenance.universeTickers,
              excluded: built.provenance.universeExcluded,
              renames: built.provenance.universeRenames,
              attrition: built.provenance.universeAttrition,
              diagnostics: { ...built.diagnostics, perTickerSummary: summary },
              samples: built.samples.length,
              tickersInRows,
              universe: built.quality.universe,
            }),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  return results
}
