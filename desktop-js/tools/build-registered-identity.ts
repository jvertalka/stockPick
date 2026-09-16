/**
 * Builds tools/registered_identity.json: the pre-registered identity ledger
 * of the walk-forward run.
 *
 * For every name in DEFAULT_BACKTEST_TICKERS that the exclusion ledger does
 * not set aside, the file records WHICH COMPANY the name is: the SEC
 * registrant id (CIK) and name from the SEC's ticker map, looked up under
 * the symbol the name is fetched as, and the long name, short name and
 * first-trade date from the Yahoo chart's meta block. Funds get the Yahoo
 * names only. The runner (tools/backtest-cli.ts) compares every fetch
 * against this record at warm-up, so a symbol that Yahoo has since handed
 * to a different company (PARA, B on 2026-09-16) can no longer pass as the
 * registered one. The rules are in tools/preregistered-run.ts
 * (checkIdentity).
 *
 * This is meant to run ONCE, on the snapshot date, and the file is then
 * committed. Run it again only to refresh the record after a deliberate
 * review of every IDENTITY NOTE the runner printed, and say so in the
 * commit. One fetch of the SEC map and one Yahoo meta fetch per name
 * (about 1,300 requests) go through the local proxy on port 8787, which
 * caches both and adds the User-Agent the SEC requires; the pause between
 * names keeps the pace polite when the cache is cold.
 *
 * Build + run (from desktop-js/):
 *   npx esbuild tools/build-registered-identity.ts --bundle --platform=node \
 *     --format=esm --define:import.meta.env='{}' --outfile=tools/build-registered-identity.mjs
 *   node tools/build-registered-identity.mjs [--snapshot-date YYYY-MM-DD] [--out PATH] [--pause-ms N]
 */

// The browser modules use window.setTimeout/clearTimeout; in Node those
// live on globalThis with compatible signatures.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const { DEFAULT_BACKTEST_TICKERS } = await import('../src/data/historicalBacktest')
  const pre = await import('./preregistered-run')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { writeFileSync } = await import('node:fs')

  const args = process.argv.slice(2)
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
  const snapshotDate = flagValue('--snapshot-date') ?? pre.REGISTERED_IDENTITY_SNAPSHOT_DATE
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    console.error('--snapshot-date must be an ISO calendar date.')
    process.exit(2)
  }
  const outPath = resolve(flagValue('--out') ?? pre.registeredIdentityPath())
  const pauseMs = Number(flagValue('--pause-ms') ?? 100)
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

  const health = await pre.probeBackendHealth(base, { timeoutMs: 5000 })
  if (!health.ok) {
    console.error(`ABORTED: the backend on ${base} is not answering (${health.detail}).`)
    console.error('  Start it from the repository root with: dart run tool/backend_cache_server.dart --port 8787 --web-root build/web')
    process.exit(1)
  }
  console.log(`Backend: ${health.detail}`)

  // The fund flag comes from the Dart universe files when the repository is
  // present, otherwise from the two fund blocks in the default list.
  const dartDataDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'src', 'data')
  const etfs = pre.resolveEtfUniverse(dartDataDir)
  console.log(`ETF list: ${etfs.source} (${etfs.symbols.size} names${etfs.disagreements.length ? `; DISAGREE on ${etfs.disagreements.join(', ')}` : ''})`)

  const secMap = await pre.fetchSecTickerMap({ base })
  if (secMap == null) {
    console.error(`ABORTED: the SEC ticker map (${pre.SEC_COMPANY_TICKERS_URL}) could not be fetched through the proxy; nothing was written.`)
    process.exit(1)
  }
  console.log(`SEC ticker map: ${secMap.size} symbols`)

  const started = Date.now()
  const { ledger, disagreements, metaMissing } = await pre.buildRegisteredIdentityLedger({
    tickers: DEFAULT_BACKTEST_TICKERS,
    etfSymbols: etfs.symbols,
    secMap,
    snapshotDate,
    // Three attempts per name: the proxy's own timeout is eight seconds,
    // and a cold Yahoo answer can miss it once.
    fetchMeta: async (symbol) => {
      let meta: Awaited<ReturnType<typeof pre.fetchYahooChartMeta>> = null
      for (let attempt = 0; attempt < 3 && meta == null; attempt++) {
        if (attempt > 0) await sleep(1500)
        meta = await pre.fetchYahooChartMeta(symbol, { base })
      }
      if (pauseMs > 0) await sleep(pauseMs)
      return meta
    },
    onProgress: (done, total, ticker) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total} ${ticker}`)
    },
  })
  writeFileSync(outPath, pre.serializeRegisteredIdentityLedger(ledger))
  console.log('')
  console.log(`Wrote ${outPath}: ${ledger.counts.entries} entries (${ledger.counts.withCik} with a CIK, ${ledger.counts.withoutCik} without, of which ${ledger.counts.etfs} funds) · snapshot ${snapshotDate} · ${((Date.now() - started) / 1000).toFixed(0)}s`)
  if (metaMissing.length > 0) {
    console.log(`Yahoo meta missing for ${metaMissing.length} name${metaMissing.length === 1 ? '' : 's'} (entries written with null Yahoo fields; run again to fill them): ${metaMissing.join(', ')}`)
  }
  if (disagreements.length > 0) {
    console.log(`SEC name and Yahoo name share fewer than half their words for ${disagreements.length} name${disagreements.length === 1 ? '' : 's'}; a human should look at each:`)
    for (const entry of disagreements) console.log(`  ${entry.ticker}: SEC "${entry.secName}" vs Yahoo "${entry.yahooName}" (overlap ${(entry.overlap * 100).toFixed(0)}%)`)
  } else {
    console.log('SEC and Yahoo names agree (at least half their words in common) for every name with a CIK.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
