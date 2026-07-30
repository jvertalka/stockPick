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
