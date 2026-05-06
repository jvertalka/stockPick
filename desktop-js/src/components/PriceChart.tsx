import { useEffect, useMemo, useState } from 'react'
import { cachedFetchDailyBars, type DailyBar } from '../data/marketData'

/**
 * Real 90-day price chart (line) with 50-day moving average overlay,
 * 60d high/low markers, and the last close highlighted.
 *
 * Renders as inline SVG so there's no charting-library dependency.
 * Falls back to a clean empty state when bars can't be fetched (e.g.
 * the backend cache is offline or the ticker has no Yahoo coverage).
 */

type Range = '1mo' | '3mo' | '6mo' | '1y'

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: '1mo', label: '1M' },
  { value: '3mo', label: '3M' },
  { value: '6mo', label: '6M' },
  { value: '1y', label: '1Y' },
]

export function PriceChart({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<Range>('3mo')
  const [bars, setBars] = useState<DailyBar[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    cachedFetchDailyBars(ticker, range)
      .then((rows) => {
        if (cancelled) return
        setBars(rows)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setBars([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ticker, range])

  const chart = useMemo(() => (bars && bars.length >= 5 ? buildChart(bars) : null), [bars])

  return (
    <section className="panel-block price-chart">
      <header>
        <strong>Price chart</strong>
        <div className="range-toggle" role="tablist" aria-label="Chart range">
          {RANGE_OPTIONS.map((option) => (
            <button
              aria-pressed={range === option.value}
              className={`ghost ${range === option.value ? 'active' : ''}`}
              key={option.value}
              onClick={() => setRange(option.value)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>
      {loading && !bars ? (
        <div aria-live="polite" className="chart-loading">
          Loading {ticker} bars from cache…
        </div>
      ) : !chart ? (
        <div className="chart-empty">
          <strong>No bars available</strong>
          <span>
            The backend cache could not return OHLCV for {ticker}. Try the Sync prices button or
            confirm the symbol is on Yahoo.
          </span>
        </div>
      ) : (
        <ChartView chart={chart} ticker={ticker} />
      )}
    </section>
  )
}

type ChartData = ReturnType<typeof buildChart>

function buildChart(bars: DailyBar[]) {
  const closes = bars.map((bar) => bar.close)
  const minPrice = Math.min(...closes)
  const maxPrice = Math.max(...closes)
  const padding = (maxPrice - minPrice) * 0.08
  const yMin = minPrice - padding
  const yMax = maxPrice + padding
  const sma50 = simpleMovingAverage(closes, 50)
  const high60 = bars.length > 0 ? Math.max(...closes.slice(-60)) : null
  const low60 = bars.length > 0 ? Math.min(...closes.slice(-60)) : null
  const last = bars[bars.length - 1]
  const first = bars[0]
  const change = ((last.close - first.close) / first.close) * 100
  return { bars, closes, sma50, yMin, yMax, high60, low60, last, first, change }
}

function ChartView({ chart, ticker }: { chart: NonNullable<ChartData>; ticker: string }) {
  const width = 360
  const priceHeight = 110
  const volumeHeight = 26
  const totalHeight = priceHeight + volumeHeight + 4
  const padX = 4
  const padY = 8

  const projectX = (idx: number) =>
    padX + (idx / Math.max(1, chart.bars.length - 1)) * (width - padX * 2)
  const projectY = (price: number) =>
    priceHeight - padY - ((price - chart.yMin) / (chart.yMax - chart.yMin)) * (priceHeight - padY * 2)

  const maxVolume = Math.max(...chart.bars.map((bar) => bar.volume))
  const volBarWidth = Math.max(0.6, ((width - padX * 2) / chart.bars.length) * 0.7)

  const linePath = chart.bars
    .map((bar, idx) => `${idx === 0 ? 'M' : 'L'} ${projectX(idx).toFixed(1)} ${projectY(bar.close).toFixed(1)}`)
    .join(' ')
  const areaPath = `${linePath} L ${projectX(chart.bars.length - 1).toFixed(1)} ${priceHeight} L ${projectX(0)} ${priceHeight} Z`
  const smaPath = chart.sma50
    .map((value, idx) =>
      value == null ? null : `${idx === 0 ? 'M' : 'L'} ${projectX(idx).toFixed(1)} ${projectY(value).toFixed(1)}`,
    )
    .filter(Boolean)
    .join(' ')

  const isUp = chart.change >= 0
  const lastX = projectX(chart.bars.length - 1)
  const lastY = projectY(chart.last.close)

  return (
    <figure className={`price-chart-figure ${isUp ? 'up' : 'down'}`}>
      <svg
        aria-label={`${ticker} price chart with volume`}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${totalHeight}`}
      >
        {/* 60d high/low reference lines on price panel */}
        {chart.high60 != null ? (
          <line
            className="ref-line high"
            x1={padX}
            x2={width - padX}
            y1={projectY(chart.high60)}
            y2={projectY(chart.high60)}
          />
        ) : null}
        {chart.low60 != null ? (
          <line
            className="ref-line low"
            x1={padX}
            x2={width - padX}
            y1={projectY(chart.low60)}
            y2={projectY(chart.low60)}
          />
        ) : null}
        <path className="price-area" d={areaPath} />
        <path className="price-line" d={linePath} />
        {smaPath ? <path className="sma-line" d={smaPath} /> : null}
        <circle className="last-dot" cx={lastX} cy={lastY} r={3.5} />

        {/* Volume sub-strip below the price panel */}
        {chart.bars.map((bar, idx) => {
          const x = projectX(idx)
          const barHeightPx =
            maxVolume > 0
              ? (bar.volume / maxVolume) * (volumeHeight - 2)
              : 0
          const upDay = idx === 0 ? bar.close >= bar.open : bar.close >= chart.bars[idx - 1].close
          return (
            <rect
              className={`vol-bar ${upDay ? 'up' : 'down'}`}
              height={barHeightPx}
              key={idx}
              width={volBarWidth}
              x={x - volBarWidth / 2}
              y={priceHeight + 4 + (volumeHeight - 2 - barHeightPx)}
            />
          )
        })}
      </svg>
      <figcaption>
        <div>
          <span>Close</span>
          <strong>{formatCurrency(chart.last.close)}</strong>
        </div>
        <div>
          <span>{chart.bars.length}d Δ</span>
          <strong className={isUp ? 'positive' : 'danger'}>
            {isUp ? '+' : ''}
            {chart.change.toFixed(1)}%
          </strong>
        </div>
        <div>
          <span>60d range</span>
          <strong>
            {chart.low60 ? formatCurrency(chart.low60) : '–'} → {chart.high60 ? formatCurrency(chart.high60) : '–'}
          </strong>
        </div>
      </figcaption>
    </figure>
  )
}

function simpleMovingAverage(values: number[], window: number): Array<number | null> {
  if (values.length < window) return values.map(() => null)
  const out: Array<number | null> = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    out.push(i >= window - 1 ? sum / window : null)
  }
  return out
}

function formatCurrency(value: number) {
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}
