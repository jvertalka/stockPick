import { cachedFetchDailyBars } from './marketData'
import {
  computeFeaturesAtDate,
  fetchFundamentalsTimeline,
  HISTORICAL_FEATURE_NAMES,
  type RegimeLabel,
} from './historicalBacktest'
import { kvGet, kvSet, type DecisionLogEntry } from './storage'
import {
  fitMarkovRegime,
  logReturns,
  predictGradientBoosting,
  type GradientBoostingModel,
} from './quantMath'
import { ML_REGIME_GATE } from './quantConfig'

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
// (horizon ensemble added without a key bump — the field is optional, so
// v2 blobs without it load fine and the horizons layer reports unavailable)
const MODEL_KEY = 'ml-model:gbt:v2'
const FEATURE_NORM_KEY = 'ml-model:feature-norm:v1'
const PREDICTION_LOG_KEY = 'ml-model:prediction-log:v1'

/** One persisted horizon: the median (q=0.5) GBT plus its measured
 * out-of-sample IC so the UI can show how much each horizon is worth. */
export type StoredHorizonModel = {
  horizon: number
  medianModel: GradientBoostingModel
  meanIC: number
  icCI: { lower: number; mean: number; upper: number }
  /** Split-conformal interval widening (Romano et al. 2019) measured on
   * the backtest's held-out calibration slice. */
  conformalOffsetPct?: number
}

export type StoredMlModel = {
  /** 20-day median GBT — backward compat */
  model: GradientBoostingModel
  /** Optional 20-day p10 model for prediction interval lower bound */
  p10Model?: GradientBoostingModel
  /** Optional 20-day p90 model for prediction interval upper bound */
  p90Model?: GradientBoostingModel
  /** Median models for every trained horizon (5/20/60/120d) — feeds the
   * conviction stack's multi-horizon agreement layer. */
  horizonModels?: StoredHorizonModel[]
  /** Conformal widening for the 20d p10/p90 interval; live predictions
   * report [p10−Q, p90+Q] so the 80% label is calibrated, not aspirational. */
  conformalOffset20dPct?: number
  trainedAt: string
  featureCount: number
  featureNames: string[]
  featureMeans: number[]
  featureStds: number[]
  /** Walk-forward IC under per-date cross-sectional normalization — the
   * validated-pipeline number. */
  meanIC: number
  /** LIVE-APPLICABLE IC: held-out IC under the global normalization this
   * very serving path uses. This, not meanIC, is what single-ticker live
   * predictions realize; usually below meanIC due to the train/serve
   * normalization skew. */
  servingConsistentIC20d?: number
  meanLongShortReturnNet: number
  meanLongShortSharpe: number
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
}

export type HorizonReturn = {
  horizon: number
  predictedReturnPct: number
  meanIC: number
}

export type LivePrediction = {
  ticker: string
  predictedReturn20d: number
  /** 80% prediction interval [p10, p90] when quantile models are loaded */
  p10Return20d?: number
  p90Return20d?: number
  /** Median forecasts across all trained horizons, when the ensemble is
   * persisted — used for the cross-horizon agreement vote. */
  horizonReturns?: HorizonReturn[]
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
    servingConsistentIC20d?: number
    meanLongShortReturnNet: number
    meanLongShortSharpe: number
    hyperparameters: { numTrees: number; depth: number; learningRate: number }
    p10Model?: GradientBoostingModel
    p90Model?: GradientBoostingModel
    /** Median models per horizon from the backtest's ensemble — persisting
     * all of them enables the multi-horizon agreement conviction layer. */
    horizonModels?: StoredHorizonModel[]
    conformalOffset20dPct?: number
    /** Names of the features the model was trained on, in column order.
     * Defaults to the full set; pruned models MUST pass their subset so
     * live predictions slice the same columns. */
    featureNames?: string[]
  },
): Promise<void> {
  const stored: StoredMlModel = {
    model,
    p10Model: meta.p10Model,
    p90Model: meta.p90Model,
    horizonModels: meta.horizonModels,
    conformalOffset20dPct: meta.conformalOffset20dPct,
    trainedAt: new Date().toISOString(),
    featureCount: model.numFeatures,
    featureNames: meta.featureNames ?? HISTORICAL_FEATURE_NAMES,
    featureMeans: meta.featureMeans,
    featureStds: meta.featureStds,
    meanIC: meta.meanIC,
    servingConsistentIC20d: meta.servingConsistentIC20d,
    meanLongShortReturnNet: meta.meanLongShortReturnNet,
    meanLongShortSharpe: meta.meanLongShortSharpe,
    hyperparameters: meta.hyperparameters,
  }
  await kvSet(MODEL_KEY, stored)
  await kvSet(FEATURE_NORM_KEY, {
    means: meta.featureMeans,
    stds: meta.featureStds,
  })
  // Mirror to the backend's model store (best effort) so other app
  // instances — packaged desktop, other browsers — adopt this retrain
  // on their next boot.
  void putModelToBackend(stored)
}

function mlBackendBase(): string {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
}

async function putModelToBackend(stored: StoredMlModel): Promise<void> {
  try {
    await fetch(`${mlBackendBase()}/ml/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stored),
    })
  } catch {
    // Backend down — IDB copy still works; next persist retries.
  }
}

async function fetchModelFromBackend(): Promise<StoredMlModel | null> {
  try {
    const response = await fetch(`${mlBackendBase()}/ml/model`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const payload = (await response.json()) as StoredMlModel
    return payload?.model && payload.featureMeans ? payload : null
  } catch {
    return null
  }
}

/**
 * Load the trained model: newest of the IndexedDB copy and the backend
 * store wins. The backend store is how a CLI retrain (or another app
 * instance's run) reaches this instance without re-clicking Run backtest.
 */
export async function loadModel(): Promise<StoredMlModel | null> {
  const local = await kvGet<StoredMlModel>(MODEL_KEY)
  const localValid = local?.model && local.featureMeans ? local : null
  const remote = await fetchModelFromBackend()
  if (remote && (!localValid || remote.trainedAt > localValid.trainedAt)) {
    await kvSet(MODEL_KEY, remote)
    await kvSet(FEATURE_NORM_KEY, {
      means: remote.featureMeans,
      stds: remote.featureStds,
    })
    return remote
  }
  return localValid
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
  // 'max' so listing_age_years sees the TRUE first bar — a 5y fetch would
  // cap every mature company's age at 5 and shift the feature vs training.
  const bars = await cachedFetchDailyBars(ticker, 'max')
  if (bars.length < 280) return null
  // Same inputs as training: price features + point-in-time fundamentals
  // (null for ETFs/non-filers — those columns use the neutral encoding).
  const fundamentals = await fetchFundamentalsTimeline(ticker)
  const fullFeatures = computeFeaturesAtDate(bars, bars.length - 1, fundamentals)
  if (!fullFeatures) return null
  // Respect the model's feature subset: a model trained on pruned
  // features stores its featureNames, and live features must be sliced
  // to the same columns in the same order before prediction.
  const features =
    model.featureNames.length > 0 && model.featureNames.length !== HISTORICAL_FEATURE_NAMES.length
      ? model.featureNames.map((name) => {
          const idx = HISTORICAL_FEATURE_NAMES.indexOf(name)
          return idx >= 0 ? fullFeatures[idx] : 0
        })
      : fullFeatures
  // Normalize using training-set statistics (Z-scoring against historical
  // distribution, not against the current cross-section). Missing
  // fundamentals arrive as NaN; impute the training mean — the live
  // counterpart of the per-date median imputation used in training —
  // which lands exactly on Z = 0.
  const normalized = features.map((value, i) => {
    const mean = model.featureMeans[i] ?? 0
    const std = model.featureStds[i] ?? 1
    const filled = Number.isNaN(value) ? mean : value
    return (filled - mean) / Math.max(1e-12, std)
  })
  const prediction = predictGradientBoosting(model.model, normalized)
  // Conformal widening (Romano et al. 2019): the stored offset is what the
  // backtest measured on held-out calibration data, so the 80% interval
  // label is earned rather than assumed.
  const conformal = model.conformalOffset20dPct ?? 0
  const p10 = model.p10Model
    ? predictGradientBoosting(model.p10Model, normalized) - conformal
    : undefined
  const p90 = model.p90Model
    ? predictGradientBoosting(model.p90Model, normalized) + conformal
    : undefined
  // Horizon ensemble: all horizons trained on the same feature matrix
  // (labels differ), so the one normalized vector feeds every median.
  const horizonReturns = model.horizonModels?.length
    ? model.horizonModels.map((bundle) => ({
        horizon: bundle.horizon,
        predictedReturnPct: predictGradientBoosting(bundle.medianModel, normalized),
        meanIC: bundle.meanIC,
      }))
    : undefined
  return {
    ticker,
    predictedReturn20d: prediction,
    p10Return20d: p10,
    p90Return20d: p90,
    horizonReturns,
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

/* =========================================================================
   Regime gate (Hamilton 1989 Markov switching on SPY)
   -------------------------------------------------------------------------
   The walk-forward backtest measures the model's IC separately per market
   regime. When one regime shows no (or negative) out-of-sample IC, acting
   on ML predictions in that regime is uncompensated risk — so the app
   suppresses ML-driven action overrides there and falls back to rules.
   Gate direction + thresholds live in quantConfig.ML_REGIME_GATE with the
   measurement that justified them.
   ========================================================================= */

export type RegimeGate = {
  regime: RegimeLabel
  highProb: number
  /** True when ML action overrides should be suppressed in this regime */
  gated: boolean
  detail: string
}

let regimeGateCache: { expires: number; value: Promise<RegimeGate> } | null = null

export function getRegimeGate(): Promise<RegimeGate> {
  const now = Date.now()
  if (regimeGateCache && regimeGateCache.expires > now) return regimeGateCache.value
  const value = computeRegimeGate()
  regimeGateCache = { expires: now + 60 * 60 * 1000, value }
  return value
}

async function computeRegimeGate(): Promise<RegimeGate> {
  const fallback: RegimeGate = {
    regime: 'low-vol',
    highProb: 0,
    gated: false,
    detail: 'Regime undetermined (no SPY history) — ML ungated by default.',
  }
  try {
    const bars = await cachedFetchDailyBars('SPY', '5y')
    const closes = bars.map((bar) => bar.close)
    const returns = logReturns(closes)
    if (returns.length < 120) return fallback
    // Same trailing window the backtest's regime labeling uses.
    const state = fitMarkovRegime(returns.slice(-504))
    const regime: RegimeLabel = state.currentHighProb > 0.5 ? 'high-vol' : 'low-vol'
    const gated = ML_REGIME_GATE.gatedRegime != null && regime === ML_REGIME_GATE.gatedRegime
    return {
      regime,
      highProb: state.currentHighProb,
      gated,
      detail: gated
        ? `SPY is in the ${regime} state (P=${(state.currentHighProb * 100).toFixed(0)}%). ${ML_REGIME_GATE.rationale}`
        : `SPY is in the ${regime} state (P=${(state.currentHighProb * 100).toFixed(0)}%) — ML predictions active.`,
    }
  } catch {
    return fallback
  }
}
