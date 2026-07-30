import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  CalendarClock,
  CircleDollarSign,
  Layers,
  Minus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import {
  assessMlDirectionalEvidence,
  type DecisionSignal,
  type MarketContext,
  type MlDirectionalEvidenceAssessment,
  type ScenarioId,
} from '../data/decisionEngine'
import type { LivePrediction } from '../data/mlModelService'
import type { StoredHolding } from '../data/storage'
import { compareByConviction, type ConvictionStack } from '../data/convictionStack'
import {
  cachedRecommendStrategies,
  type StrategyRecommendation,
} from '../data/optionsStrategies'

/**
 * Single-page executive summary: top buy / hold / sell decisions today,
 * this week's options plan, portfolio P&L snapshot, what changed since
 * last review, and market context. Built to be the daily landing page
 * that answers "what do I need to know right now?" in 30 seconds.
 */

const TOP_N_PER_BUCKET = 3
const OPTIONS_PLAN_TICKER_CAP = 8

export type BriefBuyEvidenceSignal = Pick<
  DecisionSignal,
  | 'dataConfidence'
  | 'dataSource'
  | 'dataWarnings'
  | 'fundamentalsAsOf'
  | 'fundamentalsSource'
  | 'priceAsOf'
  | 'priceBasis'
  | 'verdictSource'
>

export type BriefBuyEvidencePrediction = Pick<
  LivePrediction,
  'asOf' | 'p10Return20d' | 'p90Return20d' | 'predictedReturn20d' | 'normalizationMode'
>

export type BriefBuyEvidenceAssessment = MlDirectionalEvidenceAssessment

/**
 * The Executive Brief is the money-moving surface, so a green action earns
 * that placement only when every available evidence clock agrees. The 80%
 * confidence gate is the engine's existing Buy Now gate; interval > 0 uses
 * the model's natural no-relative-edge boundary, not a hand-tuned return cut.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function assessBriefBuyEvidence(
  signal: BriefBuyEvidenceSignal,
  prediction: BriefBuyEvidencePrediction | null,
  scenario: ScenarioId = 'base',
): BriefBuyEvidenceAssessment {
  return assessMlDirectionalEvidence(signal, prediction, 'bullish', scenario)
}

type Props = {
  universe: DecisionSignal[]
  ownedTickers: Set<string>
  watchTickers: Set<string>
  holdings: StoredHolding[]
  mlPredictions: Map<string, LivePrediction>
  convictionStacks: Map<string, ConvictionStack>
  portfolioMetrics: {
    value: number
    cost: number
    pnl: number | null
    pnlPct: number | null
    positionsWithCost: number
  } | null
  marketContext: MarketContext
  asOf: string
  activeScenario: ScenarioId
  onOpenStock: (ticker: string) => void
}

export function ExecutiveBrief(props: Props) {
  const {
    universe,
    ownedTickers,
    watchTickers,
    holdings,
    mlPredictions,
    convictionStacks,
    portfolioMetrics,
    marketContext,
    asOf,
    activeScenario,
    onOpenStock,
  } = props

  // Buy candidates are ranked by independent corroboration, then split by an
  // evidence gate. Only the decision-grade slice reaches "Top buys"; every
  // held-back name remains inspectable with the exact reason it was blocked.
  const buyCandidates = useMemo(
    () =>
      universe
        .filter(
          (signal) =>
            !ownedTickers.has(signal.ticker) &&
            (signal.action === 'Buy Now' ||
              signal.action === 'Accumulate' ||
              // Evidence-gated models deliberately demote their would-be
              // green labels to Hold. Keep those names visible only in the
              // research/advisory bucket instead of silently losing them.
              signal.verdictSource === 'demoted-evidence' ||
              // A promoted model can still fail the current per-name clock or
              // calibrated-interval gate. Keep that lead inspectable here.
              signal.verdictSource === 'ml-veto'),
        )
        .sort(compareByConviction(convictionStacks)),
    [universe, ownedTickers, convictionStacks],
  )
  const buyEvidence = useMemo(
    () =>
      new Map(
        buyCandidates.map((signal) => [
          signal.ticker,
          assessBriefBuyEvidence(
            signal,
            mlPredictions.get(signal.ticker) ?? null,
            activeScenario,
          ),
        ]),
      ),
    [buyCandidates, mlPredictions, activeScenario],
  )
  const topBuys = useMemo(
    () =>
      buyCandidates
        .filter((signal) => buyEvidence.get(signal.ticker)?.decisionGrade === true)
        .slice(0, TOP_N_PER_BUCKET),
    [buyCandidates, buyEvidence],
  )
  const advisoryBuys = useMemo(
    () =>
      buyCandidates.filter(
        (signal) => buyEvidence.get(signal.ticker)?.decisionGrade !== true,
      ),
    [buyCandidates, buyEvidence],
  )

  // Top sells: owned positions where the engine flags Sell / Trim / Avoid.
  const topSells = useMemo(() => {
    const owned = universe.filter((signal) => ownedTickers.has(signal.ticker))
    return owned
      .filter(
        (signal) =>
          signal.action === 'Sell' ||
          signal.action === 'Trim' ||
          signal.action === 'Avoid',
      )
      .sort((left, right) => right.thesisDamage - left.thesisDamage)
      .slice(0, TOP_N_PER_BUCKET)
  }, [universe, ownedTickers])

  // Top holds: owned positions ranked Hold with high confidence (positions
  // doing exactly what they should be).
  const topHolds = useMemo(() => {
    const owned = universe.filter((signal) => ownedTickers.has(signal.ticker))
    return owned
      .filter((signal) => signal.action === 'Hold')
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, TOP_N_PER_BUCKET)
  }, [universe, ownedTickers])

  // Options plan: aggregate the highest-scored strategy per ticker
  // across the top buys + risky owned positions, up to OPTIONS_PLAN_TICKER_CAP.
  const [optionsPlan, setOptionsPlan] = useState<
    Array<{ ticker: string; signal: DecisionSignal; strategy: StrategyRecommendation }>
  >([])
  const [optionsPlanLoading, setOptionsPlanLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Tickers to evaluate: top buys (for entry strategies) + top sells/holds
    // (for income + hedging strategies). Cap to avoid hammering Tradier.
    const candidates = [
      ...topBuys.slice(0, 3),
      ...topSells.slice(0, 3),
      ...topHolds.slice(0, 3),
    ].slice(0, OPTIONS_PLAN_TICKER_CAP)
    if (candidates.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOptionsPlan([])
      setOptionsPlanLoading(false)
      return
    }
    setOptionsPlanLoading(true)
    void Promise.all(
      candidates.map(async (signal) => {
        const holding = holdings.find((entry) => entry.ticker === signal.ticker) ?? null
        try {
          const strategies = await cachedRecommendStrategies(signal, holding)
          // Top strategy by score (>= 30 to filter out marginal ones)
          const top = strategies.find((entry) => entry.score >= 30)
          return top ? { ticker: signal.ticker, signal, strategy: top } : null
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const filtered = results.filter(
        (entry): entry is { ticker: string; signal: DecisionSignal; strategy: StrategyRecommendation } =>
          entry !== null,
      )
      filtered.sort((left, right) => right.strategy.score - left.strategy.score)
      setOptionsPlan(filtered)
      setOptionsPlanLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [topBuys, topSells, topHolds, holdings])

  const watchlistBuySignals = useMemo(
    () =>
      buyCandidates.filter(
        (signal) =>
          watchTickers.has(signal.ticker) &&
          buyEvidence.get(signal.ticker)?.decisionGrade === true,
      ),
    [buyCandidates, watchTickers, buyEvidence],
  )

  return (
    <div className="exec-brief">
      <header className="exec-brief-header">
        <div>
          <p>Executive brief</p>
          <h1>What to do right now</h1>
          <span className="exec-brief-meta">
            Brief refreshed {new Date(asOf).toLocaleString()} · regime{' '}
            <strong>{marketContext.regime}</strong> · {activeScenario === 'base' ? 'live' : `scenario: ${activeScenario}`}
          </span>
        </div>
        <div className="exec-brief-market">
          <div>
            <span>Breadth</span>
            <strong>{marketContext.breadth}%</strong>
          </div>
          <div>
            <span>Risk</span>
            <strong>{marketContext.riskScore}</strong>
          </div>
          <div>
            <span>Credit stress</span>
            <strong>{marketContext.creditStress}%</strong>
          </div>
        </div>
      </header>

      {/* Top decisions grid */}
      <section className="exec-actions">
        <ActionBucket
          icon={<TrendingUp size={14} />}
          label="Decision-grade buys"
          rows={topBuys}
          tone="positive"
          mlPredictions={mlPredictions}
          convictionStacks={convictionStacks}
          buyEvidence={buyEvidence}
          note="Requires an ML-led verdict, data confidence 80+, SEC XBRL, matching price/forecast dates, and an 80% interval above zero vs peers."
          empty="No unowned names pass every evidence and uncertainty gate right now."
          onOpenStock={onOpenStock}
        />
        <ActionBucket
          icon={<Minus size={14} />}
          label="Top holds (owned)"
          rows={topHolds}
          tone="neutral"
          mlPredictions={mlPredictions}
          empty="No owned positions in Hold state."
          onOpenStock={onOpenStock}
        />
        <ActionBucket
          icon={<TrendingDown size={14} />}
          label="Top sells (owned)"
          rows={topSells}
          tone="danger"
          mlPredictions={mlPredictions}
          empty="No owned positions trigger sell discipline."
          onOpenStock={onOpenStock}
        />
      </section>

      {advisoryBuys.length > 0 ? (
        <section className="exec-changes" aria-label="Research-only buy candidates">
          <header>
            <Minus size={14} />
            <strong>Advisory only — held out of Top buys</strong>
            <span className="exec-meta">{advisoryBuys.length} blocked</span>
          </header>
          <p className="exec-empty">
            These are research leads, not actions. Each is missing at least one required evidence check.
          </p>
          <ul className="exec-changes-list">
            {advisoryBuys.slice(0, TOP_N_PER_BUCKET).map((signal) => {
              const assessment = buyEvidence.get(signal.ticker)
              return (
                <li className="danger" key={signal.ticker}>
                  <ArrowDownRight size={12} />
                  <strong>{signal.ticker}</strong>
                  <span title={assessment?.blockers.join(' · ')}>
                    {assessment?.blockers.slice(0, 2).join(' · ') ?? 'evidence gate incomplete'}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => onOpenStock(signal.ticker)}
                    type="button"
                  >
                    Inspect
                  </button>
                </li>
              )
            })}
          </ul>
          {advisoryBuys.length > TOP_N_PER_BUCKET ? (
            <p className="exec-empty">
              {advisoryBuys.length - TOP_N_PER_BUCKET} more research-only candidates omitted from this brief.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Options plan */}
      <section className="exec-options">
        <header>
          <Layers size={14} />
          <strong>This week's options plan</strong>
          {optionsPlanLoading ? <span className="exec-meta">Pulling Tradier chains…</span> : null}
        </header>
        {optionsPlan.length === 0 && !optionsPlanLoading ? (
          <p className="exec-empty">
            No options strategies recommended right now. Either no Tradier token
            is configured or no ticker setup meets a strategy's criteria.
          </p>
        ) : (
          <ul className="exec-options-list">
            {optionsPlan.map(({ ticker, signal, strategy }) => (
              <li className="exec-options-row" key={`${ticker}-${strategy.name}`}>
                <div className="exec-options-lead">
                  <button
                    aria-label={`Open ${ticker}`}
                    className="exec-ticker-link"
                    onClick={() => onOpenStock(ticker)}
                    type="button"
                  >
                    <strong>{ticker}</strong>
                    <span>{signal.action}</span>
                  </button>
                  <span className="exec-options-name">{strategy.name}</span>
                </div>
                <div className="exec-options-meta">
                  <span>
                    {strategy.daysToExpiry > 0
                      ? `${strategy.daysToExpiry}d`
                      : 'directional'}
                  </span>
                  <span className={strategy.yieldOrCost >= 0 ? 'positive' : 'danger'}>
                    {strategy.yieldOrCost >= 0 ? '+' : ''}
                    {strategy.yieldOrCost.toFixed(2)}%
                  </span>
                  <span className="exec-options-score">score {Math.round(strategy.score)}</span>
                </div>
                <p className="exec-options-rationale">{strategy.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Portfolio pulse */}
      <section className="exec-portfolio">
        <header>
          <Briefcase size={14} />
          <strong>Portfolio</strong>
        </header>
        {portfolioMetrics && portfolioMetrics.value > 0 ? (
          <div className="exec-portfolio-grid">
            <div>
              <span>Market value</span>
              <strong>{formatCurrency(portfolioMetrics.value)}</strong>
            </div>
            <div>
              <span>Cost basis</span>
              <strong>
                {portfolioMetrics.positionsWithCost > 0
                  ? formatCurrency(portfolioMetrics.cost)
                  : '—'}
              </strong>
            </div>
            <div>
              <span>Unrealized P&L</span>
              <strong
                className={
                  portfolioMetrics.pnl == null
                    ? ''
                    : portfolioMetrics.pnl >= 0
                      ? 'positive'
                      : 'danger'
                }
              >
                {portfolioMetrics.pnl == null
                  ? 'add cost basis'
                  : `${portfolioMetrics.pnl >= 0 ? '+' : ''}${formatCurrency(portfolioMetrics.pnl)}${portfolioMetrics.pnlPct != null ? ` (${portfolioMetrics.pnlPct >= 0 ? '+' : ''}${portfolioMetrics.pnlPct.toFixed(1)}%)` : ''}`}
              </strong>
            </div>
            <div>
              <span>Tracked positions</span>
              <strong>{ownedTickers.size}</strong>
            </div>
          </div>
        ) : (
          <p className="exec-empty">
            No portfolio data — import positions via the topbar to see P&L and personal decisions.
          </p>
        )}
      </section>

      {/* Watchlist status — this is not labeled a crossing because the Brief
          does not persist the prior action required to prove a transition. */}
      {watchlistBuySignals.length > 0 ? (
        <section className="exec-changes">
          <header>
            <CalendarClock size={14} />
            <strong>Decision-grade watchlist signals</strong>
          </header>
          <ul className="exec-changes-list">
            {watchlistBuySignals.slice(0, 5).map((signal) => (
              <li className="positive" key={signal.ticker}>
                <ArrowUpRight size={12} />
                <strong>{signal.ticker}</strong>
                <span>currently ranks {signal.action}; all Brief evidence gates pass</span>
                <button
                  className="ghost"
                  onClick={() => onOpenStock(signal.ticker)}
                  type="button"
                >
                  Inspect
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function ActionBucket({
  icon,
  label,
  rows,
  tone,
  mlPredictions,
  convictionStacks,
  buyEvidence,
  note,
  empty,
  onOpenStock,
}: {
  icon: React.ReactNode
  label: string
  rows: DecisionSignal[]
  tone: 'positive' | 'neutral' | 'danger'
  mlPredictions: Map<string, LivePrediction>
  /** Present only for the buys bucket — the stack measures bull-case
   * corroboration, so showing it on sells would invert its meaning. */
  convictionStacks?: Map<string, ConvictionStack>
  /** Present only for the buys bucket; records why the money-moving Brief
   * considers each row decision-grade. */
  buyEvidence?: Map<string, BriefBuyEvidenceAssessment>
  note?: string
  empty: string
  onOpenStock: (ticker: string) => void
}) {
  return (
    <section className={`exec-bucket ${tone}`}>
      <header>
        {icon}
        <strong>{label}</strong>
        <span>{rows.length}</span>
      </header>
      {note ? <p className="exec-empty">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="exec-empty">{empty}</p>
      ) : (
        <ul className="exec-bucket-list">
          {rows.map((row) => {
            const prediction = mlPredictions.get(row.ticker)
            const stack = convictionStacks?.get(row.ticker)
            const assessment = buyEvidence?.get(row.ticker)
            return (
              <li className="exec-bucket-row" key={row.ticker}>
                <div className="exec-bucket-top">
                  <button
                    aria-label={`Open ${row.ticker}`}
                    className="exec-ticker-link"
                    onClick={() => onOpenStock(row.ticker)}
                    type="button"
                  >
                    <strong>{row.ticker}</strong>
                    <span>{row.name}</span>
                  </button>
                  <span className={`exec-action-pill ${tone}`}>{row.action}</span>
                </div>
                {stack ? (
                  <span
                    className={`exec-conviction-chip ${stack.tone}`}
                    title={stack.layers
                      .map((layer) => `${layer.status === 'pass' ? '✓' : layer.status === 'fail' ? '✗' : '—'} ${layer.label}`)
                      .join('  ')}
                  >
                    {stack.label} · {stack.passed}/{stack.available} methods
                  </span>
                ) : null}
                {assessment ? (
                  <span
                    className="exec-conviction-chip positive"
                    title={`${assessment.evidenceSource} · ${assessment.uncertainty}`}
                  >
                    Decision grade · synced evidence
                  </span>
                ) : null}
                <p className="exec-bucket-reason">{row.evidence[0] ?? ''}</p>
                <div className="exec-bucket-stats">
                  <span>
                    Opp {row.opportunityScore} · Risk {row.riskScore} · Factor conf {row.confidence}
                  </span>
                  <span
                    className={
                      tone === 'danger'
                        ? 'danger'
                        : row.forecast20d >= 0
                          ? 'positive'
                          : 'danger'
                    }
                    title={
                      row.quantConfirmed
                        ? 'Monte Carlo mean from the ticker quant overlay'
                        : 'Rule-derived factor-score translation; not a calibrated return forecast'
                    }
                  >
                    {row.quantConfirmed ? 'MC mean' : 'Factor proxy'}{' '}
                    {row.forecast20d >= 0 ? '+' : ''}
                    {row.forecast20d.toFixed(1)}% / 20d
                  </span>
                  {prediction ? (
                    <span
                      className={prediction.predictedReturn20d >= 0 ? 'positive' : 'danger'}
                      title="ML expected 20-day RELATIVE outperformance; interval is split-conformalized from held-out data"
                    >
                      ML {prediction.predictedReturn20d >= 0 ? '+' : ''}
                      {prediction.predictedReturn20d.toFixed(1)}% vs peers ·{' '}
                      {validPredictionInterval(prediction)
                        ? `80% PI [${signedPct(prediction.p10Return20d!)}, ${signedPct(prediction.p90Return20d!)}]`
                        : 'interval unavailable'}
                    </span>
                  ) : null}
                  <span title={row.dataSource ?? 'Price source not reported'}>
                    Evidence: {formatPriceEvidenceSource(row.dataSource)}{' '}
                    {formatEvidenceDate(row.priceAsOf)} ·{' '}
                    {row.fundamentalsSource === 'sec-edgar-xbrl'
                      ? `SEC XBRL ${formatEvidenceDate(row.fundamentalsAsOf)}`
                      : 'SEC XBRL unavailable'}{' '}
                    · data {Math.round(row.dataConfidence ?? 0)}
                  </span>
                  {row.dataWarnings && row.dataWarnings.length > 0 ? (
                    <span title={row.dataWarnings.join(' · ')}>
                      Data notes: {summarizeDataCaveats(row.dataWarnings)}
                    </span>
                  ) : null}
                  {row.recommendedKellyHalfPct != null && tone === 'positive' ? (
                    <span>
                      <CircleDollarSign size={10} /> {row.recommendedKellyHalfPct}% Kelly
                    </span>
                  ) : null}
                  {tone === 'danger' && row.thesisDamage >= 60 ? (
                    <span className="danger">
                      <ArrowDownRight size={10} /> Thesis {row.thesisDamage}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function formatCurrency(value: number) {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function isoDay(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!match) return null
  const date = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function validPredictionInterval(prediction: BriefBuyEvidencePrediction): boolean {
  const lower = prediction.p10Return20d
  const upper = prediction.p90Return20d
  return (
    lower != null &&
    upper != null &&
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    lower <= prediction.predictedReturn20d &&
    prediction.predictedReturn20d <= upper
  )
}

function formatEvidenceDate(value: string | null | undefined): string {
  return isoDay(value) ?? 'date unavailable'
}

function formatPriceEvidenceSource(source: string | undefined): string {
  if (!source) return 'price source unavailable'
  if (/ohlcv/i.test(source)) return 'OHLCV'
  if (source === 'priors') return 'price priors'
  return source
}

function summarizeDataCaveats(warnings: string[]): string {
  const topics: string[] = []
  const add = (topic: string) => {
    if (!topics.includes(topic)) topics.push(topic)
  }
  for (const warning of warnings) {
    if (/stale/i.test(warning)) add('stale price')
    if (/revision|analyst/i.test(warning)) add('estimate revisions')
    if (/option|skew|term structure/i.test(warning)) add('options proxy')
    if (/liquidity/i.test(warning)) add('liquidity')
    if (/history/i.test(warning)) add('short history')
  }
  return topics.length > 0
    ? topics.join(', ')
    : `${warnings.length} feed note${warnings.length === 1 ? '' : 's'}`
}
