import { cachedFetchDailyBars, normalizeYahooSymbol } from './marketData'
import {
  computeFeaturesAtDate,
  fetchFundamentalsTimeline,
  HISTORICAL_FEATURE_NAMES,
  HISTORICAL_FEATURE_PIPELINE_VERSION,
  assessModelPromotion,
  type BacktestDatasetProvenance,
  type BacktestDatasetQuality,
  type ModelPromotionAssessment,
  type RegimeLabel,
} from './historicalBacktest'
import { kvGet, kvSet } from './storage'
import {
  fitMarkovRegime,
  logReturns,
  pearsonCorrelation,
  predictBaggedGradientBoosting,
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

// v3 is an intentional compatibility boundary: adjusted/source-row price
// semantics, provenance schema 2, and executable-state binding cannot safely
// reuse a model trained under the v2 feature pipeline.
const MODEL_KEY = 'ml-model:gbt:v3'
const ADVISORY_MODEL_KEY = 'ml-model:gbt:advisory:v2'
const FEATURE_NORM_KEY = 'ml-model:feature-norm:v2'
// v2 adds executable-model cohort attribution to every prediction row.
const PREDICTION_LOG_KEY = 'ml-model:prediction-log:v2'

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
  /** Bagged 20d ensemble (member mean = the measured + served scorer).
   * Older blobs lack it; serving falls back to `model`. */
  bag20?: GradientBoostingModel[]
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
  /** Binds every decision-relevant executable component to this artifact. */
  servingEnsembleAudit?: ServingEnsembleAudit
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
  /** Reproducible dataset identity and measured quality at training time.
   * Older artifacts omit these fields and are deliberately advisory-only. */
  datasetProvenance?: BacktestDatasetProvenance
  datasetQuality?: BacktestDatasetQuality
  /** Only an artifact whose evidence assessment is promotable and whose
   * persisted mode is promoted may mint live Buy/Accumulate labels. */
  promotion?: ModelPromotionAssessment & {
    persistedMode: 'promoted' | 'advisory-only'
    advisoryOverrideUsed: boolean
  }
}

export type ServingEnsembleAudit = {
  schemaVersion: 1
  aggregation: 'mean-of-bagged-gbt-members'
  bagCount: number
  memberTreeCounts: number[]
  memberFingerprints: string[]
  p10Fingerprint: string | null
  p90Fingerprint: string | null
  /** Corruption-detection fingerprint across the main fallback, bag, interval
   * heads, conformal widening, feature order/normalizers, and horizons. */
  executableStateFingerprint: string
}

function valueFingerprint(value: unknown): string {
  const json = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    hash = Math.imul(hash ^ json.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function executableModelFingerprint(model: GradientBoostingModel | undefined): string | null {
  return model ? valueFingerprint(model) : null
}

export function createServingEnsembleAudit(
  model: Pick<
    StoredMlModel,
    | 'model'
    | 'bag20'
    | 'p10Model'
    | 'p90Model'
    | 'horizonModels'
    | 'conformalOffset20dPct'
    | 'featureNames'
    | 'featureMeans'
    | 'featureStds'
  >,
): ServingEnsembleAudit {
  const bag = model.bag20 ?? []
  return {
    schemaVersion: 1,
    aggregation: 'mean-of-bagged-gbt-members',
    bagCount: bag.length,
    memberTreeCounts: bag.map((member) => member.trees.length),
    memberFingerprints: bag.map((member) => executableModelFingerprint(member)!),
    p10Fingerprint: executableModelFingerprint(model.p10Model),
    p90Fingerprint: executableModelFingerprint(model.p90Model),
    executableStateFingerprint: valueFingerprint({
      model: model.model,
      bag20: model.bag20,
      p10Model: model.p10Model,
      p90Model: model.p90Model,
      horizonModels: model.horizonModels,
      conformalOffset20dPct: model.conformalOffset20dPct,
      featureNames: model.featureNames,
      featureMeans: model.featureMeans,
      featureStds: model.featureStds,
    }),
  }
}

export type ModelDecisionAuthority = {
  canLeadDecisions: boolean
  status: 'promoted' | 'advisory-only' | 'legacy-unverified'
  detail: string
  blockerCodes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isStringArray(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((item) => typeof item === 'string' && item.length > 0)
}

function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Backend blobs are external JSON. Validate executable structure before
 * prediction or promotion. This is corruption/crash defense, not cryptographic
 * authenticity; signed cross-machine artifacts remain a separate requirement. */
function hasValidTreeNode(node: unknown, numFeatures: number, depth = 0): boolean {
  if (!isRecord(node) || depth > 64) return false
  if (node.isLeaf === true) return isFiniteNumber(node.value)
  if (node.isLeaf !== false) return false
  return (
    Number.isInteger(node.featureIndex) &&
    (node.featureIndex as number) >= 0 &&
    (node.featureIndex as number) < numFeatures &&
    isFiniteNumber(node.threshold) &&
    hasValidTreeNode(node.left, numFeatures, depth + 1) &&
    hasValidTreeNode(node.right, numFeatures, depth + 1)
  )
}

function hasValidGradientModel(value: unknown, expectedFeatures?: number): boolean {
  if (!isRecord(value)) return false
  const numFeatures = value.numFeatures
  if (!Number.isInteger(numFeatures) || (numFeatures as number) <= 0) return false
  if (expectedFeatures != null && numFeatures !== expectedFeatures) return false
  if (!Array.isArray(value.trees) || value.trees.length === 0) return false
  if (!value.trees.every((tree) => isRecord(tree) && hasValidTreeNode(tree.root, numFeatures as number))) return false
  return isFiniteNumber(value.learningRate) && value.learningRate > 0 && isFiniteNumber(value.baseValue)
}

function hasUsableModelShape(value: unknown): value is StoredMlModel {
  if (!isRecord(value) || !hasValidGradientModel(value.model)) return false
  const model = value.model as Record<string, unknown>
  const numFeatures = model.numFeatures as number
  if (!isNonNegativeInteger(value.featureCount) || value.featureCount !== numFeatures) return false
  if (!isStringArray(value.featureNames) || value.featureNames.length !== numFeatures) return false
  if (new Set(value.featureNames).size !== value.featureNames.length) return false
  if (!value.featureNames.every((name) => HISTORICAL_FEATURE_NAMES.includes(name))) return false
  if (!Array.isArray(value.featureMeans) || value.featureMeans.length !== numFeatures || !value.featureMeans.every(isFiniteNumber)) return false
  if (!Array.isArray(value.featureStds) || value.featureStds.length !== numFeatures || !value.featureStds.every((item) => isFiniteNumber(item) && item > 0)) return false
  if (typeof value.trainedAt !== 'string' || !Number.isFinite(Date.parse(value.trainedAt))) return false
  if (!isFiniteNumber(value.meanIC) || !isFiniteNumber(value.meanLongShortReturnNet) || !isFiniteNumber(value.meanLongShortSharpe)) return false
  if (!isRecord(value.hyperparameters)) return false
  if (!Number.isInteger(value.hyperparameters.numTrees) || (value.hyperparameters.numTrees as number) <= 0) return false
  if (!Number.isInteger(value.hyperparameters.depth) || (value.hyperparameters.depth as number) <= 0) return false
  if (!isFiniteNumber(value.hyperparameters.learningRate) || value.hyperparameters.learningRate <= 0) return false
  const expectedTreeCount = value.hyperparameters.numTrees as number
  if ((model.trees as unknown[]).length !== expectedTreeCount) return false
  if (value.bag20 != null && (!Array.isArray(value.bag20) || value.bag20.length === 0 || !value.bag20.every((member) => hasValidGradientModel(member, numFeatures)))) return false
  if (value.bag20?.some((member) => member.trees.length !== expectedTreeCount)) return false
  if (value.p10Model != null && !hasValidGradientModel(value.p10Model, numFeatures)) return false
  if (value.p90Model != null && !hasValidGradientModel(value.p90Model, numFeatures)) return false
  if (value.p10Model && (value.p10Model as GradientBoostingModel).trees.length !== expectedTreeCount) return false
  if (value.p90Model && (value.p90Model as GradientBoostingModel).trees.length !== expectedTreeCount) return false
  if (value.horizonModels != null) {
    if (!Array.isArray(value.horizonModels)) return false
    const seenHorizons = new Set<number>()
    for (const horizon of value.horizonModels) {
      if (!isRecord(horizon) || ![5, 20, 60, 120].includes(horizon.horizon as number)) return false
      if (seenHorizons.has(horizon.horizon as number)) return false
      seenHorizons.add(horizon.horizon as number)
      if (!hasValidGradientModel(horizon.medianModel, numFeatures)) return false
      if ((horizon.medianModel as GradientBoostingModel).trees.length !== expectedTreeCount) return false
      if (!isFiniteNumber(horizon.meanIC) || !isRecord(horizon.icCI)) return false
      if (![horizon.icCI.lower, horizon.icCI.mean, horizon.icCI.upper].every(isFiniteNumber)) return false
      if ((horizon.icCI.lower as number) > (horizon.icCI.mean as number) || (horizon.icCI.mean as number) > (horizon.icCI.upper as number)) return false
      if (horizon.conformalOffsetPct != null && (!isFiniteNumber(horizon.conformalOffsetPct) || horizon.conformalOffsetPct < 0)) return false
    }
  }
  return true
}

function hasValidatedServingEnsemble(model: StoredMlModel): boolean {
  const numFeatures = model.model.numFeatures
  const horizons = model.horizonModels
  const horizonSetValid =
    Array.isArray(horizons) &&
    horizons.length === 4 &&
    [...horizons].map((entry) => entry.horizon).sort((a, b) => a - b).join(',') === '5,20,60,120' &&
    horizons.every(
      (entry) => isFiniteNumber(entry.conformalOffsetPct) && entry.conformalOffsetPct >= 0,
    )
  const structurallyValid =
    Array.isArray(model.bag20) &&
    // runWalkForwardBacktest evaluates and persists a five-member bag. A
    // different count is a different estimator and cannot inherit its audit.
    model.bag20.length === 5 &&
    model.bag20.every((member) => hasValidGradientModel(member, numFeatures)) &&
    hasValidGradientModel(model.p10Model, numFeatures) &&
    hasValidGradientModel(model.p90Model, numFeatures) &&
    isFiniteNumber(model.conformalOffset20dPct) &&
    model.conformalOffset20dPct >= 0 &&
    horizonSetValid
  if (!structurallyValid || !model.bag20 || !model.p10Model || !model.p90Model) return false
  const expected = createServingEnsembleAudit(model)
  return JSON.stringify(model.servingEnsembleAudit) === JSON.stringify(expected)
}

function hasSupportedProvenance(value: unknown): value is BacktestDatasetProvenance {
  if (!isRecord(value) || value.schemaVersion !== 2) return false
  if (value.featurePipelineVersion !== HISTORICAL_FEATURE_PIPELINE_VERSION) return false
  if (value.priceSource !== 'Yahoo Finance chart via local cache proxy') return false
  if (value.fundamentalsSource !== 'SEC EDGAR XBRL companyfacts via local backend') return false
  if (!isRecord(value.universeEvidence)) return false
  if (value.universeConstruction === 'caller-supplied current-symbol list') {
    if (
      value.universeEvidence.kind !== 'current-symbol-list' ||
      typeof value.universeEvidence.membershipSource !== 'string' ||
      value.universeEvidence.constituentEffectiveDateField !== null ||
      value.universeEvidence.delistedSecuritySource !== null ||
      value.universeEvidence.delistingReturnSource !== null
    ) return false
  } else if (value.universeConstruction === 'point-in-time security master with delistings') {
    if (
      value.universeEvidence.kind !== 'point-in-time-with-delistings' ||
      ![
        value.universeEvidence.membershipSource,
        value.universeEvidence.constituentEffectiveDateField,
        value.universeEvidence.delistedSecuritySource,
        value.universeEvidence.delistingReturnSource,
      ].every((item) => typeof item === 'string' && item.trim().length > 0)
    ) return false
  } else {
    return false
  }
  if (!isStringArray(value.universeTickers) || !isStringArray(value.featureNames)) return false
  if (new Set(value.universeTickers).size !== value.universeTickers.length) return false
  if (!value.universeTickers.every((ticker) => ticker === ticker.trim().toUpperCase())) return false
  if (new Set(value.universeTickers.map(normalizeYahooSymbol)).size !== value.universeTickers.length) return false
  if (new Set(value.featureNames).size !== value.featureNames.length) return false
  if (!value.featureNames.every((name) => HISTORICAL_FEATURE_NAMES.includes(name))) return false
  if (!Array.isArray(value.labelHorizonsTradingDays)) return false
  if ([...value.labelHorizonsTradingDays].sort((a, b) => Number(a) - Number(b)).join(',') !== '5,20,60,120') return false
  if (!['1y', '2y', '5y', '10y', '15y', 'max'].includes(String(value.requestedRange))) return false
  if (value.fetchedRange !== 'max') return false
  if (!Number.isInteger(value.cadenceTradingDays) || (value.cadenceTradingDays as number) <= 0) return false
  if (!Number.isInteger(value.minimumBarsPerTicker) || (value.minimumBarsPerTicker as number) <= 0) return false
  if (!isNonNegativeInteger(value.sampleCount) || value.sampleCount === 0) return false
  if (typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt))) return false
  if (!isRecord(value.sampleDateRange) || !isIsoDay(value.sampleDateRange.start) || !isIsoDay(value.sampleDateRange.end)) return false
  if (value.sampleDateRange.start > value.sampleDateRange.end) return false
  return true
}

function isCoverage(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function sameMeasuredRatio(value: unknown, numerator: number, denominator: number): boolean {
  if (!isCoverage(value)) return false
  const expected = denominator > 0 ? numerator / denominator : 0
  return Math.abs(value - expected) <= 1e-12
}

function hasSupportedDatasetQuality(value: unknown): value is BacktestDatasetQuality {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  const universe = value.universe
  const returns = value.returns
  const fundamentals = value.fundamentals
  const evaluation = value.evaluation
  if (!isRecord(universe) || !isRecord(returns) || !isRecord(fundamentals) || !isRecord(evaluation)) return false
  if (![universe.pointInTimeMembership, universe.includesDelistedSecurities, universe.includesDelistingReturns, universe.survivorshipBiasControlled].every((item) => typeof item === 'boolean')) return false
  if (![universe.intendedMemberCount, universe.membersWithUsablePriceHistory, universe.membersWithExplicitNoHistoryOutcome].every(isNonNegativeInteger)) return false
  if ((universe.intendedMemberCount as number) === 0) return false
  if ((universe.membersWithUsablePriceHistory as number) + (universe.membersWithExplicitNoHistoryOutcome as number) > (universe.intendedMemberCount as number)) return false
  if (!sameMeasuredRatio(
    universe.memberOutcomeCoverage,
    (universe.membersWithUsablePriceHistory as number) + (universe.membersWithExplicitNoHistoryOutcome as number),
    universe.intendedMemberCount as number,
  )) return false
  if (typeof universe.limitation !== 'string') return false
  if (returns.labelPriceField !== 'close') return false
  if (!['unadjusted-close', 'adjusted-close', 'total-return', 'mixed', 'unknown'].includes(String(returns.labelAdjustment))) return false
  if (![returns.sourceRowAcceptanceCoverage, returns.sourceAdjustmentCoverage, returns.adjustedCloseAvailabilityCoverage, returns.adjustedReturnLabelCoverage, returns.totalReturnLabelCoverage].every(isCoverage)) return false
  if (![returns.barsObserved, returns.sourceRowsObserved, returns.sourceInvalidRawBars, returns.sourceEligibleRawBars, returns.sourceMissingAdjustedBars, returns.barsWithAdjustedCloseAvailable].every(isNonNegativeInteger)) return false
  const barsObserved = returns.barsObserved as number
  const sourceRowsObserved = returns.sourceRowsObserved as number
  const sourceInvalidRawBars = returns.sourceInvalidRawBars as number
  const sourceEligibleRawBars = returns.sourceEligibleRawBars as number
  const sourceMissingAdjustedBars = returns.sourceMissingAdjustedBars as number
  const barsWithAdjustedCloseAvailable = returns.barsWithAdjustedCloseAvailable as number
  if (sourceInvalidRawBars > sourceRowsObserved) return false
  if (sourceEligibleRawBars !== sourceRowsObserved - sourceInvalidRawBars) return false
  if (sourceMissingAdjustedBars > sourceEligibleRawBars) return false
  if (barsWithAdjustedCloseAvailable > barsObserved) return false
  if (!sameMeasuredRatio(returns.sourceRowAcceptanceCoverage, sourceEligibleRawBars, sourceRowsObserved)) return false
  if (!sameMeasuredRatio(returns.sourceAdjustmentCoverage, sourceEligibleRawBars - sourceMissingAdjustedBars, sourceEligibleRawBars)) return false
  if (!sameMeasuredRatio(returns.adjustedCloseAvailabilityCoverage, barsWithAdjustedCloseAvailable, barsObserved)) return false
  if (Math.abs((returns.adjustedReturnLabelCoverage as number) - (returns.adjustedCloseAvailabilityCoverage as number)) > 1e-12) return false
  if (Math.abs((returns.totalReturnLabelCoverage as number) - (returns.adjustedReturnLabelCoverage as number)) > 1e-12) return false
  if (returns.dividendsIncludedInLabels !== (returns.totalReturnLabelCoverage === 1)) return false
  if (typeof returns.dividendsIncludedInLabels !== 'boolean' || typeof returns.limitation !== 'string') return false
  if (fundamentals.source !== 'SEC EDGAR XBRL companyfacts' || typeof fundamentals.alignedByFiledDate !== 'boolean') return false
  if (![fundamentals.tickerTimelineCoverage, fundamentals.sampleSnapshotCoverage, fundamentals.observedFeatureCellCoverage].every(isCoverage)) return false
  if (![fundamentals.tickersWithTimeline, fundamentals.usableTickers, fundamentals.samplesWithPointInTimeSnapshot, fundamentals.totalSamples, fundamentals.observedFeatureCells, fundamentals.totalFeatureCells].every(isNonNegativeInteger)) return false
  const tickersWithTimeline = fundamentals.tickersWithTimeline as number
  const usableTickers = fundamentals.usableTickers as number
  const samplesWithSnapshot = fundamentals.samplesWithPointInTimeSnapshot as number
  const totalSamples = fundamentals.totalSamples as number
  const observedFeatureCells = fundamentals.observedFeatureCells as number
  const totalFeatureCells = fundamentals.totalFeatureCells as number
  if (tickersWithTimeline > usableTickers) return false
  if (samplesWithSnapshot > totalSamples) return false
  if (observedFeatureCells > totalFeatureCells) return false
  if (!sameMeasuredRatio(fundamentals.tickerTimelineCoverage, tickersWithTimeline, usableTickers)) return false
  if (!sameMeasuredRatio(fundamentals.sampleSnapshotCoverage, samplesWithSnapshot, totalSamples)) return false
  if (!sameMeasuredRatio(fundamentals.observedFeatureCellCoverage, observedFeatureCells, totalFeatureCells)) return false
  if (typeof fundamentals.limitation !== 'string') return false
  if (![evaluation.purgedWalkForwardSupported, evaluation.embargoSupported, evaluation.foldLocalPreprocessing, evaluation.lockedPostSelectionHoldout].every((item) => typeof item === 'boolean')) return false
  return typeof evaluation.limitation === 'string'
}

function hasValidBaselineEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.method !== 'paired moving-block bootstrap (Kunsch 1989; Politis-Romano 1994)' || value.confidenceLevel !== 0.95) return false
  const validComparison = (candidate: unknown, baseline: 'random' | 'momentum_252d'): boolean => {
    if (!isRecord(candidate) || candidate.baseline !== baseline || candidate.metric !== 'information-coefficient') return false
    if (!isNonNegativeInteger(candidate.pairedStepCount)) return false
    const pairedStepCount = candidate.pairedStepCount as number
    if (pairedStepCount === 0 ? candidate.meanDifference !== null : !isFiniteNumber(candidate.meanDifference)) return false
    if (!Number.isInteger(candidate.bootstrapIterations) || (candidate.bootstrapIterations as number) <= 0) return false
    if (pairedStepCount < 2) {
      return candidate.blockLength === null && candidate.ci95 === null && candidate.ciClearOfZero === false
    }
    if (!Number.isInteger(candidate.blockLength) || (candidate.blockLength as number) <= 0) return false
    if (candidate.ci95 === null) return candidate.ciClearOfZero === false
    if ((candidate.blockLength as number) >= pairedStepCount || !isRecord(candidate.ci95)) return false
    const { lower, mean, upper } = candidate.ci95
    if (![lower, mean, upper].every(isFiniteNumber) || (lower as number) > (mean as number) || (mean as number) > (upper as number)) return false
    if (Math.abs((mean as number) - (candidate.meanDifference as number)) > 1e-12) return false
    return candidate.ciClearOfZero === ((lower as number) > 0)
  }
  return validComparison(value.random, 'random') && validComparison(value.momentum, 'momentum_252d')
}

function samePromotionAudit(
  stored: StoredMlModel['promotion'],
  recomputed: ModelPromotionAssessment,
): boolean {
  if (!stored || !Array.isArray(stored.reasons) || !Array.isArray(stored.blockerCodes)) return false
  return (
    stored.schemaVersion === 1 &&
    stored.policy === 'research-evidence-promotion-v1' &&
    stored.status === recomputed.status &&
    stored.promotable === recomputed.promotable &&
    JSON.stringify(stored.reasons) === JSON.stringify(recomputed.reasons) &&
    JSON.stringify(stored.blockerCodes) === JSON.stringify(recomputed.blockerCodes)
  )
}

/** Fail closed for legacy or advisory artifacts. They may still produce
 * research forecasts, but cannot change the action label shown to the user. */
export function modelDecisionAuthority(model: StoredMlModel | null): ModelDecisionAuthority {
  if (!model) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'No trained model is loaded.',
      blockerCodes: ['NO_MODEL'],
    }
  }
  if (!model.promotion) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'This model predates the evidence-quality contract and has no promotion audit.',
      blockerCodes: ['MISSING_PROMOTION_AUDIT'],
    }
  }
  if (!hasUsableModelShape(model)) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The stored model payload is incomplete or dimensionally inconsistent.',
      blockerCodes: ['INVALID_MODEL_ARTIFACT'],
    }
  }
  if (!hasSupportedProvenance(model.datasetProvenance) || !hasSupportedDatasetQuality(model.datasetQuality)) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The stored model lacks a supported dataset provenance and quality audit.',
      blockerCodes: ['INVALID_DATASET_AUDIT'],
    }
  }
  const provenanceSupportsPointInTimeUniverse =
    model.datasetProvenance.universeConstruction === 'point-in-time security master with delistings' &&
    model.datasetProvenance.universeEvidence.kind === 'point-in-time-with-delistings'
  const qualityClaimsPointInTimeUniverse =
    model.datasetQuality.universe.pointInTimeMembership &&
    model.datasetQuality.universe.includesDelistedSecurities &&
    model.datasetQuality.universe.includesDelistingReturns &&
    model.datasetQuality.universe.survivorshipBiasControlled
  if (
    provenanceSupportsPointInTimeUniverse !== qualityClaimsPointInTimeUniverse ||
    model.datasetProvenance.sampleCount !== model.datasetQuality.fundamentals.totalSamples ||
    model.datasetProvenance.universeTickers.length !== model.datasetQuality.universe.intendedMemberCount ||
    model.datasetQuality.fundamentals.usableTickers !== model.datasetQuality.universe.membersWithUsablePriceHistory ||
    (model.datasetProvenance.sampleCount > 0 && model.datasetQuality.fundamentals.usableTickers === 0) ||
    JSON.stringify(model.datasetProvenance.featureNames) !== JSON.stringify(model.featureNames)
  ) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'Dataset quality claims contradict the recorded universe or sample-count provenance.',
      blockerCodes: ['INCONSISTENT_DATASET_AUDIT'],
    }
  }
  if (!hasValidatedServingEnsemble(model)) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The promoted serving ensemble or calibrated interval heads are missing or invalid.',
      blockerCodes: ['UNVALIDATED_SERVING_MODEL'],
    }
  }
  if (!hasValidBaselineEvidence(model.promotion.baselineEvidence)) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The stored paired-baseline evidence is malformed or incomplete.',
      blockerCodes: ['INVALID_BASELINE_AUDIT'],
    }
  }
  const randomMeanDifference = model.promotion.baselineEvidence.random.meanDifference
  if (
    randomMeanDifference == null ||
    Math.abs(model.meanIC - randomMeanDifference) > 1e-12
  ) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The model headline IC does not reconcile to its zero-IC random baseline evidence.',
      blockerCodes: ['INCONSISTENT_HEADLINE_EVIDENCE'],
    }
  }

  let recomputed: ModelPromotionAssessment
  try {
    recomputed = assessModelPromotion(model.datasetQuality, model.promotion.baselineEvidence)
  } catch {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The stored promotion audit could not be recomputed.',
      blockerCodes: ['INVALID_PROMOTION_AUDIT'],
    }
  }
  if (!samePromotionAudit(model.promotion, recomputed)) {
    return {
      canLeadDecisions: false,
      status: 'legacy-unverified',
      detail: 'The stored promotion claim does not match a fresh assessment of its embedded evidence.',
      blockerCodes: ['INCONSISTENT_PROMOTION_AUDIT'],
    }
  }

  const promoted =
    recomputed.promotable &&
    recomputed.blockerCodes.length === 0 &&
    model.promotion.persistedMode === 'promoted' &&
    model.promotion.advisoryOverrideUsed === false
  if (promoted) {
    return {
        canLeadDecisions: true,
        status: 'promoted',
        detail: 'All dataset-provenance and paired-baseline promotion gates passed.',
        blockerCodes: [],
    }
  }
  const blockerDetail = recomputed.reasons
    .filter((reason) => reason.status === 'block')
    .map((reason) => reason.detail)
    .join(' ')
  return {
    canLeadDecisions: false,
    status: 'advisory-only',
    detail:
      blockerDetail ||
      'This artifact was explicitly persisted for research only and has no live decision authority.',
    blockerCodes: recomputed.blockerCodes,
  }
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
  normalizationMode: 'cross-sectional-live' | 'frozen-fallback'
  /** Median forecasts across all trained horizons, when the ensemble is
   * persisted — used for the cross-horizon agreement vote. */
  horizonReturns?: HorizonReturn[]
  asOf: string
  features: number[]
}

export type LoggedPrediction = {
  ticker: string
  asOf: string                  // ISO date when prediction was made
  predictedReturn20d: number    // % — RELATIVE (cross-sectionally demeaned) forecast
  /** 80% interval bounds at prediction time (relative-return units), when
   * quantile models were loaded — lets the scorecard audit coverage later. */
  p10Return20d?: number
  p90Return20d?: number
  /** trainedAt stamp of the model that made this prediction, so scorecard
   * windows can be interpreted across retrains. */
  modelTrainedAt?: string
  /** Executable-state fingerprint; separates live evidence across retrains. */
  modelFingerprint?: string
  normalizationMode?: LivePrediction['normalizationMode']
  realizedReturn20d?: number    // % ABSOLUTE — populated 20 trading days later
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
    bag20?: GradientBoostingModel[]
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
    datasetProvenance?: BacktestDatasetProvenance
    datasetQuality?: BacktestDatasetQuality
    promotion?: StoredMlModel['promotion']
    /** Advisory experiments stay local unless the caller explicitly chooses
     * to distribute them; a failed retrain must not replace a promoted model
     * used by every app instance. */
    mirrorToBackend?: boolean
  },
): Promise<void> {
  const stored: StoredMlModel = {
    model,
    bag20: meta.bag20,
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
    datasetProvenance: meta.datasetProvenance,
    datasetQuality: meta.datasetQuality,
    promotion: meta.promotion,
  }
  stored.servingEnsembleAudit = createServingEnsembleAudit(stored)
  const activateForServing = modelDecisionAuthority(stored).canLeadDecisions
  if (!activateForServing) {
    // Keep the research artifact for inspection without replacing the model
    // the live decision path loads on boot.
    await kvSet(ADVISORY_MODEL_KEY, stored)
    return
  }

  await kvSet(MODEL_KEY, stored)
  await kvSet(FEATURE_NORM_KEY, {
    means: meta.featureMeans,
    stds: meta.featureStds,
  })
  // Mirror to the backend's model store (best effort) so other app
  // instances — packaged desktop, other browsers — adopt this retrain
  // on their next boot.
  if (meta.mirrorToBackend !== false) void putModelToBackend(stored)
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
    const payload: unknown = await response.json()
    return hasUsableModelShape(payload) && hasSupportedProvenance(payload.datasetProvenance)
      ? payload
      : null
  } catch {
    return null
  }
}

/**
 * Load the newest authoritative model. Advisory/legacy artifacts are kept in
 * a separate research slot and are returned only when no promoted model is
 * available, so a newer experiment can never displace a proven active model.
 */
export async function loadModel(): Promise<StoredMlModel | null> {
  const local = await kvGet<StoredMlModel>(MODEL_KEY)
  const localValid =
    hasUsableModelShape(local) && hasSupportedProvenance(local.datasetProvenance)
      ? local
      : null
  const localAdvisoryRaw = await kvGet<StoredMlModel>(ADVISORY_MODEL_KEY)
  const localAdvisory =
    hasUsableModelShape(localAdvisoryRaw) &&
    hasSupportedProvenance(localAdvisoryRaw.datasetProvenance)
      ? localAdvisoryRaw
      : null
  const remote = await fetchModelFromBackend()

  const newest = (models: StoredMlModel[]): StoredMlModel | null =>
    models.sort((left, right) => Date.parse(right.trainedAt) - Date.parse(left.trainedAt))[0] ?? null
  const authoritative = newest(
    [localValid, remote].filter(
      (candidate): candidate is StoredMlModel =>
        candidate != null && modelDecisionAuthority(candidate).canLeadDecisions,
    ),
  )
  if (authoritative) {
    if (authoritative !== localValid) await kvSet(MODEL_KEY, authoritative)
    await kvSet(FEATURE_NORM_KEY, {
      means: authoritative.featureMeans,
      stds: authoritative.featureStds,
    })
    if (remote && remote !== authoritative && !modelDecisionAuthority(remote).canLeadDecisions) {
      await kvSet(ADVISORY_MODEL_KEY, remote)
    }
    return authoritative
  }

  const research = newest(
    [localAdvisory, localValid, remote].filter(
      (candidate): candidate is StoredMlModel => candidate != null,
    ),
  )
  if (research) await kvSet(ADVISORY_MODEL_KEY, research)
  return research
}

export async function clearModel(): Promise<void> {
  await kvSet(MODEL_KEY, null)
  await kvSet(ADVISORY_MODEL_KEY, null)
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
  if (
    bars.length < 280 ||
    bars.adjustment.rejectedBars > 0 ||
    bars.adjustment.adjustedBars !== bars.adjustment.sourceRows
  ) return null
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
  normalizationMode: LivePrediction['normalizationMode'],
): LivePrediction {
  // Ensemble mean when the bag shipped — the same object the walk-forward
  // measured. Single-model fallback keeps pre-ensemble blobs working.
  const prediction = model.bag20?.length
    ? predictBaggedGradientBoosting(model.bag20, normalized)
    : predictGradientBoosting(model.model, normalized)
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
  // Multi-horizon heads remain stored for research, but are deliberately not
  // emitted into the decision conviction stack. Their current single-holdout
  // IC fields are not genuine paired/block-bootstrap evidence versus
  // baselines, so counting their signs as independent votes would overstate
  // confidence and could reorder the Executive Brief.
  return {
    ticker,
    predictedReturn20d: prediction,
    p10Return20d: p10,
    p90Return20d: p90,
    normalizationMode,
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
  return buildPrediction(ticker, model, normalized, raw.asOf, 'frozen-fallback')
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
  // Concurrency pool of 6: at universe scale (~600 names) a sequential
  // walk took 10+ minutes; six lanes through the local proxy (disk-cached
  // upstream) brings a warm pass to ~1-2 minutes without hammering Yahoo.
  const rawByTicker = new Map<string, number[]>()
  const asOfByTicker = new Map<string, string>()
  const CONCURRENCY = 6
  let nextIndex = 0
  let completed = 0
  const worker = async () => {
    while (nextIndex < tickers.length) {
      const ticker = tickers[nextIndex++]
      const raw = await computeRawServingFeatures(ticker, model)
      if (raw) {
        rawByTicker.set(ticker, raw.rawFeatures)
        asOfByTicker.set(ticker, raw.asOf)
      }
      completed++
      onProgress?.(completed, tickers.length)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, tickers.length)) }, () => worker()),
  )
  // Phase 2 — cross-sectional normalization over the gathered batch.
  const normalizedByTicker = crossSectionalNormalizeServingBatch(rawByTicker, {
    means: model.featureMeans,
    stds: model.featureStds,
  })
  const normalizationMode: LivePrediction['normalizationMode'] =
    rawByTicker.size >= CROSS_SECTION_MIN_BREADTH
      ? 'cross-sectional-live'
      : 'frozen-fallback'
  // Phase 3 — run the model on each normalized vector.
  const out = new Map<string, LivePrediction>()
  for (const [ticker, normalized] of normalizedByTicker) {
    out.set(
      ticker,
      buildPrediction(ticker, model, normalized, asOfByTicker.get(ticker)!, normalizationMode),
    )
  }
  return out
}

/* =========================================================================
   Prediction logging — for live decay monitoring
   ========================================================================= */

/**
 * Log a BATCH of predictions in one read-modify-write.
 *
 * This must be one transaction-shaped operation: the old per-prediction
 * logger was fired 30 times concurrently by the predict effect, and each
 * call did kvGet → push one → kvSet on the SAME key. All 30 reads saw the
 * same starting array, so the last write won and ~29 of 30 predictions
 * were silently dropped (measured live: 1 of 30 survived). That starved
 * the scorecard's per-date cross-sections at the source.
 *
 * DEDUPE by (model fingerprint, ticker, asOf): the predict effect re-runs on refresh /
 * owned-watch changes, so the same (ticker, bar-date) prediction would
 * otherwise be appended many times a day, multiplying those rows in the
 * live IC and skewing it toward whatever names refresh most. One logged
 * prediction per ticker per bar date.
 */
export async function logLivePredictions(
  predictions: LivePrediction[],
  modelTrainedAt?: string,
  modelFingerprint?: string,
): Promise<void> {
  if (predictions.length === 0) return
  const existing = (await kvGet<LoggedPrediction[]>(PREDICTION_LOG_KEY)) ?? []
  const identity = modelFingerprint ?? modelTrainedAt ?? 'legacy-unattributed'
  const keyFor = (entry: LoggedPrediction) =>
    `${entry.modelFingerprint ?? entry.modelTrainedAt ?? 'legacy-unattributed'}|${entry.ticker}|${entry.asOf}`
  const seen = new Set(existing.map(keyFor))
  let appended = false
  for (const prediction of predictions) {
    const key = `${identity}|${prediction.ticker}|${prediction.asOf}`
    if (seen.has(key)) continue
    seen.add(key)
    appended = true
    existing.push({
      ticker: prediction.ticker,
      asOf: prediction.asOf,
      predictedReturn20d: prediction.predictedReturn20d,
      // Interval bounds + model stamp ride along so the scorecard can audit
      // 80%-coverage and attribute samples across retrains.
      p10Return20d: prediction.p10Return20d,
      p90Return20d: prediction.p90Return20d,
      modelTrainedAt,
      modelFingerprint,
      normalizationMode: prediction.normalizationMode,
    })
  }
  if (!appended) return
  // Cap keeps IDB bounded. Universe-scale scoring logs ~600 predictions per
  // trading day, so 40,000 holds ~3 months of history — enough for the
  // scorecard's rolling window with room to spare (a few MB at most).
  const trimmed = existing.length > 40_000 ? existing.slice(-40_000) : existing
  await kvSet(PREDICTION_LOG_KEY, trimmed)
}

/** Read the raw prediction log (for the scorecard). */
export async function loadPredictionLog(): Promise<LoggedPrediction[]> {
  return (await kvGet<LoggedPrediction[]>(PREDICTION_LOG_KEY)) ?? []
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
    // A pending entry more than a year old will never reconcile (delisted
    // ticker, or the provider re-stamped history so the asOf bar no longer
    // exists). Drop it instead of letting it sit as "pending" forever and
    // quietly misstate how much evidence is still on its way.
    if (daysSince > 370) continue
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

/* =========================================================================
   Live prediction scorecard
   -------------------------------------------------------------------------
   The model predicts RELATIVE returns (cross-sectionally demeaned per date —
   Improvement #1), and the backtest's meanIC is measured against that same
   relative target. The reconciler, though, can only observe each ticker's
   ABSOLUTE price path. The old live-IC pooled all realized entries across
   dates and correlated relative forecasts against absolute outcomes — so a
   month where everything rose +8% injected market movement the model never
   claimed to predict, and the "drift vs backtest IC" comparison was
   apples-to-oranges.

   The fix: score each prediction DATE as its own cross-section, exactly like
   training. Within one date, correlating predictions against absolute
   realized returns is identical to correlating against demeaned returns
   (correlation ignores a constant shift shared by the whole group), so the
   market component cancels and the per-date IC is the same quantity family
   the backtest reports. The scorecard averages per-date ICs over the most
   recent dates.
   ========================================================================= */

export type LiveScorecard = {
  /** Mean of per-date Pearson ICs — comparable to the backtest's meanIC. */
  meanIc: number | null
  /** Mean of per-date Spearman rank ICs (robust to outliers). */
  meanRankIc: number | null
  /** Within-date direction agreement: predicted above the date's average
   * where realized was also above the date's average. */
  hitRate: number | null
  /** Mean per-date top-vs-bottom prediction-quintile realized spread (%,
   * demeaned). Only dates with enough names to cut quintiles. */
  quintileSpreadPct: number | null
  /** Share of interval-carrying entries whose demeaned realized return
   * landed inside [p10, p90]. Target ≈ 0.80 by construction. */
  intervalCoverage: number | null
  intervalSamples: number
  datesUsed: number
  realizedUsed: number
  realizedTotal: number
  pendingTotal: number
  /** Earliest date a pending prediction becomes scoreable (asOf + 30d). */
  nextEvaluable: string | null
  windowOldest: string | null
  windowNewest: string | null
  /** Most recent participating dates (ascending), for display. */
  recentDates: Array<{ date: string; n: number; ic: number }>
}

function averageRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)
  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++
    const avgRank = (i + j) / 2 + 1 // average rank for ties, 1-based
    for (let k = i; k <= j; k++) ranks[order[k].index] = avgRank
    i = j + 1
  }
  return ranks
}

/**
 * Score the prediction log. Pure (no I/O) so it is unit-testable.
 *
 * minBreadth mirrors training's demeaning floor (MIN_BREADTH = 5 in
 * applyCrossSectionalReturnDemeaning): a date with fewer realized names has
 * no meaningful cross-section and is excluded. maxDates bounds the window to
 * the most recent participating dates so decay shows up rather than being
 * averaged away by ancient history.
 */
export function computeLiveScorecard(
  log: LoggedPrediction[],
  opts: {
    minBreadth?: number
    spreadMinBreadth?: number
    maxDates?: number
    modelFingerprint?: string
    modelTrainedAt?: string
  } = {},
): LiveScorecard {
  const minBreadth = opts.minBreadth ?? 5
  const spreadMinBreadth = opts.spreadMinBreadth ?? 10
  const maxDates = opts.maxDates ?? 40

  const cohort = opts.modelFingerprint
    ? log.filter((entry) => entry.modelFingerprint === opts.modelFingerprint)
    : opts.modelTrainedAt
      ? log.filter((entry) => entry.modelTrainedAt === opts.modelTrainedAt)
      : log
  const decisionComparableCohort = cohort.filter(
    (entry) => entry.normalizationMode !== 'frozen-fallback',
  )
  const realized = decisionComparableCohort.filter(
    (e) =>
      e.realizedReturn20d != null &&
      Number.isFinite(e.realizedReturn20d) &&
      Number.isFinite(e.predictedReturn20d),
  )
  const pending = decisionComparableCohort.filter((e) => e.realizedReturn20d == null)

  // Earliest scoreable moment among pending predictions: asOf + 30 calendar
  // days (the reconciler's own gate). asOf is a YYYY-MM-DD bar date.
  let nextEvaluable: string | null = null
  for (const entry of pending) {
    const t = new Date(`${entry.asOf.slice(0, 10)}T00:00:00Z`).getTime()
    if (!Number.isFinite(t)) continue
    const evaluable = new Date(t + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    if (nextEvaluable == null || evaluable < nextEvaluable) nextEvaluable = evaluable
  }

  // Group by prediction date; keep dates with a real cross-section.
  const byDate = new Map<string, LoggedPrediction[]>()
  for (const entry of realized) {
    const arr = byDate.get(entry.asOf) ?? []
    arr.push(entry)
    byDate.set(entry.asOf, arr)
  }
  const participating = [...byDate.entries()]
    .filter(([, entries]) => entries.length >= minBreadth)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxDates)

  const perDateIc: Array<{ date: string; n: number; ic: number }> = []
  const rankIcs: number[] = []
  const spreads: number[] = []
  let hits = 0
  let hitSamples = 0
  let covered = 0
  let intervalSamples = 0
  let realizedUsed = 0

  for (const [date, entries] of participating) {
    const predicted = entries.map((e) => e.predictedReturn20d)
    const actual = entries.map((e) => e.realizedReturn20d!)
    const n = entries.length
    realizedUsed += n

    perDateIc.push({ date, n, ic: pearsonCorrelation(predicted, actual) })
    rankIcs.push(pearsonCorrelation(averageRanks(predicted), averageRanks(actual)))

    // Demean within the date — the market's shared move cancels, leaving the
    // relative outcome the model actually forecast.
    const meanP = predicted.reduce((s, v) => s + v, 0) / n
    const meanA = actual.reduce((s, v) => s + v, 0) / n
    for (let i = 0; i < n; i++) {
      hits += Math.sign(predicted[i] - meanP) === Math.sign(actual[i] - meanA) ? 1 : 0
      hitSamples++
      const e = entries[i]
      if (
        e.p10Return20d != null &&
        e.p90Return20d != null &&
        Number.isFinite(e.p10Return20d) &&
        Number.isFinite(e.p90Return20d)
      ) {
        intervalSamples++
        const rel = actual[i] - meanA
        if (rel >= e.p10Return20d && rel <= e.p90Return20d) covered++
      }
    }

    // Top-vs-bottom prediction-quintile realized spread (demeaned %).
    if (n >= spreadMinBreadth) {
      const k = Math.floor(n / 5)
      const sorted = entries
        .map((e, i) => ({ p: e.predictedReturn20d, a: actual[i] - meanA }))
        .sort((x, y) => y.p - x.p)
      const top = sorted.slice(0, k)
      const bottom = sorted.slice(-k)
      const meanTop = top.reduce((s, v) => s + v.a, 0) / k
      const meanBottom = bottom.reduce((s, v) => s + v.a, 0) / k
      spreads.push(meanTop - meanBottom)
    }
  }

  const mean = (xs: number[]) =>
    xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null

  return {
    meanIc: mean(perDateIc.map((d) => d.ic)),
    meanRankIc: mean(rankIcs),
    hitRate: hitSamples > 0 ? hits / hitSamples : null,
    quintileSpreadPct: mean(spreads),
    intervalCoverage: intervalSamples > 0 ? covered / intervalSamples : null,
    intervalSamples,
    datesUsed: participating.length,
    realizedUsed,
    realizedTotal: realized.length,
    pendingTotal: pending.length,
    nextEvaluable,
    windowOldest: participating.length > 0 ? participating[0][0] : null,
    windowNewest: participating.length > 0 ? participating[participating.length - 1][0] : null,
    recentDates: perDateIc.slice(-12),
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
