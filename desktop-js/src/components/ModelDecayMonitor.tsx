import { useEffect, useState } from 'react'
import { Activity, RefreshCcw } from 'lucide-react'
import { computeLiveModelIc, loadModel, reconcilePredictions, type StoredMlModel } from '../data/mlModelService'

/**
 * Surfaces live model decay: rolling IC of past predictions vs. realized
 * returns over the last ~100 reconciled samples. When the live IC drifts
 * substantially below the backtest IC, the model is decaying and a
 * retrain is overdue.
 */

type LiveStats = {
  ic: number
  hitRate: number
  meanRealized: number
  sampleSize: number
  oldest: string
  newest: string
}

export function ModelDecayMonitor() {
  const [model, setModel] = useState<StoredMlModel | null>(null)
  const [live, setLive] = useState<LiveStats | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    await reconcilePredictions()
    const [m, l] = await Promise.all([loadModel(), computeLiveModelIc(100)])
    setModel(m)
    setLive(l)
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
            <p>Live model decay</p>
            <h2>No trained ML model loaded yet</h2>
          </div>
        </header>
        <p className="workflow-lede">
          Run the backtest first to train and persist a Gradient Boosted Trees model.
          Once one exists, this panel will track the rolling 100-prediction IC against
          realized 20-day returns.
        </p>
      </section>
    )
  }

  const drift = live ? live.ic - model.meanIC : null
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
          <p>Live model decay</p>
          <h2>
            Trained {formatRelative(model.trainedAt)} ·{' '}
            {model.hyperparameters.numTrees} trees, depth {model.hyperparameters.depth}
          </h2>
        </div>
        <button className="ghost" disabled={loading} onClick={refresh} type="button">
          <RefreshCcw size={14} />
          {loading ? 'Reconciling…' : 'Reconcile predictions'}
        </button>
      </header>

      <p className="workflow-lede">
        IC drift below -0.01 is mild; below -0.03 means the model has materially
        decayed and a retrain is overdue. Below -0.05 means the model is no
        better than random — stop relying on it.
      </p>

      <div className="backtest-summary">
        <div>
          <span>Backtest mean IC</span>
          <strong>{model.meanIC.toFixed(3)}</strong>
        </div>
        <div>
          <span>Live IC ({live?.sampleSize ?? 0} samples)</span>
          <strong className={driftTone === 'positive' ? 'positive' : driftTone === 'danger' ? 'danger' : ''}>
            {live ? live.ic.toFixed(3) : '–'}
          </strong>
        </div>
        <div>
          <span>Drift</span>
          <strong className={driftTone === 'positive' ? 'positive' : driftTone === 'danger' ? 'danger' : ''}>
            {drift == null ? '–' : `${drift >= 0 ? '+' : ''}${drift.toFixed(3)}`}
          </strong>
        </div>
        <div>
          <span>Hit rate</span>
          <strong>{live ? `${(live.hitRate * 100).toFixed(1)}%` : '–'}</strong>
        </div>
        <div>
          <span>Mean realized 20d</span>
          <strong>
            {live ? `${live.meanRealized >= 0 ? '+' : ''}${live.meanRealized.toFixed(2)}%` : '–'}
          </strong>
        </div>
      </div>

      {live ? (
        <p className="backtest-section-note">
          <Activity size={12} /> Window: {live.oldest} → {live.newest}. Predictions log
          continuously while the app is open; reconciliation populates realized returns
          for any prediction whose 20-day forward window has closed.
        </p>
      ) : (
        <p className="backtest-section-note">
          Not enough realized predictions yet (need 30+). Predictions made today
          become evaluable in roughly 28-30 calendar days.
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
