/**
 * Node CLI for the walk-forward backtest — runs the exact same pipeline
 * as the in-app BacktestPanel (dataset build → purged/embargoed
 * walk-forward → multi-horizon quantile ensemble) but headless, so
 * results can be produced and inspected without clicking through the UI.
 *
 * Build + run (from desktop-js/):
 *   npx esbuild tools/backtest-cli.ts --bundle --platform=node --format=esm \
 *     --outfile=tools/backtest-cli.mjs \
 *     "--define:import.meta.env.VITE_ORACLE_BACKEND_URL='\"http://127.0.0.1:8787\"'" \
 *     "--define:import.meta.env.VITE_FRED_API_KEY='\"\"'"
 *   node tools/backtest-cli.mjs
 *
 * Requires the backend cache server on port 8787 (it proxies Yahoo).
 */

// The browser modules use window.setTimeout/clearTimeout; in Node those
// live on globalThis with compatible signatures.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const { DEFAULT_BACKTEST_TICKERS, HISTORICAL_FEATURE_NAMES, buildHistoricalDataset, runWalkForwardBacktest } =
    await import('../src/data/historicalBacktest')

  console.log(`Building dataset for ${DEFAULT_BACKTEST_TICKERS.length} tickers (5y bars via proxy)…`)
  const started = Date.now()
  const built = await buildHistoricalDataset(DEFAULT_BACKTEST_TICKERS, {
    cadenceDays: 10,
    range: '5y',
    onProgress: (current, total, ticker) => {
      if (current % 10 === 0) console.log(`  ${current}/${total} ${ticker}`)
    },
  })
  const d = built.diagnostics
  console.log(
    `Dataset: ${built.samples.length} samples · ${d.tickersWithUsableBars}/${d.tickersAttempted} tickers usable` +
      (d.tickersWithZeroBars ? ` · ${d.tickersWithZeroBars} fetch failures` : '') +
      (d.tickersBelowMinBars ? ` · ${d.tickersBelowMinBars} below history threshold` : ''),
  )
  if (d.tickersWithZeroBars > 0) {
    const failed = d.perTickerSummary.filter((entry) => entry.bars === 0).map((entry) => entry.ticker)
    console.log(`  failed: ${failed.join(', ')}`)
  }
  if (built.samples.length < 200) {
    console.error('Not enough samples for a reliable walk-forward. Is the backend running on 8787?')
    process.exit(1)
  }

  console.log('Running purged+embargoed walk-forward (nested-CV hyperparameters)…')
  const result = runWalkForwardBacktest(built.samples, {
    initialTrainSize: Math.floor(built.samples.length * 0.6),
    testSize: 60,
    stepSize: 60,
  })
  if (!result) {
    console.error('Walk-forward produced no usable steps.')
    process.exit(1)
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  const f = (value: number, digits = 3) => value.toFixed(digits)

  console.log('')
  console.log('=== WALK-FORWARD RESULTS (out-of-sample) ===')
  console.log(`samples=${result.totalSamples} steps=${result.steps.length} elapsed=${elapsed}s`)
  console.log(
    `hyperparameters: trees=${result.hyperparameters.numTrees} depth=${result.hyperparameters.depth} lr=${result.hyperparameters.learningRate}`,
  )
  console.log(`embargo=${result.embargoDaysUsed}d txCost=${result.txCostBpsUsed}bps`)
  console.log('')
  console.log(`IC (Pearson):   ${f(result.meanIC)}  CI [${f(result.icCI.lower)}, ${f(result.icCI.upper)}]`)
  console.log(`IC (Spearman):  ${f(result.meanSpearmanIC)}`)
  console.log(`Hit rate:       ${f(result.meanHitRate * 100, 1)}%  CI [${f(result.hitRateCI.lower * 100, 1)}%, ${f(result.hitRateCI.upper * 100, 1)}%]`)
  console.log('')
  console.log('--- Baselines (mean IC) ---')
  console.log(`GBT model:          ${f(result.meanIC)}`)
  console.log(`Random:             ${f(result.meanBaselineRandomIc)}`)
  console.log(`12-month momentum:  ${f(result.meanBaselineMomentumIc)}`)
  console.log(`Edge over momentum: ${f(result.meanIC - result.meanBaselineMomentumIc)}`)
  console.log('')
  console.log('--- Long-short quintile (20d horizon) ---')
  console.log(`Gross return: ${f(result.meanLongShortReturnGross, 2)}%`)
  console.log(`Net return:   ${f(result.meanLongShortReturnNet, 2)}%  CI [${f(result.longShortReturnNetCI.lower, 2)}%, ${f(result.longShortReturnNetCI.upper, 2)}%]`)
  console.log(`Sharpe (ann): ${f(result.meanLongShortSharpe, 2)}  CI [${f(result.longShortSharpeCI.lower, 2)}, ${f(result.longShortSharpeCI.upper, 2)}]`)
  console.log(`Cumulative:   ${f(result.cumulativeReturn, 2)}%  MaxDD: ${f(result.maxDrawdown, 2)}%`)
  console.log('')
  console.log('--- Multi-horizon in-sample IC ---')
  for (const bundle of result.horizonBundles) {
    console.log(`  ${String(bundle.horizon).padStart(3)}d: IC ${f(bundle.meanIC)} hit ${f(bundle.meanHitRate * 100, 1)}%`)
  }
  console.log('')
  console.log('--- Permutation feature importance (mean IC drop) ---')
  const ranked = result.meanFeatureImportance
    .map((value, idx) => ({ name: HISTORICAL_FEATURE_NAMES[idx] ?? `f${idx}`, value }))
    .sort((left, right) => right.value - left.value)
  for (const entry of ranked) {
    console.log(`  ${entry.name.padEnd(18)} ${entry.value >= 0 ? '+' : ''}${f(entry.value)}`)
  }
  console.log('')
  console.log('--- Per-step history ---')
  for (const step of result.steps) {
    console.log(
      `  ${step.testStartDate} → ${step.testEndDate}  IC ${f(step.informationCoefficient)}  hit ${f(step.hitRate * 100, 0)}%  L/S net ${f(step.longShortReturnNet, 2)}%  (train ${step.trainSize})`,
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
