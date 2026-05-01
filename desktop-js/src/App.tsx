import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  CircleDollarSign,
  Gauge,
  LineChart,
  RefreshCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react'
import './App.css'

type Action = 'Buy' | 'Hold' | 'Sell'
type Tone = 'positive' | 'neutral' | 'caution' | 'danger'

type Candidate = {
  ticker: string
  name: string
  sector: string
  action: Action
  score: number
  confidence: number
  regimeFit: number
  risk: number
  forecast20d: string
  evidence: string
  invalidation: string
}

const candidates: Candidate[] = [
  {
    ticker: 'NVDA',
    name: 'NVIDIA',
    sector: 'Semiconductors',
    action: 'Buy',
    score: 91,
    confidence: 84,
    regimeFit: 88,
    risk: 62,
    forecast20d: '+5.8%',
    evidence: 'Leadership intact, revisions firm, peer breadth still supportive.',
    invalidation: 'Failed breakout with skew steepening and sector breadth below 45.',
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft',
    sector: 'Mega-cap software',
    action: 'Buy',
    score: 86,
    confidence: 81,
    regimeFit: 84,
    risk: 44,
    forecast20d: '+3.1%',
    evidence: 'Quality growth bid, low fragility, durable estimate support.',
    invalidation: 'Relative strength turns negative versus platforms for 10 sessions.',
  },
  {
    ticker: 'LLY',
    name: 'Eli Lilly',
    sector: 'Healthcare',
    action: 'Hold',
    score: 78,
    confidence: 76,
    regimeFit: 71,
    risk: 51,
    forecast20d: '+1.9%',
    evidence: 'Defensive growth profile remains useful while momentum cools.',
    invalidation: 'Volume-backed loss of peer leadership and revision deceleration.',
  },
  {
    ticker: 'JPM',
    name: 'JPMorgan Chase',
    sector: 'Financials',
    action: 'Hold',
    score: 72,
    confidence: 70,
    regimeFit: 66,
    risk: 49,
    forecast20d: '+1.2%',
    evidence: 'Capital strength offsets a less favorable rate and credit backdrop.',
    invalidation: 'Credit spreads widen while bank breadth deteriorates.',
  },
  {
    ticker: 'TSLA',
    name: 'Tesla',
    sector: 'Autos',
    action: 'Sell',
    score: 43,
    confidence: 68,
    regimeFit: 39,
    risk: 82,
    forecast20d: '-4.6%',
    evidence: 'Fragility cluster rising, trend quality weak, options risk elevated.',
    invalidation: 'Reclaim prior range with improving volume and peer confirmation.',
  },
]

const sectorRows: Array<[string, number, string, string]> = [
  ['Semiconductors', 86, '+4.8%', 'Leadership'],
  ['Software', 78, '+2.6%', 'Accumulation'],
  ['Healthcare', 69, '+1.5%', 'Defensive bid'],
  ['Financials', 58, '+0.7%', 'Watch credit'],
  ['Consumer discretionary', 42, '-1.8%', 'Weak breadth'],
]

const alerts = [
  'Downside skew rising in high-beta growth.',
  'Small-cap participation remains below confirmation threshold.',
  'Credit proxies stable but not improving.',
]

function toneForAction(action: Action): Tone {
  if (action === 'Buy') return 'positive'
  if (action === 'Sell') return 'danger'
  return 'neutral'
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: Tone
}) {
  return (
    <section className="metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </section>
  )
}

function Score({ value, tone = 'neutral' }: { value: number; tone?: Tone }) {
  return (
    <div className="score">
      <span style={{ width: `${value}%` }} className={tone}></span>
    </div>
  )
}

function ActionTable({ action }: { action: Action }) {
  const rows = candidates.filter((candidate) => candidate.action === action)
  return (
    <section className="panel action-panel">
      <header className="panel-header">
        <div>
          <p>{action}</p>
          <h2>
            {action === 'Buy'
              ? 'Fresh candidates'
              : action === 'Hold'
                ? 'Keep under review'
                : 'Risk control'}
          </h2>
        </div>
        <span className={`pill ${toneForAction(action)}`}>{rows.length}</span>
      </header>
      <div className="table compact">
        {rows.map((row) => (
          <article className="row" key={row.ticker}>
            <div className="ticker-cell">
              <strong>{row.ticker}</strong>
              <span>{row.sector}</span>
            </div>
            <div>
              <span>Score</span>
              <strong>{row.score}</strong>
            </div>
            <div>
              <span>20d</span>
              <strong className={row.forecast20d.startsWith('-') ? 'danger' : 'positive'}>
                {row.forecast20d}
              </strong>
            </div>
            <button aria-label={`Open ${row.ticker}`}>
              <LineChart size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

function App() {
  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand">
          <BarChart3 size={22} />
          <span>Finance Oracle</span>
        </div>
        <nav aria-label="Main navigation">
          <button className="active" title="Decision desk">
            <CircleDollarSign size={18} />
            <span>Decision Desk</span>
          </button>
          <button title="Market radar">
            <Gauge size={18} />
            <span>Market Radar</span>
          </button>
          <button title="Opportunity board">
            <Activity size={18} />
            <span>Opportunity</span>
          </button>
          <button title="Sell alerts">
            <ShieldAlert size={18} />
            <span>Sell Alerts</span>
          </button>
          <button title="Scenario lab">
            <SlidersHorizontal size={18} />
            <span>Scenarios</span>
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>Decision Desk</p>
            <h1>Regime-aware buy, hold, and sell board</h1>
          </div>
          <div className="topbar-actions">
            <label className="search">
              <Search size={16} />
              <input placeholder="Search ticker" />
            </label>
            <button title="Refresh data">
              <RefreshCcw size={17} />
            </button>
            <button title="Alerts">
              <Bell size={17} />
            </button>
          </div>
        </header>

        <section className="metrics-grid">
          <Metric label="Current regime" value="Growth favorable" tone="positive" />
          <Metric label="Regime confidence" value="76%" />
          <Metric label="Risk level" value="Moderate" tone="caution" />
          <Metric label="Universe" value="1,331 names" />
        </section>

        <section className="decision-grid">
          <ActionTable action="Buy" />
          <ActionTable action="Hold" />
          <ActionTable action="Sell" />
        </section>

        <section className="lower-grid">
          <section className="panel">
            <header className="panel-header">
              <div>
                <p>Ranked evidence</p>
                <h2>Top conditional opportunities</h2>
              </div>
              <span className="pill neutral">Live cache</span>
            </header>
            <div className="candidate-list">
              {candidates.map((candidate) => (
                <article className="candidate" key={candidate.ticker}>
                  <div className="candidate-main">
                    <div>
                      <strong>{candidate.ticker}</strong>
                      <span>{candidate.name}</span>
                    </div>
                    <span className={`pill ${toneForAction(candidate.action)}`}>
                      {candidate.action}
                    </span>
                  </div>
                  <p>{candidate.evidence}</p>
                  <div className="score-grid">
                    <label>
                      Regime fit
                      <Score value={candidate.regimeFit} tone="positive" />
                    </label>
                    <label>
                      Confidence
                      <Score value={candidate.confidence} />
                    </label>
                    <label>
                      Risk
                    <Score
                      value={candidate.risk}
                      tone={candidate.risk > 75 ? 'danger' : 'caution'}
                    />
                    </label>
                  </div>
                  <footer>
                    <AlertTriangle size={14} />
                    <span>{candidate.invalidation}</span>
                  </footer>
                </article>
              ))}
            </div>
          </section>

          <section className="side-stack">
            <section className="panel">
              <header className="panel-header">
                <div>
                  <p>Sector rotation</p>
                  <h2>Sponsorship map</h2>
                </div>
              </header>
              <div className="sector-table">
                {sectorRows.map(([sector, score, move, label]) => (
                  <article key={sector}>
                    <div>
                      <strong>{sector}</strong>
                      <span>{label}</span>
                    </div>
                    <Score
                      value={score}
                      tone={score > 70 ? 'positive' : score < 50 ? 'danger' : 'neutral'}
                    />
                    <strong className={String(move).startsWith('-') ? 'danger' : 'positive'}>
                      {move.startsWith('-') ? (
                        <ArrowDownRight size={14} />
                      ) : (
                        <ArrowUpRight size={14} />
                      )}
                      {move}
                    </strong>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel">
              <header className="panel-header">
                <div>
                  <p>Risk tape</p>
                  <h2>Deterioration cluster</h2>
                </div>
                <span className="pill caution">3 flags</span>
              </header>
              <ul className="alerts">
                {alerts.map((alert) => (
                  <li key={alert}>
                    <AlertTriangle size={15} />
                    <span>{alert}</span>
                  </li>
                ))}
              </ul>
            </section>
          </section>
        </section>
      </section>
    </main>
  )
}

export default App
