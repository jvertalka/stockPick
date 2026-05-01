# Finance Oracle Workstation

This is the separate JavaScript desktop track for Finance Oracle. It is built as
a Tauri + React + TypeScript + Vite app so we can keep the current Flutter app
alive while building a faster, denser desktop workstation in parallel.

## Why This Track Exists

The Flutter app remains useful for proving the intelligence engine and keeping a
cross-platform surface. This workstation is for the heavier desktop experience:

- dense buy, hold, and sell decision boards
- regime-aware opportunity ranking
- sell discipline and deterioration clusters
- scenario lab workflows
- future local analytics, caching, and model-serving commands through Tauri

## Current State

The first screen is a static decision desk shell with mocked data. It establishes
the layout, navigation, and decision surfaces before wiring the existing market
repository and cache into a JavaScript API layer.

## Commands

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

Run the native Tauri desktop app:

```powershell
npm run desktop:dev
```

Build the native desktop app:

```powershell
npm run desktop:build
```

Native Tauri commands require Rust/Cargo. On Windows, install Rust from
`https://rustup.rs`, then install the Microsoft C++ build tools if Tauri reports
a missing native linker or Windows SDK.

## Near-Term Integration Plan

1. Add a local data service adapter that reads the same cached Alpha Vantage and
   universe files as the Flutter app.
2. Replace the mocked decision rows with live buy, hold, and sell projections.
3. Add stock-detail routes for thesis support, thesis damage, options warnings,
   and invalidation rules.
4. Add scenario controls that re-rank the loaded universe without waiting for a
   full refresh.
5. Package the workstation as a signed Windows installer once native builds pass.
