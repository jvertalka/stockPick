# Finance Oracle — product doctrine

This file is binding for any AI session or contributor working in this repo.
It encodes the owner's product vision. When a change conflicts with this
doctrine, the doctrine wins.

## What this app is

A quantitative decision engine that answers **"which stocks/ETFs do I buy
and which do I sell, right now"** in under 30 seconds — grounded in
peer-reviewed research, derivatives data, and advanced statistical methods.

## What this app is NOT

**Not a Fidelity-style dashboard.** No walls of quotes, charts, and tabs
that make the user do the synthesis. The app does the synthesis; the user
gets ranked, justified decisions. If a feature adds information without
adding decision speed, it belongs behind a click, not on the main path.

## The four pillars (priority order)

1. **Decision speed.** The Executive Brief is the landing page and the
   centerpiece: top buys, top sells, options plan, portfolio state — one
   screen, 30 seconds. Every new feature must either sharpen a decision or
   stay out of the default path.

2. **Scientific grounding — no guessed constants.** Every threshold,
   weight, premium, or parameter must cite one of:
   - a peer-reviewed publication (inline comment with author/year/journal),
   - a live data feed (FRED, Yahoo, Tradier, SEC EDGAR, GDELT),
   - or our own measured backtest (date + numbers recorded next to the
     constant, e.g. `quantConfig.ML_REGIME_GATE`).
   Existing canon: BSM/Heston/rough-vol pricing, GJR-GARCH + HAR-RV vol,
   EVT/GPD tails, Cornish-Fisher VaR, CVaR-optimal sizing, Hawkes jumps,
   Hamilton Markov regimes, Kelly, factor premia (Fama-French, AQR,
   Jegadeesh-Titman), GBT per Gu-Kelly-Xiu. Extend this list; never
   regress to hand-tuned magic numbers.

3. **Derivatives are a first-class input AND output.** Options chains feed
   the engine (IV, skew, risk-neutral probabilities via Tradier + BSM), and
   the app emits options strategies (covered calls, protective puts, long
   calls, condors, vol-arb flags) with legs, payoffs, and citations — not
   just stock picks.

4. **Self-healing and robust.** The app must never look broken when it
   isn't, and must repair what it can without the user:
   - `start-workstation.cmd` starts/heals everything; keep it working.
   - Backend warms its own universe on boot; frontend shows "warming up"
     and polls — never a silent empty screen.
   - Auto-reconnect with backoff; ErrorBoundary contains crashes;
     self-tests run at startup (quantMath: 26 tests vs. textbook values).
   - Any new failure mode gets a visible state + automatic recovery path.

## Validation doctrine (ML and rules alike)

- Out-of-sample only: purged + embargoed walk-forward (López de Prado).
- Always vs. baselines (random, momentum) with bootstrap CIs; a model that
  doesn't beat baselines with CI clear of zero stays advisory.
- Regime-aware: measure performance per Markov regime; gate where skill
  isn't proven (current gate: ML suppressed in high-vol — see
  `quantConfig.ML_REGIME_GATE` for the measured justification).
- Live decay monitoring must keep running (prediction logging +
  reconciliation); a model that decays gets retired, not defended.
- Show honest limits in the UI (data confidence, prediction intervals,
  "coin flip in this regime" chips). Never present uncalibrated numbers
  as certainty.

## Where things live

- `desktop-js/` — the product (React + Vite; Tauri shell available).
- `tool/backend_cache_server.dart` — local data backend: CORS proxy,
  cache, decision universe, boot warmup.
- `desktop-js/src/data/quantMath.ts` — all pricing/statistical methods
  (citation-commented) + `quantMath.tests.ts` startup self-tests.
- `desktop-js/src/data/quantConfig.ts` — every research-backed constant.
- `desktop-js/src/data/historicalBacktest.ts` + `tools/backtest-cli.ts` —
  walk-forward training/evaluation (UI panel and headless CLI share it).
- **Packaged desktop app is the primary runtime**: `build-desktop.ps1`
  compiles the Dart backend to a native sidecar
  (`desktop-js/src-tauri/binaries/`, gitignored) and builds the Tauri
  app. The Rust supervisor (`src-tauri/src/lib.rs`) spawns the sidecar,
  reuses an already-running backend instead of double-binding the port,
  auto-restarts it on crash with backoff, and kills it on exit.
- `start-workstation.ps1` / `.cmd` — dev-mode launcher (Vite + `dart run`).
- The Flutter app at repo root is legacy; the JS workstation is canonical.
