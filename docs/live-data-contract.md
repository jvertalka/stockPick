# Live Data Contract

Finance Oracle can run against connected HTTP feeds by setting `ORACLE_DATA_MODE`
to `live-preferred` or `live-required`. Connected feeds should expose one
snapshot-oriented API surface so the app can score the current market, archive
point-in-time history, and validate the research stack without changing the
rules engine.

The app can also run in `alpha-vantage` mode when you want a free connected
price-history spine before building a custom backend. In that mode the app
fetches Alpha Vantage `TIME_SERIES_DAILY` compact OHLCV responses, caches them
into a durable local store, respects the configured daily request budget,
surfaces sync cadence and local coverage in the UI, and marks fundamentals,
revisions, options-like inputs, and validation labels as fallback data.

## Environment

```bash
flutter run \
  --dart-define=ORACLE_DATA_MODE=live-preferred \
  --dart-define=ORACLE_DATA_BASE_URL=https://your-api.example \
  --dart-define=ORACLE_DATA_API_TOKEN=optional-token \
  --dart-define=ORACLE_STOCK_UNIVERSE_LIMIT=100 \
  --dart-define=ORACLE_HISTORICAL_SNAPSHOT_LIMIT=252
```

Use `live-required` when you want missing or malformed endpoints to fail fast.
Use `live-preferred` when you want the app to fall back to fixture data while
you are bringing endpoints online.

For Alpha Vantage daily price history:

```bash
flutter run \
  --dart-define=ORACLE_DATA_MODE=alpha-vantage \
  --dart-define=ORACLE_ALPHA_VANTAGE_API_KEY=your-alpha-vantage-key \
  --dart-define=ORACLE_ALPHA_VANTAGE_SYMBOLS=NVDA,MSFT,AVGO,JPM,LLY \
  --dart-define=ORACLE_ALPHA_VANTAGE_BENCHMARK=SPY \
  --dart-define=ORACLE_ALPHA_VANTAGE_DAILY_LIMIT=25 \
  --dart-define=ORACLE_ALPHA_VANTAGE_SYNC_INTERVAL_MINUTES=20 \
  --dart-define=ORACLE_STOCK_UNIVERSE_LIMIT=25 \
  --dart-define=ORACLE_HISTORICAL_SNAPSHOT_LIMIT=100
```

If `ORACLE_ALPHA_VANTAGE_SYMBOLS` is omitted, the app starts with a default
large-cap watchlist and limits first-run network requests so the benchmark plus
stocks fit the daily request budget. Cached symbols continue to be used even
after the budget is spent.

The sync interval controls when the app is allowed to try the vendor again
after a sync attempt. Between those windows, the app reads from the local store
first instead of repeatedly burning quota on every refresh.

For web/Chrome runs, use the local proxy because Alpha Vantage does not ship
permissive CORS headers:

```bash
dart run tool/alpha_vantage_proxy_server.dart --port=8081

flutter run -d web-server \
  --web-hostname 127.0.0.1 \
  --web-port 54123 \
  --dart-define=ORACLE_DATA_MODE=alpha-vantage \
  --dart-define=ORACLE_ALPHA_VANTAGE_API_KEY=your-alpha-vantage-key \
  --dart-define=ORACLE_ALPHA_VANTAGE_PROXY_URL=http://127.0.0.1:8081/query
```

## Envelope

Every endpoint may return either the raw payload directly or this envelope:

```json
{
  "asOf": "2026-04-22T10:15:00.000Z",
  "source": "vendor-or-internal-feed-name",
  "detail": "Human-readable feed status.",
  "data": {}
}
```

`asOf` should be the timestamp of the data, not the request time.

## Endpoints

### `GET /market/environment`

Returns one `RawMarketEnvironment`.

Required numeric fields:

```json
{
  "indexTrend": 81,
  "realizedVolatility": 54,
  "impliedVolatility": 52,
  "creditStress": 28,
  "financialConditions": 73,
  "growthLeadership": 77,
  "defensiveLeadership": 34,
  "smallCapLeadership": 49,
  "inflationPressure": 37,
  "breadth": 72,
  "advanceDecline": 70,
  "newHighLow": 67,
  "percentAboveMajorAverages": 75,
  "equalWeightConfirmation": 61,
  "sectorParticipation": 71,
  "correlation": 43,
  "dispersion": 58,
  "volumeConcentration": 60
}
```

### `GET /market/styles`

Returns a list of style signals:

```json
[
  {
    "style": "Large-cap growth",
    "strength": 80,
    "note": "Growth remains the strongest factor bucket."
  }
]
```

### `GET /market/sectors`

Returns a list of sector signals:

```json
[
  {
    "sector": "Technology",
    "strength": 88,
    "breadth": 81,
    "revisions": 83,
    "sponsorship": 86,
    "crowdingRisk": 72,
    "note": "Technology leadership is broad but crowded."
  }
]
```

### `GET /market/stocks?limit=100`

Returns the current stock universe. The app ranks every returned stock and only
surfaces the highest-ranked names as top opportunities.

```json
[
  {
    "ticker": "NVDA",
    "company": "NVIDIA",
    "sector": "Technology",
    "industry": "Semiconductors",
    "shortTrend": 91,
    "mediumTrend": 89,
    "longTrend": 87,
    "residualStrength": 92,
    "momentumPersistence": 88,
    "breakoutQuality": 84,
    "volumeSupport": 82,
    "earningsRevisions": 87,
    "earningsSurprise": 83,
    "marginTrend": 80,
    "revenueTrend": 89,
    "freeCashFlowTrend": 82,
    "balanceSheetQuality": 84,
    "profitability": 93,
    "leverageQuality": 81,
    "earningsStability": 78,
    "valuationSupport": 60,
    "crowdingRisk": 76,
    "impliedVolRank": 69,
    "realizedImpliedGap": 7,
    "putSkewChange": 62,
    "eventPremium": 58,
    "downsideProtectionDemand": 65,
    "relativeStrengthDelta": 64,
    "sectorBreadthDelta": 62,
    "revisionDelta": 68,
    "priceResponse": 59,
    "abnormalDownVolume": 41,
    "volatilityRepricing": 47,
    "peerLeadership": 77,
    "growthExposure": 92,
    "defensiveExposure": 16,
    "creditSensitivity": 33,
    "rateSensitivity": 70,
    "expectedStability": 72,
    "peers": [
      {
        "ticker": "AVGO",
        "company": "Broadcom",
        "relativeStrength": 81,
        "revisionTrend": 74,
        "crowdingScore": 83
      }
    ]
  }
]
```

### `GET /market/history?limit=252`

Returns historical `RawMarketState` snapshots in chronological order. Each item
must include `asOf`, `environment`, `styles`, `sectors`, and `stocks`.

```json
[
  {
    "asOf": "2026-04-21T10:15:00.000Z",
    "environment": {},
    "styles": [],
    "sectors": [],
    "stocks": []
  }
]
```

The app archives these snapshots before scoring the current state, then computes
trend charts from the durable archive.

### `GET /research/validation-windows`

Returns labeled historical windows for backtesting and calibration. Each window
contains a point-in-time market state plus later realized outcomes.

```json
[
  {
    "asOf": "2026-02-14T00:00:00.000Z",
    "marketState": {
      "asOf": "2026-02-14T00:00:00.000Z",
      "environment": {},
      "styles": [],
      "sectors": [],
      "stocks": []
    },
    "outcomes": [
      {
        "ticker": "NVDA",
        "forwardReturn20d": 3.1,
        "sectorReturn20d": 1.4,
        "maxDrawdown20d": -6.0
      }
    ]
  }
]
```

## Data Quality Gates

The app now reports model-readiness separately from fixture validation. Treat the
system as ML-ready only after the connected data reaches these minimums:

- At least `252` archived point-in-time market snapshots.
- At least `100` stocks in the current ranked universe.
- At least `20` validation windows.
- At least `500` labeled stock outcomes.
- Chronological validation windows with no duplicate as-of dates.

These are minimum safety gates, not a guarantee that the model is good.

## Validate a Candidate Feed

Before pointing the app at a new service, run:

```bash
dart run tool/validate_live_feed_contract.dart --base-url https://your-api.example
```

The validator fetches every required endpoint, parses each payload using the same
raw model contracts as the app, and fails fast on missing fields, malformed
numbers, non-2xx responses, or invalid timestamps.
