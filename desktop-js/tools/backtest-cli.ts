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
    calibrationAndSizingAudit,
    computeFeatureStats,
    featureSelectionFDR,
    labelStepsByRegime,
    pruneSampleFeatures,
    runWalkForwardBacktest,
    singleFeatureSharpes,
    summarizeStepsByRegime,
  } = await import('../src/data/historicalBacktest')
  const { cachedFetchDailyBars } = await import('../src/data/marketData')
  const { sampleSkewness, sampleExcessKurtosis } = await import('../src/data/quantMath')
  const { deflatedSharpeRatio } = await import('../src/data/selectionStats')

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
  // --tickers-file PATH: train on a custom JSON array of tickers instead of
  // DEFAULT_BACKTEST_TICKERS (used for size-segment experiments — e.g. an
  // S&P 400 mid-cap-only or S&P 600 small-cap-only universe).
  const tickersFileIdx = process.argv.indexOf('--tickers-file')
  let baseTickers: readonly string[] = DEFAULT_BACKTEST_TICKERS
  if (tickersFileIdx >= 0) {
    const { readFileSync } = await import('node:fs')
    baseTickers = JSON.parse(readFileSync(process.argv[tickersFileIdx + 1], 'utf-8')) as string[]
  }
  // --limit N: train on the first N tickers (the curated bellwethers come
  // first). Used to stage a big retrain — e.g. 500 to de-risk, then 1000.
  const limitArgIndex = process.argv.indexOf('--limit')
  const limit = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) : 0
  const tickers = limit > 0 ? baseTickers.slice(0, limit) : baseTickers

  console.log(
    `Building dataset for ${tickers.length} tickers (${range} bars via proxy)…`,
  )
  const started = Date.now()
  const built = await buildHistoricalDataset(tickers, {
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
    baselineMomentumFeatureIndex: featureNames.indexOf('momentum_252d'),
    captureTestDetails: true,
  })
  if (!result) {
    console.error('Walk-forward produced no usable steps.')
    process.exit(1)
  }

  // Regime labeling: point-in-time Markov regime on SPY at each step
  // start. 'max', not the dataset range: every step needs 60+ prior SPY
  // returns. Retry on empty — a single transient Yahoo failure here would
  // mark every window 'unknown' and erase the whole regime breakdown.
  console.log('Labeling walk-forward steps by SPY Markov regime…')
  let spyBars = await cachedFetchDailyBars('SPY', 'max')
  for (let attempt = 0; spyBars.length === 0 && attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1500))
    spyBars = await cachedFetchDailyBars('SPY', 'max')
  }
  if (spyBars.length === 0) {
    console.warn('  WARNING: SPY history unavailable — every step labeled "unknown".')
  } else {
    console.log(`  SPY history: ${spyBars.length} bars (${spyBars[0].date} → ${spyBars[spyBars.length - 1].date})`)
  }
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
  console.log(`embargo=${result.embargoDaysUsed}d  size-tiered cost (entry both legs + short borrow) avg=${f(result.meanRealizedCostBps, 1)}bps/window`)
  console.log('')
  console.log(`IC (Pearson, validated):  ${f(result.meanIC)}  CI [${f(result.icCI.lower)}, ${f(result.icCI.upper)}]   (per-date cross-sectional norm)`)
  if (result.servingConsistentIC20d != null && Number.isFinite(result.servingConsistentIC20d)) {
    console.log(`IC (live-applicable):     ${f(result.servingConsistentIC20d)}   (held-out, under SERVING's global normalization — what live predictions realize)`)
  }
  console.log(`IC (Spearman):  ${f(result.meanSpearmanIC)}`)
  console.log(`Hit rate:       ${f(result.meanHitRate * 100, 1)}%  CI [${f(result.hitRateCI.lower * 100, 1)}%, ${f(result.hitRateCI.upper * 100, 1)}%]`)
  console.log('')
  console.log('--- Baselines (mean IC) ---')
  console.log(`GBT model:          ${f(result.meanIC)}`)
  console.log(`Random:             ${f(result.meanBaselineRandomIc)}`)
  const momInSet = featureNames.includes('momentum_252d')
  console.log(
    `12-month momentum:  ${momInSet ? f(result.meanBaselineMomentumIc) : 'n/a (momentum_252d not in this feature set)'}`,
  )
  if (momInSet) {
    console.log(`Edge over momentum: ${f(result.meanIC - result.meanBaselineMomentumIc)}`)
  }
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
  console.log('--- Multi-horizon OUT-OF-FOLD IC + conformal offsets ---')
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
  for (const regime of ['low-vol', 'high-vol', 'unknown'] as const) {
    const bucket = regimeBreakdown[regime]
    if (regime === 'unknown' && bucket.steps === 0) continue
    console.log(
      `  ${regime.padEnd(9)} steps=${bucket.steps}  IC ${f(bucket.meanIC)}  hit ${f(bucket.meanHitRate * 100, 1)}%  L/S net ${f(bucket.meanLongShortReturnNet, 2)}%`,
    )
  }

  // === Selection-inflation audit: how much of the headline is real? ===
  console.log('')
  console.log('--- Selection-inflation audit (Harvey-Liu-Zhu 2016 FDR; Bailey-López de Prado 2014 DSR) ---')
  const fdr = featureSelectionFDR(built.samples, HISTORICAL_FEATURE_NAMES, 0.1)
  const survivors = fdr.perFeature.filter((p) => p.significant).map((p) => p.name)
  const keptFailing = PRUNED_FEATURE_NAMES.filter((n) => !survivors.includes(n))
  const newSignificant = survivors.filter((n) => !PRUNED_FEATURE_NAMES.includes(n))
  console.log(
    `FDR feature screen (q=${fdr.q}): ${fdr.significantCount}/${HISTORICAL_FEATURE_NAMES.length} features clear multiple-testing control.`,
  )
  console.log(
    `  current ${PRUNED_FEATURE_NAMES.length}-feature keeper set: ${PRUNED_FEATURE_NAMES.length - keptFailing.length} survive, ${keptFailing.length} FAIL FDR` +
      (keptFailing.length ? ` [${keptFailing.join(', ')}]` : ''),
  )
  if (newSignificant.length) {
    console.log(`  significant but NOT kept (possible dropped signal): ${newSignificant.join(', ')}`)
  }
  const fdrRanked = [...fdr.perFeature].sort((a, b) => Math.abs(b.meanIC) - Math.abs(a.meanIC)).slice(0, 12)
  console.log('  top features by |IC|:   feature              meanIC    p-val   FDR')
  for (const p of fdrRanked) {
    console.log(`    ${p.name.padEnd(22)} ${f(p.meanIC).padStart(7)}  ${f(p.pValue).padStart(6)}   ${p.significant ? 'YES' : 'no'}`)
  }
  // Deflated Sharpe Ratio of the L/S strategy (per-step return series).
  const stepRets = result.steps.map((s) => s.longShortReturnNet)
  const srMean = stepRets.reduce((s, v) => s + v, 0) / stepRets.length
  const srStd = Math.sqrt(stepRets.reduce((s, v) => s + (v - srMean) ** 2, 0) / stepRets.length)
  const srHat = srStd > 0 ? srMean / srStd : 0
  const skew = sampleSkewness(stepRets)
  const exKurt = sampleExcessKurtosis(stepRets)
  const sfSharpes = singleFeatureSharpes(built.samples, HISTORICAL_FEATURE_NAMES)
  const sfMean = sfSharpes.reduce((s, v) => s + v, 0) / Math.max(1, sfSharpes.length)
  const varSr = sfSharpes.length > 1 ? sfSharpes.reduce((s, v) => s + (v - sfMean) ** 2, 0) / sfSharpes.length : 0.01
  const nFeat = HISTORICAL_FEATURE_NAMES.length
  console.log('')
  console.log(
    `Deflated Sharpe Ratio (per-step SR=${f(srHat, 3)}, n=${stepRets.length}, skew=${f(skew, 2)}, exKurt=${f(exKurt, 2)}, Var(SR_trials)=${f(varSr, 4)}):`,
  )
  for (const nTrials of [6, nFeat, nFeat + 6]) {
    const { sr0, psr0, dsr } = deflatedSharpeRatio({ srHat, n: stepRets.length, skew, exKurt, nTrials, varSrAcrossTrials: varSr })
    console.log(
      `  N=${String(nTrials).padStart(3)} trials -> max-SR0=${f(sr0, 3)}  PSR(0)=${f(psr0 * 100, 1)}%  DSR=${f(dsr * 100, 1)}%`,
    )
  }
  console.log('  (PSR(0)=P(true Sharpe>0); DSR=P(Sharpe beats the best-of-N-trials null). DSR>95% ⇒ robust to selection.)')

  // === Calibration + sizing audit ===
  const cs = calibrationAndSizingAudit(result.steps, 20)
  if (cs) {
    console.log('')
    console.log('--- Calibration + sizing audit (isotonic P(outperform); conviction vs equal-weight) ---')
    console.log(
      `Base rate P(outperform): ${f(cs.baseRate * 100, 1)}%  ·  Brier (held-out ${cs.evalN}): calibrated ${f(cs.brierCalibrated, 4)} vs base-rate ${f(cs.brierBaseRate, 4)} (lower = better)`,
    )
    console.log('  reliability  (calibrated prob bin → realized win rate):')
    for (const b of cs.reliability) {
      console.log(`    P≈${f(b.binMeanProb * 100, 1)}%  →  won ${f(b.winRate * 100, 1)}%   (n=${b.n})`)
    }
    console.log(
      `Sizing A/B (ann. Sharpe): equal-weight quintile ${f(cs.equalWeightSharpe, 2)}  vs  conviction-weighted ${f(cs.convictionWeightedSharpe, 2)}` +
        `  (per-20d mean ${f(cs.equalWeightMeanPct, 2)}% vs ${f(cs.convictionWeightedMeanPct, 2)}%)`,
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
    const regimeTag = label
      ? `${label.regime === 'high-vol' ? 'HIGH' : label.regime === 'unknown' ? '??? ' : 'low '} p=${f(label.highProb, 2)}`
      : ''
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
      servingConsistentIC20d: result.servingConsistentIC20d,
      meanLongShortReturnNet: result.meanLongShortReturnNet,
      meanLongShortSharpe: result.meanLongShortSharpe,
      hyperparameters: result.hyperparameters,
    }
    const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
    const json = JSON.stringify(payload)
    // Always write a local fallback first, so a transient PUT drop
    // (ECONNRESET on the multi-hundred-KB upload) never wastes the whole
    // retrain — the file can be PUT to /ml/model separately.
    const fs = await import('node:fs/promises')
    await fs.writeFile('tools/ml_trained_model.json', json)
    let persisted = false
    for (let attempt = 0; attempt < 4 && !persisted; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500))
      try {
        const response = await fetch(`${base}/ml/model`, {
          method: 'PUT',
          // X-Oracle-Write gates model writes (CSRF-proof via CORS preflight
          // for browsers; native callers like this CLI just send it).
          headers: { 'Content-Type': 'application/json', 'X-Oracle-Write': '1' },
          body: json,
        })
        const body = (await response.json()) as { ok?: boolean; bytes?: number; detail?: string }
        if (response.ok && body.ok) {
          console.log(
            `\nPersisted trained bundle to backend /ml/model (${((body.bytes ?? 0) / 1024).toFixed(0)} KB) — app instances adopt it on next boot.`,
          )
          persisted = true
        }
      } catch {
        /* transient — retry */
      }
    }
    if (!persisted) {
      console.error(
        `\nPersist to backend FAILED after retries — model saved to tools/ml_trained_model.json; PUT it to ${base}/ml/model manually.`,
      )
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
