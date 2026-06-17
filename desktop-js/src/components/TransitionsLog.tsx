import { useEffect, useState } from 'react'
import { ArrowRight, Activity } from 'lucide-react'
import { getDecisionLog } from '../data/storage'

/**
 * Aggregates the decision-history log across the user's owned + watched
 * tickers and surfaces the most recent action transitions. Answers "what
 * changed in my portfolio over the last few days?" without forcing the
 * user to click through each ticker's detail panel.
 */

type Transition = {
  ticker: string
  fromAction: string
  toAction: string
  asOf: string
  reason: string
}

export function TransitionsLog({
  ownedTickers,
  watchTickers,
}: {
  ownedTickers: Set<string>
  watchTickers: Set<string>
}) {
  const [transitions, setTransitions] = useState<Transition[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const tickers = [...new Set([...ownedTickers, ...watchTickers])]
      if (tickers.length === 0) {
        if (!cancelled) {
          setTransitions([])
          setLoading(false)
        }
        return
      }
      const all: Transition[] = []
      for (const ticker of tickers) {
        const log = await getDecisionLog(ticker)
        for (let i = 1; i < log.length; i++) {
          const prev = log[i - 1]
          const curr = log[i]
          if (prev.action !== curr.action) {
            all.push({
              ticker,
              fromAction: prev.action,
              toAction: curr.action,
              asOf: curr.asOf,
              reason: curr.reason,
            })
          }
        }
      }
      if (cancelled) return
      all.sort((left, right) => right.asOf.localeCompare(left.asOf))
      setTransitions(all.slice(0, 25))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [ownedTickers, watchTickers])

  if (loading) {
    return (
      <section className="panel workflow-panel" data-testid="transitions-log">
        <header className="panel-header">
          <div>
            <p>Recent transitions</p>
            <h2>Loading watchlist history…</h2>
          </div>
        </header>
      </section>
    )
  }

  if (transitions.length === 0) {
    return (
      <section className="panel workflow-panel" data-testid="transitions-log">
        <header className="panel-header">
          <div>
            <p>Recent transitions</p>
            <h2>No action changes logged yet</h2>
          </div>
          <span className="pill neutral">
            <Activity size={12} /> Empty
          </span>
        </header>
        <p className="workflow-lede">
          The transition log fills in as the engine re-ranks over time. Each
          time an owned or watched ticker's action label flips (Hold → Trim,
          Buy → Hold, etc.) it lands here. Come back tomorrow.
        </p>
      </section>
    )
  }

  return (
    <section className="panel workflow-panel" data-testid="transitions-log">
      <header className="panel-header">
        <div>
          <p>Recent transitions</p>
          <h2>
            {transitions.length} action change{transitions.length === 1 ? '' : 's'} on watchlist
          </h2>
        </div>
        <span className="pill neutral">
          <Activity size={12} /> Aggregated
        </span>
      </header>
      <ol className="transitions-list">
        {transitions.map((entry, idx) => (
          <li key={`${entry.ticker}-${entry.asOf}-${idx}`}>
            <div className="transition-row">
              <strong>{entry.ticker}</strong>
              <span className={`pill ${pillTone(entry.fromAction)}`}>{entry.fromAction}</span>
              <ArrowRight size={12} />
              <span className={`pill ${pillTone(entry.toAction)}`}>{entry.toAction}</span>
              <span className="transition-date">{formatRelative(entry.asOf)}</span>
            </div>
            <span className="transition-reason">{entry.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function pillTone(action: string): string {
  if (action === 'Buy Now' || action === 'Accumulate') return 'positive'
  if (action === 'Trim') return 'caution'
  if (action === 'Sell' || action === 'Avoid') return 'danger'
  return 'neutral'
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
