# Data sources & rate-limit budget

The Finance Oracle app reads from three production data adapters, with a
fixture-fallback layer so the engine never starves. This document explains
what each source provides, its limits, and how to expand coverage.

## Currently wired

| Source | Auth | Rate limit | Coverage | Status |
|---|---|---|---|---|
| **Alpha Vantage** | API key | Free: 25 req/day · Premium: 75+/min | Daily OHLCV; FX, crypto, some fundamentals on paid tiers | Primary |
| **Yahoo Finance** | None | Generous, unofficial | Daily OHLCV, intraday on most symbols | Probe / secondary |
| **Stooq** | None | Gentle | Daily OHLCV via CSV | Probe / secondary |
| **Fixture** | None | n/a | Hardcoded universe + research replay history | Fallback |

The Universe today is **100 S&P 100 names** in `lib/src/data/local_secrets.dart`
(gitignored), rotating through Alpha Vantage's daily quota.

## Rate-limit math

Free Alpha Vantage covers about 25 fresh symbols per day. With a 100-symbol
universe, the adapter rotates: every name gets a fresh pull every ~4 days.
Stocks not refreshed today fall back to the local archive (last good
snapshot) or the deterministic enrichment layer.

To break out of the rotation throttle, in priority order:

1. Upgrade Alpha Vantage to Premium ($49.99/mo for 75 req/min) — covers 100
   stocks fully in under 2 minutes, plus extra endpoints like company
   overview, earnings, income statement.
2. Add Finnhub (free 60/min). Set `kFinnhubApiKey` in `local_secrets.dart`
   and we'll wire up a Finnhub adapter (fundamentals, recommendation trends,
   news sentiment).
3. Add Tiingo ($10/mo unlimited daily EOD).
4. Add Polygon ($29/mo Starter) — broader coverage including options.

## Provider responsibilities

| Engine input | Today's source | Production source |
|---|---|---|
| Daily prices, volume | Alpha Vantage (where covered) → fixture | Alpha Vantage Premium / Polygon / Tiingo |
| Sector / industry classification | Hardcoded in fixture | Refinitiv / FactSet / Polygon ticker reference |
| Earnings revisions, estimates | Faked from existing values via enrichment | FactSet / Refinitiv / Zacks / Estimize |
| Margin / FCF / balance sheet | Faked from enrichment | SEC EDGAR (free!) / FactSet / FMP |
| IV rank / skew / gamma / flow | Faked from enrichment | CBOE DataShop / OPRA / broker chains |
| Macro (credit spreads, conditions) | Hardcoded fixture | FRED (free) + ICE / Markit |
| Forward returns (validation labels) | Hardcoded fixture | Computed point-in-time from real prices |

Anywhere "faked from enrichment" appears, the values are deterministic
derivations from existing fields — internally consistent but not real
market data. Replacing those is the gating work for trained models.

## Setting up local secrets

1. Copy `lib/src/data/local_secrets.example.dart` to
   `lib/src/data/local_secrets.dart`.
2. Fill in your keys.
3. Restart the app. The configuration loader auto-detects keys at startup.

The file is gitignored — never committed.

## Adding a new provider

1. Build an adapter in `lib/src/data/<name>_feed_provider.dart` returning
   `FeedSlice<...>` results.
2. Plug it into `provider_market_repository.dart`, either as the primary
   provider or as a supplemental probe in `supplementalLoader`.
3. Surface its connection status in the data-readiness UI by emitting a
   `DataFeedStatus` from `loadSupplementalFeedStatuses`.

## Roadmap from MVP to trained models

The `ValidationEngine.modelReadiness.gates` already exposes the five gates:

1. Archived snapshots >= 200 (calendar-time only)
2. Stock universe >= 100 (done)
3. Validation windows >= 30 (needs labeled forward returns)
4. Labeled outcomes >= 80% (requires real point-in-time prices)
5. Integrity checks green (no leakage detected by the validation harness)

- Phase 1 (price spine): Alpha Vantage Premium / Finnhub / Polygon. ~2 weeks.
- Phase 2 (PIT history): 6 months of calendar time minimum.
- Phase 3 (shadow models): 2-3 months of A/B vs. rules baseline.
- Phase 4 (promote winners): only after Phase 3 calibration data exists.
