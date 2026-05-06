import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { DecisionSignal } from '../data/decisionEngine'
import { Sparkline } from './Sparkline'
import { EarningsChip } from './EarningsChip'

/**
 * Side-by-side comparison of 2-4 picked tickers. Lets the user answer
 * the "which one of these three?" question without clicking each in
 * turn. Pulls from the visible universe; the user can pick anything in
 * the current scoring set.
 *
 * Common metrics are aligned in rows so the eye sweeps horizontally.
 */

const MAX_COMPARE = 4

export function ComparisonView({
  universe,
  initialTickers,
  onOpenStock,
}: {
  universe: DecisionSignal[]
  initialTickers: string[]
  onOpenStock: (ticker: string) => void
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    initialTickers.slice(0, MAX_COMPARE),
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  const rows = selected
    .map((ticker) => universe.find((row) => row.ticker === ticker))
    .filter((row): row is DecisionSignal => row != null)

  function addTicker(ticker: string) {
    setSelected((current) => {
      if (current.includes(ticker)) return current
      if (current.length >= MAX_COMPARE) return current
      return [...current, ticker]
    })
    setPickerOpen(false)
  }

  function removeTicker(ticker: string) {
    setSelected((current) => current.filter((existing) => existing !== ticker))
  }

  return (
    <section className="panel comparison-view" data-testid="comparison-view">
      <header className="panel-header">
        <div>
          <p>Side-by-side</p>
          <h2>Compare {rows.length || 0} of {MAX_COMPARE} tickers</h2>
        </div>
        <button
          className="ghost"
          disabled={rows.length >= MAX_COMPARE}
          onClick={() => setPickerOpen((current) => !current)}
          type="button"
        >
          <Plus size={14} />
          Add ticker
        </button>
      </header>

      {pickerOpen ? (
        <ComparisonPicker
          excluded={selected}
          onClose={() => setPickerOpen(false)}
          onPick={addTicker}
          universe={universe}
        />
      ) : null}

      {rows.length === 0 ? (
        <div className="comparison-empty">
          <strong>Pick up to four tickers to compare</strong>
          <span>
            Useful for "which one of these three?" decisions where the rank-by-score view alone
            doesn't show the trade-offs.
          </span>
        </div>
      ) : (
        <div className="comparison-table">
          <ComparisonHeaderRow rows={rows} onRemove={removeTicker} onOpen={onOpenStock} />
          <ComparisonRow label="Action" cells={rows.map((row) => row.action)} bold />
          <ComparisonRow
            label="Why"
            cells={rows.map((row) => row.evidence[0] ?? '–')}
            multiline
          />
          <ComparisonRow
            label="Sector / industry"
            cells={rows.map((row) => `${row.sector} · ${row.industry}`)}
          />
          <ComparisonNumberRow
            label="Opportunity"
            values={rows.map((row) => row.opportunityScore)}
            higherIsBetter
          />
          <ComparisonNumberRow
            label="Risk"
            values={rows.map((row) => row.riskScore)}
            higherIsBetter={false}
          />
          <ComparisonNumberRow
            label="Confidence"
            values={rows.map((row) => row.confidence)}
            higherIsBetter
          />
          <ComparisonNumberRow
            label="Regime fit"
            values={rows.map((row) => row.regimeFit)}
            higherIsBetter
          />
          <ComparisonNumberRow
            label="Fragility"
            values={rows.map((row) => row.fragilityScore)}
            higherIsBetter={false}
          />
          <ComparisonNumberRow
            label="20d forecast"
            values={rows.map((row) => row.forecast20d)}
            format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`}
            higherIsBetter
          />
          <ComparisonRow
            label="Trajectory"
            cells={rows.map(() => '')}
            extras={rows.map((row) => (
              <Sparkline
                signal={{
                  ticker: row.ticker,
                  lastPrice: row.lastPrice,
                  priceChange20d: row.priceChange20d,
                  priceChange60d: row.priceChange60d,
                  priceChange120d: row.priceChange120d,
                }}
                key={row.ticker}
              />
            ))}
          />
          <ComparisonRow
            label="Risk flags"
            cells={rows.map((row) => row.riskFlags.slice(0, 2).join(' · ') || '–')}
            multiline
          />
        </div>
      )}
    </section>
  )
}

function ComparisonHeaderRow({
  rows,
  onRemove,
  onOpen,
}: {
  rows: DecisionSignal[]
  onRemove: (ticker: string) => void
  onOpen: (ticker: string) => void
}) {
  return (
    <div className="comparison-row comparison-header">
      <div className="comparison-label">Ticker</div>
      {rows.map((row) => (
        <div className="comparison-cell ticker-cell" key={row.ticker}>
          <button className="ticker-link" onClick={() => onOpen(row.ticker)} type="button">
            <strong>{row.ticker}</strong>
            <span>{row.name}</span>
          </button>
          <EarningsChip compact ticker={row.ticker} />
          <button
            aria-label={`Remove ${row.ticker} from comparison`}
            className="ghost icon-only"
            onClick={() => onRemove(row.ticker)}
            type="button"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function ComparisonRow({
  label,
  cells,
  bold = false,
  multiline = false,
  extras,
}: {
  label: string
  cells: string[]
  bold?: boolean
  multiline?: boolean
  extras?: React.ReactNode[]
}) {
  return (
    <div className="comparison-row">
      <div className="comparison-label">{label}</div>
      {cells.map((cell, idx) => (
        <div
          className={`comparison-cell${bold ? ' bold' : ''}${multiline ? ' multiline' : ''}`}
          key={idx}
        >
          {extras?.[idx] ?? cell}
        </div>
      ))}
    </div>
  )
}

function ComparisonNumberRow({
  label,
  values,
  higherIsBetter,
  format,
}: {
  label: string
  values: number[]
  higherIsBetter: boolean
  format?: (value: number) => string
}) {
  const target = higherIsBetter ? Math.max(...values) : Math.min(...values)
  return (
    <div className="comparison-row">
      <div className="comparison-label">{label}</div>
      {values.map((value, idx) => (
        <div className={`comparison-cell number${value === target ? ' best' : ''}`} key={idx}>
          {format ? format(value) : Math.round(value)}
        </div>
      ))}
    </div>
  )
}

function ComparisonPicker({
  universe,
  excluded,
  onPick,
  onClose,
}: {
  universe: DecisionSignal[]
  excluded: string[]
  onPick: (ticker: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const matches = universe
    .filter(
      (row) =>
        !excluded.includes(row.ticker) &&
        (query === '' ||
          row.ticker.toLowerCase().includes(query.toLowerCase()) ||
          row.name.toLowerCase().includes(query.toLowerCase())),
    )
    .slice(0, 24)
  return (
    <div className="comparison-picker">
      <input
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search ticker or company"
        type="text"
        value={query}
      />
      <ul>
        {matches.map((row) => (
          <li key={row.ticker}>
            <button onClick={() => onPick(row.ticker)} type="button">
              <strong>{row.ticker}</strong>
              <span>{row.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="ghost" onClick={onClose} type="button">
        Cancel
      </button>
    </div>
  )
}
