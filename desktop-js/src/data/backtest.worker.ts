/// <reference lib="webworker" />

import {
  PRUNED_FEATURE_NAMES,
  assessModelPromotion,
  buildCalendarWindows,
  buildHistoricalDataset,
  computeFeatureStats,
  pruneSampleFeatures,
  resolveWindowRule,
  runWalkForwardBacktest,
  summarizeCalendarWindows,
  type DatasetBuildResult,
  type FullBacktestResult,
  type ModelPromotionAssessment,
} from './historicalBacktest'

/**
 * Web Worker host for the backtest pipeline.
 *
 * Main thread sends:
 *   { type: 'run', tickers, options }
 *
 * Worker emits:
 *   { type: 'progress', current, total, ticker }
 *   { type: 'dataset-built', diagnostics, sampleCount }
 *   { type: 'done', result }   // result is FullBacktestResult
 *   { type: 'error', message }
 *
 * Moving the dataset build + walk-forward training off the main thread
 * means the UI stays responsive (60 FPS) during the multi-minute
 * compute (~200-name universe with conformal interval fits). Vite
 * handles bundling automatically when imported via
 * `new Worker(new URL('./backtest.worker.ts', import.meta.url),
 * { type: 'module' })`.
 */

type RunMessage = {
  type: 'run'
  tickers: string[]
  range: '5y' | '10y' | '15y' | 'max'
  cadenceDays: number
  modelOptions?: { numTrees: number; depth: number; learningRate: number }
}

type WorkerOutbound =
  | { type: 'progress'; current: number; total: number; ticker: string }
  | { type: 'dataset-built'; diagnostics: DatasetBuildResult['diagnostics']; sampleCount: number }
  | {
      type: 'done'
      result: FullBacktestResult
      provenance: DatasetBuildResult['provenance']
      quality: DatasetBuildResult['quality']
      promotion: ModelPromotionAssessment
      /** Raw-feature mean/std for the pruned columns — what live
       * predictions must normalize against (NOT 0/1). */
      featureStats: { means: number[]; stds: number[] }
    }
  | { type: 'error'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (event: MessageEvent<RunMessage>) => {
  if (event.data.type !== 'run') return
  const { tickers, range, cadenceDays, modelOptions } = event.data
  try {
    const built: DatasetBuildResult = await buildHistoricalDataset(tickers, {
      cadenceDays,
      range,
      onProgress: (current, total, ticker) => {
        const msg: WorkerOutbound = { type: 'progress', current, total, ticker }
        ctx.postMessage(msg)
      },
    })
    const datasetMsg: WorkerOutbound = {
      type: 'dataset-built',
      diagnostics: built.diagnostics,
      sampleCount: built.samples.length,
    }
    ctx.postMessage(datasetMsg)

    if (built.samples.length < 200) {
      const err: WorkerOutbound = {
        type: 'error',
        message: `Only ${built.samples.length} samples — need at least 200 for a reliable walk-forward.`,
      }
      ctx.postMessage(err)
      return
    }

    // Train on the importance-survivor feature subset. The 2026-05-12
    // pruning study (see PRUNED_FEATURE_NAMES) doubled out-of-sample IC
    // (0.040 → 0.076) and halved max drawdown by dropping the 18 features
    // with zero/negative permutation importance.
    const pruned = pruneSampleFeatures(built.samples, PRUNED_FEATURE_NAMES)

    // Test windows are cut on the trading calendar by the SAME rule and the
    // SAME defaults the CLI uses (DEFAULT_WINDOW_RULE), so the app and the
    // CLI report the same window count on the same data. Each window holds
    // every name formed inside its 20 trading days, so quintile long-short
    // portfolios are still formed within one holding period.
    const windowRule = resolveWindowRule()
    const result = runWalkForwardBacktest(pruned.samples, {
      ...windowRule,
      tradingDates: built.tradingDates,
      modelOptions,
      baselineMomentumFeatureIndex: pruned.featureNames.indexOf('momentum_252d'),
    })
    if (!result) {
      const attempted = summarizeCalendarWindows(
        pruned.samples,
        buildCalendarWindows(pruned.samples, { ...windowRule, tradingDates: built.tradingDates }),
        windowRule,
        0,
      )
      const err: WorkerOutbound = {
        type: 'error',
        message:
          `Walk-forward validation produced no usable steps: ${attempted.windowsBuilt} test window(s) from samples dated ` +
          `${attempted.firstSampleDate} to ${attempted.lastSampleDate} after the ${windowRule.burnInYears}-year burn-in. ` +
          'Choose a longer history range.',
      }
      ctx.postMessage(err)
      return
    }
    const done: WorkerOutbound = {
      type: 'done',
      result,
      provenance: built.provenance,
      quality: built.quality,
      promotion: assessModelPromotion(built.quality, result.baselineEvidence),
      featureStats: computeFeatureStats(pruned.samples),
    }
    ctx.postMessage(done)
  } catch (error) {
    const err: WorkerOutbound = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Worker error',
    }
    ctx.postMessage(err)
  }
}

export {}
