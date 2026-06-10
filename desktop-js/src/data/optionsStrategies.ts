import type { DecisionSignal } from './decisionEngine'
import {
  cachedFetchOptionsChainNear,
  type OptionsChain,
  type TradierOption,
} from './optionsAdapter'
import { cachedComputeQuantAnalysis, type QuantAnalysis } from './quantAnalysis'
import type { StoredHolding } from './storage'

/**
 * Options Strategy Recommender
 *
 * Five strategies generated from Tradier chains + the engine's quant
 * analysis:
 *
 *   1. Covered call          — sell OTM call against owned shares for yield
 *   2. Protective put        — buy OTM put to bound downside on owned shares
 *   3. Long call             — leveraged buy when IV is cheap + engine bullish
 *   4. Vol-arb flag          — IV/RV divergence (sell premium when rich)
 *   5. Iron condor           — sell strangle + buy wings when MC predicts narrow range
 *
 * Each recommender returns 0 or 1 strategy with rationale + scoring.
 * The card combines all returns + ranks by score.
 */

export type StrategyLeg = {
  action: 'buy' | 'sell'
  type: 'call' | 'put'
  strike: number
  premium: number
  delta?: number
  quantity?: number
}

export type StrategyRecommendation = {
  name: string
  symbol: string
  expiration: string
  daysToExpiry: number
  legs: StrategyLeg[]
  netCost: number          // negative = credit received
  maxProfit: number
  maxLoss: number
  breakeven: number | [number, number]
  probabilityOfProfit?: number
  yieldOrCost: number      // % of underlying, signed (positive = yield received)
  rationale: string
  score: number            // 0-100 attractiveness rank for sorting
  citations: string[]      // research/methodology citations
}

/* =========================================================================
   Helpers
   ========================================================================= */

const midPrice = (opt: TradierOption): number | null => {
  if (opt.bid && opt.ask && opt.bid > 0 && opt.ask > 0) return (opt.bid + opt.ask) / 2
  if (opt.last && opt.last > 0) return opt.last
  return null
}

const closestByDelta = (
  options: TradierOption[],
  targetDelta: number,
): TradierOption | null => {
  return options
    .filter((opt) => opt.greeks?.delta != null && midPrice(opt) != null)
    .reduce<TradierOption | null>((closest, candidate) => {
      const candidateGap = Math.abs((candidate.greeks?.delta ?? 0) - targetDelta)
      const closestGap = closest
        ? Math.abs((closest.greeks?.delta ?? 0) - targetDelta)
        : Infinity
      return candidateGap < closestGap ? candidate : closest
    }, null)
}

/* =========================================================================
   1. Covered Call
   -------------------------------------------------------------------------
   Sell an OTM call against a long stock position. We pick a strike near
   ~25-delta (~75% probability of expiring OTM) at ~30-45 day expiration.
   The yield = premium / underlying. The "expected" yield accounts for
   assignment probability: if called away, the gain is capped at strike.
   ========================================================================= */
export function recommendCoveredCall(
  signal: DecisionSignal,
  holding: StoredHolding | null,
  chain: OptionsChain | null,
): StrategyRecommendation | null {
  if (!chain || !holding || holding.shares < 100) return null  // need 100+ shares to write a call
  const spot = chain.underlyingPrice

  // Pick the 25-delta call (typical income strategy)
  const target = closestByDelta(chain.calls, 0.25)
  if (!target || target.strike == null) return null
  const premium = midPrice(target)
  if (!premium || premium <= 0) return null
  const delta = target.greeks?.delta ?? 0.25

  // Assignment probability ≈ delta (rough approximation under BSM)
  const assignmentProb = delta
  const yieldPct = (premium / spot) * 100
  const annualizedYield = yieldPct * (365 / chain.daysToExpiry)
  // Max gain if called away: (strike - cost basis) + premium
  // For unrealized basis, use spot.
  const maxGainIfCalled = ((target.strike - spot) / spot) * 100 + yieldPct

  // Don't recommend if the engine is screaming Buy (capping upside is wrong then)
  if (signal.action === 'Buy Now') return null

  return {
    name: 'Covered Call',
    symbol: target.symbol ?? `${signal.ticker} ${target.strike}C`,
    expiration: chain.expiration,
    daysToExpiry: chain.daysToExpiry,
    legs: [
      {
        action: 'sell',
        type: 'call',
        strike: target.strike,
        premium,
        delta,
        quantity: Math.floor(holding.shares / 100),
      },
    ],
    netCost: -premium * 100,  // credit received per contract
    maxProfit: (target.strike - spot + premium) * 100,
    maxLoss: -(spot - premium) * 100,  // stock can still fall
    breakeven: spot - premium,
    probabilityOfProfit: 1 - assignmentProb * 0.5,  // approximate
    yieldOrCost: yieldPct,
    rationale:
      `Sell the ${target.strike} strike call expiring ${chain.expiration}. ` +
      `Collect $${premium.toFixed(2)}/share (${yieldPct.toFixed(2)}% in ${chain.daysToExpiry}d, ` +
      `${annualizedYield.toFixed(1)}% annualized). ` +
      `Approximate ${(assignmentProb * 100).toFixed(0)}% chance of assignment. ` +
      `If called away your total gain is ${maxGainIfCalled.toFixed(2)}%. ` +
      `Best when engine action is Hold/Trim and IV rank is elevated.`,
    score: Math.min(
      100,
      annualizedYield * 5 +              // higher annualized yield = better
      (signal.action === 'Hold' ? 20 : 0) +
      (signal.action === 'Trim' ? 10 : 0) +
      (signal.impliedVolRank >= 50 ? 15 : 0),
    ),
    citations: ['Hull (2017) ch 11 — covered call income strategy'],
  }
}

/* =========================================================================
   2. Protective Put
   -------------------------------------------------------------------------
   Buy a put 5-10% out of the money to bound downside on an owned position
   that the engine has flagged as elevated risk. Cost = put premium /
   underlying. Worth it when the engine's drawdown probability is high.
   ========================================================================= */
export function recommendProtectivePut(
  signal: DecisionSignal,
  holding: StoredHolding | null,
  chain: OptionsChain | null,
  quant: QuantAnalysis | null,
): StrategyRecommendation | null {
  if (!chain || !holding || holding.shares <= 0) return null
  // Only suggest when the engine sees elevated risk
  if (signal.riskScore < 55 && (quant?.monteCarlo.probDown8pct ?? 0) < 0.18) return null

  const spot = chain.underlyingPrice
  // Pick the put closest to -0.25 delta (~7% OTM typically)
  const target = closestByDelta(chain.puts, -0.25)
  if (!target || target.strike == null) return null
  const premium = midPrice(target)
  if (!premium || premium <= 0) return null
  const delta = target.greeks?.delta ?? -0.25

  const costPct = (premium / spot) * 100
  const annualizedCost = costPct * (365 / chain.daysToExpiry)
  // Max downside protected: spot - strike (the put pays out from strike down)
  const protectedFloorPct = ((target.strike - spot) / spot) * 100

  return {
    name: 'Protective Put',
    symbol: target.symbol ?? `${signal.ticker} ${target.strike}P`,
    expiration: chain.expiration,
    daysToExpiry: chain.daysToExpiry,
    legs: [
      {
        action: 'buy',
        type: 'put',
        strike: target.strike,
        premium,
        delta,
        quantity: Math.ceil(holding.shares / 100),
      },
    ],
    netCost: premium * 100,
    maxProfit: Infinity,  // upside on stock + put goes to zero
    maxLoss: -((spot - target.strike) + premium) * 100,
    breakeven: spot + premium,
    yieldOrCost: -costPct,
    rationale:
      `Buy the ${target.strike} put expiring ${chain.expiration} as a hedge. ` +
      `Cost $${premium.toFixed(2)}/share (${costPct.toFixed(2)}% of position, ` +
      `${annualizedCost.toFixed(1)}% annualized). ` +
      `Floors loss at ${protectedFloorPct.toFixed(2)}% below today. ` +
      `Engine flags risk score ${signal.riskScore} and ` +
      `${quant ? (quant.monteCarlo.probDown8pct * 100).toFixed(0) : '?'}% chance of >8% drop — ` +
      `this caps that tail.`,
    score: Math.min(
      100,
      (signal.riskScore - 50) * 1.2 +
      ((quant?.monteCarlo.probDown8pct ?? 0) * 100) +
      (signal.action === 'Hold' && signal.riskScore >= 60 ? 20 : 0) +
      Math.max(0, 30 - annualizedCost),  // cheaper hedges score higher
    ),
    citations: [
      'Hull (2017) ch 12 — protective put / portfolio insurance',
      'Bookstaber (1985) — option-based portfolio insurance',
    ],
  }
}

/* =========================================================================
   3. Long Call (Leveraged Buy)
   -------------------------------------------------------------------------
   Buy a 0.6-delta call (deep ITM-ish, ~70% of stock exposure for ~30% of
   the capital) when the engine signals Buy AND options are cheap by
   IV-vs-realized-vol comparison.
   ========================================================================= */
export function recommendLongCall(
  signal: DecisionSignal,
  chain: OptionsChain | null,
  quant: QuantAnalysis | null,
): StrategyRecommendation | null {
  if (!chain || !quant) return null
  if (signal.action !== 'Buy Now' && signal.action !== 'Accumulate') return null

  // IV / RV must be low (cheap options). Threshold: IV/RV < 1.15
  const iv = quant.optionsImpliedVol
  const rv = quant.garchForecastVol
  if (!iv || !rv || iv / rv > 1.15) return null

  // Pick the 0.6-delta call (60-65% delta is the typical "stock replacement"
  // sweet spot per McMillan 2011)
  const target = closestByDelta(chain.calls, 0.6)
  if (!target || target.strike == null) return null
  const premium = midPrice(target)
  if (!premium || premium <= 0) return null
  const delta = target.greeks?.delta ?? 0.6

  const spot = chain.underlyingPrice
  const costPct = (premium / spot) * 100
  const breakeven = target.strike + premium
  const breakevenMove = ((breakeven - spot) / spot) * 100
  const leverageRatio = delta / costPct * 100  // % of underlying move captured per $1 of capital

  return {
    name: 'Long Call',
    symbol: target.symbol ?? `${signal.ticker} ${target.strike}C`,
    expiration: chain.expiration,
    daysToExpiry: chain.daysToExpiry,
    legs: [
      {
        action: 'buy',
        type: 'call',
        strike: target.strike,
        premium,
        delta,
        quantity: 1,
      },
    ],
    netCost: premium * 100,
    maxProfit: Infinity,
    maxLoss: -premium * 100,
    breakeven,
    yieldOrCost: -costPct,
    rationale:
      `Buy the ${target.strike} call (Δ ${delta.toFixed(2)}) expiring ${chain.expiration}. ` +
      `Cost ${costPct.toFixed(1)}% of spot; breakeven at ${breakevenMove >= 0 ? '+' : ''}${breakevenMove.toFixed(1)}%. ` +
      `IV/RV ratio = ${(iv / rv).toFixed(2)} (< 1.15 indicates cheap options). ` +
      `Engine forecast 20d: ${signal.forecast20d.toFixed(1)}%; if realized, profit ≈ ${(delta * signal.forecast20d * (100 / costPct)).toFixed(0)}% of capital.`,
    score: Math.min(
      100,
      signal.compositeAlphaZ * 25 +
      (1.15 - iv / rv) * 50 +
      (signal.action === 'Buy Now' ? 20 : 5) +
      Math.min(20, leverageRatio / 5),
    ),
    citations: [
      'McMillan (2011) Options as a Strategic Investment — 60Δ stock replacement',
      'Xing-Zhang-Zhao (2010) — option pricing efficiency',
    ],
  }
}

/* =========================================================================
   4. Vol-Arb Flag
   -------------------------------------------------------------------------
   Not a single trade — a directional flag: IV is high or low vs realized
   vol. Tells the user whether to favor selling-premium strategies
   (covered calls, condors) or buying-premium strategies (long calls/puts,
   straddles).
   ========================================================================= */
export function flagVolArb(
  signal: DecisionSignal,
  quant: QuantAnalysis | null,
): StrategyRecommendation | null {
  if (!quant?.optionsImpliedVol || !quant.garchForecastVol) return null
  const iv = quant.optionsImpliedVol
  const rv = quant.garchForecastVol
  const ratio = iv / rv

  if (ratio > 1.3) {
    // IV is rich — favor selling premium
    return {
      name: 'Vol Arb: Sell Premium',
      symbol: signal.ticker,
      expiration: '',
      daysToExpiry: 0,
      legs: [],
      netCost: 0,
      maxProfit: 0,
      maxLoss: 0,
      breakeven: 0,
      yieldOrCost: 0,
      rationale:
        `Implied volatility (${(iv * 100).toFixed(1)}%) is ${((ratio - 1) * 100).toFixed(0)}% richer than ` +
        `GARCH-forecast realized vol (${(rv * 100).toFixed(1)}%). ` +
        `When IV/RV > 1.3, sell-premium strategies (covered calls, iron condors, cash-secured puts) ` +
        `have positive expected value on average. Buy-premium strategies (long calls/puts, straddles) ` +
        `face a vol headwind.`,
      score: Math.min(100, (ratio - 1.0) * 100),
      citations: [
        'Bakshi-Kapadia-Madan (2003) — variance risk premium',
        'Carr-Wu (2009) — variance risk premium replication',
      ],
    }
  }
  if (ratio < 0.85) {
    return {
      name: 'Vol Arb: Buy Premium',
      symbol: signal.ticker,
      expiration: '',
      daysToExpiry: 0,
      legs: [],
      netCost: 0,
      maxProfit: 0,
      maxLoss: 0,
      breakeven: 0,
      yieldOrCost: 0,
      rationale:
        `Implied volatility (${(iv * 100).toFixed(1)}%) is ${((1 - ratio) * 100).toFixed(0)}% cheaper than ` +
        `GARCH-forecast realized vol (${(rv * 100).toFixed(1)}%). ` +
        `When IV/RV < 0.85, options are statistically cheap — buy-premium strategies ` +
        `(long calls/puts, straddles) have positive expected value. Avoid covered calls right now.`,
      score: Math.min(100, (1.0 - ratio) * 100),
      citations: ['Bakshi-Kapadia-Madan (2003) — variance risk premium'],
    }
  }
  return null
}

/* =========================================================================
   5. Iron Condor
   -------------------------------------------------------------------------
   Sell an OTM call + sell an OTM put + buy further-OTM wings on both
   sides. Profitable if the stock stays inside the short strikes through
   expiration. Best when Monte Carlo predicts a narrow forward distribution
   (low sigma) AND IV is rich.
   ========================================================================= */
export function recommendIronCondor(
  signal: DecisionSignal,
  chain: OptionsChain | null,
  quant: QuantAnalysis | null,
): StrategyRecommendation | null {
  if (!chain || !quant) return null
  const mcSigma = quant.monteCarlo.sigmaReturnPct
  // Only suggest when MC predicts a narrow distribution (sigma < 5% over 20d)
  // AND options are richly priced
  if (mcSigma > 5) return null
  if (!quant.optionsImpliedVol || !quant.garchForecastVol) return null
  if (quant.optionsImpliedVol / quant.garchForecastVol < 1.1) return null

  // Short call at +0.20 delta, short put at -0.20 delta (both OTM)
  // Long call at +0.10 delta, long put at -0.10 delta (further OTM as wings)
  const shortCall = closestByDelta(chain.calls, 0.20)
  const longCall = closestByDelta(chain.calls, 0.10)
  const shortPut = closestByDelta(chain.puts, -0.20)
  const longPut = closestByDelta(chain.puts, -0.10)
  if (!shortCall || !longCall || !shortPut || !longPut) return null
  if (!shortCall.strike || !longCall.strike || !shortPut.strike || !longPut.strike) return null

  const sCallPrem = midPrice(shortCall)
  const lCallPrem = midPrice(longCall)
  const sPutPrem = midPrice(shortPut)
  const lPutPrem = midPrice(longPut)
  if (!sCallPrem || !lCallPrem || !sPutPrem || !lPutPrem) return null

  // Verify strike ordering
  if (longCall.strike <= shortCall.strike) return null
  if (longPut.strike >= shortPut.strike) return null

  const netCredit = sCallPrem - lCallPrem + sPutPrem - lPutPrem
  if (netCredit <= 0) return null  // unprofitable structure
  const callSpreadWidth = longCall.strike - shortCall.strike
  const putSpreadWidth = shortPut.strike - longPut.strike
  const maxRisk = Math.max(callSpreadWidth, putSpreadWidth) - netCredit
  if (maxRisk <= 0) return null

  const spot = chain.underlyingPrice
  const profitZoneWidth = shortCall.strike - shortPut.strike
  const profitZonePct = (profitZoneWidth / spot) * 100
  const probInside =
    Math.abs(shortCall.greeks?.delta ?? 0.20) +  // approx 1 - (call_delta + |put_delta|)
    Math.abs(shortPut.greeks?.delta ?? -0.20)
  const approxProbProfit = Math.max(0, 1 - probInside)

  return {
    name: 'Iron Condor',
    symbol: `${signal.ticker} IC ${shortPut.strike}/${shortCall.strike}`,
    expiration: chain.expiration,
    daysToExpiry: chain.daysToExpiry,
    legs: [
      { action: 'sell', type: 'put', strike: shortPut.strike, premium: sPutPrem, delta: shortPut.greeks?.delta },
      { action: 'buy', type: 'put', strike: longPut.strike, premium: lPutPrem, delta: longPut.greeks?.delta },
      { action: 'sell', type: 'call', strike: shortCall.strike, premium: sCallPrem, delta: shortCall.greeks?.delta },
      { action: 'buy', type: 'call', strike: longCall.strike, premium: lCallPrem, delta: longCall.greeks?.delta },
    ],
    netCost: -netCredit * 100,
    maxProfit: netCredit * 100,
    maxLoss: -maxRisk * 100,
    breakeven: [shortPut.strike - netCredit, shortCall.strike + netCredit],
    probabilityOfProfit: approxProbProfit,
    yieldOrCost: (netCredit / spot) * 100,
    rationale:
      `Sell put ${shortPut.strike} + buy put ${longPut.strike}, ` +
      `sell call ${shortCall.strike} + buy call ${longCall.strike}, expiring ${chain.expiration}. ` +
      `Net credit ${netCredit.toFixed(2)}; profitable if stock stays in [${shortPut.strike}, ${shortCall.strike}] ` +
      `(${profitZonePct.toFixed(1)}% wide). Monte Carlo σ ${mcSigma.toFixed(1)}% (narrow range), ` +
      `IV/RV ${(quant.optionsImpliedVol / quant.garchForecastVol).toFixed(2)} (rich premium). ` +
      `Approx ${(approxProbProfit * 100).toFixed(0)}% probability of profit.`,
    score: Math.min(
      100,
      approxProbProfit * 60 +
      (5 - mcSigma) * 4 +
      (quant.optionsImpliedVol / quant.garchForecastVol - 1) * 30,
    ),
    citations: [
      'McMillan (2011) Options as a Strategic Investment — iron condor',
      'Cohen (2015) — defined-risk credit spread strategies',
    ],
  }
}

/* =========================================================================
   Public: run all recommenders, return ranked list
   ========================================================================= */

export async function recommendStrategies(
  signal: DecisionSignal,
  holding: StoredHolding | null,
): Promise<StrategyRecommendation[]> {
  // Fetch chain at ~30 days out for income strategies; ~60 days for hedges & leverage
  const [chain30, chain60] = await Promise.all([
    cachedFetchOptionsChainNear(signal.ticker, 30),
    cachedFetchOptionsChainNear(signal.ticker, 60),
  ])
  let quant: QuantAnalysis | null
  try {
    quant = await cachedComputeQuantAnalysis(signal)
  } catch {
    quant = null
  }

  const recommendations: StrategyRecommendation[] = []
  const coveredCall = recommendCoveredCall(signal, holding, chain30)
  if (coveredCall) recommendations.push(coveredCall)
  const protectivePut = recommendProtectivePut(signal, holding, chain60, quant)
  if (protectivePut) recommendations.push(protectivePut)
  const longCall = recommendLongCall(signal, chain60, quant)
  if (longCall) recommendations.push(longCall)
  const volArb = flagVolArb(signal, quant)
  if (volArb) recommendations.push(volArb)
  const ironCondor = recommendIronCondor(signal, chain30, quant)
  if (ironCondor) recommendations.push(ironCondor)

  // Sort by score desc
  recommendations.sort((left, right) => right.score - left.score)
  return recommendations
}

const cache = new Map<string, { expires: number; value: Promise<StrategyRecommendation[]> }>()

export function cachedRecommendStrategies(
  signal: DecisionSignal,
  holding: StoredHolding | null,
): Promise<StrategyRecommendation[]> {
  const cacheKey = `${signal.ticker}:${signal.action}:${holding?.shares ?? 0}`
  const now = Date.now()
  const existing = cache.get(cacheKey)
  if (existing && existing.expires > now) return existing.value
  const value = recommendStrategies(signal, holding)
  cache.set(cacheKey, { expires: now + 5 * 60 * 1000, value })
  return value
}
