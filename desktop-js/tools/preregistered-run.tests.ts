/**
 * Tests for the pre-registered runner's helpers (tools/preregistered-run.ts).
 *
 * The one that matters most: a run that is stopped part-way and resumed
 * from its checkpoint must produce exactly the numbers that one straight
 * call into runWalkForwardBacktest produces, down to the last bit. Every
 * source of randomness in the core is seeded from the data, so "exactly"
 * is the right standard, and JSON text equality is the check.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BACKTEST_TICKERS,
  EXCLUDED_UNFETCHABLE,
  HISTORICAL_FEATURE_PIPELINE_VERSION,
  TICKER_RENAMES,
  assessModelPromotion,
  buildCalendarWindows,
  computeBaselineEvidence,
  describeUniverseAttrition,
  indexSamples,
  planUniverseFetch,
  resolveWindowRule,
  runWalkForwardBacktest,
  type BacktestDatasetQuality,
  type BaselineEvidence,
  type HistoricalSample,
} from '../src/data/historicalBacktest'
import { fetchDailyBars } from '../src/data/marketData'
import { createServingEnsembleAudit, modelDecisionAuthority, type StoredMlModel } from '../src/data/mlModelService'
import {
  HOLDOUT_CUTOFF_DATE,
  IDENTITY_FIRST_TRADE_TOLERANCE_DAYS,
  IDENTITY_NAME_OVERLAP_THRESHOLD,
  POST_LOOP_MEMORY_FACTOR,
  POST_LOOP_MEMORY_POINT,
  REGISTERED_IDENTITY_SNAPSHOT_DATE,
  SAMPLE_HASH_TAIL_MARGIN_DAYS,
  SMOKE_MEMORY_POINTS,
  STUB_FIRST_BAR_AFTER,
  STUB_MIN_BARS_MAX_RANGE,
  WindowLoopStopped,
  assembleFullResult,
  blockBootstrapStat,
  buildRegisteredIdentityLedger,
  checkIdentity,
  decodeJson,
  encodeJson,
  etfBlocksInDefaultTickers,
  hashRunSettings,
  hashSampleContent,
  holdoutWindows,
  identityByTicker,
  memoryGuardVerdict,
  nameOverlap,
  openCheckpoint,
  parseDartEtfSymbols,
  parseSecTickerMap,
  parseYahooChartMeta,
  probeBackendHealth,
  projectHeapNeed,
  hashRegisteredIdentityLedger,
  readRegisteredIdentityLedger,
  readStoredFingerprint,
  recordWindow,
  registeredIdentityPath,
  registeredPrefixForLimit,
  releaseCheckpoint,
  requiredWindows,
  resolveEtfUniverse,
  runCheckpointedWindows,
  sameName,
  sampleHashThroughDate,
  serializeRegisteredIdentityLedger,
  summarizeIdentityChecks,
  trainFinalModelsWithCore,
  classifyStubSeries,
  readCheckpointUniverse,
  recordUniverseInCheckpoint,
  warmDailyBars,
  warmFundamentals,
  yahooChartUrl,
  type CheckpointFingerprint,
  type PreRegisteredRunProvenance,
  type RegisteredIdentity,
  type YahooChartMeta,
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
    universe: {
      requested: 1359,
      etfsExcluded: 286,
      etfSource: 'dart-universe-isEtf-flag',
      registered: 1073,
      registeredButExcluded: 57,
      excludedNames: [{ ticker: 'PXD', delistingDate: '2024-05-03', reason: 'acquired by Exxon Mobil' }],
      renamed: 16,
      renames: [{ original: 'SQ', fetchedAs: 'XYZ' }],
      stubs: [],
      attrition: describeUniverseAttrition(1073, 57),
      trained: 1016,
    },
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

  // The fail-loud guard after the ledgers: a registered name that is in
  // neither ledger and still cannot be fetched comes back on the warm-up's
  // failed list, which is what stops the run. Names in the ledgers never
  // reach the warm-up: an excluded name is set aside, a renamed name is
  // asked for under its successor.
  {
    const plan = planUniverseFetch(['AAPL', 'PXD', 'SQ', 'ZZZZBOGUS'])
    const fetchSymbolOf = (ticker: string) => plan.fetch.find((entry) => entry.ticker === ticker)?.fetchedAs ?? ticker
    const requested: string[] = []
    const warm = await warmDailyBars(
      plan.fetch.map((entry) => entry.ticker),
      async (ticker) => {
        requested.push(fetchSymbolOf(ticker))
        return fetchSymbolOf(ticker) === 'ZZZZBOGUS' ? [] : [1]
      },
      { attempts: 4, pauseMs: 0 },
    )
    const passed =
      warm.failed.join(',') === 'ZZZZBOGUS' &&
      warm.usable.join(',') === 'AAPL,SQ' &&
      plan.excluded.map((entry) => entry.ticker).join(',') === 'PXD' &&
      !requested.includes('PXD') &&
      !requested.includes('SQ') &&
      requested.includes('XYZ') &&
      requested.filter((symbol) => symbol === 'ZZZZBOGUS').length === 4
    results.push({ name: 'fail-loud guard: an unlisted unfetchable name still comes back failed from the warm-up, while ledger names never reach it', passed, detail: passed ? undefined : JSON.stringify({ warm, requested, excluded: plan.excluded.map((entry) => entry.ticker) }) })
  }

  // Stubs at the warm-up. A synthetic stub (one bar under a registered
  // symbol) and a young listing (80 bars, not registered) are named and set
  // apart from both the usable and the failed names; a stub is not retried;
  // a fetch that answers nothing is still a failure; and the printed line
  // has the promised form.
  {
    const bar = (date: string) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 })
    const series = (from: string, count: number) => {
      const out = []
      const start = new Date(`${from}T00:00:00Z`).getTime()
      for (let i = 0; i < count; i++) out.push(bar(new Date(start + i * 86_400_000).toISOString().slice(0, 10)))
      return out
    }
    const answers: Record<string, ReturnType<typeof series>> = {
      AAPL: series('1980-12-12', 6000),
      EA: series('2026-08-04', 1),
      YOUNG: series('2026-06-03', 80),
      ZZZZBOGUS: [],
    }
    const calls = new Map<string, number>()
    const printed: string[] = []
    const registered = new Set<string>(DEFAULT_BACKTEST_TICKERS)
    const warm = await warmDailyBars(
      ['AAPL', 'EA', 'ZZZZBOGUS', 'YOUNG'],
      async (ticker) => {
        calls.set(ticker, (calls.get(ticker) ?? 0) + 1)
        return answers[ticker]
      },
      {
        attempts: 4,
        pauseMs: 0,
        stubCheck: (ticker, bars) => classifyStubSeries(ticker, bars, { registered: registered.has(ticker), maxRange: true }),
        onStub: (stub) => printed.push(stub.line),
      },
    )
    const ea = warm.stubs.find((stub) => stub.ticker === 'EA')
    const young = warm.stubs.find((stub) => stub.ticker === 'YOUNG')
    const passed =
      warm.usable.join(',') === 'AAPL' &&
      warm.failed.join(',') === 'ZZZZBOGUS' &&
      warm.stubs.map((stub) => stub.ticker).join(',') === 'EA,YOUNG' &&
      ea?.rule === 'first-bar-after-listing-floor' && ea.firstBar === '2026-08-04' && ea.bars === 1 &&
      young?.rule === 'fewer-than-a-year-of-bars' && young.firstBar === '2026-06-03' && young.bars === 80 &&
      printed.length === 2 && printed[0].startsWith('STUB: EA first bar 2026-08-04, 1 bar') && printed[1].startsWith('STUB: YOUNG first bar 2026-06-03, 80 bars') &&
      calls.get('EA') === 1 && calls.get('YOUNG') === 1 && calls.get('ZZZZBOGUS') === 4 && calls.get('AAPL') === 1 &&
      warm.retries === 3
    results.push({ name: 'warm-up stub detection: a one-bar stub under a registered symbol and an 80-bar young listing are named as stubs, not retried, and kept apart from usable and failed', passed, detail: passed ? undefined : JSON.stringify({ warm, printed, calls: [...calls] }) })
  }

  // The two stub rules on their own. The listing-floor rule applies to
  // registered names only (a caller-supplied young listing is not a stub by
  // that rule) and catches a re-listed series even when it holds a year of
  // bars; the bar-count rule applies to full-history fetches only; an empty
  // series is a fetch failure, not a stub; bars without a date still count.
  {
    const bars = (from: string, count: number) => Array.from({ length: count }, (_, i) => ({ date: new Date(new Date(`${from}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10) }))
    const reListed = classifyStubSeries('WOLF', bars('2025-09-29', 300), { registered: true, maxRange: true })
    const youngCustom = classifyStubSeries('YOUNG', bars('2025-09-29', 300), { registered: false, maxRange: true })
    const old = classifyStubSeries('AAPL', bars('1980-12-12', 6000), { registered: true, maxRange: true })
    const shortRange = classifyStubSeries('AAPL', bars('2026-05-01', 90), { registered: true, maxRange: false })
    const empty = classifyStubSeries('EA', [], { registered: true, maxRange: true })
    const undated = classifyStubSeries('X', Array.from({ length: 100 }, () => ({})), { registered: false, maxRange: true })
    const passed =
      reListed?.rule === 'first-bar-after-listing-floor' &&
      youngCustom?.rule === 'fewer-than-a-year-of-bars' === false && youngCustom == null &&
      old == null &&
      shortRange?.rule === 'first-bar-after-listing-floor' &&
      empty == null &&
      undated?.rule === 'fewer-than-a-year-of-bars' && undated.firstBar == null && /first bar unknown, 100 bars/.test(undated.line) &&
      STUB_FIRST_BAR_AFTER === '2025-01-01' && STUB_MIN_BARS_MAX_RANGE === 252
    results.push({ name: 'stub rules: a registered series that starts after 2025-01-01 is a stub even with a year of bars; a young caller-supplied listing with a year of bars is not; fewer than 252 bars on a full fetch is', passed, detail: passed ? undefined : JSON.stringify({ reListed, youngCustom, old, shortRange, empty, undated }) })
  }

  // --limit N means N fetched names; the registered prefix that holds them
  // keeps an excluded name inside it on the record.
  {
    const ledger = { renames: {}, excluded: [{ ticker: 'GONE', delistingDate: '2025-01-02', reason: 'acquired by Test Co', evidence: 'test' }] }
    const list = ['A', 'GONE', 'B', 'C']
    const two = registeredPrefixForLimit(list, 2, ledger)
    const all = registeredPrefixForLimit(list, 0, ledger)
    const beyond = registeredPrefixForLimit(list, 9, ledger)
    const one = registeredPrefixForLimit(list, 1, ledger)
    const passed = two.join(',') === 'A,GONE,B' && all.join(',') === 'A,GONE,B,C' && beyond.join(',') === 'A,GONE,B,C' && one.join(',') === 'A'
    results.push({ name: '--limit keeps N fetchable names and registers the prefix that holds them, excluded names included', passed, detail: passed ? undefined : JSON.stringify({ two, all, beyond, one }) })
  }

  // No fund is in either ledger: the funds are already out of the scored
  // cross-section, and a ledger entry for one would count it twice.
  {
    const funds = new Set(etfBlocksInDefaultTickers())
    const fundsInLedgers = [...Object.keys(TICKER_RENAMES), ...EXCLUDED_UNFETCHABLE.map((entry) => entry.ticker)].filter((ticker) => funds.has(ticker))
    results.push({ name: 'neither unfetchable ledger names a fund', passed: fundsInLedgers.length === 0, detail: fundsInLedgers.join(',') || undefined })
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

  // The memory projection: the loop line reproduces the two smoke points it
  // is drawn through, the whole-run projection is that line times the
  // post-loop factor (1.4, the 200-name smoke's OS-level peak over its loop
  // line), the recommended flag is a whole number of gigabytes with a
  // quarter of headroom, and free memory below the recommendation is named
  // as a shortfall. Synthetic inputs: 200 names (the measured smoke) and the
  // 1,023-name universe, against 3,500 MB free (what the machine showed on
  // 2026-09-16) and a roomy 20,000 MB.
  {
    const [low, high] = SMOKE_MEMORY_POINTS
    const atLow = projectHeapNeed(low.names, 4288)
    const atHigh = projectHeapNeed(high.names, 4288)
    const smoke = projectHeapNeed(POST_LOOP_MEMORY_POINT.names, 4288, 3500)
    const full = projectHeapNeed(1023, 4288, 3500)
    const roomy = projectHeapNeed(POST_LOOP_MEMORY_POINT.names, 8192, 20_000)
    const unread = projectHeapNeed(POST_LOOP_MEMORY_POINT.names, 4288)
    const passed =
      atLow.loopProjectedMb === low.peakRssMb && atHigh.loopProjectedMb === high.peakRssMb &&
      atLow.projectedMb === Math.round(low.peakRssMb * POST_LOOP_MEMORY_FACTOR) && !atLow.exceedsCeiling &&
      POST_LOOP_MEMORY_FACTOR === 1.4 && Math.abs(POST_LOOP_MEMORY_POINT.osPeakWorkingSetMb / POST_LOOP_MEMORY_POINT.loopProjectedMb - POST_LOOP_MEMORY_FACTOR) < 0.01 &&
      smoke.loopProjectedMb === POST_LOOP_MEMORY_POINT.loopProjectedMb && smoke.loopProjectedMb === 2039 &&
      smoke.projectedMb === 2855 && smoke.postLoopFactor === 1.4 && smoke.recommendedMb === 4096 && smoke.flag === '--max-old-space-size=4096' &&
      !smoke.exceedsCeiling && smoke.freeMemoryMb === 3500 && smoke.freeMemoryShortfallMb === 596 && smoke.belowFreeMemory &&
      full.loopProjectedMb === 9528 && full.projectedMb === 13339 && full.recommendedMb === 17408 && full.flag === '--max-old-space-size=17408' &&
      full.exceedsCeiling && full.belowFreeMemory && full.freeMemoryShortfallMb === 17408 - 3500 &&
      full.recommendedMb % 1024 === 0 && full.recommendedMb >= full.projectedMb * 1.25 && full.recommendedMb - 1024 < full.projectedMb * 1.25 &&
      full.perNameMb > 5 && full.perNameMb < 15 &&
      !roomy.exceedsCeiling && !roomy.belowFreeMemory && roomy.freeMemoryShortfallMb === 0 &&
      unread.freeMemoryMb === null && !unread.belowFreeMemory && unread.freeMemoryShortfallMb === 0
    results.push({ name: 'memory projection: loop line through the smoke points, times 1.4 for the unsampled post-loop phase (200 names -> 2855 MB, flag 4096; 1023 names -> 13339 MB, flag 17408), with the free-memory shortfall named', passed, detail: passed ? undefined : JSON.stringify({ atLow, atHigh, smoke, full, roomy, unread }) })
  }

  // The memory guard's verdict: free memory below the recommended heap
  // stops the run and says how much is missing and what to do; the heap
  // ceiling below the projection stops it too; --allow-low-heap turns
  // either into a warning; a roomy machine has nothing to say.
  {
    const short = projectHeapNeed(200, 4288, 3500)
    const strict = memoryGuardVerdict(short, false)
    const waived = memoryGuardVerdict(short, true)
    const fine = memoryGuardVerdict(projectHeapNeed(200, 8192, 20_000), false)
    const ceiling = memoryGuardVerdict(projectHeapNeed(1023, 4288, 40_000), false)
    const both = memoryGuardVerdict(projectHeapNeed(1023, 4288, 3500), false)
    const passed =
      strict.abort && strict.problems.length === 1 && /only 3500 MB of memory is free, 596 MB short of the recommended heap \(4096 MB for 200 names\)/.test(strict.problems[0]) &&
      /close other applications/.test(strict.advice[0]) &&
      !waived.abort && waived.problems.length === 1 && waived.advice.length === 1 &&
      !fine.abort && fine.problems.length === 0 && fine.advice.length === 0 &&
      ceiling.abort && ceiling.problems.length === 1 && /heap ceiling \(4288 MB\) is below the projected need \(13339 MB for 1023 names\)/.test(ceiling.problems[0]) && /--max-old-space-size=17408/.test(ceiling.advice[0]) &&
      both.abort && both.problems.length === 2 && both.advice.length === 2
    results.push({ name: 'memory guard: free memory below the recommended heap aborts with the shortfall named (unless --allow-low-heap); so does a heap ceiling below the projection', passed, detail: passed ? undefined : JSON.stringify({ strict, waived, fine, ceiling, both }) })
  }

  // The identity rules. (a) A different SEC CIK is a different company:
  // RECYCLED. (c) The same CIK with a new name is the company renamed in
  // place: an IDENTITY NOTE, allowed. (b) With no CIK on either side the
  // chart's first-trade date and name decide: a date more than 30 days
  // away, or a name sharing fewer than half its words, is RECYCLED; a date
  // a fortnight off with the same name is a match; the same words in a
  // shorter name is a rename note. The SEC map dropping a symbol since the
  // snapshot is not by itself a recycle when the chart still matches. A
  // name not in the ledger is reported as unregistered, and one with no
  // CIK, no meta and nothing to compare is unverified. The summary line has
  // the promised form.
  {
    const registered = (over: Partial<RegisteredIdentity>): RegisteredIdentity => ({ ticker: 'ACME', fetchSymbol: 'ACME', etf: false, cik: 111, secName: 'ACME CORP', yahooLongName: 'Acme Corporation', yahooShortName: 'Acme Corp', yahooFirstTradeDate: '1990-01-02', snapshotDate: '2026-09-16', ...over })
    const meta = (over: Partial<YahooChartMeta>): YahooChartMeta => ({ symbol: 'ACME', longName: 'Acme Corporation', shortName: 'Acme Corp', firstTradeDate: '1990-01-02', exchange: 'NYSE', instrumentType: 'EQUITY', ...over })
    const recycled = checkIdentity('ACME', 'ACME', registered({}), { cik: 222, secName: 'Impostor Software Inc', meta: meta({ longName: 'Impostor Software, Inc.', shortName: 'Impostor Software', firstTradeDate: '2021-02-12' }) })
    const renamed = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME HOLDINGS CORP', meta: meta({ longName: 'Acme Holdings Corporation' }) })
    const matched = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ longName: 'Acme Corporation, Inc.' }) })
    const fund = registered({ ticker: 'FUND', fetchSymbol: 'FUND', etf: true, cik: null, secName: null, yahooLongName: 'iShares Example Fund ETF', yahooShortName: 'ISHARES EXAMPLE', yahooFirstTradeDate: '2005-03-01' })
    const fundMeta = (over: Partial<YahooChartMeta>) => meta({ symbol: 'FUND', longName: 'iShares Example Fund ETF', shortName: 'ISHARES EXAMPLE', firstTradeDate: '2005-03-01', instrumentType: 'ETF', ...over })
    const fundMoved = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: fundMeta({ firstTradeDate: '2019-06-01' }) })
    const fundDayOff = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: fundMeta({ firstTradeDate: '2005-03-15' }) })
    const fundOtherName = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: fundMeta({ longName: 'Rocket Cannabis Leveraged ETF', shortName: 'ROCKET CANNABIS' }) })
    const fundNewName = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: fundMeta({ longName: 'iShares Example Fund' }) })
    const secLost = checkIdentity('ACME', 'ACME', registered({}), { cik: null, secName: null, meta: meta({}) })
    const unknown = checkIdentity('ZZZZ', 'ZZZZ', undefined, { cik: 1, secName: 'x', meta: null })
    const blind = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: null })
    const summary = summarizeIdentityChecks([recycled, renamed, matched, fundMoved, fundDayOff, fundOtherName, fundNewName, secLost, unknown, blind])
    const words = nameOverlap('The Bank of New York Mellon Corporation', 'Bank of New York Mellon Corp') === 1 && nameOverlap('Paramount Global', 'Banzai International, Inc.') === 0 &&
      nameOverlap('JBT Marel Corporation', 'John Bean Technologies') < 0.5 && sameName('Acme, Inc.', 'ACME INC') && !sameName('Acme', 'Acme Holdings') &&
      // The SEC's and Yahoo's spellings of the same names, from the committed ledger.
      nameOverlap('AMAZON COM INC', 'Amazon.com, Inc.') === 1 && nameOverlap('FNB CORP/PA/', 'F.N.B. Corporation') === 1 && nameOverlap('MOODYS CORP /DE/', "Moody's Corporation") === 1 &&
      nameOverlap('V F CORP', 'V.F. Corporation') === 1 && nameOverlap('LOWES COMPANIES INC', "Lowe's Companies, Inc.") === 1 && nameOverlap('GENERAL ELECTRIC CO', 'GE Aerospace') === 0 &&
      sameName('AMAZON COM INC', 'Amazon.com, Inc.') && sameName('FNB CORP/PA/', 'F.N.B. Corporation') === false
    const passed =
      recycled.status === 'recycled' && (recycled.line ?? '').startsWith('RECYCLED: ACME is now Impostor Software, Inc. (SEC CIK 222); the run is registered against ACME CORP (SEC CIK 111)') &&
      renamed.status === 'renamed-in-place' && (renamed.line ?? '').startsWith('IDENTITY NOTE: ACME now Acme Holdings Corporation') && /same SEC CIK 111/.test(renamed.line ?? '') &&
      matched.status === 'matched' && matched.line === null &&
      fundMoved.status === 'recycled' && /first-trade date moved from 2005-03-01 to 2019-06-01/.test(fundMoved.line ?? '') &&
      fundDayOff.status === 'matched' && fundDayOff.line === null &&
      fundOtherName.status === 'recycled' && /shares 25% of its words/.test(fundOtherName.line ?? '') &&
      fundNewName.status === 'renamed-in-place' && (fundNewName.line ?? '').startsWith('IDENTITY NOTE: FUND now iShares Example Fund') &&
      secLost.status === 'matched' && /no longer lists ACME; it was CIK 111 at the snapshot/.test(secLost.line ?? '') &&
      unknown.status === 'unregistered' && blind.status === 'unverified' &&
      summary.checked === 10 && summary.matched === 3 && summary.renamedInPlace === 2 && summary.recycled === 3 && summary.unverified === 1 && summary.unregistered === 1 &&
      summary.line === 'identity: 10 checked, 3 matched, 2 renamed-in-place, 3 recycled, 1 unverified, 1 not in the ledger' &&
      summarizeIdentityChecks([matched, renamed]).line === 'identity: 2 checked, 1 matched, 1 renamed-in-place, 0 recycled' &&
      words && IDENTITY_NAME_OVERLAP_THRESHOLD === 0.5 && IDENTITY_FIRST_TRADE_TOLERANCE_DAYS === 30
    results.push({ name: 'identity rules: a different CIK is RECYCLED, the same CIK with a new name is an IDENTITY NOTE, and without CIKs a moved first-trade date or a foreign name is RECYCLED; the summary line has the promised form', passed, detail: passed ? undefined : JSON.stringify({ recycled, renamed, matched, fundMoved, fundDayOff, fundOtherName, fundNewName, secLost, unknown, blind, summary, words }) })
  }

  // The holes the adversarial review found. (1) The SEC map lagging a
  // symbol reassignment: the same CIK on both sides while the chart already
  // belongs to the new holder. The first-trade date gives it away, so it is
  // RECYCLED, while the same CIK with a new name and the same date is still
  // the rename note, and that note names the Yahoo name that changed. (2) A
  // chart answering under another symbol is a redirect: unverified, never a
  // match; Yahoo's own spelling of a class share (BRK-B for BRK.B) is not a
  // redirect. (3) In the no-CIK path a name on one side only cannot be
  // matched on the date alone: unverified, with the missing side named.
  {
    const registered = (over: Partial<RegisteredIdentity>): RegisteredIdentity => ({ ticker: 'ACME', fetchSymbol: 'ACME', etf: false, cik: 111, secName: 'ACME CORP', yahooLongName: 'Acme Corporation', yahooShortName: 'Acme Corp', yahooFirstTradeDate: '1990-01-02', snapshotDate: '2026-09-16', ...over })
    const meta = (over: Partial<YahooChartMeta>): YahooChartMeta => ({ symbol: 'ACME', longName: 'Acme Corporation', shortName: 'Acme Corp', firstTradeDate: '1990-01-02', exchange: 'NYSE', instrumentType: 'EQUITY', ...over })
    // Barnes-style: the SEC map still says CIK 111, the chart is Barrick's from 1985.
    const secLag = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ longName: 'Barrick Mining Corporation', shortName: 'Barrick Mining', firstTradeDate: '1985-02-13' }) })
    // Banzai-style: same map lag, the chart starts in 2021.
    const secLagNewer = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ longName: 'Banzai International, Inc.', firstTradeDate: '2021-02-12' }) })
    const dayOff = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ firstTradeDate: '1990-01-20' }) })
    const renamedSameDate = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ longName: 'Acme Holdings Corporation' }) })
    const redirect = checkIdentity('ACME', 'ACME', registered({}), { cik: 111, secName: 'ACME CORP', meta: meta({ symbol: 'OTHER' }) })
    const classShare = checkIdentity('BRK.B', 'BRK.B', registered({ ticker: 'BRK.B', fetchSymbol: 'BRK.B' }), { cik: 111, secName: 'ACME CORP', meta: meta({ symbol: 'BRK-B' }) })
    const fund = registered({ ticker: 'FUND', fetchSymbol: 'FUND', etf: true, cik: null, secName: null, yahooLongName: 'iShares Example Fund ETF', yahooShortName: 'ISHARES EXAMPLE', yahooFirstTradeDate: '2005-03-01' })
    const fundMeta = (over: Partial<YahooChartMeta>) => meta({ symbol: 'FUND', longName: 'iShares Example Fund ETF', shortName: 'ISHARES EXAMPLE', firstTradeDate: '2005-03-01', instrumentType: 'ETF', ...over })
    const nameless = checkIdentity('FUND', 'FUND', fund, { cik: null, secName: null, meta: fundMeta({ longName: null, shortName: null }) })
    const recordNameless = checkIdentity('FUND', 'FUND', { ...fund, yahooLongName: null, yahooShortName: null }, { cik: null, secName: null, meta: fundMeta({}) })
    const passed =
      secLag.status === 'recycled' && /same SEC CIK 111 but the chart is a different listing: its first-trade date moved from 1990-01-02 to 1985-02-13/.test(secLag.line ?? '') &&
      secLagNewer.status === 'recycled' && /moved from 1990-01-02 to 2021-02-12/.test(secLagNewer.line ?? '') &&
      dayOff.status === 'matched' && dayOff.line === null &&
      renamedSameDate.status === 'renamed-in-place' && (renamedSameDate.line ?? '').startsWith('IDENTITY NOTE: ACME now Acme Holdings Corporation (was Acme Corporation; same SEC CIK 111') &&
      redirect.status === 'unverified' && /asked for ACME but the chart answered as OTHER/.test(redirect.line ?? '') &&
      classShare.status === 'matched' && classShare.line === null &&
      nameless.status === 'unverified' && /the chart sent no name/.test(nameless.line ?? '') &&
      recordNameless.status === 'unverified' && /the record holds no name/.test(recordNameless.line ?? '') &&
      summarizeIdentityChecks([secLag, secLagNewer, dayOff, renamedSameDate, redirect, classShare, nameless, recordNameless]).line === 'identity: 8 checked, 2 matched, 1 renamed-in-place, 2 recycled, 3 unverified'
    results.push({ name: 'identity rules: the same CIK with a moved first-trade date is RECYCLED (SEC map lag), a redirected chart or a one-sided name is unverified, and the rename note names the Yahoo name that changed', passed, detail: passed ? undefined : JSON.stringify({ secLag, secLagNewer, dayOff, renamedSameDate, redirect, classShare, nameless, recordNameless }) })
  }

  // PARA and B, fed through un-ledgered: the identity the run would have
  // been registered against (Paramount Global, CIK 813828; Barnes Group,
  // CIK 9984) against what Yahoo and the SEC answered on 2026-09-16
  // (Banzai International, CIK 1826011, chart from 2021-02-12; Barrick
  // Mining, CIK 756894, first trade 1985-02-13). Both stub rules let both
  // charts through; the CIK rule catches both.
  {
    const paramount: RegisteredIdentity = { ticker: 'PARA', fetchSymbol: 'PARA', etf: false, cik: 813828, secName: 'Paramount Global', yahooLongName: 'Paramount Global', yahooShortName: 'Paramount Global', yahooFirstTradeDate: '2005-12-05', snapshotDate: '2025-06-30' }
    const barnes: RegisteredIdentity = { ticker: 'B', fetchSymbol: 'B', etf: false, cik: 9984, secName: 'BARNES GROUP INC', yahooLongName: 'Barnes Group Inc.', yahooShortName: 'Barnes Group, Inc.', yahooFirstTradeDate: '1980-03-17', snapshotDate: '2024-12-31' }
    const secMap = parseSecTickerMap({
      '0': { cik_str: 1826011, ticker: 'PARA', title: 'Banzai International, Inc.' },
      '1': { cik_str: 756894, ticker: 'B', title: 'BARRICK MINING CORP' },
      '2': { cik_str: 2041610, ticker: 'PSKY', title: 'Paramount Skydance Corp' },
    })
    const banzai = parseYahooChartMeta({ chart: { result: [{ meta: { symbol: 'PARA', longName: 'Banzai International, Inc.', shortName: 'Banzai International, Inc.', fullExchangeName: 'NasdaqCM', instrumentType: 'EQUITY', firstTradeDate: 1613140200 } }] } }, 'PARA')
    const barrick = parseYahooChartMeta({ chart: { result: [{ meta: { symbol: 'B', longName: 'Barrick Mining Corporation', shortName: 'Barrick Mining Corporation', fullExchangeName: 'NYSE', instrumentType: 'EQUITY', firstTradeDate: 477153000 } }] } }, 'B')
    const para = checkIdentity('PARA', 'PARA', paramount, { cik: secMap.get('PARA')?.cik ?? null, secName: secMap.get('PARA')?.name ?? null, meta: banzai })
    const b = checkIdentity('B', 'B', barnes, { cik: secMap.get('B')?.cik ?? null, secName: secMap.get('B')?.name ?? null, meta: barrick })
    const bars = (from: string, count: number) => Array.from({ length: count }, (_, i) => ({ date: new Date(new Date(`${from}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10) }))
    const paraStub = classifyStubSeries('PARA', bars('2021-02-12', 1404), { registered: true, maxRange: true })
    const bStub = classifyStubSeries('B', bars('1986-09-17', 10076), { registered: true, maxRange: true })
    const passed =
      para.status === 'recycled' && /CIK 1826011/.test(para.line ?? '') && /Banzai International/.test(para.line ?? '') && /CIK 813828/.test(para.line ?? '') && /Paramount Global/.test(para.line ?? '') &&
      b.status === 'recycled' && /CIK 756894/.test(b.line ?? '') && /Barrick Mining/.test(b.line ?? '') && /CIK 9984/.test(b.line ?? '') && /BARNES GROUP/.test(b.line ?? '') &&
      paraStub == null && bStub == null &&
      banzai?.firstTradeDate === '2021-02-12' && banzai.exchange === 'NasdaqCM' && barrick?.firstTradeDate === '1985-02-13' &&
      parseYahooChartMeta({ chart: { result: [] } }, 'X') == null && parseYahooChartMeta(null, 'X') == null &&
      summarizeIdentityChecks([para, b]).line === 'identity: 2 checked, 0 matched, 0 renamed-in-place, 2 recycled'
    results.push({ name: 'PARA and B fed through un-ledgered pass both stub rules and are caught by the CIK rule as RECYCLED (Banzai for Paramount, Barrick for Barnes)', passed, detail: passed ? undefined : JSON.stringify({ para, b, paraStub, bStub, banzai, barrick }) })
  }

  // Building the ledger from synthetic answers: the fetch plan decides what
  // is looked up (the successor for a renamed name; nothing for an excluded
  // name), funds get the Yahoo names only, a name the SEC map does not list
  // gets cik null, class shares find their SEC row through the dash form,
  // an SEC name and a Yahoo name that share no words are returned for a
  // human, entries come out sorted, and two builds give the same bytes.
  {
    const secMap = parseSecTickerMap({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 1512673, ticker: 'XYZ', title: 'Block, Inc.' },
      '2': { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
      '3': { cik_str: 999, ticker: 'ZZZZBOGUS', title: 'Widget Holdings Corp' },
      '4': { cik_str: 'bad', ticker: 'NOPE', title: 'x' },
    })
    const metas: Record<string, YahooChartMeta> = {
      AAPL: { symbol: 'AAPL', longName: 'Apple Inc.', shortName: 'Apple Inc.', firstTradeDate: '1980-12-12', exchange: 'NasdaqGS', instrumentType: 'EQUITY' },
      XYZ: { symbol: 'XYZ', longName: 'Block, Inc.', shortName: 'Block, Inc.', firstTradeDate: '2015-11-19', exchange: 'NYSE', instrumentType: 'EQUITY' },
      SPY: { symbol: 'SPY', longName: 'SPDR S&P 500 ETF Trust', shortName: 'SPDR S&P 500', firstTradeDate: '1993-01-29', exchange: 'NYSEArca', instrumentType: 'ETF' },
      'BRK.B': { symbol: 'BRK-B', longName: 'Berkshire Hathaway Inc.', shortName: 'Berkshire Hathaway Inc. New', firstTradeDate: '1996-05-09', exchange: 'NYSE', instrumentType: 'EQUITY' },
      TM: { symbol: 'TM', longName: 'Toyota Motor Corporation', shortName: 'Toyota Motor Corporation', firstTradeDate: '1999-09-29', exchange: 'NYSE', instrumentType: 'EQUITY' },
      ZZZZBOGUS: { symbol: 'ZZZZBOGUS', longName: 'Gizmo Systems Inc', shortName: 'Gizmo Systems', firstTradeDate: '2010-01-04', exchange: 'NYSE', instrumentType: 'EQUITY' },
    }
    const build = async (requested: string[]) =>
      buildRegisteredIdentityLedger({
        tickers: ['SQ', 'AAPL', 'PXD', 'SPY', 'BRK.B', 'TM', 'ZZZZBOGUS'],
        etfSymbols: new Set(['SPY']),
        secMap,
        snapshotDate: '2026-09-16',
        fetchMeta: async (symbol) => {
          requested.push(symbol)
          return metas[symbol] ?? null
        },
      })
    const requested: string[] = []
    const built = await build(requested)
    const again = await build([])
    const entry = (ticker: string) => built.ledger.entries.find((item) => item.ticker === ticker)
    const sq = entry('SQ')
    const spy = entry('SPY')
    const tm = entry('TM')
    const brk = entry('BRK.B')
    const bytes = serializeRegisteredIdentityLedger(built.ledger)
    const passed =
      secMap.size === 4 && secMap.get('BRK-B')?.cik === 1067983 && !secMap.has('NOPE') &&
      built.ledger.entries.map((item) => item.ticker).join(',') === 'AAPL,BRK.B,SPY,SQ,TM,ZZZZBOGUS' &&
      requested.join(',') === 'XYZ,AAPL,SPY,BRK.B,TM,ZZZZBOGUS' &&
      sq?.fetchSymbol === 'XYZ' && sq.cik === 1512673 && sq.secName === 'Block, Inc.' && sq.yahooLongName === 'Block, Inc.' && sq.yahooFirstTradeDate === '2015-11-19' && sq.etf === false && sq.snapshotDate === '2026-09-16' &&
      spy?.etf === true && spy.cik === null && spy.secName === null && spy.yahooLongName === 'SPDR S&P 500 ETF Trust' && spy.yahooShortName === 'SPDR S&P 500' &&
      tm?.cik === null && tm.secName === null && tm.yahooLongName === 'Toyota Motor Corporation' && tm.etf === false &&
      brk?.cik === 1067983 && brk.secName === 'BERKSHIRE HATHAWAY INC' &&
      built.ledger.counts.entries === 6 && built.ledger.counts.withCik === 4 && built.ledger.counts.withoutCik === 2 && built.ledger.counts.etfs === 1 &&
      built.ledger.snapshotDate === '2026-09-16' && built.ledger._comment.length > 0 && /identity ledger/.test(built.ledger._comment[0]) &&
      built.disagreements.length === 1 && built.disagreements[0].ticker === 'ZZZZBOGUS' && built.disagreements[0].overlap === 0 &&
      built.metaMissing.length === 0 &&
      bytes === serializeRegisteredIdentityLedger(again.ledger) && bytes.endsWith('\n') && (JSON.parse(bytes) as { entries: RegisteredIdentity[] }).entries[0].ticker === 'AAPL'
    results.push({ name: 'identity ledger build: successor symbols looked up, excluded names left out, funds and foreign filers with cik null, class shares matched through the dash form, SEC/Yahoo name disagreements flagged, sorted and byte-stable', passed, detail: passed ? undefined : JSON.stringify({ tickers: built.ledger.entries.map((item) => item.ticker), requested, sq, spy, tm, brk, counts: built.ledger.counts, disagreements: built.disagreements, metaMissing: built.metaMissing }) })
  }

  // The committed ledger itself: one entry for every registered name the
  // exclusion ledger keeps (funds included), none for an excluded name (so
  // neither PARA nor B), sorted, with the fetch symbol the rename ledger
  // gives, funds without a CIK, a CIK on well over nine hundred companies,
  // and bytes that re-serialize to exactly the file on disk.
  {
    const path = registeredIdentityPath()
    let ledger: ReturnType<typeof readRegisteredIdentityLedger> | null = null
    let error = ''
    try {
      ledger = readRegisteredIdentityLedger(path)
    } catch (caught) {
      error = (caught as Error).message
    }
    if (ledger == null) {
      results.push({ name: 'the committed identity ledger reads', passed: false, detail: error })
    } else {
      const byTicker = identityByTicker(ledger)
      const excluded = new Set(EXCLUDED_UNFETCHABLE.map((item) => item.ticker))
      const expected = DEFAULT_BACKTEST_TICKERS.filter((ticker) => !excluded.has(ticker))
      const missing = expected.filter((ticker) => !byTicker.has(ticker))
      const registeredSet = new Set(DEFAULT_BACKTEST_TICKERS)
      const extra = ledger.entries.filter((item) => !registeredSet.has(item.ticker) || excluded.has(item.ticker)).map((item) => item.ticker)
      const sorted = ledger.entries.every((item, i) => i === 0 || ledger!.entries[i - 1].ticker < item.ticker)
      const wrongFetchSymbol = ledger.entries.filter((item) => item.fetchSymbol !== (TICKER_RENAMES[item.ticker]?.successor ?? item.ticker)).map((item) => item.ticker)
      const etfSet = new Set(etfBlocksInDefaultTickers())
      const wrongEtf = ledger.entries.filter((item) => item.etf !== etfSet.has(item.ticker) || (item.etf && (item.cik !== null || item.secName !== null))).map((item) => item.ticker)
      const companiesWithCik = ledger.entries.filter((item) => !item.etf && item.cik != null).length
      const countsRight =
        ledger.counts.entries === ledger.entries.length &&
        ledger.counts.withCik === ledger.entries.filter((item) => item.cik != null).length &&
        ledger.counts.withoutCik === ledger.entries.length - ledger.counts.withCik &&
        ledger.counts.etfs === ledger.entries.filter((item) => item.etf).length
      const stable = serializeRegisteredIdentityLedger(ledger) === readFileSync(path, 'utf8')
      // The hash the run records is the hash of these exact bytes.
      const sha = hashRegisteredIdentityLedger(path)
      const hashed = /^[0-9a-f]{64}$/.test(sha) && sha === createHash('sha256').update(readFileSync(path)).digest('hex')
      const passed =
        missing.length === 0 && extra.length === 0 && ledger.entries.length === expected.length && sorted && wrongFetchSymbol.length === 0 && wrongEtf.length === 0 &&
        countsRight && stable && hashed && ledger.snapshotDate === REGISTERED_IDENTITY_SNAPSHOT_DATE && ledger.entries.every((item) => item.snapshotDate === ledger!.snapshotDate) &&
        !byTicker.has('PARA') && !byTicker.has('B') && companiesWithCik > 900 &&
        byTicker.get('AAPL')?.cik === 320193 && byTicker.get('SQ')?.fetchSymbol === 'XYZ' && byTicker.get('SQ')?.cik === 1512673 && byTicker.get('SPY')?.etf === true && byTicker.get('SPY')?.cik === null
      results.push({
        name: `the committed identity ledger covers every fetchable registered name (${ledger.entries.length}), none excluded, sorted, byte-stable, funds without a CIK, ${companiesWithCik} companies with one`,
        passed,
        detail: passed ? undefined : JSON.stringify({ missing: missing.slice(0, 20), extra: extra.slice(0, 20), sorted, wrongFetchSymbol: wrongFetchSymbol.slice(0, 20), wrongEtf: wrongEtf.slice(0, 20), countsRight, stable, snapshot: ledger.snapshotDate, companiesWithCik, entries: ledger.entries.length, expected: expected.length }),
      })
    }
  }

  // The meta fetch asks for byte for byte the URL the bar fetch asked for,
  // so the proxy answers it from the copy it just cached: fetchDailyBars
  // (marketData.ts) is run against a stand-in fetch and its URL compared
  // with yahooChartUrl for the same symbol and moment.
  {
    const seen: string[] = []
    const realFetch = globalThis.fetch
    const now = Date.now()
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      await fetchDailyBars('BRK.B', 'max')
    } finally {
      globalThis.fetch = realFetch
    }
    const expected = `http://127.0.0.1:8787/proxy?url=${encodeURIComponent(yahooChartUrl('BRK.B', now))}`
    const passed = seen.length === 1 && seen[0] === expected && /chart%2FBRK-B%3Fperiod1/.test(expected)
    results.push({ name: 'the identity meta fetch reuses the exact chart URL the bar warm-up fetched, so the proxy serves it from cache', passed, detail: passed ? undefined : JSON.stringify({ seen, expected }) })
  }

  // The warm-up's onUsable hook runs, and is awaited, for usable names only:
  // not for a stub and not for a name that never answered.
  {
    const order: string[] = []
    const warm = await warmDailyBars(
      ['AAA', 'EA', 'ZZZZBOGUS', 'BBB'],
      async (ticker) => (ticker === 'AAA' || ticker === 'BBB' ? [{ date: '1990-01-02' }] : ticker === 'EA' ? [{ date: '2026-08-04' }] : []),
      {
        attempts: 2,
        pauseMs: 0,
        stubCheck: (ticker, bars) => classifyStubSeries(ticker, bars, { registered: true, maxRange: false }),
        onUsable: async (ticker) => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          order.push(`usable:${ticker}`)
        },
        onProgress: (_done, _total, ticker) => order.push(`done:${ticker}`),
      },
    )
    const passed = order.join(',') === 'usable:AAA,done:AAA,done:EA,done:ZZZZBOGUS,usable:BBB,done:BBB' && warm.usable.join(',') === 'AAA,BBB' && warm.stubs.length === 1 && warm.failed.join(',') === 'ZZZZBOGUS'
    results.push({ name: 'warm-up onUsable hook is awaited for usable names only, before the next name is fetched', passed, detail: passed ? undefined : JSON.stringify({ order, warm }) })
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
    // The universe record: written into run.json before the checkpoint is
    // opened (no fingerprint yet), kept when openCheckpoint adds the
    // fingerprint, rewritten after the warm-up with the stubs, and read
    // back with the rename map, the excluded names (dates and reasons),
    // the stub list and the attrition sentence intact.
    {
      const dir = join(scratch, 'universe')
      const plan = planUniverseFetch(['AAPL', 'PXD', 'SQ', 'EA'])
      const record = {
        recordedAt: '2026-09-16T20:00:00.000Z',
        registered: [...plan.registered],
        renames: plan.renamed.map((entry) => ({ ...entry })),
        excluded: plan.excluded.map(({ ticker, delistingDate, reason, evidence }) => ({ ticker, delistingDate, reason, evidence })),
        stubs: [],
        attrition: { ...plan.attrition },
      }
      recordUniverseInCheckpoint(dir, record)
      const beforeOpen = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>
      const fingerprintBeforeOpen = readStoredFingerprint(dir)
      const opened = openCheckpoint(dir, fingerprint)
      releaseCheckpoint(opened)
      const afterOpen = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Record<string, unknown>
      const stub = classifyStubSeries('EA', [{ date: '2026-08-04' }], { registered: true, maxRange: true })!
      recordUniverseInCheckpoint(dir, { ...record, stubs: [stub] })
      const afterWarm = readCheckpointUniverse(dir)
      const stillOpens = openCheckpoint(dir, fingerprint)
      releaseCheckpoint(stillOpens)
      const passed =
        beforeOpen.fingerprint === undefined &&
        fingerprintBeforeOpen === null &&
        typeof beforeOpen.createdAt === 'string' &&
        afterOpen.fingerprint != null &&
        (afterOpen.universe as typeof record).renames.map((entry) => `${entry.original}>${entry.fetchedAs}`).join(',') === 'SQ>XYZ' &&
        (afterOpen.universe as typeof record).excluded.map((entry) => `${entry.ticker}:${entry.delistingDate}:${entry.reason}`).join(';') ===
          'PXD:2024-05-03:acquired by Exxon Mobil;EA:2026-08-04:taken private by a consortium of the Public Investment Fund, Silver Lake and Affinity Partners' &&
        afterOpen.createdAt === beforeOpen.createdAt &&
        afterWarm?.stubs.length === 1 &&
        afterWarm.stubs[0].ticker === 'EA' &&
        afterWarm.stubs[0].line.startsWith('STUB: EA first bar 2026-08-04, 1 bar') &&
        afterWarm.attrition.statement === plan.attrition.statement &&
        /2 of 4 registered names \(50\.0%\) left the market/.test(afterWarm.attrition.statement) &&
        afterWarm.registered.join(',') === 'AAPL,PXD,SQ,EA' &&
        readStoredFingerprint(dir) != null &&
        stillOpens.completed.size === 0
      results.push({
        name: 'run.json carries the universe record (renames, excluded names with dates and reasons, stubs, attrition) from run start, and keeps it when the fingerprint is added',
        passed,
        detail: passed ? undefined : JSON.stringify({ beforeOpen: Object.keys(beforeOpen), afterOpen: Object.keys(afterOpen), afterWarm }),
      })
    }

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
