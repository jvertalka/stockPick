/**
 * Tests for applyMlLedVerdicts — the function that decides which labels
 * reach the screen. Hand-built fixtures, hand-computed percentile cuts.
 */
import { applyMlLedVerdicts, type Action, type DecisionSignal } from './decisionEngine'

type TestResult = { name: string; passed: boolean; detail?: string }

function mkSignal(ticker: string, action: Action, overrides: Partial<DecisionSignal> = {}): DecisionSignal {
  return {
    ticker,
    name: ticker,
    assetType: 'Stock',
    sector: 'Tech',
    industry: 'Software',
    style: 'Large growth',
    trend20: 50, trend60: 50, trend120: 50,
    relativeStrength: 50, residualStrength: 50,
    revisionTrend: 50, surpriseMomentum: 50,
    marginTrend: 50, revenueAcceleration: 50, freeCashFlowTrend: 50,
    quality: 50, valuationSupport: 50, liquidity: 50, breadth: 50,
    impliedVolRank: 50, realizedVol: 50, skewRisk: 50, eventRisk: 50,
    crowding: 50, drawdownRisk: 50, creditSensitivity: 50, rateSensitivity: 50,
    growthSensitivity: 50, defensiveScore: 50,
    dataConfidence: 85,
    fundamentalsSource: 'sec-edgar-xbrl',
    action,
    opportunityScore: 50, confidence: 50, riskScore: 50, fragilityScore: 50,
    regimeFit: 50, asymmetryScore: 50, thesisDamage: 20,
    forecast20d: 0, probabilityOutperform: 50, probabilityDrawdown: 20,
    signalStability: 50, actionRank: 3, positionPlan: 'plan', evidence: [],
    riskFlags: [], invalidation: [], nextCheck: 'check',
    momentumZ: 0, qualityZ: 0, valueZ: 0, lowVolZ: 0, growthZ: 0, fragilityZ: 0,
    compositeAlphaZ: 0, alphaPercentile: 50, detectedRegime: 'calm',
    factorAgreement: 50, quantConfirmed: false,
    ...overrides,
  }
}

/** 40 predictions T00..T39 with value = index → percentile = i/39*100. */
function fortyPredictions(): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < 40; i++) out.set(`T${String(i).padStart(2, '0')}`, i)
  return out
}

export function runMlVerdictTests(): TestResult[] {
  const results: TestResult[] = []
  const preds = fortyPredictions()

  // V1 — top of the batch + decision-grade evidence → Buy Now via 'ml'.
  {
    const rows = [mkSignal('T39', 'Hold')]
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Buy Now' && out.verdictSource === 'ml'
    results.push({ name: 'V1: top rank + decision-grade → Buy Now (ml)', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  // V2 — top rank but NO real fundamentals → held at Hold via 'ml-veto'.
  {
    const rows = [mkSignal('T39', 'Hold', { fundamentalsSource: undefined })]
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Hold' && out.verdictSource === 'ml-veto'
    results.push({ name: 'V2: top rank, no fundamentals → Hold (ml-veto)', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  // V3 — rules bearish is kept verbatim even when ML loves the name.
  {
    const rows = [mkSignal('T39', 'Sell')]
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Sell' && out.verdictSource === 'rules-exit'
    results.push({ name: 'V3: rules Sell survives ML enthusiasm (rules-exit)', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  // V4 — rules-green with NO ML coverage is demoted to Hold.
  {
    const rows = [mkSignal('UNCOVERED', 'Buy Now')]
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Hold' && out.verdictSource === 'demoted-no-ml'
    results.push({ name: 'V4: rules green without ML → Hold (demoted-no-ml)', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  // V5 — regime gate closed: greens demoted, no promotions, exits kept.
  {
    const rows = [mkSignal('T39', 'Accumulate'), mkSignal('T38', 'Trim'), mkSignal('T37', 'Hold')]
    const out = applyMlLedVerdicts(rows, preds, { regimeGated: true })
    const ok =
      out[0].action === 'Hold' && out[0].verdictSource === 'demoted-gated' &&
      out[1].action === 'Trim' && out[1].verdictSource === 'rules-exit' &&
      out[2].action === 'Hold' && out[2].verdictSource === 'rules'
    results.push({ name: 'V5: regime gate demotes greens, keeps exits', passed: ok, detail: out.map((o) => `${o.ticker}:${o.action}/${o.verdictSource}`).join(' ') })
  }

  // V6 — bottom decile → Avoid; bottom quartile → Trim (both 'ml').
  {
    const rows = [mkSignal('T00', 'Hold'), mkSignal('T08', 'Hold')]
    const out = applyMlLedVerdicts(rows, preds)
    // T00 pct 0 (≤10) → Avoid; T08 pct 8/39*100 = 20.5 (≤25) → Trim
    const ok =
      out[0].action === 'Avoid' && out[0].verdictSource === 'ml' &&
      out[1].action === 'Trim' && out[1].verdictSource === 'ml'
    results.push({ name: 'V6: ML bottom decile → Avoid, bottom quartile → Trim', passed: ok, detail: out.map((o) => `${o.ticker}:${o.action}`).join(' ') })
  }

  // V7 — below the 25-name breadth floor, ML ranks are ignored: greens
  // demote as uncovered rather than promote on a noisy percentile.
  {
    const thin = new Map<string, number>([['A', 1], ['B', 2], ['C', 3]])
    const rows = [mkSignal('C', 'Buy Now'), mkSignal('B', 'Hold')]
    const out = applyMlLedVerdicts(rows, thin)
    const ok =
      out[0].action === 'Hold' && out[0].verdictSource === 'demoted-no-ml' &&
      out[1].action === 'Hold' && out[1].verdictSource === 'rules'
    results.push({ name: 'V7: breadth floor — thin batches promote nothing', passed: ok, detail: out.map((o) => `${o.ticker}:${o.action}/${o.verdictSource}`).join(' ') })
  }

  // V8 — risk veto: top rank + hot risk score stays at Hold.
  {
    const rows = [mkSignal('T39', 'Hold', { riskScore: 85 })]
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Hold' && out.verdictSource === 'ml-veto'
    results.push({ name: 'V8: risk veto blocks promotion (ml-veto)', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  // V9 — a changed action regenerates plan, check, and rank.
  {
    const row = mkSignal('T39', 'Hold', { positionPlan: 'OLD PLAN', nextCheck: 'OLD CHECK', actionRank: 3 })
    const out = applyMlLedVerdicts([row], preds)[0]
    const ok =
      out.action === 'Buy Now' &&
      out.actionRank === 1 &&
      out.positionPlan !== 'OLD PLAN' &&
      out.nextCheck !== 'OLD CHECK'
    results.push({ name: 'V9: relabel regenerates plan/check/rank', passed: ok, detail: `rank=${out.actionRank} plan=${out.positionPlan.slice(0, 24)}` })
  }

  // V10 — mid-rank confidence tier: pct in [67,80) with price-backed
  // confidence (60-79) still earns Accumulate, but not Buy Now.
  {
    const rows = [mkSignal('T28', 'Hold', { dataConfidence: 65 })] // pct = 28/39*100 = 71.8
    const out = applyMlLedVerdicts(rows, preds)[0]
    const ok = out.action === 'Accumulate' && out.verdictSource === 'ml'
    results.push({ name: 'V10: top tercile + price-backed evidence → Accumulate', passed: ok, detail: `${out.action}/${out.verdictSource}` })
  }

  return results
}
