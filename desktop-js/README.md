# Finance Oracle Workstation

This is the canonical Finance Oracle product: a Tauri + React + TypeScript +
Vite workstation backed by the local Dart cache/decision sidecar.

## Why This Track Exists

The Flutter app remains useful for proving the intelligence engine and keeping a
cross-platform surface. This workstation is for the heavier desktop experience:

- dense buy, hold, and sell decision boards
- regime-aware opportunity ranking
- sell discipline and deterioration clusters
- scenario lab workflows
- future local analytics, caching, and model-serving commands through Tauri

## Current state

The workstation is live-data-backed and contains the Executive Brief, ranked
Decision Desk, portfolio workflows, options strategy tickets, walk-forward
Model Lab, and live model-decay monitoring. When the backend or adjusted price
history is unavailable, recommendations pause instead of falling back to mocked
rows.

Models are fail-closed: advisory/legacy artifacts may show research forecasts
but cannot change action labels. See
[the evidence-quality contract](../docs/EVIDENCE_QUALITY.md).

## Commands

Primary development startup (from the repository root) compiles/starts the
Dart sidecar and launches Vite with recovery behavior:

```powershell
.\start-workstation.cmd
```

Primary packaged build (also from the repository root) compiles the gitignored
native sidecar before Tauri bundles it:

```powershell
.\build-desktop.ps1
```

Install dependencies:

```powershell
npm install
```

Run the React/Vite shell in a browser:

```powershell
npm run dev
```

Build the frontend bundle:

```powershell
npm run build
```

Run the complete evidence gate (lint + deterministic tests + build):

```powershell
npm run quality
```

Advanced: run Tauri directly only after the sidecar binary has been compiled:

```powershell
npm run desktop:dev
```

Advanced: build Tauri directly under the same prerequisite:

```powershell
npm run desktop:build
```

Native Tauri commands require Rust/Cargo and the prebuilt external sidecar. On Windows, install Rust from
`https://rustup.rs`, then install the Microsoft C++ build tools if Tauri reports
a missing native linker or Windows SDK.

## Remaining promotion blockers

The research pipeline now uses Yahoo adjusted-total-return prices and
point-in-time SEC filing dates. A production-promotable model still requires a
point-in-time constituent/dead-security dataset with delisting returns and a
fold-local preprocessing implementation plus a locked post-feature-selection
holdout. Until those gates pass, newly trained
models are explicitly advisory-only.
