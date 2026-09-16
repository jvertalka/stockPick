# Evidence and data quality contract

Finance Oracle separates a model that is useful for research from one that is
allowed to change a live action label. This contract is enforced in code and
stored with every new model artifact.

## Price data

- Yahoo `indicators.adjclose` is the return and label price. It adjusts for
  splits and cash distributions.
- Analytical open/high/low are scaled by `adjclose / rawClose`, keeping each
  historical OHLC bar internally consistent.
- Raw OHLC is retained separately for current-price display, market-cap
  reconstruction, and dollar-liquidity calculations.
- A row without valid, internally consistent OHLCV or `adjclose` is rejected
  and remains in the source-row coverage denominator rather than disappearing.
- Exception: a provider placeholder row — every price field AND volume null —
  carries zero information and is dropped at parse time, so the date reads
  like a market holiday. The count is stored on the series as
  `excludedProviderPlaceholderRows` so the exclusion stays visible. A row
  with any real field is never dropped. (Yahoo served such placeholders
  fleet-wide for the 2026-07-21/22/31 sessions.)
- Exception: the session in progress. Yahoo serves today's running session as
  if it were a finished daily bar, and its open/high/low/close come from update
  paths that have not reconciled yet (measured 2026-08-25 at 18:16Z, ABCB
  reported an open of 86.10 above its own high of 85.99). When the response's
  own `meta.currentTradingPeriod.regular` says the instrument's regular session
  is open right now and the last bar belongs to that session, the bar is
  excluded from the analytics series and counted in
  `excludedInProgressSessionBars`. The exclusion is unconditional while the
  session is open, because dropping the bar only when it happens to look wrong
  is what made scoreable coverage churn between refreshes. Only ever the last
  bar, only against the currently open session; a halted or stale symbol keeps
  every bar, and a response without usable session metadata changes nothing.
  The consequence is deliberate: during market hours a symbol's newest stored
  bar is the last COMPLETED session, so the last stored price is the previous
  close until today's session ends. That is the honest last daily close.
- Timestamps must be strictly increasing; rows are never sorted/deduplicated in
  a way that would compress trading-day horizons.
- Live decision metrics require the latest 200 provider rows to be complete
  adjusted bars. A gap inside that analytical window pauses the name and
  triggers refresh; older gaps remain visible as provenance warnings.
- Legacy cache rows are marked `legacy-unadjusted-close`, cannot support
  signals, and are prioritized for refresh.
- Dataset artifacts record eligible rows, adjusted rows, missing rows, price
  basis, provider field, and coverage.

## Fundamental data

- SEC EDGAR companyfacts remain keyed to the public `filed` date.
- A historical sample can see only facts filed before its sample date.
- Coverage is measured before median imputation: artifacts record both the
  share of samples with a filed snapshot and observed fundamental feature-cell
  coverage.
- Missing fundamentals remain visible as missing/imputed evidence; they are not
  relabeled as observed data.

## Model promotion

Promotion is an all-gates contract, not a score threshold. A model may lead
live decisions only when:

1. Universe membership is point-in-time and includes dead securities and
   delisting returns.
2. Every source row and return label has a proven adjusted-total-return basis.
3. Fundamentals are aligned by public filing date.
4. Missing-data and sparse-date fallback statistics are fit inside each
   training fold; dataset-wide preprocessing is a hard leakage blocker.
5. Feature selection is followed by a locked, untouched post-selection
   holdout.
6. Paired moving-block-bootstrap 95% confidence intervals for model IC minus
   random and model IC minus 12-month momentum both have lower bounds above
   zero. Block length is measured from exact test-label overlap and the policy
   requires at least 1,000 bootstrap resamples.

### Pre-registered stopping rule (UNSIGNED - owner to complete)

> **STATUS: UNSIGNED DRAFT, written 2026-09-16. Nothing in this subsection is
> in force.** It becomes a rule only when the signature line at the end is
> filled in, and that must happen before the run is launched. Every `______`
> is a decision the owner has not made yet. The text in square brackets after
> a blank is a recommended default, not a decision. A reader who finds this
> subsection with the signature line empty should treat it as a proposal.

**Why a stopping rule exists.** The saved model's evidence rests on exactly
70 walk-forward windows, and that number was never a property of the data.
As of commit 8c22bf0 (since replaced), the command-line runner hardcoded
`const targetWindows = 70` and worked the window size backwards from it
(`desktop-js/tools/backtest-cli.ts:152` at that commit), windows were slices
of the date-sorted sample list taken by row count, not by calendar
(`desktop-js/src/data/historicalBacktest.ts:2250` and `:3392-3405` at that
commit), and the in-app worker used a different rule again, `Math.max(60,
tickersWithUsableBars)` with no target (`src/data/backtest.worker.ts:97` at
that commit), so the app and the runner disagreed on the same data. Widening
the universe from 224 names (the saved artifact,
`desktop-js/tools/ml_trained_model.json`, `datasetProvenance.universeTickers`)
to 500 names added rows but not one new independent window: that run still
produced `steps=70` on 148,259 samples
(`desktop-js/tools/backtest-1000-derisk-500.log:60`), and its net long-short
interval was [-0.14%, +1.77%] (`:76`), no tighter than before. More names do
not buy evidence; more time does.

The code no longer works that way. Test windows are now cut on the trading
calendar by `buildCalendarWindows` (`historicalBacktest.ts:2700-2755`): after
a training-only burn-in, every block of 20 trading days becomes one test
window holding every name formed inside it, with no target count and no cap,
so the window count is a property of the span and the calendar alone. The
three numbers that place the windows live in one object, `DEFAULT_WINDOW_RULE`
(`:2621-2625`: 20 trading days per window, a 10-year burn-in, a 5-trading-day
embargo), and both the runner (`backtest-cli.ts:169-173`) and the in-app
worker (`backtest.worker.ts:102`) start from it, so the two now agree on the
same data. The 25-name 40-year smoke run on 2026-09-16 produced 359 windows
(`backtest-cli.ts:17-18`). This subsection fixes the experiment, the two
numbers that will be read, and what happens on each outcome, all in writing
before the run starts, so the result cannot be re-read afterwards to suit
whatever came out.

**1. The single experiment.** One run, and only one, defined as follows.

- Data span: 40 years of daily bars. The dataset builder always fetches the
  full history (`fetchRange = 'max'`, `historicalBacktest.ts:2107`; the `max`
  range means 40 years in `src/data/marketData.ts:171`, mirrored by
  `MAX_FETCH_RANGE_YEARS` at `historicalBacktest.ts:889`) and then trims to
  the requested range (`trimByRange`, `:2104-2108`, applied at `:2169`; a
  15-year run keeps 3,780 bars). The runner's `--range` flag defaults to
  `max` (`backtest-cli.ts:159`), which skips that trim.
- Names: every ticker in `DEFAULT_BACKTEST_TICKERS` (1,359 entries as of this
  draft, `historicalBacktest.ts:170`), subject to the exchange-traded-fund
  blank in section 4. With the runner's exchange-traded-fund exclusion at
  its default (ON, `backtest-cli.ts:188`) that is 1,073 names before the two
  ledgers below are applied. The registered list itself is never edited; the
  ledgers sit next to it and are applied when the dataset is built.
  - Renames (`TICKER_RENAMES`): a company that still trades under a new
    symbol is fetched under that symbol and kept under its registered name.
    A rename is only accepted when the successor's price history starts on
    the same day the original did, so a symbol that merely reused the name
    cannot pass as a continuation.
  - Exclusions (`EXCLUDED_UNFETCHABLE`): names that no free source serves
    any more, each with the delisting date, the reason (bankruptcy, merger,
    taken private, and so on) and the evidence read. Two of these are
    recycled symbols: `PARA` and `B` now belong to Banzai International and
    Barrick Mining, companies with long histories of their own, so a bar
    count or a first-trade date could never have caught them. Paramount
    Global delisted on 2025-08-07 and Barnes Group on 2025-01-27.
  - Identity pin (`tools/registered_identity.json`): for every remaining
    name the run records who the symbol belonged to on 2026-09-16, by
    Securities and Exchange Commission filer number where one exists and by
    the provider's company name and first-trade date otherwise. The runner
    checks every name against that record before training. A changed filer
    number stops the run outright and cannot be waved through with a flag: a
    symbol that now belongs to a different company is a wrong company, not a
    missing one. The same filer number with a first-trade date that moved by
    more than 30 days also stops the run, because the Securities and
    Exchange Commission's ticker list can lag a symbol reassignment by weeks
    while the price provider has already handed the symbol to its new
    holder. A changed name under the same filer and the same first-trade
    date is printed and allowed. A name the run cannot check at all (no
    filer number, no readable provider record, or a chart that answered
    under another symbol) also stops the run: an unknown company is not
    missing data. The run records the SHA-256 of the identity file it was
    checked against, so a later edit of that file cannot pass as the one
    the run used.
  Names dropped by the ledgers are a known hole in the panel: a company that
  died is exactly the kind of name a survivorship-honest study wants to keep,
  and these are lost only because no free source still serves their prices,
  or because the business now files under a new registrant number.
  The run reports how many registered names it could not fetch and treats the
  measured result as survivor-flattered by that share.
- Features: the eleven price-only features now in `PRUNED_FEATURE_NAMES`
  (`historicalBacktest.ts:4938`): `volatility_252d`, `volatility_60d`,
  `range_compression_20d`, `downside_vol_60d`, `volatility_20d`,
  `momentum_252d`, `listing_age_years`, `log_price_level`, `vol_of_vol_60d`,
  `price_velocity_acceleration`, and `amihud_illiquidity_20d`. This is the
  runner's `--features` default (`backtest-cli.ts:46-47`). The list's two
  other entries, `fund_log_market_cap` and `fund_altman_z`, are left out of
  this run. Both sit in the fundamentals block that is built point-in-time
  from Securities and Exchange Commission electronic filings (`:500-523`),
  those filings only start around 2009, and the brief that commissioned this
  draft estimated that about 44% of a 40-year panel would have no filing to
  read. That figure is an estimate. The dataset build measures fundamental
  coverage before imputation (`:2381-2386`) and the number it prints at run
  time is the one to quote. Leaving two names out of a run changes neither
  `HISTORICAL_FEATURE_NAMES`, nor `PRUNED_FEATURE_NAMES`, nor the feature
  vector, so the pipeline version stays at v4.
- Windows: cut by the calendar, one test window per 20 trading days, so a
  window is a fixed slice of time rather than a fixed count of rows. This is
  now the only rule in the code (`buildCalendarWindows`,
  `historicalBacktest.ts:2700`; `--window-days 20` is the runner's default,
  `backtest-cli.ts:169-173`).
- Training-only period: the first 10 years of the span are used only to
  train. No window that starts inside them is scored (`burnInYears: 10` in
  `DEFAULT_WINDOW_RULE`, `historicalBacktest.ts:2623`; `--burn-in-years 10`
  is the runner's default).
- Hyperparameters: frozen at 50 trees, depth 3, learning rate 0.1, the values
  in the saved artifact (`ml_trained_model.json`, `hyperparameters`) and now
  in `FROZEN_HYPERPARAMETERS` (`historicalBacktest.ts:4587-4588`), which the
  runner uses by default (`--freeze-hparams` ON, `backtest-cli.ts:192`). The
  nested search is switched off for this run. It scores six settings
  (`:4525-4532`) on only the first three inner windows (`:4541-4545`; the
  old inner steps of at most 40 rows went with the count-based slicing), and
  on the 500-name run it flipped to 80 trees / depth 4 / rate 0.05
  (`backtest-1000-derisk-500.log:61`). A choice that moves that much on that
  little data is not stable enough to pre-register.
- Missing data: `--allow-missing` is OFF by default (`backtest-cli.ts:39` and
  `:141`). A name whose price history cannot be fetched after four attempts,
  a name whose filings request fails (as opposed to the backend saying the
  name files nothing), and missing SPY history for the regime table each stop
  the run with the names printed. With the flag on, the run proceeds and the
  artifact's provenance lists what was dropped, and the run prints what it
  went without whether or not the artifact is saved, so a run with the flag
  on can never read as a complete one (`:997-1002`). The pre-registered run
  is made with the flag off.
- Memory: the runner is started as `node --max-old-space-size=13312
  tools/backtest-cli.mjs ...` (`backtest-cli.ts:11` and `:22`). Nothing is
  released during a run, so the need grows with the number of names: the two
  2026-09-16 smokes peaked at 355 MB for 15 names and 446 MB for 25, about
  219 MB fixed plus 9.1 MB per name, which projects to about 9,983 MB for the
  1,073-name universe; the flag is that projection plus a quarter, rounded up
  to a whole gigabyte (`projectHeapNeed`,
  `desktop-js/tools/preregistered-run.ts:676-692`). The run prints the
  ceiling it got, the projection, and the exact flag, and warns at start when
  the projection is above the ceiling (`backtest-cli.ts:281-297`).

**2. The two numbers that are read, and only these.** From the paired
moving-block bootstrap (`computeBaselineEvidence`,
`historicalBacktest.ts:3974-4081`; block length measured from label overlap
by `measuredOverlapBlockLength`, `:3833-3848`; at least 1,000 resamples, as
item 6 already requires), at the 20-trading-day label horizon (`:2901`):

- the lower end of the 95% interval for model information coefficient minus
  the random baseline, and
- the lower end of the 95% interval for model information coefficient minus
  the 12-month momentum baseline.

Nothing else decides the outcome. Every other statistic the run prints is a
report line.

**3. Pre-committed outcomes.** The owner writes in what the app does in each
case before the run. The bracketed text is the recommended default.

- (a) Both lower bounds above zero -> ______
  [recommended default: promote under the rewritten gate]
- (b) Random lower bound above zero, momentum lower bound at or below zero ->
  ______ [recommended default: the model becomes an advisory tilt on top of
  momentum, with the tilt weight measured inside this run's windows, not set
  by a formula]
- (c) Neither lower bound above zero -> ______
  [recommended default: retire the machine-learning path; the app ships the
  rules engine plus momentum]

The honest expectation going in, from today's numbers in section 5, is
outcome (b): random clears, momentum does not.

**4. Yardstick blanks the owner must fill before the run.**

- Correlation used by the gate: ______ [default: Pearson, which is what the
  gate uses today for the model information coefficient (`:3012`) and for
  the momentum baseline (`:3128` for 12-0, `:3134` for 12-1); Spearman is
  computed beside each (`:3013`, `:3131`, `:3137`). The runner reads
  `--correlation pearson` by default (`backtest-cli.ts:183`;
  `DEFAULT_GATE_CORRELATION`, `historicalBacktest.ts:3496`) and prints both.
  The two disagreed on the 500-name run, 0.049 Pearson against 0.020
  Spearman (`backtest-1000-derisk-500.log:64` and `:66`), so which one gates
  has to be written down first.]
- Momentum baseline definition: ______ [default: 12-1, the Jegadeesh-Titman
  literature standard that skips the most recent month; 12-0 is reported
  beside it. The runner now implements this default:
  `DEFAULT_GATE_MOMENTUM_BASELINE` is `'12-1'` (`historicalBacktest.ts:3495`),
  the value is computed per row by `computeMomentum12to1AtDate` (`:878`),
  and `--momentum-baseline 12-1` is the runner's default
  (`backtest-cli.ts:180`). The 12-0 form is the `momentum_252d` feature
  column, `ret(252)`, close today over close 252 bars ago (`ret` at
  `:628-632`, feature slot at `:802`), which includes the most recent month;
  it was the gate's baseline until 2026-09-16, and both forms get a Pearson
  and a Spearman reading on every window (`:3128-3137`).]
- Exchange-traded funds in the scored cross-section: ______ [default: OUT.
  286 of the 1,359 default tickers sit in a symbol-universe bucket flagged
  `isEtf: true` (`lib/src/data/expanded_symbol_universe.dart` and
  `lib/src/data/default_symbol_universe.dart`, intersected with
  `DEFAULT_BACKTEST_TICKERS`; one ticker, PXD, is in neither file). They
  carry no filings, they are a different kind of instrument, and with no
  filed market cap their trading cost now rests on the dollar-volume stand-in
  described in section 5 rather than on the bottom, most expensive tier
  outright (`costTierMarketCapUsd`, `historicalBacktest.ts:63-77`; tier
  table at `src/data/quantConfig.ts:268-274`). The runner leaves them out by
  default (`--exclude-etfs` ON, `backtest-cli.ts:188`; `--include-etfs` keeps
  them), reading the `isEtf` flag from the two Dart files when they are
  present and falling back to the two fund blocks inside
  `DEFAULT_BACKTEST_TICKERS` otherwise (`resolveEtfUniverse`,
  `desktop-js/tools/preregistered-run.ts:1116`). Their result is reported as
  a separate line either way.]
- Listing-age treatment on a 40-year fetch: ______ [default: treat listing
  age as unknown when a name's first bar sits on the fetch start. The runner
  now implements this. `listing_age_years` is still capped at 25 years
  (`listingAgeYears`, `historicalBacktest.ts:945-963`), so on a 40-year fetch
  every name listed before 1986 would read as if it listed in 1986, and the
  cap would hide the difference between "listed in 1986" and "already old in
  1986". The dataset builder therefore passes the fetch boundary down
  (`fetchWindowStartMs`, `:2114`), and a name whose first bar is at or within
  a week after it gets `NaN` for its listing age instead of a measured value
  (`:951-958`). That `NaN` is the missing sentinel the rest of the pipeline
  already understands: the causal imputation fills it with the date's median
  from names whose age IS known and records the cell as missing on the
  sample's `imputedMask` (`imputeMissingWithDateMedians`, `:1773`, the mark
  at `:1819-1826`), the survivorship cohort never calls an imputed age
  "young" (`:1889-1890`), and the number of names at the boundary is stored
  in the dataset diagnostics as `tickersAtFetchBoundary` (`:2166` and
  `:2410`). The feature name and its slot in the vector are unchanged. The
  live scoring path passes no boundary and takes the first bar at face
  value.]
- Holdout definition: windows starting before 2012-07-20. The saved
  artifact's sample range starts on that date (`ml_trained_model.json`,
  `datasetProvenance.sampleDateRange.start`), so no feature screen or nested
  search has ever seen an earlier window. The two gate intervals in section 2
  are reported twice: once on holdout-only windows and once on all windows
  (`HOLDOUT_CUTOFF_DATE` and `holdoutWindows`,
  `desktop-js/tools/preregistered-run.ts:1060-1064`).
- The era test, stated as a test: the difference between the mean per-window
  paired (model minus momentum) information coefficient for windows before
  2012-07-20 and for windows from 2012-07-20 on, with a block-bootstrap 95%
  interval built the same way as the gate intervals; ______ [either keep it
  as that test, or explicitly demote it to a report line. It does not decide
  the outcome either way.]

**5. Required-window arithmetic.** Every future run states how far it is from
the bar using this rule (the runner prints it for each gate comparison as
`windows needed`; `requiredWindows`,
`desktop-js/tools/preregistered-run.ts:1037-1049`, printed at
`backtest-cli.ts:501-504`). Take the current mean paired difference m, the
current interval half-width h (upper end minus lower end, divided by two),
and the current window count n. The half-width of a bootstrap interval on a
mean shrinks with the square root of the number of windows, so at n' windows
it is h × sqrt(n / n'). The lower bound reaches zero when that half-width
equals m, so sqrt(n / n') = m / h, which rearranges to

    windows needed = n × (h / m)²

Today, from `ml_trained_model.json` `promotion.baselineEvidence` (n = 70
paired windows, block length 3, 1,000 resamples):

- Momentum: m = 0.0203, interval [-0.0453, +0.0893], so h = 0.0673.
  h / m ≈ 3.306, squared ≈ 10.93, times 70 ≈ 765 windows.
- Random: m = 0.0474, interval [-0.0044, +0.0976], so h = 0.0510.
  h / m ≈ 1.076, squared ≈ 1.158, times 70 ≈ 81 windows.
- Supply: a 40-year span with the first 10 years reserved for training leaves
  30 scoring years. At roughly 252 trading days a year and one window per 20
  trading days that is at most 30 × 252 / 20 = 378 windows, and about
  340-380 once the final label horizon and calendar losses are taken off.
  The 25-name smoke run on 2026-09-16 produced 359. The run prints the
  actual count, and that printed count is the one to quote.

So the run can clear the random bar with room to spare and cannot reach the
momentum bar unless the momentum edge itself grows. The formula assumes the
mean stays where it is and the block structure does not change; it is a
planning yardstick, not a forecast.

Report-line note on trading costs (not a gate input). Filed market caps come
from Securities and Exchange Commission XBRL filings, which only reach back
to about 2009, and exchange-traded funds never file one. Until 2026-09-16
every name without a filed cap was charged the bottom, most expensive cost
tier outright, so the early decades of a 40-year run priced names like IBM
and Exxon as microcaps (the 25-name smoke run paid about 268 basis points a
window in those years). The rule now: a filed cap always wins; without one,
the trailing 20-day average dollar volume (the same number the Amihud
illiquidity feature is built from, carried on each row as
`avgDollarVolume20d`, `historicalBacktest.ts:401`) is divided by a typical
daily turnover rate of 1% of market cap, and the result is looked up in the
same two tier tables (`costTierMarketCapUsd`, `historicalBacktest.ts:63-77`;
`DOLLAR_VOLUME_SIZE_PROXY`, `src/data/quantConfig.ts:323-326`, with the
turnover sources in the comment above it). The rate sits at the high end of
the historical range on purpose, so the stand-in can only err toward a MORE
expensive tier, never a cheaper one. A row with neither a filed cap nor a
dollar volume still falls to the bottom tier. Each window records how many
charged names were placed by a filing, by the stand-in, or by neither
(`costTierBasis`, `:2514-2519`, counted at `:3073-3078`). What this touches:
the net long-short return, the Sharpe ratio built on it, and the cost lines,
all of which are report lines. What it does not touch: the information
coefficient, which is measured on predictions and outcomes before any cost is
subtracted, so neither gate number in section 2 moves.

**6. Signature.**

Signed: ________ Date: ________ (must precede the run launch)

The current dataset still uses a caller-supplied list of securities that exist
today, applies global fallback preprocessing before folds, and has no locked
post-selection holdout. Those are hard blockers, so a
new model built from the current data is correctly labeled `advisory-only` even
when its walk-forward statistics look strong.

After using the exact esbuild command in the
[CLI source header](../desktop-js/tools/backtest-cli.ts),
`node tools/backtest-cli.mjs --persist` refuses an advisory artifact. An
operator can preserve one for research with
`node tools/backtest-cli.mjs --persist --allow-advisory-persist`; the artifact
records that override, stays in the local JSON research file, is not uploaded
to the canonical backend model slot, and still cannot lead decisions in the app.

## User-interface policy

- Legacy and advisory models may show forecasts and uncertainty intervals, but
  cannot mint live action labels.
- Independently measured rules-based exit warnings remain visible.
- The Executive Brief admits an unqualified buy only when its existing
  decision-grade data gate passes, SEC provenance and dates are present, price
  and prediction dates agree, and the calibrated 80% relative-return interval
  is entirely above zero.
- ML-derived Trim/Avoid labels use the same synchronized evidence clock and
  require the calibrated interval to be entirely below zero. Independent rules
  exits remain clearly labeled risk warnings.
- Blocked candidates remain inspectable under **Advisory only**, with the exact
  reasons shown.
- Every fresh launch starts on the live/base Executive Brief, never a persisted
  hypothetical scenario.

## Verification

From `desktop-js`:

```powershell
npm run quality
```

This runs lint, deterministic evidence/quant tests, TypeScript compilation, and
the production frontend build. The packaged app also runs the textbook quant
self-tests at startup and pauses recommendations if any fail.

The repository CI additionally runs Dart analysis and the Flutter/Dart contract
suite on Windows, including backend shutdown/cache lifecycle and adjusted-price
parsing.
