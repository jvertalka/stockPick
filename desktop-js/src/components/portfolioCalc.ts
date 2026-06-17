import type { DecisionSignal } from '../data/decisionEngine'
import type { StoredHolding } from '../data/storage'

/**
 * Portfolio calculations + types + the digest renderer. Lives outside
 * the components file so the React Fast Refresh rule
 * `react-refresh/only-export-components` is satisfied.
 */

export type LossHarvestCandidate = {
  ticker: string
  name: string
  shares: number
  costBasis: number
  marketValue: number
  unrealizedLoss: number
  unrealizedLossPct: number
  replacement?: { ticker: string; name: string; opportunityScore: number; reason: string }
}

export function computeTaxLossCandidates(
  holdings: StoredHolding[],
  universe: DecisionSignal[],
  ownedTickers: Set<string>,
  threshold = -3,
): LossHarvestCandidate[] {
  const tickerToSignal = new Map(universe.map((row) => [row.ticker, row]))
  const candidates: LossHarvestCandidate[] = []
  for (const holding of holdings) {
    if (!holding.shares || !holding.averageCost || holding.averageCost <= 0) continue
    const signal = tickerToSignal.get(holding.ticker)
    if (!signal?.lastPrice) continue
    const marketValue = holding.shares * signal.lastPrice
    const costBasis = holding.shares * holding.averageCost
    const loss = marketValue - costBasis
    const lossPct = (loss / costBasis) * 100
    if (lossPct > threshold) continue

    const replacement = universe
      .filter(
        (row) =>
          row.sector === signal.sector &&
          row.ticker !== signal.ticker &&
          !ownedTickers.has(row.ticker) &&
          (row.action === 'Buy Now' || row.action === 'Accumulate' || row.action === 'Hold'),
      )
      .sort((left, right) => right.opportunityScore - left.opportunityScore)[0]

    candidates.push({
      ticker: holding.ticker,
      name: signal.name,
      shares: holding.shares,
      costBasis,
      marketValue,
      unrealizedLoss: loss,
      unrealizedLossPct: lossPct,
      replacement: replacement
        ? {
            ticker: replacement.ticker,
            name: replacement.name,
            opportunityScore: replacement.opportunityScore,
            reason: replacement.evidence[0] ?? 'Same-sector peer',
          }
        : undefined,
    })
  }
  return candidates.sort((left, right) => left.unrealizedLossPct - right.unrealizedLossPct)
}

export type SectorWeight = {
  sector: string
  actualPct: number
  targetPct: number
  driftPct: number
  positions: number
}

export function computeSectorWeights(
  holdings: StoredHolding[],
  universe: DecisionSignal[],
): { weights: SectorWeight[]; totalValue: number } {
  const tickerToSignal = new Map(universe.map((row) => [row.ticker, row]))
  const sectorValue = new Map<string, { value: number; positions: number }>()
  let totalValue = 0
  for (const holding of holdings) {
    if (!holding.shares) continue
    const signal = tickerToSignal.get(holding.ticker)
    if (!signal?.lastPrice) continue
    const value = holding.shares * signal.lastPrice
    totalValue += value
    const existing = sectorValue.get(signal.sector) ?? { value: 0, positions: 0 }
    sectorValue.set(signal.sector, {
      value: existing.value + value,
      positions: existing.positions + 1,
    })
  }
  const sectorCount = sectorValue.size
  const targetPct = sectorCount > 0 ? 100 / sectorCount : 0
  const weights: SectorWeight[] = []
  for (const [sector, { value, positions }] of sectorValue.entries()) {
    const actualPct = totalValue > 0 ? (value / totalValue) * 100 : 0
    weights.push({
      sector,
      actualPct,
      targetPct,
      driftPct: actualPct - targetPct,
      positions,
    })
  }
  weights.sort((left, right) => Math.abs(right.driftPct) - Math.abs(left.driftPct))
  return { weights, totalValue }
}

const TUTORIAL_KEY = 'finance-oracle:tutorial-done'

export function shouldShowTutorial(): boolean {
  try {
    return window.localStorage.getItem(TUTORIAL_KEY) !== '1'
  } catch {
    return false
  }
}

export function markTutorialComplete(): void {
  try {
    window.localStorage.setItem(TUTORIAL_KEY, '1')
  } catch {
    // ignore
  }
}

export function exportWeeklyDigest(opts: {
  topBuys: DecisionSignal[]
  topRisks: DecisionSignal[]
  ownedRows: DecisionSignal[]
  sectorWeights: SectorWeight[]
  totalValue: number
  pnl: number | null
  pnlPct: number | null
  asOf: string
}) {
  const win = window.open('', '_blank', 'width=900,height=1100')
  if (!win) return false
  const html = renderDigestHtml(opts)
  win.document.open()
  win.document.write(html)
  win.document.close()
  window.setTimeout(() => {
    try {
      win.focus()
      win.print()
    } catch {
      // ignore — user can hit Cmd/Ctrl+P manually
    }
  }, 400)
  return true
}

function renderDigestHtml(opts: {
  topBuys: DecisionSignal[]
  topRisks: DecisionSignal[]
  ownedRows: DecisionSignal[]
  sectorWeights: SectorWeight[]
  totalValue: number
  pnl: number | null
  pnlPct: number | null
  asOf: string
}) {
  const dateLabel = new Date(opts.asOf).toLocaleDateString()
  const buyRows = opts.topBuys
    .slice(0, 10)
    .map(
      (row) => `
        <tr>
          <td><strong>${row.ticker}</strong> ${escape(row.name)}</td>
          <td>${row.action}</td>
          <td class="num">${row.opportunityScore}</td>
          <td class="num">${row.riskScore}</td>
          <td>${escape(row.evidence[0] ?? '')}</td>
        </tr>`,
    )
    .join('')
  const riskRows = opts.topRisks
    .slice(0, 10)
    .map(
      (row) => `
        <tr>
          <td><strong>${row.ticker}</strong> ${escape(row.name)}</td>
          <td>${row.action}</td>
          <td class="num">${row.opportunityScore}</td>
          <td class="num">${row.riskScore}</td>
          <td>${escape(row.riskFlags[0] ?? '')}</td>
        </tr>`,
    )
    .join('')
  const ownedRows = opts.ownedRows
    .slice(0, 30)
    .map(
      (row) => `
        <tr>
          <td><strong>${row.ticker}</strong></td>
          <td>${row.action}</td>
          <td class="num">${row.opportunityScore}</td>
          <td class="num">${row.riskScore}</td>
          <td>${escape(row.evidence[0] ?? '')}</td>
        </tr>`,
    )
    .join('')
  const sectorRows = opts.sectorWeights
    .map(
      (row) => `
        <tr>
          <td>${escape(row.sector)}</td>
          <td class="num">${row.actualPct.toFixed(1)}%</td>
          <td class="num">${row.targetPct.toFixed(1)}%</td>
          <td class="num">${row.driftPct > 0 ? '+' : ''}${row.driftPct.toFixed(1)}pp</td>
        </tr>`,
    )
    .join('')
  const pnlBlock =
    opts.pnl != null
      ? `<p><strong>Total value:</strong> $${opts.totalValue.toLocaleString()} · <strong>Unrealized P&amp;L:</strong> ${opts.pnl >= 0 ? '+' : ''}$${Math.abs(opts.pnl).toLocaleString()} (${opts.pnlPct?.toFixed(1)}%)</p>`
      : `<p><strong>Total value:</strong> $${opts.totalValue.toLocaleString()} · <em>Add cost basis to see P&amp;L</em></p>`
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Finance Oracle Digest — ${dateLabel}</title>
<style>
  body { font-family: 'Inter', -apple-system, system-ui, sans-serif; color: #1c1d18; margin: 32px; max-width: 760px; line-height: 1.45; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #d6d2c5; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; vertical-align: top; }
  th { background: #f3f1ea; border-bottom: 1px solid #d6d2c5; }
  tr + tr td { border-top: 1px solid #ece9de; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .meta { color: #6a6759; font-size: 12px; }
  @media print { body { margin: 24px; max-width: 100%; } button { display: none; } }
</style>
</head>
<body>
  <h1>Finance Oracle weekly digest</h1>
  <p class="meta">Generated ${dateLabel}. This is a rules-based ranking, not investment advice.</p>
  <h2>Portfolio summary</h2>
  ${pnlBlock}
  ${ownedRows ? `<table><thead><tr><th>Ticker</th><th>Action</th><th>Opp</th><th>Risk</th><th>Why</th></tr></thead><tbody>${ownedRows}</tbody></table>` : '<p>No tracked positions yet.</p>'}
  <h2>Sector mix</h2>
  ${sectorRows ? `<table><thead><tr><th>Sector</th><th>Actual</th><th>Target</th><th>Drift</th></tr></thead><tbody>${sectorRows}</tbody></table>` : '<p>No sectors yet.</p>'}
  <h2>Top buy candidates</h2>
  ${buyRows ? `<table><thead><tr><th>Name</th><th>Action</th><th>Opp</th><th>Risk</th><th>Why</th></tr></thead><tbody>${buyRows}</tbody></table>` : '<p>No buy candidates clear the bar.</p>'}
  <h2>Biggest risks</h2>
  ${riskRows ? `<table><thead><tr><th>Name</th><th>Action</th><th>Opp</th><th>Risk</th><th>Concern</th></tr></thead><tbody>${riskRows}</tbody></table>` : '<p>No deterioration clusters detected.</p>'}
  <p class="meta">Print this page (Cmd/Ctrl+P) to save as PDF or email.</p>
</body></html>`
}

// Re-exported from PortfolioWorkflows so the hook isn't an extra
// non-component export in the components file.
import { useMemo } from 'react'

export function usePortfolioWorkflows(
  holdings: StoredHolding[],
  universe: DecisionSignal[],
  ownedTickers: Set<string>,
) {
  return useMemo(() => {
    const lossCandidates = computeTaxLossCandidates(holdings, universe, ownedTickers)
    const { weights, totalValue } = computeSectorWeights(holdings, universe)
    return { lossCandidates, weights, totalValue }
  }, [holdings, universe, ownedTickers])
}

function escape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
