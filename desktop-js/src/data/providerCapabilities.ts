/**
 * Provider capabilities — which live data feeds the backend has a token for.
 *
 * Tokens used to be baked into this browser bundle as VITE_* env vars, so
 * anyone with the app could read them out of the shipped JavaScript. They now
 * live server-side (backend `local_secrets.dart` / environment variables) and
 * the backend proxy injects them onto the upstream request. The frontend never
 * sees a token; it only asks the backend "which providers are wired?" via
 * GET /config/providers (booleans only) and switches features on accordingly.
 *
 * The fetch is async but every caller stayed synchronous, so we cache the
 * result in a module-level snapshot: before the first load resolves everything
 * reads as "not configured" (features simply light up a beat later, which is
 * fine — the backend warms for ~a minute on boot anyway).
 */

export type ProviderName = 'finnhub' | 'tradier' | 'polygon' | 'fred'

export type ProviderCapabilities = {
  finnhub: boolean
  tradier: boolean
  polygon: boolean
  fred: boolean
  tradierEnv: 'sandbox' | 'production'
}

const EMPTY: ProviderCapabilities = {
  finnhub: false,
  tradier: false,
  polygon: false,
  fred: false,
  tradierEnv: 'sandbox',
}

let snapshot: ProviderCapabilities = EMPTY
let loaded = false

function backendUrl(): string {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
}

/** Fetch the capability map from the backend and cache it. Safe to call more
 * than once (e.g. after the backend finishes warming up). Never throws. */
export async function loadProviderCapabilities(): Promise<ProviderCapabilities> {
  try {
    const res = await fetch(`${backendUrl()}/config/providers`)
    if (!res.ok) return snapshot
    const j = (await res.json()) as Partial<ProviderCapabilities>
    snapshot = {
      finnhub: Boolean(j.finnhub),
      tradier: Boolean(j.tradier),
      polygon: Boolean(j.polygon),
      fred: Boolean(j.fred),
      tradierEnv: j.tradierEnv === 'production' ? 'production' : 'sandbox',
    }
    loaded = true
  } catch {
    // Backend not up yet — keep whatever we had; the caller can retry later.
  }
  return snapshot
}

export function providerConfigured(name: ProviderName): boolean {
  return snapshot[name]
}

export function tradierEnvConfigured(): 'sandbox' | 'production' {
  return snapshot.tradierEnv
}

export function providerCapabilitiesLoaded(): boolean {
  return loaded
}
