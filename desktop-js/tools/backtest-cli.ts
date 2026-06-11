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
  const {
    DEFAULT_BACKTEST_TICKERS,
    HISTORICAL_FEATURE_NAMES,
    PRUNED_FEATURE_NAMES,
    analyzeSurvivorship,
    buildHistoricalDataset,
    computeFeatureStats,
    labelStepsByRegime,
    pruneSampleFeatures,
    runWalkForwardBacktest,
    summarizeStepsByRegime,
  } = await import('../src/data/historicalBacktest')
  const { cachedFetchDailyBars } = await import('../src/data/marketData')

  const usePruned = process.argv.includes('--pruned')
  // --persist: PUT the trained bundle to the backend's /ml/model store so
  // every app instance adopts it on next boot (newest trainedAt wins).
  const persist = process.argv.includes('--persist')
  const rangeArgIndex = process.argv.indexOf('--range')
  const range = (rangeArgIndex >= 0 ? process.argv[rangeArgIndex + 1] : '15y') as
    | '5y'
    | '10y'
    | '15y'
    | 'max'

  console.log(
    `Building dataset for ${DEFAULT_BACKTEST_TICKERS.length} tickers (${range} bars via proxy)…`,
  )
  const started = Date.now()
  const built = await buildHistoricalDataset(DEFAULT_BACKTEST_TICKERS, {
    cadenceDays: 10,
    range,
    onProgress: (current, total, ticker) => {
      if (current % 10 === 0) console.log(`  ${current}/${total} ${ticker}`)
    },
  })
  const d = built.diagnostics
  console.log(
    `Dataset: ${built.samples.length} samples · ${d.tickersWithUsableBars}/${d.tickersAttempted} tickers usable` +
      ` · ${d.tickersWithFundamentals ?? 0} with point-in-time EDGAR fundamentals` +
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

  // Optional pruning to the importance-survivor feature set
  let samples = built.samples
  let featureNames: string[] = [...HISTORICAL_FEATURE_NAMES]
  if (usePruned) {
    const pruned = pruneSampleFeatures(built.samples, PRUNED_FEATURE_NAMES)
    samples = pruned.samples
    featureNames = pruned.featureNames
    console.log(
      `Pruned to ${featureNames.length}/${HISTORICAL_FEATURE_NAMES.length} importance-positive features.`,
    )
  }

  console.log('Running purged+embargoed walk-forward (nested-CV hyperparameters)…')
  // Test windows: at least one cross-sectional date each, sized so the
  // out-of-sample period yields ~70 windows (CI width scales with the
  // number of independent windows, not with samples).
  const targetWindows = 70
  const testSize = Math.max(
    d.tickersWithUsableBars,
    Math.floor((samples.length * 0.4) / targetWindows),
  )
  const result = runWalkForwardBacktest(samples, {
    initialTrainSize: Math.floor(samples.length * 0.6),
    testSize,
    stepSize: testSize,
    baselineMomentumFeatureIndex: Math.max(0, featureNames.indexOf('momentum_252d')),
    captureTestDetails: true,
  })
  if (!result) {
    console.error('Walk-forward produced no usable steps.')
    process.exit(1)
  }

  // Regime labeling: point-in-time Markov regime on SPY at each step
  // start. 'max', not the dataset range: every step needs 60+ prior SPY
  // returns or labelStepsByRegime silently defaults it to 'low-vol' —
  // which would misfile the 2020 crash on long-range runs.
  console.log('Labeling walk-forward steps by SPY Markov regime…')
  const spyBars = await cachedFetchDailyBars('SPY', 'max')
  const regimeLabels = labelStepsByRegime(result.steps, spyBars)
  const regimeBreakdown = summarizeStepsByRegime(result.steps, regimeLabels)

  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  const f = (value: number, digits = 3) => value.toFixed(digits)

  console.log('')
  console.log(`=== WALK-FORWARD RESULTS (out-of-sample, ${usePruned ? 'PRUNED' : 'FULL'} feature set: ${featureNames.length}) ===`)
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
  if (result.intervalCoverage80CI) {
    console.log('--- Conformal 80% intervals (Romano-Patterson-Candès 2019, out of sample) ---')
    console.log(
      `Coverage: ${f(result.intervalCoverage80CI.mean * 100, 1)}%  CI [${f(result.intervalCoverage80CI.lower * 100, 1)}%, ${f(result.intervalCoverage80CI.upper * 100, 1)}%]  (target 80%)` +
        (result.intervalMeanWidthPct != null ? `  mean width ${f(result.intervalMeanWidthPct, 1)}pp` : ''),
    )
    console.log('')
  }
  console.log('--- Multi-horizon in-sample IC + conformal offsets ---')
  for (const bundle of result.horizonBundles) {
    console.log(
      `  ${String(bundle.horizon).padStart(3)}d: IC ${f(bundle.meanIC)} hit ${f(bundle.meanHitRate * 100, 1)}%` +
        (bundle.conformalOffsetPct != null
          ? `  conformal +/-${f(bundle.conformalOffsetPct, 2)}pp (n=${bundle.conformalCalibrationSize})`
          : ''),
    )
  }
  console.log('')
  console.log('--- Regime breakdown (Hamilton Markov on SPY, point-in-time) ---')
  for (const regime of ['low-vol', 'high-vol'] as const) {
    const bucket = regimeBreakdown[regime]
    console.log(
      `  ${regime.padEnd(9)} steps=${bucket.steps}  IC ${f(bucket.meanIC)}  hit ${f(bucket.meanHitRate * 100, 1)}%  L/S net ${f(bucket.meanLongShortReturnNet, 2)}%`,
    )
  }

  // ALWAYS the unpruned samples: the diagnostics index raw features in
  // full 45-column space; pruned arrays would silently misread.
  const survivorship = analyzeSurvivorship(built.samples, result.steps)
  if (survivorship) {
    console.log('')
    console.log('--- Survivorship diagnostics ---')
    const core = survivorship.cohorts.core
    const priv = survivorship.cohorts.survivorPrivileged
    console.log(
      `cohorts at formation (HXZ 2020 size screen + FF 2004 age screen):`,
    )
    console.log(
      `  established-then    windows=${core.windows}  IC ${f(core.meanIC)}  L/S ${f(core.meanLongShortPct, 2)}%  (n=${core.samples})`,
    )
    console.log(
      `  survivor-privileged windows=${priv.windows}  IC ${f(priv.meanIC)}  L/S ${f(priv.meanLongShortPct, 2)}%  (n=${priv.samples}, young-or-small-then)`,
    )
    console.log(
      `  edge concentrated in the privileged cohort = partly survivorship artifact`,
    )
    console.log(`era ICs (Linnainmaa-Roberts 2018 subperiods; deeper-past outperformance = bias fingerprint):`)
    for (const era of survivorship.eras) {
      console.log(
        `  ${era.label}  steps=${String(era.steps).padStart(2)}  IC ${f(era.meanIC)}  L/S net ${f(era.meanLongShortNetPct, 2)}%`,
      )
    }
    const dd = survivorship.canary.naiveDdToReturnIc
    const az = survivorship.canary.altmanZToReturnIc
    console.log(
      `distress canary (CHS 2008 expects NEGATIVE distress->return relation; financials excluded per BS/CHS practice; imputed values skipped):`,
    )
    console.log(
      `  IC(distress via naive-DD -> fwd 20d) = ${dd != null ? f(dd) : 'n/a'}   IC(distress via Altman Z'' -> fwd 20d) = ${az != null ? f(az) : 'n/a'}`,
    )
    if (dd == null && az == null) {
      console.log(`  canary NOT COMPUTED (too few observed distress values out of sample) — no verdict either way.`)
    } else if (survivorship.canary.survivorshipSignature) {
      console.log(
        `  WARNING: distress predicts HIGH returns here — the survivorship signature. Treat absolute returns as inflated.`,
      )
    } else {
      console.log(`  sign consistent with CHS 2008 — no overt survivorship signature in the distress dimension.`)
    }
    console.log(
      `delisting haircut bound (Shumway 1997 -30% NYSE/AMEX; Shumway-Warther 1999 ~-55% Nasdaq makes this the conservative end; FF2004 ~7%/yr attrition applied to YOUNG lists only):`,
    )
    console.log(
      `  long quintile: ${f(survivorship.delistingBound.privilegedShareOfLongQuintile * 100, 1)}% privileged, ${f(survivorship.delistingBound.youngShareOfLongQuintile * 100, 1)}% young -> long-side haircut ~${f(survivorship.delistingBound.haircutPpPerWindow, 3)}pp/window; L/S net ${f(result.meanLongShortReturnNet, 2)}% -> ~${f(result.meanLongShortReturnNet - survivorship.delistingBound.haircutPpPerWindow, 2)}% adjusted`,
    )
  }
  console.log('')
  console.log('--- Permutation feature importance (mean IC drop) ---')
  const ranked = result.meanFeatureImportance
    .map((value, idx) => ({ name: featureNames[idx] ?? `f${idx}`, value }))
    .sort((left, right) => right.value - left.value)
  for (const entry of ranked) {
    console.log(`  ${entry.name.padEnd(18)} ${entry.value >= 0 ? '+' : ''}${f(entry.value)}`)
  }
  console.log('')
  console.log('--- Per-step history ---')
  const regimeByDate = new Map(regimeLabels.map((label) => [label.testStartDate, label]))
  for (const step of result.steps) {
    const label = regimeByDate.get(step.testStartDate)
    const regimeTag = label ? `${label.regime === 'high-vol' ? 'HIGH' : 'low '} p=${f(label.highProb, 2)}` : ''
    console.log(
      `  ${step.testStartDate} → ${step.testEndDate}  IC ${f(step.informationCoefficient)}  hit ${f(step.hitRate * 100, 0)}%  L/S net ${f(step.longShortReturnNet, 2)}%  [${regimeTag}]`,
    )
  }

  if (persist) {
    const stats = computeFeatureStats(samples)
    const bundle20 = result.horizonBundles.find((bundle) => bundle.horizon === 20)
    const payload = {
      model: result.trainedModel,
      p10Model: bundle20?.p10Model,
      p90Model: bundle20?.p90Model,
      horizonModels: result.horizonBundles.map((bundle) => ({
        horizon: bundle.horizon,
        medianModel: bundle.medianModel,
        meanIC: bundle.meanIC,
        icCI: bundle.icCI,
        conformalOffsetPct: bundle.conformalOffsetPct,
      })),
      conformalOffset20dPct: bundle20?.conformalOffsetPct,
      trainedAt: new Date().toISOString(),
      featureCount: result.trainedModel.numFeatures,
      featureNames,
      featureMeans: stats.means,
      featureStds: stats.stds,
      meanIC: result.meanIC,
      meanLongShortReturnNet: result.meanLongShortReturnNet,
      meanLongShortSharpe: result.meanLongShortSharpe,
      hyperparameters: result.hyperparameters,
    }
    const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
    const response = await fetch(`${base}/ml/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = (await response.json()) as { ok?: boolean; bytes?: number; detail?: string }
    if (response.ok && body.ok) {
      console.log('')
      console.log(
        `Persisted trained bundle to backend /ml/model (${((body.bytes ?? 0) / 1024).toFixed(0)} KB) — app instances adopt it on next boot.`,
      )
    } else {
      console.error('')
      console.error(`Persist FAILED: ${body.detail ?? response.status}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
