import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Filter,
  Gauge,
  LineChart,
  RefreshCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Target,
  X,
} from 'lucide-react'
import {
  actionTone,
  formatSignedPercent,
  marketContext,
  scenarios,
  scoreUniverse,
  sectorScores,
  sortSignals,
  type Action,
  type DecisionSignal,
  type MarketContext,
  type RawSignal,
  type ScenarioId,
  type SortKey,
  type Tone,
} from './data/decisionEngine'
import {
  loadDecisionUniverse,
  type DecisionHistoryPoint,
  type DecisionUniverseResponse,
} from './data/decisionApi'
import './App.css'

type ViewId = 'decision' | 'buy' | 'hold' | 'sell' | 'radar' | 'scenario'
type ActionFilter = 'All' | 'Buy' | 'Hold' | 'Risk'
type FeedStatus = 'loading' | 'backend' | 'fallback'

type NavItem = {
  id: ViewId
  label: string
  eyebrow: string
  heading: string
  icon: ComponentType<{ size?: number }>
}

const navItems: NavItem[] = [
  {
    id: 'decision',
    label: 'Decision Desk',
    eyebrow: 'Decision Desk',
    heading: 'What to buy, hold, trim, sell, and avoid',
    icon: CircleDollarSign,
  },
  {
    id: 'buy',
    label: 'Buy Board',
    eyebrow: 'Buy Board',
    heading: 'Highest-confidence accumulation candidates',
    icon: Target,
  },
  {
    id: 'hold',
    label: 'Hold Board',
    eyebrow: 'Hold Board',
    heading: 'Positions with enough evidence to stay patient',
    icon: CheckCircle2,
  },
  {
    id: 'sell',
    label: 'Sell Board',
    eyebrow: 'Sell Board',
    heading: 'Deterioration clusters that need action',
    icon: ShieldAlert,
  },
  {
    id: 'radar',
    label: 'Market Radar',
    eyebrow: 'Market Radar',
    heading: 'Regime, breadth, volatility, and sector rotation',
    icon: Gauge,
  },
  {
    id: 'scenario',
    label: 'Scenario Lab',
    eyebrow: 'Scenario Lab',
    heading: 'Stress the market and re-rank the universe',
    icon: SlidersHorizontal,
  },
]

const actionFilters: ActionFilter[] = ['All', 'Buy', 'Hold', 'Risk']
const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'action', label: 'Action priority' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'risk', label: 'Risk' },
  { value: 'data', label: 'Data quality' },
  { value: 'regimeFit', label: 'Regime fit' },
]
const actionOrder: Action[] = ['Buy Now', 'Accumulate', 'Hold', 'Trim', 'Sell', 'Avoid']
const ownedStorageKey = 'finance-oracle-owned-tickers'
const watchStorageKey = 'finance-oracle-watch-tickers'
const maxTableRows = 260
const maxBoardCards = 96
const maxRiskRows = 140

function readOwnedTickers() {
  return readStoredTickers(ownedStorageKey)
}

function readWatchTickers() {
  return readStoredTickers(watchStorageKey)
}

function readStoredTickers(storageKey: string) {
  try {
    const stored = window.localStorage.getItem(storageKey)
    const decoded = stored ? (JSON.parse(stored) as unknown) : []
    if (!Array.isArray(decoded)) return new Set<string>()
    return new Set(decoded.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))
  } catch {
    return new Set<string>()
  }
}

function formatFeedTime(value: string | null) {
  if (!value) return 'pending'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'pending'
  return parsed.toLocaleTimeString()
}

function formatDate(value?: string | null) {
  if (!value) return 'not synced'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'not synced'
  return parsed.toLocaleDateString()
}

function feedLabel(status: FeedStatus) {
  if (status === 'loading') return 'Loading'
  if (status === 'backend') return 'Backend cache'
  return 'No live picks'
}

function actionFilterFor(action: Action): ActionFilter {
  if (action === 'Buy Now' || action === 'Accumulate') return 'Buy'
  if (action === 'Hold') return 'Hold'
  return 'Risk'
}

function viewForAction(action: Action): ViewId {
  if (action === 'Buy Now' || action === 'Accumulate') return 'buy'
  if (action === 'Hold') return 'hold'
  return 'sell'
}

function actionFilterForView(view: ViewId): ActionFilter {
  if (view === 'buy') return 'Buy'
  if (view === 'hold') return 'Hold'
  if (view === 'sell') return 'Risk'
  return 'All'
}

function viewForActionFilter(filter: ActionFilter): ViewId {
  if (filter === 'Buy') return 'buy'
  if (filter === 'Hold') return 'hold'
  if (filter === 'Risk') return 'sell'
  return 'decision'
}

function portfolioActionFor(signal: DecisionSignal, owned: boolean, watched: boolean) {
  if (owned) {
    if (signal.action === 'Buy Now' || signal.action === 'Accumulate') return 'Hold / add selectively'
    if (signal.action === 'Hold') return 'Hold'
    if (signal.action === 'Trim') return 'Trim'
    if (signal.action === 'Sell') return 'Exit candidate'
    return 'Reduce or avoid fresh exposure'
  }
  if (watched && (signal.action === 'Buy Now' || signal.action === 'Accumulate')) return 'Watchlist buy setup'
  if (watched && (signal.action === 'Trim' || signal.action === 'Sell' || signal.action === 'Avoid')) return 'Watchlist risk flag'
  if (signal.action === 'Buy Now') return 'Buy candidate'
  if (signal.action === 'Accumulate') return 'Accumulate on pullbacks'
  if (signal.action === 'Hold') return 'Watch only'
  if (signal.action === 'Trim') return 'Do not initiate'
  if (signal.action === 'Sell') return 'Avoid / short-list risk'
  return 'Avoid for now'
}

function signalReadiness(signal: DecisionSignal): { label: string; tone: Tone; detail: string } {
  const dataConfidence = signal.dataConfidence ?? 0
  const warnings = signal.dataWarnings ?? []
  const missingCoreFeeds = warnings.some((warning) =>
    ['Fundamental', 'estimate', 'Listed-options'].some((needle) => warning.includes(needle)),
  )
  if (dataConfidence >= 72 && !missingCoreFeeds) {
    return {
      label: 'Decision grade',
      tone: 'positive',
      detail: 'Full evidence stack is available.',
    }
  }
  if (dataConfidence >= 60) {
    return {
      label: 'Price-backed',
      tone: 'caution',
      detail: 'Market-data case is live; fundamental and options confirmation are incomplete.',
    }
  }
  return {
    label: 'Research only',
    tone: 'danger',
    detail: 'Evidence is too thin for a high-conviction decision.',
  }
}

function missingEvidenceCount(signal: DecisionSignal) {
  return (signal.dataWarnings ?? []).filter((warning) =>
    ['not connected', 'neutral', 'stale', 'Short price', 'thin'].some((needle) => warning.includes(needle)),
  ).length
}

function actionableRows(rows: DecisionSignal[]) {
  return rows.filter((row) => signalReadiness(row).label !== 'Research only')
}

function Metric({
  label,
  value,
  tone = 'neutral',
  detail,
}: {
  label: string
  value: string
  tone?: Tone
  detail?: string
}) {
  return (
    <section className="metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </section>
  )
}

function ScoreBar({ value, tone = 'neutral' }: { value: number; tone?: Tone }) {
  return (
    <div className="score">
      <span style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} className={tone}></span>
    </div>
  )
}

function ActionPill({ action }: { action: Action }) {
  return <span className={`pill ${actionTone(action)}`}>{action}</span>
}

function SignalButton({
  signal,
  context,
  label = 'Open',
  onOpen,
}: {
  signal: DecisionSignal
  context: string
  label?: string
  onOpen: (signal: DecisionSignal) => void
}) {
  return (
    <button
      aria-label={`Open ${signal.ticker}`}
      data-testid={`open-${context}-${signal.ticker}`}
      onClick={() => onOpen(signal)}
      type="button"
    >
      <LineChart size={16} />
      <span>{label}</span>
    </button>
  )
}

function riskPriority(row: DecisionSignal) {
  const actionPenalty = row.action === 'Sell' ? 28 : row.action === 'Trim' ? 18 : row.action === 'Avoid' ? 12 : 0
  return row.thesisDamage * 0.45 + row.riskScore * 0.3 + row.fragilityScore * 0.18 + actionPenalty
}

function byRiskPriority(left: DecisionSignal, right: DecisionSignal) {
  return riskPriority(right) - riskPriority(left)
}

function HeroDecisionCard({
  label,
  signal,
  tone,
  onOpen,
}: {
  label: string
  signal: DecisionSignal | undefined
  tone: Tone
  onOpen: (signal: DecisionSignal) => void
}) {
  if (!signal) {
    return (
      <section className="hero-card">
        <p>{label}</p>
        <h2>No signal</h2>
      </section>
    )
  }

  return (
    <section className={`hero-card ${tone}`}>
      <p>{label}</p>
      <div className="hero-row">
        <div>
          <h2>{signal.ticker}</h2>
          <span>{signal.name}</span>
        </div>
        <ActionPill action={signal.action} />
      </div>
      <div className="hero-stats">
        <span>Opp {signal.opportunityScore}</span>
        <span>Conf {signal.confidence}</span>
        <span>Risk {signal.riskScore}</span>
        <span>{formatSignedPercent(signal.forecast20d)} 20d</span>
      </div>
      <p className="hero-reason">{signal.evidence[0]}</p>
      <SignalButton
        context={`hero-${label.toLowerCase().replace(/\s+/g, '-')}`}
        signal={signal}
        label="Inspect"
        onOpen={onOpen}
      />
    </section>
  )
}

function ReadinessGate({
  feed,
  rows,
  status,
}: {
  feed: DecisionUniverseResponse | null
  rows: DecisionSignal[]
  status: FeedStatus
}) {
  const qualified = feed?.returned ?? rows.length
  const universeSize = feed?.universeSize ?? rows.length
  const excluded = feed?.excludedForInsufficientData ?? Math.max(0, universeSize - qualified)
  const actionable = actionableRows(rows).length
  const readinessTone: Tone = status === 'backend' && qualified > 0 ? 'caution' : status === 'loading' ? 'neutral' : 'danger'
  const readinessLabel =
    status === 'loading'
      ? 'Loading evidence'
      : status === 'backend' && qualified > 0
        ? 'Price-backed, incomplete'
        : 'Recommendations paused'

  return (
    <section className="readiness-panel" data-testid="readiness-gate">
      <div className="readiness-lead">
        <p>Decision readiness</p>
        <h2>{readinessLabel}</h2>
        <span>{feed?.detail ?? 'Waiting for backend decision evidence.'}</span>
      </div>
      <div className="readiness-grid">
        <Metric
          label="Usable cases"
          value={`${actionable}/${qualified}`}
          detail="Above research-only data threshold"
          tone={readinessTone}
        />
        <Metric
          label="Excluded"
          value={`${excluded}`}
          detail="No fresh OHLCV, no recommendation"
          tone={excluded > 0 ? 'caution' : 'positive'}
        />
        <Metric
          label="Latest bar"
          value={formatDate(feed?.priceCoverage.latestPriceDate)}
          detail={`${feed?.priceCoverage.usableSymbolCount ?? 0} usable price histories`}
          tone={feed?.priceCoverage.usableSymbolCount ? 'neutral' : 'danger'}
        />
        <Metric
          label="Missing feeds"
          value="3"
          detail="Fundamentals, estimates, listed options"
          tone="caution"
        />
      </div>
    </section>
  )
}

function Controls({
  query,
  actionFilter,
  sector,
  sectors,
  sortKey,
  highConvictionOnly,
  onQueryChange,
  onActionFilterChange,
  onSectorChange,
  onSortChange,
  onHighConvictionChange,
  onClear,
}: {
  query: string
  actionFilter: ActionFilter
  sector: string
  sectors: string[]
  sortKey: SortKey
  highConvictionOnly: boolean
  onQueryChange: (value: string) => void
  onActionFilterChange: (value: ActionFilter) => void
  onSectorChange: (value: string) => void
  onSortChange: (value: SortKey) => void
  onHighConvictionChange: (value: boolean) => void
  onClear: () => void
}) {
  return (
    <section className="control-strip">
      <label className="search">
        <Search size={16} />
        <input
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search ticker, company, sector"
          value={query}
        />
      </label>

      <div className="segmented" aria-label="Action filter">
        {actionFilters.map((filter) => (
          <button
            className={actionFilter === filter ? 'active' : ''}
            data-testid={`filter-${filter}`}
            key={filter}
            onClick={() => onActionFilterChange(filter)}
            type="button"
          >
            {filter}
          </button>
        ))}
      </div>

      <label className="select-control">
        <span>Sector</span>
        <select
          data-testid="sector-select"
          onChange={(event) => onSectorChange(event.target.value)}
          value={sector}
        >
          {sectors.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label className="select-control">
        <span>Sort</span>
        <select
          data-testid="sort-select"
          onChange={(event) => onSortChange(event.target.value as SortKey)}
          value={sortKey}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="toggle-control">
        <input
          checked={highConvictionOnly}
          data-testid="high-conviction-toggle"
          onChange={(event) => onHighConvictionChange(event.target.checked)}
          type="checkbox"
        />
        <span>High conviction</span>
      </label>

      <button onClick={onClear} type="button">
        <Filter size={16} />
        Reset
      </button>
    </section>
  )
}

function ActionSummaryStrip({
  rows,
  activeFilter,
  onActionFocus,
}: {
  rows: DecisionSignal[]
  activeFilter: ActionFilter
  onActionFocus: (action: Action) => void
}) {
  const counts = new Map<Action, number>()
  rows.forEach((row) => counts.set(row.action, (counts.get(row.action) ?? 0) + 1))

  return (
    <section className="action-summary" aria-label="Action summary">
      {actionOrder.map((action) => {
        const filter = actionFilterFor(action)
        const active = activeFilter === filter
        return (
          <button
            className={active ? `active ${actionTone(action)}` : actionTone(action)}
            data-testid={`summary-${action.toLowerCase().replace(/\s+/g, '-')}`}
            key={action}
            onClick={() => onActionFocus(action)}
            type="button"
          >
            <span>{action}</span>
            <strong>{counts.get(action) ?? 0}</strong>
          </button>
        )
      })}
    </section>
  )
}

function DecisionTable({
  rows,
  selectedTicker,
  sourceLabel,
  onOpen,
}: {
  rows: DecisionSignal[]
  selectedTicker: string | null
  sourceLabel: string
  onOpen: (signal: DecisionSignal) => void
}) {
  const displayedRows = rows.slice(0, maxTableRows)
  const visibleLabel = rows.length > maxTableRows ? `${displayedRows.length} of ${rows.length}` : `${rows.length}`
  return (
    <section className="panel table-panel">
      <header className="panel-header">
        <div>
          <p>Ranked decisions</p>
          <h2>{visibleLabel} visible signals</h2>
        </div>
        <span className="pill neutral">{sourceLabel}</span>
      </header>
      <div className="decision-table">
        <div className="table-head">
          <span>Name</span>
          <span>Action</span>
          <span>Opportunity</span>
          <span>Risk</span>
          <span>20d model</span>
          <span>Data</span>
          <span></span>
        </div>
        {displayedRows.map((row) => {
          const readiness = signalReadiness(row)
          return (
            <article className={selectedTicker === row.ticker ? 'active table-row' : 'table-row'} key={row.ticker}>
              <div className="name-cell">
                <strong>{row.ticker}</strong>
                <span>{row.name}</span>
              </div>
              <ActionPill action={row.action} />
              <div>
                <strong>{row.opportunityScore}</strong>
                <ScoreBar value={row.opportunityScore} tone="positive" />
              </div>
              <div>
                <strong className={row.riskScore >= 68 ? 'danger' : 'neutral'}>{row.riskScore}</strong>
                <ScoreBar value={row.riskScore} tone={row.riskScore >= 68 ? 'danger' : 'caution'} />
              </div>
              <strong className={row.forecast20d < 0 ? 'danger' : 'positive'}>
                {formatSignedPercent(row.forecast20d)}
              </strong>
              <div className="readiness-cell">
                <strong className={readiness.tone}>{readiness.label}</strong>
                <span>{Math.round(row.dataConfidence ?? 0)}%</span>
              </div>
              <SignalButton context="table" signal={row} onOpen={onOpen} />
            </article>
          )
        })}
      </div>
    </section>
  )
}

function DetailPanel({
  signal,
  reviewed,
  owned,
  watched,
  onClose,
  onReview,
  onToggleOwned,
  onToggleWatch,
}: {
  signal: DecisionSignal | null
  reviewed: boolean
  owned: boolean
  watched: boolean
  onClose: () => void
  onReview: (ticker: string) => void
  onToggleOwned: (ticker: string) => void
  onToggleWatch: (ticker: string) => void
}) {
  if (!signal) {
    return (
      <aside className="detail-panel empty-detail">
        <p>Stock intelligence</p>
        <h2>Select a ticker</h2>
      </aside>
    )
  }

  const readiness = signalReadiness(signal)

  return (
    <aside className="detail-panel" data-testid="candidate-detail">
      <header>
        <div>
          <p>Stock intelligence</p>
          <h2>
            {signal.ticker} <span>{signal.name}</span>
          </h2>
        </div>
        <button aria-label="Close stock detail" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </header>

      <div className="detail-action">
        <ActionPill action={signal.action} />
        <strong>{signal.positionPlan}</strong>
        <span>{signal.nextCheck}</span>
      </div>

      <section className={`case-status ${readiness.tone}`} data-testid="case-readiness">
        <div>
          <p>Case readiness</p>
          <strong>{readiness.label}</strong>
          <span>{readiness.detail}</span>
        </div>
        <span className={`pill ${readiness.tone}`}>{Math.round(signal.dataConfidence ?? 0)}% data</span>
      </section>

      <section className="portfolio-box">
        <div>
          <p>{owned ? 'Portfolio action' : watched ? 'Watchlist action' : 'Entry action'}</p>
          <strong>{portfolioActionFor(signal, owned, watched)}</strong>
          <span>{owned ? 'Tracked position' : watched ? 'Watchlist name' : 'Not tracked'}</span>
        </div>
        <div className="portfolio-actions">
          <button onClick={() => onToggleOwned(signal.ticker)} type="button">
            <CheckCircle2 size={16} />
            {owned ? 'Untrack' : 'Owned'}
          </button>
          <button onClick={() => onToggleWatch(signal.ticker)} type="button">
            <Bell size={16} />
            {watched ? 'Unwatch' : 'Watch'}
          </button>
        </div>
      </section>

      <div className="detail-metrics">
        <Metric label="Opportunity" value={`${signal.opportunityScore}`} tone="positive" />
        <Metric label="Confidence" value={`${signal.confidence}`} />
        <Metric label="Risk" value={`${signal.riskScore}`} tone={signal.riskScore >= 68 ? 'danger' : 'caution'} />
        <Metric
          label="Data confidence"
          value={`${Math.round(signal.dataConfidence ?? 65)}%`}
          detail={signal.dataSource ?? 'local'}
          tone={(signal.dataConfidence ?? 65) < 45 ? 'danger' : 'neutral'}
        />
        <Metric label="Drawdown odds" value={`${signal.probabilityDrawdown}%`} tone="caution" />
        <Metric
          label="Price as of"
          value={formatDate(signal.priceAsOf)}
          detail={signal.historyBars ? `${signal.historyBars} bars` : 'no OHLCV yet'}
        />
      </div>

      <InfoList title="Why it ranks here" items={signal.evidence} tone="positive" />
      <InfoList title="What could go wrong" items={signal.riskFlags} tone="caution" />
      <EvidenceLedger signal={signal} />
      <InfoList title="Invalidation triggers" items={signal.invalidation} tone="danger" />

      <button
        className={reviewed ? 'reviewed-button' : ''}
        onClick={() => onReview(signal.ticker)}
        type="button"
      >
        <CheckCircle2 size={16} />
        {reviewed ? 'Reviewed' : 'Mark reviewed'}
      </button>
    </aside>
  )
}

function InfoList({ title, items, tone }: { title: string; items: string[]; tone: Tone }) {
  return (
    <section className="info-list">
      <p>{title}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <span className={`dot ${tone}`}></span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}

function EvidenceLedger({ signal }: { signal: DecisionSignal }) {
  const warnings = signal.dataWarnings ?? []
  const gaps = warnings.filter((warning) => !warning.includes('backed by cached OHLCV'))
  return (
    <section className="evidence-ledger">
      <p>Evidence ledger</p>
      <div className="evidence-row positive">
        <strong>Live</strong>
        <span>
          {signal.dataSource ?? 'market data'} - {signal.historyBars ?? 0} OHLCV bars, price as of{' '}
          {formatDate(signal.priceAsOf)}
        </span>
      </div>
      <div className="evidence-row caution">
        <strong>Proxy</strong>
        <span>{signal.optionsProxySource ?? 'Volatility proxy from realized price and volume behavior.'}</span>
      </div>
      {gaps.map((gap) => (
        <div className="evidence-row danger" key={gap}>
          <strong>Gap</strong>
          <span>{gap}</span>
        </div>
      ))}
    </section>
  )
}

function SignalCard({
  signal,
  onOpen,
}: {
  signal: DecisionSignal
  onOpen: (signal: DecisionSignal) => void
}) {
  const readiness = signalReadiness(signal)
  return (
    <article className={`signal-card ${actionTone(signal.action)}`}>
      <div className="signal-card-top">
        <div>
          <strong>{signal.ticker}</strong>
          <span>{signal.name}</span>
        </div>
        <ActionPill action={signal.action} />
      </div>
      <p>{signal.evidence[0]}</p>
      <div className="card-bars">
        <label>
          Opp
          <ScoreBar value={signal.opportunityScore} tone="positive" />
        </label>
        <label>
          Risk
          <ScoreBar value={signal.riskScore} tone={signal.riskScore >= 68 ? 'danger' : 'caution'} />
        </label>
      </div>
      <div className="card-evidence">
        <span className={readiness.tone}>{readiness.label}</span>
        <span>{missingEvidenceCount(signal)} gaps</span>
      </div>
      <footer>
        <span>{formatSignedPercent(signal.forecast20d)} 20d</span>
        <SignalButton context="card" signal={signal} label="Inspect" onOpen={onOpen} />
      </footer>
    </article>
  )
}

function BuyBoard({ rows, onOpen }: { rows: DecisionSignal[]; onOpen: (signal: DecisionSignal) => void }) {
  const buyRows = rows.filter((row) => row.action === 'Buy Now' || row.action === 'Accumulate')
  const displayedRows = buyRows.slice(0, maxBoardCards)
  return (
    <section className="board-grid">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Buy focus</p>
            <h2>{displayedRows.length} of {buyRows.length} candidates cleared the buy bar</h2>
          </div>
          <span className="pill positive">Ranked</span>
        </header>
        {buyRows.length > 0 ? (
          <div className="card-grid">
            {displayedRows.map((row) => (
              <SignalCard key={row.ticker} signal={row} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <InlineEmptyState message="No buy candidates match the current filters." />
        )}
      </section>
    </section>
  )
}

function HoldBoard({ rows, onOpen }: { rows: DecisionSignal[]; onOpen: (signal: DecisionSignal) => void }) {
  const holdRows = rows.filter((row) => row.action === 'Hold')
  const displayedRows = holdRows.slice(0, maxBoardCards)
  return (
    <section className="board-grid">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Hold focus</p>
            <h2>{displayedRows.length} of {holdRows.length} names have balanced evidence</h2>
          </div>
          <span className="pill neutral">Patience</span>
        </header>
        {holdRows.length > 0 ? (
          <div className="card-grid">
            {displayedRows.map((row) => (
              <SignalCard key={row.ticker} signal={row} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <InlineEmptyState message="No hold candidates match the current filters." />
        )}
      </section>
    </section>
  )
}

function SellBoard({ rows, onOpen }: { rows: DecisionSignal[]; onOpen: (signal: DecisionSignal) => void }) {
  const riskRows = rows
    .filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid')
    .sort(byRiskPriority)
  const displayedRows = riskRows.slice(0, maxRiskRows)
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p>Sell discipline</p>
          <h2>{displayedRows.length} of {riskRows.length} names need risk-control review</h2>
        </div>
        <span className="pill danger">Deterioration</span>
      </header>
      {riskRows.length > 0 ? (
        <div className="risk-list">
          {displayedRows.map((row) => (
            <article key={row.ticker}>
              <div>
                <strong>{row.ticker}</strong>
                <span>{row.name}</span>
              </div>
              <ActionPill action={row.action} />
              <span>Damage {row.thesisDamage}</span>
              <span>Risk {row.riskScore}</span>
              <SignalButton context="risk" signal={row} onOpen={onOpen} />
            </article>
          ))}
        </div>
      ) : (
        <InlineEmptyState message="No trim, sell, or avoid signals match the current filters." />
      )}
    </section>
  )
}

function MarketRadar({
  rows,
  context,
  history,
}: {
  rows: DecisionSignal[]
  context: MarketContext
  history: DecisionHistoryPoint[]
}) {
  const sectors = sectorScores(rows)
  return (
    <section className="radar-layout" data-testid="view-radar">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Market regime</p>
            <h2>{context.regime}</h2>
          </div>
          <span className="pill caution">{context.riskLevel}</span>
        </header>
        <div className="radar-grid">
          <Metric label="Regime confidence" value={`${context.confidence}%`} />
          <Metric label="Breadth" value={`${context.breadth}%`} />
          <Metric label="Vol pressure" value={`${context.volatilityPressure}%`} tone="caution" />
          <Metric label="Credit stress" value={`${context.creditStress}%`} />
        </div>
        <div className="market-note">
          <Sparkles size={16} />
          <span>{context.leadership}</span>
        </div>
        {history.length > 0 ? (
          <div className="history-list">
            {history.slice(0, 4).map((point) => (
              <article key={point.asOf}>
                <span>{new Date(point.asOf).toLocaleTimeString()}</span>
                <strong>{point.topBuy?.ticker ?? 'No buy'}</strong>
                <small>{point.topRisk?.ticker ?? 'No risk'} risk</small>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Sector sponsorship</p>
            <h2>Where evidence is improving</h2>
          </div>
        </header>
        <div className="sector-table">
          {sectors.map((sector) => (
            <article key={sector.sector}>
              <div>
                <strong>{sector.sector}</strong>
                <span>{sector.label}</span>
              </div>
              <ScoreBar value={sector.score} tone={sector.score >= 70 ? 'positive' : sector.score < 50 ? 'danger' : 'neutral'} />
              <strong className={sector.score >= 60 ? 'positive' : 'danger'}>
                {sector.score >= 60 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {sector.participation}%
              </strong>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}

function ScenarioLab({
  rows,
  activeScenario,
  sourceLabel,
  onScenarioChange,
  onOpen,
}: {
  rows: DecisionSignal[]
  activeScenario: ScenarioId
  sourceLabel: string
  onScenarioChange: (scenario: ScenarioId) => void
  onOpen: (signal: DecisionSignal) => void
}) {
  const scenario = scenarios.find((item) => item.id === activeScenario) ?? scenarios[0]
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p>Scenario controls</p>
          <h2>{scenario.shock}</h2>
        </div>
        <span className="pill neutral">{scenario.interpretation}</span>
      </header>
      <div className="scenario-buttons">
        {scenarios.map((item) => (
          <button
            className={activeScenario === item.id ? 'active scenario-button' : 'scenario-button'}
            data-testid={`scenario-${item.id}`}
            key={item.id}
            onClick={() => onScenarioChange(item.id)}
            type="button"
          >
            <SlidersHorizontal size={16} />
            {item.label}
          </button>
        ))}
      </div>
      <DecisionTable rows={rows} selectedTicker={null} sourceLabel={sourceLabel} onOpen={onOpen} />
    </section>
  )
}

function EmptyState({ query, reason }: { query: string; reason?: string }) {
  return (
    <section className="panel empty-state">
      <h2>{query ? 'No matches' : 'No qualified live signals'}</h2>
      <p>{reason ?? `No visible securities match "${query}".`}</p>
    </section>
  )
}

function InlineEmptyState({ message }: { message: string }) {
  return (
    <div className="inline-empty">
      <strong>No visible signals</strong>
      <span>{message}</span>
    </div>
  )
}

function App() {
  const [activeView, setActiveView] = useState<ViewId>('decision')
  const [query, setQuery] = useState('')
  const [actionFilter, setActionFilter] = useState<ActionFilter>('All')
  const [sector, setSector] = useState('All')
  const [sortKey, setSortKey] = useState<SortKey>('action')
  const [highConvictionOnly, setHighConvictionOnly] = useState(false)
  const [selectedTicker, setSelectedTicker] = useState<string | null>('NVDA')
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(() => new Date())
  const [refreshCount, setRefreshCount] = useState(0)
  const [reviewedTickers, setReviewedTickers] = useState<Set<string>>(() => new Set())
  const [activeScenario, setActiveScenario] = useState<ScenarioId>('base')
  const [signalInputs, setSignalInputs] = useState<RawSignal[] | null>(null)
  const [decisionFeed, setDecisionFeed] = useState<DecisionUniverseResponse | null>(null)
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('loading')
  const [dataError, setDataError] = useState<string | null>(null)
  const [ownedTickers, setOwnedTickers] = useState<Set<string>>(() => readOwnedTickers())
  const [watchTickers, setWatchTickers] = useState<Set<string>>(() => readWatchTickers())
  const [priceSyncMode, setPriceSyncMode] = useState<'off' | 'auto' | 'force'>('off')

  const ownedKey = useMemo(() => Array.from(ownedTickers).sort().join(','), [ownedTickers])
  const watchKey = useMemo(() => Array.from(watchTickers).sort().join(','), [watchTickers])
  const universe = useMemo(() => scoreUniverse(signalInputs ?? [], activeScenario), [activeScenario, signalInputs])
  const sectors = useMemo(() => ['All', ...Array.from(new Set(universe.map((row) => row.sector))).sort()], [universe])
  const activeMarketContext = useMemo(
    () => ({ ...marketContext, ...(decisionFeed?.marketContext ?? {}) }),
    [decisionFeed],
  )

  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const filtered = universe.filter((row) => {
      const actionAllowed =
        actionFilter === 'All' ||
        (actionFilter === 'Buy' && (row.action === 'Buy Now' || row.action === 'Accumulate')) ||
        (actionFilter === 'Hold' && row.action === 'Hold') ||
        (actionFilter === 'Risk' && (row.action === 'Trim' || row.action === 'Sell' || row.action === 'Avoid'))
      const sectorAllowed = sector === 'All' || row.sector === sector
      const convictionAllowed = !highConvictionOnly || row.confidence >= 72
      const searchAllowed =
        !normalized ||
        [row.ticker, row.name, row.sector, row.industry, row.style].some((value) =>
          value.toLowerCase().includes(normalized),
        )
      return actionAllowed && sectorAllowed && convictionAllowed && searchAllowed
    })
    return sortSignals(filtered, sortKey)
  }, [actionFilter, highConvictionOnly, query, sector, sortKey, universe])

  const activeMeta = navItems.find((item) => item.id === activeView) ?? navItems[0]
  const selectedSignal = visibleRows.find((row) => row.ticker === selectedTicker) ?? visibleRows[0] ?? null
  const selectedDisplayTicker = selectedSignal?.ticker ?? selectedTicker
  const topBuy = universe.find((row) => row.action === 'Buy Now' || row.action === 'Accumulate')
  const topRisk =
    universe
      .filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid')
      .sort(byRiskPriority)[0] ?? undefined
  const reviewed = selectedSignal ? reviewedTickers.has(selectedSignal.ticker) : false
  const selectedOwned = selectedSignal ? ownedTickers.has(selectedSignal.ticker) : false
  const selectedWatched = selectedSignal ? watchTickers.has(selectedSignal.ticker) : false
  const buyCount = universe.filter((row) => row.action === 'Buy Now' || row.action === 'Accumulate').length
  const holdCount = universe.filter((row) => row.action === 'Hold').length
  const riskCount = universe.filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid').length
  const averageConfidence =
    universe.length > 0 ? Math.round(universe.reduce((sum, row) => sum + row.confidence, 0) / universe.length) : 0
  const sourceLabel = feedLabel(feedStatus)
  const noRowsReason =
    feedStatus === 'fallback'
      ? 'Live backend data is unavailable, so Buy/Hold/Sell recommendations are paused instead of using placeholder data.'
      : decisionFeed?.returned === 0
        ? decisionFeed.detail
        : undefined

  useEffect(() => {
    let cancelled = false
    const owned = ownedKey.length > 0 ? ownedKey.split(',') : []
    const watched = watchKey.length > 0 ? watchKey.split(',') : []

    loadDecisionUniverse({
      ownedTickers: owned,
      watchTickers: watched,
      syncMode: priceSyncMode,
      syncLimit: priceSyncMode === 'force' ? 96 : 24,
    })
      .then((payload) => {
        if (cancelled) return
        setDecisionFeed(payload)
        setSignalInputs(payload.rawSignals)
        setFeedStatus(payload.dataMode)
        setDataError(payload.errorMessage ?? null)
        setLastRefresh(new Date(payload.asOf))
        setPriceSyncMode('off')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFeedStatus('fallback')
        setDataError(error instanceof Error ? error.message : 'Decision feed failed to load')
      })

    return () => {
      cancelled = true
    }
  }, [ownedKey, priceSyncMode, refreshCount, watchKey])

  useEffect(() => {
    try {
      window.localStorage.setItem(ownedStorageKey, JSON.stringify(Array.from(ownedTickers).sort()))
    } catch {
      // Local storage can be unavailable in hardened webviews.
    }
  }, [ownedTickers])

  useEffect(() => {
    try {
      window.localStorage.setItem(watchStorageKey, JSON.stringify(Array.from(watchTickers).sort()))
    } catch {
      // Local storage can be unavailable in hardened webviews.
    }
  }, [watchTickers])

  function openSignal(signal: DecisionSignal) {
    setSelectedTicker(signal.ticker)
  }

  function markReviewed(ticker: string) {
    setReviewedTickers((current) => {
      const next = new Set(current)
      next.add(ticker)
      return next
    })
  }

  function refreshData() {
    setFeedStatus('loading')
    setPriceSyncMode('off')
    setRefreshCount((count) => count + 1)
  }

  function syncPrices() {
    setFeedStatus('loading')
    setPriceSyncMode('force')
    setRefreshCount((count) => count + 1)
  }

  function toggleOwned(ticker: string) {
    setFeedStatus('loading')
    setOwnedTickers((current) => {
      const next = new Set(current)
      if (next.has(ticker)) {
        next.delete(ticker)
      } else {
        next.add(ticker)
      }
      return next
    })
  }

  function toggleWatch(ticker: string) {
    setWatchTickers((current) => {
      const next = new Set(current)
      if (next.has(ticker)) {
        next.delete(ticker)
      } else {
        next.add(ticker)
      }
      return next
    })
  }

  function focusAction(action: Action) {
    setActionFilter(actionFilterFor(action))
    setActiveView(viewForAction(action))
  }

  function activateView(view: ViewId) {
    setActiveView(view)
    setActionFilter(actionFilterForView(view))
  }

  function activateActionFilter(filter: ActionFilter) {
    setActionFilter(filter)
    setActiveView(viewForActionFilter(filter))
  }

  function clearFilters() {
    setQuery('')
    setActionFilter('All')
    setActiveView('decision')
    setSector('All')
    setSortKey('action')
    setHighConvictionOnly(false)
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand">
          <BarChart3 size={22} />
          <span>Finance Oracle</span>
        </div>
        <nav aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={activeView === item.id ? 'active' : ''}
                aria-current={activeView === item.id ? 'page' : undefined}
                data-testid={`nav-${item.id}`}
                key={item.id}
                onClick={() => activateView(item.id)}
                title={item.label}
                type="button"
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>{activeMeta.eyebrow}</p>
            <h1 data-testid="view-heading">{activeMeta.heading}</h1>
            <span className="sync-line">
              {sourceLabel} - Last feed {formatFeedTime(lastRefresh.toISOString())} - {refreshCount} manual refreshes
            </span>
          </div>
          <div className="topbar-actions">
            <button
              aria-label="Refresh signals"
              disabled={feedStatus === 'loading'}
              onClick={refreshData}
              title="Refresh signals"
              type="button"
            >
              <RefreshCcw size={17} />
              Refresh
            </button>
            <button
              aria-label="Sync prices"
              disabled={feedStatus === 'loading'}
              onClick={syncPrices}
              title="Sync prices"
              type="button"
            >
              <RefreshCcw size={17} />
              Sync prices
            </button>
            <button
              aria-expanded={alertsOpen}
              aria-label="Toggle alerts"
              className={alertsOpen ? 'active' : ''}
              onClick={() => setAlertsOpen((open) => !open)}
              title="Alerts"
              type="button"
            >
              <Bell size={17} />
              Alerts
            </button>
          </div>
        </header>

        {alertsOpen ? (
          <section className="alert-drawer" data-testid="alert-drawer">
            <div>
              <strong>Risk tape</strong>
              <span>
                {riskCount} risk-control signals are active. Highest priority: {topRisk?.ticker ?? 'none'}.
              </span>
            </div>
            <button aria-label="Close alerts" onClick={() => setAlertsOpen(false)} type="button">
              <X size={16} />
            </button>
          </section>
        ) : null}

        <ReadinessGate feed={decisionFeed} rows={universe} status={feedStatus} />

        <section className="hero-grid">
          <HeroDecisionCard label="Best buy candidate" signal={topBuy} tone="positive" onOpen={openSignal} />
          <HeroDecisionCard label="Biggest sell or trim risk" signal={topRisk} tone="danger" onOpen={openSignal} />
          <section className="hero-card neutral">
            <p>Market posture</p>
            <h2>{activeMarketContext.regime}</h2>
            <div className="hero-stats">
              <span>Risk {activeMarketContext.riskScore}</span>
              <span>Breadth {activeMarketContext.breadth}%</span>
              <span>Credit {activeMarketContext.creditStress}%</span>
            </div>
            <p className="hero-reason">{activeMarketContext.liquidity}</p>
          </section>
          <section className="hero-card caution">
            <p>Decision coverage</p>
            <h2>{decisionFeed ? `${decisionFeed.returned}/${decisionFeed.universeSize}` : `${universe.length}`} names</h2>
            <div className="hero-stats">
              <span>{buyCount} buy</span>
              <span>{holdCount} hold</span>
              <span>{riskCount} risk</span>
              <span>{averageConfidence}% confidence</span>
              <span>{ownedTickers.size} owned</span>
              <span>{watchTickers.size} watched</span>
            </div>
            <p className="hero-reason">{dataError ?? decisionFeed?.detail ?? 'Loading backend decision universe.'}</p>
          </section>
        </section>

        <section className="data-strip">
          <Metric
            label="Price coverage"
            value={`${decisionFeed?.priceCoverage.usableSymbolCount ?? 0}/${decisionFeed?.returned ?? universe.length}`}
            detail={`${decisionFeed?.priceCoverage.cachedSymbolCount ?? 0} cached, ${decisionFeed?.priceCoverage.staleSymbolCount ?? 0} stale`}
          />
          <Metric
            label="Latest bar"
            value={formatDate(decisionFeed?.priceCoverage.latestPriceDate)}
            detail={`${decisionFeed?.priceCoverage.totalBarCount ?? 0} cached bars`}
          />
          <Metric
            label="Last sync"
            value={formatFeedTime(decisionFeed?.sync.lastSyncAt ?? null)}
            detail={`${decisionFeed?.sync.updated ?? 0} updated, ${decisionFeed?.sync.failed ?? 0} failed`}
          />
          <Metric
            label="Options layer"
            value="Proxy"
            detail="Realized vol and downside-volume proxy until options feed is connected"
            tone="caution"
          />
        </section>

        <ActionSummaryStrip rows={universe} activeFilter={actionFilter} onActionFocus={focusAction} />

        <Controls
          actionFilter={actionFilter}
          highConvictionOnly={highConvictionOnly}
          onActionFilterChange={activateActionFilter}
          onClear={clearFilters}
          onHighConvictionChange={setHighConvictionOnly}
          onQueryChange={setQuery}
          onSectorChange={setSector}
          onSortChange={setSortKey}
          query={query}
          sector={sector}
          sectors={sectors}
          sortKey={sortKey}
        />

        {visibleRows.length === 0 ? <EmptyState query={query} reason={noRowsReason} /> : null}

        {activeView === 'decision' && visibleRows.length > 0 ? (
          <section className="main-grid" data-testid="view-decision">
            <DecisionTable
              rows={visibleRows}
              selectedTicker={selectedDisplayTicker}
              sourceLabel={sourceLabel}
              onOpen={openSignal}
            />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              onToggleOwned={toggleOwned}
              onToggleWatch={toggleWatch}
              owned={selectedOwned}
              reviewed={reviewed}
              signal={selectedSignal}
              watched={selectedWatched}
            />
          </section>
        ) : null}

        {activeView === 'buy' && visibleRows.length > 0 ? (
          <section className="main-grid" data-testid="view-buy">
            <BuyBoard rows={visibleRows} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              onToggleOwned={toggleOwned}
              onToggleWatch={toggleWatch}
              owned={selectedOwned}
              reviewed={reviewed}
              signal={selectedSignal}
              watched={selectedWatched}
            />
          </section>
        ) : null}

        {activeView === 'hold' && visibleRows.length > 0 ? (
          <section className="main-grid" data-testid="view-hold">
            <HoldBoard rows={visibleRows} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              onToggleOwned={toggleOwned}
              onToggleWatch={toggleWatch}
              owned={selectedOwned}
              reviewed={reviewed}
              signal={selectedSignal}
              watched={selectedWatched}
            />
          </section>
        ) : null}

        {activeView === 'sell' && visibleRows.length > 0 ? (
          <section className="main-grid" data-testid="view-sell">
            <SellBoard rows={visibleRows} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              onToggleOwned={toggleOwned}
              onToggleWatch={toggleWatch}
              owned={selectedOwned}
              reviewed={reviewed}
              signal={selectedSignal}
              watched={selectedWatched}
            />
          </section>
        ) : null}

        {activeView === 'radar' ? (
          <MarketRadar
            context={activeMarketContext}
            history={decisionFeed?.history ?? []}
            rows={universe}
          />
        ) : null}

        {activeView === 'scenario' && visibleRows.length > 0 ? (
          <section className="main-grid" data-testid="view-scenario">
            <ScenarioLab
              activeScenario={activeScenario}
              onOpen={openSignal}
              onScenarioChange={setActiveScenario}
              rows={visibleRows}
              sourceLabel={sourceLabel}
            />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              onToggleOwned={toggleOwned}
              onToggleWatch={toggleWatch}
              owned={selectedOwned}
              reviewed={reviewed}
              signal={selectedSignal}
              watched={selectedWatched}
            />
          </section>
        ) : null}
      </section>
    </main>
  )
}

export default App
