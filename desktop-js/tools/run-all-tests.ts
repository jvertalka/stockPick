/**
 * One deterministic entry point for every headless quantitative/evidence test.
 *
 * Browser modules use window timers; Node exposes compatible timers on
 * globalThis, so the alias keeps the production modules unchanged.
 */
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis

// A fixed xorshift32 stream removes the unseeded HAR/GBT fixture flake from
// release gates while leaving production randomness untouched.
let randomState = 0x6f726163
Math.random = () => {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return (randomState >>> 0) / 0x1_0000_0000
}

type TestResult = {
  name: string
  passed: boolean
  detail?: string
}

async function main() {
  const [
    { runQuantSelfTests },
    { runServingNormTests, runScorecardTests },
    { runMlVerdictTests },
    { runCalibrationTests },
    { runSelectionStatsTests },
    { runExitStudyTests },
    { runHistoricalBacktestQualityTests },
    { runExecutiveBriefEvidenceTests },
    { runMarketDataAdjustmentTests },
  ] = await Promise.all([
    import('../src/data/quantMath.tests'),
    import('../src/data/mlModelService.tests'),
    import('../src/data/mlVerdicts.tests'),
    import('../src/data/calibration.tests'),
    import('../src/data/selectionStats.tests'),
    import('../src/data/exitStudy.tests'),
    import('../src/data/historicalBacktestQuality.tests'),
    import('../src/components/ExecutiveBrief.evidence.tests'),
    import('../src/data/marketData.tests'),
  ])

  const suites: Array<[string, () => TestResult[] | Promise<TestResult[]>]> = [
    ['quant math', runQuantSelfTests],
    ['serving normalization', runServingNormTests],
    ['live scorecard', runScorecardTests],
    ['ML verdicts', runMlVerdictTests],
    ['calibration and sizing', runCalibrationTests],
    ['selection statistics', runSelectionStatsTests],
    ['exit study', runExitStudyTests],
    ['backtest data and promotion quality', runHistoricalBacktestQualityTests],
    ['Executive Brief evidence gate', runExecutiveBriefEvidenceTests],
    ['adjusted market data', runMarketDataAdjustmentTests],
  ]

  let total = 0
  const failed: Array<{ suite: string; result: TestResult }> = []
  for (const [suite, run] of suites) {
    const results = await run()
    total += results.length
    for (const result of results) {
      if (!result.passed) failed.push({ suite, result })
    }
    console.log(`${failed.some((entry) => entry.suite === suite) ? 'FAIL' : 'PASS'}  ${suite} (${results.length})`)
  }

  if (failed.length > 0) {
    for (const { suite, result } of failed) {
      console.error(`  ${suite}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
    }
    console.error(`\n${failed.length}/${total} evidence tests failed.`)
    process.exit(1)
  }

  console.log(`\nAll ${total} evidence tests passed.`)
}

void main()
