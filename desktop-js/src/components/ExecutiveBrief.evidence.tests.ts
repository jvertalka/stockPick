import {
  assessBriefBuyEvidence,
  type BriefBuyEvidencePrediction,
  type BriefBuyEvidenceSignal,
} from './ExecutiveBrief'

type TestResult = { name: string; passed: boolean; detail?: string }

const signal: BriefBuyEvidenceSignal = {
  dataConfidence: 88,
  dataSource: 'yahoo-ohlcv+edgar',
  dataWarnings: [
    'Estimate-revision fields remain neutral: no analyst feed is connected.',
  ],
  fundamentalsAsOf: '2026-06-30',
  fundamentalsSource: 'sec-edgar-xbrl',
  priceAsOf: '2026-07-09T00:00:00.000Z',
  priceBasis: 'adjusted-total-return',
  verdictSource: 'ml',
}

const prediction: BriefBuyEvidencePrediction = {
  asOf: '2026-07-09',
  predictedReturn20d: 2.4,
  p10Return20d: 0.3,
  p90Return20d: 5.8,
  normalizationMode: 'cross-sectional-live',
}

function caseResult(
  name: string,
  expected: boolean,
  candidateSignal: BriefBuyEvidenceSignal,
  candidatePrediction: BriefBuyEvidencePrediction | null,
  scenario: 'base' | 'volJump' = 'base',
  blocker?: RegExp,
): TestResult {
  const result = assessBriefBuyEvidence(candidateSignal, candidatePrediction, scenario)
  const blockerMatches = blocker == null || result.blockers.some((item) => blocker.test(item))
  const passed = result.decisionGrade === expected && blockerMatches
  return {
    name,
    passed,
    detail: passed
      ? undefined
      : `grade=${result.decisionGrade}; blockers=${result.blockers.join(' | ')}`,
  }
}

export function runExecutiveBriefEvidenceTests(): TestResult[] {
  return [
    caseResult('B1: synchronized decision-grade evidence passes', true, signal, prediction),
    caseResult(
      'B2: lower data-confidence tier stays advisory',
      false,
      { ...signal, dataConfidence: 79 },
      prediction,
      'base',
      /data confidence/,
    ),
    caseResult(
      'B3: missing SEC evidence stays advisory',
      false,
      { ...signal, fundamentalsAsOf: null, fundamentalsSource: undefined },
      prediction,
      'base',
      /SEC XBRL/,
    ),
    caseResult(
      'B3a: SEC provenance without a filing date stays advisory',
      false,
      { ...signal, fundamentalsAsOf: null },
      prediction,
      'base',
      /filing as-of date/,
    ),
    caseResult(
      'B3b: missing price date stays advisory',
      false,
      { ...signal, priceAsOf: null },
      prediction,
      'base',
      /price as-of date/,
    ),
    caseResult(
      'B3c: a legacy rules verdict cannot become an unqualified buy',
      false,
      { ...signal, verdictSource: 'rules' },
      prediction,
      'base',
      /not ML-led/,
    ),
    caseResult(
      'B3d: unproven price basis stays advisory',
      false,
      { ...signal, priceBasis: 'unadjusted-or-unavailable' },
      prediction,
      'base',
      /adjusted-total-return/,
    ),
    caseResult(
      'B4: backend staleness warning blocks an action',
      false,
      { ...signal, dataWarnings: ['Latest daily bar is stale for a live decision.'] },
      prediction,
      'base',
      /stale data/,
    ),
    caseResult(
      'B5: missing live ML forecast stays advisory',
      false,
      signal,
      null,
      'base',
      /forecast is unavailable/,
    ),
    caseResult(
      'B6: forecast and price dates must match exactly',
      false,
      signal,
      { ...prediction, asOf: '2026-07-08' },
      'base',
      /does not match/,
    ),
    caseResult(
      'B7: unavailable interval stays advisory',
      false,
      signal,
      { ...prediction, p10Return20d: undefined, p90Return20d: undefined },
      'base',
      /interval is unavailable/,
    ),
    caseResult(
      'B8: interval crossing zero stays advisory',
      false,
      signal,
      { ...prediction, p10Return20d: -0.2 },
      'base',
      /includes no peer outperformance/,
    ),
    caseResult(
      'B9: malformed interval stays advisory',
      false,
      signal,
      { ...prediction, p10Return20d: 3, p90Return20d: 2 },
      'base',
      /malformed/,
    ),
    caseResult(
      'B10: hypothetical scenario never enters the live action list',
      false,
      signal,
      prediction,
      'volJump',
      /hypothetical scenario/,
    ),
    caseResult(
      'B11: frozen-normalization fallback remains advisory',
      false,
      signal,
      { ...prediction, normalizationMode: 'frozen-fallback' },
      'base',
      /frozen-normalization/,
    ),
  ]
}
