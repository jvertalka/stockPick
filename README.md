# Finance Oracle

Cross-platform Flutter MVP for a regime-aware market intelligence product. The app is designed to feel like a multi-layer decision engine instead of a generic screener:

- market regime detection
- breadth and internal health monitoring
- regime-conditioned stock ranking
- sell-discipline alerts based on deterioration clusters
- scenario analysis with explanation-first output

## Views

- `Market Radar`: regime, breadth, volatility, style rotation, sector sponsorship
- `Opportunity Board`: ranked stocks with conviction, fragility, and thesis support
- `Stock Intelligence`: single-name explanation layer with options risk and invalidation rules
- `Sell Alerts`: trim, de-risk, and exit ideas based on clustered evidence
- `Scenario Lab`: re-rank the board under stress scenarios

## Current state

The app now runs through a structured fixture repository and a deterministic intelligence engine:

- raw market, sector, stock, and options-like inputs now flow through provider-backed repository contracts
- a rules-based engine derives regimes, stock rankings, sell alerts, and scenarios
- a point-in-time snapshot archive now stores repository states locally
- an Alpha Vantage adapter can populate the daily price-history spine with
  connected OHLCV data under a quota-aware cache
- a local backend cache can serve the Flutter web build and proxy/cache the
  free data layer so Chrome is not blocked by CORS
- Alpha Vantage now syncs into a durable local store with cached coverage and
  sync-cadence metadata so the app can read from local history first
- a fixture walk-forward validation pass reports hit rate, alpha, and drawdown stats
- the research harness now surfaces chronological train/test splits and per-window breakdowns
- the shell can manually refresh the repository and surfaces feed refresh cadence

This is a better foundation than a handwritten final snapshot, and the app is
now wired for both pluggable live feed providers and a free Alpha Vantage daily
price-history path. It is still not a trained system yet.

## Run

```bash
flutter pub get
flutter run
```

To prefer live adapters when you have an endpoint ready:

```bash
flutter run \
  --dart-define=ORACLE_DATA_MODE=live-preferred \
  --dart-define=ORACLE_DATA_BASE_URL=https://your-api.example \
  --dart-define=ORACLE_STOCK_UNIVERSE_LIMIT=100 \
  --dart-define=ORACLE_HISTORICAL_SNAPSHOT_LIMIT=252
```

To use the free Alpha Vantage price spine:

```bash
flutter run \
  --dart-define=ORACLE_DATA_MODE=alpha-vantage \
  --dart-define=ORACLE_ALPHA_VANTAGE_API_KEY=your-alpha-vantage-key \
  --dart-define=ORACLE_ALPHA_VANTAGE_SYMBOLS=NVDA,MSFT,AVGO,JPM,LLY \
  --dart-define=ORACLE_ALPHA_VANTAGE_DAILY_LIMIT=25 \
  --dart-define=ORACLE_ALPHA_VANTAGE_SYNC_INTERVAL_MINUTES=20 \
  --dart-define=ORACLE_HISTORICAL_SNAPSHOT_LIMIT=100
```

Alpha Vantage mode uses `TIME_SERIES_DAILY` compact responses as the real daily
price-and-volume history spine. That drives trend, volatility, breadth,
relative strength, historical market states, and the trend charts where data is
available. The app now stores synced symbol history and sync metadata locally so
repeat opens and refreshes can read from the local store before touching the
vendor again. Fundamentals, analyst revisions, options-style risk, and labeled
research outcomes are still explicit fallback inputs until those feeds are
connected.

For Flutter web/Chrome, run the local proxy first because Alpha Vantage does not
send browser-friendly CORS headers and several free sources are easier to use
through one cache:

```bash
flutter build web --release \
  --dart-define=ORACLE_CORS_PROXY_PREFIX=http://127.0.0.1:8787/proxy?url=

dart run tool/backend_cache_server.dart --port 8787 --web-root build/web
```

Then open `http://127.0.0.1:8787`. The backend cache exposes
`/proxy?url=...`, `/health`, and `/cache/status`, and stores cached responses
under `.dart_tool/market_data_cache`.

## Desktop app track

The project also has a native Windows desktop track. This uses the same Flutter
codebase and same decision engine, but runs as `FinanceOracle.exe` instead of a
Chrome-served web build.

Windows desktop builds require Visual Studio with the **Desktop development
with C++** workload installed. `flutter doctor -v` will report this under
`Visual Studio - develop Windows apps`.

```powershell
.\tool\run_windows_desktop.ps1
```

To create a release build:

```powershell
.\tool\build_windows_desktop.ps1
```

The release executable is written to:

```text
build\windows\x64\runner\Release\FinanceOracle.exe
```

Desktop builds do not need the browser CORS proxy by default. If
`ORACLE_CORS_PROXY_PREFIX` is not explicitly supplied, the native app calls free
data sources directly and stores Alpha Vantage history plus market snapshots in
the platform application-support directory. The Chrome/web track can keep using
the local proxy/cache for browser compatibility.

Available modes:

- `fixture`
- `live-preferred`
- `live-required`
- `alpha-vantage`

Expected live endpoint contract:

- `GET /market/environment`
- `GET /market/styles`
- `GET /market/sectors`
- `GET /market/stocks?limit=100`
- `GET /market/history?limit=252`
- `GET /research/validation-windows`

Each endpoint can return either raw JSON matching the app models or an envelope shaped like:

```json
{
  "asOf": "2026-04-22T10:15:00.000Z",
  "source": "oracle-live",
  "detail": "Connected market environment feed.",
  "data": {}
}
```

See [docs/live-data-contract.md](docs/live-data-contract.md) for the full JSON
contract, environment variables, data quality gates, and endpoint validation
workflow.

You can validate a live service before launching the app:

```bash
dart run tool/validate_live_feed_contract.dart --base-url https://your-api.example
```

## Next build steps

- replace the fixture repository with live market, fundamental, and options adapters
- connect a production data service that implements `/market/stocks` and `/market/history`
- grow the validation feed until the model-readiness gates pass
- add trained model candidates only after point-in-time data, labeled outcomes, and shadow tracking are healthy
- add sync and notification delivery for saved workflows

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
