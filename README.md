# Finance Oracle

Finance Oracle is a local quantitative decision workstation that answers what
to buy, hold, trim, or sell now. Its default screen is the Executive Brief:
ranked decisions, an options plan, and portfolio state without a wall of quotes.

The canonical product is `desktop-js/` (React + Vite + Tauri), supervised by
the Dart sidecar in `tool/backend_cache_server.dart`. The Flutter application
at the repository root is retained only as a legacy/reference implementation.

## Run and build

From the repository root on Windows, start the complete development workstation
(sidecar plus Vite) with:

```powershell
.\start-workstation.cmd
```

Build the packaged desktop application and its native sidecar with:

```powershell
.\build-desktop.ps1
```

Raw `npm run desktop:*` commands are advanced Tauri commands; they assume the
gitignored sidecar binary has already been compiled. See
[desktop-js/README.md](desktop-js/README.md) for frontend-only and quality
commands.

## Evidence policy

Return/model paths use adjusted-total-return prices while current-price and
execution paths retain raw exchange prices. Directional ML labels are created
only when the model artifact is promoted and each name has synchronized price,
SEC filing, prediction-date, and calibrated-interval evidence. Advisory and
legacy forecasts remain inspectable but cannot replace a proven model or mint
an action.

The complete enforced policy is documented in
[docs/EVIDENCE_QUALITY.md](docs/EVIDENCE_QUALITY.md). The current training
universe is still a current-survivor list, uses dataset-wide sparse-date
fallback preprocessing, and lacks a locked post-selection holdout, so models
trained from it remain advisory by design.

## Verification

```powershell
cd desktop-js
npm ci
npm run quality

cd ..
flutter analyze
flutter test
```

CI runs both gates. Startup quant self-tests also pause recommendations if a
textbook-value check fails.

## Legacy Flutter reference

The root Flutter code and its provider/contract tests remain useful for shared
Dart data logic. They are not the primary UI or packaged runtime. New product
work belongs in `desktop-js/` unless it changes the supervised sidecar or a
shared Dart contract.

## Highest-value next data work

- Acquire a licensed point-in-time security master with dead securities and
  explicit delisting outcomes/returns.
- Lock a final post-feature-selection holdout before model selection begins.
- Persist a content-hashed per-ticker dataset manifest (Yahoo snapshot/cache
  state and SEC filing/accession inputs) so an artifact can be reproduced after
  upstream histories revise.
- Add release-calendar-aware DGS1MO freshness validation beyond the exposed
  FRED observation date and proxy cache state.
- Promote live decay monitoring from display-only to a statistically gated,
  model-fingerprint-specific quarantine/retirement state.
- Add signed or otherwise authenticated model artifacts if authority must cross
  a machine/process trust boundary.
