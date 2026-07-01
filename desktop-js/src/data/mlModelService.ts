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
      // X-Oracle-Write: model writes are gated behind this custom header —
      // it forces a CORS preflight, which the backend only approves for
      // local origins, so a drive-by website can't overwrite the model that
      // decides what the app recommends.
      headers: { 'Content-Type': 'application/json', 'X-Oracle-Write': '1' },
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

/** Minimum number of live names required to form a trustworthy cross-section
 * for serve-time normalization. Mirrors the training-side MIN_GROUP_FOR_ZSCORE
 * in applyCrossSectionalNormalization: below this many names a single date's
 * (here: the live batch's) mean/std is too noisy, so the whole batch falls
 * back to the model's frozen training stats. The live universe passed in is
 * the top ~30 opportunity/owned/watched names, so this floor only trips for
 * tiny watchlists. */
const CROSS_SECTION_MIN_BREADTH = 5

type RawServingFeatures = { rawFeatures: number[]; asOf: string }

/**
 * Fetch a ticker's current bars + point-in-time fundamentals and compute its
 * RAW (un-normalized) feature vector, sliced to the model's column order.
 * Missing fundamentals stay as NaN — the caller imputes + normalizes them.
 * Returns null when history is too short or features can't be built.
 */
async function computeRawServingFeatures(
  ticker: string,
  model: StoredMlModel,
): Promise<RawServingFeatures | null> {
  // 'max' so listing_age_years sees the TRUE first bar — a 5y fetch would
  // cap every mature company's age at 5 and shift the feature vs training.
  const bars = await cachedFetchDailyBars(ticker, 'max')
  if (bars.length < 280) return null
  // Same inputs as training: price features + point-in-time fundamentals
  // (null for ETFs/non-filers — those columns arrive NaN and get imputed).
  const fundamentals = await fetchFundamentalsTimeline(ticker)
  const fullFeatures = computeFeaturesAtDate(bars, bars.length - 1, fundamentals)
  if (!fullFeatures) return null
  // Respect the model's feature subset: a model trained on pruned features
  // stores its featureNames, and live features must be sliced to the same
  // columns in the same order before prediction. An unknown name (should
  // never happen) arrives NaN so it imputes to the neutral center.
  const rawFeatures =
    model.featureNames.length > 0 && model.featureNames.length !== HISTORICAL_FEATURE_NAMES.length
      ? model.featureNames.map((name) => {
          const idx = HISTORICAL_FEATURE_NAMES.indexOf(name)
          return idx >= 0 ? fullFeatures[idx] : Number.NaN
        })
      : fullFeatures
  return { rawFeatures, asOf: bars[bars.length - 1].date }
}

/** Frozen-stats normalization: Z-score a single raw vector against the
 * model's stored training means/stds (RMS-of-within-date-std scaled). Missing
 * (non-finite) values impute to the mean and land exactly on Z = 0. Used for
 * single-name predictions and as the small-batch fallback below. */
function normalizeWithFrozenStats(
  rawFeatures: number[],
  frozen: { means: number[]; stds: number[] },
): number[] {
  return rawFeatures.map((value, i) => {
    const mean = frozen.means[i] ?? 0
    const std = frozen.stds[i] ?? 1
    const filled = !Number.isFinite(value) ? mean : value
    return (filled - mean) / Math.max(1e-12, std)
  })
}

/**
 * Serve-time CROSS-SECTIONAL normalization (Improvement #2) — the live
 * counterpart of training's imputeMissingWithDateMedians +
 * applyCrossSectionalNormalization, with "today's live universe" playing the
 * role of one training date. Per feature, across the batch:
 *   1. impute missing (non-finite) values to the cross-sectional MEDIAN of
 *      the names that have it (matches imputeMissingWithDateMedians), then
 *   2. Z-score every name against the cross-sectional MEAN/STD of the now-
 *      complete column (matches applyCrossSectionalNormalization).
 * The four exact-fidelity choices match training: ascending-sort median at
 * Math.floor(n/2), population variance (/N), median-imputed values INCLUDED
 * in the mean/std, and the Math.max(1e-12, .) std floor.
 *
 * Breadth guard: with fewer than `minBreadth` names the batch mean/std is too
 * noisy to trust, so the whole batch falls back to the model's frozen
 * training stats. A feature absent for EVERY name in the batch likewise falls
 * back to frozen for that one column — there is no live cross-section to
 * estimate it from. NOTE this frozen fallback is a knowing APPROXIMATION, not
 * a faithful copy of training's <MIN_GROUP_FOR_ZSCORE sparse-date rule: that
 * rule divides by the global POOLED std, whereas the frozen stats use the RMS
 * of within-date stds (computeFeatureStats). The two differ for drifting
 * features, so tiny batches are not expected to recover meanIC — acceptable
 * because the production batch is ~30 names and this path only fires for a
 * near-empty watchlist.
 *
 * "Missing" means non-finite (NaN OR ±Infinity): a single Infinity admitted
 * into the cross-section would poison the whole column's mean/std to NaN, so
 * we treat it as missing and impute it.
 *
 * One cross-section: the batch is normalized as a single group even though
 * each name's asOf is its own last-bar date. Training groups strictly by
 * date; on a normal trading day every active name shares the last-bar date,
 * so they coincide. A day-stale straggler enters at the wrong date, but its
 * effect is bounded (1 of ~30 names, dampened by the median impute).
 *
 * Pure (no I/O) so it is unit-testable in isolation.
 */
export function crossSectionalNormalizeServingBatch(
  rawByTicker: Map<string, number[]>,
  frozen: { means: number[]; stds: number[] },
  minBreadth = CROSS_SECTION_MIN_BREADTH,
): Map<string, number[]> {
  const tickers = [...rawByTicker.keys()]
  const out = new Map<string, number[]>()
  if (tickers.length === 0) return out
  const featureCount = rawByTicker.get(tickers[0])!.length

  // Too few names for a trustworthy cross-section — frozen fallback for all.
  if (tickers.length < minBreadth) {
    for (const ticker of tickers) {
      out.set(ticker, normalizeWithFrozenStats(rawByTicker.get(ticker)!, frozen))
    }
    return out
  }

  // Per-feature cross-sectional median (for imputation) + mean/std (for the
  // Z-score), each computed over the median-imputed-complete column exactly
  // as training does after imputeMissingWithDateMedians.
  const csMean = new Array<number>(featureCount).fill(0)
  const csStd = new Array<number>(featureCount).fill(1)
  const csMedian = new Array<number>(featureCount).fill(Number.NaN)
  const featureUsesFrozen = new Array<boolean>(featureCount).fill(false)

  for (let f = 0; f < featureCount; f++) {
    const present: number[] = []
    for (const ticker of tickers) {
      const value = rawByTicker.get(ticker)![f]
      if (Number.isFinite(value)) present.push(value)
    }
    if (present.length === 0) {
      // Feature absent across the whole batch — no cross-section to form.
      featureUsesFrozen[f] = true
      continue
    }
    present.sort((a, b) => a - b)
    const median = present[Math.floor(present.length / 2)]
    csMedian[f] = median
    let sum = 0
    const imputed: number[] = []
    for (const ticker of tickers) {
      const value = rawByTicker.get(ticker)![f]
      const filled = !Number.isFinite(value) ? median : value
      imputed.push(filled)
      sum += filled
    }
    const mean = sum / imputed.length
    let varSum = 0
    for (const value of imputed) varSum += (value - mean) ** 2
    csMean[f] = mean
    csStd[f] = Math.sqrt(Math.max(1e-12, varSum / imputed.length))
  }

  for (const ticker of tickers) {
    const raw = rawByTicker.get(ticker)!
    const normalized = new Array<number>(featureCount)
    for (let f = 0; f < featureCount; f++) {
      if (featureUsesFrozen[f]) {
        const mean = frozen.means[f] ?? 0
        const std = frozen.stds[f] ?? 1
        const filled = !Number.isFinite(raw[f]) ? mean : raw[f]
        normalized[f] = (filled - mean) / Math.max(1e-12, std)
      } else {
        const filled = !Number.isFinite(raw[f]) ? csMedian[f] : raw[f]
        normalized[f] = (filled - csMean[f]) / Math.max(1e-12, csStd[f])
      }
    }
    out.set(ticker, normalized)
  }
  return out
}

/** Run the trained GBT (+ quantile heads + horizon ensemble) on an already-
 * normalized feature vector and assemble the LivePrediction. */
function buildPrediction(
  ticker: string,
  model: StoredMlModel,
  normalized: number[],
  asOf: string,
): LivePrediction {
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
    asOf,
    features: normalized,
  }
}

/**
 * Predict a SINGLE ticker's 20-day forward return. With only one name there
 * is no live cross-section, so this normalizes against the model's frozen
 * training stats. Returns null if no model is loaded or history is too short.
 * (Universe-scale predictions go through predictForUniverse, which uses the
 * cross-sectional path.)
 */
export async function predictForTicker(
  ticker: string,
  model: StoredMlModel,
): Promise<LivePrediction | null> {
  const raw = await computeRawServingFeatures(ticker, model)
  if (!raw) return null
  const normalized = normalizeWithFrozenStats(raw.rawFeatures, {
    means: model.featureMeans,
    stds: model.featureStds,
  })
  return buildPrediction(ticker, model, normalized, raw.asOf)
}

/**
 * Predict for a whole live universe with SERVE-TIME CROSS-SECTIONAL
 * normalization (Improvement #2): each feature is Z-scored against the
 * batch's own cross-section — the same FAMILY of transform the model trained
 * under (per-date cross-sectional Z) — instead of the model's frozen 15y
 * training stats.
 *
 * This REMOVES the train/serve normalization skew that depressed the frozen
 * single-name path (whose held-out IC is the measured servingConsistentIC20d
 * ≈ 0.072) and moves live ranking TOWARD the per-date-normalized walk-forward
 * meanIC (≈ 0.078). It does NOT "realize" meanIC, and we deliberately do not
 * claim a specific live number, because the live cross-section differs from
 * the one meanIC was measured on in three ways: (a) the batch is the top ~30
 * SELECTED opportunity/owned/watched names (pickTickersToEnhance) — a
 * conditional, range-compressed slice, not the full per-date panel; (b) ~30
 * names give a noisier mean/std than the full-universe panels; (c) meanIC is
 * a POOLED multi-date Pearson IC, not a within-batch rank-IC. So treat
 * servingConsistentIC20d and meanIC as a lower/upper BRACKET on the expected
 * live IC, with meanIC an upper reference, not a delivered figure.
 *
 * Selecting the batch this way is still the right FRAME for a "who is
 * relatively strongest among my candidates" tool — it just means the realized
 * IC is its own unmeasured quantity inside that bracket.
 *
 * Phase 1 gathers raw features for every name; phase 2 normalizes them
 * together; phase 3 runs the model.
 */
export async function predictForUniverse(
  tickers: string[],
  model: StoredMlModel,
  onProgress?: (current: number, total: number) => void,
): Promise<Map<string, LivePrediction>> {
  // Phase 1 — gather RAW (un-normalized) feature vectors for the batch.
  const rawByTicker = new Map<string, number[]>()
  const asOfByTicker = new Map<string, string>()
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    onProgress?.(i, tickers.length)
    const raw = await computeRawServingFeatures(ticker, model)
    if (raw) {
      rawByTicker.set(ticker, raw.rawFeatures)
      asOfByTicker.set(ticker, raw.asOf)
    }
  }
  // Phase 2 — cross-sectional normalization over the gathered batch.
  const normalizedByTicker = crossSectionalNormalizeServingBatch(rawByTicker, {
    means: model.featureMeans,
    stds: model.featureStds,
  })
  // Phase 3 — run the model on each normalized vector.
  const out = new Map<string, LivePrediction>()
  for (const [ticker, normalized] of normalizedByTicker) {
    out.set(ticker, buildPrediction(ticker, model, normalized, asOfByTicker.get(ticker)!))
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
  // DEDUPE by (ticker, asOf): the predict effect re-runs on every refresh /
  // owned-watch change, so the same (ticker, bar-date) prediction would be
  // appended many times a day, multiplying those rows in the decay-monitor
  // IC and skewing it toward whatever names happen to refresh most. One
  // logged prediction per ticker per bar date.
  if (existing.some((e) => e.ticker === prediction.ticker && e.asOf === prediction.asOf)) {
    return
  }
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
