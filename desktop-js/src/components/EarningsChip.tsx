import { useEffect, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { cachedFetchEarnings, type EarningsEstimate } from '../data/marketData'

/**
 * Small "EARN: 5/14" chip. Highlights amber when earnings is within the
 * next 5 trading days so users don't initiate positions that gap through
 * earnings overnight.
 *
 * If Yahoo doesn't return a date the chip hides itself entirely rather
 * than showing "unknown" noise.
 */

export function EarningsChip({ ticker, compact = false }: { ticker: string; compact?: boolean }) {
  const [estimate, setEstimate] = useState<EarningsEstimate | null>(null)

  useEffect(() => {
    let cancelled = false
    cachedFetchEarnings(ticker)
      .then((value) => {
        if (!cancelled) setEstimate(value)
      })
      .catch(() => {
        if (!cancelled) setEstimate({ ticker, source: 'none' })
      })
    return () => {
      cancelled = true
    }
  }, [ticker])

  if (!estimate || estimate.source === 'none' || !estimate.nextEarningsDate) return null
  const days = estimate.daysUntil ?? 0
  const tone = days <= 5 && days >= 0 ? 'caution' : days < 0 ? 'neutral' : 'neutral'
  const label = days < 0 ? `EARN ${formatShortDate(estimate.nextEarningsDate)}` : `EARN ${formatShortDate(estimate.nextEarningsDate)} (${days}d)`
  return (
    <span
      aria-label={`Next earnings ${estimate.nextEarningsDate}`}
      className={`earnings-chip ${tone}${compact ? ' compact' : ''}`}
      title={
        days < 0
          ? `Last earnings ${estimate.nextEarningsDate}`
          : `Next earnings ${estimate.nextEarningsDate} - ${days} day${days === 1 ? '' : 's'} away`
      }
    >
      <CalendarDays size={11} />
      {compact ? `${days < 0 ? '~' : ''}${Math.abs(days)}d` : label}
    </span>
  )
}

function formatShortDate(iso: string) {
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()}`
}
