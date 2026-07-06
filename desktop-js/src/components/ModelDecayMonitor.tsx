import { useEffect, useState } from 'react'
import { Activity, RefreshCcw } from 'lucide-react'
import {
  computeLiveScorecard,
  loadModel,
  loadPredictionLog,
  reconcilePredictions,
  type LiveScorecard,
  type StoredMlModel,
} from '../data/mlModelService'

/**
 * Live prediction scorecard: every prediction the app makes is logged, and
 * once its 20-day window closes the realized return is filled in. This panel
 * scores those pairs the SAME way the backtest scores itself — each
 * prediction day is its own cross-section, so the market's shared move
 * cancels and the live IC is directly comparable to the backtest's meanIC.
 * When live IC drifts well below the backtest number, the model is decaying
 * and a retrain is overdue.
 */

export function ModelDecayMonitor() {
  const [model, setModel] = useState<StoredMlModel | null>(null)
  const [card, setCard] = useState<LiveScorecard | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    await reconcilePredictions()
    const [m, log] = await Promise.all([loadModel(), loadPredictionLog()])
    setModel(m)
    setCard(computeLiveScorecard(log))
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [])

  if (!model) {
    return (
      <section className="panel decay-monitor" data-testid="decay-monitor">
        <header className="panel-header">
          <div>
            <p>Live prediction scorecard</p>
            <h2>No trained ML model loaded yet</h2>
          </div>
        </header>
        <p className="workflow-lede">
          Run the backtest first to train and persist a model. Once one exists,
          every live prediction is logged here and scored against what the
          stock actually did over the following 20 trading days.
        </p>
      </section>
    )
  }

  const scored = card != null && card.datesUsed > 0
  const drift = scored && card.meanIc != null ? card.meanIc - model.meanIC : null
  const driftTone =
    drift == null
      ? 'neutral'
      : drift > -0.01
        ? 'positive'
        : drift > -0.03
          ? 'caution'
          : 'danger'

  return (
    <section className="panel decay-monitor" data-testid="decay-monitor">
      <header className="panel-header">
        <div>
          <p>Live prediction scorecard</p>
          <h2>
            Trained {formatRelative(model.trainedAt)} ·{' '}
            {model.hyperparameters.numTrees} trees, depth {model.hyperparameters.depth}
          </h2>
        </div>
        <button className="ghost" disabled={loading} onClick={refresh} type="button">
          <RefreshCcw size={14} />
          {loading ? 'Scoring…' : 'Reconcile + rescore'}
        </button>
      </header>

      <p className="workflow-lede">
        Each prediction day is scored as its own cross-section — did the names
        the model ranked higher actually do better than the names it ranked
        lower that day? Market-wide moves cancel out, so this live IC is
        directly comparable to the backtest IC. Drift below −0.01 is mild;
        below −0.03 the model has materially decayed and a retrain is overdue.
      </p>

      <div className="backtest-summary">
        <div>
          <span>Backtest mean IC</span>
          <strong>{model.meanIC.toFixed(3)}</strong>
        </div>
        <div>
          <span>Live IC ({card?.datesUsed ?? 0} days)</span>
          <strong className={driftTone === 'positive' ? 'positive' : driftTone === 'danger' ? 'danger' : ''}>
            {scored && card.meanIc != null ? card.meanIc.toFixed(3) : '–'}
          </strong>
        </div>
        <div>
          <span>Drift</span>
          <strong className={driftTone === 'positive' ? 'positive' : driftTone === 'danger' ? 'danger' : ''}>
            {drift == null ? '–' : `${drift >= 0 ? '+' : ''}${drift.toFixed(3)}`}
          </strong>
        </div>
        <div>
          <span>Rank IC</span>
          <strong>{scored && card.meanRankIc != null ? card.meanRankIc.toFixed(3) : '–'}</strong>
        </div>
        <div>
          <span>Hit rate (vs day avg)</span>
          <strong>{scored && card.hitRate != null ? `${(card.hitRate * 100).toFixed(1)}%` : '–'}</strong>
        </div>
        <div>
          <span>Top-vs-bottom 20d</span>
          <strong>
            {scored && card.quintileSpreadPct != null
              ? `${card.quintileSpreadPct >= 0 ? '+' : ''}${card.quintileSpreadPct.toFixed(2)}%`
              : '–'}
          </strong>
        </div>
        <div>
          <span>80% interval coverage</span>
          <strong>
            {scored && card.intervalCoverage != null
              ? `${(card.intervalCoverage * 100).toFixed(0)}% of ${card.intervalSamples}`
              : '–'}
          </strong>
        </div>
        <div>
          <span>Samples</span>
          <strong>
            {card ? `${card.realizedUsed} scored · ${card.pendingTotal} pending` : '–'}
          </strong>
        </div>
      </div>

      {scored ? (
        <>
          <p className="backtest-section-note">
            <Activity size={12} /> Window: {card.windowOldest} → {card.windowNewest}.
            Scored on the ~30 names the app predicts each day (days with fewer
            than 5 realized names are skipped — no meaningful cross-section).
            Predictions keep logging while the app is open; each becomes
            scoreable once its 20-day window closes.
          </p>
          {card.recentDates.length > 0 ? (
            <div className="scorecard-dates">
              {card.recentDates.map((d) => (
                <span
                  className={`pill ${d.ic > 0.02 ? 'positive' : d.ic < -0.02 ? 'danger' : 'neutral'}`}
                  key={d.date}
                  title={`${d.n} names scored on ${d.date}`}
                >
                  {d.date.slice(5)} · IC {d.ic >= 0 ? '+' : ''}{d.ic.toFixed(2)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="backtest-section-note">
          {card && card.pendingTotal > 0
            ? `${card.pendingTotal} predictions logged and waiting for their 20-day windows to close` +
              (card.nextEvaluable ? ` — the first becomes scoreable around ${card.nextEvaluable}.` : '.')
            : 'No predictions logged yet. They start logging automatically while the app is open.'}
          {card && card.realizedTotal > 0 && card.datesUsed === 0
            ? ` ${card.realizedTotal} returned so far, but no single day has the 5+ names needed for a fair cross-section yet.`
            : ''}
        </p>
      )}
    </section>
  )
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  return `${months}mo ago`
}
