/// <reference lib="webworker" />

import {
  buildHistoricalDataset,
  runWalkForwardBacktest,
  type DatasetBuildResult,
  type FullBacktestResult,
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
 * means the UI stays responsive (60 FPS) during the 20-60 second
 * compute. Vite handles bundling automatically when imported via
 * `new Worker(new URL('./backtest.worker.ts', import.meta.url),
 * { type: 'module' })`.
 */

type RunMessage = {
  type: 'run'
  tickers: string[]
  range: '5y' | '10y' | 'max'
  cadenceDays: number
  modelOptions?: { numTrees: number; depth: number; learningRate: number }
}

type WorkerOutbound =
  | { type: 'progress'; current: number; total: number; ticker: string }
  | { type: 'dataset-built'; diagnostics: DatasetBuildResult['diagnostics']; sampleCount: number }
  | { type: 'done'; result: FullBacktestResult }
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

    const result = runWalkForwardBacktest(built.samples, {
      initialTrainSize: Math.floor(built.samples.length * 0.6),
      testSize: 60,
      stepSize: 60,
      modelOptions,
    })
    if (!result) {
      const err: WorkerOutbound = { type: 'error', message: 'Walk-forward validation produced no usable steps.' }
      ctx.postMessage(err)
      return
    }
    const done: WorkerOutbound = { type: 'done', result }
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
