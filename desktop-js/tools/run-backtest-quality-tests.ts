// Headless runner for dataset provenance and model-promotion tests.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

async function main() {
  const { runHistoricalBacktestQualityTests } = await import(
    '../src/data/historicalBacktestQuality.tests'
  )
  const results = runHistoricalBacktestQualityTests()
  const failed = results.filter((result) => !result.passed)
  for (const result of results) {
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'}  ${result.name}` +
        (result.passed ? '' : ` - ${result.detail ?? 'no detail'}`),
    )
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
