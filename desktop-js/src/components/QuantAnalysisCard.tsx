import { useEffect, useState } from 'react'
import { Sigma } from 'lucide-react'
import type { DecisionSignal } from '../data/decisionEngine'
import { cachedComputeQuantAnalysis, type QuantAnalysis } from '../data/quantAnalysis'

/**
 * Surfaces the heavy quantitative analysis for a single ticker:
 * Black-Scholes-Merton implied data, Monte Carlo forecast distribution,
 * GARCH volatility, Kelly Criterion, VaR/CVaR, Sortino/Sharpe.
 *
 * This is where the "advanced math from research papers" actually
 * shows up to drive a decision. Citation tooltips on each block.
 */

export function QuantAnalysisCard({ signal }: { signal: DecisionSignal }) {
  const [analysis, setAnalysis] = useState<QuantAnalysis | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    cachedComputeQuantAnalysis(signal)
      .then((value) => {
        if (cancelled) return
        setAnalysis(value)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setAnalysis(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [signal])

  if (loading) {
    return (
      <section className="panel-block quant-analysis">
        <header>
          <Sigma size={14} />
          <strong>Quantitative analysis</strong>
        </header>
        <p className="quant-loading">Computing GARCH + Monte Carlo + BSM…</p>
      </section>
    )
  }

  if (!analysis) {
    return (
      <section className="panel-block quant-analysis">
        <header>
          <Sigma size={14} />
          <strong>Quantitative analysis</strong>
        </header>
        <p className="quant-empty">
          Not enough price history to run quantitative analysis on this name.
        </p>
      </section>
    )
  }

  return (
    <section className="panel-block quant-analysis">
      <header>
        <Sigma size={14} />
        <strong>Quantitative analysis</strong>
        <span className="quant-source">
          {analysis.barsAvailable}d bars · {analysis.hasOptionsData ? 'BSM live' : 'BSM unavailable'}
        </span>
      </header>

      {/* Volatility row */}
      <div
        className="quant-block"
        title="Realized = sample stddev of last 30d log returns. GARCH(1,1) per Bollerslev 1986. IV = options-implied from ATM 30d (BSM)."
      >
        <span className="quant-label">Volatility (annualized)</span>
        <div className="quant-row">
          <div>
            <span>Realized 30d</span>
            <strong>{(analysis.realizedVol30d * 100).toFixed(1)}%</strong>
          </div>
          <div>
            <span>GARCH(1,1) forecast</span>
            <strong>{(analysis.garchForecastVol * 100).toFixed(1)}%</strong>
          </div>
          {analysis.optionsImpliedVol ? (
            <div>
              <span>Options implied</span>
              <strong>{(analysis.optionsImpliedVol * 100).toFixed(1)}%</strong>
            </div>
          ) : null}
        </div>
      </div>

      {/* Monte Carlo row */}
      <div
        className="quant-block"
        title="5,000 path Monte Carlo simulation. GBM with optional Merton (1976) jump diffusion when event/skew risk is elevated. 20 trading day horizon."
      >
        <span className="quant-label">Monte Carlo 20d forecast (5,000 paths)</span>
        <div className="quant-row">
          <div>
            <span>Mean return</span>
            <strong className={tone(analysis.monteCarlo.meanReturnPct)}>
              {sign(analysis.monteCarlo.meanReturnPct)}{analysis.monteCarlo.meanReturnPct.toFixed(1)}%
            </strong>
          </div>
          <div>
            <span>P(up)</span>
            <strong>{(analysis.monteCarlo.probUp * 100).toFixed(0)}%</strong>
          </div>
          <div>
            <span>P(down &gt; 8%)</span>
            <strong className={analysis.monteCarlo.probDown8pct > 0.15 ? 'danger' : ''}>
              {(analysis.monteCarlo.probDown8pct * 100).toFixed(0)}%
            </strong>
          </div>
        </div>
        <div className="quant-quantiles">
          <div className="quant-quantile-bar">
            <span className="qmark p05" style={{ left: `${pctToPosition(analysis.monteCarlo.quantiles.p05)}%` }} />
            <span className="qmark p25" style={{ left: `${pctToPosition(analysis.monteCarlo.quantiles.p25)}%` }} />
            <span className="qmark p50" style={{ left: `${pctToPosition(analysis.monteCarlo.quantiles.p50)}%` }} />
            <span className="qmark p75" style={{ left: `${pctToPosition(analysis.monteCarlo.quantiles.p75)}%` }} />
            <span className="qmark p95" style={{ left: `${pctToPosition(analysis.monteCarlo.quantiles.p95)}%` }} />
          </div>
          <div className="quant-quantile-labels">
            <span>p05 {analysis.monteCarlo.quantiles.p05.toFixed(1)}%</span>
            <span>p50 {analysis.monteCarlo.quantiles.p50.toFixed(1)}%</span>
            <span>p95 +{analysis.monteCarlo.quantiles.p95.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Risk-neutral (BSM) — only if we have options data */}
      {analysis.riskNeutral ? (
        <div
          className="quant-block"
          title="Risk-neutral probabilities extracted from BSM (Black-Scholes 1973 / Merton 1973) using the Tradier ATM 30d implied vol. These are what the OPTIONS MARKET is pricing — not what our model expects."
        >
          <span className="quant-label">Risk-neutral (Black-Scholes-Merton)</span>
          <div className="quant-row">
            <div>
              <span>P(up) market</span>
              <strong>{(analysis.riskNeutral.probUp * 100).toFixed(0)}%</strong>
            </div>
            <div>
              <span>P(up &gt; 5%)</span>
              <strong>{(analysis.riskNeutral.probUp5pct * 100).toFixed(0)}%</strong>
            </div>
            <div>
              <span>P(down &gt; 8%)</span>
              <strong className={analysis.riskNeutral.probDown8pct > 0.2 ? 'danger' : ''}>
                {(analysis.riskNeutral.probDown8pct * 100).toFixed(0)}%
              </strong>
            </div>
          </div>
          <p className="quant-note">
            Implied range 30d (p25-p75): {sign(analysis.riskNeutral.quantiles.p25)}
            {analysis.riskNeutral.quantiles.p25.toFixed(1)}% to{' '}
            {sign(analysis.riskNeutral.quantiles.p75)}
            {analysis.riskNeutral.quantiles.p75.toFixed(1)}%
          </p>
        </div>
      ) : null}

      {/* Greeks — only if we have options data */}
      {analysis.greeksATM ? (
        <div
          className="quant-block"
          title="ATM 30d Greeks computed via Black-Scholes-Merton. Delta = price sensitivity to spot; Gamma = delta sensitivity; Vega = price sensitivity to vol; Theta = daily decay; Rho = rate sensitivity."
        >
          <span className="quant-label">Greeks (ATM 30d call)</span>
          <div className="quant-row five">
            <div>
              <span>Δ</span>
              <strong>{analysis.greeksATM.delta.toFixed(3)}</strong>
            </div>
            <div>
              <span>Γ</span>
              <strong>{analysis.greeksATM.gamma.toFixed(4)}</strong>
            </div>
            <div>
              <span>ν</span>
              <strong>{analysis.greeksATM.vega.toFixed(2)}</strong>
            </div>
            <div>
              <span>Θ</span>
              <strong>{analysis.greeksATM.theta.toFixed(3)}</strong>
            </div>
            <div>
              <span>ρ</span>
              <strong>{analysis.greeksATM.rho.toFixed(3)}</strong>
            </div>
          </div>
        </div>
      ) : null}

      {/* Risk metrics */}
      <div
        className="quant-block"
        title="VaR / CVaR computed historically over 1y of returns. Sortino = mean / downside deviation. Sharpe = excess return / total vol, both annualized."
      >
        <span className="quant-label">Risk-adjusted metrics</span>
        <div className="quant-row">
          <div>
            <span>1d VaR(95%)</span>
            <strong className="danger">{analysis.var95.toFixed(2)}%</strong>
          </div>
          <div>
            <span>1d CVaR(95%)</span>
            <strong className="danger">{analysis.cvar95.toFixed(2)}%</strong>
          </div>
          <div>
            <span>Sortino</span>
            <strong className={tone(analysis.sortino)}>{analysis.sortino.toFixed(2)}</strong>
          </div>
          <div>
            <span>Sharpe</span>
            <strong className={tone(analysis.sharpe)}>{analysis.sharpe.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      {/* Kelly Criterion */}
      <div
        className="quant-block"
        title="Kelly Criterion (Kelly 1956) — optimal capital fraction. Full Kelly maximizes log-wealth but is too aggressive in practice. Half/Quarter Kelly are industry-standard fractional implementations to limit drawdown risk."
      >
        <span className="quant-label">Kelly position sizing</span>
        <div className="quant-row">
          <div>
            <span>Full Kelly</span>
            <strong>{(analysis.kellyFull * 100).toFixed(1)}%</strong>
          </div>
          <div>
            <span>Half Kelly</span>
            <strong>{(analysis.kellyHalf * 100).toFixed(1)}%</strong>
          </div>
          <div>
            <span>Quarter Kelly</span>
            <strong>{(analysis.kellyQuarter * 100).toFixed(1)}%</strong>
          </div>
        </div>
        <p className="quant-note">
          Recommended fraction of risk capital. Most practitioners use Half or Quarter Kelly.
        </p>
      </div>
    </section>
  )
}

function tone(value: number): string {
  if (value > 0.01) return 'positive'
  if (value < -0.01) return 'danger'
  return ''
}

function sign(value: number): string {
  return value >= 0 ? '+' : ''
}

/** Position a quantile marker on a 0-100% bar centered at 0% return. */
function pctToPosition(returnPct: number): number {
  // Map [-15, +15] → [0, 100]
  const clamped = Math.max(-15, Math.min(15, returnPct))
  return ((clamped + 15) / 30) * 100
}
