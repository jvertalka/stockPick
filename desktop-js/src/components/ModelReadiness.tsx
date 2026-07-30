import { AlertTriangle, CheckCircle2, Circle, GraduationCap } from 'lucide-react'
import type { DecisionUniverseResponse } from '../data/decisionApi'
import type { DecisionSignal } from '../data/decisionEngine'
import {
  modelDecisionAuthority,
  type StoredMlModel,
} from '../data/mlModelService'

/**
 * The promotion audit shown here is the same structured evidence object that
 * the CLI and in-app trainer persist with the model. This panel does not infer
 * readiness from time elapsed or browser refresh counts.
 */
export function ModelReadinessPanel({
  feed,
  universe,
  model,
}: {
  feed: DecisionUniverseResponse | null
  universe: DecisionSignal[]
  model: StoredMlModel | null
}) {
  const authority = modelDecisionAuthority(model)
  const reasons = model?.promotion?.reasons ?? []
  const passed = reasons.filter((reason) => reason.status === 'pass').length
  const total = reasons.length
  const liveNames = feed?.returned ?? universe.length
  const requestedNames = feed?.universeSize ?? universe.length
  const fundamentalsCoverage = feed?.fundamentalsCoverage ?? 0
  const sampleRange = model?.datasetProvenance?.sampleDateRange

  const statusLabel =
    authority.status === 'promoted'
      ? 'Promoted for decisions'
      : authority.status === 'advisory-only'
        ? 'Research only'
        : 'Unverified legacy model'

  return (
    <section className="panel readiness-panel-large" data-testid="model-readiness">
      <header className="panel-header">
        <div>
          <p>Model evidence contract</p>
          <h2>
            {total > 0 ? `${passed}/${total} promotion checks passed` : statusLabel}
          </h2>
        </div>
        <span className={`pill ${authority.canLeadDecisions ? 'positive' : 'caution'}`}>
          <GraduationCap size={12} /> {statusLabel}
        </span>
      </header>

      <p className="readiness-lede">
        {authority.canLeadDecisions
          ? 'This artifact passed the recorded data-provenance and paired-baseline checks and may set live action labels.'
          : model
            ? 'Forecasts remain visible for research, but this artifact cannot mint Buy, Accumulate, Trim, or Avoid labels. Rules exits remain independent risk warnings.'
            : 'No audited model is loaded, so bullish actions are paused. Rules exits remain visible as independent risk warnings.'}
      </p>

      {reasons.length > 0 ? (
        <ol className="gate-list">
          {reasons.map((reason) => {
            const done = reason.status === 'pass'
            return (
              <li className={done ? 'done' : ''} key={reason.code}>
                <span className="gate-icon">
                  {done ? (
                    <CheckCircle2 size={16} />
                  ) : reason.status === 'warning' ? (
                    <AlertTriangle size={16} />
                  ) : (
                    <Circle size={16} />
                  )}
                </span>
                <div className="gate-body">
                  <div className="gate-row">
                    <strong>{reason.title}</strong>
                    <span className="gate-progress">{reason.status}</span>
                  </div>
                  <span className="gate-detail">{reason.detail}</span>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="empty-state compact">
          <strong>Promotion metadata unavailable</strong>
          <span>{authority.detail}</span>
        </div>
      )}

      <footer className="readiness-footer">
        <div>
          <strong>Live evidence</strong>
          <span>
            {liveNames.toLocaleString()}/{requestedNames.toLocaleString()} names scoreable ·{' '}
            {fundamentalsCoverage.toLocaleString()} with SEC fundamentals
          </span>
        </div>
        <div>
          <strong>Training evidence</strong>
          <span>
            {model?.datasetProvenance
              ? `${model.datasetProvenance.sampleCount.toLocaleString()} samples${
                  sampleRange?.start && sampleRange.end
                    ? ` · ${sampleRange.start} to ${sampleRange.end}`
                    : ''
                }`
              : 'No auditable dataset provenance attached'}
          </span>
        </div>
      </footer>
    </section>
  )
}
