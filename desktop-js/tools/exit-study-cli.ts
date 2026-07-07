/**
 * Exit-rule event study CLI.
 *
 * Walks 15 years of weekly dates; for each date asks the STUDY backend
 * (port 8788, --warmup off) to rebuild raw signals as of that date through
 * the production signal builder, classifies them with the REAL JS
 * scoreUniverse rule engine, detects action transitions between consecutive
 * weeks, and event-studies the demeaned forward returns.
 *
 * Run:
 *   1. dart run tool/backend_cache_server.dart --port 8788 \
 *        --cache-dir <study-cache-dir> --warmup off
 *   2. npx esbuild tools/exit-study-cli.ts --bundle --platform=node \
 *        --format=esm --define:import.meta.env='{}' \
 *        --outfile=tools/exit-study-cli.mjs
 *   3. node tools/exit-study-cli.mjs [--limit 500] [--from 2011-01-01]
 *
 * HONESTY NOTES baked into every report:
 *  - Universe = TODAY'S symbol list applied to the past (survivorship: names
 *    that died are invisible, so exit value is likely UNDERSTATED — exits'
 *    best saves are exactly the names that later delisted).
 *  - Signals are price-only (fundamentals/revisions/options neutral), same
 *    as live uncovered names; the study measures the price-driven rules.
 *  - Returns are RELATIVE to the same-date cross-section; CIs are cluster-
 *    bootstrapped over dates.
 */
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

import { writeFileSync } from 'node:fs'

const STUDY_URL = process.env.ORACLE_STUDY_URL ?? 'http://127.0.0.1:8788'
const STEP_TRADING_DAYS = 5
const HORIZONS_IN_STEPS = [1, 4, 12] // ≈ 5d / 20d / 60d
const MIN_NAMES_PER_DATE = 40

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

async function fetchJson<T>(url: string, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** SPY trading-day calendar from the same 16y window the backend uses. */
async function tradingCalendar(): Promise<string[]> {
  const period2 = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400
  const period1 = period2 - Math.round(16 * 365.25 * 86_400)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div%2Csplits`
  const payload = await fetchJson<{
    chart?: { result?: Array<{ timestamp?: number[] }> }
  }>(`${STUDY_URL}/proxy?url=${encodeURIComponent(url)}`)
  const ts = payload.chart?.result?.[0]?.timestamp ?? []
  return ts.map((t) => new Date(t * 1000).toISOString().slice(0, 10))
}

type RawSignalWire = { ticker: string; lastPrice: number } & Record<string, unknown>

async function main() {
  const { detectEvents, groupStats, pairMatrix } = await import('../src/data/exitStudy')
  type StudyDateT = import('../src/data/exitStudy').StudyDate
  type StudyActionT = import('../src/data/exitStudy').StudyAction
  const { scoreUniverse } = await import('../src/data/decisionEngine')

  const limit = Number(arg('--limit', '500'))
  const fromDate = arg('--from', '2011-01-01')
  const outPath = arg('--out', 'tools/exit_study_results.json')
  // 'pit' = point-in-time SEC fundamentals (filings as FILED by each date;
  // unlocks the engine's bullish actions historically). 'off' = price-only.
  const fundamentalsMode = arg('--fundamentals', 'pit')
  const fundamentalsQuery = fundamentalsMode === 'pit' ? '&fundamentals=pit' : ''

  console.log(
    `Exit-rule event study — universe limit ${limit}, from ${fromDate}, fundamentals: ${fundamentalsMode}`,
  )
  console.log(`Study backend: ${STUDY_URL} (must run with --warmup off)\n`)

  const calendar = await tradingCalendar()
  const startIdx = calendar.findIndex((d) => d >= fromDate)
  if (startIdx < 0) throw new Error(`No trading days on/after ${fromDate}`)
  const sampleIdxs: number[] = []
  for (let i = startIdx; i < calendar.length; i += STEP_TRADING_DAYS) sampleIdxs.push(i)
  // Trim the tail so the longest horizon has data.
  const maxSteps = Math.max(...HORIZONS_IN_STEPS)
  const usableSamples = sampleIdxs.length - maxSteps
  console.log(
    `Calendar: ${calendar.length} trading days; sampling every ${STEP_TRADING_DAYS} -> ` +
      `${sampleIdxs.length} dates (${calendar[sampleIdxs[0]]} .. ${calendar[sampleIdxs[sampleIdxs.length - 1]]})`,
  )

  const dates: StudyDateT[] = []
  let skippedThin = 0
  let coverageSum = 0
  const t0 = Date.now()
  for (let s = 0; s < sampleIdxs.length; s++) {
    const date = calendar[sampleIdxs[s]]
    const payload = await fetchJson<{
      returned: number
      fundamentalsCoverage?: number
      rawSignals?: RawSignalWire[]
    }>(
      `${STUDY_URL}/decision/universe?asOf=${date}&limit=${limit}${fundamentalsQuery}`,
      600_000, // first PIT call fetches ~500 SEC filings; be patient
    )
    const raw = payload.rawSignals ?? []
    coverageSum += payload.fundamentalsCoverage ?? 0
    if (raw.length < MIN_NAMES_PER_DATE) {
      skippedThin++
      continue
    }
    const priceByTicker = new Map(raw.map((r) => [r.ticker, r.lastPrice]))
    const scored = scoreUniverse(raw as never, 'base')
    const byTicker = new Map<string, { ticker: string; action: StudyActionT; lastPrice: number }>()
    for (const s2 of scored) {
      const lastPrice = priceByTicker.get(s2.ticker)
      if (lastPrice == null || !(lastPrice > 0)) continue
      byTicker.set(s2.ticker, {
        ticker: s2.ticker,
        action: s2.action as StudyActionT,
        lastPrice,
      })
    }
    dates.push({ date, byTicker })
    if ((s + 1) % 50 === 0 || s === sampleIdxs.length - 1) {
      const rate = (s + 1) / ((Date.now() - t0) / 1000)
      console.log(
        `  ${s + 1}/${sampleIdxs.length} dates (${date}, ${byTicker.size} names, ${rate.toFixed(1)}/s)`,
      )
    }
  }
  console.log(`\nSampled ${dates.length} usable dates (${skippedThin} skipped as too thin).`)
  if (fundamentalsMode === 'pit') {
    console.log(
      `Point-in-time fundamentals coverage: ${(coverageSum / Math.max(1, dates.length)).toFixed(0)} names/date average.`,
    )
  }
  if (dates.length < 60) throw new Error('Too few usable dates for a meaningful study.')

  const events = detectEvents(dates, HORIZONS_IN_STEPS)
  const kinds = ['exit', 'soften', 'entry', 'warn', 'stay-bullish', 'stay-neutral', 'stay-bearish'] as const

  console.log(`Total evaluable (ticker, week) rows: ${events.length}\n`)
  console.log('Relative forward returns by transition kind (demeaned vs same-date cross-section):')
  console.log('kind           horizon      n   dates    mean     median   95% CI (cluster bootstrap)')
  console.log('-------------  -------  -----  ------  -------  -------  --------------------------')
  const statsOut: Record<string, unknown>[] = []
  for (const kind of kinds) {
    for (const h of HORIZONS_IN_STEPS) {
      const s = groupStats(events, kind, h)
      statsOut.push(s as unknown as Record<string, unknown>)
      const label = h === 1 ? '~5d' : h === 4 ? '~20d' : '~60d'
      const fmt = (v: number | null) => (v == null ? '      –' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`.padStart(7))
      const ci = s.ci95 ? `[${s.ci95[0] >= 0 ? '+' : ''}${s.ci95[0].toFixed(2)}, ${s.ci95[1] >= 0 ? '+' : ''}${s.ci95[1].toFixed(2)}]` : '–'
      console.log(
        `${kind.padEnd(13)}  ${label.padEnd(7)}  ${String(s.n).padStart(5)}  ${String(s.dates).padStart(6)}  ${fmt(s.meanRelPct)}  ${fmt(s.medianRelPct)}  ${ci}`,
      )
    }
    console.log('')
  }

  // The decision-relevant contrast: names the engine FLIPPED OUT of vs names
  // it KEPT bullish, same dates. Negative delta = exits added timing value.
  const exit20 = groupStats(events, 'exit', 4)
  const stay20 = groupStats(events, 'stay-bullish', 4)
  const exit60 = groupStats(events, 'exit', 12)
  const stay60 = groupStats(events, 'stay-bullish', 12)
  const d20 = exit20.meanRelPct != null && stay20.meanRelPct != null ? exit20.meanRelPct - stay20.meanRelPct : null
  const d60 = exit60.meanRelPct != null && stay60.meanRelPct != null ? exit60.meanRelPct - stay60.meanRelPct : null
  console.log('EXIT VALUE (flipped-out minus kept-bullish, same dates):')
  console.log(`  ~20d: ${d20 == null ? '–' : `${d20 >= 0 ? '+' : ''}${d20.toFixed(2)}pp`}   ~60d: ${d60 == null ? '–' : `${d60 >= 0 ? '+' : ''}${d60.toFixed(2)}pp`}`)
  console.log('  (negative = the names it told you to exit went on to do WORSE than the ones it kept — good exits)\n')

  const pairs = pairMatrix(events, 4).slice(0, 14)
  console.log('Most common exact flips (≈20d relative return after the flip):')
  for (const p of pairs) {
    console.log(`  ${`${p.from} → ${p.to}`.padEnd(24)} n=${String(p.n).padStart(5)}  mean ${p.meanRelPct >= 0 ? '+' : ''}${p.meanRelPct.toFixed(2)}%`)
  }

  console.log('\nCAVEATS (read before trusting):')
  console.log("  - Universe is TODAY'S list applied to the past: delisted names are invisible,")
  console.log('    so exit value is likely UNDERSTATED (the best saves are the deaths we cannot see).')
  console.log('  - Signals are price-only (fundamentals/revisions/options neutral) — the same')
  console.log('    footing as live names without EDGAR coverage.')
  console.log('  - Weekly sampling: a flip is seen up to 4 trading days late.')
  console.log('  - No trading costs; this measures signal timing, not strategy P&L.')

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        params: { limit, fromDate, fundamentalsMode, stepTradingDays: STEP_TRADING_DAYS, horizonsInSteps: HORIZONS_IN_STEPS, minNamesPerDate: MIN_NAMES_PER_DATE },
        meanFundamentalsCoverage: coverageSum / Math.max(1, dates.length),
        datesSampled: dates.length,
        firstDate: dates[0]?.date,
        lastDate: dates[dates.length - 1]?.date,
        totalEventRows: events.length,
        stats: statsOut,
        exitValue: { d20pp: d20, d60pp: d60 },
        pairs,
        usableSamplesPlanned: usableSamples,
      },
      null,
      2,
    ),
  )
  console.log(`\nWrote ${outPath}`)
  process.exit(0)
}

main().catch((error) => {
  console.error('exit-study failed:', error)
  process.exit(1)
})
