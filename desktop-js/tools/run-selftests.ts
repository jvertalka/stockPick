// Headless runner for the quantMath self-tests (browser console normally).
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis
async function main() {
  const { runQuantSelfTests } = await import('../src/data/quantMath.tests')
  const results = runQuantSelfTests()
  const failed = results.filter((r) => !r.passed)
  for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` — ${r.detail}`}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
main()
