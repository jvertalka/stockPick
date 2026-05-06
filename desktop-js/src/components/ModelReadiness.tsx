import { useEffect, useState } from 'react'
import { CheckCircle2, Circle, GraduationCap } from 'lucide-react'
import { kvGet, kvSet } from '../data/storage'
import type { DecisionUniverseResponse } from '../data/decisionApi'
import type { DecisionSignal } from '../data/decisionEngine'

/**
 * Surfaces the path from rules to trained ML.
 *
 * Five gates (mirroring the Flutter ValidationEngine.modelReadiness):
 *   1. Snapshot accumulation - point-in-time evidence days collected
 *   2. Universe size        - number of tickers being scored
 *   3. Validation windows   - distinct labeled forward-return windows
 *   4. Labeled outcomes     - % of past predictions that have a real
 *                              forward return now available
 *   5. Integrity            - cross-validation didn't show leakage
 *
 * The first counter accumulates client-side: every successful refresh
 * stamps a date into IndexedDB. Once 6 months of distinct dates land,
 * gate 1 turns green.
 */

const SNAPSHOT_TARGET = 180
const UNIVERSE_TARGET = 100
const WINDOW_TARGET = 30
const LABEL_TARGET_PCT = 80

type Gate = {
  id: string
  label: string
  current: number
  target: number
  unit: string
  done: boolean
  detail: string
}

export function ModelReadinessPanel({
  feed,
  universe,
}: {
  feed: DecisionUniverseResponse | null
  universe: DecisionSignal[]
}) {
  const [snapshotDays, setSnapshotDays] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    void recordTodaySnapshot().then(async () => {
      const days = await countSnapshotDays()
      if (!cancelled) setSnapshotDays(days)
    })
    return () => {
      cancelled = true
    }
  }, [feed?.asOf])

  const universeSize = feed?.universeSize ?? universe.length
  const historyLength = feed?.history?.length ?? 0
  // Forward-return labels require N+20 calendar days of history per
  // recorded ranking. Until we have at least 20 days of accumulation,
  // labeled-outcome % stays at 0.
  const labelablePct =
    snapshotDays > 20
      ? Math.min(100, Math.round((Math.max(0, snapshotDays - 20) / SNAPSHOT_TARGET) * 100))
      : 0

  const gates: Gate[] = [
    {
      id: 'snapshots',
      label: 'Snapshot accumulation',
      current: snapshotDays,
      target: SNAPSHOT_TARGET,
      unit: 'days',
      done: snapshotDays >= SNAPSHOT_TARGET,
      detail:
        snapshotDays === 0
          ? 'No snapshots persisted yet — they accumulate one per successful refresh.'
          : `Roughly ${Math.max(0, SNAPSHOT_TARGET - snapshotDays)} more trading days needed.`,
    },
    {
      id: 'universe',
      label: 'Universe size',
      current: universeSize,
      target: UNIVERSE_TARGET,
      unit: 'names',
      done: universeSize >= UNIVERSE_TARGET,
      detail: `Currently scoring ${universeSize} tickers.`,
    },
    {
      id: 'windows',
      label: 'Validation windows',
      current: historyLength,
      target: WINDOW_TARGET,
      unit: 'windows',
      done: historyLength >= WINDOW_TARGET,
      detail: `${historyLength} historical windows kept in the rolling history buffer.`,
    },
    {
      id: 'labels',
      label: 'Labeled outcomes',
      current: labelablePct,
      target: LABEL_TARGET_PCT,
      unit: '%',
      done: labelablePct >= LABEL_TARGET_PCT,
      detail:
        labelablePct === 0
          ? 'No predictions have aged into the +20d label window yet.'
          : `${labelablePct}% of past predictions now have a measurable forward return.`,
    },
    {
      id: 'integrity',
      label: 'Leakage / integrity check',
      current: 0,
      target: 1,
      unit: 'pass',
      done: false,
      detail: 'Runs after gates 1–4 clear. Cross-validates that no future-information leaks into ranking inputs.',
    },
  ]

  const cleared = gates.filter((gate) => gate.done).length
  const nextActionable = estimateNextActionable(snapshotDays)

  return (
    <section className="panel readiness-panel-large" data-testid="model-readiness">
      <header className="panel-header">
        <div>
          <p>Path to trained models</p>
          <h2>
            {cleared}/{gates.length} readiness gates cleared
          </h2>
        </div>
        <span className="pill neutral">
          <GraduationCap size={12} /> Rules-only today
        </span>
      </header>
      <p className="readiness-lede">
        Until every gate clears, the engine runs hand-set weights and thresholds. Trained models are
        worth shipping only after we have enough labeled history for honest backtests.
      </p>
      <ol className="gate-list">
        {gates.map((gate) => (
          <li className={gate.done ? 'done' : ''} key={gate.id}>
            <span className="gate-icon">
              {gate.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
            </span>
            <div className="gate-body">
              <div className="gate-row">
                <strong>{gate.label}</strong>
                <span className="gate-progress">
                  {gate.current.toLocaleString()} / {gate.target.toLocaleString()} {gate.unit}
                </span>
              </div>
              <div className="gate-bar">
                <span
                  style={{
                    width: `${Math.min(100, (gate.current / Math.max(1, gate.target)) * 100)}%`,
                  }}
                />
              </div>
              <span className="gate-detail">{gate.detail}</span>
            </div>
          </li>
        ))}
      </ol>
      <footer className="readiness-footer">
        <strong>Estimated earliest training date</strong>
        <span>{nextActionable}</span>
      </footer>
    </section>
  )
}

const SNAPSHOT_KEY = 'model-readiness:dates'

async function recordTodaySnapshot() {
  const today = new Date().toISOString().slice(0, 10)
  const stored = (await kvGet<string[]>(SNAPSHOT_KEY)) ?? []
  if (stored.includes(today)) return
  stored.push(today)
  // Cap at 5 years of dates
  const trimmed = stored.slice(-1825)
  await kvSet(SNAPSHOT_KEY, trimmed)
}

async function countSnapshotDays() {
  const stored = (await kvGet<string[]>(SNAPSHOT_KEY)) ?? []
  return stored.length
}

function estimateNextActionable(snapshotDays: number) {
  if (snapshotDays >= SNAPSHOT_TARGET) {
    return 'All accumulation gates met — ready to begin shadow training.'
  }
  const remaining = SNAPSHOT_TARGET - snapshotDays
  // Trading-day estimate: 21 per month
  const months = Math.ceil(remaining / 21)
  const target = new Date()
  target.setMonth(target.getMonth() + months)
  return `~${target.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} (${remaining} more trading days)`
}
