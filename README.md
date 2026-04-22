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

- raw market, sector, stock, and options-like inputs live in a repository layer
- a rules-based engine derives regimes, stock rankings, sell alerts, and scenarios
- a point-in-time snapshot archive now stores repository states locally
- a fixture walk-forward validation pass reports hit rate, alpha, and drawdown stats
- the research harness now surfaces chronological train/test splits and per-window breakdowns
- the shell can manually refresh the repository and surfaces feed refresh cadence

This is a better foundation than a handwritten final snapshot, but it is still not a live or trained system yet.

## Run

```bash
flutter pub get
flutter run
```

## Next build steps

- replace the fixture repository with live market, fundamental, and options adapters
- upgrade the local snapshot archive into a true vendor-backed point-in-time history
- add a research harness for backtests, calibration, and slippage-aware evaluation
- add persisted watchlists, action history, sync, and notification delivery

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
