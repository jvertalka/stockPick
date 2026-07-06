import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clipboard,
  FileDown,
  Filter,
  GraduationCap,
  Keyboard,
  LineChart,
  Moon,
  RefreshCcw,
  Search,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'
import { DecisionHistory, PositionSizer, TickerNotes } from './components/DetailExtras'
import { FactorBreakdown } from './components/FactorBreakdown'
import { QuantAnalysisCard } from './components/QuantAnalysisCard'
import { OptionsStrategiesCard } from './components/OptionsStrategiesCard'
import { ExecutiveBrief } from './components/ExecutiveBrief'
import { findHoldingForSignal } from './components/optionsStrategiesHelpers'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { copyToClipboard, rowsToCsv, type ExportRow } from './components/exportCsv'
import { useToast } from './components/useToast'
import { PriceChart } from './components/PriceChart'
import { NewsStream } from './components/NewsStream'
import { OptionsCard } from './components/OptionsCard'
import { EarningsChip } from './components/EarningsChip'
import { ComparisonView } from './components/ComparisonView'
import { ModelReadinessPanel } from './components/ModelReadiness'
import { BacktestPanel } from './components/BacktestPanel'
import { ModelDecayMonitor } from './components/ModelDecayMonitor'
import { FilterBuilder } from './components/FilterBuilder'
import { buildPredicate, type FilterRule } from './components/filterTypes'
import {
  RebalancePanel,
  TaxLossPanel,
  TutorialOverlay,
} from './components/PortfolioWorkflows'
import { TransitionsLog } from './components/TransitionsLog'
import { PortfolioImportDialog } from './components/PortfolioImportDialog'
import {
  exportWeeklyDigest,
  shouldShowTutorial,
  usePortfolioWorkflows,
} from './components/portfolioCalc'
import {
  bulkPutHoldings,
  deleteHolding,
  getHoldings,
  kvGet,
  kvSet,
  migrateLegacyOwnedTickers,
  recordCurrentDecisions,
  type StoredHolding,
} from './data/storage'
import { notifyOnce, setDockBadge } from './data/notifications'
import { activeOptionsProvider, type OptionsSnapshot } from './data/optionsAdapter'
import {
  applyOptionsOverlay,
  fetchSnapshotsBatched,
  pickTickersToEnhance,
} from './data/optionsEnhancer'
import {
  applyRevisionsOverlay,
  fetchRevisionRaw,
  revisionsConfigured,
  getCachedRevisionRaw,
  rankRevisions,
  type RevisionRaw,
  type RevisionRanks,
} from './data/revisionsEnhancer'
import {
  loadProviderCapabilities,
  providerCapabilitiesLoaded,
} from './data/providerCapabilities'
import { cachedComputeQuantAnalysis, type QuantAnalysis } from './data/quantAnalysis'
import {
  getRegimeGate,
  loadModel,
  logLivePrediction,
  predictForUniverse,
  reconcilePredictions,
  type LivePrediction,
  type RegimeGate,
  type StoredMlModel,
} from './data/mlModelService'
import { buildConvictionStacks, type ConvictionStack } from './data/convictionStack'
import { ConvictionStackMeter } from './components/ConvictionStackMeter'
import {
  actionTone,
  formatSignedPercent,
  marketContext,
  scenarios,
  applyQuantOverlay,
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
  type DecisionSummary,
  type DecisionUniverseResponse,
} from './data/decisionApi'
import './App.css'

/** Four surfaces (was ten views). Doctrine: the app does the synthesis —
 * Brief answers "what do I do", the Desk is where a decision is examined,
 * Workflows handle portfolio chores, the Lab owns model training/health.
 * Everything that used to be its own view (Buy/Hold/Sell boards, Scenario
 * Lab, Compare, Radar) is a filter or mode INSIDE the Desk. */
type ViewId = 'brief' | 'desk' | 'workflows' | 'lab'
/** Sub-modes of the Decision Desk. */
type DeskMode = 'table' | 'compare' | 'radar'
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
    id: 'brief',
    label: 'Brief',
    eyebrow: 'Executive brief',
    heading: 'Top decisions + options plan + portfolio at a glance',
    icon: Sparkles,
  },
  {
    id: 'desk',
    label: 'Decision Desk',
    eyebrow: 'Decision Desk',
    heading: 'What to buy, hold, trim, sell, and avoid — and why',
    icon: CircleDollarSign,
  },
  {
    id: 'workflows',
    label: 'Workflows',
    eyebrow: 'Portfolio workflows',
    heading: 'Tax-loss harvest, rebalance, and weekly digest',
    icon: FileDown,
  },
  {
    id: 'lab',
    label: 'Model Lab',
    eyebrow: 'Model training & health',
    heading: 'Backtests, readiness gates, and live decay monitoring',
    icon: GraduationCap,
  },
]

/** Legacy view ids (pre-consolidation) → surviving surface, so persisted
 * state from older builds lands somewhere sensible. */
function migrateViewId(stored: string | undefined): ViewId | undefined {
  switch (stored) {
    case 'brief':
    case 'desk':
    case 'workflows':
    case 'lab':
      return stored
    case 'decision':
    case 'buy':
    case 'hold':
    case 'sell':
    case 'scenario':
    case 'compare':
    case 'radar':
      return 'desk'
    case 'workflow':
      return 'workflows'
    case 'readiness':
      return 'lab'
    default:
      return undefined
  }
}

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
const viewStateStorageKey = 'finance-oracle-view-state'
const maxTableRows = 260

type PersistedViewState = {
  activeView?: ViewId
  deskMode?: DeskMode
  actionFilter?: ActionFilter
  sector?: string
  sortKey?: SortKey
  highConvictionOnly?: boolean
  activeScenario?: ScenarioId
}

function readPersistedViewState(): PersistedViewState {
  try {
    const stored = window.localStorage.getItem(viewStateStorageKey)
    if (!stored) return {}
    const decoded = JSON.parse(stored) as unknown
    if (typeof decoded !== 'object' || decoded === null) return {}
    const state = decoded as PersistedViewState & { activeView?: string }
    return { ...state, activeView: migrateViewId(state.activeView) }
  } catch {
    return {}
  }
}

function persistViewState(state: PersistedViewState) {
  try {
    window.localStorage.setItem(viewStateStorageKey, JSON.stringify(state))
  } catch {
    // Local storage can be unavailable in hardened webviews.
  }
}

/** Adds a comma/space/newline-separated list of tickers to a stored set. */
function mergeTickerList(current: Set<string>, raw: string): Set<string> {
  const next = new Set(current)
  raw
    .split(/[,;\s]+/u)
    .map((token) => token.trim().toUpperCase())
    .filter((token) => /^[A-Z][A-Z0-9.-]{0,9}$/u.test(token))
    .forEach((token) => next.add(token))
  return next
}

/**
 * Synthesizes the strongest one-line reason behind a decision.
 * The hero strip and the table's "Why" column both consume this so the
 * user sees a consistent rationale wherever a ticker appears.
 */
function synthesizeReason(signal: DecisionSignal): string {
  // For risk actions the most decisive thing is *what's deteriorating*.
  if (signal.action === 'Sell' || signal.action === 'Trim' || signal.action === 'Avoid') {
    if (signal.thesisDamage >= 60) return `Thesis damage ${signal.thesisDamage} — ${primaryRisk(signal)}`
    if (signal.fragilityScore >= 60) return `Fragility ${signal.fragilityScore} — ${primaryRisk(signal)}`
    return primaryRisk(signal)
  }

  // For buy/hold actions the most decisive thing is *what's working*.
  const drivers: string[] = []
  if (signal.relativeStrength >= 75) drivers.push('RS leadership')
  if (signal.revisionTrend >= 72) drivers.push('positive revisions')
  if (signal.regimeFit >= 70) drivers.push('regime support')
  if (signal.quality >= 82) drivers.push('quality durable')
  if (signal.residualStrength >= 72 && drivers.length < 2) drivers.push('residual strength')
  if (signal.freeCashFlowTrend >= 80 && drivers.length < 2) drivers.push('strong FCF')

  if (drivers.length === 0) {
    return signal.evidence[0] ?? 'Mixed evidence keeps this in review.'
  }
  const lead = drivers.slice(0, 2).join(' + ')
  if (signal.fragilityScore >= 60) {
    return `${lead}, watch fragility ${signal.fragilityScore}`
  }
  return `${lead}; risk ${signal.riskScore}`
}

function primaryRisk(signal: DecisionSignal): string {
  if (signal.skewRisk >= 65) return 'put skew + crowding risk'
  if (signal.crowding >= 70) return 'crowded trade with thin breadth'
  if (signal.impliedVolRank >= 70) return 'implied vol elevated'
  if (signal.relativeStrength <= 40) return 'losing relative strength'
  if (signal.revisionTrend <= 45) return 'estimate revisions deteriorating'
  if (signal.drawdownRisk >= 65) return 'drawdown risk elevated'
  return signal.riskFlags[0] ?? 'composite risk elevated'
}

const themeStorageKey = 'finance-oracle-theme'

type ThemePreference = 'dark' | 'light'

function readPersistedTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(themeStorageKey)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // ignore
  }
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

function applyThemeToDocument(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme
}

/** Verbal label for any 0-100 score so a glance can replace mental math. */
function scoreLabel(value: number): string {
  if (value >= 80) return 'Strong'
  if (value >= 65) return 'Solid'
  if (value >= 50) return 'Mixed'
  if (value >= 35) return 'Weak'
  return 'Very weak'
}

function riskLabel(value: number): string {
  if (value >= 70) return 'High'
  if (value >= 55) return 'Elevated'
  if (value >= 40) return 'Manageable'
  return 'Low'
}

/** Counts how many of a portfolio's tickers fall into each action bucket. */
function portfolioPulse(rows: DecisionSignal[], owned: Set<string>) {
  if (owned.size === 0) return null
  const ownedRows = rows.filter((row) => owned.has(row.ticker))
  if (ownedRows.length === 0) return null
  const counts: Record<Action, number> = {
    'Buy Now': 0,
    Accumulate: 0,
    Hold: 0,
    Trim: 0,
    Sell: 0,
    Avoid: 0,
  }
  ownedRows.forEach((row) => {
    counts[row.action] += 1
  })
  const buys = counts['Buy Now'] + counts.Accumulate
  const risk = counts.Trim + counts.Sell + counts.Avoid
  const matched = ownedRows.length
  const unmatched = owned.size - matched
  return { rows: ownedRows, counts, buys, hold: counts.Hold, risk, matched, unmatched }
}

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

/** Mid-rank cross-sectional percentiles (0-100) for a batch of [key, value]
 * pairs; ties share the average rank. Used to gate ML/ensemble actions on a
 * name's RANK within the live batch: the model predicts a RELATIVE
 * (~zero-centered) 20d return, so absolute % thresholds are meaningless —
 * roughly half a batch is negative by construction. A single value maps to 50
 * (no spread to rank against). */
function batchPercentiles(pairs: Array<[string, number]>): Map<string, number> {
  const out = new Map<string, number>()
  const n = pairs.length
  if (n === 0) return out
  if (n === 1) {
    out.set(pairs[0][0], 50)
    return out
  }
  const sorted = [...pairs].sort((a, b) => a[1] - b[1])
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++
    const pct = (((i + j) / 2) / (sorted.length - 1)) * 100
    for (let k = i; k <= j; k++) out.set(sorted[k][0], pct)
    i = j + 1
  }
  return out
}

// Focusing an action bucket always lands on the Desk with the matching
// filter — the boards that used to be separate views are now just filters.

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
  const hasFundamentals = signal.fundamentalsSource === 'sec-edgar-xbrl'
  if (dataConfidence >= 80 && hasFundamentals) {
    return {
      label: 'Decision grade',
      tone: 'positive',
      detail:
        'Price history + SEC-filing fundamentals back this case; estimate revisions and listed options remain neutral/proxied.',
    }
  }
  if (dataConfidence >= 60) {
    return {
      label: 'Price-backed',
      tone: 'caution',
      detail: hasFundamentals
        ? 'Market data and SEC fundamentals are live; confidence is held back by data gaps.'
        : 'Market-data case is live; SEC fundamentals are not computed for this name yet.',
    }
  }
  return {
    label: 'Research only',
    tone: 'danger',
    detail: 'Evidence is too thin for a high-conviction decision.',
  }
}

function actionableRows(rows: DecisionSignal[]) {
  return rows.filter((row) => signalReadiness(row).label !== 'Research only')
}

/** A verdict on 'Research only' evidence (dataConfidence < 60 — i.e. fallback,
 * stale price, or no real fundamentals) is NOT decision-grade. The UI caveats
 * such verdicts so a confident "Buy Now" can't appear on thin data. */
function thinEvidence(signal: DecisionSignal): boolean {
  return signalReadiness(signal).label === 'Research only'
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

function ActionPill({ action, caveated = false }: { action: Action; caveated?: boolean }) {
  // Thin-evidence verdicts are demoted to a caution tone so a confident green
  // "Buy Now" can't read as decision-grade on fallback/stale/uncovered data.
  return <span className={`pill ${caveated ? 'caution' : actionTone(action)}`}>{action}</span>
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

function LeadDecisionCard({
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
        <h2>No qualifying name</h2>
        <span className="hero-reason">Either the universe is loading or no candidate clears the data threshold for this side of the book yet.</span>
      </section>
    )
  }

  const reason = synthesizeReason(signal)
  const trigger =
    tone === 'danger'
      ? signal.invalidation[0] ?? 'Watch for cluster of deterioration signals.'
      : signal.invalidation[0] ?? 'Watch for any single core signal turning down.'

  // A hero-sized verdict is the most confident surface in the app — it must
  // never present a thin-evidence name as decision-grade. Demote the card's
  // tone and badge it, same rule as the detail-panel verdict zone.
  const thin = thinEvidence(signal)
  return (
    <section className={`hero-card ${thin ? 'caution' : tone}`}>
      <div className="hero-lead">
        <p>{label}</p>
        <h2>
          <strong>{signal.action.toUpperCase()}</strong> {signal.ticker}
        </h2>
        <span className="hero-name">{signal.name}</span>
        {thin ? (
          <span className="pill danger" title={signalReadiness(signal).detail}>
            ⚠ Thin evidence — not decision-grade
          </span>
        ) : null}
      </div>
      <p className="hero-reason">
        <strong>Why: </strong>
        {reason}
      </p>
      <div className="hero-stats">
        <span>Opp {signal.opportunityScore}</span>
        <span>Conf {signal.confidence}</span>
        <span>Risk {signal.riskScore}</span>
        <span>{formatSignedPercent(signal.forecast20d)} 20d</span>
      </div>
      <div className="hero-action-row">
        <span className="hero-plan">{signal.positionPlan}</span>
        <SignalButton
          context={`hero-${label.toLowerCase().replace(/\s+/g, '-')}`}
          signal={signal}
          label="Inspect"
          onOpen={onOpen}
        />
      </div>
      <p className="hero-trigger">
        <strong>Invalidation: </strong>
        {trigger}
      </p>
    </section>
  )
}

function StatusStrip({
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
  const fundamentals = feed?.fundamentalsCoverage ?? 0
  const actionable = actionableRows(rows).length
  const tone: Tone =
    status === 'backend' && qualified > 0 ? 'caution' : status === 'loading' ? 'neutral' : 'danger'
  const label =
    status === 'loading'
      ? 'Loading evidence'
      : status === 'backend' && qualified > 0
        ? fundamentals > 0
          ? `Price + SEC fundamentals (${fundamentals} names) - options proxied`
          : 'Price-backed - fundamentals warming, options proxied'
        : 'Recommendations paused'

  return (
    <section className="status-strip" data-testid="readiness-gate" aria-label="Decision readiness">
      <div className={`status-strip-lead ${tone}`}>
        <span className="dot-status" />
        <strong>{label}</strong>
      </div>
      <div className="status-strip-stat">
        <span>Usable</span>
        <strong>
          {actionable}/{qualified}
        </strong>
      </div>
      <div className="status-strip-stat">
        <span>Excluded</span>
        <strong>{excluded}</strong>
      </div>
      <div className="status-strip-stat">
        <span>Latest bar</span>
        <strong>{formatDate(feed?.priceCoverage.latestPriceDate)}</strong>
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
  ownedTickers,
  watchTickers,
  enrichedTickers,
  mlPredictions: mlPredictionsProp,
  isLoading,
  onOpen,
}: {
  rows: DecisionSignal[]
  selectedTicker: string | null
  sourceLabel: string
  ownedTickers: Set<string>
  watchTickers: Set<string>
  enrichedTickers: Set<string>
  mlPredictions?: Map<string, LivePrediction>
  isLoading?: boolean
  onOpen: (signal: DecisionSignal) => void
}) {
  // Defensive default: HMR sometimes passes undefined during a refresh
  // window. An empty map keeps the table rendering cleanly.
  const mlPredictions = mlPredictionsProp ?? new Map<string, LivePrediction>()
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null)
  const displayedRows = rows.slice(0, maxTableRows)
  const visibleLabel =
    rows.length > maxTableRows ? `${displayedRows.length} of ${rows.length}` : `${rows.length}`

  function handleRowClick(row: DecisionSignal) {
    onOpen(row)
    setExpandedTicker((current) => (current === row.ticker ? null : row.ticker))
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p>Ranked decisions</p>
          <h2>{visibleLabel} visible signals</h2>
        </div>
        <span className="pill neutral">{sourceLabel}</span>
      </header>

      {isLoading && rows.length === 0 ? (
        <div role="status" aria-live="polite">
          {Array.from({ length: 6 }, (_, idx) => (
            <div key={idx} className="skeleton skeleton-row" />
          ))}
          <span className="visually-hidden">Loading decisions</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="decision-table" role="grid" aria-label="Ranked decision signals">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Action</th>
                <th scope="col">Why</th>
                <th scope="col">Opp</th>
                <th scope="col">Risk</th>
                <th scope="col">20d</th>
                <th scope="col" title="ML model prediction (when available)">ML</th>
                <th scope="col">Data</th>
                <th scope="col" aria-label="Row actions"></th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => {
                const readiness = signalReadiness(row)
                const owned = ownedTickers.has(row.ticker)
                const watched = watchTickers.has(row.ticker)
                const isExpanded = expandedTicker === row.ticker
                const isActive = selectedTicker === row.ticker
                const className = [isActive ? 'active' : '', isExpanded ? 'expanded' : '']
                  .filter(Boolean)
                  .join(' ')
                return (
                  <Fragment key={row.ticker}>
                    <tr
                      aria-expanded={isExpanded}
                      aria-selected={isActive}
                      className={className}
                      onClick={() => handleRowClick(row)}
                    >
                      <td className="name">
                        <strong>
                          {row.ticker}
                          {owned ? (
                            <span className="ticker-badge" title="In your portfolio">
                              Owned
                            </span>
                          ) : null}
                          {!owned && watched ? (
                            <span className="ticker-badge watch" title="On your watchlist">
                              Watch
                            </span>
                          ) : null}
                          {enrichedTickers.has(row.ticker) ? (
                            <span
                              className="ticker-badge live-options"
                              title="Score uses real options data from configured provider"
                            >
                              Live IV
                            </span>
                          ) : null}
                          {row.quantConfirmed ? (
                            <span
                              className="ticker-badge quant-confirmed"
                              title={`Action validated by Monte Carlo + BSM + Kelly. MC mean ${row.monteCarloMean?.toFixed(1)}% / Half Kelly ${row.recommendedKellyHalfPct}%.`}
                            >
                              Quant ✓
                            </span>
                          ) : null}
                        </strong>
                        <span>{row.name}</span>
                      </td>
                      <td>
                        <ActionPill action={row.action} caveated={thinEvidence(row)} />
                      </td>
                      <td className="why">{synthesizeReason(row)}</td>
                      <td className="score" title={`Opportunity ${row.opportunityScore} - ${scoreLabel(row.opportunityScore)}`}>
                        <strong>{row.opportunityScore}</strong>
                        <span className="score-bar">
                          <span style={{ width: `${row.opportunityScore}%` }} />
                        </span>
                      </td>
                      <td
                        className="score"
                        title={`Risk ${row.riskScore} - ${riskLabel(row.riskScore)}`}
                      >
                        <strong className={row.riskScore >= 68 ? 'danger' : ''}>{row.riskScore}</strong>
                        <span className="score-bar">
                          <span style={{ width: `${row.riskScore}%` }} />
                        </span>
                      </td>
                      <td className={`delta ${row.forecast20d < 0 ? 'danger' : 'positive'}`}>
                        {formatSignedPercent(row.forecast20d)}
                      </td>
                      <td className={(() => {
                        const prediction = mlPredictions.get(row.ticker)
                        if (!prediction) return 'delta'
                        return `delta ${prediction.predictedReturn20d < 0 ? 'danger' : 'positive'}`
                      })()} title={(() => {
                        const prediction = mlPredictions.get(row.ticker)
                        if (!prediction) return 'No ML prediction'
                        if (prediction.p10Return20d != null && prediction.p90Return20d != null) {
                          return `GBT 20d relative (vs peers): ${formatSignedPercent(prediction.predictedReturn20d)} | 80% interval [${formatSignedPercent(prediction.p10Return20d)}, ${formatSignedPercent(prediction.p90Return20d)}]`
                        }
                        return `GBT 20d relative (vs peers): ${formatSignedPercent(prediction.predictedReturn20d)}`
                      })()}>
                        {(() => {
                          const prediction = mlPredictions.get(row.ticker)
                          if (!prediction) return '–'
                          const point = formatSignedPercent(prediction.predictedReturn20d)
                          if (prediction.p10Return20d != null && prediction.p90Return20d != null) {
                            // Show point estimate with tiny interval beneath
                            return (
                              <>
                                <strong>{point}</strong>
                                <span style={{ display: 'block', fontSize: 9, color: 'var(--muted)' }}>
                                  [{prediction.p10Return20d.toFixed(1)}, {prediction.p90Return20d.toFixed(1)}]
                                </span>
                              </>
                            )
                          }
                          return point
                        })()}
                      </td>
                      <td title={readiness.detail}>
                        <strong className={readiness.tone}>{readiness.label}</strong>
                        <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>
                          {Math.round(row.dataConfidence ?? 0)}%
                        </span>
                      </td>
                      <td className="actions">
                        <button
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${row.ticker}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setExpandedTicker((current) => (current === row.ticker ? null : row.ticker))
                          }}
                          type="button"
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span>{isExpanded ? 'Less' : 'More'}</span>
                        </button>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="expanded-row">
                        <td colSpan={9}>
                          <dl>
                            <div>
                              <dt>Why it ranks here</dt>
                              <dd>{row.evidence.join(' · ')}</dd>
                            </div>
                            <div>
                              <dt>What could go wrong</dt>
                              <dd>{row.riskFlags.join(' · ')}</dd>
                            </div>
                            <div>
                              <dt>Invalidation triggers</dt>
                              <dd>{row.invalidation.join(' · ')}</dd>
                            </div>
                            <div>
                              <dt>Position plan</dt>
                              <dd>
                                {row.positionPlan} - {row.nextCheck}
                              </dd>
                            </div>
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PortfolioPulseStrip({
  pulse,
  metrics,
  onFocusOwned,
  onFocusRisk,
}: {
  pulse: NonNullable<ReturnType<typeof portfolioPulse>>
  metrics: {
    value: number
    cost: number
    pnl: number | null
    pnlPct: number | null
    positionsWithCost: number
  } | null
  onFocusOwned: () => void
  onFocusRisk: () => void
}) {
  const tone: Tone = pulse.risk > 0 ? 'caution' : pulse.buys > pulse.hold ? 'positive' : 'neutral'
  return (
    <section className={`portfolio-pulse ${tone}`} data-testid="portfolio-pulse">
      <div className="portfolio-pulse-lead">
        <p>Your portfolio</p>
        <h2>
          {pulse.matched} tracked positions{pulse.unmatched > 0 ? ` (+${pulse.unmatched} not in universe)` : ''}
        </h2>
      </div>
      <div className="portfolio-pulse-stats">
        <button onClick={onFocusOwned} type="button" className="positive">
          <strong>{pulse.buys}</strong>
          <span>buy / accumulate</span>
        </button>
        <button onClick={onFocusOwned} type="button">
          <strong>{pulse.hold}</strong>
          <span>hold</span>
        </button>
        <button onClick={onFocusRisk} type="button" className={pulse.risk > 0 ? 'danger' : ''}>
          <strong>{pulse.risk}</strong>
          <span>trim / sell / avoid</span>
        </button>
      </div>
      <div className="portfolio-pulse-list">
        {pulse.rows.slice(0, 6).map((row) => (
          <span
            className={`pill ${thinEvidence(row) ? 'caution' : actionTone(row.action)}`}
            key={row.ticker}
            title={
              thinEvidence(row)
                ? `Thin evidence — not decision-grade. ${synthesizeReason(row)}`
                : synthesizeReason(row)
            }
          >
            {thinEvidence(row) ? '⚠ ' : ''}{row.ticker} - {row.action}
          </span>
        ))}
        {pulse.rows.length > 6 ? <span className="pulse-more">+{pulse.rows.length - 6} more</span> : null}
      </div>
      {metrics && metrics.value > 0 ? (
        <div className="portfolio-pnl">
          <div>
            <span>Market value</span>
            <strong>{formatPnlCurrency(metrics.value)}</strong>
          </div>
          <div>
            <span>Cost basis</span>
            <strong>
              {metrics.positionsWithCost > 0
                ? formatPnlCurrency(metrics.cost)
                : '—'}
            </strong>
          </div>
          <div>
            <span>Unrealized P&amp;L</span>
            <strong
              className={metrics.pnl == null ? '' : metrics.pnl >= 0 ? 'positive' : 'danger'}
            >
              {metrics.pnl == null
                ? 'add cost basis'
                : `${metrics.pnl >= 0 ? '+' : ''}${formatPnlCurrency(metrics.pnl)}${metrics.pnlPct != null ? ` (${metrics.pnlPct >= 0 ? '+' : ''}${metrics.pnlPct.toFixed(1)}%)` : ''}`}
            </strong>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function formatPnlCurrency(value: number) {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function WhatChangedStrip({ history }: { history: DecisionHistoryPoint[] }) {
  if (history.length < 2) return null
  const latest = history[0]
  const previous = history[1]
  const newTopBuy =
    latest.topBuy?.ticker && latest.topBuy.ticker !== previous.topBuy?.ticker
      ? latest.topBuy.ticker
      : null
  const newTopRisk =
    latest.topRisk?.ticker && latest.topRisk.ticker !== previous.topRisk?.ticker
      ? latest.topRisk.ticker
      : null
  if (!newTopBuy && !newTopRisk) return null

  return (
    <section className="changed-strip" data-testid="what-changed">
      <div>
        <p>Since last refresh</p>
        <h2>What moved on the board</h2>
      </div>
      <div className="changed-grid">
        {newTopBuy ? (
          <article className="positive">
            <strong>New top buy: {newTopBuy}</strong>
            <span>Replaced {previous.topBuy?.ticker ?? 'no prior'}</span>
          </article>
        ) : null}
        {newTopRisk ? (
          <article className="danger">
            <strong>New top risk: {newTopRisk}</strong>
            <span>Replaced {previous.topRisk?.ticker ?? 'no prior'}</span>
          </article>
        ) : null}
      </div>
    </section>
  )
}

function BackendDownState({
  errorMessage,
  onRetry,
}: {
  errorMessage: string | null
  onRetry: () => void
}) {
  return (
    <section className="panel backend-down" data-testid="backend-down">
      <h2>The backend cache is not reachable.</h2>
      <p>
        Recommendations are paused on purpose so you do not act on stale data.
        Start the local backend cache from the repo root and the Decision Desk
        will resume automatically.
      </p>
      <pre>dart run tool/backend_cache_server.dart --port 8787 --web-root build/web</pre>
      <p className="backend-down-detail">
        Last error: <code>{errorMessage ?? 'no error reported'}</code>
      </p>
      <button onClick={onRetry} type="button">
        <RefreshCcw size={16} />
        Retry connection
      </button>
    </section>
  )
}

/**
 * Shown when the backend is reachable but has zero scoreable names yet —
 * i.e. a freshly started server that's still warming its price cache.
 * Distinct from BackendDownState (which means unreachable) so users see
 * "give it a minute" instead of "something is broken".
 */
function WarmingUpState({
  universeSize,
  onRefresh,
}: {
  universeSize: number
  onRefresh: () => void
}) {
  return (
    <section className="panel warming-up" data-testid="warming-up">
      <h2>
        <span className="pulse-dot" /> Warming up market data
      </h2>
      <p>
        The backend just started and is syncing price history for{' '}
        {universeSize > 0 ? universeSize.toLocaleString() : 'the'} symbols in the
        background. Names appear here automatically as their data lands —
        the first batch usually shows within a minute.
      </p>
      <button onClick={onRefresh} type="button">
        <RefreshCcw size={16} />
        Check now
      </button>
    </section>
  )
}

function DetailPanel({
  signal,
  conviction,
  reviewed,
  owned,
  watched,
  isDrawerOpen,
  holdings,
  onClose,
  onReview,
  onToggleOwned,
  onToggleWatch,
}: {
  signal: DecisionSignal | null
  conviction: ConvictionStack | null
  reviewed: boolean
  owned: boolean
  watched: boolean
  isDrawerOpen: boolean
  holdings: StoredHolding[]
  onClose: () => void
  onReview: (ticker: string) => void
  onToggleOwned: (ticker: string) => void
  onToggleWatch: (ticker: string) => void
}) {
  if (!signal) {
    return (
      <aside className={`detail-panel empty-detail ${isDrawerOpen ? 'open' : ''}`}>
        <p>Stock intelligence</p>
        <h2>Select a ticker</h2>
      </aside>
    )
  }

  const readiness = signalReadiness(signal)

  return (
    <aside className={`detail-panel ${isDrawerOpen ? 'open' : ''}`} data-testid="candidate-detail">
      <header>
        <div>
          <p>Stock intelligence</p>
          <h2>
            {signal.ticker} <span>{signal.name}</span>
          </h2>
          <div style={{ marginTop: 4 }}>
            <EarningsChip ticker={signal.ticker} />
          </div>
        </div>
        <button aria-label="Close stock detail" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </header>

      <div className="detail-action">
        <ActionPill action={signal.action} caveated={thinEvidence(signal)} />
        {thinEvidence(signal) ? (
          <span className="pill danger" title={signalReadiness(signal).detail}>
            ⚠ Thin evidence — not decision-grade
          </span>
        ) : null}
        <strong>{signal.positionPlan}</strong>
        <span>{signal.nextCheck}</span>
      </div>

      <ConvictionStackMeter stack={conviction} />

      <section className={`detail-thesis ${actionTone(signal.action)}`} data-testid="detail-thesis">
        <p>One-line read</p>
        <strong>{synthesizeReason(signal)}</strong>
        <span
          title={
            signal.quantConfirmed
              ? "Odds from this name's GJR-GARCH / HAR-RV Monte Carlo simulation."
              : "Heuristic only: rule-derived from the composite factor score (normal-CDF of the alpha Z) — NOT a calibrated or simulated probability. Read it as a relative confidence cue, not a forecast."
          }
        >
          Forecast {formatSignedPercent(signal.forecast20d)} 20d · {signal.probabilityOutperform}% outperform / {signal.probabilityDrawdown}% drawdown {signal.quantConfirmed ? '(simulated)' : '(heuristic)'}
        </span>
      </section>

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

      {/* Verdict zone ends here: action, conviction, thesis, readiness,
          sizing, and the chart stay above the fold. Everything deeper is
          grouped behind a click (doctrine: information that doesn't speed
          the decision stays off the main path). */}
      <PositionSizer
        action={signal.action}
        kellyHalfPct={signal.recommendedKellyHalfPct}
        lastPrice={signal.lastPrice}
        riskScore={signal.riskScore}
        ticker={signal.ticker}
      />
      <PriceChart ticker={signal.ticker} />

      <details className="detail-group" data-testid="detail-group-evidence" open>
        <summary>
          <ChevronRight size={14} />
          Evidence &amp; analysis
        </summary>
        <div className="detail-group-body">
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
            <Metric
              label="Drawdown odds"
              value={`${signal.probabilityDrawdown}%`}
              detail={signal.quantConfirmed ? 'Monte Carlo' : 'heuristic'}
              tone="caution"
            />
            <Metric
              label="Price as of"
              value={formatDate(signal.priceAsOf)}
              detail={signal.historyBars ? `${signal.historyBars} bars` : 'no OHLCV yet'}
            />
          </div>
          <FactorBreakdown signal={signal} />
          <QuantAnalysisCard signal={signal} />
          <InfoList title="Why it ranks here" items={signal.evidence} tone="positive" />
          <InfoList title="What could go wrong" items={signal.riskFlags} tone="caution" />
          <EvidenceLedger signal={signal} />
          <InfoList title="Invalidation triggers" items={signal.invalidation} tone="danger" />
        </div>
      </details>

      <details className="detail-group" data-testid="detail-group-options">
        <summary>
          <ChevronRight size={14} />
          Options strategies &amp; chain
        </summary>
        <div className="detail-group-body">
          <OptionsStrategiesCard
            holding={findHoldingForSignal(signal, holdings)}
            signal={signal}
          />
          <OptionsCard ticker={signal.ticker} />
        </div>
      </details>

      <details className="detail-group" data-testid="detail-group-journal">
        <summary>
          <ChevronRight size={14} />
          Journal, history &amp; news
        </summary>
        <div className="detail-group-body">
          <TickerNotes ticker={signal.ticker} />
          <DecisionHistory ticker={signal.ticker} />
          <NewsStream name={signal.name} ticker={signal.ticker} />
        </div>
      </details>

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

function EmptyState({ query, reason }: { query: string; reason?: string }) {
  return (
    <section className="panel empty-state">
      <h2>{query ? 'No matches' : 'No qualified live signals'}</h2>
      <p>{reason ?? `No visible securities match "${query}".`}</p>
    </section>
  )
}

function App() {
  const persisted = useMemo(() => readPersistedViewState(), [])
  // Deep-link override: ?view=brief|desk|workflows|lab (legacy ids migrate).
  const [activeView, setActiveView] = useState<ViewId>(() => {
    const fromUrl = migrateViewId(
      new URLSearchParams(window.location.search).get('view') ?? undefined,
    )
    return fromUrl ?? persisted.activeView ?? 'brief'
  })
  const [deskMode, setDeskMode] = useState<DeskMode>(persisted.deskMode ?? 'table')
  const [query, setQuery] = useState('')
  const [actionFilter, setActionFilter] = useState<ActionFilter>(persisted.actionFilter ?? 'All')
  const [sector, setSector] = useState(persisted.sector ?? 'All')
  const [sortKey, setSortKey] = useState<SortKey>(persisted.sortKey ?? 'action')
  const [highConvictionOnly, setHighConvictionOnly] = useState(persisted.highConvictionOnly ?? false)
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(() => new Date())
  const [refreshCount, setRefreshCount] = useState(0)
  const [reviewedTickers, setReviewedTickers] = useState<Set<string>>(() => new Set())
  const [reviewedHydrated, setReviewedHydrated] = useState(false)
  const [activeScenario, setActiveScenario] = useState<ScenarioId>(persisted.activeScenario ?? 'base')
  const [signalInputs, setSignalInputs] = useState<RawSignal[] | null>(null)
  const [decisionFeed, setDecisionFeed] = useState<DecisionUniverseResponse | null>(null)
  // Client-side history classified by the SAME JS engine the list uses — the
  // single source of truth. Replaces the backend's independent _classifyAction
  // history, which contradicted the list (audit: ~half the labels differed).
  const [jsHistory, setJsHistory] = useState<DecisionHistoryPoint[]>([])
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('loading')
  const [dataError, setDataError] = useState<string | null>(null)
  const [ownedTickers, setOwnedTickers] = useState<Set<string>>(() => readOwnedTickers())
  const [watchTickers, setWatchTickers] = useState<Set<string>>(() => readWatchTickers())
  const [priceSyncMode, setPriceSyncMode] = useState<'off' | 'auto' | 'force'>('off')
  const [theme, setTheme] = useState<ThemePreference>(() => readPersistedTheme())
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [tutorialOpen, setTutorialOpen] = useState(() => shouldShowTutorial())
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [holdings, setHoldings] = useState<StoredHolding[]>([])
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [optionsSnapshots, setOptionsSnapshots] = useState<Map<string, OptionsSnapshot>>(
    () => new Map(),
  )
  const [revisionRanks, setRevisionRanks] = useState<RevisionRanks>(() => new Map())
  const [quantAnalyses, setQuantAnalyses] = useState<Map<string, QuantAnalysis>>(
    () => new Map(),
  )
  // ML model state: persisted GBT loaded from IndexedDB + live predictions
  // for the visible universe + A/B decision mode toggle.
  const [mlModel, setMlModel] = useState<StoredMlModel | null>(null)
  const [regimeGate, setRegimeGate] = useState<RegimeGate | null>(null)
  const [mlPredictions, setMlPredictions] = useState<Map<string, LivePrediction>>(
    () => new Map(),
  )
  const [decisionMode, setDecisionMode] = useState<'rules' | 'ml' | 'ensemble'>(
    () => (typeof window !== 'undefined' && (window.localStorage.getItem('decisionMode') as 'rules' | 'ml' | 'ensemble' | null)) || 'rules',
  )
  const [reconnectIn, setReconnectIn] = useState<number | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const { showToast } = useToast()

  const ownedKey = useMemo(() => Array.from(ownedTickers).sort().join(','), [ownedTickers])
  const watchKey = useMemo(() => Array.from(watchTickers).sort().join(','), [watchTickers])
  const universe = useMemo(() => {
    // 1. Overlay live options + analyst-revision data onto rawSignals
    //    BEFORE scoring, so the cross-sectional Z-scores see real values.
    const baseSignals = signalInputs ?? []
    const enriched =
      optionsSnapshots.size === 0 && revisionRanks.size === 0
        ? baseSignals
        : baseSignals.map((signal) => {
            let next = signal
            const snapshot = optionsSnapshots.get(signal.ticker)
            if (snapshot) next = applyOptionsOverlay(next, snapshot)
            const revisions = revisionRanks.get(signal.ticker)
            if (revisions) next = applyRevisionsOverlay(next, revisions)
            return next
          })
    // 2. Run the statistical scoring pipeline (Z-scores + factors + regime).
    const scored = scoreUniverse(enriched, activeScenario)
    // 3. Overlay Monte Carlo + BSM + Kelly outputs onto the scored signals.
    //    For tickers we've completed quant analysis on, this REPLACES the
    //    rule-based forecast/probabilities with simulation-based ones AND
    //    re-evaluates the action through quant-confirmation gates.
    let withQuant = scored
    if (quantAnalyses.size > 0) {
      withQuant = scored.map((signal) => {
        const quant = quantAnalyses.get(signal.ticker)
        if (!quant) return signal
        return applyQuantOverlay(signal, {
          monteCarloMean: quant.monteCarlo.meanReturnPct,
          monteCarloProbUp: quant.monteCarlo.probUp,
          monteCarloProbUp5: quant.monteCarlo.probUp5pct,
          monteCarloProbDown8: quant.monteCarlo.probDown8pct,
          kellyHalfFraction: quant.kellyHalf,
          riskNeutralProbUp: quant.riskNeutral?.probUp,
        })
      })
    }
    // A/B decision mode: override action with ML prediction (or blend) when
    // configured — UNLESS the regime gate is closed. The 2026-05-12 backtest
    // measured IC 0.021 / 50.2% hit rate (coin flip) for the model in
    // high-vol Markov regimes, so ML overrides are suppressed there and the
    // engine falls back to rules (see quantConfig.ML_REGIME_GATE).
    if (decisionMode !== 'rules' && mlPredictions.size > 0 && !regimeGate?.gated) {
      // The ML model predicts RELATIVE (cross-sectionally demeaned) 20d return
      // — its output is ~zero-centered, so absolute % thresholds (">1.5% =
      // Buy") are wrong: roughly half the batch is negative BY CONSTRUCTION
      // regardless of absolute attractiveness, which would force good names to
      // Trim/Sell on relative weakness. Gate on the name's cross-sectional
      // RANK within the live ML batch instead — the quintile convention used
      // elsewhere (Fama-French portfolio cut, TOP_QUINTILE_PERCENTILE).
      const mlPctByTicker = batchPercentiles(
        [...mlPredictions.entries()].map(([ticker, p]) => [ticker, p.predictedReturn20d]),
      )
      // Below this many predictions a percentile is too noisy to act on; leave
      // the rules action untouched rather than force a miscalibrated override.
      const haveRankBreadth = mlPctByTicker.size >= 8
      withQuant = withQuant.map((signal) => {
        const prediction = mlPredictions.get(signal.ticker)
        if (!prediction || !haveRankBreadth) return signal
        const pct = mlPctByTicker.get(signal.ticker)
        if (pct == null) return signal
        if (decisionMode === 'ml') {
          // Pure-ML gating on the relative-return percentile: top quintile
          // buys, bottom quintile sells (symmetric quintile cuts).
          let mlAction: typeof signal.action = 'Hold'
          if (pct >= 80) mlAction = 'Buy Now'
          else if (pct >= 60) mlAction = 'Accumulate'
          else if (pct <= 20) mlAction = 'Sell'
          else if (pct <= 40) mlAction = 'Trim'
          return { ...signal, action: mlAction }
        }
        // Ensemble: blend in RANK space — both the rules composite-alpha
        // percentile and the ML relative-return percentile are 0-100, so they
        // are commensurable (the old code averaged a raw ±12 forecast with the
        // relative ML output, mixing units). Conservative: only nudge a Hold.
        const blendedPct = (pct + signal.alphaPercentile) / 2
        let blendedAction = signal.action
        if (blendedPct >= 80 && signal.action === 'Hold') blendedAction = 'Accumulate'
        if (blendedPct <= 20 && signal.action === 'Hold') blendedAction = 'Trim'
        return { ...signal, action: blendedAction }
      })
    }
    return withQuant
  }, [activeScenario, signalInputs, optionsSnapshots, revisionRanks, quantAnalyses, decisionMode, mlPredictions, regimeGate])
  // Conviction stacks: six independent evidence layers per name (rules,
  // ML, Monte Carlo, options skew, regime, multi-horizon agreement).
  const convictionStacks = useMemo(
    () => buildConvictionStacks(universe, mlPredictions, regimeGate),
    [universe, mlPredictions, regimeGate],
  )
  const sectors = useMemo(() => ['All', ...Array.from(new Set(universe.map((row) => row.sector))).sort()], [universe])
  const activeMarketContext = useMemo(
    () => ({ ...marketContext, ...(decisionFeed?.marketContext ?? {}) }),
    [decisionFeed],
  )

  const customPredicate = useMemo(
    () => buildPredicate(filterRules, ownedTickers, watchTickers),
    [filterRules, ownedTickers, watchTickers],
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
      return actionAllowed && sectorAllowed && convictionAllowed && searchAllowed && customPredicate(row)
    })
    return sortSignals(filtered, sortKey)
  }, [actionFilter, highConvictionOnly, query, sector, sortKey, universe, customPredicate])

  const activeMeta = navItems.find((item) => item.id === activeView) ?? navItems[0]
  const selectedSignal = visibleRows.find((row) => row.ticker === selectedTicker) ?? visibleRows[0] ?? null
  const selectedDisplayTicker = selectedSignal?.ticker ?? selectedTicker
  const pulse = useMemo(() => portfolioPulse(universe, ownedTickers), [universe, ownedTickers])

  // Compute portfolio P&L from holdings + last prices in the universe.
  // Names without cost basis or shares contribute 0 — they're tracked
  // for decision purposes but don't move the dollar totals.
  const portfolioMetrics = useMemo(() => {
    if (holdings.length === 0) return null
    const tickerToPrice = new Map<string, number>()
    universe.forEach((row) => {
      if (row.lastPrice && row.lastPrice > 0) {
        tickerToPrice.set(row.ticker, row.lastPrice)
      }
    })
    let value = 0
    let cost = 0
    let positionsWithCost = 0
    holdings.forEach((holding) => {
      if (!holding.shares || holding.shares <= 0) return
      const price = tickerToPrice.get(holding.ticker)
      if (!price) return
      value += holding.shares * price
      if (holding.averageCost && holding.averageCost > 0) {
        cost += holding.shares * holding.averageCost
        positionsWithCost += 1
      }
    })
    const pnl = cost > 0 ? value - cost : null
    const pnlPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null
    return { value, cost, pnl, pnlPct, positionsWithCost }
  }, [holdings, universe])
  const topBuy = universe.find((row) => row.action === 'Buy Now' || row.action === 'Accumulate')
  const topRisk =
    universe
      .filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid')
      .sort(byRiskPriority)[0] ?? undefined
  // Append a JS-classified history snapshot whenever the leaders change, so
  // What-Changed + the history list stay consistent with the list/Brief.
  useEffect(() => {
    if (universe.length === 0) return
    const toSummary = (s: typeof topBuy): DecisionSummary | null =>
      s
        ? {
            ticker: s.ticker,
            action: s.action,
            opportunityScore: s.opportunityScore,
            confidence: s.confidence,
            riskScore: s.riskScore,
            fragilityScore: s.fragilityScore,
            thesisDamage: s.thesisDamage,
          }
        : null
    // Appends ONLY when the leaders change (guard returns prev otherwise), so
    // there is no cascade in steady state — the heuristic is safe to disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJsHistory((prev) => {
      const head = prev[0]
      if (
        head &&
        (head.topBuy?.ticker ?? null) === (topBuy?.ticker ?? null) &&
        (head.topRisk?.ticker ?? null) === (topRisk?.ticker ?? null)
      ) {
        return prev // leaders unchanged — no duplicate snapshot
      }
      const point: DecisionHistoryPoint = {
        asOf: new Date().toISOString(),
        universeSize: universe.length,
        returned: universe.length,
        scenario: activeScenario,
        topBuy: toSummary(topBuy),
        topRisk: toSummary(topRisk),
      }
      return [point, ...prev].slice(0, 12)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topBuy?.ticker, topRisk?.ticker, activeScenario, universe.length])
  const reviewed = selectedSignal ? reviewedTickers.has(selectedSignal.ticker) : false
  const selectedOwned = selectedSignal ? ownedTickers.has(selectedSignal.ticker) : false
  const selectedWatched = selectedSignal ? watchTickers.has(selectedSignal.ticker) : false
  const selectedConviction = selectedSignal
    ? convictionStacks.get(selectedSignal.ticker) ?? null
    : null
  const riskCount = universe.filter((row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid').length
  const ownedRiskCount = useMemo(
    () =>
      universe.filter(
        (row) =>
          ownedTickers.has(row.ticker) &&
          (row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid'),
      ).length,
    [universe, ownedTickers],
  )
  const sourceLabel = feedLabel(feedStatus)
  const workflows = usePortfolioWorkflows(holdings, universe, ownedTickers)
  const enrichedTickers = useMemo(() => new Set(optionsSnapshots.keys()), [optionsSnapshots])
  const optionsProviderName = activeOptionsProvider().name
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

  // Persist filter and view choices so reopening the app lands the user where they left off.
  useEffect(() => {
    persistViewState({ activeView, deskMode, actionFilter, sector, sortKey, highConvictionOnly, activeScenario })
  }, [activeView, deskMode, actionFilter, sector, sortKey, highConvictionOnly, activeScenario])

  // Theme: apply on mount and whenever it changes; persist for next launch.
  useEffect(() => {
    applyThemeToDocument(theme)
    try {
      window.localStorage.setItem(themeStorageKey, theme)
    } catch {
      // ignore
    }
  }, [theme])

  // Detail panel slide-over: dismiss with Escape on narrow viewports.
  useEffect(() => {
    if (!detailDrawerOpen) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDetailDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailDrawerOpen])

  // Keyboard navigation: J/K or Down/Up moves the row cursor, Enter inspects,
  // O toggles owned, W toggles watch, / focuses the search box. The handler
  // ignores key presses that originate inside form fields so typing isn't hijacked.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const inField = target ? ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) : false
      if (event.key === '/' && !inField) {
        const search = document.querySelector<HTMLInputElement>('.search input')
        if (search) {
          event.preventDefault()
          search.focus()
        }
        return
      }
      if (inField) return
      if (visibleRows.length === 0) return
      const currentIndex = visibleRows.findIndex((row) => row.ticker === selectedDisplayTicker)
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        const next = visibleRows[Math.min(currentIndex + 1, visibleRows.length - 1)] ?? visibleRows[0]
        setSelectedTicker(next.ticker)
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = visibleRows[Math.max(currentIndex - 1, 0)] ?? visibleRows[0]
        setSelectedTicker(next.ticker)
      } else if (event.key === 'Enter' && currentIndex >= 0) {
        event.preventDefault()
        markReviewed(visibleRows[currentIndex].ticker)
      } else if ((event.key === 'o' || event.key === 'O') && currentIndex >= 0) {
        event.preventDefault()
        toggleOwned(visibleRows[currentIndex].ticker)
      } else if ((event.key === 'w' || event.key === 'W') && currentIndex >= 0) {
        event.preventDefault()
        toggleWatch(visibleRows[currentIndex].ticker)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // toggleOwned/toggleWatch/markReviewed are stable closures over setState; including them
    // would re-register the listener on every render without behavioral benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows, selectedDisplayTicker])

  // `?` opens the shortcuts overlay from anywhere except form fields.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key !== '?' || event.shiftKey === false) {
        // Most keyboards put `?` on Shift+/, but laptops sometimes emit it
        // directly. Accept either.
      }
      if (event.key === '?') {
        const target = event.target as HTMLElement | null
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
        event.preventDefault()
        setShortcutsOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Hydrate reviewedTickers from IndexedDB. Stored under a date-stamped
  // key so reviewed status auto-clears each new trading day — yesterday's
  // "reviewed" doesn't count toward today's discipline.
  useEffect(() => {
    let cancelled = false
    const today = new Date().toISOString().slice(0, 10)
    void kvGet<string[]>(`reviewed:${today}`).then((stored) => {
      if (cancelled) return
      setReviewedTickers(new Set(stored ?? []))
      setReviewedHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist reviewedTickers any time it changes (after hydration).
  useEffect(() => {
    if (!reviewedHydrated) return
    const today = new Date().toISOString().slice(0, 10)
    void kvSet(`reviewed:${today}`, Array.from(reviewedTickers))
  }, [reviewedTickers, reviewedHydrated])

  // Load holdings from IndexedDB on mount + migrate legacy owned tickers.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const legacy = Array.from(ownedTickers)
      await migrateLegacyOwnedTickers(legacy)
      const stored = await getHoldings()
      if (!cancelled) {
        setHoldings(stored)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Warmup polling: backend reachable but zero scoreable names means a
  // freshly started server is still syncing its price cache (it warms
  // itself in the background). Poll every 15s so the UI fills in without
  // the user having to click anything.
  useEffect(() => {
    if (feedStatus !== 'backend') return
    if ((decisionFeed?.returned ?? 0) > 0) return
    const handle = window.setTimeout(() => setRefreshCount((count) => count + 1), 15000)
    return () => window.clearTimeout(handle)
  }, [feedStatus, decisionFeed])

  // Auto-reconnect: when the backend goes down, retry with exponential
  // backoff. The countdown is surfaced as a small "Reconnecting in Xs"
  // pill in the topbar so the user knows the app is trying.
  useEffect(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearInterval(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (feedStatus !== 'fallback') {
      reconnectAttemptsRef.current = 0
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReconnectIn(null)
      return
    }
    const attempt = reconnectAttemptsRef.current + 1
    reconnectAttemptsRef.current = attempt
    const delay = Math.min(60, 2 ** attempt)
    let remaining = delay
    setReconnectIn(remaining)
    reconnectTimerRef.current = window.setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        if (reconnectTimerRef.current !== null) {
          window.clearInterval(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        setReconnectIn(null)
        setRefreshCount((count) => count + 1)
      } else {
        setReconnectIn(remaining)
      }
    }, 1000)
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearInterval(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [feedStatus])

  // Record current action into the decision log for owned/watched tickers
  // so the per-ticker history timeline populates over time.
  useEffect(() => {
    if (universe.length === 0) return
    const watched = new Set([...ownedTickers, ...watchTickers])
    if (watched.size === 0) return
    const rows = universe
      .filter((row) => watched.has(row.ticker))
      .map((row) => ({
        ticker: row.ticker,
        action: row.action,
        asOf: lastRefresh.toISOString(),
        opportunityScore: row.opportunityScore,
        riskScore: row.riskScore,
        confidence: row.confidence,
        reason: synthesizeReason(row),
      }))
    if (rows.length > 0) {
      void recordCurrentDecisions(rows)
    }
  }, [universe, ownedTickers, watchTickers, lastRefresh])

  // Dock / taskbar / tab badge: shows count of owned positions with sell triggers.
  useEffect(() => {
    setDockBadge(ownedRiskCount)
  }, [ownedRiskCount])

  // Persist decision-mode choice
  useEffect(() => {
    try {
      window.localStorage.setItem('decisionMode', decisionMode)
    } catch {
      // ignore
    }
  }, [decisionMode])

  // Hydrate trained ML model from IDB on mount + reconcile any pending
  // predictions whose forward windows have closed.
  useEffect(() => {
    let cancelled = false
    void loadModel().then((stored) => {
      if (cancelled) return
      setMlModel(stored)
    })
    void getRegimeGate().then((gate) => {
      if (cancelled) return
      setRegimeGate(gate)
    })
    void reconcilePredictions()
    return () => {
      cancelled = true
    }
  }, [])

  // When the model is loaded, predict for the top tickers in the
  // universe (cap at 30 since each prediction needs a separate Yahoo
  // bars fetch). Predictions persist for decay tracking.
  useEffect(() => {
    if (!mlModel) return
    if (universe.length === 0) return
    let cancelled = false
    const tickers = pickTickersToEnhance(universe, ownedTickers, watchTickers, 30)
    if (tickers.length === 0) return
    void predictForUniverse(tickers, mlModel).then((predictions) => {
      if (cancelled) return
      setMlPredictions(predictions)
      // Log each prediction so the decay monitor has data later
      predictions.forEach((prediction) => {
        void logLivePrediction(prediction)
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mlModel, refreshCount, ownedKey, watchKey])

  // Ask the backend once which live feeds have a server-side token wired
  // (tokens no longer ship in this bundle). Retries every 5s while the backend
  // is still warming. Flipping providersReady re-renders the options provider
  // chip and re-runs the options + revision feed effects below. Declared ABOVE
  // those effects because their dependency arrays reference it at render time.
  const [providersReady, setProvidersReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const attempt = async () => {
      await loadProviderCapabilities()
      if (cancelled) return
      if (providerCapabilitiesLoaded()) setProvidersReady((v) => !v)
      else timer = window.setTimeout(attempt, 5000)
    }
    void attempt()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  // Background enhancement: pull real Tradier (or other provider) snapshots
  // for the top ~20 tickers we're most likely to look at. As each snapshot
  // arrives, we splice it into optionsSnapshots which triggers re-scoring.
  // Skipped entirely when no provider is configured.
  useEffect(() => {
    if (universe.length === 0) return
    const provider = activeOptionsProvider()
    if (provider.name === 'stub') return
    const tickers = pickTickersToEnhance(universe, ownedTickers, watchTickers, 20)
    if (tickers.length === 0) return

    let cancelled = false
    void fetchSnapshotsBatched(tickers, (ticker, snapshot) => {
      if (cancelled || !snapshot) return
      setOptionsSnapshots((current) => {
        const next = new Map(current)
        next.set(ticker, snapshot)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // Refetch when refresh count changes (manual re-rank) or owned/watch
    // changes meaningfully. We deliberately do NOT depend on the full
    // universe array because it remounts on every score run. providersReady
    // is a dep for the same reason as the revisions effect: the capability
    // map loads async, so the first run may see the stub provider — without
    // the dep, a configured Tradier feed would silently never be fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount, ownedKey, watchKey, providersReady])

  // Background analyst-revision enhancement (Finnhub free tier). Fills the
  // dormant revisionTrend / surpriseMomentum growth-factor inputs for a
  // prioritized slice of the universe. Cached names (IDB, 12h) seed
  // instant signal; only genuinely uncached names hit the throttled
  // fetch (free tier is 60 req/min, 2 calls/ticker). Skipped entirely when
  // the backend has no Finnhub token wired — fields stay neutral, never faked.
  useEffect(() => {
    if (universe.length === 0) return
    // The Finnhub token lives server-side now; we only ask the backend whether
    // the feed is wired. providersReady is a dep so this re-runs once the
    // capability map loads (it may arrive after the universe first populates).
    if (!revisionsConfigured()) return
    // Owned + watch + top opportunity; cap bounds the first-warm time.
    const tickers = pickTickersToEnhance(universe, ownedTickers, watchTickers, 300)
    if (tickers.length === 0) return

    let cancelled = false
    void (async () => {
      const raws = new Map<string, RevisionRaw>()
      const publish = () => {
        if (!cancelled && raws.size >= 20) setRevisionRanks(rankRevisions(new Map(raws)))
      }
      // 1. Seed from IDB cache instantly (no network, no throttle).
      const cached = await Promise.all(
        tickers.map((t) => getCachedRevisionRaw(t).catch(() => null)),
      )
      const uncached: string[] = []
      tickers.forEach((t, i) => {
        const hit = cached[i]
        if (hit) raws.set(t, hit)
        else uncached.push(t)
      })
      publish()
      // 2. Throttled network fetch for the rest, re-ranking periodically.
      const batchSize = 3
      for (let i = 0; i < uncached.length && !cancelled; i += batchSize) {
        const batch = uncached.slice(i, i + batchSize)
        const results = await Promise.all(
          batch.map((t) => fetchRevisionRaw(t).catch(() => null)),
        )
        results.forEach((r) => {
          if (r) raws.set(r.ticker, r)
        })
        if (raws.size % 30 < batchSize || i + batchSize >= uncached.length) publish()
        if (i + batchSize < uncached.length && !cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 7000))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount, ownedKey, watchKey, providersReady])

  // Background quant analysis: for the top tickers we'd actually trade,
  // run Monte Carlo + GARCH + BSM. Each takes 50-100ms so we cap at 12
  // (smaller than the options enhancement cap of 20). As each completes
  // it splices into quantAnalyses which triggers re-scoring with quant
  // overlays.
  useEffect(() => {
    if (universe.length === 0) return
    const tickers = pickTickersToEnhance(universe, ownedTickers, watchTickers, 12)
    if (tickers.length === 0) return
    let cancelled = false
    void (async () => {
      for (const ticker of tickers) {
        if (cancelled) return
        const signal = universe.find((row) => row.ticker === ticker)
        if (!signal) continue
        const analysis = await cachedComputeQuantAnalysis(signal)
        if (cancelled || !analysis) continue
        setQuantAnalyses((current) => {
          const next = new Map(current)
          next.set(ticker, analysis)
          return next
        })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount, ownedKey, watchKey])

  // Fire native notification when an owned ticker first hits a Sell or
  // a watched ticker first becomes a Buy. notifyOnce guards against
  // re-firing on every refresh.
  useEffect(() => {
    universe.forEach((row) => {
      if (ownedTickers.has(row.ticker) && (row.action === 'Sell' || row.action === 'Avoid')) {
        void notifyOnce(
          `${row.ticker}:owned-sell`,
          `Sell trigger: ${row.ticker}`,
          synthesizeReason(row),
        )
      } else if (
        watchTickers.has(row.ticker) &&
        (row.action === 'Buy Now' || row.action === 'Accumulate')
      ) {
        void notifyOnce(
          `${row.ticker}:watch-buy`,
          `Buy candidate: ${row.ticker}`,
          synthesizeReason(row),
        )
      }
    })
  }, [universe, ownedTickers, watchTickers])

  function openSignal(signal: DecisionSignal) {
    setSelectedTicker(signal.ticker)
    // Examining a ticker always happens on the Desk's table mode — other
    // surfaces/modes hand off here so the detail panel is in view.
    setActiveView('desk')
    setDeskMode('table')
    if (window.matchMedia('(max-width: 1280px)').matches) {
      setDetailDrawerOpen(true)
    }
  }

  /**
   * Owned imports go through the dialog (file picker + paste preview).
   * Watch imports stay on the lightweight prompt — they don't need cost
   * basis or column detection, so the friction of a full dialog isn't
   * worth it.
   */
  function bulkAddTickers(target: 'owned' | 'watch') {
    if (target === 'owned') {
      setImportDialogOpen(true)
      return
    }
    const raw = window.prompt(
      'Paste tickers to watch. Separate with commas, spaces, or new lines.',
      '',
    )
    if (!raw) return
    const before = watchTickers.size
    const next = mergeTickerList(watchTickers, raw)
    setWatchTickers(next)
    const added = next.size - before
    showToast(
      added === 0 ? 'Nothing new to watch' : `Added ${added} ticker${added === 1 ? '' : 's'} to watch list`,
      added === 0 ? 'info' : 'success',
    )
  }

  /** Commits parsed rows from the import dialog into IDB + state. */
  function commitPortfolioImport(parsedRows: StoredHolding[]) {
    if (parsedRows.length === 0) {
      showToast('Nothing to import', 'info')
      return
    }
    setImportDialogOpen(false)
    setFeedStatus('loading')
    setOwnedTickers((current) => {
      const next = new Set(current)
      parsedRows.forEach((row) => next.add(row.ticker))
      return next
    })
    void bulkPutHoldings(parsedRows).then(async () => {
      const all = await getHoldings()
      setHoldings(all)
      const withCost = parsedRows.filter((row) => row.averageCost && row.shares > 0).length
      showToast(
        `Imported ${parsedRows.length} position${parsedRows.length === 1 ? '' : 's'}` +
          (withCost > 0 ? ` (${withCost} with cost basis)` : ''),
        'success',
      )
    })
  }

  /** Removes a single holding from IndexedDB and refreshes the list. */
  async function removeHolding(ticker: string) {
    await deleteHolding(ticker)
    const all = await getHoldings()
    setHoldings(all)
    setOwnedTickers((current) => {
      const next = new Set(current)
      next.delete(ticker)
      return next
    })
    showToast(`Removed ${ticker} from portfolio`, 'info')
  }

  /** Copies the current view's rows as CSV to the clipboard. */
  async function exportCurrentView() {
    const rows: ExportRow[] = visibleRows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      action: row.action,
      reason: synthesizeReason(row),
      opportunityScore: row.opportunityScore,
      riskScore: row.riskScore,
      forecast20d: row.forecast20d,
      lastPrice: row.lastPrice,
    }))
    if (rows.length === 0) {
      showToast('Nothing to export from this view', 'error')
      return
    }
    const csv = rowsToCsv(rows)
    const ok = await copyToClipboard(csv)
    showToast(
      ok ? `Copied ${rows.length} rows as CSV to clipboard` : 'Could not access clipboard',
      ok ? 'success' : 'error',
    )
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
    if (ownedTickers.has(ticker)) {
      void removeHolding(ticker)
      return
    }
    setOwnedTickers((current) => {
      const next = new Set(current)
      next.add(ticker)
      return next
    })
    void bulkPutHoldings([
      { ticker, shares: 0, addedAt: new Date().toISOString() },
    ]).then(async () => {
      const all = await getHoldings()
      setHoldings(all)
    })
    showToast(`${ticker} added to portfolio (set shares with bulk import)`, 'info')
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
    setActiveView('desk')
    setDeskMode('table')
  }

  function activateView(view: ViewId) {
    setActiveView(view)
  }

  function activateActionFilter(filter: ActionFilter) {
    setActionFilter(filter)
    setActiveView('desk')
    setDeskMode('table')
  }

  function clearFilters() {
    setQuery('')
    setActionFilter('All')
    setActiveView('desk')
    setDeskMode('table')
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
            {reconnectIn !== null ? (
              <span className="reconnect-indicator" title="Backend unreachable - retrying with backoff">
                <span className="pulse" />
                Reconnecting in {reconnectIn}s
              </span>
            ) : null}
            <span
              className={`provider-chip ${
                optionsProviderName === 'stub' ? 'inactive' : 'active'
              }`}
              title={
                optionsProviderName === 'stub'
                  ? 'No options provider configured - engine uses price-derived proxies for IV and skew. Add a Tradier token to the backend (local_secrets.dart kTradierToken or the TRADIER_TOKEN env var) and rebuild to switch on live data.'
                  : `Options scoring uses real ${optionsProviderName} data for ${enrichedTickers.size} of ${universe.length} ranked tickers. The rest still use price-derived proxies.`
              }
            >
              <Activity size={12} />
              {optionsProviderName === 'stub'
                ? 'Options: proxy'
                : `Options: ${optionsProviderName} - ${enrichedTickers.size}/${universe.length}`}
            </span>
            <button
              aria-label="Add owned tickers in bulk"
              className="ghost"
              onClick={() => bulkAddTickers('owned')}
              title="Paste TICKER, TICKER,SHARES or TICKER,SHARES,COST rows"
              type="button"
            >
              <CheckCircle2 size={15} />
              Import owned
            </button>
            <button
              aria-label="Add watch tickers in bulk"
              className="ghost"
              onClick={() => bulkAddTickers('watch')}
              title="Paste a list of tickers to watch"
              type="button"
            >
              <Bell size={15} />
              Import watch
            </button>
            <button
              aria-label="Copy current view as CSV"
              className="ghost"
              onClick={exportCurrentView}
              title="Copy current ranked rows as CSV to clipboard"
              type="button"
            >
              <Clipboard size={15} />
              Export CSV
            </button>
            <button
              aria-label="Re-rank with current cache"
              disabled={feedStatus === 'loading'}
              onClick={refreshData}
              title="Re-rank using cached prices (no network calls)"
              type="button"
            >
              <RefreshCcw size={15} />
              Re-rank
            </button>
            <button
              aria-label="Sync prices from market data sources"
              className="primary"
              disabled={feedStatus === 'loading'}
              onClick={syncPrices}
              title="Pull fresh prices from the backend, then re-rank"
              type="button"
            >
              <RefreshCcw size={15} />
              Sync prices
            </button>
            <button
              aria-expanded={alertsOpen}
              aria-label={alertsOpen ? 'Hide alerts' : 'Show alerts'}
              className={`icon-only ghost ${alertsOpen ? 'active' : ''}`}
              onClick={() => setAlertsOpen((open) => !open)}
              title="Alerts"
              type="button"
            >
              <Bell size={15} />
            </button>
            <button
              aria-label="Show keyboard shortcuts"
              className="icon-only ghost"
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (?)"
              type="button"
            >
              <Keyboard size={15} />
            </button>
            <button
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="icon-only ghost"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              type="button"
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {mlModel ? (
              <label className="select-control" title="Decision mode: rules / ML / ensemble">
                <span>Mode</span>
                <select
                  onChange={(event) =>
                    setDecisionMode(event.target.value as 'rules' | 'ml' | 'ensemble')
                  }
                  value={decisionMode}
                >
                  <option value="rules">Rules</option>
                  <option value="ml">ML</option>
                  <option value="ensemble">Ensemble</option>
                </select>
              </label>
            ) : null}
            {mlModel && regimeGate?.gated && decisionMode !== 'rules' ? (
              <span className="regime-gate-chip" title={regimeGate.detail}>
                ML regime-gated
              </span>
            ) : null}
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

        {feedStatus === 'fallback' && universe.length === 0 ? (
          <BackendDownState errorMessage={dataError} onRetry={refreshData} />
        ) : feedStatus === 'backend' && universe.length === 0 ? (
          <WarmingUpState
            universeSize={decisionFeed?.universeSize ?? 0}
            onRefresh={refreshData}
          />
        ) : (
          <>
            <StatusStrip feed={decisionFeed} rows={universe} status={feedStatus} />

            {activeScenario !== 'base' ? (
              <section className="scenario-warning" data-testid="scenario-warning">
                <strong>What-if mode</strong>
                <span>
                  Scores below are a hypothetical re-rank assuming the active shock. Reset to view the real
                  current state.
                </span>
                <button onClick={() => setActiveScenario('base')} type="button">
                  Reset to base
                </button>
              </section>
            ) : null}

            {ownedTickers.size === 0 && watchTickers.size === 0 ? (
              <section className="first-time-callout" data-testid="first-time">
                <div>
                  <strong>Get personal recommendations</strong>
                  <span>Import your portfolio to see Hold / Trim / Sell calls on positions you actually own.</span>
                </div>
                <button className="primary" onClick={() => bulkAddTickers('owned')} type="button">
                  <CheckCircle2 size={15} />
                  Import owned tickers
                </button>
              </section>
            ) : null}

          </>
        )}

        {activeView === 'brief' ? (
          <ExecutiveBrief
            activeScenario={activeScenario}
            asOf={lastRefresh.toISOString()}
            convictionStacks={convictionStacks}
            holdings={holdings}
            marketContext={activeMarketContext as MarketContext}
            mlPredictions={mlPredictions}
            onOpenStock={(ticker) => {
              setSelectedTicker(ticker)
              setActiveView('desk')
              setDeskMode('table')
            }}
            ownedTickers={ownedTickers}
            portfolioMetrics={portfolioMetrics}
            universe={universe}
            watchTickers={watchTickers}
          />
        ) : null}

        {activeView === 'desk' ? (
          <>
            {pulse ? (
              <PortfolioPulseStrip
                metrics={portfolioMetrics}
                onFocusOwned={() => activateActionFilter('All')}
                onFocusRisk={() => activateActionFilter('Risk')}
                pulse={pulse}
              />
            ) : null}

            <WhatChangedStrip history={jsHistory} />

            <section className="hero-grid" aria-label="Top decisions right now">
              <LeadDecisionCard
                label="Highest-conviction buy right now"
                onOpen={openSignal}
                signal={topBuy}
                tone="positive"
              />
              <LeadDecisionCard
                label="Biggest deterioration to act on"
                onOpen={openSignal}
                signal={topRisk}
                tone="danger"
              />
            </section>

            <ActionSummaryStrip rows={universe} activeFilter={actionFilter} onActionFocus={focusAction} />

            <div className="desk-toolbar" data-testid="desk-toolbar">
              <div className="desk-modes" role="tablist" aria-label="Desk mode">
                {(
                  [
                    ['table', 'Rankings'],
                    ['compare', 'Compare'],
                    ['radar', 'Market radar'],
                  ] as Array<[DeskMode, string]>
                ).map(([mode, label]) => (
                  <button
                    aria-selected={deskMode === mode}
                    className={deskMode === mode ? 'active' : ''}
                    key={mode}
                    onClick={() => setDeskMode(mode)}
                    role="tab"
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="select-control" title="Stress-test: re-rank the universe under a hypothetical shock">
                <span>Scenario</span>
                <select
                  onChange={(event) => setActiveScenario(event.target.value as ScenarioId)}
                  value={activeScenario}
                >
                  {scenarios.map((scenario) => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenario.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {activeScenario !== 'base' ? (
              <p className="desk-scenario-note">
                {scenarios.find((scenario) => scenario.id === activeScenario)?.interpretation}
              </p>
            ) : null}

            {deskMode === 'table' ? (
              <>
                <FilterBuilder onChange={setFilterRules} rules={filterRules} universe={universe} />

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

                {visibleRows.length === 0 ? (
                  <EmptyState query={query} reason={noRowsReason} />
                ) : (
                  <section className="main-grid" data-testid="view-desk">
                    <DecisionTable
                      enrichedTickers={enrichedTickers}
                      isLoading={feedStatus === 'loading'}
                      mlPredictions={mlPredictions}
                      onOpen={openSignal}
                      ownedTickers={ownedTickers}
                      rows={visibleRows}
                      selectedTicker={selectedDisplayTicker}
                      sourceLabel={sourceLabel}
                      watchTickers={watchTickers}
                    />
                    <DetailPanel
                      conviction={selectedConviction}
                      holdings={holdings}
                      isDrawerOpen={detailDrawerOpen}
                      onClose={() => {
                        setSelectedTicker(null)
                        setDetailDrawerOpen(false)
                      }}
                      onReview={markReviewed}
                      onToggleOwned={toggleOwned}
                      onToggleWatch={toggleWatch}
                      owned={selectedOwned}
                      reviewed={reviewed}
                      signal={selectedSignal}
                      watched={selectedWatched}
                    />
                  </section>
                )}
              </>
            ) : null}

            {deskMode === 'compare' ? (
              <ComparisonView
                initialTickers={[
                  ...Array.from(ownedTickers).slice(0, 2),
                  ...visibleRows
                    .filter((row) => !ownedTickers.has(row.ticker))
                    .slice(0, 2)
                    .map((row) => row.ticker),
                ].slice(0, 4)}
                onOpenStock={(ticker) => {
                  setSelectedTicker(ticker)
                  setDeskMode('table')
                }}
                universe={universe}
              />
            ) : null}

            {deskMode === 'radar' ? (
              <MarketRadar
                context={activeMarketContext}
                history={jsHistory}
                rows={universe}
              />
            ) : null}
          </>
        ) : null}

        {activeView === 'workflows' ? (
          <section className="workflow-stack" data-testid="view-workflow">
            <section className="panel">
              <header className="panel-header">
                <div>
                  <p>Weekly digest</p>
                  <h2>Print or save your portfolio summary</h2>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    const ok = exportWeeklyDigest({
                      topBuys: universe.filter(
                        (row) => row.action === 'Buy Now' || row.action === 'Accumulate',
                      ),
                      topRisks: universe.filter(
                        (row) => row.action === 'Sell' || row.action === 'Trim' || row.action === 'Avoid',
                      ),
                      ownedRows: universe.filter((row) => ownedTickers.has(row.ticker)),
                      sectorWeights: workflows.weights,
                      totalValue: workflows.totalValue,
                      pnl:
                        portfolioMetrics?.pnl ?? null,
                      pnlPct:
                        portfolioMetrics?.pnlPct ?? null,
                      asOf: lastRefresh.toISOString(),
                    })
                    showToast(
                      ok
                        ? 'Digest opened in a new window — Cmd/Ctrl+P to save as PDF'
                        : 'Could not open print window — pop-ups may be blocked',
                      ok ? 'success' : 'error',
                    )
                  }}
                  type="button"
                >
                  <FileDown size={14} />
                  Export weekly digest
                </button>
              </header>
              <p className="workflow-lede">
                Opens a printable summary in a new window with your top buys, biggest risks, owned
                positions and their actions, and current sector mix. Use the browser's print dialog
                to save as PDF or send via email.
              </p>
            </section>
            <TransitionsLog ownedTickers={ownedTickers} watchTickers={watchTickers} />
            <RebalancePanel totalValue={workflows.totalValue} weights={workflows.weights} />
            <TaxLossPanel candidates={workflows.lossCandidates} />
          </section>
        ) : null}

        {activeView === 'lab' ? (
          <section className="workflow-stack" data-testid="view-lab">
            <ModelReadinessPanel feed={decisionFeed} universe={universe} />
            <ModelDecayMonitor />
            <BacktestPanel />
          </section>
        ) : null}
      </section>

      {detailDrawerOpen ? (
        <div
          aria-hidden
          className="drawer-backdrop"
          onClick={() => setDetailDrawerOpen(false)}
        />
      ) : null}

      <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} open={shortcutsOpen} />
      {tutorialOpen ? <TutorialOverlay onDismiss={() => setTutorialOpen(false)} /> : null}
      <PortfolioImportDialog
        onCancel={() => setImportDialogOpen(false)}
        onImport={commitPortfolioImport}
        open={importDialogOpen}
      />
    </main>
  )
}

export default App
