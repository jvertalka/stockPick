// Headless runner for the serve-time cross-sectional normalization tests.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis
async function main() {
  const { runServingNormTests } = await import('../src/data/mlModelService.tests')
  const results = runServingNormTests()
  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` — ${r.detail}`}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}
main()
