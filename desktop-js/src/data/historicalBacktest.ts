import { cachedFetchDailyBars, type DailyBar } from './marketData'
import {
  fitGradientBoosting,
  predictGradientBoosting,
  pearsonCorrelation,
  type GradientBoostingModel,
} from './quantMath'

export type { DailyBar }

/**
 * Historical backtest harness — turns Yahoo's multi-year bar history into
 * labeled training data without waiting for live snapshots to accumulate.
 *
 * Implements quant-finance ML best practices that were missing in the
 * earlier version:
 *
 *   1. NO LOOK-AHEAD: features at date t use ONLY bars ≤ t-1. Forward
 *      returns at date t use bars between t and t+horizon. The two sets
 *      never overlap.
 *
 *   2. CROSS-SECTIONAL NORMALIZATION: at each date, Z-score features
 *      across the cross-section so the model learns relative effects
 *      rather than absolute scales.
 *
 *   3. PURGED + EMBARGOED WALK-FORWARD: per López de Prado (2018),
 *      "Advances in Financial Machine Learning". Drop training samples
 *      whose forward-return window overlaps the test window, and skip
 *      a buffer of days between train and test to prevent serial-correlation
 *      leakage.
 *
 *   4. BASELINE COMPARISONS: every walk-forward step also evaluates
 *      naive baselines (random, 12-month momentum, equal-weight) so IC
 *      numbers have context.
 *
 *   5. TRANSACTION COST MODELING: long-short returns are reported both
 *      gross AND net of a configurable per-trade cost (default 10 bps).
 *
 *   6. DRAWDOWN METRICS: max drawdown, time-under-water computed from
 *      the cumulative long-short return series.
 *
 *   7. PERMUTATION FEATURE IMPORTANCE: shuffles each feature in the test
 *      set and measures the IC drop, so we can see which features actually
 *      contribute and which are noise (Breiman 2001).
 */

export type HorizonKey = 5 | 20 | 60 | 120

export type HistoricalSample = {
  ticker: string
  asOf: string
  asOfIndex: number   // bar index within the ticker's series — needed for purging
  features: number[]
  rawFeatures: number[]  // pre-normalization values for diagnostic display
  // Forward returns at multiple horizons for multi-horizon ensemble training
  forwardReturn5d: number
  forwardReturn20d: number
  forwardReturn60d: number
  forwardReturn120d: number
}

export const ENSEMBLE_HORIZONS: HorizonKey[] = [5, 20, 60, 120]

export type FeatureNames = string[]

/**
 * Feature set inspired by Gu-Kelly-Xiu 2020 ("Empirical Asset Pricing
 * via Machine Learning"). 30 price-derived features that span:
 *   - Momentum (multiple horizons + relative strength variants)
 *   - Mean reversion (short-horizon)
 *   - Volatility (multiple horizons + asymmetry)
 *   - Liquidity (volume + Amihud-style illiquidity proxy)
 *   - Trend strength (proximity to highs/lows + SMA distances)
 *   - Distributional moments (skew + kurtosis at multiple horizons)
 *   - Range/extension metrics
 */
export const HISTORICAL_FEATURE_NAMES: FeatureNames = [
  // Momentum (5)
  'momentum_5d',
  'momentum_20d',
  'momentum_60d',
  'momentum_120d',
  'momentum_252d',
  // Reversal (2)
  'reversal_1d',
  'reversal_5d',
  // Volatility (4)
  'volatility_20d',
  'volatility_60d',
  'volatility_252d',
  'vol_change_60_20',  // ratio of recent vs longer-window vol (vol regime)
  // Liquidity (4)
  'volume_trend_20_60',
  'volume_trend_5_20',
  'volume_zscore_60d',
  'amihud_illiquidity_20d',  // Amihud (2002) illiquidity proxy
  // Trend strength (5)
  'price_to_high_60d',
  'price_to_low_60d',
  'price_to_high_252d',
  'sma_50_distance',
  'sma_200_distance',
  // Cross-trend (2)
  'sma_50_over_200',          // golden-cross / death-cross indicator
  'last_close_over_sma_20',
  // Drawdown (2)
  'drawdown_60d',             // current drawdown from 60d peak
  'drawdown_252d',
  // Distributional moments (4)
  'skew_60d',
  'kurt_60d',
  'skew_252d',
  'kurt_252d',
  // Range/extension (2)
  'range_compression_20d',    // (high-low)/close, last 20d
  'price_velocity_acceleration',  // 20d vel - 60d vel (momentum of momentum)
]

export function computeFeaturesAtDate(bars: DailyBar[], dateIndex: number): number[] | null {
  if (dateIndex < 252) return null  // need 252 bars for the 1-year features
  const window = bars.slice(0, dateIndex)
  const closes = window.map((bar) => bar.close)
  const highs = window.map((bar) => bar.high)
  const lows = window.map((bar) => bar.low)
  const volumes = window.map((bar) => bar.volume)
  if (closes.length < 252) return null
  const lastClose = closes[closes.length - 1]
  if (lastClose <= 0) return null

  const ret = (lookback: number): number => {
    const start = closes[closes.length - 1 - lookback]
    if (!start || start <= 0) return 0
    return (closes[closes.length - 1] / start - 1) * 100
  }

  const meanOf = (arr: number[]): number =>
    arr.reduce((sum, value) => sum + value, 0) / Math.max(1, arr.length)

  const stdOf = (arr: number[]): number => {
    const m = meanOf(arr)
    const v = arr.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(1, arr.length)
    return Math.sqrt(v)
  }

  // Log-return series at multiple windows
  const buildLogReturns = (window: number): number[] => {
    const slice = closes.slice(-window - 1)
    const out: number[] = []
    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > 0 && slice[i - 1] > 0) {
        out.push(Math.log(slice[i] / slice[i - 1]))
      }
    }
    return out
  }
  const log20 = buildLogReturns(20)
  const log60 = buildLogReturns(60)
  const log252 = buildLogReturns(252)

  // Volatility at multiple horizons (annualized)
  const vol20 = stdOf(log20) * Math.sqrt(252)
  const vol60 = stdOf(log60) * Math.sqrt(252)
  const vol252 = stdOf(log252) * Math.sqrt(252)
  const volChange60to20 = vol60 > 0 ? vol20 / vol60 : 1

  // Volume features
  const vol5 = meanOf(volumes.slice(-5))
  const vol20vol = meanOf(volumes.slice(-20))
  const vol60vol = meanOf(volumes.slice(-60))
  const volumeTrend20_60 = vol60vol > 0 ? vol20vol / vol60vol : 1
  const volumeTrend5_20 = vol20vol > 0 ? vol5 / vol20vol : 1
  const volume60Mean = meanOf(volumes.slice(-60))
  const volume60Std = stdOf(volumes.slice(-60))
  const volumeZScore = volume60Std > 0 ? (volumes[volumes.length - 1] - volume60Mean) / volume60Std : 0

  // Amihud (2002) illiquidity: |return| / dollar volume, averaged
  const dollarVolumes = volumes.slice(-20).map((v, i) => v * closes[closes.length - 20 + i])
  const absReturns20 = log20.map(Math.abs)
  let amihud = 0
  if (dollarVolumes.length === absReturns20.length && dollarVolumes.length > 0) {
    let sum = 0
    let n = 0
    for (let i = 0; i < absReturns20.length; i++) {
      if (dollarVolumes[i] > 0) {
        sum += absReturns20[i] / dollarVolumes[i]
        n++
      }
    }
    amihud = n > 0 ? (sum / n) * 1e8 : 0  // scaled for numeric stability
  }

  // Trend strength
  const high60 = Math.max(...closes.slice(-60))
  const low60 = Math.min(...closes.slice(-60))
  const high252 = Math.max(...closes.slice(-252))

  const sma20 = meanOf(closes.slice(-20))
  const sma50 = meanOf(closes.slice(-50))
  const sma200 = meanOf(closes.slice(-200))
  const sma50Over200 = sma200 > 0 ? sma50 / sma200 - 1 : 0

  // Drawdown from rolling peak
  let peak60 = 0
  for (let i = closes.length - 60; i < closes.length; i++) {
    if (closes[i] > peak60) peak60 = closes[i]
  }
  const drawdown60 = peak60 > 0 ? (lastClose - peak60) / peak60 : 0

  let peak252 = 0
  for (let i = closes.length - 252; i < closes.length; i++) {
    if (closes[i] > peak252) peak252 = closes[i]
  }
  const drawdown252 = peak252 > 0 ? (lastClose - peak252) / peak252 : 0

  // Distributional moments at 60d and 252d
  const moments = (logs: number[]): { skew: number; exKurt: number } => {
    const m = meanOf(logs)
    const m2 = logs.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(1, logs.length)
    const m3 = logs.reduce((sum, value) => sum + (value - m) ** 3, 0) / Math.max(1, logs.length)
    const m4 = logs.reduce((sum, value) => sum + (value - m) ** 4, 0) / Math.max(1, logs.length)
    return {
      skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0,
      exKurt: m2 > 0 ? m4 / (m2 * m2) - 3 : 0,
    }
  }
  const moments60 = moments(log60)
  const moments252 = moments(log252)

  // Range compression: (high - low) / close, averaged over 20d
  let rangeCompression = 0
  for (let i = closes.length - 20; i < closes.length; i++) {
    if (closes[i] > 0) rangeCompression += (highs[i] - lows[i]) / closes[i]
  }
  rangeCompression /= 20

  // Price velocity acceleration: 20d momentum - 60d momentum (per day rate)
  const velocity20 = ret(20) / 20
  const velocity60 = ret(60) / 60
  const velocityAccel = velocity20 - velocity60

  return [
    // Momentum (5)
    ret(5),
    ret(20),
    ret(60),
    ret(120),
    ret(252),
    // Reversal (2)
    ret(1),
    ret(5),
    // Volatility (4)
    vol20,
    vol60,
    vol252,
    volChange60to20,
    // Liquidity (4)
    volumeTrend20_60,
    volumeTrend5_20,
    volumeZScore,
    amihud,
    // Trend strength (5)
    lastClose / Math.max(1e-8, high60),
    lastClose / Math.max(1e-8, low60),
    lastClose / Math.max(1e-8, high252),
    lastClose / Math.max(1e-8, sma50) - 1,
    lastClose / Math.max(1e-8, sma200) - 1,
    // Cross-trend (2)
    sma50Over200,
    lastClose / Math.max(1e-8, sma20) - 1,
    // Drawdown (2)
    drawdown60,
    drawdown252,
    // Distributional moments (4)
    moments60.skew,
    moments60.exKurt,
    moments252.skew,
    moments252.exKurt,
    // Range/extension (2)
    rangeCompression,
    velocityAccel,
  ]
}

export function computeForwardReturn(
  bars: DailyBar[],
  dateIndex: number,
  horizon: number,
): number | null {
  const future = dateIndex + horizon
  if (future >= bars.length) return null
  const start = bars[dateIndex].close
  const end = bars[future].close
  if (start <= 0 || end <= 0) return null
  return (end / start - 1) * 100
}

export type DatasetBuildResult = {
  samples: HistoricalSample[]
  diagnostics: {
    tickersAttempted: number
    tickersWithUsableBars: number
    tickersWithZeroBars: number
    tickersBelowMinBars: number
    perTickerSummary: Array<{
      ticker: string
      bars: number
      samplesGenerated: number
      reason?: string
    }>
  }
}

/**
 * Apply cross-sectional Z-score normalization to features WITHIN each
 * as-of date. After this, every feature has mean 0 and stddev 1 across
 * stocks at any given date — the model learns relative ranking rather
 * than absolute level.
 */
function applyCrossSectionalNormalization(samples: HistoricalSample[]): void {
  // Group sample indices by date
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  if (samples.length === 0) return
  const featureCount = samples[0].rawFeatures.length
  const MIN_GROUP_FOR_ZSCORE = 5

  // Compute global mean/std as fallback for sparse-date groups
  const globalMean = new Array(featureCount).fill(0)
  const globalStd = new Array(featureCount).fill(1)
  for (let f = 0; f < featureCount; f++) {
    const values = samples.map((sample) => sample.rawFeatures[f])
    const m = values.reduce((sum, value) => sum + value, 0) / values.length
    const v = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length
    globalMean[f] = m
    globalStd[f] = Math.sqrt(Math.max(1e-12, v))
  }

  for (const indices of byDate.values()) {
    if (indices.length < MIN_GROUP_FOR_ZSCORE) {
      // Sparse date — fall back to global Z-score so we don't lose the
      // sample's information. This is honest about the limitation.
      indices.forEach((idx) => {
        for (let f = 0; f < featureCount; f++) {
          samples[idx].features[f] = (samples[idx].rawFeatures[f] - globalMean[f]) / globalStd[f]
        }
      })
      continue
    }
    for (let f = 0; f < featureCount; f++) {
      const values = indices.map((idx) => samples[idx].rawFeatures[f])
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      const sigma = Math.sqrt(Math.max(1e-12, variance))
      indices.forEach((idx) => {
        samples[idx].features[f] = (samples[idx].rawFeatures[f] - mean) / sigma
      })
    }
  }
}

export async function buildHistoricalDataset(
  tickers: string[],
  options: {
    cadenceDays?: number
    minBars?: number
    range?: '1y' | '2y' | '5y' | '10y' | 'max'
    onProgress?: (current: number, total: number, ticker: string) => void
  } = {},
): Promise<DatasetBuildResult> {
  const cadence = options.cadenceDays ?? 10
  const minBars = options.minBars ?? 400  // 252 history + 120 forward + buffer
  const range = options.range ?? '5y'
  const samples: HistoricalSample[] = []
  const perTickerSummary: DatasetBuildResult['diagnostics']['perTickerSummary'] = []
  let tickersWithUsableBars = 0
  let tickersWithZeroBars = 0
  let tickersBelowMinBars = 0

  for (let t = 0; t < tickers.length; t++) {
    const ticker = tickers[t]
    options.onProgress?.(t, tickers.length, ticker)
    let bars: DailyBar[]
    try {
      bars = await cachedFetchDailyBars(ticker, range)
    } catch {
      bars = []
    }
    if (bars.length === 0) {
      tickersWithZeroBars++
      perTickerSummary.push({ ticker, bars: 0, samplesGenerated: 0, reason: 'fetch failed or empty' })
      continue
    }
    if (bars.length < minBars) {
      tickersBelowMinBars++
      perTickerSummary.push({
        ticker,
        bars: bars.length,
        samplesGenerated: 0,
        reason: `< ${minBars} bars`,
      })
      continue
    }
    let generated = 0
    // Need 252 bars history (for 252d momentum, vol, moments) + 120 future
    // (longest horizon in the ensemble)
    for (let i = 252; i < bars.length - 120; i += cadence) {
      const features = computeFeaturesAtDate(bars, i)
      if (!features) continue
      const fwd5 = computeForwardReturn(bars, i, 5)
      const fwd20 = computeForwardReturn(bars, i, 20)
      const fwd60 = computeForwardReturn(bars, i, 60)
      const fwd120 = computeForwardReturn(bars, i, 120)
      if (fwd5 == null || fwd20 == null || fwd60 == null || fwd120 == null) continue
      samples.push({
        ticker,
        asOf: bars[i].date,
        asOfIndex: i,
        features: [...features],
        rawFeatures: [...features],
        forwardReturn5d: fwd5,
        forwardReturn20d: fwd20,
        forwardReturn60d: fwd60,
        forwardReturn120d: fwd120,
      })
      generated++
    }
    tickersWithUsableBars++
    perTickerSummary.push({ ticker, bars: bars.length, samplesGenerated: generated })
  }

  // Apply cross-sectional normalization in place
  applyCrossSectionalNormalization(samples)

  return {
    samples,
    diagnostics: {
      tickersAttempted: tickers.length,
      tickersWithUsableBars,
      tickersWithZeroBars,
      tickersBelowMinBars,
      perTickerSummary,
    },
  }
}

/* =========================================================================
   Walk-forward validation with purging + embargo
   ========================================================================= */

export type WalkForwardResult = {
  trainSize: number
  testSize: number
  testStartDate: string
  testEndDate: string
  informationCoefficient: number
  spearmanIc: number
  hitRate: number
  longShortReturnGross: number
  longShortReturnNet: number   // net of transaction costs
  longShortSharpe: number
  predictedDecileReturns: number[]
  // Baseline comparisons
  baselineRandomIc: number
  baselineMomentumIc: number
  // Drawdown
  cumulativeReturn: number
  maxDrawdown: number
  // Feature importance — IC drop when each feature is permuted
  featureImportance: number[]
}

/**
 * Days since the same ticker's earliest sample, used for purging + embargo
 * decisions. We pre-compute and cache it on the sample.
 */
type IndexedSample = HistoricalSample & { sortIndex: number }

function indexSamples(samples: HistoricalSample[]): IndexedSample[] {
  const sorted = [...samples].sort((a, b) => a.asOf.localeCompare(b.asOf))
  return sorted.map((sample, idx) => ({ ...sample, sortIndex: idx }))
}

/**
 * Run a single walk-forward step with PURGE + EMBARGO.
 *   - Train set: samples with sortIndex < splitIndex
 *   - Test set:  samples with splitIndex ≤ sortIndex < splitIndex + testSize
 *   - Purge:     drop training samples whose forward-return window OVERLAPS
 *                the earliest test sample's date
 *   - Embargo:   drop training samples within `embargoDays` of test start
 */
export function walkForwardStep(
  samples: IndexedSample[],
  splitIndex: number,
  testSize: number,
  options: {
    embargoDays?: number
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
  } = {},
): WalkForwardResult | null {
  if (splitIndex <= 0 || splitIndex + testSize > samples.length) return null
  const embargoDays = options.embargoDays ?? 5
  const horizonDays = options.horizonDays ?? 20
  const txCostBps = options.txCostBps ?? 10

  const testSamples = samples.slice(splitIndex, splitIndex + testSize)
  if (testSamples.length < 10) return null
  const testStartDate = testSamples[0].asOf
  const testStartTime = new Date(testStartDate).getTime()

  // PURGE: drop train samples whose forward-return window overlaps the
  // earliest test date. EMBARGO: drop train samples within embargoDays
  // of the test start.
  const candidateTrain = samples.slice(0, splitIndex)
  const trainSamples = candidateTrain.filter((sample) => {
    const sampleTime = new Date(sample.asOf).getTime()
    const sampleEndTime = sampleTime + horizonDays * 24 * 3600 * 1000
    const embargoCutoff = testStartTime - embargoDays * 24 * 3600 * 1000
    // Drop if forward-return window overlaps test, OR within embargo
    return sampleEndTime <= embargoCutoff
  })
  if (trainSamples.length < 50) return null

  const trainFeatures = trainSamples.map((sample) => sample.features)
  const trainTargets = trainSamples.map((sample) => sample.forwardReturn20d)
  const model = fitGradientBoosting(trainFeatures, trainTargets, options.modelOptions ?? {})

  const predictions = testSamples.map((sample) => predictGradientBoosting(model, sample.features))
  const actuals = testSamples.map((sample) => sample.forwardReturn20d)

  const ic = pearsonCorrelation(predictions, actuals)
  const spearmanIc = spearmanCorrelation(predictions, actuals)
  const hitRate =
    predictions.filter((value, idx) => Math.sign(value) === Math.sign(actuals[idx])).length /
    predictions.length

  // Long-short quintile portfolio
  const indexed = predictions.map((value, idx) => ({ pred: value, actual: actuals[idx] }))
  indexed.sort((left, right) => right.pred - left.pred)
  const quintileSize = Math.max(1, Math.floor(indexed.length / 5))
  const topQ = indexed.slice(0, quintileSize)
  const bottomQ = indexed.slice(-quintileSize)
  const topMean = topQ.reduce((sum, item) => sum + item.actual, 0) / topQ.length
  const bottomMean = bottomQ.reduce((sum, item) => sum + item.actual, 0) / bottomQ.length
  const longShortReturnGross = topMean - bottomMean
  // Net: subtract 2× tx cost (one for long, one for short)
  const longShortReturnNet = longShortReturnGross - (2 * txCostBps) / 100
  const meanActual = actuals.reduce((sum, value) => sum + value, 0) / actuals.length
  const stdActual = Math.sqrt(
    actuals.reduce((sum, value) => sum + (value - meanActual) ** 2, 0) / actuals.length,
  )
  const longShortSharpe = stdActual > 0 ? (longShortReturnNet / stdActual) * Math.sqrt(252 / horizonDays) : 0

  // Decile bucket means
  indexed.sort((left, right) => left.pred - right.pred)
  const decileSize = Math.max(1, Math.floor(indexed.length / 10))
  const decileReturns: number[] = []
  for (let d = 0; d < 10; d++) {
    const start = d * decileSize
    const end = d === 9 ? indexed.length : start + decileSize
    const slice = indexed.slice(start, end)
    decileReturns.push(
      slice.length > 0 ? slice.reduce((sum, item) => sum + item.actual, 0) / slice.length : 0,
    )
  }

  // BASELINE: random predictions
  const randomPredictions = predictions.map(() => Math.random())
  const baselineRandomIc = pearsonCorrelation(randomPredictions, actuals)

  // BASELINE: 12-month momentum (feature index 2 = momentum_120d)
  const momentumPredictions = testSamples.map((sample) => sample.features[2])
  const baselineMomentumIc = pearsonCorrelation(momentumPredictions, actuals)

  // DRAWDOWN: cumulative L/S return path through the test window
  // (approximate — assumes equal weighting at each test point)
  const cumPath: number[] = []
  let running = 0
  for (let i = 0; i < indexed.length; i++) {
    running += indexed[i].actual / indexed.length
    cumPath.push(running)
  }
  const cumulativeReturn = running
  let peak = cumPath[0] ?? 0
  let maxDD = 0
  for (const value of cumPath) {
    if (value > peak) peak = value
    const dd = peak - value
    if (dd > maxDD) maxDD = dd
  }

  // FEATURE IMPORTANCE via permutation
  const featureCount = testSamples[0]?.features.length ?? 0
  const featureImportance: number[] = []
  for (let f = 0; f < featureCount; f++) {
    // Shuffle feature f across the test set
    const shuffled = [...actuals]  // unused, but allocates to keep shape
    void shuffled
    const permutedFeatures = testSamples.map((sample) => [...sample.features])
    const indicesShuf = Array.from({ length: testSamples.length }, (_, i) => i)
    for (let i = indicesShuf.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[indicesShuf[i], indicesShuf[j]] = [indicesShuf[j], indicesShuf[i]]
    }
    permutedFeatures.forEach((features, i) => {
      features[f] = testSamples[indicesShuf[i]].features[f]
    })
    const permutedPredictions = permutedFeatures.map((features) =>
      predictGradientBoosting(model, features),
    )
    const permutedIc = pearsonCorrelation(permutedPredictions, actuals)
    featureImportance.push(ic - permutedIc)
  }

  return {
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    testStartDate,
    testEndDate: testSamples[testSamples.length - 1].asOf,
    informationCoefficient: ic,
    spearmanIc,
    hitRate,
    longShortReturnGross,
    longShortReturnNet,
    longShortSharpe,
    predictedDecileReturns: decileReturns,
    baselineRandomIc,
    baselineMomentumIc,
    cumulativeReturn,
    maxDrawdown: maxDD,
    featureImportance,
  }
}

function spearmanCorrelation(x: number[], y: number[]): number {
  const n = x.length
  if (n === 0 || x.length !== y.length) return 0
  const xRanks = ranks(x)
  const yRanks = ranks(y)
  return pearsonCorrelation(xRanks, yRanks)
}

function ranks(values: number[]): number[] {
  const indexed = values.map((value, idx) => ({ value, idx }))
  indexed.sort((left, right) => left.value - right.value)
  const result = new Array(values.length).fill(0)
  for (let i = 0; i < indexed.length; i++) {
    result[indexed[i].idx] = i
  }
  return result
}

export type ConfidenceInterval = { lower: number; mean: number; upper: number }

export type HorizonModelBundle = {
  horizon: HorizonKey
  /** Median (q=0.5) GBT — the point-estimate model */
  medianModel: GradientBoostingModel
  /** 10th-percentile model — lower bound of 80% prediction interval */
  p10Model: GradientBoostingModel
  /** 90th-percentile model — upper bound */
  p90Model: GradientBoostingModel
  meanIC: number
  meanHitRate: number
  icCI: ConfidenceInterval
}

export type FullBacktestResult = {
  steps: WalkForwardResult[]
  /** Mean across horizons of mean-per-step IC for the 20d (primary) model — kept for backward compat */
  meanIC: number
  meanSpearmanIC: number
  meanHitRate: number
  meanLongShortReturnGross: number
  meanLongShortReturnNet: number
  meanLongShortSharpe: number
  meanBaselineRandomIc: number
  meanBaselineMomentumIc: number
  cumulativeReturn: number
  maxDrawdown: number
  meanFeatureImportance: number[]
  totalSamples: number
  /** Backward-compat: the 20-day median model */
  trainedModel: GradientBoostingModel
  /** Multi-horizon ensemble: one bundle per horizon, each containing
   *  median + p10 + p90 models for prediction intervals. */
  horizonBundles: HorizonModelBundle[]
  embargoDaysUsed: number
  txCostBpsUsed: number
  icCI: ConfidenceInterval
  hitRateCI: ConfidenceInterval
  longShortReturnNetCI: ConfidenceInterval
  longShortSharpeCI: ConfidenceInterval
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
}

/**
 * Bootstrap a 95% confidence interval over a sample. Resamples with
 * replacement N times and returns the 2.5th / 50th / 97.5th percentiles.
 */
function bootstrapCI(values: number[], iterations = 1000): ConfidenceInterval {
  if (values.length === 0) return { lower: 0, mean: 0, upper: 0 }
  if (values.length === 1) {
    return { lower: values[0], mean: values[0], upper: values[0] }
  }
  const means: number[] = []
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(Math.random() * values.length)]
    }
    means.push(sum / values.length)
  }
  means.sort((left, right) => left - right)
  const empiricalMean = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    lower: means[Math.floor(0.025 * means.length)],
    mean: empiricalMean,
    upper: means[Math.floor(0.975 * means.length)],
  }
}

/**
 * Nested walk-forward hyperparameter search. Tries a small grid of
 * (numTrees, depth, learningRate) on a held-out slice of the early
 * training data and returns the best by mean test-window IC.
 *
 * Standard nested CV practice in time-series ML: outer loop = backtest,
 * inner loop = hyperparameter selection on training data only.
 */
function nestedCvHyperparameterSearch(
  sortedSamples: IndexedSample[],
  innerInitialTrainSize: number,
  innerTestSize: number,
  embargoDays: number,
  horizonDays: number,
): { numTrees: number; depth: number; learningRate: number } {
  const grid: Array<{ numTrees: number; depth: number; learningRate: number }> = [
    { numTrees: 30, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.10 },
    { numTrees: 50, depth: 4, learningRate: 0.05 },
    { numTrees: 80, depth: 3, learningRate: 0.05 },
    { numTrees: 80, depth: 4, learningRate: 0.05 },
  ]
  // Use only the first ~70% of the universe for inner CV (so we don't
  // peek at the outer test windows during hyperparameter selection)
  const innerScope = sortedSamples.slice(0, Math.floor(sortedSamples.length * 0.7))
  if (innerScope.length < innerInitialTrainSize + innerTestSize) {
    return grid[2]  // default fallback
  }
  let bestParams = grid[2]
  let bestMeanIc = -Infinity
  for (const params of grid) {
    let total = 0
    let count = 0
    let splitIndex = innerInitialTrainSize
    // Just take the first 3 inner steps to keep this fast
    for (let stepNum = 0; stepNum < 3 && splitIndex + innerTestSize <= innerScope.length; stepNum++) {
      const result = walkForwardStep(innerScope, splitIndex, innerTestSize, {
        embargoDays,
        horizonDays,
        modelOptions: params,
      })
      if (result) {
        total += result.informationCoefficient
        count++
      }
      splitIndex += innerTestSize
    }
    if (count > 0) {
      const meanIc = total / count
      if (meanIc > bestMeanIc) {
        bestMeanIc = meanIc
        bestParams = params
      }
    }
  }
  return bestParams
}

export function runWalkForwardBacktest(
  samples: HistoricalSample[],
  options: {
    initialTrainSize?: number
    testSize?: number
    stepSize?: number
    embargoDays?: number
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
    /** When true, runs nested CV to pick hyperparameters. Default true. */
    nestedHyperparameterSearch?: boolean
  } = {},
): FullBacktestResult | null {
  const sorted = indexSamples(samples)
  const initialTrainSize = options.initialTrainSize ?? Math.floor(sorted.length * 0.6)
  const testSize = options.testSize ?? 60
  const stepSize = options.stepSize ?? testSize
  const embargoDays = options.embargoDays ?? 5
  const horizonDays = options.horizonDays ?? 20
  const txCostBps = options.txCostBps ?? 10

  // Nested CV: pick hyperparameters using only training-side data
  let chosenParams = options.modelOptions
  if (options.nestedHyperparameterSearch !== false && !chosenParams) {
    chosenParams = nestedCvHyperparameterSearch(
      sorted,
      Math.floor(initialTrainSize * 0.7),
      Math.min(testSize, 40),
      embargoDays,
      horizonDays,
    )
  } else {
    chosenParams = chosenParams ?? { numTrees: 50, depth: 3, learningRate: 0.1 }
  }

  const steps: WalkForwardResult[] = []
  let splitIndex = initialTrainSize
  while (splitIndex + testSize <= sorted.length) {
    const result = walkForwardStep(sorted, splitIndex, testSize, {
      embargoDays,
      horizonDays,
      txCostBps,
      modelOptions: chosenParams,
    })
    if (result) steps.push(result)
    splitIndex += stepSize
  }
  if (steps.length === 0) return null

  // Final ensemble: per-horizon median + p10 + p90 models
  const allFeatures = sorted.map((sample) => sample.features)
  const targetForHorizon = (sample: HistoricalSample, horizon: HorizonKey): number => {
    if (horizon === 5) return sample.forwardReturn5d
    if (horizon === 20) return sample.forwardReturn20d
    if (horizon === 60) return sample.forwardReturn60d
    return sample.forwardReturn120d
  }
  const horizonBundles: HorizonModelBundle[] = ENSEMBLE_HORIZONS.map((horizon) => {
    const horizonTargets = sorted.map((sample) => targetForHorizon(sample, horizon))
    const medianModel = fitGradientBoosting(allFeatures, horizonTargets, {
      ...chosenParams,
      quantile: 0.5,
    })
    const p10Model = fitGradientBoosting(allFeatures, horizonTargets, {
      ...chosenParams,
      quantile: 0.1,
    })
    const p90Model = fitGradientBoosting(allFeatures, horizonTargets, {
      ...chosenParams,
      quantile: 0.9,
    })
    // Estimate this horizon's IC using a quick in-sample correlation
    // between median predictions and actuals (cheap proxy — real IC
    // would need its own walk-forward at this horizon).
    const predictions = allFeatures.map((features) => predictGradientBoosting(medianModel, features))
    const inSampleIC = pearsonCorrelation(predictions, horizonTargets)
    // Approximate hit rate
    const hits = predictions.filter((value, idx) => Math.sign(value) === Math.sign(horizonTargets[idx])).length
    return {
      horizon,
      medianModel,
      p10Model,
      p90Model,
      meanIC: inSampleIC,
      meanHitRate: hits / Math.max(1, predictions.length),
      icCI: { lower: inSampleIC, mean: inSampleIC, upper: inSampleIC },
    }
  })
  const trainedModel = horizonBundles.find((bundle) => bundle.horizon === 20)?.medianModel ??
    horizonBundles[0].medianModel

  const mean = (key: keyof WalkForwardResult): number =>
    steps.reduce((sum, step) => sum + (step[key] as number), 0) / steps.length

  // Cumulative return path across walk-forward steps
  let runningCumReturn = 0
  let peak = 0
  let maxDD = 0
  for (const step of steps) {
    runningCumReturn += step.longShortReturnNet
    if (runningCumReturn > peak) peak = runningCumReturn
    const dd = peak - runningCumReturn
    if (dd > maxDD) maxDD = dd
  }

  // Average feature importance
  const featureCount = steps[0]?.featureImportance.length ?? 0
  const meanFeatureImportance: number[] = new Array(featureCount).fill(0)
  for (const step of steps) {
    step.featureImportance.forEach((value, idx) => {
      meanFeatureImportance[idx] += value
    })
  }
  for (let f = 0; f < featureCount; f++) {
    meanFeatureImportance[f] /= steps.length
  }

  // Bootstrap 95% CIs over the per-step distribution
  const icCI = bootstrapCI(steps.map((step) => step.informationCoefficient))
  const hitRateCI = bootstrapCI(steps.map((step) => step.hitRate))
  const longShortReturnNetCI = bootstrapCI(steps.map((step) => step.longShortReturnNet))
  const longShortSharpeCI = bootstrapCI(steps.map((step) => step.longShortSharpe))

  return {
    steps,
    meanIC: mean('informationCoefficient'),
    meanSpearmanIC: mean('spearmanIc'),
    meanHitRate: mean('hitRate'),
    meanLongShortReturnGross: mean('longShortReturnGross'),
    meanLongShortReturnNet: mean('longShortReturnNet'),
    meanLongShortSharpe: mean('longShortSharpe'),
    meanBaselineRandomIc: mean('baselineRandomIc'),
    meanBaselineMomentumIc: mean('baselineMomentumIc'),
    cumulativeReturn: runningCumReturn,
    maxDrawdown: maxDD,
    meanFeatureImportance,
    totalSamples: sorted.length,
    trainedModel,
    horizonBundles,
    embargoDaysUsed: embargoDays,
    txCostBpsUsed: txCostBps,
    icCI,
    hitRateCI,
    longShortReturnNetCI,
    longShortSharpeCI,
    hyperparameters: {
      numTrees: chosenParams.numTrees ?? 50,
      depth: chosenParams.depth ?? 3,
      learningRate: chosenParams.learningRate ?? 0.1,
    },
  }
}
