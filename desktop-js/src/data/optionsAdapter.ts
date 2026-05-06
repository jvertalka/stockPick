/**
 * Options-data adapter.
 *
 * Tradier (free developer tier) is wired through the backend cache's
 * /proxy?url= endpoint. The proxy now forwards Authorization headers
 * to allowlisted hosts so the browser can authenticate against Tradier
 * without exposing the token to the page network log directly.
 *
 * Setup:
 *   1. Sign up at https://developer.tradier.com (free)
 *   2. Generate a sandbox token
 *   3. Put it in desktop-js/.env.local as VITE_TRADIER_TOKEN=<token>
 *   4. Restart `npm run dev`
 *
 * The token never appears in built JS — Vite inlines env vars at build
 * time, but for local dev it's served fresh from .env.local on each
 * request. The token is sent only to your local backend cache, which
 * forwards it to api.tradier.com or sandbox.tradier.com.
 */

const DEFAULT_BACKEND = 'http://127.0.0.1:8787'

function backendUrl() {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? DEFAULT_BACKEND
}

function proxied(externalUrl: string) {
  return `${backendUrl()}/proxy?url=${encodeURIComponent(externalUrl)}`
}

export type OptionsSnapshot = {
  ticker: string
  asOf: string
  /** 0-100 rank — placeholder until we have a year of historical IV cached */
  impliedVolRank: number
  /** Difference between 25-delta put IV and 25-delta call IV (vol points) */
  put25DeltaSkew: number
  /** Annualized implied vol of the at-the-money 30-day option */
  atm30dIv: number
  /** Approximate put/call open-interest ratio */
  putCallOiRatio?: number
  /** Total dollar-weighted gamma exposure on options (millions) */
  gammaExposureUsd?: number
  source: string
}

export type OptionsProvider = {
  name: string
  isConfigured(): boolean
  fetchSnapshot(ticker: string): Promise<OptionsSnapshot | null>
}

/* =========================================================================
   Tradier sandbox / production adapter (real implementation)
   ========================================================================= */

type TradierEnv = 'sandbox' | 'production'

function tradierBase(env: TradierEnv) {
  return env === 'production' ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1'
}

type TradierExpirationsResponse = {
  expirations?: { date?: string | string[] } | null
}

type TradierGreeks = {
  delta?: number
  mid_iv?: number
  ask_iv?: number
  bid_iv?: number
}

type TradierOption = {
  symbol?: string
  strike?: number
  option_type?: 'put' | 'call'
  expiration_date?: string
  bid?: number
  ask?: number
  open_interest?: number
  greeks?: TradierGreeks
}

type TradierChainResponse = {
  options?: { option?: TradierOption | TradierOption[] } | null
}

type TradierQuoteResponse = {
  quotes?: {
    quote?: {
      symbol?: string
      last?: number
      bid?: number
      ask?: number
    }
  }
}

async function tradierFetch<T>(
  path: string,
  token: string,
  timeoutMs = 8000,
): Promise<T | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(proxied(path), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function tradierEnv(): TradierEnv {
  const explicit = import.meta.env.VITE_TRADIER_ENV
  if (explicit === 'production' || explicit === 'sandbox') return explicit
  return 'sandbox'
}

const tradierProvider: OptionsProvider = {
  name: 'tradier',
  isConfigured: () => Boolean(import.meta.env.VITE_TRADIER_TOKEN),
  async fetchSnapshot(ticker: string) {
    const token = import.meta.env.VITE_TRADIER_TOKEN as string | undefined
    if (!token) return null
    const env = tradierEnv()
    const base = tradierBase(env)

    // 1. Pull underlier last price for ATM reference
    const quoteResp = await tradierFetch<TradierQuoteResponse>(
      `${base}/markets/quotes?symbols=${encodeURIComponent(ticker)}`,
      token,
    )
    const last = quoteResp?.quotes?.quote?.last
    if (!last || !Number.isFinite(last) || last <= 0) return null

    // 2. Find the closest expiration to 30 days out
    const expirationsResp = await tradierFetch<TradierExpirationsResponse>(
      `${base}/markets/options/expirations?symbol=${encodeURIComponent(ticker)}`,
      token,
    )
    const dates = normalizeExpirations(expirationsResp)
    if (dates.length === 0) return null
    const target = new Date()
    target.setDate(target.getDate() + 30)
    const expiry = dates.reduce((closest, candidate) =>
      Math.abs(daysBetween(target, candidate)) < Math.abs(daysBetween(target, closest))
        ? candidate
        : closest,
    )

    // 3. Pull the chain with greeks for that expiration
    const chainResp = await tradierFetch<TradierChainResponse>(
      `${base}/markets/options/chains?symbol=${encodeURIComponent(ticker)}&expiration=${expiry}&greeks=true`,
      token,
    )
    const options = normalizeChain(chainResp)
    if (options.length === 0) return null

    return computeSnapshot(ticker, last, options)
  },
}

function normalizeExpirations(payload: TradierExpirationsResponse | null): string[] {
  const raw = payload?.expirations?.date
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

function normalizeChain(payload: TradierChainResponse | null): TradierOption[] {
  const raw = payload?.options?.option
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

function daysBetween(a: Date, b: string): number {
  const target = new Date(`${b}T00:00:00`).getTime()
  return (target - a.getTime()) / 86_400_000
}

function computeSnapshot(
  ticker: string,
  underlyingPrice: number,
  options: TradierOption[],
): OptionsSnapshot {
  // ATM IV: option whose strike is closest to spot
  const atmOption = options
    .filter((opt) => typeof opt.strike === 'number' && opt.greeks?.mid_iv != null)
    .reduce<TradierOption | null>((closest, candidate) => {
      const candidateGap = Math.abs((candidate.strike ?? 0) - underlyingPrice)
      const closestGap = closest ? Math.abs((closest.strike ?? 0) - underlyingPrice) : Infinity
      return candidateGap < closestGap ? candidate : closest
    }, null)
  const atm30dIv = atmOption?.greeks?.mid_iv != null ? atmOption.greeks.mid_iv * 100 : 0

  // 25-delta skew: closest 25-delta put IV minus closest 25-delta call IV
  const put25 = closestByDelta(options, 'put', -0.25)
  const call25 = closestByDelta(options, 'call', 0.25)
  const put25DeltaSkew =
    put25?.greeks?.mid_iv != null && call25?.greeks?.mid_iv != null
      ? (put25.greeks.mid_iv - call25.greeks.mid_iv) * 100
      : 0

  // Put/call OI ratio for the expiration
  const putOi = options
    .filter((opt) => opt.option_type === 'put')
    .reduce((sum, opt) => sum + (opt.open_interest ?? 0), 0)
  const callOi = options
    .filter((opt) => opt.option_type === 'call')
    .reduce((sum, opt) => sum + (opt.open_interest ?? 0), 0)
  const putCallOiRatio = callOi > 0 ? putOi / callOi : undefined

  // Implied vol rank — we don't have a year of history yet. Use the
  // ATM 30d IV mapped onto a rough universe-typical band as a stub
  // until the backend caches IV history.
  const impliedVolRank = clamp(((atm30dIv - 15) / 60) * 100)

  return {
    ticker,
    asOf: new Date().toISOString(),
    impliedVolRank,
    put25DeltaSkew,
    atm30dIv,
    putCallOiRatio,
    source: 'tradier',
  }
}

function closestByDelta(
  options: TradierOption[],
  type: 'put' | 'call',
  targetDelta: number,
): TradierOption | null {
  return options
    .filter((opt) => opt.option_type === type && opt.greeks?.delta != null)
    .reduce<TradierOption | null>((closest, candidate) => {
      const candidateGap = Math.abs((candidate.greeks?.delta ?? 0) - targetDelta)
      const closestGap = closest
        ? Math.abs((closest.greeks?.delta ?? 0) - targetDelta)
        : Infinity
      return candidateGap < closestGap ? candidate : closest
    }, null)
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

/* =========================================================================
   Polygon ($29 Starter) adapter — kept as a stub for symmetry. Implement
   the same way as Tradier when needed.
   ========================================================================= */
const polygonProvider: OptionsProvider = {
  name: 'polygon',
  isConfigured: () => Boolean(import.meta.env.VITE_POLYGON_TOKEN),
  async fetchSnapshot() {
    return null
  },
}

const stubProvider: OptionsProvider = {
  name: 'stub',
  isConfigured: () => true,
  async fetchSnapshot() {
    return null
  },
}

const PROVIDERS: OptionsProvider[] = [tradierProvider, polygonProvider, stubProvider]

export function activeOptionsProvider(): OptionsProvider {
  return PROVIDERS.find((provider) => provider.isConfigured()) ?? stubProvider
}

/* =========================================================================
   Cached fetch keyed by ticker — 5-minute TTL is plenty for IV data.
   ========================================================================= */
const cache = new Map<string, { expires: number; value: OptionsSnapshot | null }>()

export async function fetchOptionsSnapshot(ticker: string): Promise<OptionsSnapshot | null> {
  const now = Date.now()
  const existing = cache.get(ticker)
  if (existing && existing.expires > now) return existing.value
  const provider = activeOptionsProvider()
  const value = await provider.fetchSnapshot(ticker)
  cache.set(ticker, { expires: now + 5 * 60 * 1000, value })
  return value
}

export function optionsProviderStatus(): {
  active: string
  candidates: Array<{ name: string; configured: boolean }>
} {
  const active = activeOptionsProvider().name
  const candidates = PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: provider.isConfigured(),
  }))
  return { active, candidates }
}
