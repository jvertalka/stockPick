export type Action = 'Buy Now' | 'Accumulate' | 'Hold' | 'Trim' | 'Sell' | 'Avoid'
export type Tone = 'positive' | 'neutral' | 'caution' | 'danger'
export type AssetType = 'Stock' | 'ETF'
export type ScenarioId = 'base' | 'volJump' | 'creditStress' | 'growthBreak' | 'ratesFall'
export type SortKey = 'action' | 'opportunity' | 'confidence' | 'risk' | 'regimeFit'

export type MarketContext = {
  regime: string
  confidence: number
  riskLevel: string
  riskScore: number
  breadth: number
  volatilityPressure: number
  creditStress: number
  leadership: string
  liquidity: string
  updatedAt: string
}

export type RawSignal = {
  ticker: string
  name: string
  assetType: AssetType
  sector: string
  industry: string
  style: string
  trend20: number
  trend60: number
  trend120: number
  relativeStrength: number
  residualStrength: number
  revisionTrend: number
  surpriseMomentum: number
  marginTrend: number
  revenueAcceleration: number
  freeCashFlowTrend: number
  quality: number
  valuationSupport: number
  liquidity: number
  breadth: number
  impliedVolRank: number
  realizedVol: number
  skewRisk: number
  eventRisk: number
  crowding: number
  drawdownRisk: number
  creditSensitivity: number
  rateSensitivity: number
  growthSensitivity: number
  defensiveScore: number
}

export type DecisionSignal = RawSignal & {
  action: Action
  opportunityScore: number
  confidence: number
  riskScore: number
  fragilityScore: number
  regimeFit: number
  asymmetryScore: number
  thesisDamage: number
  forecast20d: number
  probabilityOutperform: number
  probabilityDrawdown: number
  signalStability: number
  actionRank: number
  positionPlan: string
  evidence: string[]
  riskFlags: string[]
  invalidation: string[]
  nextCheck: string
}

export type Scenario = {
  id: ScenarioId
  label: string
  shock: string
  interpretation: string
}

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value))

export const marketContext: MarketContext = {
  regime: 'Growth favorable, risk aware',
  confidence: 76,
  riskLevel: 'Moderate',
  riskScore: 57,
  breadth: 64,
  volatilityPressure: 61,
  creditStress: 38,
  leadership: 'AI infrastructure, quality software, selective healthcare',
  liquidity: 'Stable but narrower than ideal',
  updatedAt: 'Local decision layer',
}

export const scenarios: Scenario[] = [
  {
    id: 'base',
    label: 'Base regime',
    shock: 'Current conditions',
    interpretation: 'Growth leadership remains intact, but risk controls stay active.',
  },
  {
    id: 'volJump',
    label: 'Volatility +20%',
    shock: 'Options risk reprices higher',
    interpretation: 'High beta and crowded leadership lose score. Quality and ETFs hold up better.',
  },
  {
    id: 'creditStress',
    label: 'Credit spreads widen',
    shock: 'Credit conditions deteriorate',
    interpretation: 'Financials, cyclicals, and leveraged stories lose regime support.',
  },
  {
    id: 'growthBreak',
    label: 'Growth leadership breaks',
    shock: 'Momentum leadership rotates away',
    interpretation: 'AI, software, and speculative growth get penalized. Defensive exposure improves.',
  },
  {
    id: 'ratesFall',
    label: 'Rates fall quickly',
    shock: 'Duration tailwind',
    interpretation: 'Durable growth and quality bonds improve, but weak cyclicals still need proof.',
  },
]

export const rawSignals: RawSignal[] = [
  {
    ticker: 'NVDA',
    name: 'NVIDIA',
    assetType: 'Stock',
    sector: 'Technology',
    industry: 'Semiconductors',
    style: 'Mega-cap growth',
    trend20: 82,
    trend60: 91,
    trend120: 94,
    relativeStrength: 95,
    residualStrength: 91,
    revisionTrend: 90,
    surpriseMomentum: 86,
    marginTrend: 88,
    revenueAcceleration: 92,
    freeCashFlowTrend: 84,
    quality: 88,
    valuationSupport: 42,
    liquidity: 98,
    breadth: 82,
    impliedVolRank: 72,
    realizedVol: 66,
    skewRisk: 64,
    eventRisk: 58,
    crowding: 78,
    drawdownRisk: 62,
    creditSensitivity: 18,
    rateSensitivity: 42,
    growthSensitivity: 91,
    defensiveScore: 20,
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft',
    assetType: 'Stock',
    sector: 'Technology',
    industry: 'Software',
    style: 'Quality growth',
    trend20: 73,
    trend60: 81,
    trend120: 86,
    relativeStrength: 82,
    residualStrength: 78,
    revisionTrend: 82,
    surpriseMomentum: 75,
    marginTrend: 84,
    revenueAcceleration: 74,
    freeCashFlowTrend: 90,
    quality: 94,
    valuationSupport: 55,
    liquidity: 98,
    breadth: 76,
    impliedVolRank: 43,
    realizedVol: 34,
    skewRisk: 36,
    eventRisk: 44,
    crowding: 61,
    drawdownRisk: 35,
    creditSensitivity: 16,
    rateSensitivity: 37,
    growthSensitivity: 78,
    defensiveScore: 44,
  },
  {
    ticker: 'AVGO',
    name: 'Broadcom',
    assetType: 'Stock',
    sector: 'Technology',
    industry: 'Semiconductors',
    style: 'Quality growth',
    trend20: 78,
    trend60: 85,
    trend120: 87,
    relativeStrength: 88,
    residualStrength: 84,
    revisionTrend: 78,
    surpriseMomentum: 72,
    marginTrend: 81,
    revenueAcceleration: 76,
    freeCashFlowTrend: 86,
    quality: 86,
    valuationSupport: 52,
    liquidity: 91,
    breadth: 80,
    impliedVolRank: 58,
    realizedVol: 52,
    skewRisk: 50,
    eventRisk: 46,
    crowding: 65,
    drawdownRisk: 49,
    creditSensitivity: 25,
    rateSensitivity: 39,
    growthSensitivity: 82,
    defensiveScore: 28,
  },
  {
    ticker: 'LLY',
    name: 'Eli Lilly',
    assetType: 'Stock',
    sector: 'Healthcare',
    industry: 'Pharmaceuticals',
    style: 'Defensive growth',
    trend20: 67,
    trend60: 76,
    trend120: 82,
    relativeStrength: 74,
    residualStrength: 72,
    revisionTrend: 76,
    surpriseMomentum: 70,
    marginTrend: 79,
    revenueAcceleration: 80,
    freeCashFlowTrend: 68,
    quality: 83,
    valuationSupport: 45,
    liquidity: 89,
    breadth: 69,
    impliedVolRank: 49,
    realizedVol: 42,
    skewRisk: 41,
    eventRisk: 52,
    crowding: 58,
    drawdownRisk: 44,
    creditSensitivity: 12,
    rateSensitivity: 30,
    growthSensitivity: 61,
    defensiveScore: 75,
  },
  {
    ticker: 'COST',
    name: 'Costco',
    assetType: 'Stock',
    sector: 'Consumer Staples',
    industry: 'Retail',
    style: 'Quality defensive',
    trend20: 65,
    trend60: 72,
    trend120: 79,
    relativeStrength: 71,
    residualStrength: 68,
    revisionTrend: 69,
    surpriseMomentum: 66,
    marginTrend: 70,
    revenueAcceleration: 63,
    freeCashFlowTrend: 74,
    quality: 91,
    valuationSupport: 38,
    liquidity: 84,
    breadth: 67,
    impliedVolRank: 34,
    realizedVol: 29,
    skewRisk: 32,
    eventRisk: 36,
    crowding: 54,
    drawdownRisk: 31,
    creditSensitivity: 18,
    rateSensitivity: 24,
    growthSensitivity: 41,
    defensiveScore: 82,
  },
  {
    ticker: 'XLE',
    name: 'Energy Select Sector SPDR',
    assetType: 'ETF',
    sector: 'Energy',
    industry: 'Sector ETF',
    style: 'Inflation hedge',
    trend20: 62,
    trend60: 67,
    trend120: 61,
    relativeStrength: 65,
    residualStrength: 66,
    revisionTrend: 58,
    surpriseMomentum: 54,
    marginTrend: 57,
    revenueAcceleration: 55,
    freeCashFlowTrend: 70,
    quality: 64,
    valuationSupport: 72,
    liquidity: 90,
    breadth: 70,
    impliedVolRank: 45,
    realizedVol: 46,
    skewRisk: 38,
    eventRisk: 24,
    crowding: 42,
    drawdownRisk: 43,
    creditSensitivity: 36,
    rateSensitivity: 22,
    growthSensitivity: 24,
    defensiveScore: 45,
  },
  {
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF',
    assetType: 'ETF',
    sector: 'Broad Market',
    industry: 'Index ETF',
    style: 'Core beta',
    trend20: 68,
    trend60: 74,
    trend120: 78,
    relativeStrength: 62,
    residualStrength: 60,
    revisionTrend: 62,
    surpriseMomentum: 58,
    marginTrend: 62,
    revenueAcceleration: 60,
    freeCashFlowTrend: 66,
    quality: 76,
    valuationSupport: 54,
    liquidity: 99,
    breadth: 64,
    impliedVolRank: 40,
    realizedVol: 35,
    skewRisk: 38,
    eventRisk: 20,
    crowding: 50,
    drawdownRisk: 34,
    creditSensitivity: 34,
    rateSensitivity: 32,
    growthSensitivity: 55,
    defensiveScore: 52,
  },
  {
    ticker: 'QQQ',
    name: 'Invesco QQQ Trust',
    assetType: 'ETF',
    sector: 'Broad Market',
    industry: 'Growth ETF',
    style: 'Large-cap growth',
    trend20: 74,
    trend60: 82,
    trend120: 86,
    relativeStrength: 78,
    residualStrength: 74,
    revisionTrend: 69,
    surpriseMomentum: 64,
    marginTrend: 72,
    revenueAcceleration: 70,
    freeCashFlowTrend: 74,
    quality: 82,
    valuationSupport: 47,
    liquidity: 99,
    breadth: 62,
    impliedVolRank: 48,
    realizedVol: 42,
    skewRisk: 44,
    eventRisk: 18,
    crowding: 66,
    drawdownRisk: 45,
    creditSensitivity: 22,
    rateSensitivity: 42,
    growthSensitivity: 76,
    defensiveScore: 32,
  },
  {
    ticker: 'JPM',
    name: 'JPMorgan Chase',
    assetType: 'Stock',
    sector: 'Financials',
    industry: 'Banks',
    style: 'Cyclical quality',
    trend20: 54,
    trend60: 59,
    trend120: 66,
    relativeStrength: 55,
    residualStrength: 52,
    revisionTrend: 56,
    surpriseMomentum: 60,
    marginTrend: 58,
    revenueAcceleration: 52,
    freeCashFlowTrend: 62,
    quality: 80,
    valuationSupport: 67,
    liquidity: 92,
    breadth: 52,
    impliedVolRank: 42,
    realizedVol: 38,
    skewRisk: 46,
    eventRisk: 34,
    crowding: 38,
    drawdownRisk: 47,
    creditSensitivity: 74,
    rateSensitivity: 58,
    growthSensitivity: 31,
    defensiveScore: 36,
  },
  {
    ticker: 'XLF',
    name: 'Financial Select Sector SPDR',
    assetType: 'ETF',
    sector: 'Financials',
    industry: 'Sector ETF',
    style: 'Cyclical value',
    trend20: 49,
    trend60: 55,
    trend120: 61,
    relativeStrength: 48,
    residualStrength: 49,
    revisionTrend: 52,
    surpriseMomentum: 50,
    marginTrend: 51,
    revenueAcceleration: 48,
    freeCashFlowTrend: 58,
    quality: 66,
    valuationSupport: 70,
    liquidity: 92,
    breadth: 47,
    impliedVolRank: 41,
    realizedVol: 39,
    skewRisk: 43,
    eventRisk: 18,
    crowding: 36,
    drawdownRisk: 48,
    creditSensitivity: 78,
    rateSensitivity: 62,
    growthSensitivity: 25,
    defensiveScore: 32,
  },
  {
    ticker: 'TSLA',
    name: 'Tesla',
    assetType: 'Stock',
    sector: 'Consumer Discretionary',
    industry: 'Autos',
    style: 'High beta growth',
    trend20: 38,
    trend60: 42,
    trend120: 49,
    relativeStrength: 35,
    residualStrength: 34,
    revisionTrend: 31,
    surpriseMomentum: 39,
    marginTrend: 35,
    revenueAcceleration: 41,
    freeCashFlowTrend: 38,
    quality: 58,
    valuationSupport: 33,
    liquidity: 96,
    breadth: 36,
    impliedVolRank: 82,
    realizedVol: 78,
    skewRisk: 76,
    eventRisk: 72,
    crowding: 73,
    drawdownRisk: 84,
    creditSensitivity: 42,
    rateSensitivity: 62,
    growthSensitivity: 83,
    defensiveScore: 12,
  },
  {
    ticker: 'AAPL',
    name: 'Apple',
    assetType: 'Stock',
    sector: 'Technology',
    industry: 'Hardware',
    style: 'Mega-cap quality',
    trend20: 46,
    trend60: 53,
    trend120: 58,
    relativeStrength: 44,
    residualStrength: 42,
    revisionTrend: 40,
    surpriseMomentum: 48,
    marginTrend: 62,
    revenueAcceleration: 38,
    freeCashFlowTrend: 76,
    quality: 89,
    valuationSupport: 50,
    liquidity: 99,
    breadth: 48,
    impliedVolRank: 46,
    realizedVol: 37,
    skewRisk: 42,
    eventRisk: 50,
    crowding: 58,
    drawdownRisk: 44,
    creditSensitivity: 14,
    rateSensitivity: 34,
    growthSensitivity: 62,
    defensiveScore: 44,
  },
  {
    ticker: 'IWM',
    name: 'iShares Russell 2000 ETF',
    assetType: 'ETF',
    sector: 'Broad Market',
    industry: 'Small-cap ETF',
    style: 'Small-cap cyclicals',
    trend20: 37,
    trend60: 43,
    trend120: 48,
    relativeStrength: 33,
    residualStrength: 36,
    revisionTrend: 44,
    surpriseMomentum: 45,
    marginTrend: 43,
    revenueAcceleration: 45,
    freeCashFlowTrend: 42,
    quality: 45,
    valuationSupport: 68,
    liquidity: 90,
    breadth: 38,
    impliedVolRank: 63,
    realizedVol: 61,
    skewRisk: 58,
    eventRisk: 20,
    crowding: 35,
    drawdownRisk: 67,
    creditSensitivity: 82,
    rateSensitivity: 54,
    growthSensitivity: 38,
    defensiveScore: 24,
  },
  {
    ticker: 'TLT',
    name: 'iShares 20+ Year Treasury Bond ETF',
    assetType: 'ETF',
    sector: 'Rates',
    industry: 'Treasury ETF',
    style: 'Duration hedge',
    trend20: 55,
    trend60: 49,
    trend120: 43,
    relativeStrength: 52,
    residualStrength: 54,
    revisionTrend: 50,
    surpriseMomentum: 50,
    marginTrend: 50,
    revenueAcceleration: 50,
    freeCashFlowTrend: 50,
    quality: 76,
    valuationSupport: 61,
    liquidity: 95,
    breadth: 50,
    impliedVolRank: 54,
    realizedVol: 52,
    skewRisk: 47,
    eventRisk: 15,
    crowding: 41,
    drawdownRisk: 56,
    creditSensitivity: 5,
    rateSensitivity: 92,
    growthSensitivity: 12,
    defensiveScore: 66,
  },
  {
    ticker: 'XLV',
    name: 'Health Care Select Sector SPDR',
    assetType: 'ETF',
    sector: 'Healthcare',
    industry: 'Sector ETF',
    style: 'Defensive equity',
    trend20: 58,
    trend60: 61,
    trend120: 66,
    relativeStrength: 59,
    residualStrength: 61,
    revisionTrend: 58,
    surpriseMomentum: 54,
    marginTrend: 60,
    revenueAcceleration: 57,
    freeCashFlowTrend: 63,
    quality: 79,
    valuationSupport: 62,
    liquidity: 90,
    breadth: 63,
    impliedVolRank: 33,
    realizedVol: 30,
    skewRisk: 31,
    eventRisk: 16,
    crowding: 35,
    drawdownRisk: 29,
    creditSensitivity: 17,
    rateSensitivity: 20,
    growthSensitivity: 31,
    defensiveScore: 78,
  },
  {
    ticker: 'XLY',
    name: 'Consumer Discretionary Select Sector SPDR',
    assetType: 'ETF',
    sector: 'Consumer Discretionary',
    industry: 'Sector ETF',
    style: 'Cyclical growth',
    trend20: 42,
    trend60: 47,
    trend120: 54,
    relativeStrength: 41,
    residualStrength: 43,
    revisionTrend: 45,
    surpriseMomentum: 43,
    marginTrend: 47,
    revenueAcceleration: 46,
    freeCashFlowTrend: 50,
    quality: 57,
    valuationSupport: 56,
    liquidity: 88,
    breadth: 39,
    impliedVolRank: 52,
    realizedVol: 50,
    skewRisk: 49,
    eventRisk: 18,
    crowding: 45,
    drawdownRisk: 60,
    creditSensitivity: 54,
    rateSensitivity: 58,
    growthSensitivity: 56,
    defensiveScore: 20,
  },
]

export function scoreUniverse(
  signals: RawSignal[] = rawSignals,
  scenario: ScenarioId = 'base',
): DecisionSignal[] {
  return signals
    .map((signal) => applyScenario(signal, scenario))
    .map(scoreSignal)
    .sort((left, right) => {
      if (left.actionRank !== right.actionRank) return left.actionRank - right.actionRank
      return right.opportunityScore - left.opportunityScore
    })
}

export function sectorScores(rows: DecisionSignal[]) {
  const bySector = new Map<string, DecisionSignal[]>()
  rows.forEach((row) => {
    bySector.set(row.sector, [...(bySector.get(row.sector) ?? []), row])
  })

  return [...bySector.entries()]
    .map(([sector, sectorRows]) => {
      const score =
        sectorRows.reduce((sum, row) => sum + row.regimeFit + row.opportunityScore - row.riskScore * 0.4, 0) /
        sectorRows.length
      const buys = sectorRows.filter((row) => row.action === 'Buy Now' || row.action === 'Accumulate').length
      const sells = sectorRows.filter((row) => row.action === 'Sell' || row.action === 'Trim').length
      return {
        sector,
        score: Math.round(clamp(score)),
        label: buys > sells ? 'Accumulation' : sells > buys ? 'Distribution' : 'Mixed',
        participation: Math.round(sectorRows.reduce((sum, row) => sum + row.breadth, 0) / sectorRows.length),
      }
    })
    .sort((left, right) => right.score - left.score)
}

export function sortSignals(rows: DecisionSignal[], sortKey: SortKey) {
  const sorted = [...rows]
  sorted.sort((left, right) => {
    if (sortKey === 'action') {
      if (left.actionRank !== right.actionRank) return left.actionRank - right.actionRank
      return right.opportunityScore - left.opportunityScore
    }
    if (sortKey === 'opportunity') return right.opportunityScore - left.opportunityScore
    if (sortKey === 'confidence') return right.confidence - left.confidence
    if (sortKey === 'risk') return right.riskScore - left.riskScore
    return right.regimeFit - left.regimeFit
  })
  return sorted
}

export function actionTone(action: Action): Tone {
  if (action === 'Buy Now' || action === 'Accumulate') return 'positive'
  if (action === 'Trim') return 'caution'
  if (action === 'Sell' || action === 'Avoid') return 'danger'
  return 'neutral'
}

export function formatSignedPercent(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function applyScenario(signal: RawSignal, scenario: ScenarioId): RawSignal {
  if (scenario === 'base') return signal

  const next = { ...signal }
  if (scenario === 'volJump') {
    next.impliedVolRank = clamp(next.impliedVolRank + 18)
    next.skewRisk = clamp(next.skewRisk + 14)
    next.drawdownRisk = clamp(next.drawdownRisk + Math.round(next.growthSensitivity / 8))
    next.relativeStrength = clamp(next.relativeStrength - Math.round(next.crowding / 12))
  }
  if (scenario === 'creditStress') {
    next.creditSensitivity = clamp(next.creditSensitivity + 18)
    next.drawdownRisk = clamp(next.drawdownRisk + Math.round(next.creditSensitivity / 7))
    next.breadth = clamp(next.breadth - Math.round(next.creditSensitivity / 8))
    next.relativeStrength = clamp(next.relativeStrength - Math.round(next.creditSensitivity / 10))
  }
  if (scenario === 'growthBreak') {
    next.relativeStrength = clamp(next.relativeStrength - Math.round(next.growthSensitivity / 7))
    next.residualStrength = clamp(next.residualStrength - Math.round(next.growthSensitivity / 8))
    next.revisionTrend = clamp(next.revisionTrend - Math.round(next.growthSensitivity / 12))
    next.defensiveScore = clamp(next.defensiveScore + 10)
  }
  if (scenario === 'ratesFall') {
    next.rateSensitivity = clamp(next.rateSensitivity + 8)
    next.relativeStrength = clamp(next.relativeStrength + Math.round((next.rateSensitivity + next.growthSensitivity) / 18))
    next.drawdownRisk = clamp(next.drawdownRisk - Math.round(next.defensiveScore / 18))
    next.valuationSupport = clamp(next.valuationSupport + Math.round(next.rateSensitivity / 12))
  }
  return next
}

function scoreSignal(signal: RawSignal): DecisionSignal {
  const trendQuality = signal.trend20 * 0.25 + signal.trend60 * 0.35 + signal.trend120 * 0.4
  const fundamentalDirection =
    signal.revisionTrend * 0.32 +
    signal.surpriseMomentum * 0.18 +
    signal.marginTrend * 0.16 +
    signal.revenueAcceleration * 0.18 +
    signal.freeCashFlowTrend * 0.16
  const regimeFit = clamp(
    trendQuality * 0.23 +
      signal.relativeStrength * 0.18 +
      signal.residualStrength * 0.16 +
      signal.breadth * 0.14 +
      signal.growthSensitivity * 0.12 +
      signal.defensiveScore * 0.07 +
      (100 - signal.creditSensitivity) * 0.05 +
      (100 - signal.rateSensitivity) * 0.05,
  )
  const fragilityScore = clamp(
    signal.impliedVolRank * 0.2 +
      signal.skewRisk * 0.18 +
      signal.crowding * 0.18 +
      signal.drawdownRisk * 0.2 +
      signal.eventRisk * 0.12 +
      (100 - signal.breadth) * 0.12,
  )
  const riskScore = clamp(
    fragilityScore * 0.45 +
      signal.realizedVol * 0.15 +
      signal.creditSensitivity * 0.12 +
      signal.rateSensitivity * 0.08 +
      signal.eventRisk * 0.1 +
      (100 - signal.liquidity) * 0.1,
  )
  const opportunityScore = clamp(
    trendQuality * 0.19 +
      signal.relativeStrength * 0.14 +
      signal.residualStrength * 0.14 +
      fundamentalDirection * 0.18 +
      signal.quality * 0.11 +
      signal.valuationSupport * 0.08 +
      regimeFit * 0.12 +
      signal.breadth * 0.08 -
      riskScore * 0.05 -
      fragilityScore * 0.04,
  )
  const asymmetryScore = clamp(opportunityScore * 0.72 + signal.valuationSupport * 0.16 - riskScore * 0.2 + 20)
  const thesisDamage = clamp(
    (100 - signal.relativeStrength) * 0.24 +
      (100 - signal.residualStrength) * 0.18 +
      (100 - signal.revisionTrend) * 0.16 +
      riskScore * 0.22 +
      fragilityScore * 0.2,
  )
  const agreement = [
    trendQuality,
    signal.relativeStrength,
    signal.residualStrength,
    fundamentalDirection,
    signal.quality,
    signal.breadth,
    100 - riskScore,
  ]
  const average = agreement.reduce((sum, value) => sum + value, 0) / agreement.length
  const dispersion =
    agreement.reduce((sum, value) => sum + Math.abs(value - average), 0) / agreement.length
  const confidence = clamp(average * 0.72 + signal.liquidity * 0.12 + (100 - dispersion) * 0.16)
  const signalStability = clamp(100 - dispersion * 1.15 - signal.eventRisk * 0.14)
  const forecast20d = clamp((opportunityScore - riskScore) / 8 + (regimeFit - 50) / 18, -12, 12)
  const probabilityOutperform = clamp(50 + (opportunityScore - 60) * 0.55 + (regimeFit - 60) * 0.22 - riskScore * 0.08)
  const probabilityDrawdown = clamp(18 + riskScore * 0.52 + fragilityScore * 0.24 - opportunityScore * 0.18)
  const action = classifyAction({
    opportunityScore,
    confidence,
    riskScore,
    fragilityScore,
    regimeFit,
    thesisDamage,
  })

  return {
    ...signal,
    action,
    opportunityScore: Math.round(opportunityScore),
    confidence: Math.round(confidence),
    riskScore: Math.round(riskScore),
    fragilityScore: Math.round(fragilityScore),
    regimeFit: Math.round(regimeFit),
    asymmetryScore: Math.round(asymmetryScore),
    thesisDamage: Math.round(thesisDamage),
    forecast20d,
    probabilityOutperform: Math.round(probabilityOutperform),
    probabilityDrawdown: Math.round(probabilityDrawdown),
    signalStability: Math.round(signalStability),
    actionRank: actionRank(action),
    positionPlan: positionPlan(action, opportunityScore, riskScore, signal.crowding),
    evidence: evidenceFor(signal, opportunityScore, regimeFit, confidence),
    riskFlags: riskFlagsFor(signal, riskScore, fragilityScore, thesisDamage),
    invalidation: invalidationFor(signal),
    nextCheck: nextCheckFor(action, signal.eventRisk, riskScore),
  }
}

function classifyAction(scores: {
  opportunityScore: number
  confidence: number
  riskScore: number
  fragilityScore: number
  regimeFit: number
  thesisDamage: number
}): Action {
  if (scores.thesisDamage >= 58 && scores.riskScore >= 56) return 'Sell'
  if (scores.thesisDamage >= 54 || (scores.riskScore >= 58 && scores.opportunityScore < 66)) return 'Trim'
  if (scores.riskScore >= 70 && scores.opportunityScore < 60) return 'Avoid'
  if (
    scores.opportunityScore >= 74 &&
    scores.confidence >= 68 &&
    scores.regimeFit >= 62 &&
    scores.riskScore <= 55
  ) {
    return 'Buy Now'
  }
  if (scores.opportunityScore >= 68 && scores.confidence >= 62 && scores.riskScore <= 64) return 'Accumulate'
  if (scores.opportunityScore < 54 && scores.regimeFit < 52) return 'Avoid'
  return 'Hold'
}

function actionRank(action: Action) {
  return {
    'Buy Now': 1,
    Accumulate: 2,
    Hold: 3,
    Trim: 4,
    Sell: 5,
    Avoid: 6,
  }[action]
}

function positionPlan(action: Action, opportunity: number, risk: number, crowding: number) {
  if (action === 'Buy Now') {
    if (opportunity >= 84 && risk <= 55 && crowding < 65) return 'Starter position'
    return 'Small starter'
  }
  if (action === 'Accumulate') return 'Scale on pullbacks'
  if (action === 'Hold') return 'No fresh add'
  if (action === 'Trim') return 'Reduce exposure'
  if (action === 'Sell') return 'Exit candidate'
  return 'Avoid for now'
}

function evidenceFor(signal: RawSignal, opportunity: number, regimeFit: number, confidence: number) {
  const reasons = []
  if (opportunity >= 78) reasons.push('Opportunity score clears the buy threshold.')
  if (signal.relativeStrength >= 75) reasons.push('Relative strength is leading peers and the market.')
  if (signal.residualStrength >= 72) reasons.push('Residual strength remains positive after sector and market effects.')
  if (signal.revisionTrend >= 72) reasons.push('Estimate revision trend supports the thesis.')
  if (signal.quality >= 82) reasons.push('Quality and durability are above the universe median.')
  if (regimeFit >= 70) reasons.push('Current regime fit is supportive.')
  if (confidence >= 74) reasons.push('Signal agreement is high enough for action.')
  if (signal.assetType === 'ETF') reasons.push('ETF structure lowers single-name event risk.')
  return reasons.length > 0 ? reasons.slice(0, 4) : ['Mixed evidence keeps this in review.']
}

function riskFlagsFor(signal: RawSignal, risk: number, fragility: number, thesisDamage: number) {
  const flags = []
  if (risk >= 65) flags.push('Composite risk is elevated.')
  if (fragility >= 65) flags.push('Fragility cluster is rising.')
  if (signal.impliedVolRank >= 65) flags.push('Options-implied volatility is elevated.')
  if (signal.skewRisk >= 64) flags.push('Downside skew shows hedging demand.')
  if (signal.crowding >= 68) flags.push('Crowding raises failed-breakout risk.')
  if (signal.breadth <= 45) flags.push('Peer breadth is weak.')
  if (thesisDamage >= 65) flags.push('Thesis damage is high enough for sell discipline.')
  return flags.length > 0 ? flags.slice(0, 4) : ['No major deterioration cluster yet.']
}

function invalidationFor(signal: RawSignal) {
  const invalidation = []
  if (signal.relativeStrength >= 70) {
    invalidation.push('Relative strength falls below peer group for 10 trading days.')
  } else {
    invalidation.push('Relative strength fails to reclaim the sector median.')
  }
  if (signal.revisionTrend >= 65) {
    invalidation.push('Positive revisions flatten or turn negative.')
  } else {
    invalidation.push('Revision trend keeps deteriorating into the next refresh.')
  }
  if (signal.skewRisk >= 58 || signal.impliedVolRank >= 58) {
    invalidation.push('Put skew steepens again without price confirmation.')
  }
  if (signal.breadth <= 50) {
    invalidation.push('Sector breadth remains below confirmation level.')
  }
  return invalidation.slice(0, 3)
}

function nextCheckFor(action: Action, eventRisk: number, risk: number) {
  if (action === 'Sell' || action === 'Trim') return 'Review before the next close.'
  if (eventRisk >= 65) return 'Review before the next scheduled event.'
  if (risk >= 64) return 'Review after the next market refresh.'
  return 'Review on the next daily refresh.'
}
