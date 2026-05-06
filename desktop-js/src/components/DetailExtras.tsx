import { useEffect, useMemo, useState } from 'react'
import { Calculator, History, NotebookPen, Save } from 'lucide-react'
import { useToast } from './useToast'
import {
  getDecisionLog,
  getNote,
  setNote,
  type DecisionLogEntry,
} from '../data/storage'

/**
 * Position sizer: turns "Buy" into actionable share count + dollar amount.
 *
 * Inputs are persisted to localStorage so the user only sets them once.
 * Action multipliers reflect the engine's labels: Buy Now = full starter,
 * Accumulate = half, Hold = no fresh add, Trim/Sell/Avoid = no entry.
 */

const sizerStorageKey = 'finance-oracle-sizer'

type SizerPrefs = {
  accountValue: number
  maxPositionPct: number
  riskTolerance: 'conservative' | 'balanced' | 'aggressive'
}

const defaultSizerPrefs: SizerPrefs = {
  accountValue: 100000,
  maxPositionPct: 5,
  riskTolerance: 'balanced',
}

function readSizerPrefs(): SizerPrefs {
  try {
    const raw = window.localStorage.getItem(sizerStorageKey)
    if (!raw) return defaultSizerPrefs
    const parsed = JSON.parse(raw) as Partial<SizerPrefs>
    return { ...defaultSizerPrefs, ...parsed }
  } catch {
    return defaultSizerPrefs
  }
}

function writeSizerPrefs(prefs: SizerPrefs) {
  try {
    window.localStorage.setItem(sizerStorageKey, JSON.stringify(prefs))
  } catch {
    // ignore
  }
}

const actionMultiplier: Record<string, number> = {
  'Buy Now': 1.0,
  Accumulate: 0.5,
  Hold: 0,
  Trim: 0,
  Sell: 0,
  Avoid: 0,
}

const riskAdjust: Record<SizerPrefs['riskTolerance'], number> = {
  conservative: 0.7,
  balanced: 1.0,
  aggressive: 1.3,
}

export function PositionSizer({
  ticker,
  action,
  lastPrice,
  riskScore,
}: {
  ticker: string
  action: string
  lastPrice?: number
  riskScore: number
}) {
  const [prefs, setPrefs] = useState<SizerPrefs>(() => readSizerPrefs())
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    writeSizerPrefs(prefs)
  }, [prefs])

  const calculation = useMemo(() => {
    const baseDollars = (prefs.accountValue * prefs.maxPositionPct) / 100
    const actionMult = actionMultiplier[action] ?? 0
    const riskMult = riskAdjust[prefs.riskTolerance]
    // High-risk names get sized down so the dollar-stop loss stays bounded.
    const riskDamper = riskScore >= 65 ? 0.6 : riskScore >= 55 ? 0.8 : 1.0
    const targetDollars = baseDollars * actionMult * riskMult * riskDamper
    const shares =
      lastPrice && lastPrice > 0 && targetDollars > 0
        ? Math.max(1, Math.floor(targetDollars / lastPrice))
        : 0
    const realizedDollars = shares * (lastPrice ?? 0)
    return { targetDollars, shares, realizedDollars, baseDollars, actionMult, riskMult, riskDamper }
  }, [prefs, action, lastPrice, riskScore])

  if (!actionMultiplier[action] || actionMultiplier[action] === 0) {
    return (
      <section className="panel-block sizer">
        <header>
          <Calculator size={14} />
          <strong>Position sizer</strong>
        </header>
        <p className="sizer-empty">
          Sizing only suggested for Buy / Accumulate calls. Current action is <em>{action}</em>.
        </p>
      </section>
    )
  }

  return (
    <section className="panel-block sizer">
      <header>
        <Calculator size={14} />
        <strong>Position sizer</strong>
        <button className="ghost" onClick={() => setEditing((current) => !current)} type="button">
          {editing ? 'Done' : 'Adjust'}
        </button>
      </header>
      {editing ? (
        <div className="sizer-form">
          <label>
            <span>Account value</span>
            <input
              aria-label="Account value"
              min={0}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  accountValue: Math.max(0, Number(event.target.value) || 0),
                }))
              }
              type="number"
              value={prefs.accountValue}
            />
          </label>
          <label>
            <span>Max position %</span>
            <input
              aria-label="Max position percent"
              max={50}
              min={0.1}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  maxPositionPct: Math.max(0.1, Math.min(50, Number(event.target.value) || 0)),
                }))
              }
              step={0.5}
              type="number"
              value={prefs.maxPositionPct}
            />
          </label>
          <label>
            <span>Risk tolerance</span>
            <select
              aria-label="Risk tolerance"
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  riskTolerance: event.target.value as SizerPrefs['riskTolerance'],
                }))
              }
              value={prefs.riskTolerance}
            >
              <option value="conservative">Conservative</option>
              <option value="balanced">Balanced</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>
        </div>
      ) : null}
      <div className="sizer-output">
        <div>
          <span>Target</span>
          <strong>{formatCurrency(calculation.targetDollars)}</strong>
        </div>
        <div>
          <span>Shares</span>
          <strong>{calculation.shares > 0 ? calculation.shares.toLocaleString() : '—'}</strong>
        </div>
        <div>
          <span>At {formatCurrency(lastPrice ?? 0)}</span>
          <strong>{formatCurrency(calculation.realizedDollars)}</strong>
        </div>
      </div>
      <p className="sizer-note">
        {prefs.maxPositionPct}% of {formatCurrency(prefs.accountValue)} max position ·
        {action} sizing × {prefs.riskTolerance} tolerance
        {calculation.riskDamper < 1 ? ` · risk damper ${calculation.riskDamper.toFixed(1)}×` : ''}
        <span className="sizer-disclaimer"> Not investment advice — your numbers, your call on {ticker}.</span>
      </p>
    </section>
  )
}

/**
 * Per-ticker free-text notes, IndexedDB backed.
 */
export function TickerNotes({
  ticker,
  onSaved,
}: {
  ticker: string
  onSaved?: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDirty(false)
    getNote(ticker).then((note) => {
      if (cancelled) return
      setText(note?.text ?? '')
      setSavedAt(note?.updatedAt ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [ticker])

  async function handleSave() {
    await setNote(ticker, text)
    const now = new Date().toISOString()
    setSavedAt(text.trim() ? now : null)
    setDirty(false)
    onSaved?.(text)
    showToast(text.trim() ? `Saved note for ${ticker}` : `Cleared note for ${ticker}`, 'success')
  }

  return (
    <section className="panel-block notes">
      <header>
        <NotebookPen size={14} />
        <strong>Your thesis</strong>
        {savedAt && !dirty ? <span className="notes-stamp">saved {formatRelative(savedAt)}</span> : null}
        {dirty ? <span className="notes-stamp dirty">unsaved changes</span> : null}
      </header>
      <textarea
        aria-label={`Thesis notes for ${ticker}`}
        onChange={(event) => {
          setText(event.target.value)
          setDirty(true)
        }}
        placeholder={`Why are you holding ${ticker}? What would change your mind?`}
        rows={3}
        value={text}
      />
      <div className="notes-actions">
        <button className="primary" disabled={!dirty} onClick={handleSave} type="button">
          <Save size={13} />
          Save note
        </button>
      </div>
    </section>
  )
}

/**
 * Decision history ribbon: the action transitions we've recorded for this
 * ticker. Empty on first sight; populates as the engine re-ranks.
 */
export function DecisionHistory({ ticker }: { ticker: string }) {
  const [entries, setEntries] = useState<DecisionLogEntry[]>([])
  useEffect(() => {
    let cancelled = false
    getDecisionLog(ticker).then((rows) => {
      if (!cancelled) setEntries(rows)
    })
    return () => {
      cancelled = true
    }
  }, [ticker])

  if (entries.length === 0) {
    return (
      <section className="panel-block history">
        <header>
          <History size={14} />
          <strong>Decision history</strong>
        </header>
        <p className="history-empty">
          No transitions logged yet. The next time the action label changes, it will land here.
        </p>
      </section>
    )
  }

  const recent = entries.slice(-6)
  return (
    <section className="panel-block history">
      <header>
        <History size={14} />
        <strong>Decision history</strong>
        <span className="history-count">{entries.length} transitions</span>
      </header>
      <ol className="history-timeline">
        {recent.map((entry, idx) => (
          <li className={idx === recent.length - 1 ? 'current' : ''} key={`${entry.asOf}-${idx}`}>
            <span className={`pill ${pillTone(entry.action)}`}>{entry.action}</span>
            <span className="history-meta">
              {formatShortDate(entry.asOf)} · Opp {Math.round(entry.opportunityScore)} · Risk{' '}
              {Math.round(entry.riskScore)}
            </span>
            <span className="history-reason">{entry.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function pillTone(action: string) {
  if (action === 'Buy Now' || action === 'Accumulate') return 'positive'
  if (action === 'Trim') return 'caution'
  if (action === 'Sell' || action === 'Avoid') return 'danger'
  return 'neutral'
}

function formatCurrency(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 100000) return `$${(value / 1000).toFixed(0)}k`
  if (value >= 10000) return `$${(value / 1000).toFixed(1)}k`
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function formatRelative(iso: string) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function formatShortDate(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()}`
}
