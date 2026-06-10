import { useEffect, useState } from 'react'
import { Activity, Play } from 'lucide-react'
import {
  DEFAULT_BACKTEST_TICKERS,
  PRUNED_FEATURE_NAMES,
  type DatasetBuildResult,
  type FullBacktestResult,
} from '../data/historicalBacktest'
import { kvGet, kvSet } from '../data/storage'
import { persistModel } from '../data/mlModelService'

/**
 * Historical backtest panel — actually trains a Gradient Boosted Trees
 * regressor on Yahoo's multi-year price history and reports out-of-
 * sample performance via walk-forward validation.
 *
 * This is the answer to "do we have enough data to train models?" —
 * yes, we do, as long as we use historical bars correctly.
 */

const BACKTEST_TICKERS = DEFAULT_BACKTEST_TICKERS

// Cache key includes a schema version so stale entries from earlier
// builds don't crash the panel when fields rename or get added.
// Schema bump: v5 trains on the pruned 12-feature set (importance study
// 2026-05-12); cached v4 results carry 30-feature importance vectors.
const CACHE_KEY = 'backtest:last-result:v5'

export function BacktestPanel() {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; ticker: string } | null>(null)
  const [result, setResult] = useState<FullBacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<DatasetBuildResult['diagnostics'] | null>(null)

  useEffect(() => {
    void kvGet<FullBacktestResult>(CACHE_KEY).then((cached) => {
      // Validate: required fields must be present and finite. Drop the
      // cached entry on any schema mismatch so we don't crash on render.
      if (!cached) return
      const requiredKeys: Array<keyof FullBacktestResult> = [
        'meanIC',
        'meanSpearmanIC',
        'meanHitRate',
        'meanLongShortReturnGross',
        'meanLongShortReturnNet',
        'meanLongShortSharpe',
        'cumulativeReturn',
        'maxDrawdown',
        'meanFeatureImportance',
        'totalSamples',
        'steps',
      ]
      const hasAll = requiredKeys.every(
        (key) => cached[key] !== undefined && cached[key] !== null,
      )
      if (hasAll) setResult(cached)
    })
  }, [])

  async function runBacktest() {
    setRunning(true)
    setError(null)
    setDiagnostics(null)
    setProgress({ current: 0, total: BACKTEST_TICKERS.length, ticker: BACKTEST_TICKERS[0] })
    // Spin up the Web Worker so the main thread stays responsive during
    // dataset build + walk-forward training.
    const worker = new Worker(new URL('../data/backtest.worker.ts', import.meta.url), {
      type: 'module',
    })
    return new Promise<void>((resolve) => {
      worker.onmessage = async (event) => {
        const data = event.data as
          | { type: 'progress'; current: number; total: number; ticker: string }
          | { type: 'dataset-built'; diagnostics: DatasetBuildResult['diagnostics']; sampleCount: number }
          | { type: 'done'; result: FullBacktestResult }
          | { type: 'error'; message: string }
        if (data.type === 'progress') {
          setProgress({ current: data.current, total: data.total, ticker: data.ticker })
          return
        }
        if (data.type === 'dataset-built') {
          setDiagnostics(data.diagnostics)
          return
        }
        if (data.type === 'error') {
          setError(data.message)
          setRunning(false)
          setProgress(null)
          worker.terminate()
          resolve()
          return
        }
        if (data.type === 'done') {
          const backtestResult = data.result
          setResult(backtestResult)
          const { trainedModel, ...cacheable } = backtestResult
          await kvSet(CACHE_KEY, { ...cacheable, trainedModel })

          const featureMeans = new Array(trainedModel.numFeatures).fill(0)
          const featureStds = new Array(trainedModel.numFeatures).fill(1)
          // Find the 20-day horizon bundle so we can persist p10/p90 too
          const bundle20 = backtestResult.horizonBundles?.find((entry) => entry.horizon === 20)
          await persistModel(trainedModel, {
            featureMeans,
            featureStds,
            meanIC: backtestResult.meanIC,
            meanLongShortReturnNet: backtestResult.meanLongShortReturnNet,
            meanLongShortSharpe: backtestResult.meanLongShortSharpe,
            hyperparameters: backtestResult.hyperparameters,
            p10Model: bundle20?.p10Model,
            p90Model: bundle20?.p90Model,
            // The worker trains on the pruned feature set; live predictions
            // must slice the same columns.
            featureNames: PRUNED_FEATURE_NAMES,
          })
          setRunning(false)
          setProgress(null)
          worker.terminate()
          resolve()
        }
      }
      worker.onerror = (event) => {
        setError(event.message || 'Worker crashed')
        setRunning(false)
        setProgress(null)
        worker.terminate()
        resolve()
      }
      worker.postMessage({
        type: 'run',
        tickers: BACKTEST_TICKERS,
        range: '5y',
        cadenceDays: 10,
      })
    })
  }

  return (
    <section className="panel backtest-panel" data-testid="backtest-panel">
      <header className="panel-header">
        <div>
          <p>Historical backtest</p>
          <h2>Walk-forward GBT training on Yahoo price history</h2>
        </div>
        <button
          className="primary"
          disabled={running}
          onClick={runBacktest}
          type="button"
        >
          <Play size={14} />
          {running ? 'Running…' : result ? 'Re-run backtest' : 'Run backtest'}
        </button>
      </header>

      <p className="backtest-lede">
        Trains a Gradient Boosted Trees model on 30 cross-sectionally Z-scored features
        → 20-day forward returns across {BACKTEST_TICKERS.length} liquid names. Hyperparameters
        chosen by <strong>nested walk-forward CV</strong>{' '}
        {result ? `(picked: ${result.hyperparameters.numTrees} trees, depth ${result.hyperparameters.depth}, lr ${result.hyperparameters.learningRate})` : ''}.{' '}
        <strong>Purged + embargoed walk-forward</strong> (López de Prado 2018),{' '}
        <strong>bootstrap 95% CIs</strong>, 10 bps transaction cost, baseline
        comparisons (random + 12-month momentum), permutation feature importance,
        max drawdown.
      </p>

      {progress ? (
        <div className="backtest-progress">
          <Activity size={14} />
          <span>
            Building dataset: {progress.current}/{progress.total} — {progress.ticker}
          </span>
          <div className="backtest-progress-bar">
            <span style={{ width: `${(progress.current / progress.total) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {error ? <div className="backtest-error">{error}</div> : null}

      {diagnostics ? (
        <details className="backtest-diagnostics">
          <summary>
            Dataset diagnostics: {diagnostics.tickersWithUsableBars}/{diagnostics.tickersAttempted} tickers usable
            {diagnostics.tickersWithZeroBars > 0
              ? ` · ${diagnostics.tickersWithZeroBars} fetch failures`
              : ''}
            {diagnostics.tickersBelowMinBars > 0
              ? ` · ${diagnostics.tickersBelowMinBars} below history threshold`
              : ''}
          </summary>
          <table className="backtest-step-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Bars</th>
                <th>Samples</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.perTickerSummary.map((entry) => (
                <tr key={entry.ticker}>
                  <td><strong>{entry.ticker}</strong></td>
                  <td>{entry.bars}</td>
                  <td>{entry.samplesGenerated}</td>
                  <td className={entry.reason ? 'danger' : ''}>{entry.reason ?? 'ok'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      {result ? (
        <div className="backtest-results">
          <div className="backtest-summary">
            <div>
              <span>Samples</span>
              <strong>{result.totalSamples.toLocaleString()}</strong>
            </div>
            <div>
              <span>Walk-forward steps</span>
              <strong>{result.steps.length}</strong>
            </div>
            <div>
              <span>Mean IC (95% CI)</span>
              <strong className={tone(result.meanIC, 0.02)}>
                {result.meanIC.toFixed(3)}
              </strong>
              {result.icCI ? (
                <small style={{ fontSize: 10, color: 'var(--muted)' }}>
                  [{result.icCI.lower.toFixed(3)}, {result.icCI.upper.toFixed(3)}]
                </small>
              ) : null}
            </div>
            <div>
              <span>Mean IC (Spearman)</span>
              <strong className={tone(result.meanSpearmanIC, 0.02)}>
                {result.meanSpearmanIC.toFixed(3)}
              </strong>
            </div>
            <div>
              <span>Mean hit rate</span>
              <strong className={tone(result.meanHitRate - 0.5, 0.02)}>
                {(result.meanHitRate * 100).toFixed(1)}%
              </strong>
            </div>
            <div>
              <span>L/S 20d (gross)</span>
              <strong className={tone(result.meanLongShortReturnGross, 0.5)}>
                {sign(result.meanLongShortReturnGross)}
                {result.meanLongShortReturnGross.toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>L/S 20d (net of {result.txCostBpsUsed}bps)</span>
              <strong className={tone(result.meanLongShortReturnNet, 0.5)}>
                {sign(result.meanLongShortReturnNet)}
                {result.meanLongShortReturnNet.toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>L/S Sharpe (95% CI)</span>
              <strong className={tone(result.meanLongShortSharpe, 0.3)}>
                {result.meanLongShortSharpe.toFixed(2)}
              </strong>
              {result.longShortSharpeCI ? (
                <small style={{ fontSize: 10, color: 'var(--muted)' }}>
                  [{result.longShortSharpeCI.lower.toFixed(2)}, {result.longShortSharpeCI.upper.toFixed(2)}]
                </small>
              ) : null}
            </div>
            <div>
              <span>Cumulative L/S return</span>
              <strong className={tone(result.cumulativeReturn, 0.5)}>
                {sign(result.cumulativeReturn)}
                {result.cumulativeReturn.toFixed(2)}%
              </strong>
            </div>
            <div>
              <span>Max drawdown</span>
              <strong className="danger">
                -{result.maxDrawdown.toFixed(2)}%
              </strong>
            </div>
          </div>

          <h3 className="backtest-section-title">Baseline comparison (mean IC across walk-forward)</h3>
          <p className="backtest-section-note">
            A model only matters if it beats simple alternatives. If "GBT
            model" doesn't clearly exceed "12-month momentum," the model
            isn't adding value over plain price momentum.
          </p>
          <div className="baseline-grid">
            <div>
              <span>GBT model</span>
              <strong className={tone(result.meanIC, 0.02)}>{result.meanIC.toFixed(3)}</strong>
            </div>
            <div>
              <span>Random (sanity check)</span>
              <strong>{result.meanBaselineRandomIc.toFixed(3)}</strong>
            </div>
            <div>
              <span>12-month momentum</span>
              <strong className={tone(result.meanBaselineMomentumIc, 0.02)}>
                {result.meanBaselineMomentumIc.toFixed(3)}
              </strong>
            </div>
            <div>
              <span>Edge over momentum</span>
              <strong className={tone(result.meanIC - result.meanBaselineMomentumIc, 0.01)}>
                {sign(result.meanIC - result.meanBaselineMomentumIc)}
                {(result.meanIC - result.meanBaselineMomentumIc).toFixed(3)}
              </strong>
            </div>
          </div>

          <h3 className="backtest-section-title">Multi-horizon ensemble (in-sample IC by horizon)</h3>
          <p className="backtest-section-note">
            Separate GBT trained for each forward horizon (5d, 20d, 60d, 120d). For each
            horizon, three models are trained: median (point estimate), p10 (lower bound),
            p90 (upper bound). The 80% prediction interval [p10, p90] gives a real uncertainty
            band per stock instead of a single number.
          </p>
          <div className="baseline-grid">
            {result.horizonBundles?.map((bundle) => (
              <div key={bundle.horizon}>
                <span>{bundle.horizon}d horizon IC</span>
                <strong className={tone(bundle.meanIC, 0.05)}>
                  {bundle.meanIC.toFixed(3)}
                </strong>
              </div>
            ))}
          </div>

          <h3 className="backtest-section-title">Feature importance (mean IC drop on permutation)</h3>
          <p className="backtest-section-note">
            Each feature's value is shuffled in the test set and the IC is
            recomputed. A large positive drop = the feature carries real
            signal. Near-zero or negative = the feature is noise (or
            actively hurting the model).
          </p>
          <FeatureImportancePlot importance={result.meanFeatureImportance} names={PRUNED_FEATURE_NAMES} />

          <h3 className="backtest-section-title">Decile-portfolio analysis (last test window)</h3>
          <p className="backtest-section-note">
            Stocks bucketed into 10 deciles by predicted 20d return; bars show
            actual realized return per decile. A monotonic increase = the model
            ranks correctly.
          </p>
          <DecilePlot decileReturns={result.steps[result.steps.length - 1]?.predictedDecileReturns ?? []} />

          <h3 className="backtest-section-title">Walk-forward step history</h3>
          <table className="backtest-step-table">
            <thead>
              <tr>
                <th>Test window</th>
                <th>IC</th>
                <th>Hit rate</th>
                <th>L/S net</th>
                <th>Train size</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.slice(-10).map((step) => (
                <tr key={step.testStartDate}>
                  <td>{step.testStartDate} → {step.testEndDate}</td>
                  <td className={tone(step.informationCoefficient, 0.02)}>
                    {step.informationCoefficient.toFixed(3)}
                  </td>
                  <td className={tone(step.hitRate - 0.5, 0.02)}>
                    {(step.hitRate * 100).toFixed(1)}%
                  </td>
                  <td className={tone(step.longShortReturnNet, 0.5)}>
                    {sign(step.longShortReturnNet)}
                    {step.longShortReturnNet.toFixed(2)}%
                  </td>
                  <td>{step.trainSize.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="backtest-disclaimer">
            <strong>What's correct here:</strong> purged + embargoed walk-forward (López
            de Prado 2018) prevents label leakage from overlapping forward returns;
            cross-sectional Z-score normalization at each date so the model learns relative
            ranking; permutation feature importance flags noise features; baselines anchor
            interpretation; {result.txCostBpsUsed}bps transaction cost subtracted (each
            side); {result.embargoDaysUsed}-day embargo between train and test.
            <br /><br />
            <strong>What's still missing:</strong> survivorship bias (Yahoo gives only
            surviving tickers — inflates every metric); shorting borrow costs not modeled;
            no nested CV for hyperparameter tuning; bootstrap CIs on metrics not yet
            computed. Treat IC &gt; 0.03 (over momentum baseline) and net L/S Sharpe &gt; 0.5
            as meaningful — below that, the model isn't adding value over passive momentum.
          </p>
        </div>
      ) : null}
    </section>
  )
}

function DecilePlot({ decileReturns }: { decileReturns: number[] }) {
  if (decileReturns.length === 0) return null
  const max = Math.max(...decileReturns.map(Math.abs), 0.01)
  return (
    <div className="decile-plot">
      {decileReturns.map((value, idx) => {
        const widthPct = (Math.abs(value) / max) * 50
        const offsetPct = value >= 0 ? 50 : 50 - widthPct
        return (
          <div className="decile-row" key={idx}>
            <span className="decile-label">D{idx + 1}</span>
            <div className="decile-bar">
              <span className="decile-tick" />
              <span
                className={`decile-fill ${value >= 0 ? 'positive' : 'danger'}`}
                style={{ width: `${widthPct}%`, left: `${offsetPct}%` }}
              />
            </div>
            <strong className={value >= 0 ? 'positive' : 'danger'}>
              {value >= 0 ? '+' : ''}
              {value.toFixed(2)}%
            </strong>
          </div>
        )
      })}
    </div>
  )
}

function FeatureImportancePlot({
  importance,
  names,
}: {
  importance: number[]
  names: string[]
}) {
  if (importance.length === 0) return null
  // Sort by importance descending so the most informative feature is at top
  const indexed = importance.map((value, idx) => ({ value, name: names[idx] ?? `f${idx}` }))
  indexed.sort((left, right) => right.value - left.value)
  const max = Math.max(...importance.map(Math.abs), 0.001)
  return (
    <div className="feature-importance-plot">
      {indexed.map((entry) => {
        const widthPct = (Math.abs(entry.value) / max) * 100
        return (
          <div className="feature-row" key={entry.name}>
            <span className="feature-name">{entry.name}</span>
            <div className="feature-bar">
              <span
                className={`feature-fill ${entry.value >= 0 ? 'positive' : 'danger'}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <strong className={entry.value >= 0 ? 'positive' : 'danger'}>
              {entry.value >= 0 ? '+' : ''}
              {entry.value.toFixed(3)}
            </strong>
          </div>
        )
      })}
    </div>
  )
}

function tone(value: number, threshold: number): string {
  if (value >= threshold) return 'positive'
  if (value <= -threshold) return 'danger'
  return ''
}

function sign(value: number): string {
  return value >= 0 ? '+' : ''
}
