// Headless runner for the calibration + sizing tests.
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis
async function main() {
  const { runCalibrationTests } = await import('../src/data/calibration.tests')
  const results = runCalibrationTests()
  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` — ${r.detail ?? ''}`}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}
main()
