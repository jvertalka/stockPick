/**
 * Tests for the pre-registered runner's helpers (tools/preregistered-run.ts).
 *
 * The one that matters most: a run that is stopped part-way and resumed
 * from its checkpoint must produce exactly the numbers that one straight
 * call into runWalkForwardBacktest produces, down to the last bit. Every
 * source of randomness in the core is seeded from the data, so "exactly"
 * is the right standard, and JSON text equality is the check.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORICAL_FEATURE_PIPELINE_VERSION,
  assessModelPromotion,
  buildCalendarWindows,
  computeBaselineEvidence,
  indexSamples,
  resolveWindowRule,
  runWalkForwardBacktest,
  type BacktestDatasetQuality,
  type BaselineEvidence,
  type HistoricalSample,
} from '../src/data/historicalBacktest'
import { createServingEnsembleAudit, modelDecisionAuthority, type StoredMlModel } from '../src/data/mlModelService'
import {
  HOLDOUT_CUTOFF_DATE,
  SAMPLE_HASH_TAIL_MARGIN_DAYS,
  SMOKE_MEMORY_POINTS,
  WindowLoopStopped,
  assembleFullResult,
  blockBootstrapStat,
  decodeJson,
  encodeJson,
  etfBlocksInDefaultTickers,
  hashRunSettings,
  hashSampleContent,
  holdoutWindows,
  openCheckpoint,
  parseDartEtfSymbols,
  probeBackendHealth,
  projectHeapNeed,
  readStoredFingerprint,
  recordWindow,
  releaseCheckpoint,
  requiredWindows,
  resolveEtfUniverse,
  runCheckpointedWindows,
  sampleHashThroughDate,
  trainFinalModelsWithCore,
  warmDailyBars,
  warmFundamentals,
  type CheckpointFingerprint,
  type PreRegisteredRunProvenance,
} from './preregistered-run'

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

/** Seeded xorshift32 so the fixture never flakes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/** A full row the model can train on: three features, a target that follows
 * the first one, and every label date the ensemble reads. Same shape as the
 * fixture in historicalBacktestQuality.tests.ts. */
function trainableRow(ticker: string, calendar: readonly string[], index: number, nextRandom: () => number): HistoricalSample {
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, nextRandom()))) * Math.cos(2 * Math.PI * nextRandom())
  const features = [gaussian(), gaussian(), gaussian()]
  const target = 0.4 * features[0] + 0.6 * gaussian()
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
    cohort: 'core',
  } as unknown as HistoricalSample
}

function fixtureRows(seed: number): HistoricalSample[] {
  const calendar = weekdayCalendar('2018-01-01', 800)
  const nextRandom = seededRandom(seed)
  const rows: HistoricalSample[] = []
  for (let i = 0; i < 600; i++) {
    for (const ticker of ['AAA', 'BBB', 'CCC']) rows.push(trainableRow(ticker, calendar, i, nextRandom))
  }
  return rows
}

/** First place two JSON strings differ, with a little context, for the failure detail. */
function firstDifference(left: string, right: string): string {
  if (left === right) return 'identical'
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i++
  const start = Math.max(0, i - 80)
  return `at char ${i}: ...${left.slice(start, i + 80)}... vs ...${right.slice(start, i + 80)}...`
}

/** A complete, promotable stored model, so the validator's provenance check
 * is the only thing the test can trip on. Mirrors the fixture in
 * mlModelService.tests.ts. */
function promotableStoredModel(): StoredMlModel {
  const quality: BacktestDatasetQuality = {
    schemaVersion: 1,
    universe: {
      pointInTimeMembership: true,
      includesDelistedSecurities: true,
      includesDelistingReturns: true,
      survivorshipBiasControlled: true,
      intendedMemberCount: 2,
      membersWithUsablePriceHistory: 2,
      membersWithExplicitNoHistoryOutcome: 0,
      memberOutcomeCoverage: 1,
      limitation: 'none',
    },
    returns: {
      labelPriceField: 'close',
      labelAdjustment: 'total-return',
      barsObserved: 1000,
      sourceRowsObserved: 1000,
      sourceInvalidRawBars: 0,
      sourceRowAcceptanceCoverage: 1,
      sourceEligibleRawBars: 1000,
      sourceMissingAdjustedBars: 0,
      sourceAdjustmentCoverage: 1,
      barsWithAdjustedCloseAvailable: 1000,
      adjustedCloseAvailabilityCoverage: 1,
      adjustedReturnLabelCoverage: 1,
      totalReturnLabelCoverage: 1,
      dividendsIncludedInLabels: true,
      limitation: 'none',
    },
    fundamentals: {
      source: 'SEC EDGAR XBRL companyfacts',
      alignedByFiledDate: true,
      tickersWithTimeline: 2,
      usableTickers: 2,
      tickerTimelineCoverage: 1,
      samplesWithPointInTimeSnapshot: 1000,
      totalSamples: 1000,
      sampleSnapshotCoverage: 1,
      observedFeatureCells: 3000,
      totalFeatureCells: 3000,
      observedFeatureCellCoverage: 1,
      limitation: 'none',
    },
    evaluation: {
      purgedWalkForwardSupported: true,
      embargoSupported: true,
      foldLocalPreprocessing: true,
      lockedPostSelectionHoldout: true,
      limitation: 'none',
    },
  }
  const comparison = (baseline: 'random' | 'momentum_12_1') => ({
    baseline,
    metric: 'information-coefficient' as const,
    correlation: 'pearson' as const,
    pairedStepCount: 20,
    meanDifference: 0.08,
    bootstrapIterations: 1000,
    blockLength: 4,
    ci95: { lower: 0.02, mean: 0.08, upper: 0.13 },
    ciClearOfZero: true,
  })
  const evidence: BaselineEvidence = {
    method: 'paired moving-block bootstrap (Kunsch 1989; Politis-Romano 1994)',
    confidenceLevel: 0.95,
    random: comparison('random'),
    momentum: comparison('momentum_12_1'),
    gate: { correlation: 'pearson', momentumBaseline: '12-1' },
  }
  const assessment = assessModelPromotion(quality, evidence)
  const executableModel = {
    trees: [{ root: { isLeaf: true as const, value: 0 } }],
    learningRate: 0.05,
    baseValue: 0,
    numFeatures: 1,
  }
  const stored: StoredMlModel = {
    model: executableModel,
    bag20: Array.from({ length: 5 }, () => executableModel),
    p10Model: executableModel,
    p90Model: executableModel,
    horizonModels: [5, 20, 60, 120].map((horizon) => ({
      horizon,
      medianModel: executableModel,
      meanIC: 0.08,
      icCI: { lower: 0.02, mean: 0.08, upper: 0.13 },
      conformalOffsetPct: 0.25,
    })),
    conformalOffset20dPct: 0.25,
    trainedAt: '2026-09-16T00:00:00.000Z',
    featureCount: 1,
    featureNames: ['momentum_252d'],
    featureMeans: [0],
    featureStds: [1],
    meanIC: 0.08,
    meanLongShortReturnNet: 0.4,
    meanLongShortSharpe: 1.2,
    hyperparameters: { numTrees: 1, depth: 1, learningRate: 0.05 },
    datasetProvenance: {
      schemaVersion: 2,
      builtAt: '2026-09-16T00:00:00.000Z',
      featurePipelineVersion: HISTORICAL_FEATURE_PIPELINE_VERSION,
      priceSource: 'Yahoo Finance chart via local cache proxy',
      fundamentalsSource: 'SEC EDGAR XBRL companyfacts via local backend',
      universeTickers: ['AAA', 'BBB'],
      universeConstruction: 'point-in-time security master with delistings',
      universeEvidence: {
        kind: 'point-in-time-with-delistings',
        membershipSource: 'test point-in-time security master',
        constituentEffectiveDateField: 'effective_date',
        delistedSecuritySource: 'test dead-security file',
        delistingReturnSource: 'test delisting-return file',
      },
      requestedRange: 'max',
      fetchedRange: 'max',
      cadenceTradingDays: 10,
      minimumBarsPerTicker: 400,
      featureNames: ['momentum_252d'],
      labelHorizonsTradingDays: [5, 20, 60, 120],
      sampleCount: 1000,
      sampleDateRange: { start: '1986-01-02', end: '2026-09-15' },
    },
    datasetQuality: quality,
    promotion: { ...assessment, persistedMode: 'promoted', advisoryOverrideUsed: false },
  }
  stored.servingEnsembleAudit = createServingEnsembleAudit(stored)
  return stored
}

function samplePreRegisteredProvenance(): PreRegisteredRunProvenance {
  const required = { mean: 0.02, halfWidth: 0.067, windowsHave: 70, windowsNeeded: 765, alreadyClear: false }
  return {
    schemaVersion: 1,
    flags: { range: 'max', windowDays: 20, burnInYears: 10, excludeEtfs: true, freezeHparams: true },
    universe: { requested: 1359, etfsExcluded: 286, etfSource: 'dart-universe-isEtf-flag', trained: 1073 },
    windows: {
      rule: { stepTradingDays: 20, burnInYears: 10, embargoTradingDays: 5 },
      built: 360,
      scored: 360,
      namesPerWindow: { min: 400, median: 900, max: 1073 },
      firstTestDate: '1996-01-02',
      lastTestDate: '2026-08-31',
      measuredBlockLength: 2,
    },
    gate: { correlation: 'pearson', momentumBaseline: '12-1' },
    requiredWindows: { random: required, momentum: required },
    holdout: { cutoffDate: HOLDOUT_CUTOFF_DATE, windowsBefore: 200, windowsAll: 360, random: null, momentum: null },
    checkpoint: { dir: 'C:/tmp/ckpt', replayedWindows: 100, computedWindows: 260 },
    missing: { allowMissing: true, droppedNames: ['ZZZZBOGUS'], fundamentalsFetchFailures: ['ORCL'], regimeHistoryMissing: false },
    memory: { heapCeilingMb: 13312, projectedMb: 9981, recommendedFlag: '--max-old-space-size=13312', peakRssMb: 9500 },
  }
}

export async function runPreRegisteredRunTests(): Promise<TestResult[]> {
  const results: TestResult[] = []

  // The warm-up retries a name that fails, keeps one that always fails on
  // the failed list, and counts the retries it made.
  {
    const calls = new Map<string, number>()
    const fetcher = async (ticker: string): Promise<number[]> => {
      const count = (calls.get(ticker) ?? 0) + 1
      calls.set(ticker, count)
      if (ticker === 'AAA') return [1]
      if (ticker === 'BBB') return count >= 3 ? [1, 2] : []
      throw new Error('proxy down')
    }
    const warm = await warmDailyBars(['AAA', 'BBB', 'CCC'], fetcher, { attempts: 4, pauseMs: 0 })
    const passed =
      warm.usable.join(',') === 'AAA,BBB' && warm.failed.join(',') === 'CCC' && warm.retries === 5 &&
      calls.get('AAA') === 1 && calls.get('BBB') === 3 && calls.get('CCC') === 4
    results.push({ name: 'price-history warm-up retries a failed fetch a bounded number of times and reports what still failed', passed, detail: passed ? undefined : JSON.stringify({ warm, calls: [...calls] }) })
  }

  // The fundamentals warm-up retries only a request that failed. "Files
  // nothing" is the backend's answer and is accepted at once; a fetcher that
  // throws counts as failed; what still fails after the attempts is listed.
  {
    const calls = new Map<string, number>()
    const fetcher = async (ticker: string): Promise<'timeline' | 'not-a-filer' | 'failed'> => {
      const count = (calls.get(ticker) ?? 0) + 1
      calls.set(ticker, count)
      if (ticker === 'AAA') return 'timeline'
      if (ticker === 'BBB') return count >= 3 ? 'not-a-filer' : 'failed'
      if (ticker === 'CCC') return 'failed'
      throw new Error('backend answered HTTP 502')
    }
    const warm = await warmFundamentals(['AAA', 'BBB', 'CCC', 'DDD'], fetcher, { attempts: 4, pauseMs: 0 })
    const passed =
      warm.withTimeline.join(',') === 'AAA' && warm.notFilers.join(',') === 'BBB' && warm.failed.join(',') === 'CCC,DDD' &&
      warm.retries === 2 + 3 + 3 && calls.get('AAA') === 1 && calls.get('BBB') === 3 && calls.get('CCC') === 4 && calls.get('DDD') === 4
    results.push({ name: 'fundamentals warm-up retries only failed requests, accepts "files nothing" at once, and lists what still failed', passed, detail: passed ? undefined : JSON.stringify({ warm, calls: [...calls] }) })
  }

  // The health probe: one request, a plain answer. A healthy backend is
  // ok; an error status, a thrown fetch, and a backend that never answers
  // within the timeout are all "not ok" with the reason in the detail.
  {
    const okFetch = (async () => new Response(JSON.stringify({ ok: true, cacheDirectory: 'C:/cache' }), { status: 200 })) as unknown as typeof fetch
    const errorFetch = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    const throwingFetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8787')
    }) as unknown as typeof fetch
    const silentFetch = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const healthy = await probeBackendHealth('http://127.0.0.1:8787', { fetcher: okFetch })
    const busy = await probeBackendHealth('http://127.0.0.1:8787', { fetcher: errorFetch })
    const refused = await probeBackendHealth('http://127.0.0.1:8787', { fetcher: throwingFetch })
    const silentStarted = Date.now()
    const silent = await probeBackendHealth('http://127.0.0.1:8787', { fetcher: silentFetch, timeoutMs: 50 })
    const silentMs = Date.now() - silentStarted
    const passed =
      healthy.ok && healthy.detail.includes('C:/cache') &&
      !busy.ok && busy.detail.includes('503') &&
      !refused.ok && refused.detail.includes('ECONNREFUSED') &&
      !silent.ok && silent.detail.includes('no answer within 50 ms') && silentMs < 2000
    results.push({ name: 'backend health probe answers ok, error status, connection refused and silence within its timeout', passed, detail: passed ? undefined : JSON.stringify({ healthy, busy, refused, silent, silentMs }) })
  }

  // The memory projection reproduces the two smoke points it is drawn
  // through, says the full universe is above a default ceiling, and
  // recommends a whole number of gigabytes with a quarter of headroom.
  {
    const [low, high] = SMOKE_MEMORY_POINTS
    const atLow = projectHeapNeed(low.names, 4288)
    const atHigh = projectHeapNeed(high.names, 4288)
    const full = projectHeapNeed(1073, 4288)
    const passed =
      atLow.projectedMb === low.peakRssMb && atHigh.projectedMb === high.peakRssMb &&
      !atLow.exceedsCeiling && full.exceedsCeiling &&
      full.projectedMb > 8192 && full.recommendedMb % 1024 === 0 && full.recommendedMb >= full.projectedMb * 1.25 &&
      full.recommendedMb - 1024 < full.projectedMb * 1.25 &&
      full.flag === `--max-old-space-size=${full.recommendedMb}` && full.perNameMb > 5 && full.perNameMb < 15
    results.push({ name: 'memory projection reproduces the smoke points and recommends a whole-gigabyte node flag above the default ceiling for the full universe', passed, detail: passed ? undefined : JSON.stringify({ atLow, atHigh, full }) })
  }

  // The settings hash does not care about ticker order and does care about
  // every setting it covers.
  {
    const base = {
      tickers: ['BBB', 'AAA', 'CCC'],
      featureNames: ['f0', 'f1'],
      momentumBaseline: '12-1' as const,
      correlation: 'pearson' as const,
      rule: resolveWindowRule({ stepTradingDays: 20, burnInYears: 10 }),
      excludeEtfs: true,
      freezeHparams: true,
    }
    const reference = hashRunSettings(base)
    const variants = [
      hashRunSettings({ ...base, tickers: ['AAA', 'BBB', 'DDD'] }),
      hashRunSettings({ ...base, featureNames: ['f1', 'f0'] }),
      hashRunSettings({ ...base, momentumBaseline: '12-0' }),
      hashRunSettings({ ...base, correlation: 'spearman' }),
      hashRunSettings({ ...base, rule: resolveWindowRule({ stepTradingDays: 10, burnInYears: 10 }) }),
      hashRunSettings({ ...base, rule: resolveWindowRule({ stepTradingDays: 20, burnInYears: 5 }) }),
      hashRunSettings({ ...base, rule: { ...base.rule, embargoTradingDays: base.rule.embargoTradingDays + 1 } }),
      hashRunSettings({ ...base, excludeEtfs: false }),
      hashRunSettings({ ...base, freezeHparams: false }),
    ]
    const passed =
      hashRunSettings({ ...base, tickers: ['AAA', 'BBB', 'CCC'] }) === reference &&
      variants.every((hash) => hash !== reference) && new Set(variants).size === variants.length && /^[0-9a-f]{64}$/.test(reference)
    results.push({ name: 'settings hash ignores ticker order and changes with every one of its nine settings', passed })
  }

  // The row hash: the same rows in any order hash the same; one changed
  // label, one changed fundamentals flag, or one missing name changes it;
  // rows appended after the through date do not.
  {
    const rows = fixtureRows(0x5eed)
    const through = sampleHashThroughDate(rows)
    const lastDate = rows.reduce((last, row) => (row.asOf > last ? row.asOf : last), '')
    const expectedThrough = new Date(Date.parse(`${lastDate}T00:00:00Z`) - SAMPLE_HASH_TAIL_MARGIN_DAYS * 86_400_000).toISOString().slice(0, 10)
    const base = hashSampleContent(rows, through)
    const reversed = hashSampleContent([...rows].reverse(), through)
    const label = hashSampleContent(rows.map((row, i) => (i === 10 ? { ...row, forwardReturn20d: row.forwardReturn20d + 1e-9 } : row)), through)
    const flag = hashSampleContent(rows.map((row, i) => (i === 10 ? { ...row, pitFundamentalsObserved: true } : row)), through)
    const cap = hashSampleContent(rows.map((row, i) => (i === 10 ? { ...row, logMarketCap: Number.NaN } : row)), through)
    const lostName = hashSampleContent(rows.filter((row) => row.ticker !== 'CCC'), through)
    const tail = hashSampleContent([...rows, { ...rows[rows.length - 1], asOf: '2031-01-02', forwardReturn20d: 99 }], through)
    const coveredCount = rows.filter((row) => row.asOf <= through!).length
    const passed =
      through === expectedThrough && base.count === coveredCount && coveredCount > 0 && coveredCount < rows.length &&
      reversed.sha256 === base.sha256 &&
      label.sha256 !== base.sha256 && flag.sha256 !== base.sha256 && cap.sha256 !== base.sha256 && lostName.sha256 !== base.sha256 &&
      tail.sha256 === base.sha256 && tail.count === base.count &&
      hashSampleContent([], null).count === 0
    results.push({ name: 'row hash is order-free, changes with one label, one fundamentals flag or one lost name, and ignores rows appended after its through date', passed, detail: passed ? undefined : JSON.stringify({ through, expectedThrough, count: base.count, coveredCount, total: rows.length }) })
  }

  // NaN and infinity survive the trip to disk and back; ordinary values and
  // the literal text "NaN" are left alone.
  {
    const original = { a: Number.NaN, b: [1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], c: 'NaN', d: null, e: { f: 0.5 } }
    const encoded = encodeJson(original)
    const decoded = decodeJson<typeof original>(encoded)
    const passed =
      Number.isNaN(decoded.a) &&
      decoded.b[0] === 1 &&
      decoded.b[1] === Number.POSITIVE_INFINITY &&
      decoded.b[2] === Number.NEGATIVE_INFINITY &&
      decoded.c === 'NaN' &&
      decoded.d === null &&
      decoded.e.f === 0.5 &&
      // Plain JSON.stringify would have written "a":null here.
      !encoded.includes('"a":null') &&
      encoded.includes('"d":null')
    results.push({ name: 'checkpoint JSON keeps NaN and infinity instead of turning them into null', passed, detail: passed ? undefined : encoded })
  }

  // Required-windows arithmetic on the contract's own worked numbers
  // (docs/EVIDENCE_QUALITY.md section 5): momentum lands near 765, random
  // near 81, a non-positive mean is "n/a", and a clear interval says so.
  {
    const momentum = requiredWindows({ pairedStepCount: 70, ci95: { lower: -0.0453, mean: 0.0203, upper: 0.0893 } })
    const random = requiredWindows({ pairedStepCount: 70, ci95: { lower: -0.0044, mean: 0.0474, upper: 0.0976 } })
    const negative = requiredWindows({ pairedStepCount: 70, ci95: { lower: -0.05, mean: -0.01, upper: 0.03 } })
    const clear = requiredWindows({ pairedStepCount: 70, ci95: { lower: 0.01, mean: 0.03, upper: 0.05 } })
    const none = requiredWindows({ pairedStepCount: 1, ci95: null })
    const passed =
      momentum.windowsNeeded != null && momentum.windowsNeeded >= 740 && momentum.windowsNeeded <= 800 &&
      random.windowsNeeded != null && random.windowsNeeded >= 78 && random.windowsNeeded <= 86 &&
      negative.windowsNeeded === null && !negative.alreadyClear &&
      clear.alreadyClear && clear.windowsNeeded != null && clear.windowsNeeded <= 70 &&
      none.windowsNeeded === null && none.mean === null
    results.push({
      name: 'required-windows arithmetic reproduces the contract worked example (about 765 for momentum, about 81 for random)',
      passed,
      detail: passed ? undefined : JSON.stringify({ momentum, random, negative, clear, none }),
    })
  }

  // Holdout split: windows starting before 2012-07-20 only.
  {
    const steps = [{ testStartDate: '2012-07-19' }, { testStartDate: '2012-07-20' }, { testStartDate: '2000-01-03' }]
    const before = holdoutWindows(steps).map((step) => step.testStartDate)
    const passed = before.length === 2 && before.includes('2012-07-19') && before.includes('2000-01-03')
    results.push({ name: `holdout split keeps only windows that start before ${HOLDOUT_CUTOFF_DATE}`, passed, detail: passed ? undefined : before.join(',') })
  }

  // The Dart flag parser: a bucket flagged isEtf: true gives up its symbols,
  // an unflagged bucket does not, and the class definition (which mentions
  // isEtf without a value) is not mistaken for a bucket.
  {
    const source = `
class DefaultSymbolBucket {
  const DefaultSymbolBucket({
    required this.sector,
    this.isEtf = false,
    required this.symbols,
  });
}
final buckets = [
  DefaultSymbolBucket(
    sector: 'Technology',
    industry: 'Software',
    symbols: ['MSFT', 'ORCL'],
  ),
  DefaultSymbolBucket(
    sector: 'ETF / Macro',
    industry: 'US equity indexes',
    isEtf: true,
    symbols: [
      'SPY',
      'ivv',
    ],
  ),
  DefaultSymbolBucket(
    sector: 'ETF / Macro',
    isEtf: true,
    symbols: ['XLK', 'XLF'],
  ),
];`
    const parsed = parseDartEtfSymbols(source)
    const passed = parsed.size === 4 && ['SPY', 'IVV', 'XLK', 'XLF'].every((symbol) => parsed.has(symbol)) && !parsed.has('MSFT')
    results.push({ name: 'Dart universe parser reads only the buckets flagged isEtf: true', passed, detail: passed ? undefined : [...parsed].join(',') })
  }

  // The fallback blocks: 286 funds, anchored on SPY..XLV and IVV..QAT.
  {
    const blocks = etfBlocksInDefaultTickers()
    const fallback = resolveEtfUniverse(null)
    const passed =
      blocks.length === 286 &&
      blocks.includes('SPY') && blocks.includes('QAT') && blocks.includes('GLD') && !blocks.includes('AAPL') &&
      fallback.source === 'default-ticker-etf-blocks' && fallback.symbols.size === 286 && fallback.dartFlaggedCount === null
    results.push({ name: 'ETF fallback blocks in DEFAULT_BACKTEST_TICKERS hold the 286 funds the contract counts', passed, detail: passed ? undefined : `blocks=${blocks.length} fallback=${fallback.source}/${fallback.symbols.size}` })
    let threw = false
    try {
      etfBlocksInDefaultTickers(['AAPL', 'MSFT'])
    } catch {
      threw = true
    }
    results.push({ name: 'ETF fallback refuses a ticker list without its anchors instead of excluding nothing', passed: threw })
  }

  // With the repository's Dart files present, the flag and the blocks agree
  // on every one of the 286 names.
  {
    const dartDir = join(process.cwd(), '..', 'lib', 'src', 'data')
    if (existsSync(join(dartDir, 'expanded_symbol_universe.dart'))) {
      const universe = resolveEtfUniverse(dartDir)
      const inDefault = etfBlocksInDefaultTickers().filter((ticker) => universe.symbols.has(ticker)).length
      const passed = universe.source === 'dart-universe-isEtf-flag' && universe.disagreements.length === 0 && inDefault === 286 && (universe.dartFlaggedCount ?? 0) > 286
      results.push({
        name: 'Dart universe isEtf flag agrees with the fallback blocks on all 286 default-universe funds',
        passed,
        detail: passed ? undefined : `source=${universe.source} flagged=${universe.dartFlaggedCount} inDefault=${inDefault} disagreements=${universe.disagreements.join(',')}`,
      })
    } else {
      results.push({ name: 'Dart universe isEtf flag agrees with the fallback blocks (skipped: Dart files not beside desktop-js)', passed: true })
    }
  }

  // The block bootstrap here is the core's, bit for bit: the core's
  // trees-minus-random paired interval is a block bootstrap of the tree IC
  // itself (the random baseline is exactly zero), so the two must agree.
  {
    const calendar = weekdayCalendar('2020-01-01', 400)
    const steps = Array.from({ length: 30 }, (_, i) => ({
      testStartDate: calendar[i * 10],
      testLabelEndDate: calendar[i * 10 + 19],
      informationCoefficient: Math.sin(i * 0.7) * 0.1 + 0.02,
      baselineRandomIc: 0,
      baselineMomentumIc: Number.NaN,
    }))
    const evidence = computeBaselineEvidence(steps, 1000)
    const mine = blockBootstrapStat(
      steps.map((step) => step.informationCoefficient),
      (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
      evidence.random.blockLength ?? 1,
      1000,
    )
    const passed = JSON.stringify(mine) === JSON.stringify(evidence.random.ci95)
    results.push({ name: 'block bootstrap matches the core bit for bit through the trees-minus-random channel', passed, detail: passed ? undefined : `${JSON.stringify(mine)} vs ${JSON.stringify(evidence.random.ci95)}` })
  }

  // The checkpoint directory: writes, reads back, refuses another
  // configuration, ignores a half-written last line, refuses a corrupt one.
  const fixtureRule = resolveWindowRule({ stepTradingDays: 20, burnInYears: 1 })
  const fixtureSamples = fixtureRows(0x5eed)
  const fixtureThroughDate = sampleHashThroughDate(fixtureSamples)
  const fingerprint: CheckpointFingerprint = {
    schemaVersion: 2,
    tickers: ['AAA', 'BBB', 'CCC'],
    featureNames: ['f0', 'f1', 'f2'],
    rule: fixtureRule,
    momentumBaseline: '12-1',
    correlation: 'pearson',
    hyperparameters: { numTrees: 5, depth: 2, learningRate: 0.1 },
    freezeHparams: true,
    horizonDays: 20,
    range: 'max',
    excludeEtfs: true,
    cadenceDays: 1,
    firstSampleDate: '2018-01-01',
    usableTickers: ['AAA', 'BBB', 'CCC'],
    settingsHash: hashRunSettings({
      tickers: ['AAA', 'BBB', 'CCC'],
      featureNames: ['f0', 'f1', 'f2'],
      momentumBaseline: '12-1',
      correlation: 'pearson',
      rule: fixtureRule,
      excludeEtfs: true,
      freezeHparams: true,
    }),
    fundamentals: { tickersWithFundamentals: 3, sampleCoveragePct: 100 },
    samples: hashSampleContent(fixtureSamples, fixtureThroughDate),
  }
  const scratch = mkdtempSync(join(tmpdir(), 'preregistered-run-tests-'))
  try {
    {
      const dir = join(scratch, 'basic')
      const checkpoint = openCheckpoint(dir, fingerprint)
      const window = { index: 0, testStartDate: '2019-01-02', testEndDate: '2019-01-30', tradingDayCount: 20, trainAsOfCutoff: '2018-12-24', testRowCount: 60, testNameCount: 3 }
      recordWindow(checkpoint, window, null)
      const reopened = openCheckpoint(dir, fingerprint)
      const marker = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8')) as { completedWindows: number; lastTestEndDate: string }
      const passed = reopened.completed.size === 1 && reopened.completed.get(0)?.scored === false && marker.completedWindows === 1 && marker.lastTestEndDate === '2019-01-30' && !reopened.droppedPartialLine
      results.push({ name: 'checkpoint writes a window, rewrites the resume marker, and reads both back', passed, detail: passed ? undefined : JSON.stringify({ size: reopened.completed.size, marker }) })

      let refused = ''
      try {
        openCheckpoint(dir, { ...fingerprint, correlation: 'spearman' })
      } catch (error) {
        refused = (error as Error).message
      }
      results.push({ name: 'checkpoint refuses to resume under a different configuration and names the difference', passed: refused.includes('correlation'), detail: refused || 'no error thrown' })

      // A universe that lost a name (a fetch that failed this time) is
      // reported by name, not as two dumped arrays.
      let namedDifference = ''
      try {
        openCheckpoint(dir, { ...fingerprint, usableTickers: ['AAA', 'BBB', 'DDD'] })
      } catch (error) {
        namedDifference = (error as Error).message
      }
      const namesTheDifference = namedDifference.includes('usableTickers: missing now: CCC; new now: DDD') && !namedDifference.includes('["AAA"')
      results.push({ name: 'checkpoint names the tickers that went missing or appeared instead of dumping both lists', passed: namesTheDifference, detail: namesTheDifference ? undefined : namedDifference || 'no error thrown' })

      // A crash mid-write leaves a cut-off last line; it is dropped, not fatal.
      writeFileSync(join(dir, 'windows.jsonl'), readFileSync(join(dir, 'windows.jsonl'), 'utf8') + '{"index":1,"testStartDate":"2019-0')
      const partial = openCheckpoint(dir, fingerprint)
      results.push({ name: 'checkpoint ignores a half-written last line so that window is scored again', passed: partial.droppedPartialLine && partial.completed.size === 1 && !partial.completed.has(1) })

      // A corrupt line in the middle is a different matter: refuse.
      writeFileSync(join(dir, 'windows.jsonl'), 'not json\n' + encodeJson({ ...window, index: 2, scored: false, trainSize: null, step: null, completedAt: 'x' }) + '\n')
      let corruptRefused = false
      try {
        openCheckpoint(dir, fingerprint)
      } catch {
        corruptRefused = true
      }
      results.push({ name: 'checkpoint refuses a corrupt line that is not the last one', passed: corruptRefused })
    }

    // The lock file: the opener's process id is written; the same process
    // may reopen; a lock whose process is gone is taken over and reported;
    // a lock held by a live process is refused; releasing removes it.
    {
      const dir = join(scratch, 'lock')
      const lockPath = join(dir, 'lock.json')
      const first = openCheckpoint(dir, fingerprint)
      const written = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; hostname: string }
      const again = openCheckpoint(dir, fingerprint)
      const ownLock = written.pid === process.pid && written.hostname === hostname() && first.lockReclaimed === null && again.lockReclaimed === null
      results.push({ name: 'checkpoint writes a lock with its own process id and lets the same process reopen', passed: ownLock, detail: ownLock ? undefined : JSON.stringify({ written, first: first.lockReclaimed, again: again.lockReclaimed }) })

      releaseCheckpoint(first)
      const gone = !existsSync(lockPath)
      writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, hostname: hostname(), startedAt: '2026-09-16T00:00:00.000Z', command: 'node backtest-cli.mjs --checkpoint x' }))
      const reclaimed = openCheckpoint(dir, fingerprint)
      const afterReclaim = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }
      const stalePassed = gone && reclaimed.lockReclaimed?.pid === 999_999_999 && reclaimed.lockReclaimed.startedAt === '2026-09-16T00:00:00.000Z' && afterReclaim.pid === process.pid
      results.push({ name: 'checkpoint takes over a stale lock whose process is gone and says whose it was', passed: stalePassed, detail: stalePassed ? undefined : JSON.stringify({ gone, reclaimed: reclaimed.lockReclaimed, afterReclaim }) })
      releaseCheckpoint(reclaimed)

      // The parent process (the shell or runner that started this test) is
      // alive and is not us: exactly what a second concurrent run looks like.
      let parentAlive = false
      try {
        process.kill(process.ppid, 0)
        parentAlive = true
      } catch {
        parentAlive = false
      }
      if (parentAlive) {
        writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: '2026-09-16T01:00:00.000Z', command: 'node backtest-cli.mjs --checkpoint x' }))
        let refused = ''
        try {
          openCheckpoint(dir, fingerprint)
        } catch (error) {
          refused = (error as Error).message
        }
        const stillTheirs = (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid === process.ppid
        const livePassed = refused.includes('in use by another run') && refused.includes(`pid ${process.ppid}`) && stillTheirs
        results.push({ name: 'checkpoint refuses to open while a live process holds the lock, and leaves that lock alone', passed: livePassed, detail: livePassed ? undefined : refused || 'no error thrown' })
        unlinkSync(lockPath)
      } else {
        results.push({ name: 'checkpoint refuses to open while a live process holds the lock (skipped: no live parent process to stand in)', passed: true })
      }

      // A lock from another machine cannot be checked and is refused too.
      writeFileSync(lockPath, JSON.stringify({ pid: 12, hostname: `${hostname()}-elsewhere`, startedAt: '2026-09-16T02:00:00.000Z', command: '' }))
      let elsewhere = ''
      try {
        openCheckpoint(dir, fingerprint)
      } catch (error) {
        elsewhere = (error as Error).message
      }
      results.push({ name: 'checkpoint refuses a lock written on another machine instead of guessing', passed: elsewhere.includes('another machine'), detail: elsewhere || 'no error thrown' })
      unlinkSync(lockPath)

      const last = openCheckpoint(dir, fingerprint)
      releaseCheckpoint(last)
      releaseCheckpoint(last)
      results.push({ name: 'releasing the checkpoint removes its lock, and releasing twice is harmless', passed: !existsSync(lockPath) })
    }

    // The content fingerprint: a resume whose rows, fundamentals coverage
    // or settings differ is refused with the field named in plain words,
    // the stored through date is read back for the next hash, and a
    // checkpoint from the older schema is refused outright.
    {
      const dir = join(scratch, 'content')
      releaseCheckpoint(openCheckpoint(dir, fingerprint))
      const storedThrough = readStoredFingerprint(dir)?.samples.throughDate
      results.push({ name: 'a resume reads the through date the checkpoint was created with', passed: storedThrough === fixtureThroughDate && fixtureThroughDate != null, detail: `${storedThrough} vs ${fixtureThroughDate}` })

      const tamperedRows = fixtureSamples.map((row, i) => (i === 100 ? { ...row, forwardReturn20d: row.forwardReturn20d + 1e-6 } : row))
      let rowsRefused = ''
      try {
        openCheckpoint(dir, { ...fingerprint, samples: hashSampleContent(tamperedRows, storedThrough ?? null) })
      } catch (error) {
        rowsRefused = (error as Error).message
      }
      const rowsPassed = rowsRefused.includes('samples:') && rowsRefused.includes('rows differ') && rowsRefused.includes('different data') && !existsSync(join(dir, 'lock.json'))
      results.push({ name: 'a resume whose rows hash differently is refused with the row hash named and the lock given back', passed: rowsPassed, detail: rowsPassed ? undefined : rowsRefused || 'no error thrown' })

      const tailRows = [...fixtureSamples, { ...fixtureSamples[fixtureSamples.length - 1], asOf: '2031-01-02', forwardReturn20d: 99 }]
      let tailRefused = ''
      try {
        releaseCheckpoint(openCheckpoint(dir, { ...fingerprint, samples: hashSampleContent(tailRows, storedThrough ?? null) }))
      } catch (error) {
        tailRefused = (error as Error).message
      }
      results.push({ name: 'a resume whose fetch appended rows after the through date still opens', passed: tailRefused === '', detail: tailRefused || undefined })

      let coverageRefused = ''
      try {
        openCheckpoint(dir, { ...fingerprint, fundamentals: { tickersWithFundamentals: 1, sampleCoveragePct: 25.7 } })
      } catch (error) {
        coverageRefused = (error as Error).message
      }
      const coveragePassed = coverageRefused.includes('fundamentals:') && coverageRefused.includes('100%') && coverageRefused.includes('25.7%')
      results.push({ name: 'a resume with different fundamentals coverage is refused with both percentages side by side', passed: coveragePassed, detail: coveragePassed ? undefined : coverageRefused || 'no error thrown' })

      let settingsRefused = ''
      try {
        openCheckpoint(dir, { ...fingerprint, settingsHash: hashRunSettings({ tickers: ['AAA', 'BBB', 'CCC'], featureNames: ['f0', 'f1', 'f2'], momentumBaseline: '12-1', correlation: 'pearson', rule: fixtureRule, excludeEtfs: true, freezeHparams: false }) })
      } catch (error) {
        settingsRefused = (error as Error).message
      }
      results.push({ name: 'a resume whose settings hash differs is refused naming the settings hash', passed: settingsRefused.includes('settingsHash'), detail: settingsRefused || 'no error thrown' })

      const oldDir = join(scratch, 'schema1')
      const { settingsHash: _settings, fundamentals: _fundamentals, samples: _samples, freezeHparams: _freeze, ...older } = fingerprint
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(join(oldDir, 'run.json'), encodeJson({ createdAt: 'x', fingerprint: { ...older, schemaVersion: 1 } }))
      let schemaRefused = ''
      try {
        openCheckpoint(oldDir, fingerprint)
      } catch (error) {
        schemaRefused = (error as Error).message
      }
      results.push({ name: 'a checkpoint written with the older fingerprint schema is refused outright', passed: schemaRefused.includes('schema 1') && schemaRefused.includes('schema 2'), detail: schemaRefused || 'no error thrown' })
    }

    // The main event: stop after five fresh windows, resume, and match the
    // core's single call exactly, served models included.
    {
      const rows = fixtureRows(0x5eed)
      const rule = resolveWindowRule({ stepTradingDays: 20, burnInYears: 1 })
      const modelOptions = { numTrees: 5, depth: 2, learningRate: 0.1 }
      const reference = runWalkForwardBacktest(rows, {
        ...rule,
        modelOptions,
        baselineMomentumFeatureIndex: 1,
        captureTestDetails: true,
      })
      const sorted = indexSamples(rows)
      const windows = buildCalendarWindows(sorted, rule)
      const stepOptions = {
        horizonDays: 20,
        txCostBps: 10,
        modelOptions,
        baselineMomentumFeatureIndex: 1,
        momentumBaseline: '12-1' as const,
        correlation: 'pearson' as const,
        captureTestDetails: true,
      }
      const dir = join(scratch, 'resume')
      let stopped: WindowLoopStopped | null = null
      try {
        runCheckpointedWindows({ sorted, windows, checkpoint: openCheckpoint(dir, fingerprint), stepOptions, stopAfterFreshWindows: 5 })
      } catch (error) {
        if (error instanceof WindowLoopStopped) stopped = error
        else throw error
      }
      const linesAfterStop = readFileSync(join(dir, 'windows.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0).length
      const resumed = runCheckpointedWindows({ sorted, windows, checkpoint: openCheckpoint(dir, fingerprint), stepOptions })
      const served = trainFinalModelsWithCore({ samples: rows, rule, modelOptions, baselineMomentumFeatureIndex: 1 })
      const assembled = assembleFullResult({
        sorted,
        windows,
        rule,
        steps: resumed.steps,
        served,
        momentumBaseline: '12-1',
        correlation: 'pearson',
        horizonDays: 20,
        hyperparameterSelection: 'caller-supplied',
      })
      const left = encodeJson(assembled)
      const right = encodeJson(reference)
      const passed =
        reference != null &&
        stopped != null && stopped.windowsComputed === 5 && linesAfterStop === 5 &&
        resumed.replayedWindows === 5 && resumed.computedWindows === windows.length - 5 &&
        resumed.steps.length === reference.steps.length &&
        left === right
      results.push({
        name: 'a run stopped after five windows and resumed from its checkpoint equals one straight core call, bit for bit',
        passed,
        detail: passed
          ? undefined
          : `stopped=${stopped?.windowsComputed} lines=${linesAfterStop} replayed=${resumed.replayedWindows} computed=${resumed.computedWindows} ` +
            `windows=${windows.length} steps=${resumed.steps.length}/${reference?.steps.length} diff: ${firstDifference(left, right)}`,
      })

      // Every window from the finished checkpoint replays; nothing is rescored.
      const replayAll = runCheckpointedWindows({ sorted, windows, checkpoint: openCheckpoint(dir, fingerprint), stepOptions })
      results.push({ name: 'a finished checkpoint replays every window and scores none again', passed: replayAll.computedWindows === 0 && replayAll.replayedWindows === windows.length && encodeJson(replayAll.steps) === encodeJson(reference?.steps) })

      // A checkpoint whose recorded window no longer matches the rebuilt data is refused.
      const tampered = readFileSync(join(dir, 'windows.jsonl'), 'utf8').replace('"testRowCount":60', '"testRowCount":59')
      writeFileSync(join(dir, 'windows.jsonl'), tampered)
      let mismatchRefused = ''
      try {
        runCheckpointedWindows({ sorted, windows, checkpoint: openCheckpoint(dir, fingerprint), stepOptions })
      } catch (error) {
        mismatchRefused = (error as Error).message
      }
      results.push({ name: 'a replayed window whose rows no longer match the rebuilt data is refused', passed: mismatchRefused.includes('does not match'), detail: mismatchRefused || 'no error thrown' })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  // The serving validator accepts an artifact whose provenance carries the
  // optional pre-registered-run record, and treats it exactly like one
  // without it.
  {
    const plain = promotableStoredModel()
    const withRecord = promotableStoredModel()
    ;(withRecord.datasetProvenance as unknown as Record<string, unknown>).preRegisteredRun = samplePreRegisteredProvenance()
    const before = modelDecisionAuthority(plain)
    const after = modelDecisionAuthority(withRecord)
    const passed = before.canLeadDecisions && after.canLeadDecisions && after.status === 'promoted' && JSON.stringify(before) === JSON.stringify(after)
    results.push({ name: 'serving validator accepts an artifact with the optional preRegisteredRun provenance and judges it the same', passed, detail: passed ? undefined : `${JSON.stringify(before)} vs ${JSON.stringify(after)}` })

    const artifactPath = join(process.cwd(), 'tools', 'ml_trained_model.json')
    if (existsSync(artifactPath)) {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as StoredMlModel
      const baseline = modelDecisionAuthority(artifact)
      ;(artifact.datasetProvenance as unknown as Record<string, unknown>).preRegisteredRun = samplePreRegisteredProvenance()
      const amended = modelDecisionAuthority(artifact)
      const same = JSON.stringify(baseline) === JSON.stringify(amended)
      results.push({ name: `the saved artifact on disk keeps its authority verdict (${baseline.status}) once the optional record is added`, passed: same, detail: same ? undefined : `${JSON.stringify(baseline)} vs ${JSON.stringify(amended)}` })
    }
  }

  return results
}
