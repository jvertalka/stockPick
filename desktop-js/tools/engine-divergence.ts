/**
 * Engine-divergence audit (Tier-2 #1). Feeds the SAME raw signals from the
 * running backend through the JS scoreUniverse engine and compares its action
 * classification to the backend's own _classifyAction (payload.actionCounts +
 * per-ticker if present). Quantifies how often the two engines that both feed
 * the desktop disagree on the same stock, before any consolidation refactor.
 */
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const { scoreUniverse } = await import('../src/data/decisionEngine')
  const res = await fetch('http://127.0.0.1:8787/decision/universe?limit=3000')
  const payload = (await res.json()) as {
    rawSignals?: Array<Record<string, unknown>>
    actionCounts?: Record<string, number>
  }
  const rawSignals = payload.rawSignals ?? []
  const backendCounts = payload.actionCounts ?? {}
  if (rawSignals.length === 0) {
    console.log('No rawSignals (backend still warming).')
    process.exit(1)
  }
  const keys = Object.keys(rawSignals[0]).sort()
  const perTickerBackendAction = keys.includes('action')

  const scored = scoreUniverse(rawSignals as never, 'base')
  const jsCounts: Record<string, number> = {}
  for (const s of scored) jsCounts[s.action] = (jsCounts[s.action] ?? 0) + 1

  const order = ['Buy Now', 'Accumulate', 'Hold', 'Watch', 'Trim', 'Sell', 'Avoid']
  const norm = (a: string) => a
  console.log(`N = ${rawSignals.length} signals\n`)
  console.log('action        backend    JS(scoreUniverse)')
  console.log('------------  --------   -----------------')
  const allActions = [...new Set([...Object.keys(backendCounts), ...Object.keys(jsCounts), ...order])]
    .filter((a, i, arr) => arr.indexOf(a) === i)
    .sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0 ? 1 : 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0 ? 1 : 0)))
  for (const a of allActions) {
    console.log(`${a.padEnd(12)}  ${String(backendCounts[a] ?? 0).padStart(6)}   ${String(jsCounts[a] ?? 0).padStart(6)}`)
  }
  // Bullish share (Buy Now + Accumulate) per engine — the number a user acts on.
  const bull = (c: Record<string, number>) => (c['Buy Now'] ?? 0) + (c['Accumulate'] ?? 0)
  console.log(
    `\nBullish (Buy Now+Accumulate): backend ${bull(backendCounts)}  vs  JS ${bull(jsCounts)}` +
      `  (${((bull(jsCounts) - bull(backendCounts)) / rawSignals.length * 100).toFixed(1)}pp of the universe differ on "is this a buy")`,
  )

  // Per-ticker confusion, only if the backend embeds a per-ticker action.
  if (perTickerBackendAction) {
    const jsByTicker = new Map(scored.map((s) => [s.ticker, s.action]))
    let agree = 0
    let total = 0
    let bullVsNot = 0
    for (const r of rawSignals) {
      const be = norm(String(r['action']))
      const js = jsByTicker.get(r['ticker'] as string)
      if (!js) continue
      total++
      if (be === js) agree++
      const beBull = be === 'Buy Now' || be === 'Accumulate'
      const jsBull = js === 'Buy Now' || js === 'Accumulate'
      if (beBull !== jsBull) bullVsNot++
    }
    console.log(
      `\nPer-ticker: exact-action agreement ${agree}/${total} (${((agree / total) * 100).toFixed(0)}%);` +
        ` buy-vs-not disagreement on ${bullVsNot}/${total} (${((bullVsNot / total) * 100).toFixed(0)}%).`,
    )
  } else {
    console.log('\n(Backend does not embed a per-ticker action in rawSignals — comparison is distribution-level.)')
  }
  process.exit(0)
}
main()
