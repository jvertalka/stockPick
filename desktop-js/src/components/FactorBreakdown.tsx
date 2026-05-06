import { BarChart2 } from 'lucide-react'
import type { DecisionSignal } from '../data/decisionEngine'

/**
 * Surfaces the engine's factor decomposition for a single signal so the
 * user sees exactly which canonical academic factors are driving the
 * composite alpha. Each row shows the factor's Z-score (vs. the active
 * universe), its weight in the current regime, and its contribution to
 * the final composite.
 *
 * Z-score reading guide:
 *   +1.0  = top ~16% of universe on this factor
 *   +2.0  = top ~2% (rare, very strong)
 *    0.0  = universe median
 *   -1.0  = bottom ~16%
 *
 * The composite is a regime-weighted sum, so a stock can have a high
 * momentum Z but a low overall composite if the active regime is
 * defensive (where momentum carries less weight).
 */

const FACTOR_LABELS: Array<{ key: keyof DecisionSignal; label: string; description: string }> = [
  {
    key: 'momentumZ',
    label: 'Momentum',
    description: '12-month relative strength + residual (Jegadeesh & Titman 1993)',
  },
  {
    key: 'qualityZ',
    label: 'Quality',
    description: 'Margins + FCF + balance sheet durability (Asness, Frazzini, Pedersen 2019)',
  },
  {
    key: 'growthZ',
    label: 'Growth',
    description: 'Revisions + surprise + revenue acceleration (Chan, Jegadeesh, Lakonishok 1996)',
  },
  {
    key: 'valueZ',
    label: 'Value',
    description: 'Valuation support relative to peers (Fama & French 1992)',
  },
  {
    key: 'lowVolZ',
    label: 'Low-volatility',
    description: 'Inverse of realized vol + drawdown risk (Frazzini & Pedersen 2014)',
  },
  {
    key: 'fragilityZ',
    label: 'Fragility (inv.)',
    description: 'Inverse of options-derived skew + crowding (Xing, Zhang, Zhao 2010)',
  },
]

export function FactorBreakdown({ signal }: { signal: DecisionSignal }) {
  return (
    <section className="panel-block factor-breakdown">
      <header>
        <BarChart2 size={14} />
        <strong>Factor breakdown</strong>
        <span className="factor-meta">
          Composite α: {signal.compositeAlphaZ >= 0 ? '+' : ''}
          {signal.compositeAlphaZ.toFixed(2)}σ · regime: {signal.detectedRegime.replace(/-/g, ' ')}
        </span>
      </header>
      <ul className="factor-list">
        {FACTOR_LABELS.map(({ key, label, description }) => {
          const z = (signal[key] as number) ?? 0
          const tone = z >= 0.5 ? 'positive' : z <= -0.5 ? 'danger' : 'neutral'
          // Bar fills from the center (Z=0) outward, capped at ±2.5σ
          const cappedZ = Math.max(-2.5, Math.min(2.5, z))
          const widthPct = (Math.abs(cappedZ) / 2.5) * 50
          const offsetPct = z >= 0 ? 50 : 50 - widthPct
          return (
            <li key={key as string} title={description}>
              <span className="factor-label">{label}</span>
              <div className="factor-bar">
                <span className="factor-tick" />
                <span
                  className={`factor-fill ${tone}`}
                  style={{ width: `${widthPct}%`, left: `${offsetPct}%` }}
                />
              </div>
              <strong className={tone}>
                {z >= 0 ? '+' : ''}
                {z.toFixed(1)}σ
              </strong>
            </li>
          )
        })}
      </ul>
      <p className="factor-footer">
        {signal.factorAgreement >= 65
          ? 'Factors are aligned — high-conviction setup.'
          : signal.factorAgreement >= 50
            ? 'Factors agree directionally with some dispersion.'
            : 'Factors disagree — mixed evidence, treat as research not action.'}
      </p>
    </section>
  )
}
