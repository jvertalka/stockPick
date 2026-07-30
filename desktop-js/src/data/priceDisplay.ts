import type { DailyBar } from './marketData'

/** Spot shows the observable exchange price. The historical range stays on
 * the adjusted/current-share basis so a split cannot create a fake price
 * range; it also remains consistent with the chart's adjusted reference lines. */
export function priceChartCurrencyDisplay(bars: readonly DailyBar[]) {
  const latest = bars[bars.length - 1]
  const latestRaw = latest?.rawClose
  const adjustedCloses = bars.map((bar) => bar.close)
  return {
    lastClose:
      latestRaw != null && Number.isFinite(latestRaw) && latestRaw > 0
        ? latestRaw
        : latest?.close ?? null,
    high60: adjustedCloses.length > 0 ? Math.max(...adjustedCloses.slice(-60)) : null,
    low60: adjustedCloses.length > 0 ? Math.min(...adjustedCloses.slice(-60)) : null,
  }
}
