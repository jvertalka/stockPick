import { useMemo } from 'react'

/**
 * Compact SVG sparkline for the detail panel.
 *
 * The backend's decision payload includes `priceChange20d/60d/120d` and
 * `lastPrice`. We invert those to compute four implied price points
 * (~120d ago, ~60d ago, ~20d ago, today) and draw a line through them.
 *
 * Because we only have 4 data points, this is deliberately rendered as a
 * "trajectory" indicator rather than a full chart. The label below the
 * SVG calls that out so users know what they're looking at. When a real
 * OHLCV endpoint comes online we'll swap the implementation; the props
 * stay stable.
 */

export type SparklineSignal = {
  ticker: string
  lastPrice?: number
  priceChange20d?: number
  priceChange60d?: number
  priceChange120d?: number
}

type Point = { x: number; y: number; label: string; price: number }

type Props = {
  signal: SparklineSignal
  width?: number
  height?: number
}

export function Sparkline({ signal, width = 320, height = 64 }: Props) {
  const data = useMemo(() => buildPoints(signal), [signal])
  if (!data) {
    return (
      <div className="sparkline-empty" aria-label="Price trajectory unavailable">
        <span>No price history yet</span>
      </div>
    )
  }
  const { points, min, max, isUp } = data
  const path = pointsToPath(points, width, height, min, max)
  const area = pointsToArea(points, width, height, min, max)
  return (
    <figure
      aria-label={`${signal.ticker} 120-day trajectory`}
      className={`sparkline ${isUp ? 'up' : 'down'}`}
    >
      <svg viewBox={`0 0 ${width} ${height + 8}`} role="img" preserveAspectRatio="none">
        <path className="sparkline-area" d={area} />
        <path className="sparkline-line" d={path} />
        {points.map((point, idx) => (
          <circle
            cx={(point.x / (points.length - 1)) * width}
            cy={projectY(point.y, height, min, max)}
            key={idx}
            r={idx === points.length - 1 ? 3 : 2}
          />
        ))}
      </svg>
      <figcaption>
        <span>120d trajectory</span>
        <strong>{formatCurrency(points[points.length - 1].price)}</strong>
      </figcaption>
    </figure>
  )
}

function buildPoints(signal: SparklineSignal) {
  const last = signal.lastPrice
  if (last == null || !Number.isFinite(last) || last <= 0) return null

  const change20 = num(signal.priceChange20d)
  const change60 = num(signal.priceChange60d)
  const change120 = num(signal.priceChange120d)

  const points: Point[] = []
  if (change120 !== null) {
    const price120 = last / (1 + change120 / 100)
    points.push({ x: 0, y: price120, label: '120d', price: price120 })
  }
  if (change60 !== null) {
    const price60 = last / (1 + change60 / 100)
    points.push({ x: points.length, y: price60, label: '60d', price: price60 })
  }
  if (change20 !== null) {
    const price20 = last / (1 + change20 / 100)
    points.push({ x: points.length, y: price20, label: '20d', price: price20 })
  }
  points.push({ x: points.length, y: last, label: 'today', price: last })

  if (points.length < 2) return null

  // Re-index x positions evenly across [0, n-1] for projection
  points.forEach((point, idx) => {
    point.x = idx
  })

  const ys = points.map((point) => point.y)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const isUp = points[points.length - 1].price >= points[0].price
  return { points, min, max, isUp }
}

function pointsToPath(
  points: Point[],
  width: number,
  height: number,
  min: number,
  max: number,
): string {
  const n = points.length - 1
  return points
    .map((point, idx) => {
      const x = (idx / n) * width
      const y = projectY(point.y, height, min, max)
      return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function pointsToArea(
  points: Point[],
  width: number,
  height: number,
  min: number,
  max: number,
): string {
  const n = points.length - 1
  const top = points
    .map((point, idx) => {
      const x = (idx / n) * width
      const y = projectY(point.y, height, min, max)
      return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
  return `${top} L ${width} ${height} L 0 ${height} Z`
}

function projectY(value: number, height: number, min: number, max: number) {
  if (max === min) return height / 2
  const ratio = (value - min) / (max - min)
  // Pad 4px so points don't sit on the chart edge.
  return height - 4 - ratio * (height - 8)
}

function num(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function formatCurrency(value: number) {
  if (value >= 1000) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}
