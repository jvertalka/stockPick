import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import type { DecisionSignal } from '../data/decisionEngine'
import {
  cachedRecommendStrategies,
  type StrategyRecommendation,
} from '../data/optionsStrategies'
import type { StoredHolding } from '../data/storage'

/**
 * Lists ranked options-strategy recommendations for the selected ticker:
 * covered call, protective put, long call, vol-arb flag, iron condor.
 * Each recommendation comes from optionsStrategies.ts with rationale,
 * payoff metrics, and citation. Tradier token required for live chains.
 */
export function OptionsStrategiesCard({
  signal,
  holding,
}: {
  signal: DecisionSignal
  holding: StoredHolding | null
}) {
  const [strategies, setStrategies] = useState<StrategyRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(0)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    cachedRecommendStrategies(signal, holding)
      .then((result) => {
        if (cancelled) return
        setStrategies(result)
        setLoading(false)
      })
      .catch((caught) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : 'Failed to compute strategies')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [signal, holding])

  return (
    <section className="panel-block options-strategies">
      <header>
        <Layers size={14} />
        <strong>Options strategies</strong>
        {strategies.length > 0 ? (
          <span className="options-source">{strategies.length} ranked</span>
        ) : null}
      </header>

      {loading ? (
        <p className="quant-loading">Fetching chain + computing strategies…</p>
      ) : error ? (
        <p className="quant-empty">{error}</p>
      ) : strategies.length === 0 ? (
        <p className="quant-empty">
          No options-strategy recommendations match this ticker's current state.
          Reasons: no Tradier token configured, no listed options, or no setup
          meets the strategy criteria right now.
        </p>
      ) : (
        <ul className="strategy-list">
          {strategies.map((strategy, idx) => (
            <li className="strategy-item" key={`${strategy.name}-${idx}`}>
              <button
                aria-expanded={expanded === idx}
                className="strategy-header"
                onClick={() => setExpanded(expanded === idx ? null : idx)}
                type="button"
              >
                {expanded === idx ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <strong>{strategy.name}</strong>
                <span className="strategy-meta">
                  {strategy.daysToExpiry > 0 ? `${strategy.daysToExpiry}d · ` : ''}
                  <span className="score-badge">score {Math.round(strategy.score)}</span>
                </span>
              </button>
              {expanded === idx ? <StrategyDetail strategy={strategy} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StrategyDetail({ strategy }: { strategy: StrategyRecommendation }) {
  return (
    <div className="strategy-detail">
      <p className="strategy-rationale">{strategy.rationale}</p>
      {strategy.legs.length > 0 ? (
        <table className="strategy-legs-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Type</th>
              <th>Strike</th>
              <th>Premium</th>
              <th>Δ</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {strategy.legs.map((leg, idx) => (
              <tr key={idx}>
                <td className={leg.action === 'sell' ? 'positive' : 'danger'}>
                  {leg.action.toUpperCase()}
                </td>
                <td>{leg.type}</td>
                <td>${leg.strike.toFixed(2)}</td>
                <td>${leg.premium.toFixed(2)}</td>
                <td>{leg.delta != null ? leg.delta.toFixed(2) : '–'}</td>
                <td>{leg.quantity ?? 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {strategy.legs.length > 0 ? (
        <div className="strategy-summary">
          <div>
            <span>Net {strategy.netCost >= 0 ? 'cost' : 'credit'}</span>
            <strong>${Math.abs(strategy.netCost).toFixed(0)}</strong>
          </div>
          <div>
            <span>Max profit</span>
            <strong className="positive">
              {Number.isFinite(strategy.maxProfit)
                ? `$${strategy.maxProfit.toFixed(0)}`
                : '∞'}
            </strong>
          </div>
          <div>
            <span>Max loss</span>
            <strong className="danger">
              {Number.isFinite(strategy.maxLoss)
                ? `$${strategy.maxLoss.toFixed(0)}`
                : '∞'}
            </strong>
          </div>
          <div>
            <span>Breakeven</span>
            <strong>
              {Array.isArray(strategy.breakeven)
                ? `$${strategy.breakeven[0].toFixed(2)} / $${strategy.breakeven[1].toFixed(2)}`
                : `$${strategy.breakeven.toFixed(2)}`}
            </strong>
          </div>
          <div>
            <span>Yield / cost</span>
            <strong className={strategy.yieldOrCost >= 0 ? 'positive' : 'danger'}>
              {strategy.yieldOrCost >= 0 ? '+' : ''}
              {strategy.yieldOrCost.toFixed(2)}%
            </strong>
          </div>
          {strategy.probabilityOfProfit != null ? (
            <div>
              <span>P(profit)</span>
              <strong>{(strategy.probabilityOfProfit * 100).toFixed(0)}%</strong>
            </div>
          ) : null}
        </div>
      ) : null}
      {strategy.citations.length > 0 ? (
        <div className="strategy-citations">
          {strategy.citations.map((cite) => (
            <span className="strategy-citation" key={cite}>
              {cite}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

