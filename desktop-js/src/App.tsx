import { useMemo, useState, type ComponentType } from 'react'
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
  type ScenarioId,
  type SortKey,
  type Tone,
} from './data/decisionEngine'
import './App.css'

type ViewId = 'decision' | 'buy' | 'sell' | 'radar' | 'scenario'
type ActionFilter = 'All' | 'Buy' | 'Hold' | 'Risk'

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
  { value: 'regimeFit', label: 'Regime fit' },
]

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

function DecisionTable({
  rows,
  selectedTicker,
  onOpen,
}: {
  rows: DecisionSignal[]
  selectedTicker: string | null
  onOpen: (signal: DecisionSignal) => void
}) {
  return (
    <section className="panel table-panel">
      <header className="panel-header">
        <div>
          <p>Ranked decisions</p>
          <h2>{rows.length} visible signals</h2>
        </div>
        <span className="pill neutral">Local model</span>
      </header>
      <div className="decision-table">
        <div className="table-head">
          <span>Name</span>
          <span>Action</span>
          <span>Opportunity</span>
          <span>Risk</span>
          <span>Forecast</span>
          <span></span>
        </div>
        {rows.map((row) => (
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
            <SignalButton context="table" signal={row} onOpen={onOpen} />
          </article>
        ))}
      </div>
    </section>
  )
}

function DetailPanel({
  signal,
  reviewed,
  onClose,
  onReview,
}: {
  signal: DecisionSignal | null
  reviewed: boolean
  onClose: () => void
  onReview: (ticker: string) => void
}) {
  if (!signal) {
    return (
      <aside className="detail-panel empty-detail">
        <p>Stock intelligence</p>
        <h2>Select a ticker</h2>
      </aside>
    )
  }

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

      <div className="detail-metrics">
        <Metric label="Opportunity" value={`${signal.opportunityScore}`} tone="positive" />
        <Metric label="Confidence" value={`${signal.confidence}`} />
        <Metric label="Risk" value={`${signal.riskScore}`} tone={signal.riskScore >= 68 ? 'danger' : 'caution'} />
        <Metric label="Drawdown odds" value={`${signal.probabilityDrawdown}%`} tone="caution" />
      </div>

      <InfoList title="Why it ranks here" items={signal.evidence} tone="positive" />
      <InfoList title="What could go wrong" items={signal.riskFlags} tone="caution" />
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

function SignalCard({
  signal,
  onOpen,
}: {
  signal: DecisionSignal
  onOpen: (signal: DecisionSignal) => void
}) {
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
      <footer>
        <span>{formatSignedPercent(signal.forecast20d)} 20d</span>
        <SignalButton context="card" signal={signal} label="Inspect" onOpen={onOpen} />
      </footer>
    </article>
  )
}

function BuyBoard({ rows, onOpen }: { rows: DecisionSignal[]; onOpen: (signal: DecisionSignal) => void }) {
  const buyRows = rows.filter((row) => row.action === 'Buy Now' || row.action === 'Accumulate')
  return (
    <section className="board-grid">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Buy focus</p>
            <h2>{buyRows.length} candidates cleared the buy bar</h2>
          </div>
          <span className="pill positive">Ranked</span>
        </header>
        <div className="card-grid">
          {buyRows.map((row) => (
            <SignalCard key={row.ticker} signal={row} onOpen={onOpen} />
          ))}
        </div>
      </section>
    </section>
  )
}

function SellBoard({ rows, onOpen }: { rows: DecisionSignal[]; onOpen: (signal: DecisionSignal) => void }) {
  const riskRows = rows.filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid')
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p>Sell discipline</p>
          <h2>{riskRows.length} names need risk-control review</h2>
        </div>
        <span className="pill danger">Deterioration</span>
      </header>
      <div className="risk-list">
        {riskRows.map((row) => (
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
    </section>
  )
}

function MarketRadar({ rows }: { rows: DecisionSignal[] }) {
  const sectors = sectorScores(rows)
  return (
    <section className="radar-layout">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p>Market regime</p>
            <h2>{marketContext.regime}</h2>
          </div>
          <span className="pill caution">{marketContext.riskLevel}</span>
        </header>
        <div className="radar-grid">
          <Metric label="Regime confidence" value={`${marketContext.confidence}%`} />
          <Metric label="Breadth" value={`${marketContext.breadth}%`} />
          <Metric label="Vol pressure" value={`${marketContext.volatilityPressure}%`} tone="caution" />
          <Metric label="Credit stress" value={`${marketContext.creditStress}%`} />
        </div>
        <div className="market-note">
          <Sparkles size={16} />
          <span>{marketContext.leadership}</span>
        </div>
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
  onScenarioChange,
  onOpen,
}: {
  rows: DecisionSignal[]
  activeScenario: ScenarioId
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
      <DecisionTable rows={rows} selectedTicker={null} onOpen={onOpen} />
    </section>
  )
}

function EmptyState({ query }: { query: string }) {
  return (
    <section className="panel empty-state">
      <h2>No matches</h2>
      <p>No visible securities match "{query}".</p>
    </section>
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

  const universe = useMemo(() => scoreUniverse(undefined, activeScenario), [activeScenario])
  const sectors = useMemo(() => ['All', ...Array.from(new Set(universe.map((row) => row.sector))).sort()], [universe])

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
  const selectedSignal = universe.find((row) => row.ticker === selectedTicker) ?? null
  const topBuy = universe.find((row) => row.action === 'Buy Now' || row.action === 'Accumulate')
  const topRisk = universe.find((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid')
  const reviewed = selectedSignal ? reviewedTickers.has(selectedSignal.ticker) : false
  const buyCount = universe.filter((row) => row.action === 'Buy Now' || row.action === 'Accumulate').length
  const riskCount = universe.filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid').length
  const averageConfidence = Math.round(universe.reduce((sum, row) => sum + row.confidence, 0) / universe.length)

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
    setLastRefresh(new Date())
    setRefreshCount((count) => count + 1)
  }

  function clearFilters() {
    setQuery('')
    setActionFilter('All')
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
                data-testid={`nav-${item.id}`}
                key={item.id}
                onClick={() => setActiveView(item.id)}
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
            <h1>{activeMeta.heading}</h1>
            <span className="sync-line">
              Last refreshed {lastRefresh.toLocaleTimeString()} - {refreshCount} manual syncs
            </span>
          </div>
          <div className="topbar-actions">
            <button aria-label="Refresh data" onClick={refreshData} title="Refresh data" type="button">
              <RefreshCcw size={17} />
              Refresh
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

        <section className="hero-grid">
          <HeroDecisionCard label="Best buy candidate" signal={topBuy} tone="positive" onOpen={openSignal} />
          <HeroDecisionCard label="Biggest sell or trim risk" signal={topRisk} tone="danger" onOpen={openSignal} />
          <section className="hero-card neutral">
            <p>Market posture</p>
            <h2>{marketContext.regime}</h2>
            <div className="hero-stats">
              <span>Risk {marketContext.riskScore}</span>
              <span>Breadth {marketContext.breadth}%</span>
              <span>Credit {marketContext.creditStress}%</span>
            </div>
            <p className="hero-reason">{marketContext.liquidity}</p>
          </section>
          <section className="hero-card caution">
            <p>Decision coverage</p>
            <h2>{universe.length} names</h2>
            <div className="hero-stats">
              <span>{buyCount} buy</span>
              <span>{riskCount} risk</span>
              <span>{averageConfidence}% confidence</span>
            </div>
            <p className="hero-reason">Stocks and ETFs are scored by regime fit, trend, revisions, risk, and fragility.</p>
          </section>
        </section>

        <Controls
          actionFilter={actionFilter}
          highConvictionOnly={highConvictionOnly}
          onActionFilterChange={setActionFilter}
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

        {visibleRows.length === 0 ? <EmptyState query={query} /> : null}

        {activeView === 'decision' && visibleRows.length > 0 ? (
          <section className="main-grid">
            <DecisionTable rows={visibleRows} selectedTicker={selectedTicker} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              reviewed={reviewed}
              signal={selectedSignal}
            />
          </section>
        ) : null}

        {activeView === 'buy' && visibleRows.length > 0 ? (
          <section className="main-grid">
            <BuyBoard rows={visibleRows} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              reviewed={reviewed}
              signal={selectedSignal}
            />
          </section>
        ) : null}

        {activeView === 'sell' && visibleRows.length > 0 ? (
          <section className="main-grid">
            <SellBoard rows={visibleRows} onOpen={openSignal} />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              reviewed={reviewed}
              signal={selectedSignal}
            />
          </section>
        ) : null}

        {activeView === 'radar' ? <MarketRadar rows={universe} /> : null}

        {activeView === 'scenario' && visibleRows.length > 0 ? (
          <section className="main-grid">
            <ScenarioLab
              activeScenario={activeScenario}
              onOpen={openSignal}
              onScenarioChange={setActiveScenario}
              rows={visibleRows}
            />
            <DetailPanel
              onClose={() => setSelectedTicker(null)}
              onReview={markReviewed}
              reviewed={reviewed}
              signal={selectedSignal}
            />
          </section>
        ) : null}
      </section>
    </main>
  )
}

export default App
