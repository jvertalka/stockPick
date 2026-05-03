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
  portfolio: {
    ownedTickers: string[]
    ownedCount: number
  }
  errorMessage?: string
}

type LoadUniverseOptions = {
  ownedTickers?: string[]
  timeoutMs?: number
}

const defaultBackendUrl = 'http://127.0.0.1:8787'

export async function loadDecisionUniverse({
  ownedTickers = [],
  timeoutMs = 6000,
}: LoadUniverseOptions = {}): Promise<DecisionUniverseResponse> {
  try {
    const url = new URL('/decision/universe', backendBaseUrl())
    url.searchParams.set('limit', '0')
    url.searchParams.set('historyLimit', '8')
    if (ownedTickers.length > 0) {
      url.searchParams.set('owned', ownedTickers.join(','))
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
      portfolio: normalizePortfolio(payload.portfolio, ownedTickers),
    }
  } catch (error) {
    return fallbackUniverse(error, ownedTickers)
  }
}

function backendBaseUrl() {
  return import.meta.env.VITE_ORACLE_BACKEND_URL ?? defaultBackendUrl
}

function fallbackUniverse(error: unknown, ownedTickers: string[]): DecisionUniverseResponse {
  const message = error instanceof Error ? error.message : 'Backend decision endpoint unavailable'
  return {
    asOf: new Date().toISOString(),
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
    portfolio: normalizePortfolio(undefined, ownedTickers),
    errorMessage: message,
  }
}

function normalizePortfolio(
  portfolio: DecisionUniverseResponse['portfolio'] | undefined,
  ownedTickers: string[],
) {
  const owned = Array.isArray(portfolio?.ownedTickers)
    ? portfolio.ownedTickers
    : ownedTickers
  const normalized = owned.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)
  return {
    ownedTickers: normalized,
    ownedCount: numberOr(portfolio?.ownedCount, normalized.length),
  }
}

function stringOrNow(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : new Date().toISOString()
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
