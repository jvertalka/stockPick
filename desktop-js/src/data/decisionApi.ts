import {
  marketContext,
  rawSignals,
  type Action,
  type MarketContext,
  type RawSignal,
} from './decisionEngine'

export type DecisionSummary = {
  ticker: string
  action: Action
  opportunityScore: number
  confidence: number
  riskScore: number
  fragilityScore: number
  thesisDamage: number
  riskPriority?: number
}

export type DecisionHistoryPoint = {
  asOf: string
  universeSize: number
  returned: number
  scenario: string
  topBuy?: DecisionSummary | null
  topRisk?: DecisionSummary | null
  actionCounts?: Partial<Record<Action, number>>
  priceCoverage?: PriceCoverage
}

export type PriceCoverage = {
  cachedSymbolCount: number
  usableSymbolCount: number
  freshSymbolCount: number
  staleSymbolCount: number
  totalBarCount: number
  latestPriceDate?: string | null
  oldestPriceDate?: string | null
}

export type PriceSyncResult = {
  mode: string
  requested: number
  updated: number
  failed: number
  updatedSymbols: string[]
  failedSymbols: string[]
  durationMs: number
  lastSyncAt?: string | null
}

export type DecisionUniverseResponse = {
  asOf: string
  source: string
  detail: string
  dataMode: 'backend' | 'fallback'
  universeSize: number
  returned: number
  scenario: string
  marketContext: Partial<MarketContext>
  rawSignals: RawSignal[]
  history: DecisionHistoryPoint[]
  actionCounts: Partial<Record<Action, number>>
  priceCoverage: PriceCoverage
  sync: PriceSyncResult
  portfolio: {
    ownedTickers: string[]
    ownedCount: number
    watchTickers: string[]
    watchCount: number
  }
  errorMessage?: string
}

type LoadUniverseOptions = {
  ownedTickers?: string[]
  watchTickers?: string[]
  syncMode?: 'auto' | 'force' | 'off'
  syncLimit?: number
  timeoutMs?: number
}

const defaultBackendUrl = 'http://127.0.0.1:8787'

export async function loadDecisionUniverse({
  ownedTickers = [],
  watchTickers = [],
  syncMode = 'auto',
  syncLimit = syncMode === 'force' ? 96 : 24,
  timeoutMs = syncMode === 'force' ? 20000 : 9000,
}: LoadUniverseOptions = {}): Promise<DecisionUniverseResponse> {
  try {
    const url = new URL('/decision/universe', backendBaseUrl())
    url.searchParams.set('limit', '0')
    url.searchParams.set('historyLimit', '8')
    url.searchParams.set('sync', syncMode)
    url.searchParams.set('syncLimit', `${syncLimit}`)
    if (ownedTickers.length > 0) {
      url.searchParams.set('owned', ownedTickers.join(','))
    }
    if (watchTickers.length > 0) {
      url.searchParams.set('watch', watchTickers.join(','))
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
    } finally {
      window.clearTimeout(timeout)
    }

    if (!response.ok) {
      throw new Error(`Decision endpoint returned ${response.status}`)
    }

    const payload = (await response.json()) as Partial<DecisionUniverseResponse>
    if (!Array.isArray(payload.rawSignals) || payload.rawSignals.length === 0) {
      throw new Error('Decision endpoint returned no raw signals')
    }

    return {
      asOf: stringOrNow(payload.asOf),
      source: payload.source ?? 'finance-oracle-backend-cache',
      detail: payload.detail ?? 'Backend decision universe loaded.',
      dataMode: 'backend',
      universeSize: numberOr(payload.universeSize, payload.rawSignals.length),
      returned: numberOr(payload.returned, payload.rawSignals.length),
      scenario: payload.scenario ?? 'base',
      marketContext: payload.marketContext ?? {},
      rawSignals: payload.rawSignals as RawSignal[],
      history: Array.isArray(payload.history) ? payload.history : [],
      actionCounts: payload.actionCounts ?? {},
      priceCoverage: normalizeCoverage(payload.priceCoverage),
      sync: normalizeSync(payload.sync),
      portfolio: normalizePortfolio(payload.portfolio, ownedTickers, watchTickers),
    }
  } catch (error) {
    return fallbackUniverse(error, ownedTickers, watchTickers)
  }
}

function backendBaseUrl() {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? defaultBackendUrl
}

function fallbackUniverse(
  error: unknown,
  ownedTickers: string[],
  watchTickers: string[],
): DecisionUniverseResponse {
  const message = error instanceof Error ? error.message : 'Backend decision endpoint unavailable'
  const now = new Date().toISOString()
  return {
    asOf: now,
    source: 'local-fallback',
    detail: 'Using the bundled local signal universe until the backend cache is reachable.',
    dataMode: 'fallback',
    universeSize: rawSignals.length,
    returned: rawSignals.length,
    scenario: 'base',
    marketContext,
    rawSignals,
    history: [],
    actionCounts: {},
    priceCoverage: emptyCoverage(),
    sync: {
      mode: 'fallback',
      requested: 0,
      updated: 0,
      failed: 0,
      updatedSymbols: [],
      failedSymbols: [],
      durationMs: 0,
      lastSyncAt: null,
    },
    portfolio: normalizePortfolio(undefined, ownedTickers, watchTickers),
    errorMessage: message,
  }
}

function normalizePortfolio(
  portfolio: DecisionUniverseResponse['portfolio'] | undefined,
  ownedTickers: string[],
  watchTickers: string[],
) {
  const owned = Array.isArray(portfolio?.ownedTickers)
    ? portfolio.ownedTickers
    : ownedTickers
  const watched = Array.isArray(portfolio?.watchTickers)
    ? portfolio.watchTickers
    : watchTickers
  const normalized = owned.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)
  const normalizedWatch = watched.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)
  return {
    ownedTickers: normalized,
    ownedCount: numberOr(portfolio?.ownedCount, normalized.length),
    watchTickers: normalizedWatch,
    watchCount: numberOr(portfolio?.watchCount, normalizedWatch.length),
  }
}

function normalizeCoverage(value: PriceCoverage | undefined): PriceCoverage {
  if (!value) return emptyCoverage()
  return {
    cachedSymbolCount: numberOr(value.cachedSymbolCount, 0),
    usableSymbolCount: numberOr(value.usableSymbolCount, 0),
    freshSymbolCount: numberOr(value.freshSymbolCount, 0),
    staleSymbolCount: numberOr(value.staleSymbolCount, 0),
    totalBarCount: numberOr(value.totalBarCount, 0),
    latestPriceDate: typeof value.latestPriceDate === 'string' ? value.latestPriceDate : null,
    oldestPriceDate: typeof value.oldestPriceDate === 'string' ? value.oldestPriceDate : null,
  }
}

function normalizeSync(value: PriceSyncResult | undefined): PriceSyncResult {
  return {
    mode: value?.mode ?? 'unknown',
    requested: numberOr(value?.requested, 0),
    updated: numberOr(value?.updated, 0),
    failed: numberOr(value?.failed, 0),
    updatedSymbols: Array.isArray(value?.updatedSymbols) ? value.updatedSymbols : [],
    failedSymbols: Array.isArray(value?.failedSymbols) ? value.failedSymbols : [],
    durationMs: numberOr(value?.durationMs, 0),
    lastSyncAt: typeof value?.lastSyncAt === 'string' ? value.lastSyncAt : null,
  }
}

function emptyCoverage(): PriceCoverage {
  return {
    cachedSymbolCount: 0,
    usableSymbolCount: 0,
    freshSymbolCount: 0,
    staleSymbolCount: 0,
    totalBarCount: 0,
    latestPriceDate: null,
    oldestPriceDate: null,
  }
}

function stringOrNow(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : new Date().toISOString()
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
