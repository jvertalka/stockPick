export type Action = 'Buy Now' | 'Accumulate' | 'Hold' | 'Trim' | 'Sell' | 'Avoid'
export type Tone = 'positive' | 'neutral' | 'caution' | 'danger'
export type AssetType = 'Stock' | 'ETF'
export type ScenarioId = 'base' | 'volJump' | 'creditStress' | 'growthBreak' | 'ratesFall'
export type SortKey = 'action' | 'opportunity' | 'confidence' | 'risk' | 'regimeFit' | 'data'

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
  dataConfidence?: number
  dataSource?: string
  dataWarnings?: string[]
  priceAsOf?: string | null
  historyBars?: number
  lastPrice?: number
  priceChange20d?: number
  priceChange60d?: number
  priceChange120d?: number
  realizedVolatilityPct?: number
  maxDrawdown60d?: number
  volumeTrend?: number
  downsideVolumePressure?: number
  volatilityExpansion?: number
  optionsProxySource?: string
  /** ISO date of the latest SEC filing behind the fundamental fields;
   * absent when this symbol has no EDGAR coverage (ETF / non-filer). */
  fundamentalsAsOf?: string | null
  fundamentalsSource?: string
  /** Position in the curated universe list (0 = most established/liquid).
   * Used to pick the ML scoring set — the model trained on liquid names,
   * so serving it far down the illiquid tail is a distribution shift. */
  universeRankSeed?: number
  fundamentalsCovered?: boolean
}

/** Where a signal's final action label came from — shown in the UI so a
 * verdict's provenance is never a mystery.
 *  - 'ml'            the ML ensemble's cross-sectional rank set it
 *  - 'ml-veto'       ML ranked it bullish but evidence/risk gates held it at Hold
 *  - 'rules-exit'    the rules' bearish call (their measured strength) kept it
 *  - 'demoted-no-ml' rules said bullish but no ML coverage — held at Hold
 *  - 'demoted-gated' regime gate closed; unearned bullish held at Hold
 *  - 'rules'         untouched rules label (legacy mode, or neutral) */
export type VerdictSource =
  | 'ml'
  | 'ml-veto'
  | 'rules-exit'
  | 'demoted-no-ml'
  | 'demoted-gated'
  | 'rules'

export type DecisionSignal = RawSignal & {
  action: Action
  verdictSource?: VerdictSource
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
  // Data-driven additions: every score below is statistically grounded
  // in cross-sectional Z-scores rather than hand-set weights.
  momentumZ: number
  qualityZ: number
  valueZ: number
  lowVolZ: number
  growthZ: number
  fragilityZ: number
  compositeAlphaZ: number
  alphaPercentile: number
  detectedRegime: string
  factorAgreement: number
  // Quant-overlay additions: present only when computeQuantAnalysis has
  // run for this ticker. quantConfirmed = true means the action label
  // has been validated by Monte Carlo + BSM + Kelly.
  quantConfirmed: boolean
  recommendedKellyHalfPct?: number  // suggested capital fraction (Half Kelly)
  monteCarloMean?: number           // expected 20d return %
  monteCarloProbUp5?: number        // P(20d return > +5%)
  monteCarloProbDown8?: number      // P(20d return < -8%)
  riskNeutralProbUp?: number        // BSM-implied P(spot > today, 30d)
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

/** SAMPLE fixture — dev/Storybook/test ONLY. Never a runtime default: the
 * live app feeds real signals from the backend (App.tsx → setSignalInputs).
 * Renamed loud + the scoreUniverse default removed so this can't be scored as
 * a real decision feed by accident. */
export const SAMPLE_RAW_SIGNALS: RawSignal[] = [
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

/* =========================================================================
   Data-driven scoring pipeline
   -------------------------------------------------------------------------
   Replaces the previous hand-tuned weighted-sum with a 6-step statistical
   process:
     1. Apply scenario shocks (unchanged from before)
     2. Compute universe-wide statistics (mean, stddev, percentile rank)
        for every input across ALL stocks being scored together
     3. Z-score each input cross-sectionally so signals are comparable
        across stocks regardless of their absolute scale
     4. Decompose Z-scores into canonical academic factors (momentum,
        quality, value, low-vol, growth, options-derived fragility)
     5. Detect the prevailing market regime from cross-sectional dispersion
        + macro-sensitivity averages, then weight factors per regime
     6. Compute composite alpha as a regime-weighted factor sum, convert
        to percentile rank, and gate actions on percentile + Z magnitude
   The action label is no longer "Opp >= 74 = Buy". It's "this stock's
   composite alpha is in the top 8% of the universe AND its risk Z is
   below +0.5 AND at least three factors agree on direction."
   ========================================================================= */

const FACTOR_INPUTS = {
  momentum: ['trend20', 'trend60', 'trend120', 'relativeStrength', 'residualStrength'] as const,
  quality: ['quality', 'marginTrend', 'freeCashFlowTrend'] as const,
  value: ['valuationSupport'] as const,
  lowVol: ['realizedVol', 'impliedVolRank', 'drawdownRisk'] as const,
  growth: ['revenueAcceleration', 'revisionTrend', 'surpriseMomentum', 'growthSensitivity'] as const,
  fragility: ['skewRisk', 'crowding', 'eventRisk', 'impliedVolRank'] as const,
}

type UniverseStats = {
  size: number
  // mean[field] and stddev[field] across the active universe
  mean: Record<string, number>
  stddev: Record<string, number>
  // Aggregate market-state observations derived from the cross-section
  marketBreadth: number // average breadth, 0-100
  marketTrend: number   // average trend60, 0-100
  marketRisk: number    // average drawdownRisk, 0-100
  marketDispersion: number // stddev of compositeReadings (proxy for regime change)
}

type DetectedRegime =
  | 'growth-favorable'
  | 'risk-on-broad'
  | 'late-cycle'
  | 'defensive'
  | 'credit-stress'
  | 'mixed'

const NUMERIC_FIELDS_FOR_STATS: Array<keyof RawSignal> = [
  'trend20', 'trend60', 'trend120',
  'relativeStrength', 'residualStrength',
  'revisionTrend', 'surpriseMomentum',
  'marginTrend', 'revenueAcceleration', 'freeCashFlowTrend',
  'quality', 'valuationSupport',
  'liquidity', 'breadth',
  'impliedVolRank', 'realizedVol', 'skewRisk', 'eventRisk',
  'crowding', 'drawdownRisk',
  'creditSensitivity', 'rateSensitivity',
  'growthSensitivity', 'defensiveScore',
]

/** Compute mean + stddev for every numeric input across the universe. */
function computeUniverseStats(signals: RawSignal[]): UniverseStats {
  const size = signals.length
  const mean: Record<string, number> = {}
  const stddev: Record<string, number> = {}

  for (const field of NUMERIC_FIELDS_FOR_STATS) {
    const values = signals.map((signal) => signal[field] as number).filter(Number.isFinite)
    if (values.length === 0) {
      mean[field as string] = 50
      stddev[field as string] = 1
      continue
    }
    const m = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance =
      values.reduce((sum, value) => sum + (value - m) * (value - m), 0) / values.length
    mean[field as string] = m
    // Floor stddev at 1 so we never divide by 0 on a degenerate universe.
    stddev[field as string] = Math.max(1, Math.sqrt(variance))
  }

  const marketBreadth = mean.breadth ?? 50
  const marketTrend = mean.trend60 ?? 50
  const marketRisk = mean.drawdownRisk ?? 50

  // Cross-sectional dispersion: how spread out are the trends? High
  // dispersion = factor rotation. Low dispersion = correlated market.
  const trendDispersion = stddev.trend60 ?? 0
  const fragilityDispersion = stddev.skewRisk ?? 0
  const marketDispersion = (trendDispersion + fragilityDispersion) / 2

  return { size, mean, stddev, marketBreadth, marketTrend, marketRisk, marketDispersion }
}

/** Detect the prevailing regime from cross-sectional aggregates + macro
 * sensitivities. The regime label drives factor-weight selection. */
function detectMarketRegime(stats: UniverseStats): DetectedRegime {
  const breadth = stats.marketBreadth
  const trend = stats.marketTrend
  const risk = stats.marketRisk
  const credit = stats.mean.creditSensitivity ?? 50
  const growth = stats.mean.growthSensitivity ?? 50

  // Heuristics ordered most-restrictive-first
  if (risk > 65 && credit > 60) return 'credit-stress'
  if (risk > 60 && breadth < 45) return 'late-cycle'
  if (trend > 60 && growth > 55 && breadth > 55) return 'growth-favorable'
  if (trend > 55 && breadth > 60) return 'risk-on-broad'
  if (risk < 50 && breadth < 55) return 'defensive'
  return 'mixed'
}

/**
 * Risk-parity factor weights computed from the cross-sectional volatility
 * of each factor in the active universe. Weights are inversely proportional
 * to factor volatility, normalized to sum to 1, so each factor contributes
 * equal risk to the composite.
 *
 * Source: Maillard, Roncalli, Teiletche (2010), "The Properties of Equally
 * Weighted Risk Contribution Portfolios", Journal of Portfolio Management
 * 36(4): 60-70.
 *
 * This replaces the prior hand-set per-regime weight tables. The regime
 * label is still computed (used for evidence narration) but no longer
 * drives the weights — the data does.
 */
function computeRiskParityWeights(stats: UniverseStats): Record<keyof typeof FACTOR_INPUTS, number> {
  // Each factor's volatility = stddev of its component Z-scores across
  // the universe (proxy for cross-sectional dispersion of the factor).
  const factorVols: Record<keyof typeof FACTOR_INPUTS, number> = {
    momentum: averageStddev(FACTOR_INPUTS.momentum, stats),
    quality: averageStddev(FACTOR_INPUTS.quality, stats),
    value: stats.stddev.valuationSupport ?? 1,
    lowVol: averageStddev(FACTOR_INPUTS.lowVol, stats),
    growth: averageStddev(FACTOR_INPUTS.growth, stats),
    fragility: averageStddev(FACTOR_INPUTS.fragility, stats),
  }
  const inverse: Record<keyof typeof FACTOR_INPUTS, number> = {
    momentum: 1 / Math.max(1, factorVols.momentum),
    quality: 1 / Math.max(1, factorVols.quality),
    value: 1 / Math.max(1, factorVols.value),
    lowVol: 1 / Math.max(1, factorVols.lowVol),
    growth: 1 / Math.max(1, factorVols.growth),
    fragility: 1 / Math.max(1, factorVols.fragility),
  }
  const total = Object.values(inverse).reduce((sum, value) => sum + value, 0)
  return {
    momentum: inverse.momentum / total,
    quality: inverse.quality / total,
    value: inverse.value / total,
    lowVol: inverse.lowVol / total,
    growth: inverse.growth / total,
    fragility: inverse.fragility / total,
  }
}

function averageStddev(fields: ReadonlyArray<string>, stats: UniverseStats): number {
  const stddevs = fields.map((field) => stats.stddev[field] ?? 1)
  if (stddevs.length === 0) return 1
  return stddevs.reduce((sum, value) => sum + value, 0) / stddevs.length
}

function zScore(value: number, mean: number, stddev: number): number {
  return (value - mean) / Math.max(1, stddev)
}

/** Average of a Z-score array, ignoring NaN/Infinity. */
function meanZ(values: number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

/** Standard deviation across an array. */
function stdZ(values: number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  const m = meanZ(finite)
  const variance = finite.reduce((sum, value) => sum + (value - m) * (value - m), 0) / finite.length
  return Math.sqrt(variance)
}

/** Standard normal CDF approximation (Abramowitz & Stegun). Used to
 * convert composite Z-scores to percentile ranks. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp(-z * z / 2)
  const p = d * t * (
    0.31938153 +
    t * (-0.356563782 +
      t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
  )
  return z >= 0 ? 1 - p : p
}

export function scoreUniverse(
  // REQUIRED — no default. A silent fallback to the SAMPLE_RAW_SIGNALS fixture
  // would let placeholder data be scored as if it were a real decision feed,
  // which is unacceptable for buy/sell use. Callers must pass live signals.
  signals: RawSignal[],
  scenario: ScenarioId = 'base',
): DecisionSignal[] {
  // Step 1: scenario application
  const scaled = signals.map((signal) => applyScenario(signal, scenario))

  // Step 2: compute universe-wide statistics (mean, stddev per input)
  const stats = computeUniverseStats(scaled)

  // Step 3: detect market regime — used for narration only now, not for
  // weighting. The weights themselves come from data via risk-parity.
  const regime = detectMarketRegime(stats)

  // Step 4: compute risk-parity factor weights from cross-sectional
  // dispersion. Each factor contributes equal risk to the composite,
  // following Maillard-Roncalli-Teiletche (2010).
  const factorWeights = computeRiskParityWeights(stats)

  // Steps 5-7: score every signal with risk-parity weighted factors
  const scored = scaled.map((signal) => scoreSignal(signal, stats, regime, factorWeights))

  return scored.sort((left, right) => {
    if (left.actionRank !== right.actionRank) return left.actionRank - right.actionRank
    return right.compositeAlphaZ - left.compositeAlphaZ
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
    if (sortKey === 'data') return (right.dataConfidence ?? 0) - (left.dataConfidence ?? 0)
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

function scoreSignal(
  signal: RawSignal,
  stats: UniverseStats,
  regime: DetectedRegime,
  factorWeights: Record<keyof typeof FACTOR_INPUTS, number>,
): DecisionSignal {
  const dataConfidence = signal.dataConfidence ?? 65
  const lowDataPenalty = Math.max(0, 55 - dataConfidence)

  // Step 4a: Z-score every input cross-sectionally. A trend score of 75
  // means very different things in a bull market (median) vs. a bear
  // market (top decile). Z-scores normalize that.
  const z = (field: keyof RawSignal) =>
    zScore(signal[field] as number, stats.mean[field as string] ?? 50, stats.stddev[field as string] ?? 1)

  // Step 4b: Build canonical academic factor scores from Z-score averages.
  // Each factor is a literature-backed concept (Fama-French / AQR / Jegadeesh):
  //   momentum  : cross-sectional 12-month relative strength + residual
  //   quality   : Asness-Frazzini-Pedersen quality factor
  //   value     : Fama-French value factor
  //   lowVol    : low-volatility anomaly (Frazzini-Pedersen)
  //   growth    : earnings revisions + surprise momentum (Chan-Jegadeesh-Lakonishok)
  //   fragility : options-implied risk (skew + IV + crowding) — Xing-Zhang-Zhao
  const momentumZ = meanZ(FACTOR_INPUTS.momentum.map((field) => z(field)))
  const qualityZ = meanZ(FACTOR_INPUTS.quality.map((field) => z(field)))
  const valueZ = z('valuationSupport')
  // low-vol factor inverts: lower realized vol / IV / drawdown = higher score
  const lowVolZ = -meanZ(FACTOR_INPUTS.lowVol.map((field) => z(field)))
  const growthZ = meanZ(FACTOR_INPUTS.growth.map((field) => z(field)))
  // fragility inverts: high skew / crowding / event risk = penalty
  const fragilityZ = -meanZ(FACTOR_INPUTS.fragility.map((field) => z(field)))

  // Step 5: Apply risk-parity factor weights computed from the
  // universe's cross-sectional dispersion (Maillard et al 2010).
  const w = factorWeights
  const compositeAlphaZ =
    momentumZ * w.momentum +
    qualityZ * w.quality +
    valueZ * w.value +
    lowVolZ * w.lowVol +
    growthZ * w.growth +
    fragilityZ * w.fragility

  // Step 6a: Convert composite Z to percentile via normal CDF.
  // alphaPercentile = 75 means the stock is in the top 25% of the universe.
  const alphaPercentile = clamp(normalCdf(compositeAlphaZ) * 100)

  // Step 6b: Factor agreement = how many factors point the same direction.
  // A stock with all 6 factors in agreement is high confidence; one with
  // 3 positive and 3 negative is low confidence regardless of magnitude.
  const factorZs = [momentumZ, qualityZ, valueZ, lowVolZ, growthZ, fragilityZ]
  const positiveFactors = factorZs.filter((value) => value > 0.2).length
  const negativeFactors = factorZs.filter((value) => value < -0.2).length
  const factorAgreement = clamp(
    50 + (positiveFactors - negativeFactors) * 8 - stdZ(factorZs) * 8,
  )

  // Risk Z (separate from alpha): combines downside-fragility inputs.
  // Note: this is the OPPOSITE direction from fragilityZ (which is a
  // factor where higher = better). Here higher = more risk.
  const riskZ = meanZ([
    z('drawdownRisk'),
    z('skewRisk'),
    z('eventRisk'),
    z('realizedVol'),
    z('creditSensitivity') * 0.4,
    z('rateSensitivity') * 0.3,
    -z('liquidity') * 0.5,
  ])

  // Backward-compatible 0-100 scores derived from Z-scores so the
  // existing UI keeps working without a schema change. These are
  // statistical translations, not redundant calculations.
  const opportunityScore = Math.round(alphaPercentile)
  const fragilityScore = Math.round(clamp(50 + (-fragilityZ) * 18))
  const riskScore = Math.round(clamp(50 + riskZ * 18 + lowDataPenalty * 0.12))
  const confidence = Math.round(clamp(factorAgreement * 0.78 + dataConfidence * 0.22))
  // regimeFit: how well this stock's factor profile matches the regime
  // ideal. Computed as Z-weighted match to the regime's preferred factors.
  const regimeIdealMatch =
    momentumZ * w.momentum +
    qualityZ * w.quality +
    growthZ * w.growth +
    lowVolZ * w.lowVol
  const regimeFit = Math.round(clamp(50 + regimeIdealMatch * 18))

  const asymmetryScore = Math.round(clamp(50 + (compositeAlphaZ - riskZ) * 18))

  // Thesis damage: high when fundamental + momentum factors have rolled
  // negative. This drives sell discipline.
  const thesisDamage = Math.round(
    clamp(50 - meanZ([momentumZ, growthZ, qualityZ]) * 18 + Math.max(0, riskZ) * 12),
  )

  const signalStability = Math.round(clamp(100 - stdZ(factorZs) * 25 - lowDataPenalty * 0.2))

  // Forecast 20d: still derived from composite Z scaled to a return %.
  // Honest about the magnitude — composite Z of +1.5 (top ~7%) maps to
  // roughly +4% expected, NOT a guaranteed return. The bands matter.
  const forecast20d = clamp(compositeAlphaZ * 2.5, -12, 12)
  const probabilityOutperform = Math.round(clamp(normalCdf(compositeAlphaZ - 0.1) * 100))
  const probabilityDrawdown = Math.round(clamp(normalCdf(riskZ - 0.4) * 100))

  // Action gate: based on percentiles + factor agreement + risk Z.
  // Adaptive — uses the universe distribution rather than absolute cutoffs.
  const action = classifyAction({
    alphaPercentile,
    compositeAlphaZ,
    riskZ,
    fragilityZ,
    momentumZ,
    growthZ,
    qualityZ,
    thesisDamage,
    factorAgreement,
  })

  return {
    ...signal,
    action,
    opportunityScore,
    confidence,
    riskScore,
    fragilityScore,
    regimeFit,
    asymmetryScore,
    thesisDamage,
    forecast20d,
    probabilityOutperform,
    probabilityDrawdown,
    signalStability,
    actionRank: actionRank(action),
    positionPlan: positionPlan(action, opportunityScore, riskScore, signal.crowding),
    evidence: evidenceForZ(signal, momentumZ, qualityZ, growthZ, valueZ, lowVolZ, regime),
    riskFlags: riskFlagsForZ(signal, riskZ, fragilityZ, thesisDamage),
    invalidation: invalidationFor(signal),
    nextCheck: nextCheckFor(action, signal.eventRisk, riskScore),
    momentumZ,
    qualityZ,
    valueZ,
    lowVolZ,
    growthZ,
    fragilityZ,
    compositeAlphaZ,
    alphaPercentile: Math.round(alphaPercentile),
    detectedRegime: regime,
    factorAgreement: Math.round(factorAgreement),
    quantConfirmed: false,
  }
}

/**
 * Action gate using thresholds anchored to peer-reviewed literature.
 *
 * Thresholds:
 *   - Top quintile (≥80th percentile) for Buy Now: canonical bucket from
 *     Fama-French (1992) factor-portfolio convention. Long-short factor
 *     portfolios are constructed quintile-on-quintile in nearly all
 *     replicated factor research (Asness-Frazzini-Pedersen 2019,
 *     Jegadeesh-Titman 1993, Frazzini-Pedersen 2014).
 *   - Z >= 1.645 = one-sided 95% statistical significance.
 *   - Bottom quintile (<20th percentile) for Avoid: same convention, opposite tail.
 *   - Bottom decile (<10th percentile) hard-Avoid: stronger statistical conviction.
 *
 * The risk-side gates (riskZ thresholds) come from VaR convention: ±1
 * standard deviation in the cross-sectional risk distribution
 * approximately bounds 68% of names; flagging the upper 16% (riskZ ≥ +1.0)
 * as elevated is consistent with Basel III tail-risk thresholds.
 */
function classifyAction(scores: {
  alphaPercentile: number
  compositeAlphaZ: number
  riskZ: number
  fragilityZ: number
  momentumZ: number
  growthZ: number
  qualityZ: number
  thesisDamage: number
  factorAgreement: number
}): Action {
  // Sell discipline: thesis materially damaged AND risk in upper 16%
  if (scores.thesisDamage >= 60 && scores.riskZ >= 1.0) return 'Sell'

  // Trim: thesis damage elevated OR risk in upper 16% with sub-median alpha
  if (
    scores.thesisDamage >= 56 ||
    (scores.riskZ >= 1.0 && scores.alphaPercentile < 50)
  ) {
    return 'Trim'
  }

  // Avoid: bottom decile (Fama-French convention) — strongest statistical
  // case against initiating
  if (scores.alphaPercentile < 10) return 'Avoid'

  // Avoid: bottom quintile with elevated risk
  if (scores.alphaPercentile < 20 && scores.riskZ >= 1.0) return 'Avoid'

  // Buy Now: top quintile (Fama-French convention) AND one-sided 95%
  // significance (z >= 1.645) AND factors are aligned AND risk not in
  // the upper 16%
  if (
    scores.alphaPercentile >= 80 &&
    scores.compositeAlphaZ >= 1.645 &&
    scores.factorAgreement >= 60 &&
    scores.riskZ <= 1.0
  ) {
    return 'Buy Now'
  }

  // Accumulate: above top tercile (top 33%) with above-zero composite Z
  // and at least directional factor agreement — Fama-French decile
  // bucketing is more granular here.
  if (
    scores.alphaPercentile >= 67 &&
    scores.compositeAlphaZ >= 0.5 &&
    scores.factorAgreement >= 50 &&
    scores.riskZ <= 1.0
  ) {
    return 'Accumulate'
  }

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

/* =========================================================================
   ML-led verdicts
   -------------------------------------------------------------------------
   The 15-year action event study (2026-07-07) measured a hard asymmetry in
   the hand-written rules: their bullish upgrades were ANTI-predictive
   (fresh Accumulates lagged peers −0.7pp/20d, −1.1pp/60d, CIs exclude 0)
   while their bearish downgrades carried real signal. The walk-forward-
   validated ML ensemble is therefore the ONLY layer allowed to mint a
   bullish label; the rules keep the jobs they measurably do well — exits,
   risk warnings, and vetoes.
   ========================================================================= */

/** Percentile rank (0-100, average-rank ties) of each ticker's value within
 * the batch. The ML model predicts a RELATIVE (~zero-centered) 20d return,
 * so absolute thresholds are meaningless — rank within the scored batch is
 * the honest unit (same quintile convention the backtest validated). */
function mlBatchPercentiles(pairs: Array<[string, number]>): Map<string, number> {
  const out = new Map<string, number>()
  const n = pairs.length
  if (n === 0) return out
  if (n === 1) {
    out.set(pairs[0][0], 50)
    return out
  }
  const sorted = [...pairs].sort((a, b) => a[1] - b[1])
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++
    const pct = (((i + j) / 2) / (sorted.length - 1)) * 100
    for (let k = i; k <= j; k++) out.set(sorted[k][0], pct)
    i = j + 1
  }
  return out
}

/** Below this many scored names a percentile is too noisy to gate money on. */
const ML_MIN_RANK_BREADTH = 25

/**
 * Re-label a scored universe so every BULLISH verdict is earned by the ML
 * ensemble and every bearish rules call survives as the exit/warning layer.
 *
 * Per name:
 *  - Rules said Trim/Sell/Avoid  → kept verbatim ('rules-exit'). Measured:
 *    the rules' bearish side is informative; the ML bottom ranks reinforce
 *    it below anyway.
 *  - ML scored it:
 *      top quintile  (≥80) → Buy Now,   top tercile (≥67) → Accumulate —
 *      but ONLY through the evidence + risk gates below; a blocked
 *      promotion holds at Hold ('ml-veto').
 *      bottom decile (≤10) → Avoid,  bottom quartile (≤25) → Trim ('ml').
 *      middle → Hold ('ml').
 *  - No ML score (outside the scored set, or model missing): a rules
 *    bullish label is DEMOTED to Hold ('demoted-no-ml') — the measured
 *    anti-signal never reaches the screen.
 *  - Regime gate closed: same demotion ('demoted-gated') and no ML
 *    promotions — the backtest showed the model has no edge there.
 *
 * Evidence gates for promotions (mirrors the UI's readiness tiers):
 *   Buy Now    → dataConfidence ≥ 80 AND real SEC fundamentals
 *   Accumulate → dataConfidence ≥ 60 AND real SEC fundamentals
 * Risk veto: riskScore ≥ 80 blocks any promotion (upper tail of the
 * cross-sectional risk distribution — same spirit as the rules' riskZ gate).
 */
export function applyMlLedVerdicts(
  rows: DecisionSignal[],
  predictedRelReturnByTicker: Map<string, number>,
  options: { regimeGated?: boolean } = {},
): DecisionSignal[] {
  const gated = options.regimeGated === true
  const pctByTicker = gated
    ? new Map<string, number>()
    : mlBatchPercentiles([...predictedRelReturnByTicker.entries()])
  const haveBreadth = pctByTicker.size >= ML_MIN_RANK_BREADTH

  return rows.map((row) => {
    const relabel = (action: Action, verdictSource: VerdictSource): DecisionSignal =>
      action === row.action
        ? { ...row, verdictSource }
        : {
            ...row,
            action,
            verdictSource,
            actionRank: actionRank(action),
            positionPlan: positionPlan(action, row.opportunityScore, row.riskScore, row.crowding),
            nextCheck: nextCheckFor(action, row.eventRisk, row.riskScore),
          }

    // 1. Rules' bearish side survives untouched — its measured strength.
    if (row.action === 'Trim' || row.action === 'Sell' || row.action === 'Avoid') {
      return relabel(row.action, 'rules-exit')
    }

    // 2. Regime gate closed: no layer has earned a bullish call here.
    if (gated) {
      if (row.action === 'Buy Now' || row.action === 'Accumulate') {
        return relabel('Hold', 'demoted-gated')
      }
      return relabel(row.action, 'rules')
    }

    const pct = haveBreadth ? pctByTicker.get(row.ticker) : undefined

    // 3. No ML coverage: rules may keep neutral labels, never bullish ones.
    if (pct == null) {
      if (row.action === 'Buy Now' || row.action === 'Accumulate') {
        return relabel('Hold', 'demoted-no-ml')
      }
      return relabel(row.action, 'rules')
    }

    // 4. ML-ranked names: the ensemble's cross-sectional rank decides.
    const hasRealFundamentals = row.fundamentalsSource === 'sec-edgar-xbrl'
    const confidence = row.dataConfidence ?? 0
    const riskVeto = row.riskScore >= 80

    if (pct >= 80) {
      if (!riskVeto && hasRealFundamentals && confidence >= 80) return relabel('Buy Now', 'ml')
      if (!riskVeto && hasRealFundamentals && confidence >= 60) return relabel('Accumulate', 'ml')
      return relabel('Hold', 'ml-veto')
    }
    if (pct >= 67) {
      if (!riskVeto && hasRealFundamentals && confidence >= 60) return relabel('Accumulate', 'ml')
      return relabel('Hold', 'ml-veto')
    }
    if (pct <= 10) return relabel('Avoid', 'ml')
    if (pct <= 25) return relabel('Trim', 'ml')
    return relabel('Hold', 'ml')
  })
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

/**
 * Build the evidence list from factor Z-scores. Each line cites the
 * specific factor whose Z is statistically meaningful (>=0.5 or <=-0.5
 * in stddev units) so the user can see exactly which factor is driving
 * the rank.
 */
function evidenceForZ(
  signal: RawSignal,
  momentumZ: number,
  qualityZ: number,
  growthZ: number,
  valueZ: number,
  lowVolZ: number,
  regime: DetectedRegime,
): string[] {
  const reasons: string[] = []
  const STAT_THRESHOLD = 0.5
  if (momentumZ >= STAT_THRESHOLD)
    reasons.push(`Momentum factor +${momentumZ.toFixed(1)}σ — leading the universe on trend + relative strength.`)
  if (growthZ >= STAT_THRESHOLD)
    reasons.push(`Growth factor +${growthZ.toFixed(1)}σ — revisions, surprise, and revenue acceleration above peers.`)
  if (qualityZ >= STAT_THRESHOLD)
    reasons.push(`Quality factor +${qualityZ.toFixed(1)}σ — margins, FCF, and balance sheet rank top quartile.`)
  if (valueZ >= STAT_THRESHOLD)
    reasons.push(`Value factor +${valueZ.toFixed(1)}σ — valuation support above the universe median.`)
  if (lowVolZ >= STAT_THRESHOLD)
    reasons.push(`Low-vol factor +${lowVolZ.toFixed(1)}σ — drawdown risk and realized vol below peers.`)
  if (
    (signal.dataConfidence ?? 0) >= 75 &&
    signal.dataSource &&
    signal.dataSource !== 'priors'
  ) {
    reasons.push('Price-derived signals are backed by synced daily OHLCV.')
  }
  if (signal.assetType === 'ETF') {
    reasons.push('ETF structure lowers single-name event risk.')
  }
  if (reasons.length === 0) {
    reasons.push(`Mixed factor profile in a ${regime.replace(/-/g, ' ')} regime — no factor clears 0.5σ.`)
  }
  return reasons.slice(0, 4)
}

function riskFlagsForZ(signal: RawSignal, riskZ: number, fragilityZ: number, thesisDamage: number): string[] {
  const flags: string[] = []
  if ((signal.dataConfidence ?? 65) < 45) flags.push('Price-history confidence is low.')
  if (riskZ >= 0.8) flags.push(`Composite risk +${riskZ.toFixed(1)}σ above universe — top decile of risk.`)
  if (fragilityZ <= -0.8) flags.push(`Fragility factor ${fragilityZ.toFixed(1)}σ — high skew + crowding cluster.`)
  if (signal.impliedVolRank >= 65) flags.push(`Implied vol rank ${signal.impliedVolRank} — options market pricing wide outcomes.`)
  if (signal.skewRisk >= 64) flags.push(`Put skew ${signal.skewRisk} — institutions buying downside protection.`)
  if (signal.crowding >= 68) flags.push(`Crowding ${signal.crowding} — limited marginal buyer.`)
  if (thesisDamage >= 60) flags.push(`Thesis damage ${thesisDamage} — factor decay in momentum/growth/quality.`)
  signal.dataWarnings?.forEach((warning) => {
    if (!flags.includes(warning)) flags.push(warning)
  })
  if (flags.length === 0) flags.push('No major deterioration cluster yet.')
  return flags.slice(0, 4)
}

function invalidationFor(signal: RawSignal) {
  const invalidation: string[] = []
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

/* =========================================================================
   Quant-overlay layer
   -------------------------------------------------------------------------
   Once a ticker has a QuantAnalysis (Monte Carlo + BSM + Kelly), we overlay
   the quantitative outputs onto the engine-derived DecisionSignal and
   re-evaluate the action with stricter gates.
   ========================================================================= */

export type QuantOverlayInput = {
  monteCarloMean: number      // % expected 20d return
  monteCarloProbUp: number    // 0-1
  monteCarloProbUp5: number   // 0-1
  monteCarloProbDown8: number // 0-1
  kellyHalfFraction: number   // 0-1
  riskNeutralProbUp?: number  // 0-1, only when BSM data exists
}

export function applyQuantOverlay(
  signal: DecisionSignal,
  quant: QuantOverlayInput,
): DecisionSignal {
  // Replace engine's heuristic forecast/probabilities with MC outputs
  const refinedAction = refineActionWithQuant(signal, quant)
  return {
    ...signal,
    action: refinedAction,
    actionRank: actionRank(refinedAction),
    forecast20d: clamp(quant.monteCarloMean, -25, 25),
    probabilityOutperform: Math.round(clamp(quant.monteCarloProbUp5 * 100)),
    probabilityDrawdown: Math.round(clamp(quant.monteCarloProbDown8 * 100)),
    quantConfirmed: true,
    recommendedKellyHalfPct: Math.round(quant.kellyHalfFraction * 1000) / 10,
    monteCarloMean: quant.monteCarloMean,
    monteCarloProbUp5: quant.monteCarloProbUp5,
    monteCarloProbDown8: quant.monteCarloProbDown8,
    riskNeutralProbUp: quant.riskNeutralProbUp,
    positionPlan: positionPlan(refinedAction, signal.opportunityScore, signal.riskScore, signal.crowding),
    nextCheck: nextCheckFor(refinedAction, signal.eventRisk, signal.riskScore),
    evidence: appendQuantEvidence(signal.evidence, quant, refinedAction),
    riskFlags: appendQuantRiskFlags(signal.riskFlags, quant),
  }
}

/**
 * Action gate refinement using Monte Carlo + Kelly outputs.
 *
 * Thresholds anchored to research where possible:
 *
 *   - "Equity-risk-premium pace" for 20d minimum expected return:
 *     long-run US equity premium ≈ 5.5%/year (Damodaran updates) →
 *     20-day proportional pace ≈ 0.44%. We require a buy candidate to
 *     beat the equity premium pace by 50% (so >= +0.66%) to justify
 *     active selection over passive market exposure.
 *
 *   - "Skilled manager" Kelly threshold: full Kelly ≈ Sharpe² applies
 *     to a continuously-priced asset (Thorp 2006). A skilled manager
 *     IR ≈ 0.5 (Grinold-Kahn 1999) implies Kelly ≈ 0.25² = 6.25% per
 *     opportunity. Half Kelly therefore ≈ 3.1% — we use 3% as the
 *     gate, slightly below the threshold to allow marginal-skill picks.
 *
 *   - "Material drawdown" threshold (8%): institutional risk-budget
 *     convention. Probability gate of 25% means: only initiate when
 *     fewer than 1 in 4 simulated paths breach the drawdown threshold.
 *
 * Sell signals are never demoted — once thesis damage triggers in the
 * primary engine, the discipline path stays intact.
 */
const TWENTY_DAY_EQUITY_PREMIUM_PACE = (0.055 * 20) / 252 * 100  // ≈ 0.44%
const BUY_GATE_MIN_RETURN_PCT = TWENTY_DAY_EQUITY_PREMIUM_PACE * 1.5  // ≈ 0.66%
const KELLY_SKILLED_GATE = 0.03  // 3%, Grinold-Kahn IR=0.5 implied
const MATERIAL_DRAWDOWN_PROB_GATE = 0.25  // 1 in 4 paths

function refineActionWithQuant(signal: DecisionSignal, quant: QuantOverlayInput): Action {
  const action = signal.action
  const mean = quant.monteCarloMean
  const probDown8 = quant.monteCarloProbDown8

  if (action === 'Buy Now') {
    if (
      mean < BUY_GATE_MIN_RETURN_PCT ||
      quant.kellyHalfFraction < KELLY_SKILLED_GATE ||
      probDown8 > MATERIAL_DRAWDOWN_PROB_GATE
    ) {
      return 'Accumulate'
    }
  }
  if (action === 'Accumulate') {
    // Demote to Hold when expected return is negative or drawdown
    // probability exceeds the institutional convention by another 5pp.
    if (mean < 0 || probDown8 > MATERIAL_DRAWDOWN_PROB_GATE + 0.05) return 'Hold'
  }
  if (action === 'Hold') {
    // Promote to Trim when MC paints a clearly negative picture: mean
    // worse than half the equity-premium pace AND drawdown prob > 35%.
    if (mean < -BUY_GATE_MIN_RETURN_PCT && probDown8 > MATERIAL_DRAWDOWN_PROB_GATE + 0.10) {
      return 'Trim'
    }
  }
  if (action === 'Trim') {
    // Promote to Sell when MC mean is materially negative AND drawdown
    // prob exceeds 45% (essentially coin-flip-against the position).
    if (mean < -3 * BUY_GATE_MIN_RETURN_PCT && probDown8 > MATERIAL_DRAWDOWN_PROB_GATE + 0.20) {
      return 'Sell'
    }
  }
  return action
}

function appendQuantEvidence(
  existing: string[],
  quant: QuantOverlayInput,
  action: Action,
): string[] {
  const next = [...existing]
  const sign = quant.monteCarloMean >= 0 ? '+' : ''
  next.unshift(
    `Monte Carlo 20d: ${sign}${quant.monteCarloMean.toFixed(1)}% expected, ` +
      `P(up >5%) ${(quant.monteCarloProbUp5 * 100).toFixed(0)}%, ` +
      `P(down >8%) ${(quant.monteCarloProbDown8 * 100).toFixed(0)}%.`,
  )
  if (quant.kellyHalfFraction > 0.02) {
    next.unshift(
      `Half Kelly ${(quant.kellyHalfFraction * 100).toFixed(1)}% — quant-recommended capital fraction.`,
    )
  }
  if (quant.riskNeutralProbUp != null && action !== 'Sell' && action !== 'Avoid') {
    next.unshift(
      `BSM risk-neutral P(up) ${(quant.riskNeutralProbUp * 100).toFixed(0)}% — what options market is pricing.`,
    )
  }
  return next.slice(0, 5)
}

function appendQuantRiskFlags(existing: string[], quant: QuantOverlayInput): string[] {
  const next = [...existing]
  if (quant.monteCarloProbDown8 > 0.3) {
    next.unshift(
      `Monte Carlo P(down >8%) ${(quant.monteCarloProbDown8 * 100).toFixed(0)}% — sized down accordingly.`,
    )
  }
  if (quant.monteCarloMean < -2) {
    next.unshift(`Negative expected return: ${quant.monteCarloMean.toFixed(1)}% over 20d (Monte Carlo mean).`)
  }
  return next.slice(0, 5)
}
