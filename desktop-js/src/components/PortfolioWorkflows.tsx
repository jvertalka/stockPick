import { useState } from 'react'
import { Banknote, GraduationCap, Scale, X } from 'lucide-react'
import {
  markTutorialComplete,
  type LossHarvestCandidate,
  type SectorWeight,
} from './portfolioCalc'

/**
 * Portfolio workflow UI components: tax-loss panel, rebalance panel,
 * tutorial overlay. Calculations + types live in `portfolioCalc.ts`
 * for Fast Refresh compatibility.
 */

export function TaxLossPanel({ candidates }: { candidates: LossHarvestCandidate[] }) {
  if (candidates.length === 0) return null
  return (
    <section className="panel workflow-panel" data-testid="tax-loss-panel">
      <header className="panel-header">
        <div>
          <p>Tax-loss harvest</p>
          <h2>{candidates.length} positions sitting on losses</h2>
        </div>
        <span className="pill caution">
          <Banknote size={12} /> Review with your CPA
        </span>
      </header>
      <p className="workflow-lede">
        Capturing these losses can offset realized gains or up to $3,000 of ordinary income. The
        suggested replacement keeps your sector tilt intact while staying meaningfully different
        from the sold name to avoid wash-sale issues.
      </p>
      <ul className="loss-list">
        {candidates.map((row) => (
          <li key={row.ticker}>
            <div className="loss-head">
              <strong>{row.ticker}</strong>
              <span className="loss-name">{row.name}</span>
              <span className="loss-amount danger">
                {formatCurrency(row.unrealizedLoss)} ({row.unrealizedLossPct.toFixed(1)}%)
              </span>
            </div>
            <div className="loss-detail">
              <span>
                {row.shares.toLocaleString()} sh · cost {formatCurrency(row.costBasis / row.shares)}
                /sh · now worth {formatCurrency(row.marketValue)}
              </span>
            </div>
            {row.replacement ? (
              <div className="loss-replacement">
                <span>Replace with</span>
                <strong>{row.replacement.ticker}</strong>
                <span>{row.replacement.name}</span>
                <span>·</span>
                <span>opp {row.replacement.opportunityScore}</span>
                <span>·</span>
                <span>{row.replacement.reason}</span>
              </div>
            ) : (
              <div className="loss-replacement empty">
                <span>No same-sector replacement clears the buy bar right now.</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function RebalancePanel({
  weights,
  totalValue,
}: {
  weights: SectorWeight[]
  totalValue: number
}) {
  if (weights.length === 0 || totalValue === 0) return null
  const drifted = weights.filter((entry) => Math.abs(entry.driftPct) >= 5)
  return (
    <section className="panel workflow-panel" data-testid="rebalance-panel">
      <header className="panel-header">
        <div>
          <p>Portfolio rebalance</p>
          <h2>{drifted.length} sectors drifted &gt; 5pp from equal weight</h2>
        </div>
        <span className="pill neutral">
          <Scale size={12} /> Equal-weight target
        </span>
      </header>
      <ul className="rebalance-list">
        {weights.map((entry) => {
          const tone =
            Math.abs(entry.driftPct) >= 5
              ? entry.driftPct > 0
                ? 'caution'
                : 'positive'
              : 'neutral'
          return (
            <li className={tone} key={entry.sector}>
              <div className="rebalance-head">
                <strong>{entry.sector}</strong>
                <span>
                  {entry.positions} position{entry.positions === 1 ? '' : 's'}
                </span>
              </div>
              <div className="rebalance-bar">
                <span style={{ width: `${Math.min(100, entry.actualPct)}%` }} />
                <span
                  className="target-marker"
                  style={{ left: `${Math.min(100, entry.targetPct)}%` }}
                />
              </div>
              <div className="rebalance-numbers">
                <span>actual {entry.actualPct.toFixed(1)}%</span>
                <span>target {entry.targetPct.toFixed(1)}%</span>
                <strong className={Math.abs(entry.driftPct) >= 5 ? tone : ''}>
                  {entry.driftPct > 0 ? '+' : ''}
                  {entry.driftPct.toFixed(1)}pp
                </strong>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Welcome to Finance Oracle Workstation',
    body: 'This tool ranks stocks and ETFs by Buy / Hold / Trim / Sell. Today everything is rules-based — no trained models — but the rules are visible and tunable.',
  },
  {
    title: 'Import your portfolio',
    body: 'Click "Import owned" in the topbar. Paste rows like AAPL,40,165.50 to get cost basis, P&L, and tax-loss suggestions. Just AAPL also works for tracking.',
  },
  {
    title: 'Read any decision in 3 seconds',
    body: 'The top-left card always shows the highest-conviction Buy. The "Why" column on the table synthesizes the top reasons. Click any row to expand or open the detail panel.',
  },
  {
    title: 'Power-user shortcuts',
    body: 'Press ? at any time to see all keyboard shortcuts. J/K move the row cursor, Enter marks reviewed, O toggles owned, W toggles watch.',
  },
  {
    title: 'Honest limits',
    body: 'Options-side risk inputs are proxied from price — until a real options feed is wired they are educated guesses. The Path to trained models tab shows what we still need before ML kicks in.',
  },
]

export function TutorialOverlay({ onDismiss }: { onDismiss: () => void }) {
  const [step, setStep] = useState(0)
  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  function close() {
    markTutorialComplete()
    onDismiss()
  }

  return (
    <>
      <div aria-hidden className="drawer-backdrop" onClick={close} />
      <div aria-modal className="tutorial-overlay" role="dialog">
        <header>
          <GraduationCap size={16} />
          <strong>
            {step + 1} of {STEPS.length}
          </strong>
          <button aria-label="Skip tutorial" className="ghost icon-only" onClick={close} type="button">
            <X size={14} />
          </button>
        </header>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <footer>
          <button
            className="ghost"
            disabled={step === 0}
            onClick={() => setStep((current) => current - 1)}
            type="button"
          >
            Back
          </button>
          {isLast ? (
            <button className="primary" onClick={close} type="button">
              Got it
            </button>
          ) : (
            <button className="primary" onClick={() => setStep((current) => current + 1)} type="button">
              Next
            </button>
          )}
        </footer>
      </div>
    </>
  )
}

function formatCurrency(value: number) {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
