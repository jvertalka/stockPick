/**
 * Lightweight SIZE-SEGMENTATION experiment.
 *
 * Question: does training a separate model per market-cap tier (a mixture of
 * experts routed by size) beat one pooled model on each tier? The de-risk
 * showed pooling a heterogeneous universe DILUTES IC (edge concentrates in
 * liquid large-caps). This measures whether segment-specific models recover it.
 *
 * Method (one clean time split, no walk-forward — fast + robust):
 *   1. build the dataset (per-date cross-sectional features, 20d relative target)
 *   2. split ONCE by date: train = first 70% (label window closed before the
 *      test start, so no leakage), test = last 30%
 *   3. partition by logMarketCap terciles (small / mid / large)
 *   4. POOLED model: train on ALL train, measure IC on each tier's test
 *   5. SEGMENT model: train on that tier's train only, measure IC on its test
 *   6. delta = segment IC - pooled IC. Positive => segmentation helps that tier.
 */
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const { buildHistoricalDataset } = await import('../src/data/historicalBacktest')
  const { fitGradientBoosting, predictGradientBoosting, pearsonCorrelation } = await import(
    '../src/data/quantMath'
  )
  const { readFileSync } = await import('node:fs')

  const fileIdx = process.argv.indexOf('--tickers-file')
  const tickers = JSON.parse(readFileSync(process.argv[fileIdx + 1], 'utf-8')) as string[]
  const rangeIdx = process.argv.indexOf('--range')
  const range = (rangeIdx >= 0 ? process.argv[rangeIdx + 1] : '15y') as '10y' | '15y' | 'max'
  const PARAMS = { numTrees: 80, depth: 4, learningRate: 0.05 }

  console.log(`Building dataset for ${tickers.length} tickers (${range})…`)
  const built = await buildHistoricalDataset(tickers, {
    cadenceDays: 10,
    range,
    onProgress: (c, t, k) => {
      if (c % 50 === 0) console.log(`  ${c}/${t} ${k}`)
    },
  })
  // Need a market cap to assign a size tier.
  const samples = built.samples.filter((s) => Number.isFinite(s.logMarketCap))
  console.log(
    `Dataset: ${built.samples.length} samples · ${samples.length} with market cap · ` +
      `${built.diagnostics.tickersWithUsableBars}/${built.diagnostics.tickersAttempted} tickers usable`,
  )
  if (samples.length < 3000) {
    console.log('Too few sized samples for a stable segment experiment.')
    process.exit(1)
  }

  // ---- single date-based time split (70/30) with a 20d purge ----
  const byDate = [...samples].sort((a, b) => (a.asOf < b.asOf ? -1 : 1))
  const testStart = byDate[Math.floor(byDate.length * 0.7)].asOf
  const trainAll = samples.filter((s) => s.labelEnd20d < testStart)
  const testAll = samples.filter((s) => s.asOf >= testStart)

  // ---- size terciles by logMarketCap (boundaries from the train set) ----
  const caps = trainAll.map((s) => s.logMarketCap).sort((a, b) => a - b)
  const q1 = caps[Math.floor(caps.length / 3)]
  const q2 = caps[Math.floor((2 * caps.length) / 3)]
  const tier = (s: { logMarketCap: number }) =>
    s.logMarketCap <= q1 ? 'small' : s.logMarketCap <= q2 ? 'mid' : 'large'

  const ic = (model: ReturnType<typeof fitGradientBoosting>, test: typeof samples) =>
    pearsonCorrelation(
      test.map((s) => predictGradientBoosting(model, s.features)),
      test.map((s) => s.forwardReturn20dRel),
    )

  // POOLED model on the whole train set
  const pooled = fitGradientBoosting(
    trainAll.map((s) => s.features),
    trainAll.map((s) => s.forwardReturn20dRel),
    PARAMS,
  )
  const pooledOverall = ic(pooled, testAll)

  console.log(`\nTrain ${trainAll.length} · Test ${testAll.length} · testStart ${testStart}`)
  console.log(`Pooled model overall test IC: ${pooledOverall.toFixed(4)}\n`)
  console.log('tier   | nTrain | nTest  | pooled IC | segment IC |  delta')
  console.log('-------|--------|--------|-----------|------------|--------')
  for (const name of ['large', 'mid', 'small'] as const) {
    const segTrain = trainAll.filter((s) => tier(s) === name)
    const segTest = testAll.filter((s) => tier(s) === name)
    const pooledIC = ic(pooled, segTest)
    let segIC = Number.NaN
    if (segTrain.length >= 500 && segTest.length >= 100) {
      const segModel = fitGradientBoosting(
        segTrain.map((s) => s.features),
        segTrain.map((s) => s.forwardReturn20dRel),
        PARAMS,
      )
      segIC = ic(segModel, segTest)
    }
    const delta = segIC - pooledIC
    console.log(
      `${name.padEnd(6)} | ${String(segTrain.length).padStart(6)} | ${String(segTest.length).padStart(6)} | ` +
        `${pooledIC.toFixed(4).padStart(9)} | ${segIC.toFixed(4).padStart(10)} | ${(delta >= 0 ? '+' : '') + delta.toFixed(4)}`,
    )
  }
  console.log(
    '\nReading: positive delta => a size-specific model beats the pooled model on that tier => segmentation helps.',
  )
  process.exit(0)
}
main()
