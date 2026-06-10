import { cachedFetchDailyBars } from './marketData'
import {
  computeFeaturesAtDate,
  HISTORICAL_FEATURE_NAMES,
} from './historicalBacktest'
import { kvGet, kvSet, type DecisionLogEntry } from './storage'
import { predictGradientBoosting, type GradientBoostingModel } from './quantMath'

/**
 * Live ML model service — bridges the historical backtest's trained
 * GBT model to the live engine.
 *
 * Responsibilities:
 *   1. Persist the trained model + metadata to IndexedDB after a backtest
 *   2. Restore it on app launch
 *   3. Compute live ML predictions for any ticker by fetching its current
 *      bars and running them through `computeFeaturesAtDate`
 *   4. Cross-sectional Z-score features against a stored feature snapshot
 *      so live predictions are normalized the same way training data was
 *   5. Track live prediction → realized return for decay monitoring
 */

// v2: adds p10/p90 quantile models for prediction intervals
const MODEL_KEY = 'ml-model:gbt:v2'
const FEATURE_NORM_KEY = 'ml-model:feature-norm:v1'
const PREDICTION_LOG_KEY = 'ml-model:prediction-log:v1'

export type StoredMlModel = {
  /** 20-day median GBT — backward compat */
  model: GradientBoostingModel
  /** Optional 20-day p10 model for prediction interval lower bound */
  p10Model?: GradientBoostingModel
  /** Optional 20-day p90 model for prediction interval upper bound */
  p90Model?: GradientBoostingModel
  trainedAt: string
  featureCount: number
  featureNames: string[]
  featureMeans: number[]
  featureStds: number[]
  meanIC: number
  meanLongShortReturnNet: number
  meanLongShortSharpe: number
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
}

export type LivePrediction = {
  ticker: string
  predictedReturn20d: number
  /** 80% prediction interval [p10, p90] when quantile models are loaded */
  p10Return20d?: number
  p90Return20d?: number
  asOf: string
  features: number[]
}

export type LoggedPrediction = {
  ticker: string
  asOf: string                  // ISO date when prediction was made
  predictedReturn20d: number    // %
  realizedReturn20d?: number    // % — populated 20 trading days later
  realizedAt?: string
}

/* =========================================================================
   Save / load model
   ========================================================================= */

export async function persistModel(
  model: GradientBoostingModel,
  meta: {
    featureMeans: number[]
    featureStds: number[]
    meanIC: number
    meanLongShortReturnNet: number
    meanLongShortSharpe: number
    hyperparameters: { numTrees: number; depth: number; learningRate: number }
    p10Model?: GradientBoostingModel
    p90Model?: GradientBoostingModel
  },
): Promise<void> {
  const stored: StoredMlModel = {
    model,
    p10Model: meta.p10Model,
    p90Model: meta.p90Model,
    trainedAt: new Date().toISOString(),
    featureCount: model.numFeatures,
    featureNames: HISTORICAL_FEATURE_NAMES,
    featureMeans: meta.featureMeans,
    featureStds: meta.featureStds,
    meanIC: meta.meanIC,
    meanLongShortReturnNet: meta.meanLongShortReturnNet,
    meanLongShortSharpe: meta.meanLongShortSharpe,
    hyperparameters: meta.hyperparameters,
  }
  await kvSet(MODEL_KEY, stored)
  await kvSet(FEATURE_NORM_KEY, {
    means: meta.featureMeans,
    stds: meta.featureStds,
  })
}

export async function loadModel(): Promise<StoredMlModel | null> {
  const stored = await kvGet<StoredMlModel>(MODEL_KEY)
  if (!stored || !stored.model || !stored.featureMeans) return null
  return stored
}

export async function clearModel(): Promise<void> {
  await kvSet(MODEL_KEY, null)
  await kvSet(FEATURE_NORM_KEY, null)
}

/* =========================================================================
   Live prediction
   ========================================================================= */

/**
 * Fetch current bars for a ticker and predict its 20-day forward return
 * using the persisted trained model. Returns null if no model is loaded
 * or the ticker has insufficient history.
 */
export async function predictForTicker(
  ticker: string,
  model: StoredMlModel,
): Promise<LivePrediction | null> {
  const bars = await cachedFetchDailyBars(ticker, '5y')
  if (bars.length < 280) return null
  const features = computeFeaturesAtDate(bars, bars.length - 1)
  if (!features) return null
  // Normalize using training-set statistics (Z-scoring against historical
  // distribution, not against the current cross-section)
  const normalized = features.map((value, i) => {
    const mean = model.featureMeans[i] ?? 0
    const std = model.featureStds[i] ?? 1
    return (value - mean) / Math.max(1e-12, std)
  })
  const prediction = predictGradientBoosting(model.model, normalized)
  const p10 = model.p10Model ? predictGradientBoosting(model.p10Model, normalized) : undefined
  const p90 = model.p90Model ? predictGradientBoosting(model.p90Model, normalized) : undefined
  return {
    ticker,
    predictedReturn20d: prediction,
    p10Return20d: p10,
    p90Return20d: p90,
    asOf: bars[bars.length - 1].date,
    features: normalized,
  }
}

export async function predictForUniverse(
  tickers: string[],
  model: StoredMlModel,
  onProgress?: (current: number, total: number) => void,
): Promise<Map<string, LivePrediction>> {
  const out = new Map<string, LivePrediction>()
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    onProgress?.(i, tickers.length)
    const prediction = await predictForTicker(ticker, model)
    if (prediction) out.set(ticker, prediction)
  }
  return out
}

/* =========================================================================
   Prediction logging — for live decay monitoring
   ========================================================================= */

export async function logLivePrediction(
  prediction: LivePrediction,
): Promise<void> {
  const existing = (await kvGet<LoggedPrediction[]>(PREDICTION_LOG_KEY)) ?? []
  existing.push({
    ticker: prediction.ticker,
    asOf: prediction.asOf,
    predictedReturn20d: prediction.predictedReturn20d,
  })
  // Cap at 5,000 entries to avoid unbounded IDB growth
  const trimmed = existing.length > 5000 ? existing.slice(-5000) : existing
  await kvSet(PREDICTION_LOG_KEY, trimmed)
}

/**
 * Walk through pending predictions, look up actual returns 20 trading
 * days after each prediction (if enough time has passed), and update
 * the log with realized returns. This populates the data the decay
 * monitor needs.
 */
export async function reconcilePredictions(): Promise<void> {
  const log = (await kvGet<LoggedPrediction[]>(PREDICTION_LOG_KEY)) ?? []
  if (log.length === 0) return
  const today = new Date()
  const updated: LoggedPrediction[] = []
  // Fetch bars per ticker only once
  const barCache = new Map<string, Awaited<ReturnType<typeof cachedFetchDailyBars>>>()
  for (const entry of log) {
    if (entry.realizedReturn20d != null) {
      updated.push(entry)
      continue
    }
    const asOfDate = new Date(entry.asOf)
    const daysSince = Math.floor((today.getTime() - asOfDate.getTime()) / (1000 * 60 * 60 * 24))
    // 20 trading days ≈ 28 calendar days; pad to 30 to be safe
    if (daysSince < 30) {
      updated.push(entry)
      continue
    }
    let bars = barCache.get(entry.ticker)
    if (!bars) {
      bars = await cachedFetchDailyBars(entry.ticker, '5y')
      barCache.set(entry.ticker, bars)
    }
    if (!bars || bars.length === 0) {
      updated.push(entry)
      continue
    }
    // Find the bar whose date matches asOf, then count 20 forward
    const asOfIndex = bars.findIndex((bar) => bar.date === entry.asOf)
    if (asOfIndex < 0 || asOfIndex + 20 >= bars.length) {
      updated.push(entry)
      continue
    }
    const startPrice = bars[asOfIndex].close
    const endPrice = bars[asOfIndex + 20].close
    if (startPrice <= 0) {
      updated.push(entry)
      continue
    }
    const realizedReturn = ((endPrice - startPrice) / startPrice) * 100
    updated.push({
      ...entry,
      realizedReturn20d: realizedReturn,
      realizedAt: bars[asOfIndex + 20].date,
    })
  }
  await kvSet(PREDICTION_LOG_KEY, updated)
}

/**
 * Compute rolling IC over the most recent N realized predictions.
 * Returns null if fewer than 30 realized predictions exist (too noisy).
 */
export async function computeLiveModelIc(
  windowSize = 100,
): Promise<{
  ic: number
  hitRate: number
  meanRealized: number
  sampleSize: number
  oldest: string
  newest: string
} | null> {
  const log = (await kvGet<LoggedPrediction[]>(PREDICTION_LOG_KEY)) ?? []
  const realized = log.filter((entry) => entry.realizedReturn20d != null)
  if (realized.length < 30) return null
  const recent = realized.slice(-windowSize)
  const predicted = recent.map((entry) => entry.predictedReturn20d)
  const actual = recent.map((entry) => entry.realizedReturn20d!)

  const meanP = predicted.reduce((sum, value) => sum + value, 0) / predicted.length
  const meanA = actual.reduce((sum, value) => sum + value, 0) / actual.length
  let cov = 0
  let varP = 0
  let varA = 0
  for (let i = 0; i < predicted.length; i++) {
    cov += (predicted[i] - meanP) * (actual[i] - meanA)
    varP += (predicted[i] - meanP) ** 2
    varA += (actual[i] - meanA) ** 2
  }
  const ic = varP > 0 && varA > 0 ? cov / Math.sqrt(varP * varA) : 0
  const hits = predicted.filter((value, i) => Math.sign(value) === Math.sign(actual[i])).length
  return {
    ic,
    hitRate: hits / predicted.length,
    meanRealized: meanA,
    sampleSize: predicted.length,
    oldest: recent[0].asOf,
    newest: recent[recent.length - 1].asOf,
  }
}

/** Decision-log integration: also log every prediction into the engine
 * decision log so it shows up alongside the rule-based history. */
export function predictionToLogEntry(
  prediction: LivePrediction,
  modelMeanIc: number,
): DecisionLogEntry {
  return {
    ticker: prediction.ticker,
    asOf: new Date().toISOString(),
    action: prediction.predictedReturn20d > 0 ? 'Buy Now' : 'Avoid',
    opportunityScore: 50 + prediction.predictedReturn20d * 5,
    riskScore: 50,
    confidence: 50 + Math.abs(modelMeanIc) * 200,
    reason: `ML model 20d forecast: ${prediction.predictedReturn20d >= 0 ? '+' : ''}${prediction.predictedReturn20d.toFixed(2)}%`,
  }
}
