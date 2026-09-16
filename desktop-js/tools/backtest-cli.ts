/**
 * The pre-registered walk-forward runner (docs/EVIDENCE_QUALITY.md).
 *
 * Runs the same pipeline as the in-app BacktestPanel (dataset build, purged
 * and embargoed walk-forward, multi-horizon quantile ensemble) headless, so
 * the evidence can be produced, checkpointed and inspected without the UI.
 *
 * Build + run (from desktop-js/):
 *   npx esbuild tools/backtest-cli.ts --bundle --platform=node --format=esm \
 *     --define:import.meta.env='{}' --outfile=tools/backtest-cli.mjs
 *   node --max-old-space-size=17408 tools/backtest-cli.mjs --checkpoint <dir>
 *
 * Memory: the in-process bar cache (marketData.ts) keeps every name's
 * 40-year history for the life of the process, the dataset holds every row
 * twice (the 51-column build plus the pruned copy), and every scored window
 * keeps its per-row detail. Nothing is released, so the need grows with the
 * number of names. Two smoke runs on 2026-09-16 (40 years, 359 windows,
 * price-only columns) peaked at 355 MB for 15 names and 446 MB for 25, which
 * is about 219 MB fixed plus 9.1 MB per name. That line covers the WINDOW
 * LOOP only, the one phase the CLI sampled: the 200-name smoke the same day
 * projected 2,039 MB on it and the CLI saw 1,741 MB, but the operating
 * system's peak working set for the process was 2,864 MB, reached after the
 * loop (served-model training, regime labelling, gate report), which was
 * never sampled. 2,864 / 2,039 = 1.40, so the projection is the loop line
 * times 1.4 (POST_LOOP_MEMORY_FACTOR in tools/preregistered-run.ts). For
 * the 1,023 names the two ledgers leave fetchable (1,073 registered minus
 * 50 excluded) the loop line gives about 9,528 MB, times 1.4 about
 * 13,339 MB, and with a quarter of headroom rounded up to the next whole
 * gigabyte the flag to pass is
 *   --max-old-space-size=17408
 * Node's default ceiling is 2-4 GB, so the full run dies with "heap out of
 * memory" without it. The run prints the machine's total and FREE memory,
 * the ceiling it actually got, the projection for the universe it was
 * given, and the exact flag to use, and ABORTS at start (a) when the
 * projection is above the ceiling, because V8 slows sharply near its
 * ceiling and a run of several hours can still die part-way through, and
 * (b) when free memory is below the recommended heap, naming the shortfall,
 * because the flag only raises node's own limit and a run that pages to
 * disk for hours is no better than one that dies; --allow-low-heap runs
 * anyway in either case. The post-loop phase is now sampled too (after the
 * served models, the regime step and the report) and both peaks are
 * printed and recorded, so the 1.4 can be replaced by a measurement.
 *
 * Nothing may go missing quietly. Before any data is fetched the runner asks
 * the backend's /health once and stops at once if it is down. A name whose
 * price history cannot be fetched after four attempts, a name whose SEC
 * fundamentals request fails (as opposed to the backend saying the name files
 * nothing), and missing SPY history for the regime table each stop the run
 * with the names printed, unless --allow-missing is given, in which case the
 * run proceeds and the artifact's provenance lists what was dropped. So does
 * a STUB: Yahoo answers HTTP 200 for some departed names with a series that
 * is not their history (one bar, or a series that starts on 2026-07-17, or
 * only a re-listed security's bars). The warm-up flags a registered name
 * whose series starts after 2025-01-01, and any name with fewer than a
 * year of bars on the full-history fetch, prints "STUB: <ticker> first bar
 * <date>, <n> bars", and treats it like a fetch failure (classifyStubSeries
 * in tools/preregistered-run.ts explains the two thresholds).
 *
 * Names Yahoo no longer serves are handled before that guard, from the two
 * ledgers beside DEFAULT_BACKTEST_TICKERS (resolved 2026-09-16; 66 names). A
 * name that left the market (EXCLUDED_UNFETCHABLE) is set aside before any
 * fetch and recorded in the artifact as "registered but excluded" with the
 * date and reason; a name that now trades under a new symbol
 * (TICKER_RENAMES) is fetched under the successor and kept under its own
 * symbol in the samples. Both outcomes are printed at start, and the
 * excluded share is reported with the survivorship diagnostics, because
 * those are companies that left the market during the window: the names
 * that remain are more survivor-biased, not less. A name in neither ledger
 * that still cannot be fetched is a real failure and stops the run as above.
 *
 * A symbol can also answer with the WRONG COMPANY: after the registered
 * company left the market Yahoo handed its symbol to another one whose own
 * chart is long enough to pass both stub rules (on 2026-09-16 PARA came
 * back as Banzai International and B as Barrick Mining). So the run is
 * pre-registered against an identity ledger, tools/registered_identity.json
 * (the SEC CIK and the Yahoo names and first-trade date of every fetchable
 * name on the snapshot date), and the warm-up compares each name's live SEC
 * CIK (one fetch of the SEC ticker map per run) and the meta block of the
 * chart it just fetched with that record. A different CIK, or with no CIK
 * on either side a first-trade date more than 30 days away or a name that
 * shares fewer than half its words, is printed as RECYCLED and stops the
 * run; --allow-missing does NOT apply, because a wrong company is not a
 * missing one. A new name under the same CIK is printed as an IDENTITY
 * NOTE and allowed. One line sums it up: "identity: N checked, N matched,
 * N renamed-in-place, N recycled" (checkIdentity in tools/preregistered-run.ts).
 *
 * With --checkpoint, the rename map, the excluded names with their dates and
 * reasons, the attrition sentence and (after the warm-up) the stub list and
 * the identity summary are written into <dir>/run.json before anything is
 * fetched, so an auditor can tell from the checkpoint alone which universe
 * the windows were scored on, even when --persist is later refused by a
 * blocking gate.
 *
 * Flags, with the pre-registered defaults (each is printed at start):
 *   --allow-missing                   OFF by default; see above (never covers a RECYCLED name)
 *   --allow-low-heap                  run even when the heap ceiling is below the projection
 *                                     or free memory is below the recommended heap
 *   --warm-only                       stop after the price warm-up (ledgers printed and recorded,
 *                                     stubs and fetch failures named); nothing is built or scored
 *   --range max                       bars per name (5y | 10y | 15y | max)
 *   --window-days 20                  trading days per test window
 *   --burn-in-years 10                training-only years before the first window
 *   --momentum-baseline 12-1          12-1 (skips the latest month) or 12-0
 *   --correlation pearson             pearson or spearman; what the gate reads
 *   --exclude-etfs                    ON by default; --include-etfs keeps the funds
 *   --features <comma list>           default: the price-only names in the pruned
 *                                     keeper set; --pruned = all 13 keepers; all = every column
 *   --freeze-hparams                  ON by default (50 trees, depth 3, rate 0.1);
 *                                     --search-hyperparameters re-enables the nested search
 *   --checkpoint <dir>                write every finished window to <dir>/windows.jsonl and
 *                                     resume from it; a crash loses at most one window
 *   --limit N                         train on the first N names (after the ETF exclusion)
 *   --tickers-file PATH               a JSON array of names instead of the default list
 *   --persist [--allow-advisory-persist]   save the artifact (fail-closed, see below)
 *   --fdr-q Q                         run the feature screen at a pre-registered q
 * There is no --selection-cutoff flag: the re-screen was cut from the design.
 *
 * Both momentum definitions and both correlations are always printed; the
 * two gate flags only choose which pair the promotion gate reads.
 *
 * Checkpointing runs the window loop from this file through the core's own
 * walkForwardStep (tools/preregistered-run.ts). The nested hyperparameter
 * search lives inside the core's single call and cannot be checkpointed, so
 * --search-hyperparameters and --checkpoint refuse to run together.
 *
 * Persistence is fail-closed. `--persist` writes only a promotable model.
 * Research artifacts that fail one or more gates require BOTH `--persist`
 * and the explicit `--allow-advisory-persist` override; their metadata stays
 * marked advisory-only.
 *
 * Requires the backend cache server on port 8787 (it proxies Yahoo).
 */

// The browser modules use window.setTimeout/clearTimeout; in Node those
// live on globalThis with compatible signatures.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const {
    DEFAULT_BACKTEST_TICKERS,
    FROZEN_HYPERPARAMETERS,
    HISTORICAL_FEATURE_NAMES,
    PRUNED_FEATURE_NAMES,
    analyzeSurvivorship,
    assessModelPromotion,
    buildCalendarWindows,
    buildHistoricalDataset,
    calibrationAndSizingAudit,
    computeBaselineEvidence,
    computeFeatureStats,
    featureSelectionFDR,
    fetchFundamentalsTimeline,
    fundamentalsFetchFailures,
    fundamentalsFetchOutcome,
    indexSamples,
    labelStepsByRegime,
    planUniverseFetch,
    pruneSampleFeatures,
    resolveWindowRule,
    runWalkForwardBacktest,
    singleFeatureSharpes,
    summarizeCalendarWindows,
    summarizeStepsByRegime,
  } = await import('../src/data/historicalBacktest')
  type FullBacktestResult = import('../src/data/historicalBacktest').FullBacktestResult
  type BaselineComparisonEvidence = import('../src/data/historicalBacktest').BaselineComparisonEvidence
  const { cachedFetchDailyBars } = await import('../src/data/marketData')
  const { sampleSkewness, sampleExcessKurtosis } = await import('../src/data/quantMath')
  const { createServingEnsembleAudit } = await import('../src/data/mlModelService')
  const { deflatedSharpeRatio } = await import('../src/data/selectionStats')
  const pre = await import('./preregistered-run')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { getHeapStatistics } = await import('node:v8')
  const { freemem, totalmem } = await import('node:os')

  /* ------------------------------------------------------------------ */
  /* Flags                                                               */
  /* ------------------------------------------------------------------ */
  const args = process.argv.slice(2)
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const hasFlag = (name: string): boolean => args.includes(name)
  const refuse = (message: string): never => {
    console.error(message)
    process.exit(2)
  }

  if (hasFlag('--selection-cutoff')) {
    refuse('--selection-cutoff is not a flag of this runner: the re-screen was cut from the pre-registered design.')
  }

  const persist = hasFlag('--persist')
  const allowAdvisoryPersist = hasFlag('--allow-advisory-persist')
  if (allowAdvisoryPersist && !persist) refuse('--allow-advisory-persist is valid only together with --persist.')

  // Nothing goes missing quietly. Without this flag a lost price history, a
  // failed fundamentals request or missing SPY history stops the run with
  // the names printed; with it the run proceeds and records what it lost.
  const allowMissing = hasFlag('--allow-missing')
  // The memory guard below aborts when the ceiling is under the projection
  // or free memory is under the recommended heap; this flag runs anyway (a
  // deliberate small-heap experiment, or a warm-up-only pass, say).
  const allowLowHeap = hasFlag('--allow-low-heap')
  // Stop after the price warm-up: the ledgers are printed and recorded and
  // every stub or fetch failure is named, and nothing is built or scored.
  const warmOnly = hasFlag('--warm-only')
  // A data failure is a different exit code from a bad flag (2), so a
  // wrapper script can tell "fix the command line" from "fix the backend".
  const abortRun = (headline: string, lines: string[] = []): never => {
    console.error('')
    console.error(`ABORTED: ${headline}`)
    for (const line of lines) console.error(`  ${line}`)
    if (!allowMissing) console.error('  Pass --allow-missing to proceed anyway; the artifact will record what was dropped.')
    process.exit(1)
  }
  const backendBase = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'

  const fdrQRaw = flagValue('--fdr-q')
  const fdrQ = fdrQRaw != null ? Number(fdrQRaw) : null
  if (fdrQ != null && (!Number.isFinite(fdrQ) || fdrQ <= 0 || fdrQ >= 1)) {
    refuse('--fdr-q must be an explicitly pre-registered value between 0 and 1.')
  }

  const rangeArg = flagValue('--range') ?? 'max'
  if (!['5y', '10y', '15y', 'max'].includes(rangeArg)) refuse('--range must be 5y, 10y, 15y or max.')
  const range = rangeArg as '5y' | '10y' | '15y' | 'max'

  // Test windows are cut on the trading calendar (buildCalendarWindows):
  // --window-days trading days per window after a --burn-in-years
  // training-only burn-in, embargo counted in trading days. Nothing here
  // depends on the row count, so widening the universe adds names to each
  // window and never changes the window count. The in-app worker uses the
  // same rule and the same defaults (DEFAULT_WINDOW_RULE).
  const windowDaysArg = flagValue('--window-days')
  const burnInYearsArg = flagValue('--burn-in-years')
  const windowRule = resolveWindowRule({
    stepTradingDays: windowDaysArg != null ? Number(windowDaysArg) : undefined,
    burnInYears: burnInYearsArg != null ? Number(burnInYearsArg) : undefined,
  })

  // Gate yardsticks (docs/EVIDENCE_QUALITY.md, section 4). Both momentum
  // definitions and both correlations are always reported; the flags only
  // pick which pair the gate reads, and a value outside the two choices is
  // refused rather than silently defaulted.
  const momentumBaselineArg = flagValue('--momentum-baseline') ?? '12-1'
  if (momentumBaselineArg !== '12-1' && momentumBaselineArg !== '12-0') refuse('--momentum-baseline must be 12-1 or 12-0.')
  const momentumBaseline = momentumBaselineArg as '12-1' | '12-0'
  const correlationArg = flagValue('--correlation') ?? 'pearson'
  if (correlationArg !== 'pearson' && correlationArg !== 'spearman') refuse('--correlation must be pearson or spearman.')
  const correlation = correlationArg as 'pearson' | 'spearman'

  // Funds are out of the scored cross-section unless the owner keeps them.
  const excludeEtfs = !hasFlag('--include-etfs')

  // Tree settings are frozen at the pre-registered values unless the nested
  // search is asked for by name.
  const freezeHparams = !(hasFlag('--search-hyperparameters') || hasFlag('--no-freeze-hparams'))

  // Feature set: price-only keepers by default, every keeper with --pruned,
  // a named list with --features a,b,c, or every column with --features all.
  const featuresArg = flagValue('--features')
  let featureNames: string[]
  let featureChoice: string
  if (featuresArg != null && featuresArg.trim().toLowerCase() === 'all') {
    featureNames = [...HISTORICAL_FEATURE_NAMES]
    featureChoice = '--features all (every column)'
  } else if (featuresArg != null) {
    featureNames = featuresArg.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    const unknown = featureNames.filter((name) => !HISTORICAL_FEATURE_NAMES.includes(name))
    if (unknown.length > 0) refuse(`--features names not in HISTORICAL_FEATURE_NAMES: ${unknown.join(', ')}`)
    if (new Set(featureNames).size !== featureNames.length) refuse('--features lists a name twice.')
    featureChoice = '--features (caller-supplied list)'
  } else if (hasFlag('--pruned')) {
    featureNames = [...PRUNED_FEATURE_NAMES]
    featureChoice = '--pruned (every FDR keeper, fundamentals included)'
  } else {
    featureNames = PRUNED_FEATURE_NAMES.filter((name) => !name.startsWith('fund_'))
    featureChoice = 'default (price-only FDR keepers)'
  }
  const usesEveryColumn = featureNames.length === HISTORICAL_FEATURE_NAMES.length && featureNames.every((name, i) => name === HISTORICAL_FEATURE_NAMES[i])

  const checkpointArg = flagValue('--checkpoint')
  const checkpointDir = checkpointArg != null ? resolve(checkpointArg) : null
  if (checkpointDir != null && !freezeHparams) {
    refuse('--checkpoint cannot be combined with --search-hyperparameters: the nested search runs inside one core call and cannot be resumed window by window.')
  }

  // --tickers-file PATH: train on a custom JSON array of tickers instead of
  // DEFAULT_BACKTEST_TICKERS (used for size-segment experiments).
  const tickersFile = flagValue('--tickers-file')
  let baseTickers: readonly string[] = DEFAULT_BACKTEST_TICKERS
  if (tickersFile != null) {
    const { readFileSync } = await import('node:fs')
    const parsed: unknown = JSON.parse(readFileSync(tickersFile, 'utf-8'))
    if (!Array.isArray(parsed) || !parsed.every((ticker) => typeof ticker === 'string')) {
      refuse('--tickers-file must contain a JSON array of ticker strings.')
    }
    baseTickers = parsed as string[]
  }
  // --limit N: the first N names, counted after the ETF exclusion, so
  // "--limit 25" always means 25 scored companies.
  const limitArg = flagValue('--limit')
  const limit = limitArg != null ? Number(limitArg) : 0

  /* ------------------------------------------------------------------ */
  /* Universe: take the funds out                                        */
  /* ------------------------------------------------------------------ */
  // The isEtf flag lives in the Dart universe files two directories up
  // (lib/src/data). When they are present the CLI reads the flag from them;
  // otherwise it falls back to the two fund blocks in the default list.
  const dartDataDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'src', 'data')
  const etfUniverse = pre.resolveEtfUniverse(dartDataDir)
  const afterEtfs = excludeEtfs ? baseTickers.filter((ticker) => !etfUniverse.symbols.has(ticker)) : [...baseTickers]
  const etfsExcluded = baseTickers.length - afterEtfs.length

  /* ------------------------------------------------------------------ */
  /* Universe: names Yahoo no longer serves                              */
  /* ------------------------------------------------------------------ */
  // The two ledgers beside DEFAULT_BACKTEST_TICKERS say which registered
  // names left the market (set aside before any fetch, so the fail-loud
  // guard below does not fire on a name whose fate is already known) and
  // which now trade under a new symbol (fetched under the successor, kept
  // under their own symbol in the samples). The dataset builder applies the
  // same plan again on the registered list; the CLI plans here so it can
  // print the outcome first and warm only the names that will be fetched.
  //
  // --limit N keeps the first N names that will actually be fetched, so
  // "--limit 25" still means 25 scored companies. The registered universe
  // of the run is then the prefix of the list those N names sit in, which
  // keeps any excluded names inside that prefix on the record.
  // Both lists are narrowed after the warm-up when --allow-missing lets a
  // stub through: a stub must never reach the build (a re-listed security
  // with enough bars would enter the dataset as a short-history name).
  let registeredTickers = pre.registeredPrefixForLimit(afterEtfs, limit)
  const plan = planUniverseFetch(registeredTickers)
  // The names that are fetched and scored; each sample carries one of these.
  let tickers = plan.fetch.map((entry) => entry.ticker)
  const fetchSymbolByTicker = new Map(plan.fetch.map((entry) => [entry.ticker, entry.fetchedAs]))
  const fetchSymbolOf = (ticker: string): string => fetchSymbolByTicker.get(ticker) ?? ticker
  const hyperparameters = { ...FROZEN_HYPERPARAMETERS }

  /* ------------------------------------------------------------------ */
  /* The identity ledger: which company each name is                     */
  /* ------------------------------------------------------------------ */
  // Read before anything else happens, so a missing or malformed ledger
  // stops the run here, with nothing fetched. The check itself runs at the
  // warm-up, name by name, against the SEC map fetched once below.
  const identityPath = pre.registeredIdentityPath()
  let identityLedger: import('./preregistered-run').RegisteredIdentityLedger
  try {
    identityLedger = pre.readRegisteredIdentityLedger(identityPath)
  } catch (error) {
    refuse((error as Error).message)
  }
  const identityOf = pre.identityByTicker(identityLedger!)
  // The hash pins which version of the ledger this run was checked against.
  const identitySha256 = pre.hashRegisteredIdentityLedger(identityPath)

  /* ------------------------------------------------------------------ */
  /* Print every setting before anything runs                            */
  /* ------------------------------------------------------------------ */
  const heapLimitMb = Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024)
  console.log('=== PRE-REGISTERED RUN SETTINGS ===')
  console.log(`  --range              ${range}${rangeArg === (flagValue('--range') ?? '') ? '' : '  (default)'}`)
  console.log(`  --window-days        ${windowRule.stepTradingDays} trading days${windowDaysArg == null ? '  (default)' : ''}`)
  console.log(`  --burn-in-years      ${windowRule.burnInYears}${burnInYearsArg == null ? '  (default)' : ''}`)
  console.log(`  embargo              ${windowRule.embargoTradingDays} trading days (DEFAULT_WINDOW_RULE)`)
  console.log(`  --momentum-baseline  ${momentumBaseline}${flagValue('--momentum-baseline') == null ? '  (default)' : ''}`)
  console.log(`  --correlation        ${correlation}${flagValue('--correlation') == null ? '  (default)' : ''}`)
  console.log(`  --exclude-etfs       ${excludeEtfs ? 'ON' : 'OFF (--include-etfs)'}${hasFlag('--include-etfs') || hasFlag('--exclude-etfs') ? '' : '  (default)'}`)
  console.log(
    `       ETF list source: ${etfUniverse.source === 'dart-universe-isEtf-flag' ? `isEtf flag in ${dartDataDir} (${etfUniverse.dartFlaggedCount} names flagged; ${etfUniverse.blockCount} in the default fund blocks` : `fallback: the two fund blocks inside DEFAULT_BACKTEST_TICKERS (${etfUniverse.blockCount} names; Dart universe files not found at ${dartDataDir}`}` +
      (etfUniverse.disagreements.length ? `; DISAGREE on ${etfUniverse.disagreements.join(', ')})` : '; the two sources agree)'),
  )
  console.log(`  --freeze-hparams     ${freezeHparams ? `ON: ${hyperparameters.numTrees} trees / depth ${hyperparameters.depth} / rate ${hyperparameters.learningRate} (FROZEN_HYPERPARAMETERS)` : 'OFF (--search-hyperparameters): nested search picks them'}${hasFlag('--search-hyperparameters') || hasFlag('--no-freeze-hparams') || hasFlag('--freeze-hparams') ? '' : '  (default)'}`)
  console.log(`  --features           ${featureChoice}: ${featureNames.length} of ${HISTORICAL_FEATURE_NAMES.length}`)
  console.log(`       ${featureNames.join(', ')}`)
  console.log(`  --checkpoint         ${checkpointDir ?? 'none (nothing written; a crash loses the run)'}`)
  console.log(`  --limit              ${limit > 0 ? limit : 'none'}`)
  console.log(`  --tickers-file       ${tickersFile ?? 'none (DEFAULT_BACKTEST_TICKERS)'}`)
  console.log(`  --persist            ${persist ? (allowAdvisoryPersist ? 'yes, advisory override allowed' : 'yes, promotable only') : 'no'}`)
  console.log(`  --fdr-q              ${fdrQ ?? 'none (feature screen skipped)'}`)
  console.log(`  --allow-missing      ${allowMissing ? 'ON: lost names, stubs, failed fundamentals requests and missing SPY history are recorded, not fatal' : 'OFF (default): any of those stops the run before the walk-forward'}`)
  console.log(`  --allow-low-heap     ${allowLowHeap ? 'ON: a heap ceiling below the projection, or free memory below the recommended heap, is a warning' : 'OFF (default): a heap ceiling below the projection, or free memory below the recommended heap, stops the run at start'}`)
  console.log(`  --warm-only          ${warmOnly ? 'ON: stop after the price warm-up' : 'OFF (default)'}`)
  console.log(`  identity ledger      ${identityPath} (${identityLedger!.counts.entries} entries, ${identityLedger!.counts.withCik} with a CIK, snapshot ${identityLedger!.snapshotDate}, sha256 ${identitySha256.slice(0, 12)}...)`)
  console.log(
    `  universe             ${baseTickers.length} names -> ${etfsExcluded} ETFs ${excludeEtfs ? 'excluded' : 'kept'} -> ${afterEtfs.length} registered` +
      (limit > 0 ? ` -> first ${registeredTickers.length} (the prefix holding the first ${tickers.length} fetchable names, --limit)` : '') +
      ` -> ${plan.excluded.length} registered but excluded -> ${tickers.length} fetched and scored`,
  )
  // The ledgers' outcome, printed before anything is fetched so a reader
  // sees the universe the run really works on. A name in neither ledger
  // that still cannot be fetched is a real failure and stops the run below.
  console.log(
    `  ${plan.excluded.length} names registered but excluded (delisted/unresolved)${plan.excluded.length ? ': ' : ''}` +
      plan.excluded.map((entry) => `${entry.ticker} (${entry.delistingDate ? `delisted ${entry.delistingDate}, ` : ''}${entry.reason}${entry.recycledBy ? `; symbol now ${entry.recycledBy}` : ''})`).join('; '),
  )
  console.log(
    `  ${plan.renamed.length} names fetched under a successor symbol (ticker renames; the sample keeps the original symbol)${plan.renamed.length ? ': ' : ''}` +
      plan.renamed.map((entry) => `${entry.original} -> ${entry.fetchedAs}`).join(', '),
  )
  console.log(`  ${plan.attrition.statement}`)
  // Memory: the smoke-measured loop line (fixed cost plus a cost per name),
  // extended to this universe and multiplied by the post-loop factor,
  // against the ceiling node actually gave us and the memory the machine
  // actually has free. Both readings are printed so a reader can tell "the
  // flag was too small" from "the machine was full".
  const totalMemoryMb = Math.round(totalmem() / 1024 / 1024)
  const freeMemoryMb = Math.round(freemem() / 1024 / 1024)
  const heap = pre.projectHeapNeed(tickers.length, heapLimitMb, freeMemoryMb)
  console.log(`  node heap ceiling    ${heapLimitMb} MB (this process)`)
  console.log(`  machine memory       ${totalMemoryMb} MB total, ${freeMemoryMb} MB free right now (os.totalmem / os.freemem)`)
  console.log(
    `  projected need       ${heap.projectedMb} MB for ${tickers.length} names = (${heap.baseMb.toFixed(1)} MB fixed + ${tickers.length} x ${heap.perNameMb.toFixed(1)} MB per name = ${heap.loopProjectedMb} MB for the window loop) x ${heap.postLoopFactor} for the post-loop phase`,
  )
  console.log(
    `                       loop line through the 2026-09-16 smokes: ${pre.SMOKE_MEMORY_POINTS.map((point) => `${point.names} names -> ${point.peakRssMb} MB peak`).join(', ')}; ` +
      `x${heap.postLoopFactor} from the ${pre.POST_LOOP_MEMORY_POINT.names}-name smoke, whose loop line projected ${pre.POST_LOOP_MEMORY_POINT.loopProjectedMb} MB, ` +
      `whose per-window sampling peaked at ${pre.POST_LOOP_MEMORY_POINT.cliSampledPeakRssMb} MB, and whose OS-level peak working set was ${pre.POST_LOOP_MEMORY_POINT.osPeakWorkingSetMb} MB ` +
      '(served-model training, regime labelling and the gate report were never sampled)',
  )
  console.log(`  node flag to use     node ${heap.flag} tools/backtest-cli.mjs ...  (projection plus a quarter, rounded up to the next whole GB)`)
  const memoryVerdict = pre.memoryGuardVerdict(heap, allowLowHeap)
  if (memoryVerdict.problems.length > 0) {
    console.log('')
    for (let i = 0; i < memoryVerdict.problems.length; i++) {
      console.log(`  !!! ${memoryVerdict.problems[i]}`)
      console.log(`  !!! ${memoryVerdict.advice[i]}`)
    }
    if (heap.exceedsCeiling) {
      console.log(`  !!! The run would most likely die with "heap out of memory" part-way through. Start it as:  node ${heap.flag} tools/backtest-cli.mjs ${args.filter((arg) => arg !== '--allow-low-heap').join(' ')}`)
    }
    if (heap.recommendedMb > totalMemoryMb) {
      console.log(`  !!! The recommended heap is more than this machine's ${totalMemoryMb} MB of memory in all; use --limit or a machine with more memory.`)
    }
    if (memoryVerdict.abort) {
      console.error('')
      console.error(`ABORTED: ${memoryVerdict.problems.join('; ')}.`)
      for (const line of memoryVerdict.advice) console.error(`  ${line}`)
      console.error('  Or pass --allow-low-heap to run anyway. Nothing was fetched and nothing was written.')
      process.exit(2)
    }
    console.log('  !!! proceeding anyway (--allow-low-heap)')
    console.log('')
  }
  console.log('')

  /* ------------------------------------------------------------------ */
  /* One health probe before anything is fetched                         */
  /* ------------------------------------------------------------------ */
  // Every fetch below waits out its own timeout when the backend is down,
  // and with four attempts per name that is more than an hour of silence
  // for the full universe. One request to /health answers at once.
  const health = await pre.probeBackendHealth(backendBase, { timeoutMs: 5000 })
  if (!health.ok) {
    console.error('')
    console.error(`ABORTED: the backend on ${backendBase} is not answering (${health.detail}).`)
    console.error("  Start it from the repository root with: dart run tool/backend_cache_server.dart --port 8787 --web-root build/web")
    console.error('  Nothing was fetched and nothing was written.')
    process.exit(1)
  }
  console.log(`Backend: ${health.detail}`)

  /* ------------------------------------------------------------------ */
  /* One fetch of the SEC ticker map, for the identity check             */
  /* ------------------------------------------------------------------ */
  // The map says which registrant (CIK) holds each symbol today. It is the
  // decisive half of the identity check (a different CIK is a different
  // company), so a run that cannot get it stops, unless --allow-missing,
  // in which case the Yahoo meta alone decides and the run says so.
  const secMap = await pre.fetchSecTickerMap({ base: backendBase })
  if (secMap == null) {
    if (!allowMissing) {
      abortRun(`the SEC ticker map (${pre.SEC_COMPANY_TICKERS_URL}) could not be fetched through the proxy, so the identity check has no CIKs to compare.`, [
        'Check the backend log (the proxy adds the User-Agent the SEC requires), then start the run again.',
      ])
    }
    console.warn('  WARNING: no SEC ticker map; the identity check falls back to the Yahoo names and first-trade dates alone (--allow-missing).')
  } else {
    console.log(`SEC ticker map: ${secMap.size} symbols (one fetch per run, through the proxy)`)
  }

  /* ------------------------------------------------------------------ */
  /* The universe record in the checkpoint                               */
  /* ------------------------------------------------------------------ */
  // Written now, before anything is fetched, and again after the warm-up
  // with the stubs and the identity summary filled in, so the checkpoint
  // alone says which names were set aside, renamed, found to be stubs or
  // found to be another company, even when --persist is later refused by
  // a blocking gate.
  const universeRecord = (
    stubs: import('./preregistered-run').StubSeries[],
    identity?: import('./preregistered-run').CheckpointUniverseRecord['identity'],
  ): import('./preregistered-run').CheckpointUniverseRecord => ({
    recordedAt: new Date().toISOString(),
    registered: [...plan.registered],
    renames: plan.renamed.map((entry) => ({ ...entry })),
    excluded: plan.excluded.map(({ ticker, delistingDate, reason, evidence, recycledBy }) => ({ ticker, delistingDate, reason, evidence, ...(recycledBy != null ? { recycledBy } : {}) })),
    stubs: stubs.map((stub) => ({ ...stub })),
    attrition: { ...plan.attrition },
    ...(identity != null ? { identity } : {}),
  })
  if (checkpointDir != null) {
    pre.recordUniverseInCheckpoint(checkpointDir, universeRecord([]))
    console.log(
      `Checkpoint ${checkpointDir}: universe record written to run.json (${plan.registered.length} registered, ${plan.renamed.length} renames, ` +
        `${plan.excluded.length} excluded names with dates and reasons, the attrition sentence); the stub list is added after the warm-up.`,
    )
  }

  /* ------------------------------------------------------------------ */
  /* Dataset                                                             */
  /* ------------------------------------------------------------------ */
  // Fetch every name's full history first, with bounded retries, so a
  // proxy that is still warming up cannot silently drop names from the
  // universe. The builder fetches once and moves on when a fetch fails, and
  // a universe that differs between two runs makes a checkpoint unusable.
  const started = Date.now()
  const heapUsedAtStartMb = process.memoryUsage().heapUsed / 1024 / 1024
  console.log(`Warming price history for ${tickers.length} tickers (max bars via proxy, up to 4 attempts each; a stub is named as it is found)...`)
  // The listing-floor stub rule applies to registered names only; a
  // caller-supplied list may hold a genuinely young listing, which the
  // bar-count rule still catches.
  const registeredSet = new Set<string>(DEFAULT_BACKTEST_TICKERS)
  // The identity check rides along with each fetch: once a name's bars are
  // in, the chart's meta block is read from the same URL (the proxy still
  // holds it) and compared with the identity ledger and the SEC map. A
  // stub is not checked (it is already set apart); a name whose fetch
  // failed has nothing to compare.
  const identityChecks: import('./preregistered-run').IdentityCheck[] = []
  const identityLines: string[] = []
  const metaByTicker = new Map<string, import('./preregistered-run').YahooChartMeta | null>()
  const warm = await pre.warmDailyBars(tickers, (ticker) => cachedFetchDailyBars(fetchSymbolOf(ticker), 'max'), {
    attempts: 4,
    pauseMs: 1500,
    onProgress: (done, total, ticker) => {
      if (done % 25 === 0) console.log(`  ${done}/${total} ${ticker}`)
    },
    stubCheck: (ticker, bars) => pre.classifyStubSeries(ticker, bars, { registered: registeredSet.has(ticker), maxRange: true }),
    onStub: (stub) => console.log(`  ${stub.line}`),
    onUsable: async (ticker) => {
      const fetchSymbol = fetchSymbolOf(ticker)
      let meta: import('./preregistered-run').YahooChartMeta | null = null
      for (let attempt = 0; attempt < 3 && meta == null; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
        meta = await pre.fetchYahooChartMeta(fetchSymbol, { base: backendBase })
      }
      metaByTicker.set(ticker, meta)
      const sec = secMap?.get(pre.normalizeSecSymbol(fetchSymbol)) ?? null
      const check = pre.checkIdentity(ticker, fetchSymbol, identityOf.get(ticker), { cik: sec?.cik ?? null, secName: sec?.name ?? null, meta })
      identityChecks.push(check)
      if (check.line != null) {
        identityLines.push(check.line)
        console.log(`  ${check.line}`)
      }
    },
  })
  console.log(
    `  warmed ${warm.usable.length}/${tickers.length} · ${warm.retries} retr${warm.retries === 1 ? 'y' : 'ies'} · ` +
      `${warm.failed.length ? `still no bars after 4 attempts: ${warm.failed.join(', ')}` : 'no fetch failures'} · ` +
      `${warm.stubs.length ? `${warm.stubs.length} stub${warm.stubs.length === 1 ? '' : 's'}: ${warm.stubs.map((stub) => stub.ticker).join(', ')}` : 'no stubs'} · ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s`,
  )
  const identity = pre.summarizeIdentityChecks(identityChecks)
  console.log(`  ${identity.line} (against ${identityPath}, snapshot ${identityLedger!.snapshotDate}${secMap == null ? '; no SEC map, Yahoo meta only' : ''})`)
  const identityRecord: NonNullable<import('./preregistered-run').CheckpointUniverseRecord['identity']> = { snapshotDate: identityLedger!.snapshotDate, ledgerSha256: identitySha256, summary: identity.line, lines: [...identityLines] }
  if (checkpointDir != null) {
    pre.recordUniverseInCheckpoint(checkpointDir, universeRecord(warm.stubs, identityRecord))
    console.log(`Checkpoint ${checkpointDir}: universe record updated with the stub list (${warm.stubs.length}) and the identity summary.`)
  }
  // A name that came back as another company is a wrong answer, not a
  // missing one, so this stop cannot be waived: --allow-missing narrows a
  // run honestly, it does not let the wrong history in.
  const recycledChecks = identityChecks.filter((check) => check.status === 'recycled')
  if (recycledChecks.length > 0) {
    console.error('')
    console.error(`ABORTED: ${recycledChecks.length} of ${identity.checked} checked names came back as a DIFFERENT COMPANY from the one the run is registered against.`)
    for (const check of recycledChecks) console.error(`  ${check.line}`)
    console.error('  --allow-missing does not apply: a wrong company is not a missing one. Each name belongs in EXCLUDED_UNFETCHABLE with a recycledBy')
    console.error('  (src/data/historicalBacktest.ts) unless the SEC lists the new symbol under the same CIK, in which case it is a TICKER_RENAMES entry; then start the run again.')
    process.exit(1)
  }
  // A name whose company could not be checked (no CIK on either side and
  // no readable chart meta, a chart that answered under another symbol, a
  // name on one side only) is an unknown company, and an unknown company
  // is not missing data: --allow-missing narrows a run to the names it
  // could verify, it does not let an unverified one in. The run stops and
  // says which names, so each can be resolved on purpose (a ledger entry
  // with a reason, or a fixed record) and the run started again.
  const unverifiedChecks = identityChecks.filter((check) => check.status === 'unverified')
  if (unverifiedChecks.length > 0) {
    console.error('')
    console.error(`ABORTED: ${unverifiedChecks.length} of ${identity.checked} checked names could not be identity-checked; an unknown company is not a missing one.`)
    for (const check of unverifiedChecks) console.error(`  ${check.line ?? check.ticker}`)
    console.error('  --allow-missing does not apply. Resolve each name (an EXCLUDED_UNFETCHABLE entry with its reason, or a corrected identity ledger) and start the run again.')
    process.exit(1)
  }
  // Names that could not be fetched, and names that came back as a stub,
  // narrow the universe. That is fatal by default: a pre-registered run on
  // fewer names than it registered is a different run, and it must say so
  // instead of quietly going on.
  const stubTickers = warm.stubs.map((stub) => stub.ticker)
  const droppedNames = new Set<string>([...warm.failed, ...stubTickers])
  if (droppedNames.size > 0 && !allowMissing) {
    abortRun(
      `${droppedNames.size} of ${tickers.length} names could not be fetched after 4 attempts each or came back as a stub; the run would narrow silently.`,
      [
        ...(warm.failed.length ? [`no bars after 4 attempts: ${warm.failed.join(', ')}`] : []),
        ...warm.stubs.map((stub) => stub.line),
        'Check the backend log for the unfetched symbols. A stub belongs in EXCLUDED_UNFETCHABLE or TICKER_RENAMES (src/data/historicalBacktest.ts) with its evidence; then start the run again.',
      ],
    )
  }
  if (stubTickers.length > 0) {
    // A stub never reaches the build: with enough bars a re-listed security
    // would enter the dataset as a short-history name under the old symbol.
    const stubSet = new Set(stubTickers)
    registeredTickers = registeredTickers.filter((ticker) => !stubSet.has(ticker))
    tickers = tickers.filter((ticker) => !stubSet.has(ticker))
    console.warn(`  WARNING: proceeding without ${stubTickers.length} stub name${stubTickers.length === 1 ? '' : 's'} (--allow-missing): ${stubTickers.join(', ')}`)
  }
  if (warmOnly) {
    console.log('')
    console.log(
      `--warm-only: stopping after the price warm-up. ${warm.usable.length} of ${warm.usable.length + droppedNames.size} names usable · ` +
        `${warm.failed.length} unfetched · ${warm.stubs.length} stub${warm.stubs.length === 1 ? '' : 's'} · ${identity.line}` +
        (checkpointDir != null ? ` · the universe record (renames, exclusions, stubs, identity, attrition) is in ${checkpointDir}/run.json` : '') +
        '. Nothing was built or scored.',
    )
    process.exit(0)
  }

  // SPY is the regime yardstick for the era report. Fetch it now, so a run
  // that cannot label its windows stops before it spends hours scoring them.
  const spyWarm = await pre.warmDailyBars(['SPY'], (ticker) => cachedFetchDailyBars(ticker, 'max'), { attempts: 4, pauseMs: 1500 })
  if (spyWarm.failed.length > 0) {
    if (!allowMissing) {
      abortRun('SPY history could not be fetched after 4 attempts; the regime table of the era report needs it.', [
        'Every window would be labeled "unknown" and the regime breakdown would be empty.',
      ])
    }
    console.warn('  WARNING: SPY history unavailable now; the regime step will try again at the end (--allow-missing).')
  }

  // SEC fundamentals, with the same care: a request that failed is retried,
  // and one that still fails is a lost fetch, not "files nothing". The
  // pre-registered run trains on price-only columns, so this protects the
  // cost tier and the cohort diagnostics here, and every fund_ column on
  // runs that use them.
  const fundamentalsStarted = Date.now()
  console.log(`Warming SEC fundamentals for ${tickers.length} tickers (up to 4 attempts for a failed request; "files nothing" is accepted at once)...`)
  const fundamentalsWarm = await pre.warmFundamentals(
    tickers,
    async (ticker) => {
      // SEC's ticker map knows only the current symbol, so a renamed name
      // asks under its successor, exactly as the builder will.
      await fetchFundamentalsTimeline(fetchSymbolOf(ticker))
      const outcome = fundamentalsFetchOutcome(fetchSymbolOf(ticker))
      return outcome == null ? 'failed' : outcome.kind
    },
    {
      attempts: 4,
      pauseMs: 1500,
      onProgress: (done, total, ticker) => {
        if (done % 25 === 0) console.log(`  ${done}/${total} ${ticker}`)
      },
    },
  )
  console.log(
    `  fundamentals: ${fundamentalsWarm.withTimeline.length} with filings · ${fundamentalsWarm.notFilers.length} file nothing (backend's answer) · ` +
      `${fundamentalsWarm.failed.length} requests still failing after 4 attempts · ${fundamentalsWarm.retries} retr${fundamentalsWarm.retries === 1 ? 'y' : 'ies'} · ${((Date.now() - fundamentalsStarted) / 1000).toFixed(0)}s`,
  )
  if (fundamentalsWarm.failed.length > 0) {
    const detail = fundamentalsWarm.failed.slice(0, 20).map((ticker) => `${ticker} (${fundamentalsFetchOutcome(fetchSymbolOf(ticker))?.kind === 'failed' ? (fundamentalsFetchOutcome(fetchSymbolOf(ticker)) as { detail: string }).detail : 'failed'})`)
    if (!allowMissing) {
      abortRun(`${fundamentalsWarm.failed.length} SEC fundamentals requests failed after 4 attempts each (timed out or errored; not "files nothing").`, [
        `names: ${detail.join(', ')}${fundamentalsWarm.failed.length > 20 ? ` ... and ${fundamentalsWarm.failed.length - 20} more` : ''}`,
        'A cold backend needs up to 20 s per SEC download; the client now waits 30 s. Check the backend log, then start the run again.',
      ])
    }
    console.warn(`  WARNING: proceeding with no fundamentals for ${fundamentalsWarm.failed.length} names (--allow-missing): ${detail.join(', ')}`)
  }
  console.log(`Building dataset for ${tickers.length} tickers (${range} bars via proxy)...`)
  // The builder gets the REGISTERED list, so the artifact's universe is the
  // list as registered; the builder applies the same ledgers and fetches
  // only the names planned above.
  const built = await buildHistoricalDataset(registeredTickers, {
    cadenceDays: 10,
    range,
    onProgress: (current, total, ticker) => {
      if (current % 10 === 0) console.log(`  ${current}/${total} ${ticker}`)
    },
  })
  const datasetSeconds = (Date.now() - started) / 1000
  const d = built.diagnostics
  console.log(
    `Dataset: ${built.samples.length} samples · ${d.tickersWithUsableBars}/${d.tickersAttempted} tickers usable` +
      ` · ${d.tickersWithFundamentals ?? 0} with point-in-time EDGAR fundamentals` +
      (d.tickersWithZeroBars ? ` · ${d.tickersWithZeroBars} fetch failures` : '') +
      (d.tickersBelowMinBars ? ` · ${d.tickersBelowMinBars} below history threshold` : '') +
      ` · ${datasetSeconds.toFixed(0)}s (${(tickers.length / Math.max(1, datasetSeconds)).toFixed(2)} names/s)`,
  )
  // The builder and this file must have set aside and renamed exactly the
  // same names, or the artifact would describe a different universe from
  // the one that was warmed and guarded above.
  const builtExcluded = (built.provenance.universeExcluded ?? []).map((entry) => entry.ticker).join(',')
  const plannedExcluded = plan.excluded.map((entry) => entry.ticker).join(',')
  const builtRenamed = (built.provenance.universeRenames ?? []).map((entry) => `${entry.original}>${entry.fetchedAs}`).join(',')
  const plannedRenamed = plan.renamed.map((entry) => `${entry.original}>${entry.fetchedAs}`).join(',')
  if (builtExcluded !== plannedExcluded || builtRenamed !== plannedRenamed) {
    console.error(`ABORTED: the dataset builder and the runner disagree on the universe ledgers (excluded: builder "${builtExcluded}" vs runner "${plannedExcluded}"; renamed: builder "${builtRenamed}" vs runner "${plannedRenamed}").`)
    process.exit(1)
  }
  console.log(
    `  registered ${registeredTickers.length} · registered but excluded ${plan.excluded.length} (recorded in the artifact with the reason) · ` +
      `fetched under a successor symbol ${d.tickersRenamed ?? 0} · ${plan.attrition.statement}`,
  )
  const q = built.quality
  console.log('Dataset evidence quality:')
  console.log(
    `  universe: CURRENT symbols only; PIT membership=${q.universe.pointInTimeMembership ? 'yes' : 'NO'}, ` +
      `delisted names=${q.universe.includesDelistedSecurities ? 'yes' : 'NO'}, ` +
      `delisting returns=${q.universe.includesDelistingReturns ? 'yes' : 'NO'}`,
  )
  console.log(
    `  returns: labels use ${q.returns.labelAdjustment}; adjusted-label coverage ` +
      `${(q.returns.adjustedReturnLabelCoverage * 100).toFixed(1)}%, total-return coverage ` +
      `${(q.returns.totalReturnLabelCoverage * 100).toFixed(1)}% ` +
      `(adjusted close is present on ${(q.returns.adjustedCloseAvailabilityCoverage * 100).toFixed(1)}% of received bars)`,
  )
  console.log(
    `  PIT fundamentals: ${(q.fundamentals.sampleSnapshotCoverage * 100).toFixed(1)}% of samples, ` +
      `${(q.fundamentals.observedFeatureCellCoverage * 100).toFixed(1)}% observed feature cells before imputation; ` +
      `filed-date aligned=${q.fundamentals.alignedByFiledDate ? 'yes' : 'NO'}`,
  )
  console.log(
    `  locked post-selection holdout: ${q.evaluation.lockedPostSelectionHoldout ? 'yes' : 'NO'} ` +
      '(walk-forward folds are OOS, but they are not a never-touched final holdout)',
  )
  // The builder fetches each name once more (the in-process bar cache keeps
  // a name for five minutes, and a long warm-up outlives that), so a fetch
  // can still fail here. Same rule as the warm-up: fatal unless told otherwise.
  // A name that was fetched but produced no rows is printed by name with
  // its bar count and the builder's reason, so a short series can never
  // narrow the run as a bare count.
  const noRows = d.perTickerSummary.filter((entry) => entry.bars > 0 && entry.samplesGenerated === 0)
  if (noRows.length > 0) {
    console.log(`  fetched but no rows (${noRows.length}): ${noRows.map((entry) => `${entry.ticker} (${entry.bars} bars${entry.reason ? `, ${entry.reason}` : ''})`).join(', ')}`)
  }
  const buildFailures = d.perTickerSummary.filter((entry) => entry.bars === 0).map((entry) => entry.ticker)
  for (const ticker of buildFailures) droppedNames.add(ticker)
  if (buildFailures.length > 0) {
    console.log(`  fetch failed in the build: ${buildFailures.join(', ')}`)
    if (!allowMissing) {
      abortRun(`${buildFailures.length} names had no price history when the dataset was built, after the warm-up had fetched them; the run would narrow silently.`, [
        `names: ${buildFailures.join(', ')}`,
      ])
    }
  }
  // A fundamentals request that failed during the build is a lost fetch
  // too. The warm-up already retried these, so anything left is fatal by
  // default; names the backend says file nothing are not in this list.
  const fundamentalsFailed = fundamentalsFetchFailures()
  if (fundamentalsFailed.length > 0) {
    console.log(`  fundamentals requests failed (not "files nothing"): ${fundamentalsFailed.join(', ')}`)
    if (!allowMissing) {
      abortRun(`${fundamentalsFailed.length} SEC fundamentals requests failed while the dataset was built; those rows carry no fundamentals.`, [
        `names: ${fundamentalsFailed.join(', ')}`,
      ])
    }
  }
  if (droppedNames.size > 0) {
    console.warn(`  WARNING: proceeding without ${droppedNames.size} names (--allow-missing): ${[...droppedNames].sort().join(', ')}`)
  }
  // What this build actually cost, so the projection's constant can be
  // refreshed from a real run instead of trusted forever.
  const heapUsedAfterBuildMb = process.memoryUsage().heapUsed / 1024 / 1024
  console.log(
    `  memory after the build: heap ${heapUsedAfterBuildMb.toFixed(0)} MB used of ${heapLimitMb} MB ceiling · ` +
      `${((heapUsedAfterBuildMb - heapUsedAtStartMb) / Math.max(1, d.tickersWithUsableBars)).toFixed(1)} MB per usable name so far (bars + rows; per-window detail comes later) · ` +
      `projection for this run was ${heap.projectedMb} MB peak`,
  )
  if (built.samples.length < 200) {
    console.error('Not enough samples for a reliable walk-forward. Is the backend running on 8787?')
    process.exit(1)
  }

  /* ------------------------------------------------------------------ */
  /* Feature columns                                                     */
  /* ------------------------------------------------------------------ */
  let samples = built.samples
  if (!usesEveryColumn) {
    samples = pruneSampleFeatures(built.samples, featureNames).samples
    console.log(`Pruned to ${featureNames.length}/${HISTORICAL_FEATURE_NAMES.length} features.`)
  }
  const baselineMomentumFeatureIndex = featureNames.indexOf('momentum_252d')

  /* ------------------------------------------------------------------ */
  /* Walk-forward                                                        */
  /* ------------------------------------------------------------------ */
  const f = (value: number, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a')
  const range3 = (m: { min: number; median: number; max: number }) => `${m.min}/${m.median}/${m.max}`
  const pairedLine = (comparison: { ci95: { lower: number; mean: number; upper: number } | null; ciClearOfZero: boolean; pairedStepCount: number; blockLength: number | null }) =>
    comparison.ci95
      ? `${f(comparison.ci95.mean)}  CI [${f(comparison.ci95.lower)}, ${f(comparison.ci95.upper)}]  ` +
        `${comparison.ciClearOfZero ? 'PASS: lower > 0' : 'ADVISORY: CI crosses 0'}  ` +
        `(n=${comparison.pairedStepCount}, block=${comparison.blockLength ?? 'n/a'})`
      : `n/a (only ${comparison.pairedStepCount} usable paired window${comparison.pairedStepCount === 1 ? '' : 's'})`
  // The required-windows arithmetic (docs/EVIDENCE_QUALITY.md section 5):
  // n x (h / m)^2 windows for the lower bound to reach zero at the current
  // mean, where h is the half-width of the interval.
  const requiredLine = (comparison: Pick<BaselineComparisonEvidence, 'ci95' | 'pairedStepCount'>): string => {
    const r = pre.requiredWindows(comparison)
    if (r.mean == null || r.halfWidth == null) return 'windows needed: n/a (no interval)'
    if (r.alreadyClear) return `windows needed: already clear at n=${r.windowsHave}`
    if (r.windowsNeeded == null) return `windows needed: n/a (mean ${f(r.mean, 4)} is not above zero)`
    return `windows needed: ${r.windowsHave} x (${f(r.halfWidth, 4)}/${f(r.mean, 4)})^2 = ~${r.windowsNeeded} (have ${r.windowsHave})`
  }
  const printGatePair = (label: string, evidence: { random: BaselineComparisonEvidence; momentum: BaselineComparisonEvidence }, indent = '  ') => {
    console.log(`${indent}${label}`)
    for (const comparison of [evidence.random, evidence.momentum]) {
      console.log(`${indent}  vs ${comparison.baseline.padEnd(13)} ${pairedLine(comparison)}`)
      console.log(`${indent}     ${requiredLine(comparison)}`)
    }
  }

  let result: FullBacktestResult | null
  let checkpointReport: { dir: string; replayedWindows: number; computedWindows: number } | null = null
  // Peak resident memory, sampled by phase. The window loop is sampled
  // after every window. The post-loop phase (served-model training, the
  // regime step, the gate report and the diagnostics) is sampled after each
  // of its steps, which is as often as synchronous work allows: a timer
  // cannot fire inside one training call. The 200-name smoke of 2026-09-16
  // showed the post-loop phase running well above the loop peak while only
  // the loop was sampled; both peaks are now printed and recorded, so the
  // projection's post-loop factor can be re-measured from a real run.
  const rssNowMb = () => process.memoryUsage().rss / 1024 / 1024
  const peakRss = { loop: rssNowMb(), postLoop: 0 }
  let peakRssMb = peakRss.loop
  const sampleRss = (phase: 'loop' | 'post-loop' = 'loop') => {
    const now = rssNowMb()
    if (phase === 'loop') peakRss.loop = Math.max(peakRss.loop, now)
    else peakRss.postLoop = Math.max(peakRss.postLoop, now)
    peakRssMb = Math.max(peakRssMb, now)
  }
  const walkForwardStarted = Date.now()
  let servedSeconds = 0

  if (freezeHparams) {
    // The pre-registered path: this file drives the window loop through the
    // core's walkForwardStep so every finished window can be written to the
    // checkpoint at once, then asks the core to train the served models.
    const sorted = indexSamples(samples)
    const windows = buildCalendarWindows(sorted, { ...windowRule, tradingDates: built.tradingDates })
    const attempted = summarizeCalendarWindows(sorted, windows, windowRule, 0)
    if (windows.length === 0) {
      console.error(
        `Walk-forward produced no test windows from samples dated ${attempted.firstSampleDate} to ${attempted.lastSampleDate} ` +
          `after the ${windowRule.burnInYears}-year burn-in. Use a longer --range or a shorter --burn-in-years.`,
      )
      process.exit(1)
    }
    console.log('')
    console.log(
      `Calendar windows: built=${windows.length} · ${windowRule.stepTradingDays} trading days each · names per window min/median/max=${range3(attempted.namesPerWindow)}` +
        ` · rows per window min/median/max=${range3(attempted.rowsPerWindow)} · test dates ${attempted.firstTestDate} -> ${attempted.lastTestDate}`,
    )

    let checkpoint: import('./preregistered-run').Checkpoint | null = null
    if (checkpointDir != null) {
      // The row hash runs through the date the checkpoint was created with,
      // so rows a later fetch appends at the tail do not break a resume;
      // a fresh directory fixes that date now.
      const stored = pre.readStoredFingerprint(checkpointDir)
      const hashStarted = Date.now()
      const sampleHash = pre.hashSampleContent(built.samples, stored?.samples?.throughDate ?? pre.sampleHashThroughDate(built.samples))
      const fingerprint: import('./preregistered-run').CheckpointFingerprint = {
        schemaVersion: 2,
        tickers: [...tickers].sort(),
        featureNames: [...featureNames],
        rule: { ...windowRule },
        momentumBaseline,
        correlation,
        hyperparameters,
        freezeHparams,
        horizonDays: 20,
        range,
        excludeEtfs,
        cadenceDays: 10,
        firstSampleDate: attempted.firstSampleDate,
        usableTickers: d.perTickerSummary
          .filter((entry) => entry.samplesGenerated > 0)
          .map((entry) => entry.ticker)
          .sort(),
        settingsHash: pre.hashRunSettings({ tickers, featureNames, momentumBaseline, correlation, rule: windowRule, excludeEtfs, freezeHparams }),
        fundamentals: {
          tickersWithFundamentals: d.tickersWithFundamentals ?? 0,
          sampleCoveragePct: Number((q.fundamentals.sampleSnapshotCoverage * 100).toFixed(1)),
        },
        samples: sampleHash,
      }
      console.log(`Row hash: ${sampleHash.count} rows through ${sampleHash.throughDate} -> ${sampleHash.sha256.slice(0, 16)}... (${((Date.now() - hashStarted) / 1000).toFixed(1)}s)`)
      try {
        checkpoint = pre.openCheckpoint(checkpointDir, fingerprint)
      } catch (error) {
        refuse((error as Error).message)
      }
      // The lock is ours until this process ends, however it ends.
      const giveBackLock = () => pre.releaseCheckpoint(checkpoint!)
      process.on('exit', giveBackLock)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(signal, () => {
          giveBackLock()
          process.exit(130)
        })
      }
      if (checkpoint!.lockReclaimed) {
        console.log(
          `Checkpoint lock: taken over from pid ${checkpoint!.lockReclaimed.pid} (started ${checkpoint!.lockReclaimed.startedAt}), which is no longer running.`,
        )
      }
      const done = checkpoint!.completed.size
      console.log(
        `Checkpoint ${checkpointDir}: ${done === 0 ? 'fresh (no finished windows yet)' : `resuming, ${done} of ${windows.length} windows already finished`}` +
          (checkpoint!.droppedPartialLine ? ' · the last line was cut off mid-write and is being scored again' : '') +
          ` · lock held by pid ${process.pid}`,
      )
    }

    console.log(
      `Running purged+embargoed walk-forward (frozen hyperparameters; gate reads ${correlation} IC against ${momentumBaseline} momentum)...`,
    )
    const loopStarted = Date.now()
    let freshDone = 0
    const loop = pre.runCheckpointedWindows({
      sorted,
      windows,
      checkpoint,
      stepOptions: {
        horizonDays: 20,
        txCostBps: 10,
        modelOptions: hyperparameters,
        baselineMomentumFeatureIndex,
        momentumBaseline,
        correlation,
        captureTestDetails: true,
      },
      onWindow: ({ window, step, replayed, done, total, stepsSoFar }) => {
        sampleRss()
        if (!replayed) freshDone++
        const freshRemaining = total - done
        const perWindow = freshDone > 0 ? (Date.now() - loopStarted) / freshDone : 0
        const eta = freshDone > 0 ? ` eta ${((perWindow * freshRemaining) / 60_000).toFixed(1)}m` : ''
        const tag = replayed ? 'replay' : 'scored'
        if (step) {
          console.log(
            `  [${String(done).padStart(4)}/${total}] ${tag} ${window.testStartDate} -> ${window.testEndDate} names=${window.testNameCount} ` +
              `trees ${f(step.informationCoefficient)}/${f(step.spearmanIc)}  mom12-1 ${f(step.baselineMomentum12to1Ic ?? Number.NaN)}  mom12-0 ${f(step.baselineMomentumIc)}  ` +
              `ridge ${f(step.ridgeIc ?? Number.NaN)}  blend ${f(step.blendIc ?? Number.NaN)}  cost ${f(step.realizedCostBps, 1)}bps  [${((Date.now() - started) / 60_000).toFixed(1)}m${eta}, rss ${peakRssMb.toFixed(0)}MB]`,
          )
        } else {
          console.log(`  [${String(done).padStart(4)}/${total}] ${tag} ${window.testStartDate} -> ${window.testEndDate} skipped (too few rows)`)
        }
        if (!replayed && stepsSoFar.length >= 2 && (done % 10 === 0 || done === total)) {
          const interim = computeBaselineEvidence(stepsSoFar, 1000, { momentumBaseline, correlation })
          printGatePair(`interim paired intervals after ${stepsSoFar.length} scored windows (${correlation}, block=${interim.random.blockLength ?? 'n/a'}):`, interim, '    ')
        }
      },
    })
    checkpointReport = checkpointDir != null ? { dir: checkpointDir, replayedWindows: loop.replayedWindows, computedWindows: loop.computedWindows } : null
    if (loop.steps.length === 0) {
      console.error('Every window was skipped (too few rows); nothing to report.')
      process.exit(1)
    }
    console.log(`Window loop done: ${loop.computedWindows} scored now, ${loop.replayedWindows} replayed from the checkpoint, ${loop.steps.length} usable.`)

    console.log('Training the served models on every row (the core recipe, one spanning window)...')
    const servedStarted = Date.now()
    const served = pre.trainFinalModelsWithCore({
      samples,
      rule: windowRule,
      tradingDates: built.tradingDates,
      modelOptions: hyperparameters,
      baselineMomentumFeatureIndex,
      momentumBaseline,
      correlation,
    })
    servedSeconds = (Date.now() - servedStarted) / 1000
    sampleRss('post-loop')
    result = pre.assembleFullResult({
      sorted,
      windows,
      rule: windowRule,
      steps: loop.steps,
      served,
      momentumBaseline,
      correlation,
      horizonDays: 20,
      hyperparameterSelection: 'frozen',
    })
    sampleRss('post-loop')
  } else {
    // The nested search runs inside the core's single call; no checkpoint.
    console.log(
      `Running purged+embargoed walk-forward (nested-search hyperparameters; no checkpoint; gate reads ${correlation} IC against ${momentumBaseline} momentum)...`,
    )
    result = runWalkForwardBacktest(samples, {
      ...windowRule,
      tradingDates: built.tradingDates,
      baselineMomentumFeatureIndex,
      momentumBaseline,
      correlation,
      freezeHyperparameters: false,
      captureTestDetails: true,
    })
    sampleRss()
    if (!result) {
      const attempted = summarizeCalendarWindows(
        samples,
        buildCalendarWindows(samples, { ...windowRule, tradingDates: built.tradingDates }),
        windowRule,
        0,
      )
      console.error(
        `Walk-forward produced no usable steps: ${attempted.windowsBuilt} test window(s) from samples dated ` +
          `${attempted.firstSampleDate} to ${attempted.lastSampleDate} after the ${windowRule.burnInYears}-year burn-in. ` +
          'Use a longer --range or a shorter --burn-in-years.',
      )
      process.exit(1)
    }
  }
  const walkForwardSeconds = (Date.now() - walkForwardStarted) / 1000
  const promotion = assessModelPromotion(built.quality, result.baselineEvidence)

  // Regime labeling: point-in-time Markov regime on SPY at each step
  // start. 'max', not the dataset range: every step needs 60+ prior SPY
  // returns. Retry on empty — a single transient Yahoo failure here would
  // mark every window 'unknown' and erase the whole regime breakdown.
  console.log('Labeling walk-forward steps by SPY Markov regime...')
  let spyBars = await cachedFetchDailyBars('SPY', 'max')
  for (let attempt = 0; spyBars.length === 0 && attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1500))
    spyBars = await cachedFetchDailyBars('SPY', 'max')
  }
  const regimeHistoryMissing = spyBars.length === 0
  if (regimeHistoryMissing) {
    // The regime table is part of the era report; a report without it is
    // not the report that was registered. The windows are already in the
    // checkpoint, so a fresh run after the backend recovers is cheap.
    if (!allowMissing) {
      abortRun('SPY history is unavailable after 4 attempts, so the regime table of the era report cannot be built.', [
        checkpointDir != null ? `Every scored window is saved in ${checkpointDir}; run the same command again once SPY can be fetched.` : 'Run again once SPY can be fetched (a --checkpoint directory would have kept the scored windows).',
      ])
    }
    console.warn('  WARNING: SPY history unavailable — every step labeled "unknown" (--allow-missing).')
  } else {
    console.log(`  SPY history: ${spyBars.length} bars (${spyBars[0].date} -> ${spyBars[spyBars.length - 1].date})`)
  }
  const regimeLabels = labelStepsByRegime(result.steps, spyBars)
  const regimeBreakdown = summarizeStepsByRegime(result.steps, regimeLabels)
  sampleRss('post-loop')

  const elapsed = ((Date.now() - started) / 1000).toFixed(0)

  /* ------------------------------------------------------------------ */
  /* The pre-registered gate report                                      */
  /* ------------------------------------------------------------------ */
  const evidence = result.baselineEvidence
  const w = result.windowSummary
  const holdoutSteps = pre.holdoutWindows(result.steps)
  const holdoutEvidence = holdoutSteps.length >= 2 ? computeBaselineEvidence(holdoutSteps, 1000, { momentumBaseline, correlation }) : null
  console.log('')
  console.log(`=== PRE-REGISTERED GATE REPORT (${featureNames.length} features; gate reads ${evidence.gate?.correlation ?? correlation} IC against ${evidence.gate?.momentumBaseline ?? momentumBaseline} momentum) ===`)
  console.log(`windows built=${w.windowsBuilt} scored=${w.windowsScored} · names per window min/median/max=${range3(w.namesPerWindow)} · first test date ${w.firstTestDate} · last test date ${w.lastTestDate}`)
  console.log(`measured block length: random=${evidence.random.blockLength ?? 'n/a'} momentum=${evidence.momentum.blockLength ?? 'n/a'} (adjacent windows sharing 20-day label space)`)
  console.log(`hyperparameters: trees=${result.hyperparameters.numTrees} depth=${result.hyperparameters.depth} rate=${result.hyperparameters.learningRate} (${result.hyperparameterSelection})`)
  printGatePair(`Holdout split: windows starting before ${pre.HOLDOUT_CUTOFF_DATE} (${holdoutSteps.length} windows)` + (holdoutEvidence ? ':' : ' - n/a, fewer than two windows'), holdoutEvidence ?? { random: { ...evidence.random, ci95: null, ciClearOfZero: false, pairedStepCount: holdoutSteps.length, blockLength: null }, momentum: { ...evidence.momentum, ci95: null, ciClearOfZero: false, pairedStepCount: holdoutSteps.length, blockLength: null } })
  printGatePair(`All windows (${result.steps.length} windows):`, evidence)
  console.log(
    `timing: dataset ${datasetSeconds.toFixed(0)}s · walk-forward ${walkForwardSeconds.toFixed(0)}s (served models ${servedSeconds.toFixed(0)}s of that) · total ${elapsed}s · ` +
      `peak RSS ${peakRssMb.toFixed(0)} MB (window loop ${peakRss.loop.toFixed(0)} MB, sampled after each window; post-loop ${peakRss.postLoop.toFixed(0)} MB so far, sampled after the served models and the regime step)`,
  )
  if (checkpointReport) {
    console.log(`checkpoint: ${checkpointReport.dir} · ${checkpointReport.replayedWindows} windows replayed · ${checkpointReport.computedWindows} scored this run`)
  }

  /* ------------------------------------------------------------------ */
  /* Full results                                                        */
  /* ------------------------------------------------------------------ */
  console.log('')
  console.log(`=== WALK-FORWARD RESULTS (out-of-sample, ${featureNames.length} features) ===`)
  console.log(`samples=${result.totalSamples} steps=${result.steps.length} elapsed=${elapsed}s`)
  console.log(
    `calendar windows: built=${w.windowsBuilt} scored=${w.windowsScored} · ${w.rule.stepTradingDays} trading days each` +
      ` · burn-in ${w.rule.burnInYears}y from ${w.firstSampleDate} · embargo ${w.rule.embargoTradingDays} trading days`,
  )
  console.log(
    `  names per window min/median/max=${range3(w.namesPerWindow)} · rows per window min/median/max=${range3(w.rowsPerWindow)}` +
      ` · test dates ${w.firstTestDate} -> ${w.lastTestDate}`,
  )
  console.log(
    `hyperparameters: trees=${result.hyperparameters.numTrees} depth=${result.hyperparameters.depth} lr=${result.hyperparameters.learningRate} (${result.hyperparameterSelection})`,
  )
  console.log(`embargo=${result.embargoDaysUsed} trading days  size-tiered cost (entry + exit on both sides + short borrow) avg=${f(result.meanRealizedCostBps, 1)}bps/window`)
  // Sum the per-window cost-tier basis so a reader of the net-return line can
  // see how much of the cost rests on the dollar-volume stand-in rather than a
  // filed market cap. Before SEC XBRL coverage (about 2009) every charged name
  // is proxied, so on a 40-year run this is most of the holdout era. It touches
  // net return, Sharpe and the cost lines only, never the IC the gate reads.
  const tierTotals = { filedCap: 0, dollarVolumeProxy: 0, unavailable: 0, chargedNames: 0 }
  for (const step of result.steps) {
    const basis = step.costTierBasis
    if (!basis) continue
    tierTotals.filedCap += basis.filedCap
    tierTotals.dollarVolumeProxy += basis.dollarVolumeProxy
    tierTotals.unavailable += basis.unavailable
    tierTotals.chargedNames += basis.chargedNames
  }
  if (tierTotals.chargedNames > 0) {
    const pct = (n: number) => f((n / tierTotals.chargedNames) * 100, 1)
    console.log(
      `  cost tier basis over ${tierTotals.chargedNames} charged name-windows: filed cap ${tierTotals.filedCap} (${pct(tierTotals.filedCap)}%)` +
        ` · dollar-volume proxy ${tierTotals.dollarVolumeProxy} (${pct(tierTotals.dollarVolumeProxy)}%)` +
        ` · neither (bottom tier) ${tierTotals.unavailable} (${pct(tierTotals.unavailable)}%)` +
        `  [affects net return and Sharpe lines only, not IC]`,
    )
  }
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
  console.log(
    `12-1 momentum:      ${f(result.meanBaselineMomentum12to1Ic)}  (skips the latest month; the 12-month line above is 12-0)`,
  )
  console.log(
    `Paired moving-block bootstrap edge (model IC minus baseline IC; gate reads ${evidence.gate?.correlation ?? 'pearson'} ` +
      `against ${evidence.gate?.momentumBaseline ?? '12-0'} momentum):`,
  )
  for (const comparison of [evidence.random, evidence.momentum]) {
    console.log(`  vs ${comparison.baseline.padEnd(13)} ${pairedLine(comparison)}`)
  }
  if (evidence.momentumByDefinition) {
    console.log('Momentum definition check (trees minus momentum, both definitions, gate correlation):')
    for (const definition of ['12-1', '12-0'] as const) {
      const comparison = evidence.momentumByDefinition[definition]
      const tag = evidence.gate?.momentumBaseline === definition ? 'GATE  ' : 'report'
      console.log(`  ${tag} ${definition} (${comparison.baseline.padEnd(13)}) ${pairedLine(comparison)}`)
    }
  }
  if (evidence.alternatives) {
    const alt = evidence.alternatives
    console.log('')
    console.log('--- Alternative models on the identical rows (report lines; none of these gate) ---')
    console.log('  model          Pearson   Spearman  windows')
    for (const entry of alt.models) {
      const show = (value: number | null) => (value == null ? '    n/a' : f(value).padStart(7))
      console.log(`  ${entry.model.padEnd(14)} ${show(entry.meanPearsonIc)}   ${show(entry.meanSpearmanIc)}   ${entry.windows}`)
    }
    console.log(
      `  ridge: ${alt.ridge.lambdaRule}; median lambda=${alt.ridge.medianLambda == null ? 'n/a' : f(alt.ridge.medianLambda, 2)}, failed windows=${alt.ridge.failedWindows}`,
    )
    console.log(
      `  blend: trees + ${alt.blend.momentumBaseline} momentum, weight on momentum picked per window from {${alt.blend.weightGrid.join(', ')}} ` +
        `on ${alt.blend.weightBasis} training rows; mean weight=${alt.blend.meanMomentumWeight == null ? 'n/a' : f(alt.blend.meanMomentumWeight, 2)} over ${alt.blend.windowsWithWeight} windows`,
    )
    console.log('  paired differences (left model IC minus right model IC):')
    for (const comparison of alt.comparisons) {
      console.log(`    ${comparison.comparison.padEnd(22)} [${comparison.correlation.padEnd(8)}] ${pairedLine(comparison)}`)
    }
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
  if (fdrQ == null) {
    console.log('FDR feature screen skipped: pass a pre-registered --fdr-q value; no hidden default is applied.')
  } else {
    const fdr = featureSelectionFDR(built.samples, HISTORICAL_FEATURE_NAMES, fdrQ)
    const survivors = fdr.perFeature.filter((p) => p.significant).map((p) => p.name)
    const keptFailing = PRUNED_FEATURE_NAMES.filter((n) => !survivors.includes(n))
    const newSignificant = survivors.filter((n) => !PRUNED_FEATURE_NAMES.includes(n))
    console.log(
      `FDR feature screen (pre-registered q=${fdr.q}): ${fdr.significantCount}/${HISTORICAL_FEATURE_NAMES.length} features clear multiple-testing control.`,
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
  console.log('  (PSR(0)=P(true Sharpe>0); DSR=P(Sharpe beats the best-of-N-trials null). DSR>95% => robust to selection.)')

  // === Calibration + sizing audit ===
  const cs = calibrationAndSizingAudit(result.steps, 20)
  if (cs) {
    console.log('')
    console.log('--- Calibration + sizing audit (isotonic P(outperform); conviction vs equal-weight) ---')
    console.log(
      `Base rate P(outperform): ${f(cs.baseRate * 100, 1)}%  ·  Brier (held-out ${cs.evalN}): calibrated ${f(cs.brierCalibrated, 4)} vs base-rate ${f(cs.brierBaseRate, 4)} (lower = better)`,
    )
    console.log('  reliability  (calibrated prob bin -> realized win rate):')
    for (const b of cs.reliability) {
      console.log(`    P~${f(b.binMeanProb * 100, 1)}%  ->  won ${f(b.winRate * 100, 1)}%   (n=${b.n})`)
    }
    console.log(
      `Sizing A/B (ann. Sharpe): equal-weight quintile ${f(cs.equalWeightSharpe, 2)}  vs  conviction-weighted ${f(cs.convictionWeightedSharpe, 2)}` +
        `  (per-20d mean ${f(cs.equalWeightMeanPct, 2)}% vs ${f(cs.convictionWeightedMeanPct, 2)}%)`,
    )
  }

  // ALWAYS the unpruned samples: the diagnostics index raw features in
  // full column space; pruned arrays would silently misread.
  const survivorship = analyzeSurvivorship(built.samples, result.steps, built.provenance.universeAttrition)
  // The registered names that left the market are part of this picture
  // whether or not the cohort diagnostics could be computed: the names that
  // remain are more survivor-biased by at least that share.
  const leftMarketLines = (attrition: import('../src/data/historicalBacktest').UniverseAttrition | undefined) => {
    console.log('names that left the market (registered but excluded; no free source serves their price history):')
    console.log(`  ${attrition?.statement ?? 'n/a (the dataset carries no attrition record)'}`)
  }
  if (!survivorship) {
    console.log('')
    console.log('--- Survivorship diagnostics ---')
    console.log('  cohort, era and canary diagnostics not computed (no per-row test detail or pruned feature space).')
    leftMarketLines(built.provenance.universeAttrition)
  }
  if (survivorship) {
    console.log('')
    console.log('--- Survivorship diagnostics ---')
    const core = survivorship.cohorts.core
    const priv = survivorship.cohorts.survivorPrivileged
    console.log(`cohorts at formation (HXZ 2020 size screen + FF 2004 age screen):`)
    console.log(
      `  established-then    windows=${core.windows}  IC ${f(core.meanIC)}  L/S ${f(core.meanLongShortPct, 2)}%  (n=${core.samples})`,
    )
    console.log(
      `  survivor-privileged windows=${priv.windows}  IC ${f(priv.meanIC)}  L/S ${f(priv.meanLongShortPct, 2)}%  (n=${priv.samples}, young-or-small-then)`,
    )
    console.log(`  edge concentrated in the privileged cohort = partly survivorship artifact`)
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
      console.log(`  WARNING: distress predicts HIGH returns here — the survivorship signature. Treat absolute returns as inflated.`)
    } else {
      console.log(`  sign consistent with CHS 2008 — no overt survivorship signature in the distress dimension.`)
    }
    console.log(
      `delisting haircut bound (Shumway 1997 -30% NYSE/AMEX; Shumway-Warther 1999 ~-55% Nasdaq makes this the conservative end; FF2004 ~7%/yr attrition applied to YOUNG lists only):`,
    )
    console.log(
      `  long quintile: ${f(survivorship.delistingBound.privilegedShareOfLongQuintile * 100, 1)}% privileged, ${f(survivorship.delistingBound.youngShareOfLongQuintile * 100, 1)}% young -> long-side haircut ~${f(survivorship.delistingBound.haircutPpPerWindow, 3)}pp/window; L/S net ${f(result.meanLongShortReturnNet, 2)}% -> ~${f(result.meanLongShortReturnNet - survivorship.delistingBound.haircutPpPerWindow, 2)}% adjusted`,
    )
    leftMarketLines(survivorship.leftMarket)
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
      `  ${step.testStartDate} -> ${step.testEndDate}  IC ${f(step.informationCoefficient)}  hit ${f(step.hitRate * 100, 0)}%  L/S net ${f(step.longShortReturnNet, 2)}%  [${regimeTag}]`,
    )
  }

  // What the run went without, printed whether or not the artifact is
  // saved, so a --allow-missing run can never read as a complete one.
  if (droppedNames.size > 0 || fundamentalsFailed.length > 0 || regimeHistoryMissing || secMap == null) {
    console.log('')
    console.log('--- What went missing (--allow-missing; also recorded in the artifact provenance when persisted) ---')
    if (droppedNames.size > 0) console.log(`  price history not fetched or served as a stub, names dropped from the universe: ${[...droppedNames].sort().join(', ')}`)
    for (const stub of warm.stubs) console.log(`  ${stub.line}`)
    if (fundamentalsFailed.length > 0) console.log(`  SEC fundamentals requests failed (rows built without fundamentals): ${fundamentalsFailed.join(', ')}`)
    if (regimeHistoryMissing) console.log('  SPY history unavailable: every window is labeled "unknown" in the regime table')
    if (secMap == null) console.log('  SEC ticker map unavailable: the identity check used the Yahoo names and first-trade dates alone, with no CIKs')
  }
  console.log('')
  // The whole run is done; one last sample closes the post-loop phase, and
  // the measured ratio beside the assumed factor is what the next
  // projection should be corrected with.
  sampleRss('post-loop')
  console.log(
    `memory: heap ceiling ${heapLimitMb} MB · machine ${totalMemoryMb} MB total, ${freeMemoryMb} MB free at start · ` +
      `projected ${heap.projectedMb} MB for ${tickers.length} names (loop line ${heap.loopProjectedMb} MB x ${heap.postLoopFactor} post-loop factor) · ` +
      `peak RSS ${peakRssMb.toFixed(0)} MB (window loop ${peakRss.loop.toFixed(0)} MB; post-loop ${peakRss.postLoop.toFixed(0)} MB, sampled after the served models, the regime step and the report) · ` +
      `measured peak / loop line = ${(peakRssMb / Math.max(1, heap.loopProjectedMb)).toFixed(2)} against the assumed ${heap.postLoopFactor} · flag for this size: node ${heap.flag}`,
  )

  console.log('')
  console.log(`--- Model promotion assessment: ${promotion.status.toUpperCase()} ---`)
  for (const reason of promotion.reasons) {
    const tag = reason.status === 'pass' ? 'PASS' : reason.status === 'warning' ? 'WARN' : 'BLOCK'
    console.log(`  [${tag}] ${reason.title}: ${reason.detail}`)
  }

  /* ------------------------------------------------------------------ */
  /* Persist                                                             */
  /* ------------------------------------------------------------------ */
  if (persist) {
    if (!promotion.promotable && !allowAdvisoryPersist) {
      console.error(
        '\nREFUSED --persist: this model is advisory-only. Resolve every BLOCK above, or use ' +
          '--persist --allow-advisory-persist to save a clearly labeled research artifact.',
      )
      process.exitCode = 2
      return
    }
    const persistedMode = promotion.promotable ? 'promoted' : 'advisory-only'
    console.log(
      `\nPersistence authorized in ${persistedMode.toUpperCase()} mode` +
        (!promotion.promotable ? ' by --allow-advisory-persist.' : '.'),
    )
    const stats = computeFeatureStats(samples)
    const bundle20 = result.horizonBundles.find((bundle) => bundle.horizon === 20)
    // What this run was, kept beside the dataset provenance. Every field is
    // optional on the artifact: the serving validator checks named keys only
    // and ignores this block, so older artifacts and this one both load.
    const preRegisteredRun: import('./preregistered-run').PreRegisteredRunProvenance = {
      schemaVersion: 1,
      flags: {
        range,
        windowDays: windowRule.stepTradingDays,
        burnInYears: windowRule.burnInYears,
        embargoTradingDays: windowRule.embargoTradingDays,
        momentumBaseline,
        correlation,
        excludeEtfs,
        freezeHparams,
        features: featureChoice,
        limit,
        tickersFile: tickersFile ?? '',
        allowMissing,
      },
      universe: {
        requested: baseTickers.length,
        etfsExcluded,
        etfSource: etfUniverse.source,
        registered: registeredTickers.length,
        registeredButExcluded: plan.excluded.length,
        excludedNames: plan.excluded.map(({ ticker, delistingDate, reason, recycledBy }) => ({ ticker, delistingDate, reason, ...(recycledBy != null ? { recycledBy } : {}) })),
        renamed: plan.renamed.length,
        renames: plan.renamed.map(({ original, fetchedAs }) => ({ original, fetchedAs })),
        stubs: warm.stubs.map((stub) => ({ ...stub })),
        identity: {
          snapshotDate: identityLedger!.snapshotDate,
          ledgerSha256: identitySha256,
          checked: identity.checked,
          matched: identity.matched,
          renamedInPlace: identity.renamedInPlace,
          recycled: identity.recycled,
          unverified: identity.unverified,
          unregistered: identity.unregistered,
          notes: [...identityLines],
        },
        attrition: { ...plan.attrition },
        trained: tickers.length,
      },
      windows: {
        rule: { ...w.rule },
        built: w.windowsBuilt,
        scored: w.windowsScored,
        namesPerWindow: { ...w.namesPerWindow },
        firstTestDate: w.firstTestDate,
        lastTestDate: w.lastTestDate,
        measuredBlockLength: evidence.random.blockLength,
      },
      gate: { correlation, momentumBaseline },
      requiredWindows: { random: pre.requiredWindows(evidence.random), momentum: pre.requiredWindows(evidence.momentum) },
      holdout: {
        cutoffDate: pre.HOLDOUT_CUTOFF_DATE,
        windowsBefore: holdoutSteps.length,
        windowsAll: result.steps.length,
        random: holdoutEvidence?.random ?? null,
        momentum: holdoutEvidence?.momentum ?? null,
      },
      checkpoint: checkpointReport,
      missing: {
        allowMissing,
        droppedNames: [...droppedNames].sort(),
        fundamentalsFetchFailures: fundamentalsFailed,
        regimeHistoryMissing,
      },
      memory: {
        heapCeilingMb: heapLimitMb,
        projectedMb: heap.projectedMb,
        recommendedFlag: heap.flag,
        peakRssMb: Math.round(peakRssMb),
        totalMemoryMb,
        freeMemoryMb,
        loopProjectedMb: heap.loopProjectedMb,
        postLoopFactor: heap.postLoopFactor,
        loopPeakRssMb: Math.round(peakRss.loop),
        postLoopPeakRssMb: Math.round(peakRss.postLoop),
      },
    }
    const horizonModels = result.horizonBundles.map((bundle) => ({
      horizon: bundle.horizon,
      medianModel: bundle.medianModel,
      meanIC: bundle.meanIC,
      icCI: bundle.icCI,
      conformalOffsetPct: bundle.conformalOffsetPct,
    }))
    const payload = {
      model: result.trainedModel,
      bag20: result.bag20,
      p10Model: bundle20?.p10Model,
      p90Model: bundle20?.p90Model,
      horizonModels,
      conformalOffset20dPct: bundle20?.conformalOffsetPct,
      servingEnsembleAudit: createServingEnsembleAudit({
        model: result.trainedModel,
        bag20: result.bag20,
        p10Model: bundle20?.p10Model,
        p90Model: bundle20?.p90Model,
        horizonModels,
        conformalOffset20dPct: bundle20?.conformalOffsetPct,
        featureNames,
        featureMeans: stats.means,
        featureStds: stats.stds,
      }),
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
      datasetProvenance: {
        ...built.provenance,
        featureNames: [...featureNames],
        preRegisteredRun,
      },
      datasetQuality: built.quality,
      promotion: {
        ...promotion,
        persistedMode,
        advisoryOverrideUsed: !promotion.promotable && allowAdvisoryPersist,
      },
    }
    const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
    const json = JSON.stringify(payload)
    // Always write a local fallback first, so a transient PUT drop
    // (ECONNRESET on the multi-hundred-KB upload) never wastes the whole
    // retrain — the file can be PUT to /ml/model separately.
    const fs = await import('node:fs/promises')
    await fs.writeFile('tools/ml_trained_model.json', json)
    if (!promotion.promotable) {
      console.log(
        'Advisory artifact saved to tools/ml_trained_model.json only; it was not uploaded to the canonical /ml/model slot and cannot displace a promoted model.',
      )
      return
    }
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
