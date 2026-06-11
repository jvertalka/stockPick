import { cachedFetchDailyBars, type DailyBar } from './marketData'
import {
  fitGradientBoosting,
  fitMarkovRegime,
  logReturns,
  predictGradientBoosting,
  pearsonCorrelation,
  type GradientBoostingModel,
} from './quantMath'

export type { DailyBar }

/**
 * Historical backtest harness — turns Yahoo's multi-year bar history into
 * labeled training data without waiting for live snapshots to accumulate.
 *
 * Implements quant-finance ML best practices that were missing in the
 * earlier version:
 *
 *   1. NO LOOK-AHEAD: features at date t use ONLY bars ≤ t-1. Forward
 *      returns at date t use bars between t and t+horizon. The two sets
 *      never overlap.
 *
 *   2. CROSS-SECTIONAL NORMALIZATION: at each date, Z-score features
 *      across the cross-section so the model learns relative effects
 *      rather than absolute scales.
 *
 *   3. PURGED + EMBARGOED WALK-FORWARD: per López de Prado (2018),
 *      "Advances in Financial Machine Learning". Drop training samples
 *      whose forward-return window overlaps the test window, and skip
 *      a buffer of days between train and test to prevent serial-correlation
 *      leakage.
 *
 *   4. BASELINE COMPARISONS: every walk-forward step also evaluates
 *      naive baselines (random, 12-month momentum, equal-weight) so IC
 *      numbers have context.
 *
 *   5. TRANSACTION COST MODELING: long-short returns are reported both
 *      gross AND net of a configurable per-trade cost (default 10 bps).
 *
 *   6. DRAWDOWN METRICS: max drawdown, time-under-water computed from
 *      the cumulative long-short return series.
 *
 *   7. PERMUTATION FEATURE IMPORTANCE: shuffles each feature in the test
 *      set and measures the IC drop, so we can see which features actually
 *      contribute and which are noise (Breiman 2001).
 */

/**
 * Default liquid-universe ticker set for backtests. Shared by the
 * BacktestPanel UI and the Node CLI (tools/backtest-cli.ts) so both
 * train on the same names. ~200 large/mid-cap US names across all
 * GICS sectors (wider cross-sections shrink the variance of per-date
 * Z-scores and of quintile portfolio returns) plus 8 index/sector ETFs
 * kept for regime context — ETFs carry no fundamentals and use the
 * neutral fundamental encoding.
 */
export const DEFAULT_BACKTEST_TICKERS = [
  // Mega/large tech + communication
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AVGO',
  'ORCL', 'CRM', 'ADBE', 'CSCO', 'NFLX', 'AMD', 'INTC', 'QCOM',
  'TXN', 'IBM', 'NOW', 'PANW', 'MU', 'AMAT', 'LRCX', 'KLAC',
  'SNPS', 'CDNS', 'CRWD', 'FTNT', 'WDAY', 'TEAM', 'DDOG', 'NET',
  'ZS', 'MDB', 'SNOW', 'PLTR', 'UBER', 'ABNB', 'SHOP', 'SQ',
  'PYPL', 'INTU', 'ANET', 'MRVL', 'NXPI', 'ON', 'ADI', 'MCHP',
  'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'EA', 'TTWO',
  // Financials
  'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'BLK',
  'SCHW', 'AXP', 'C', 'USB', 'PNC', 'TFC', 'COF', 'BK',
  'SPGI', 'MCO', 'ICE', 'CME', 'AON', 'MMC', 'PGR', 'TRV',
  'ALL', 'MET', 'PRU', 'AIG', 'KKR', 'BX', 'APO', 'COIN',
  // Health care
  'UNH', 'JNJ', 'LLY', 'MRK', 'ABBV', 'PFE', 'TMO', 'ABT',
  'DHR', 'BMY', 'AMGN', 'GILD', 'VRTX', 'REGN', 'ISRG', 'SYK',
  'BSX', 'MDT', 'EW', 'ZTS', 'CI', 'CVS', 'ELV', 'HUM',
  'MCK', 'BIIB', 'MRNA', 'HCA',
  // Consumer staples + discretionary
  'WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'NKE', 'MCD',
  'LOW', 'TGT', 'SBUX', 'CMG', 'BKNG', 'MAR', 'HLT', 'YUM',
  'DG', 'DLTR', 'ROST', 'TJX', 'ORLY', 'AZO', 'EL', 'CL',
  'KMB', 'GIS', 'KHC', 'HSY', 'STZ', 'MDLZ', 'MO', 'PM',
  'F', 'GM', 'RIVN', 'LULU',
  // Energy + materials
  'XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'MPC', 'VLO',
  'OXY', 'PXD', 'KMI', 'WMB', 'LIN', 'APD', 'SHW', 'ECL',
  'FCX', 'NEM', 'NUE', 'DOW',
  // Industrials
  'CAT', 'BA', 'DE', 'GE', 'HON', 'UNP', 'UPS', 'FDX',
  'RTX', 'LMT', 'NOC', 'GD', 'MMM', 'EMR', 'ETN', 'ITW',
  'PH', 'CMI', 'PCAR', 'CSX', 'NSC', 'WM', 'RSG', 'URI',
  'PWR', 'GWW', 'TT', 'CARR',
  // Utilities + real estate
  'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL',
  'PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'SPG', 'O', 'WELL',
  // Index/sector ETFs (regime context; no fundamentals)
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV',
]

export type HorizonKey = 5 | 20 | 60 | 120

export type HistoricalSample = {
  ticker: string
  asOf: string
  asOfIndex: number   // bar index within the ticker's series — needed for purging
  features: number[]
  rawFeatures: number[]  // pre-normalization values for diagnostic display
  // Forward returns at multiple horizons for multi-horizon ensemble training
  forwardReturn5d: number
  forwardReturn20d: number
  forwardReturn60d: number
  forwardReturn120d: number
  /** ISO dates when each horizon's label window CLOSES (bars[i+h].date).
   * Purging must compare in LABEL space: 20 trading days ≈ 28 calendar
   * days, so "asOf + horizon·86400s" calendar arithmetic under-purges and
   * leaks the first test-window days into training labels. */
  labelEnd5d: string
  labelEnd20d: string
  labelEnd60d: string
  labelEnd120d: string
  /** Index-aligned with rawFeatures; true where the value was imputed
   * (cross-sectional median) rather than observed. Diagnostics that read
   * raw feature values (the distress canary, size-quintile cuts) must
   * skip imputed entries or they dilute toward the median. Absent when
   * nothing was imputed. */
  imputedMask?: boolean[]
  /** Listed under 3 years at formation — the Fama-French (2004) new-list
   * failure window; drives the delisting-haircut bound separately from
   * the size screen. */
  youngAtFormation?: boolean
  /** Survivorship cohort AT FORMATION (assigned per cross-section date):
   *  'survivorPrivileged' = listed < 3y (Fama-French 2004 new-list
   *  failure window) OR bottom size-quintile of that date's cross-section
   *  (Hou-Xue-Zhang 2020 microcap screen) — where survivor bias lives.
   *  'core' = established-then. 'noFundamentals' = ETFs/non-filers,
   *  excluded from cohort diagnostics. */
  cohort?: 'core' | 'survivorPrivileged' | 'noFundamentals'
}

export const ENSEMBLE_HORIZONS: HorizonKey[] = [5, 20, 60, 120]

export type FeatureNames = string[]

/**
 * Feature set inspired by Gu-Kelly-Xiu 2020 ("Empirical Asset Pricing
 * via Machine Learning"). 30 price-derived features that span:
 *   - Momentum (multiple horizons + relative strength variants)
 *   - Mean reversion (short-horizon)
 *   - Volatility (multiple horizons + asymmetry)
 *   - Liquidity (volume + Amihud-style illiquidity proxy)
 *   - Trend strength (proximity to highs/lows + SMA distances)
 *   - Distributional moments (skew + kurtosis at multiple horizons)
 *   - Range/extension metrics
 */
export const HISTORICAL_FEATURE_NAMES: FeatureNames = [
  // Momentum (5)
  'momentum_5d',
  'momentum_20d',
  'momentum_60d',
  'momentum_120d',
  'momentum_252d',
  // Reversal (2)
  'reversal_1d',
  'reversal_5d',
  // Volatility (4)
  'volatility_20d',
  'volatility_60d',
  'volatility_252d',
  'vol_change_60_20',  // ratio of recent vs longer-window vol (vol regime)
  // Liquidity (4)
  'volume_trend_20_60',
  'volume_trend_5_20',
  'volume_zscore_60d',
  'amihud_illiquidity_20d',  // Amihud (2002) illiquidity proxy
  // Trend strength (5)
  'price_to_high_60d',
  'price_to_low_60d',
  'price_to_high_252d',
  'sma_50_distance',
  'sma_200_distance',
  // Cross-trend (2)
  'sma_50_over_200',          // golden-cross / death-cross indicator
  'last_close_over_sma_20',
  // Drawdown (2)
  'drawdown_60d',             // current drawdown from 60d peak
  'drawdown_252d',
  // Distributional moments (4)
  'skew_60d',
  'kurt_60d',
  'skew_252d',
  'kurt_252d',
  // Range/extension (2)
  'range_compression_20d',    // (high-low)/close, last 20d
  'price_velocity_acceleration',  // 20d vel - 60d vel (momentum of momentum)
  // Survivorship-visibility price features (2):
  //   listing_age_years — years since the first available bar. Fama-French
  //   (2004, "New lists") show ~half of new lists fail within 10 years;
  //   a survivors-only sample keeps just the winners, so young-at-sample
  //   names are where the bias concentrates.
  //   log_price_level — CHS (2008) PRICE variable; penny/microstructure flag.
  'listing_age_years',
  'log_price_level',
  // Fundamentals (13) — point-in-time from SEC EDGAR filings, keyed by
  // FILED date so a sample at date t only sees statements filed <= t.
  // Directions per the factor literature: profitability (Novy-Marx 2013),
  // value as earnings yield (Basu 1977), issuance (Pontiff-Woodgate 2008),
  // leverage (Fama-French 1992), size (Banz 1981), distress (Altman 1983
  // Z''; Bharath-Shumway 2008 naive distance-to-default — also the
  // survivorship "canary": CHS 2008 establish distress → LOW returns, so
  // a measured distress → HIGH returns relation flags survivor bias).
  // Values winsorized at fixed economic bounds (Gu-Kelly-Xiu 2020).
  ...[
    'fund_revenue_growth_yoy',
    'fund_revenue_accel',
    'fund_net_margin',
    'fund_margin_trend',
    'fund_fcf_margin',
    'fund_leverage',
    'fund_roe',
    'fund_share_change_yoy',
    'fund_earnings_yield',
    'fund_filing_age',
    'fund_log_market_cap',
    'fund_altman_z',
    'fund_naive_dd',
  ],
]

export const FUNDAMENTAL_FEATURE_COUNT = 13
/** Sentinel for fund_filing_age when a name has no usable filing at the
 * sample date (ETF, non-filer, or pre-coverage history). */
export const FUNDAMENTAL_MISSING_AGE_DAYS = 400

export function computeFeaturesAtDate(
  bars: DailyBar[],
  dateIndex: number,
  fundamentals?: FundamentalsTimeline | null,
  options?: {
    /** First bar of the FULL (untrimmed) history, for listing age when
     * `bars` was trimmed to a backtest window. Defaults to bars[0]. */
    firstBarDateMs?: number
  },
): number[] | null {
  if (dateIndex < 252) return null  // need 252 bars for the 1-year features
  const window = bars.slice(0, dateIndex)
  const closes = window.map((bar) => bar.close)
  const highs = window.map((bar) => bar.high)
  const lows = window.map((bar) => bar.low)
  const volumes = window.map((bar) => bar.volume)
  if (closes.length < 252) return null
  const lastClose = closes[closes.length - 1]
  if (lastClose <= 0) return null

  const ret = (lookback: number): number => {
    const start = closes[closes.length - 1 - lookback]
    if (!start || start <= 0) return 0
    return (closes[closes.length - 1] / start - 1) * 100
  }

  const meanOf = (arr: number[]): number =>
    arr.reduce((sum, value) => sum + value, 0) / Math.max(1, arr.length)

  const stdOf = (arr: number[]): number => {
    const m = meanOf(arr)
    const v = arr.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(1, arr.length)
    return Math.sqrt(v)
  }

  // Log-return series at multiple windows
  const buildLogReturns = (window: number): number[] => {
    const slice = closes.slice(-window - 1)
    const out: number[] = []
    for (let i = 1; i < slice.length; i++) {
      if (slice[i] > 0 && slice[i - 1] > 0) {
        out.push(Math.log(slice[i] / slice[i - 1]))
      }
    }
    return out
  }
  const log20 = buildLogReturns(20)
  const log60 = buildLogReturns(60)
  const log252 = buildLogReturns(252)

  // Volatility at multiple horizons (annualized)
  const vol20 = stdOf(log20) * Math.sqrt(252)
  const vol60 = stdOf(log60) * Math.sqrt(252)
  const vol252 = stdOf(log252) * Math.sqrt(252)
  const volChange60to20 = vol60 > 0 ? vol20 / vol60 : 1

  // Volume features
  const vol5 = meanOf(volumes.slice(-5))
  const vol20vol = meanOf(volumes.slice(-20))
  const vol60vol = meanOf(volumes.slice(-60))
  const volumeTrend20_60 = vol60vol > 0 ? vol20vol / vol60vol : 1
  const volumeTrend5_20 = vol20vol > 0 ? vol5 / vol20vol : 1
  const volume60Mean = meanOf(volumes.slice(-60))
  const volume60Std = stdOf(volumes.slice(-60))
  const volumeZScore = volume60Std > 0 ? (volumes[volumes.length - 1] - volume60Mean) / volume60Std : 0

  // Amihud (2002) illiquidity: |return| / dollar volume, averaged
  const dollarVolumes = volumes.slice(-20).map((v, i) => v * closes[closes.length - 20 + i])
  const absReturns20 = log20.map(Math.abs)
  let amihud = 0
  if (dollarVolumes.length === absReturns20.length && dollarVolumes.length > 0) {
    let sum = 0
    let n = 0
    for (let i = 0; i < absReturns20.length; i++) {
      if (dollarVolumes[i] > 0) {
        sum += absReturns20[i] / dollarVolumes[i]
        n++
      }
    }
    amihud = n > 0 ? (sum / n) * 1e8 : 0  // scaled for numeric stability
  }

  // Trend strength
  const high60 = Math.max(...closes.slice(-60))
  const low60 = Math.min(...closes.slice(-60))
  const high252 = Math.max(...closes.slice(-252))

  const sma20 = meanOf(closes.slice(-20))
  const sma50 = meanOf(closes.slice(-50))
  const sma200 = meanOf(closes.slice(-200))
  const sma50Over200 = sma200 > 0 ? sma50 / sma200 - 1 : 0

  // Drawdown from rolling peak
  let peak60 = 0
  for (let i = closes.length - 60; i < closes.length; i++) {
    if (closes[i] > peak60) peak60 = closes[i]
  }
  const drawdown60 = peak60 > 0 ? (lastClose - peak60) / peak60 : 0

  let peak252 = 0
  for (let i = closes.length - 252; i < closes.length; i++) {
    if (closes[i] > peak252) peak252 = closes[i]
  }
  const drawdown252 = peak252 > 0 ? (lastClose - peak252) / peak252 : 0

  // Distributional moments at 60d and 252d
  const moments = (logs: number[]): { skew: number; exKurt: number } => {
    const m = meanOf(logs)
    const m2 = logs.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(1, logs.length)
    const m3 = logs.reduce((sum, value) => sum + (value - m) ** 3, 0) / Math.max(1, logs.length)
    const m4 = logs.reduce((sum, value) => sum + (value - m) ** 4, 0) / Math.max(1, logs.length)
    return {
      skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0,
      exKurt: m2 > 0 ? m4 / (m2 * m2) - 3 : 0,
    }
  }
  const moments60 = moments(log60)
  const moments252 = moments(log252)

  // Range compression: (high - low) / close, averaged over 20d
  let rangeCompression = 0
  for (let i = closes.length - 20; i < closes.length; i++) {
    if (closes[i] > 0) rangeCompression += (highs[i] - lows[i]) / closes[i]
  }
  rangeCompression /= 20

  // Price velocity acceleration: 20d momentum - 60d momentum (per day rate)
  const velocity20 = ret(20) / 20
  const velocity60 = ret(60) / 60
  const velocityAccel = velocity20 - velocity60

  return [
    // Momentum (5)
    ret(5),
    ret(20),
    ret(60),
    ret(120),
    ret(252),
    // Reversal (2)
    ret(1),
    ret(5),
    // Volatility (4)
    vol20,
    vol60,
    vol252,
    volChange60to20,
    // Liquidity (4)
    volumeTrend20_60,
    volumeTrend5_20,
    volumeZScore,
    amihud,
    // Trend strength (5)
    lastClose / Math.max(1e-8, high60),
    lastClose / Math.max(1e-8, low60),
    lastClose / Math.max(1e-8, high252),
    lastClose / Math.max(1e-8, sma50) - 1,
    lastClose / Math.max(1e-8, sma200) - 1,
    // Cross-trend (2)
    sma50Over200,
    lastClose / Math.max(1e-8, sma20) - 1,
    // Drawdown (2)
    drawdown60,
    drawdown252,
    // Distributional moments (4)
    moments60.skew,
    moments60.exKurt,
    moments252.skew,
    moments252.exKurt,
    // Range/extension (2)
    rangeCompression,
    velocityAccel,
    // Survivorship-visibility (2)
    listingAgeYears(
      options?.firstBarDateMs ?? Date.parse(bars[0].date),
      bars[dateIndex].date,
    ),
    Math.log(Math.max(0.01, lastClose)),
    // Fundamentals (13) — point-in-time as of this bar's date
    ...fundamentalFeaturesAt(fundamentals ?? null, bars[dateIndex].date, lastClose, {
      vol252Annualized: vol252,
      return252Pct: ret(252),
    }),
  ]
}

function listingAgeYears(firstBarDateMs: number, isoDate: string): number {
  const dateMs = Date.parse(isoDate)
  if (!Number.isFinite(firstBarDateMs) || !Number.isFinite(dateMs)) return 0
  // Cap at 25y — beyond that age is not a differentiator (FF2004's
  // new-list failure risk is front-loaded in the first decade).
  return Math.min(25, Math.max(0, (dateMs - firstBarDateMs) / (365.25 * 86_400_000)))
}

/* =========================================================================
   Point-in-time fundamentals (SEC EDGAR via the backend's
   /fundamentals/history endpoint)
   -------------------------------------------------------------------------
   The endpoint returns EVERY filing occurrence (originals + restatements)
   with both the period `end` and the `filed` date. At a sample date t we
   use only rows with filed <= t, then per period keep the latest such
   filing — exactly what an investor could have known at t. TTM totals use
   latest-FY + post-FY quarters − matching prior-year quarters (US filers
   never file Q4 flows separately), falling back to four contiguous
   quarters, then to the latest annual.
   ========================================================================= */

type FundamentalRow = {
  end: number      // period end, ms epoch
  start: number | null
  filed: number    // ms epoch
  value: number
  span: 'quarter' | 'annual' | 'instant' | 'other'
}

type FundamentalSnapshot = {
  filed: number
  revenueGrowthYoY: number | null
  revenueAccel: number | null
  netMargin: number | null
  marginTrend: number | null
  fcfMargin: number | null
  leverage: number | null
  roe: number | null
  shareChangeYoY: number | null
  ttmNetIncome: number | null
  shares: number | null
  // Distress-model inputs (Altman 1983 Z''; Bharath-Shumway 2008)
  totalAssets: number | null
  totalLiabilities: number | null
  bookEquity: number | null
  currentAssets: number | null
  currentLiabilities: number | null
  retainedEarnings: number | null
  ttmOperatingIncome: number | null
  shortTermDebt: number | null
  longTermDebt: number | null
}

export class FundamentalsTimeline {
  private readonly snapshots: FundamentalSnapshot[]

  private constructor(snapshots: FundamentalSnapshot[]) {
    this.snapshots = snapshots
  }

  /** Latest snapshot whose filing date is STRICTLY before `dateMs`.
   * Strict, not <=: most 10-K/10-Qs hit EDGAR after the 16:00 close, and
   * our forward returns are measured from that day's close — a same-day
   * filing would let features see statement contents the market first
   * traded the NEXT day. Standard practice is a one-day fundamentals lag. */
  at(dateMs: number): FundamentalSnapshot | null {
    let lo = 0
    let hi = this.snapshots.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.snapshots[mid].filed < dateMs) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best >= 0 ? this.snapshots[best] : null
  }

  get size(): number {
    return this.snapshots.length
  }

  /** Build from the backend's /fundamentals/history payload: one snapshot
   * per distinct filing date, each computed using only rows filed by then. */
  static fromHistory(payload: {
    series?: Record<string, Array<Record<string, unknown>>>
  }): FundamentalsTimeline {
    const series = payload.series ?? {}
    const parse = (key: string): FundamentalRow[] =>
      (series[key] ?? [])
        .map((row) => ({
          end: Date.parse(String(row.end ?? '')),
          start: row.start ? Date.parse(String(row.start)) : null,
          filed: Date.parse(String(row.filed ?? '')),
          value: Number(row.value),
          span: (row.span as FundamentalRow['span']) ?? 'other',
        }))
        .filter((row) => Number.isFinite(row.end) && Number.isFinite(row.filed) && Number.isFinite(row.value))

    const revenue = parse('revenue')
    const netIncome = parse('netIncome')
    const cashFlow = parse('operatingCashFlow')
    const capex = parse('capex')
    const assets = parse('assets')
    const liabilities = parse('liabilities')
    const equity = parse('equity')
    const shares = parse('shares')
    const currentAssets = parse('currentAssets')
    const currentLiabilities = parse('currentLiabilities')
    const retainedEarnings = parse('retainedEarnings')
    const operatingIncome = parse('operatingIncome')
    const shortTermDebt = parse('shortTermDebt')
    const longTermDebt = parse('longTermDebt')

    const filedDates = new Set<number>()
    for (const rows of [revenue, netIncome, cashFlow, assets, equity, shares]) {
      for (const row of rows) filedDates.add(row.filed)
    }
    const sortedFiled = [...filedDates].sort((a, b) => a - b)

    const snapshots: FundamentalSnapshot[] = []
    for (const filed of sortedFiled) {
      const rev = visibleAt(revenue, filed)
      const ni = visibleAt(netIncome, filed)
      const cfo = visibleAt(cashFlow, filed)
      const cap = visibleAt(capex, filed)
      const ast = visibleAt(assets, filed)
      const lia = visibleAt(liabilities, filed)
      const eq = visibleAt(equity, filed)
      const sh = visibleAt(shares, filed)
      const curAst = visibleAt(currentAssets, filed)
      const curLia = visibleAt(currentLiabilities, filed)
      const retEarn = visibleAt(retainedEarnings, filed)
      const opInc = visibleAt(operatingIncome, filed)
      const stDebt = visibleAt(shortTermDebt, filed)
      const ltDebt = visibleAt(longTermDebt, filed)

      const ttmRev = ttmOf(rev)
      const ttmNi = ttmOf(ni)
      const latestRevEnd = rev.length > 0 ? rev[rev.length - 1].end : null

      let revenueGrowthYoY: number | null = null
      let revenueAccel: number | null = null
      let marginTrend: number | null = null
      if (ttmRev != null && latestRevEnd != null) {
        const priorEnd = shiftYears(latestRevEnd, -1)
        const priorTtm = ttmOf(rev, priorEnd)
        if (priorTtm != null && priorTtm > 0) {
          revenueGrowthYoY = (ttmRev / priorTtm - 1) * 100
          const lagEnd = shiftMonths(latestRevEnd, -3)
          const lagTtm = ttmOf(rev, lagEnd)
          const lagPrior = ttmOf(rev, shiftYears(lagEnd, -1))
          if (lagTtm != null && lagPrior != null && lagPrior > 0) {
            revenueAccel = revenueGrowthYoY - (lagTtm / lagPrior - 1) * 100
          }
        }
        if (ttmNi != null && ttmRev > 0) {
          const priorNi = ttmOf(ni, priorEnd)
          const priorRev = ttmOf(rev, priorEnd)
          if (priorNi != null && priorRev != null && priorRev > 0) {
            marginTrend = (ttmNi / ttmRev) * 100 - (priorNi / priorRev) * 100
          }
        }
      }

      const netMargin =
        ttmRev != null && ttmRev > 0 && ttmNi != null ? (ttmNi / ttmRev) * 100 : null

      let fcfMargin: number | null = null
      const ttmCfo = ttmOf(cfo)
      if (ttmCfo != null && ttmRev != null && ttmRev > 0) {
        const ttmCap = ttmOf(cap) ?? 0
        fcfMargin = ((ttmCfo - Math.abs(ttmCap)) / ttmRev) * 100
      }

      const lastAsset = lastInstant(ast)
      const lastLiability = lastInstant(lia)
      const leverage =
        lastAsset != null && lastAsset > 0 && lastLiability != null
          ? (lastLiability / lastAsset) * 100
          : null

      const lastEquity = lastInstant(eq)
      const roe =
        ttmNi != null && lastEquity != null && lastEquity > 0
          ? (ttmNi / lastEquity) * 100
          : null

      const lastShares = lastInstant(sh)
      let shareChangeYoY: number | null = null
      if (sh.length >= 2 && lastShares != null && lastShares > 0) {
        const latest = sh[sh.length - 1]
        const prior = closestByEnd(sh, shiftYears(latest.end, -1), 100)
        if (prior && prior.value > 0 && prior !== latest) {
          shareChangeYoY = (latest.value / prior.value - 1) * 100
        }
      }

      snapshots.push({
        filed,
        revenueGrowthYoY,
        revenueAccel,
        netMargin,
        marginTrend,
        fcfMargin,
        leverage,
        roe,
        shareChangeYoY,
        ttmNetIncome: ttmNi,
        shares: lastShares,
        totalAssets: lastInstant(ast),
        totalLiabilities: lastInstant(lia),
        bookEquity: lastInstant(eq),
        currentAssets: lastInstant(curAst),
        currentLiabilities: lastInstant(curLia),
        retainedEarnings: lastInstant(retEarn),
        ttmOperatingIncome: ttmOf(opInc),
        shortTermDebt: lastInstant(stDebt),
        longTermDebt: lastInstant(ltDebt),
      })
    }
    return new FundamentalsTimeline(snapshots)
  }
}

/** Rows filed on or before `dateMs`, deduped per period keeping the latest
 * such filing, sorted by period end — the point-in-time view. */
function visibleAt(rows: FundamentalRow[], dateMs: number): FundamentalRow[] {
  const byPeriod = new Map<string, FundamentalRow>()
  for (const row of rows) {
    if (row.filed > dateMs) continue
    const key = `${row.start ?? 'instant'}:${row.end}`
    const existing = byPeriod.get(key)
    if (!existing || row.filed > existing.filed) byPeriod.set(key, row)
  }
  return [...byPeriod.values()].sort((a, b) => a.end - b.end)
}

/** TTM flow total at `asOf` (default: latest available period end). */
function ttmOf(rows: FundamentalRow[], asOf?: number): number | null {
  const eligible = asOf == null ? rows : rows.filter((row) => row.end <= asOf)
  if (eligible.length === 0) return null
  const annuals = eligible.filter((row) => row.span === 'annual')
  const quarters = eligible.filter((row) => row.span === 'quarter')
  if (annuals.length > 0) {
    const fy = annuals[annuals.length - 1]
    const after = quarters.filter((q) => q.end > fy.end)
    if (after.length === 0) return fy.value
    let sumAfter = 0
    let sumPrior = 0
    let matched = true
    for (const quarter of after) {
      sumAfter += quarter.value
      const prior = closestByEnd(quarters, shiftYears(quarter.end, -1), 21)
      if (!prior) {
        matched = false
        break
      }
      sumPrior += prior.value
    }
    if (matched) return fy.value + sumAfter - sumPrior
  }
  if (quarters.length >= 4) {
    const last4 = quarters.slice(-4)
    const spanDays = (last4[3].end - last4[0].end) / 86_400_000
    if (spanDays >= 240 && spanDays <= 320) {
      return last4.reduce((sum, row) => sum + row.value, 0)
    }
  }
  return annuals.length > 0 ? annuals[annuals.length - 1].value : null
}

function lastInstant(rows: FundamentalRow[]): number | null {
  return rows.length > 0 ? rows[rows.length - 1].value : null
}

function closestByEnd(
  rows: FundamentalRow[],
  targetMs: number,
  toleranceDays: number,
): FundamentalRow | null {
  let best: FundamentalRow | null = null
  let bestDelta = toleranceDays + 1
  for (const row of rows) {
    const delta = Math.abs(row.end - targetMs) / 86_400_000
    if (delta < bestDelta) {
      best = row
      bestDelta = delta
    }
  }
  return best
}

function shiftYears(ms: number, years: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate())
}

function shiftMonths(ms: number, months: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate())
}

/** Winsorize, mapping missing to NaN. NaN survives until the per-date
 * median imputation pass (training) or the feature-mean imputation
 * (live single-name prediction) — a 0 here would masquerade as data. */
const clampTo = (value: number | null, lo: number, hi: number): number =>
  value == null || !Number.isFinite(value) ? Number.NaN : Math.max(lo, Math.min(hi, value))

/** The 13 fundamental feature values at a sample date. Missing values are
 * NaN (imputed downstream); fund_filing_age uses its cap sentinel so the
 * model can tell "no data" apart from "average company". */
function fundamentalFeaturesAt(
  fundamentals: FundamentalsTimeline | null,
  isoDate: string,
  lastClose: number,
  market: { vol252Annualized: number; return252Pct: number },
): number[] {
  const dateMs = Date.parse(isoDate)
  const snap = fundamentals && Number.isFinite(dateMs) ? fundamentals.at(dateMs) : null
  if (!snap) {
    return [
      Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
      Number.NaN, Number.NaN, Number.NaN, Number.NaN,
      FUNDAMENTAL_MISSING_AGE_DAYS,
      Number.NaN, Number.NaN, Number.NaN,
    ]
  }
  const marketCap =
    snap.shares != null && snap.shares > 0 && lastClose > 0
      ? snap.shares * lastClose
      : null
  const earningsYield =
    snap.ttmNetIncome != null && marketCap != null
      ? (snap.ttmNetIncome / marketCap) * 100
      : null
  const ageDays = Math.min(
    FUNDAMENTAL_MISSING_AGE_DAYS,
    Math.max(0, (dateMs - snap.filed) / 86_400_000),
  )

  // Altman (1983) Z'' — the four-ratio variant, comparable across
  // sectors because it drops Sales/Assets:
  //   Z'' = 6.56·WC/TA + 3.26·RE/TA + 6.72·EBIT/TA + 1.05·BookE/TL
  // Computed only when every PIT input exists; partial Z is meaningless.
  let altmanZ: number | null = null
  if (
    snap.totalAssets != null && snap.totalAssets > 0 &&
    snap.totalLiabilities != null && snap.totalLiabilities > 0 &&
    snap.currentAssets != null && snap.currentLiabilities != null &&
    snap.retainedEarnings != null && snap.ttmOperatingIncome != null &&
    snap.bookEquity != null
  ) {
    altmanZ =
      6.56 * ((snap.currentAssets - snap.currentLiabilities) / snap.totalAssets) +
      3.26 * (snap.retainedEarnings / snap.totalAssets) +
      6.72 * (snap.ttmOperatingIncome / snap.totalAssets) +
      1.05 * (snap.bookEquity / snap.totalLiabilities)
  }

  // Bharath-Shumway (2008, RFS) "naive" distance-to-default — the
  // closed-form Merton (1974) proxy they show performs as well as the
  // iterated model. Their default barrier is DEBT, not liabilities:
  // F = debt in current liabilities + ½·long-term debt (Compustat
  // DLC + 0.5·DLTT). Using total liabilities would overstate F several-
  // fold for high-payables retailers and collapse ln((E+F)/F) for banks
  // (deposits), turning the measure into a sector dummy. When a filer
  // reports no debt tags at all (true zero-debt companies do exist) we
  // require at least one debt series to have EVER existed; otherwise DD
  // is null rather than computed off a wrong barrier.
  // naive σ_D = 0.05 + 0.25·σ_E; σ_V is the value-weighted blend;
  // DD = [ln((E+F)/F) + (μ − ½σ_V²)] / σ_V at T = 1y, with μ = the
  // trailing 1-year equity return (their r_{it−1}).
  let naiveDd: number | null = null
  const hasDebtData = snap.shortTermDebt != null || snap.longTermDebt != null
  if (marketCap != null && hasDebtData) {
    const F = (snap.shortTermDebt ?? 0) + 0.5 * (snap.longTermDebt ?? 0)
    if (F > 0) {
      const E = marketCap
      const sigmaE = Math.max(0.05, market.vol252Annualized)
      const naiveSigmaD = 0.05 + 0.25 * sigmaE
      const sigmaV = (E / (E + F)) * sigmaE + (F / (E + F)) * naiveSigmaD
      const mu = market.return252Pct / 100
      naiveDd = (Math.log((E + F) / F) + (mu - 0.5 * sigmaV * sigmaV)) / sigmaV
    } else {
      // Debt tags exist but read zero — effectively default-remote.
      naiveDd = 15
    }
  }

  return [
    clampTo(snap.revenueGrowthYoY, -100, 300),
    clampTo(snap.revenueAccel, -100, 100),
    clampTo(snap.netMargin, -100, 100),
    clampTo(snap.marginTrend, -50, 50),
    clampTo(snap.fcfMargin, -100, 100),
    clampTo(snap.leverage, 0, 200),
    clampTo(snap.roe, -150, 150),
    clampTo(snap.shareChangeYoY, -50, 50),
    clampTo(earningsYield, -25, 25),
    ageDays,
    clampTo(marketCap != null ? Math.log(marketCap) : null, 10, 32),
    clampTo(altmanZ, -15, 15),
    clampTo(naiveDd, -5, 15),
  ]
}

/** In-module cache: one history fetch per ticker per process. */
const fundamentalsCache = new Map<string, Promise<FundamentalsTimeline | null>>()

export function fetchFundamentalsTimeline(ticker: string): Promise<FundamentalsTimeline | null> {
  const cached = fundamentalsCache.get(ticker)
  if (cached) return cached
  const promise = (async () => {
    try {
      const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
      const response = await fetch(
        `${base}/fundamentals/history?symbol=${encodeURIComponent(ticker)}`,
        { headers: { Accept: 'application/json' } },
      )
      if (!response.ok) return null  // 404 = ETF / non-filer — features stay neutral
      const payload = (await response.json()) as Parameters<typeof FundamentalsTimeline.fromHistory>[0]
      const timeline = FundamentalsTimeline.fromHistory(payload)
      return timeline.size > 0 ? timeline : null
    } catch {
      return null
    }
  })()
  fundamentalsCache.set(ticker, promise)
  return promise
}

export function computeForwardReturn(
  bars: DailyBar[],
  dateIndex: number,
  horizon: number,
): number | null {
  const future = dateIndex + horizon
  if (future >= bars.length) return null
  const start = bars[dateIndex].close
  const end = bars[future].close
  if (start <= 0 || end <= 0) return null
  return (end / start - 1) * 100
}

export type DatasetBuildResult = {
  samples: HistoricalSample[]
  diagnostics: {
    tickersAttempted: number
    tickersWithUsableBars: number
    tickersWithZeroBars: number
    tickersBelowMinBars: number
    /** Names whose samples carry real point-in-time EDGAR fundamentals. */
    tickersWithFundamentals?: number
    perTickerSummary: Array<{
      ticker: string
      bars: number
      samplesGenerated: number
      reason?: string
    }>
  }
}

/**
 * Replace NaN fundamental values with the cross-sectional MEDIAN of the
 * same feature on the same date (so after Z-scoring a missing value sits
 * at ≈0, neutral). Median, not zero: for log-scale features like market
 * cap a hard zero would read as "a one-dollar company". Sparse dates
 * (off-grid tickers) fall back to the GLOBAL median of the feature, never
 * to a literal 0 that may sit outside the winsorization bounds. Each
 * imputed cell is recorded on sample.imputedMask so raw-value diagnostics
 * (distress canary, size-quintile cuts) can skip synthetic values.
 */
function imputeMissingWithDateMedians(samples: HistoricalSample[]): void {
  if (samples.length === 0) return
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  const featureCount = samples[0].rawFeatures.length
  // Global per-feature medians over observed values (fallback for dates
  // whose whole cross-section is missing a feature).
  const globalMedians = new Array(featureCount).fill(0)
  for (let f = 0; f < featureCount; f++) {
    const observed = samples
      .map((sample) => sample.rawFeatures[f])
      .filter((value) => !Number.isNaN(value))
      .sort((a, b) => a - b)
    globalMedians[f] = observed.length > 0 ? observed[Math.floor(observed.length / 2)] : 0
  }
  for (const indices of byDate.values()) {
    for (let f = 0; f < featureCount; f++) {
      const present: number[] = []
      for (const idx of indices) {
        const value = samples[idx].rawFeatures[f]
        if (!Number.isNaN(value)) present.push(value)
      }
      if (present.length === indices.length) continue  // nothing missing
      present.sort((a, b) => a - b)
      const median =
        present.length > 0 ? present[Math.floor(present.length / 2)] : globalMedians[f]
      for (const idx of indices) {
        if (Number.isNaN(samples[idx].rawFeatures[f])) {
          const sample = samples[idx]
          sample.rawFeatures[f] = median
          sample.features[f] = median
          sample.imputedMask ??= new Array(featureCount).fill(false)
          sample.imputedMask[f] = true
        }
      }
    }
  }
}

/** Index helpers for survivorship cohort assignment. */
const LISTING_AGE_FEATURE_INDEX = HISTORICAL_FEATURE_NAMES.indexOf('listing_age_years')
const LOG_MKTCAP_FEATURE_INDEX = HISTORICAL_FEATURE_NAMES.indexOf('fund_log_market_cap')

/**
 * Tag each sample's survivorship cohort AT ITS FORMATION DATE:
 * 'survivorPrivileged' = listed under 3 years (Fama-French 2004: new-list
 * failure risk is front-loaded) OR in the bottom size quintile of that
 * date's cross-section (Hou-Xue-Zhang 2020: microcaps drive most anomaly
 * returns and are exactly what a survivors-only sample misrepresents).
 * Runs AFTER imputation (which never touches fund_filing_age), so
 * "no fundamentals at this date" is detected via the filing-age sentinel:
 * it equals FUNDAMENTAL_MISSING_AGE_DAYS exactly when no filing existed.
 * Those samples (ETFs/non-filers) are 'noFundamentals' and sit outside
 * the cohort diagnostics.
 */
function assignSurvivorshipCohorts(samples: HistoricalSample[]): void {
  if (samples.length === 0) return
  if (LISTING_AGE_FEATURE_INDEX < 0 || LOG_MKTCAP_FEATURE_INDEX < 0) return
  const ageIdx = HISTORICAL_FEATURE_NAMES.indexOf('fund_filing_age')
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  for (const indices of byDate.values()) {
    // Bottom size quintile threshold for this date — OBSERVED market caps
    // only; an imputed (median) cap is by construction never "small".
    const caps: number[] = []
    for (const idx of indices) {
      const sample = samples[idx]
      const hasFundamentals = sample.rawFeatures[ageIdx] < FUNDAMENTAL_MISSING_AGE_DAYS
      const capImputed = sample.imputedMask?.[LOG_MKTCAP_FEATURE_INDEX] === true
      if (hasFundamentals && !capImputed) {
        caps.push(sample.rawFeatures[LOG_MKTCAP_FEATURE_INDEX])
      }
    }
    caps.sort((a, b) => a - b)
    const quintileCut = caps.length >= 10 ? caps[Math.floor(caps.length * 0.2)] : -Infinity
    for (const idx of indices) {
      const sample = samples[idx]
      const hasFundamentals = sample.rawFeatures[ageIdx] < FUNDAMENTAL_MISSING_AGE_DAYS
      if (!hasFundamentals) {
        sample.cohort = 'noFundamentals'
        continue
      }
      const young = sample.rawFeatures[LISTING_AGE_FEATURE_INDEX] < 3
      const capImputed = sample.imputedMask?.[LOG_MKTCAP_FEATURE_INDEX] === true
      const smallThen =
        !capImputed && sample.rawFeatures[LOG_MKTCAP_FEATURE_INDEX] <= quintileCut
      sample.youngAtFormation = young
      sample.cohort = young || smallThen ? 'survivorPrivileged' : 'core'
    }
  }
}

/**
 * Apply cross-sectional Z-score normalization to features WITHIN each
 * as-of date. After this, every feature has mean 0 and stddev 1 across
 * stocks at any given date — the model learns relative ranking rather
 * than absolute level.
 */
function applyCrossSectionalNormalization(samples: HistoricalSample[]): void {
  // Group sample indices by date
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  if (samples.length === 0) return
  const featureCount = samples[0].rawFeatures.length
  const MIN_GROUP_FOR_ZSCORE = 5

  // Compute global mean/std as fallback for sparse-date groups
  const globalMean = new Array(featureCount).fill(0)
  const globalStd = new Array(featureCount).fill(1)
  for (let f = 0; f < featureCount; f++) {
    const values = samples.map((sample) => sample.rawFeatures[f])
    const m = values.reduce((sum, value) => sum + value, 0) / values.length
    const v = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length
    globalMean[f] = m
    globalStd[f] = Math.sqrt(Math.max(1e-12, v))
  }

  for (const indices of byDate.values()) {
    if (indices.length < MIN_GROUP_FOR_ZSCORE) {
      // Sparse date — fall back to global Z-score so we don't lose the
      // sample's information. This is honest about the limitation.
      indices.forEach((idx) => {
        for (let f = 0; f < featureCount; f++) {
          samples[idx].features[f] = (samples[idx].rawFeatures[f] - globalMean[f]) / globalStd[f]
        }
      })
      continue
    }
    for (let f = 0; f < featureCount; f++) {
      const values = indices.map((idx) => samples[idx].rawFeatures[f])
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      const sigma = Math.sqrt(Math.max(1e-12, variance))
      indices.forEach((idx) => {
        samples[idx].features[f] = (samples[idx].rawFeatures[f] - mean) / sigma
      })
    }
  }
}

export async function buildHistoricalDataset(
  tickers: string[],
  options: {
    cadenceDays?: number
    minBars?: number
    range?: '1y' | '2y' | '5y' | '10y' | '15y' | 'max'
    onProgress?: (current: number, total: number, ticker: string) => void
  } = {},
): Promise<DatasetBuildResult> {
  const cadence = options.cadenceDays ?? 10
  const minBars = options.minBars ?? 400  // 252 history + 120 forward + buffer
  const range = options.range ?? '5y'
  // ALWAYS fetch max and trim client-side: (a) Yahoo has no 15y range,
  // and (b) listing_age_years must come from the true first bar for every
  // range, or a 5y-trained model caps mature names' age at 5 while live
  // prediction (which fetches max) reports the true age — train/serve skew.
  const trimByRange: Record<string, number | null> = {
    '1y': 252, '2y': 504, '5y': 1260, '10y': 2520, '15y': 3780, max: null,
  }
  const fetchRange = 'max'
  const trimBars = trimByRange[range] ?? null
  const samples: HistoricalSample[] = []
  const perTickerSummary: DatasetBuildResult['diagnostics']['perTickerSummary'] = []
  let tickersWithUsableBars = 0
  let tickersWithZeroBars = 0
  let tickersBelowMinBars = 0
  let tickersWithFundamentals = 0

  for (let t = 0; t < tickers.length; t++) {
    const ticker = tickers[t]
    options.onProgress?.(t, tickers.length, ticker)
    let bars: DailyBar[]
    try {
      bars = await cachedFetchDailyBars(ticker, fetchRange)
    } catch {
      bars = []
    }
    // Listing age must come from the FULL history even when the backtest
    // window is trimmed — a 1998 listing trimmed to 15y is still old.
    const firstBarDateMs = bars.length > 0 ? Date.parse(bars[0].date) : Number.NaN
    if (trimBars != null && bars.length > trimBars) {
      bars = bars.slice(-trimBars)
    }
    if (bars.length === 0) {
      tickersWithZeroBars++
      perTickerSummary.push({ ticker, bars: 0, samplesGenerated: 0, reason: 'fetch failed or empty' })
      continue
    }
    if (bars.length < minBars) {
      tickersBelowMinBars++
      perTickerSummary.push({
        ticker,
        bars: bars.length,
        samplesGenerated: 0,
        reason: `< ${minBars} bars`,
      })
      continue
    }
    // Point-in-time fundamentals (null for ETFs/non-filers — the ten
    // fundamental features stay at their neutral encoding for them).
    const fundamentals = await fetchFundamentalsTimeline(ticker)
    if (fundamentals) tickersWithFundamentals++
    let generated = 0
    // Need 252 bars history (for 252d momentum, vol, moments) + 120 future
    // (longest horizon in the ensemble)
    for (let i = 252; i < bars.length - 120; i += cadence) {
      const features = computeFeaturesAtDate(bars, i, fundamentals, { firstBarDateMs })
      if (!features) continue
      const fwd5 = computeForwardReturn(bars, i, 5)
      const fwd20 = computeForwardReturn(bars, i, 20)
      const fwd60 = computeForwardReturn(bars, i, 60)
      const fwd120 = computeForwardReturn(bars, i, 120)
      if (fwd5 == null || fwd20 == null || fwd60 == null || fwd120 == null) continue
      samples.push({
        ticker,
        asOf: bars[i].date,
        asOfIndex: i,
        features: [...features],
        rawFeatures: [...features],
        forwardReturn5d: fwd5,
        forwardReturn20d: fwd20,
        forwardReturn60d: fwd60,
        forwardReturn120d: fwd120,
        labelEnd5d: bars[i + 5].date,
        labelEnd20d: bars[i + 20].date,
        labelEnd60d: bars[i + 60].date,
        labelEnd120d: bars[i + 120].date,
      })
      generated++
    }
    tickersWithUsableBars++
    perTickerSummary.push({ ticker, bars: bars.length, samplesGenerated: generated })
  }

  // Impute missing fundamentals with per-date cross-sectional medians
  // (must run BEFORE normalization so NaNs never reach the Z-scores),
  // then tag survivorship cohorts, then normalize.
  imputeMissingWithDateMedians(samples)
  assignSurvivorshipCohorts(samples)
  applyCrossSectionalNormalization(samples)

  return {
    samples,
    diagnostics: {
      tickersAttempted: tickers.length,
      tickersWithUsableBars,
      tickersWithZeroBars,
      tickersBelowMinBars,
      tickersWithFundamentals,
      perTickerSummary,
    },
  }
}

/**
 * Per-feature mean/std of the RAW (pre-normalization) feature values.
 * These are what live single-name prediction must normalize against —
 * training Z-scores cross-sectionally per date, and the global raw stats
 * are the stationary approximation of that transform for a lone ticker.
 * Compute AFTER pruning so the columns line up with the stored model.
 */
export function computeFeatureStats(samples: HistoricalSample[]): {
  means: number[]
  stds: number[]
} {
  if (samples.length === 0) return { means: [], stds: [] }
  const featureCount = samples[0].rawFeatures.length
  const means = new Array(featureCount).fill(0)
  const stds = new Array(featureCount).fill(1)
  for (let f = 0; f < featureCount; f++) {
    const values = samples.map((sample) => sample.rawFeatures[f])
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    means[f] = mean
    stds[f] = Math.sqrt(Math.max(1e-12, variance))
  }
  return { means, stds }
}

/* =========================================================================
   Walk-forward validation with purging + embargo
   ========================================================================= */

export type WalkForwardResult = {
  trainSize: number
  testSize: number
  testStartDate: string
  testEndDate: string
  informationCoefficient: number
  spearmanIc: number
  hitRate: number
  longShortReturnGross: number
  longShortReturnNet: number   // net of transaction costs
  longShortSharpe: number
  predictedDecileReturns: number[]
  // Baseline comparisons
  baselineRandomIc: number
  baselineMomentumIc: number
  // Drawdown
  cumulativeReturn: number
  maxDrawdown: number
  // Feature importance — IC drop when each feature is permuted
  featureImportance: number[]
  // Split-conformal interval diagnostics (Romano-Patterson-Candès 2019):
  // share of test actuals inside the conformalized 80% interval (target
  // 0.80) and the interval's mean width in return points. Absent when
  // interval training was skipped.
  intervalCoverage80?: number
  intervalMeanWidthPct?: number
  conformalOffsetPct?: number
  /** Per-test-sample detail for survivorship diagnostics (cohort splits,
   * era analysis, distress canary). Captured only when the caller sets
   * captureTestDetails — the CLI does, the in-app worker doesn't. */
  testDetails?: Array<{
    ticker: string
    asOf: string
    cohort: HistoricalSample['cohort']
    /** Listed < 3y at formation — the subset the FF2004 attrition rate
     * actually describes (the size-only privileged members delist far
     * less often). */
    young: boolean
    prediction: number
    actual: number
  }>
}

/**
 * Days since the same ticker's earliest sample, used for purging + embargo
 * decisions. We pre-compute and cache it on the sample.
 */
type IndexedSample = HistoricalSample & { sortIndex: number }

function indexSamples(samples: HistoricalSample[]): IndexedSample[] {
  const sorted = [...samples].sort((a, b) => a.asOf.localeCompare(b.asOf))
  return sorted.map((sample, idx) => ({ ...sample, sortIndex: idx }))
}

/**
 * Run a single walk-forward step with PURGE + EMBARGO.
 *   - Train set: samples with sortIndex < splitIndex
 *   - Test set:  samples with splitIndex ≤ sortIndex < splitIndex + testSize
 *   - Purge:     drop training samples whose forward-return window OVERLAPS
 *                the earliest test sample's date
 *   - Embargo:   drop training samples within `embargoDays` of test start
 */
export function walkForwardStep(
  samples: IndexedSample[],
  splitIndex: number,
  testSize: number,
  options: {
    embargoDays?: number
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
    /** Train q10/q90 models + split-conformal calibration per step (two
     * extra GBT fits). Default true; the nested-CV inner loop turns it
     * off for speed. */
    computeIntervals?: boolean
    /** Column of the long-horizon momentum feature used as the naive
     * baseline. Callers that prune/reorder features MUST pass the real
     * index (featureNames.indexOf('momentum_252d')) or the "edge over
     * momentum" metric silently compares against the wrong feature. */
    baselineMomentumFeatureIndex?: number
    /** Keep per-test-sample (cohort, prediction, actual) for survivorship
     * diagnostics. Off by default (memory). */
    captureTestDetails?: boolean
  } = {},
): WalkForwardResult | null {
  if (splitIndex <= 0 || splitIndex + testSize > samples.length) return null
  const embargoDays = options.embargoDays ?? 5
  const horizonDays = options.horizonDays ?? 20
  const txCostBps = options.txCostBps ?? 10

  const testSamples = samples.slice(splitIndex, splitIndex + testSize)
  if (testSamples.length < 10) return null
  const testStartDate = testSamples[0].asOf
  const testStartTime = new Date(testStartDate).getTime()

  // PURGE in LABEL space: drop train samples whose 20-trading-day label
  // window (labelEnd20d, an actual bar date) reaches the test start —
  // calendar arithmetic on horizonDays under-purges because 20 trading
  // days span ~28 calendar days. EMBARGO: additionally drop samples
  // formed within embargoDays of the test start (López de Prado 2018).
  const candidateTrain = samples.slice(0, splitIndex)
  const embargoCutoff = testStartTime - embargoDays * 24 * 3600 * 1000
  const trainSamples = candidateTrain.filter(
    (sample) =>
      sample.labelEnd20d < testStartDate &&
      new Date(sample.asOf).getTime() <= embargoCutoff,
  )
  if (trainSamples.length < 50) return null

  const trainFeatures = trainSamples.map((sample) => sample.features)
  const trainTargets = trainSamples.map((sample) => sample.forwardReturn20d)
  const model = fitGradientBoosting(trainFeatures, trainTargets, options.modelOptions ?? {})

  const predictions = testSamples.map((sample) => predictGradientBoosting(model, sample.features))
  const actuals = testSamples.map((sample) => sample.forwardReturn20d)

  // SPLIT-CONFORMAL 80% INTERVALS (Romano, Patterson, Candès 2019 —
  // "Conformalized Quantile Regression", NeurIPS). Fit q10/q90 on the
  // older 75% of train; on the newest 25% (calibration — still entirely
  // before the test window, so no leakage) compute conformity scores
  // E = max(q10(x) − y, y − q90(x)); the finite-sample (1−α) quantile of
  // E widens the test interval to [q10−Q, q90+Q], which guarantees ≥80%
  // marginal coverage under exchangeability. We then MEASURE realized
  // test coverage instead of asserting it.
  let intervalCoverage80: number | undefined
  let intervalMeanWidthPct: number | undefined
  let conformalOffsetPct: number | undefined
  if (options.computeIntervals !== false && trainSamples.length >= 200) {
    const calibrationSize = Math.max(50, Math.floor(trainSamples.length * 0.25))
    const calibration = trainSamples.slice(trainSamples.length - calibrationSize)
    // Purge the quantile-training tail whose label windows reach into the
    // calibration slice — conformity scores must come from outcomes the
    // quantile models never trained against (exchangeability, Romano et
    // al. 2019), and that purge too must happen in label space.
    const calibrationStartDate = calibration[0].asOf
    const properTrain = trainSamples
      .slice(0, trainSamples.length - calibrationSize)
      .filter((sample) => sample.labelEnd20d < calibrationStartDate)
    // Skip intervals when the purge leaves too little quantile-training
    // data — weak quantile heads would just report meaningless coverage.
    if (properTrain.length >= 100) {
      const properFeatures = properTrain.map((sample) => sample.features)
      const properTargets = properTrain.map((sample) => sample.forwardReturn20d)
      const q10Model = fitGradientBoosting(properFeatures, properTargets, {
        ...options.modelOptions,
        quantile: 0.1,
      })
      const q90Model = fitGradientBoosting(properFeatures, properTargets, {
        ...options.modelOptions,
        quantile: 0.9,
      })
      const scores = calibration.map((sample) => {
        const lo = predictGradientBoosting(q10Model, sample.features)
        const hi = predictGradientBoosting(q90Model, sample.features)
        return Math.max(lo - sample.forwardReturn20d, sample.forwardReturn20d - hi)
      })
      scores.sort((a, b) => a - b)
      const n = scores.length
      const rank = Math.min(n - 1, Math.ceil((n + 1) * 0.8) - 1)
      const offset = scores[rank]
      let covered = 0
      let widthSum = 0
      for (const sample of testSamples) {
        const lo = predictGradientBoosting(q10Model, sample.features) - offset
        const hi = predictGradientBoosting(q90Model, sample.features) + offset
        if (sample.forwardReturn20d >= lo && sample.forwardReturn20d <= hi) covered++
        widthSum += hi - lo
      }
      intervalCoverage80 = covered / testSamples.length
      intervalMeanWidthPct = widthSum / testSamples.length
      conformalOffsetPct = offset
    }
  }

  const ic = pearsonCorrelation(predictions, actuals)
  const spearmanIc = spearmanCorrelation(predictions, actuals)
  const hitRate =
    predictions.filter((value, idx) => Math.sign(value) === Math.sign(actuals[idx])).length /
    predictions.length

  // Long-short quintile portfolio
  const indexed = predictions.map((value, idx) => ({ pred: value, actual: actuals[idx] }))
  indexed.sort((left, right) => right.pred - left.pred)
  const quintileSize = Math.max(1, Math.floor(indexed.length / 5))
  const topQ = indexed.slice(0, quintileSize)
  const bottomQ = indexed.slice(-quintileSize)
  const topMean = topQ.reduce((sum, item) => sum + item.actual, 0) / topQ.length
  const bottomMean = bottomQ.reduce((sum, item) => sum + item.actual, 0) / bottomQ.length
  const longShortReturnGross = topMean - bottomMean
  // Net: subtract 2× tx cost (one for long, one for short)
  const longShortReturnNet = longShortReturnGross - (2 * txCostBps) / 100
  const meanActual = actuals.reduce((sum, value) => sum + value, 0) / actuals.length
  const stdActual = Math.sqrt(
    actuals.reduce((sum, value) => sum + (value - meanActual) ** 2, 0) / actuals.length,
  )
  const longShortSharpe = stdActual > 0 ? (longShortReturnNet / stdActual) * Math.sqrt(252 / horizonDays) : 0

  // Decile bucket means
  indexed.sort((left, right) => left.pred - right.pred)
  const decileSize = Math.max(1, Math.floor(indexed.length / 10))
  const decileReturns: number[] = []
  for (let d = 0; d < 10; d++) {
    const start = d * decileSize
    const end = d === 9 ? indexed.length : start + decileSize
    const slice = indexed.slice(start, end)
    decileReturns.push(
      slice.length > 0 ? slice.reduce((sum, item) => sum + item.actual, 0) / slice.length : 0,
    )
  }

  // BASELINE: random predictions
  const randomPredictions = predictions.map(() => Math.random())
  const baselineRandomIc = pearsonCorrelation(randomPredictions, actuals)

  // BASELINE: long-horizon momentum ranking (Jegadeesh-Titman)
  const momentumIndex = options.baselineMomentumFeatureIndex ?? 2
  const momentumPredictions = testSamples.map((sample) => sample.features[momentumIndex])
  const baselineMomentumIc = pearsonCorrelation(momentumPredictions, actuals)

  // DRAWDOWN: cumulative L/S return path through the test window
  // (approximate — assumes equal weighting at each test point)
  const cumPath: number[] = []
  let running = 0
  for (let i = 0; i < indexed.length; i++) {
    running += indexed[i].actual / indexed.length
    cumPath.push(running)
  }
  const cumulativeReturn = running
  let peak = cumPath[0] ?? 0
  let maxDD = 0
  for (const value of cumPath) {
    if (value > peak) peak = value
    const dd = peak - value
    if (dd > maxDD) maxDD = dd
  }

  // FEATURE IMPORTANCE via permutation
  const featureCount = testSamples[0]?.features.length ?? 0
  const featureImportance: number[] = []
  for (let f = 0; f < featureCount; f++) {
    // Shuffle feature f across the test set
    const shuffled = [...actuals]  // unused, but allocates to keep shape
    void shuffled
    const permutedFeatures = testSamples.map((sample) => [...sample.features])
    const indicesShuf = Array.from({ length: testSamples.length }, (_, i) => i)
    for (let i = indicesShuf.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[indicesShuf[i], indicesShuf[j]] = [indicesShuf[j], indicesShuf[i]]
    }
    permutedFeatures.forEach((features, i) => {
      features[f] = testSamples[indicesShuf[i]].features[f]
    })
    const permutedPredictions = permutedFeatures.map((features) =>
      predictGradientBoosting(model, features),
    )
    const permutedIc = pearsonCorrelation(permutedPredictions, actuals)
    featureImportance.push(ic - permutedIc)
  }

  return {
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    testStartDate,
    testEndDate: testSamples[testSamples.length - 1].asOf,
    informationCoefficient: ic,
    spearmanIc,
    hitRate,
    longShortReturnGross,
    longShortReturnNet,
    longShortSharpe,
    predictedDecileReturns: decileReturns,
    baselineRandomIc,
    baselineMomentumIc,
    cumulativeReturn,
    maxDrawdown: maxDD,
    featureImportance,
    intervalCoverage80,
    intervalMeanWidthPct,
    conformalOffsetPct,
    testDetails: options.captureTestDetails
      ? testSamples.map((sample, idx) => ({
          ticker: sample.ticker,
          asOf: sample.asOf,
          cohort: sample.cohort,
          young: sample.youngAtFormation === true,
          prediction: predictions[idx],
          actual: actuals[idx],
        }))
      : undefined,
  }
}

function spearmanCorrelation(x: number[], y: number[]): number {
  const n = x.length
  if (n === 0 || x.length !== y.length) return 0
  const xRanks = ranks(x)
  const yRanks = ranks(y)
  return pearsonCorrelation(xRanks, yRanks)
}

function ranks(values: number[]): number[] {
  const indexed = values.map((value, idx) => ({ value, idx }))
  indexed.sort((left, right) => left.value - right.value)
  const result = new Array(values.length).fill(0)
  for (let i = 0; i < indexed.length; i++) {
    result[indexed[i].idx] = i
  }
  return result
}

export type ConfidenceInterval = { lower: number; mean: number; upper: number }

export type HorizonModelBundle = {
  horizon: HorizonKey
  /** Median (q=0.5) GBT — the point-estimate model */
  medianModel: GradientBoostingModel
  /** 10th-percentile model — lower bound of 80% prediction interval */
  p10Model: GradientBoostingModel
  /** 90th-percentile model — upper bound */
  p90Model: GradientBoostingModel
  meanIC: number
  meanHitRate: number
  icCI: ConfidenceInterval
  /** Split-conformal widening for [p10−Q, p90+Q] (Romano et al. 2019),
   * calibrated on the most recent held-out slice. Add to live intervals. */
  conformalOffsetPct?: number
  /** How many held-out samples calibrated the offset. */
  conformalCalibrationSize?: number
}

export type FullBacktestResult = {
  steps: WalkForwardResult[]
  /** Mean across horizons of mean-per-step IC for the 20d (primary) model — kept for backward compat */
  meanIC: number
  meanSpearmanIC: number
  meanHitRate: number
  meanLongShortReturnGross: number
  meanLongShortReturnNet: number
  meanLongShortSharpe: number
  meanBaselineRandomIc: number
  meanBaselineMomentumIc: number
  cumulativeReturn: number
  maxDrawdown: number
  meanFeatureImportance: number[]
  totalSamples: number
  /** Backward-compat: the 20-day median model */
  trainedModel: GradientBoostingModel
  /** Multi-horizon ensemble: one bundle per horizon, each containing
   *  median + p10 + p90 models for prediction intervals. */
  horizonBundles: HorizonModelBundle[]
  embargoDaysUsed: number
  txCostBpsUsed: number
  icCI: ConfidenceInterval
  hitRateCI: ConfidenceInterval
  longShortReturnNetCI: ConfidenceInterval
  longShortSharpeCI: ConfidenceInterval
  /** Out-of-sample coverage of the conformalized 80% interval across
   * walk-forward steps (target 0.80) with bootstrap CI, plus mean width.
   * Honest interval validation per Romano et al. 2019. */
  intervalCoverage80CI?: ConfidenceInterval
  intervalMeanWidthPct?: number
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
}

/**
 * Bootstrap a 95% confidence interval over a sample. Resamples with
 * replacement N times and returns the 2.5th / 50th / 97.5th percentiles.
 */
function bootstrapCI(values: number[], iterations = 1000): ConfidenceInterval {
  if (values.length === 0) return { lower: 0, mean: 0, upper: 0 }
  if (values.length === 1) {
    return { lower: values[0], mean: values[0], upper: values[0] }
  }
  const means: number[] = []
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(Math.random() * values.length)]
    }
    means.push(sum / values.length)
  }
  means.sort((left, right) => left - right)
  const empiricalMean = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    lower: means[Math.floor(0.025 * means.length)],
    mean: empiricalMean,
    upper: means[Math.floor(0.975 * means.length)],
  }
}

/**
 * Nested walk-forward hyperparameter search. Tries a small grid of
 * (numTrees, depth, learningRate) on a held-out slice of the early
 * training data and returns the best by mean test-window IC.
 *
 * Standard nested CV practice in time-series ML: outer loop = backtest,
 * inner loop = hyperparameter selection on training data only.
 */
function nestedCvHyperparameterSearch(
  sortedSamples: IndexedSample[],
  innerInitialTrainSize: number,
  innerTestSize: number,
  embargoDays: number,
  horizonDays: number,
): { numTrees: number; depth: number; learningRate: number } {
  const grid: Array<{ numTrees: number; depth: number; learningRate: number }> = [
    { numTrees: 30, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.10 },
    { numTrees: 50, depth: 4, learningRate: 0.05 },
    { numTrees: 80, depth: 3, learningRate: 0.05 },
    { numTrees: 80, depth: 4, learningRate: 0.05 },
  ]
  // Use only the first ~70% of the universe for inner CV (so we don't
  // peek at the outer test windows during hyperparameter selection)
  const innerScope = sortedSamples.slice(0, Math.floor(sortedSamples.length * 0.7))
  if (innerScope.length < innerInitialTrainSize + innerTestSize) {
    return grid[2]  // default fallback
  }
  let bestParams = grid[2]
  let bestMeanIc = -Infinity
  for (const params of grid) {
    let total = 0
    let count = 0
    let splitIndex = innerInitialTrainSize
    // Just take the first 3 inner steps to keep this fast
    for (let stepNum = 0; stepNum < 3 && splitIndex + innerTestSize <= innerScope.length; stepNum++) {
      const result = walkForwardStep(innerScope, splitIndex, innerTestSize, {
        embargoDays,
        horizonDays,
        modelOptions: params,
        computeIntervals: false,  // hyperparameter scoring needs IC only
      })
      if (result) {
        total += result.informationCoefficient
        count++
      }
      splitIndex += innerTestSize
    }
    if (count > 0) {
      const meanIc = total / count
      if (meanIc > bestMeanIc) {
        bestMeanIc = meanIc
        bestParams = params
      }
    }
  }
  return bestParams
}

export function runWalkForwardBacktest(
  samples: HistoricalSample[],
  options: {
    initialTrainSize?: number
    testSize?: number
    stepSize?: number
    embargoDays?: number
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
    /** When true, runs nested CV to pick hyperparameters. Default true. */
    nestedHyperparameterSearch?: boolean
    /** See walkForwardStep — pass featureNames.indexOf('momentum_252d'). */
    baselineMomentumFeatureIndex?: number
    /** See walkForwardStep.captureTestDetails. */
    captureTestDetails?: boolean
  } = {},
): FullBacktestResult | null {
  const sorted = indexSamples(samples)
  const initialTrainSize = options.initialTrainSize ?? Math.floor(sorted.length * 0.6)
  const testSize = options.testSize ?? 60
  const stepSize = options.stepSize ?? testSize
  const embargoDays = options.embargoDays ?? 5
  const horizonDays = options.horizonDays ?? 20
  const txCostBps = options.txCostBps ?? 10

  // Nested CV: pick hyperparameters using only training-side data
  let chosenParams = options.modelOptions
  if (options.nestedHyperparameterSearch !== false && !chosenParams) {
    chosenParams = nestedCvHyperparameterSearch(
      sorted,
      Math.floor(initialTrainSize * 0.7),
      Math.min(testSize, 40),
      embargoDays,
      horizonDays,
    )
  } else {
    chosenParams = chosenParams ?? { numTrees: 50, depth: 3, learningRate: 0.1 }
  }

  const steps: WalkForwardResult[] = []
  let splitIndex = initialTrainSize
  while (splitIndex + testSize <= sorted.length) {
    const result = walkForwardStep(sorted, splitIndex, testSize, {
      embargoDays,
      horizonDays,
      txCostBps,
      modelOptions: chosenParams,
      baselineMomentumFeatureIndex: options.baselineMomentumFeatureIndex,
      captureTestDetails: options.captureTestDetails,
    })
    if (result) steps.push(result)
    splitIndex += stepSize
  }
  if (steps.length === 0) return null

  // Final ensemble: per-horizon median + p10 + p90 models.
  // Median trains on ALL samples (best point estimate). Quantile models
  // train on the older 85% with the newest 15% held out as the conformal
  // calibration slice (split-conformal needs calibration data the
  // quantile models never saw — Romano et al. 2019), purged by the
  // horizon so calibration labels don't overlap quantile training.
  const allFeatures = sorted.map((sample) => sample.features)
  const targetForHorizon = (sample: HistoricalSample, horizon: HorizonKey): number => {
    if (horizon === 5) return sample.forwardReturn5d
    if (horizon === 20) return sample.forwardReturn20d
    if (horizon === 60) return sample.forwardReturn60d
    return sample.forwardReturn120d
  }
  const horizonBundles: HorizonModelBundle[] = ENSEMBLE_HORIZONS.map((horizon) => {
    const horizonTargets = sorted.map((sample) => targetForHorizon(sample, horizon))
    const medianModel = fitGradientBoosting(allFeatures, horizonTargets, {
      ...chosenParams,
      quantile: 0.5,
    })

    const calibrationSize = Math.max(100, Math.floor(sorted.length * 0.15))
    const calibrationStart = sorted.length - calibrationSize
    // Purge in LABEL space: quantile-train samples whose forward window
    // (an actual bar date — 120 trading days span ~174 calendar days)
    // reaches into the calibration slice would leak label information
    // into the models the slice is supposed to test.
    const calibrationStartDate = sorted[calibrationStart].asOf
    const labelEndFor = (sample: HistoricalSample): string =>
      horizon === 5
        ? sample.labelEnd5d
        : horizon === 20
          ? sample.labelEnd20d
          : horizon === 60
            ? sample.labelEnd60d
            : sample.labelEnd120d
    const quantileTrain = sorted
      .slice(0, calibrationStart)
      .filter((sample) => labelEndFor(sample) < calibrationStartDate)
    const quantileFeatures = quantileTrain.map((sample) => sample.features)
    const quantileTargets = quantileTrain.map((sample) => targetForHorizon(sample, horizon))
    const p10Model = fitGradientBoosting(quantileFeatures, quantileTargets, {
      ...chosenParams,
      quantile: 0.1,
    })
    const p90Model = fitGradientBoosting(quantileFeatures, quantileTargets, {
      ...chosenParams,
      quantile: 0.9,
    })
    const calibration = sorted.slice(calibrationStart)
    const scores = calibration.map((sample) => {
      const lo = predictGradientBoosting(p10Model, sample.features)
      const hi = predictGradientBoosting(p90Model, sample.features)
      const y = targetForHorizon(sample, horizon)
      return Math.max(lo - y, y - hi)
    })
    scores.sort((a, b) => a - b)
    const rank = Math.min(scores.length - 1, Math.ceil((scores.length + 1) * 0.8) - 1)
    const conformalOffsetPct = scores.length > 0 ? scores[rank] : 0

    // Estimate this horizon's IC using a quick in-sample correlation
    // between median predictions and actuals (cheap proxy — real IC
    // would need its own walk-forward at this horizon).
    const predictions = allFeatures.map((features) => predictGradientBoosting(medianModel, features))
    const inSampleIC = pearsonCorrelation(predictions, horizonTargets)
    // Approximate hit rate
    const hits = predictions.filter((value, idx) => Math.sign(value) === Math.sign(horizonTargets[idx])).length
    return {
      horizon,
      medianModel,
      p10Model,
      p90Model,
      meanIC: inSampleIC,
      meanHitRate: hits / Math.max(1, predictions.length),
      icCI: { lower: inSampleIC, mean: inSampleIC, upper: inSampleIC },
      conformalOffsetPct,
      conformalCalibrationSize: calibration.length,
    }
  })
  const trainedModel = horizonBundles.find((bundle) => bundle.horizon === 20)?.medianModel ??
    horizonBundles[0].medianModel

  const mean = (key: keyof WalkForwardResult): number =>
    steps.reduce((sum, step) => sum + (step[key] as number), 0) / steps.length

  // Cumulative return path across walk-forward steps
  let runningCumReturn = 0
  let peak = 0
  let maxDD = 0
  for (const step of steps) {
    runningCumReturn += step.longShortReturnNet
    if (runningCumReturn > peak) peak = runningCumReturn
    const dd = peak - runningCumReturn
    if (dd > maxDD) maxDD = dd
  }

  // Average feature importance
  const featureCount = steps[0]?.featureImportance.length ?? 0
  const meanFeatureImportance: number[] = new Array(featureCount).fill(0)
  for (const step of steps) {
    step.featureImportance.forEach((value, idx) => {
      meanFeatureImportance[idx] += value
    })
  }
  for (let f = 0; f < featureCount; f++) {
    meanFeatureImportance[f] /= steps.length
  }

  // Bootstrap 95% CIs over the per-step distribution
  const icCI = bootstrapCI(steps.map((step) => step.informationCoefficient))
  const hitRateCI = bootstrapCI(steps.map((step) => step.hitRate))
  const longShortReturnNetCI = bootstrapCI(steps.map((step) => step.longShortReturnNet))
  const longShortSharpeCI = bootstrapCI(steps.map((step) => step.longShortSharpe))
  const coverageSteps = steps.filter((step) => step.intervalCoverage80 != null)
  const intervalCoverage80CI =
    coverageSteps.length > 0
      ? bootstrapCI(coverageSteps.map((step) => step.intervalCoverage80!))
      : undefined
  const intervalMeanWidthPct =
    coverageSteps.length > 0
      ? coverageSteps.reduce((sum, step) => sum + (step.intervalMeanWidthPct ?? 0), 0) /
        coverageSteps.length
      : undefined

  return {
    steps,
    meanIC: mean('informationCoefficient'),
    meanSpearmanIC: mean('spearmanIc'),
    meanHitRate: mean('hitRate'),
    meanLongShortReturnGross: mean('longShortReturnGross'),
    meanLongShortReturnNet: mean('longShortReturnNet'),
    meanLongShortSharpe: mean('longShortSharpe'),
    meanBaselineRandomIc: mean('baselineRandomIc'),
    meanBaselineMomentumIc: mean('baselineMomentumIc'),
    cumulativeReturn: runningCumReturn,
    maxDrawdown: maxDD,
    meanFeatureImportance,
    totalSamples: sorted.length,
    trainedModel,
    horizonBundles,
    embargoDaysUsed: embargoDays,
    txCostBpsUsed: txCostBps,
    icCI,
    hitRateCI,
    longShortReturnNetCI,
    longShortSharpeCI,
    intervalCoverage80CI,
    intervalMeanWidthPct,
    hyperparameters: {
      numTrees: chosenParams.numTrees ?? 50,
      depth: chosenParams.depth ?? 3,
      learningRate: chosenParams.learningRate ?? 0.1,
    },
  }
}

/* =========================================================================
   Feature pruning
   -------------------------------------------------------------------------
   Permutation importance from a full run identifies dead-weight features
   (zero or negative IC contribution). Pruning them reduces the model's
   variance without losing signal (Breiman 2001; Gu-Kelly-Xiu 2020 report
   the same effect for equity-return models). The pipeline itself is
   feature-count agnostic, so pruning is a sample transformation.
   ========================================================================= */

/**
 * Survivors of the 2026-06-10 full-feature run (40 features incl. 10
 * point-in-time EDGAR fundamentals; 19,658 samples, 221 tickers, 35
 * out-of-sample steps): every feature whose mean permutation importance
 * was >= +0.001 IC. Volatility + long momentum still dominate; five
 * fundamental features earned their place — revenue acceleration and
 * revenue growth ranked 6th-7th overall (Jegadeesh-Livnat 2006 revenue
 * momentum), then leverage, net margin, and earnings yield. Notably
 * fund_margin_trend measured most harmful of all 40 (-0.011) and
 * momentum_20d/60d + Amihud, survivors of the smaller 2026-05-12 study
 * (5,340 samples, 60 names), measured negative on the wider universe.
 */
export const PRUNED_FEATURE_NAMES: string[] = [
  'volatility_252d',
  'volatility_20d',
  'momentum_252d',
  'volatility_60d',
  'price_to_low_60d',
  'fund_revenue_accel',
  'fund_revenue_growth_yoy',
  'momentum_5d',
  'fund_leverage',
  'momentum_120d',
  'fund_net_margin',
  'price_to_high_252d',
  'range_compression_20d',
  'sma_200_distance',
  'sma_50_distance',
  'price_to_high_60d',
  'vol_change_60_20',
  'fund_earnings_yield',
]

/**
 * Returns new samples whose feature vectors contain only the named
 * features (in the given order). Names must exist in
 * HISTORICAL_FEATURE_NAMES; unknown names throw so a typo can't silently
 * train on the wrong columns.
 */
export function pruneSampleFeatures(
  samples: HistoricalSample[],
  keepNames: string[] = PRUNED_FEATURE_NAMES,
): { samples: HistoricalSample[]; featureNames: string[] } {
  const indices = keepNames.map((name) => {
    const idx = HISTORICAL_FEATURE_NAMES.indexOf(name)
    if (idx < 0) throw new Error(`Unknown feature name: ${name}`)
    return idx
  })
  const pruned = samples.map((sample) => ({
    ...sample,
    features: indices.map((idx) => sample.features[idx]),
    rawFeatures: indices.map((idx) => sample.rawFeatures[idx]),
  }))
  return { samples: pruned, featureNames: [...keepNames] }
}

/* =========================================================================
   Regime labeling (Hamilton 1989 two-state Markov switching)
   -------------------------------------------------------------------------
   Labels each walk-forward step with the market's volatility regime at
   the step's start, using ONLY market data up to that date (the Markov
   model is refit per step on the trailing window, and the filtered
   posterior P(high-vol) at the final observation is causal). This lets
   us measure whether the model's predictive power is regime-dependent —
   and, if it is, gate live ML usage on the current regime.
   ========================================================================= */

export type RegimeLabel = 'low-vol' | 'high-vol'

export type RegimeStepLabel = {
  testStartDate: string
  regime: RegimeLabel
  highProb: number
}

export function labelStepsByRegime(
  steps: WalkForwardResult[],
  marketBars: DailyBar[],
): RegimeStepLabel[] {
  return steps.map((step) => {
    // Bars strictly before the test window start — point-in-time.
    const history = marketBars.filter((bar) => bar.date < step.testStartDate)
    const closes = history.map((bar) => bar.close)
    const returns = logReturns(closes)
    if (returns.length < 60) {
      return { testStartDate: step.testStartDate, regime: 'low-vol', highProb: 0 }
    }
    // Trailing 2y window keeps the two states responsive to current
    // conditions instead of averaging over a decade.
    const trailing = returns.slice(-504)
    const state = fitMarkovRegime(trailing)
    const regime: RegimeLabel = state.currentHighProb > 0.5 ? 'high-vol' : 'low-vol'
    return { testStartDate: step.testStartDate, regime, highProb: state.currentHighProb }
  })
}

export type RegimeBreakdown = Record<
  RegimeLabel,
  {
    steps: number
    meanIC: number
    meanHitRate: number
    meanLongShortReturnNet: number
  }
>

export function summarizeStepsByRegime(
  steps: WalkForwardResult[],
  labels: RegimeStepLabel[],
): RegimeBreakdown {
  const byDate = new Map(labels.map((label) => [label.testStartDate, label.regime]))
  const buckets: Record<RegimeLabel, WalkForwardResult[]> = {
    'low-vol': [],
    'high-vol': [],
  }
  for (const step of steps) {
    const regime = byDate.get(step.testStartDate) ?? 'low-vol'
    buckets[regime].push(step)
  }
  const summarize = (group: WalkForwardResult[]) => ({
    steps: group.length,
    meanIC:
      group.reduce((sum, step) => sum + step.informationCoefficient, 0) / Math.max(1, group.length),
    meanHitRate: group.reduce((sum, step) => sum + step.hitRate, 0) / Math.max(1, group.length),
    meanLongShortReturnNet:
      group.reduce((sum, step) => sum + step.longShortReturnNet, 0) / Math.max(1, group.length),
  })
  return {
    'low-vol': summarize(buckets['low-vol']),
    'high-vol': summarize(buckets['high-vol']),
  }
}

/* =========================================================================
   Survivorship diagnostics
   -------------------------------------------------------------------------
   A backtest on TODAY'S universe quietly assumes you'd have known in 2012
   which firms would survive (Brown-Goetzmann-Ibbotson-Ross 1992). Without
   point-in-time constituents (CRSP), the bias can't be removed — but it
   can be made VISIBLE:

   1. Cohorts at formation (Hou-Xue-Zhang 2020): compare the model inside
      'core' (established-then) vs 'survivorPrivileged' (young or
      bottom-size-quintile then). Edge concentrated in the privileged
      cohort is partly an artifact.
   2. Era stratification (Linnainmaa-Roberts 2018): bias grows with depth,
      so performance that improves monotonically going back in time is the
      survivorship fingerprint.
   3. Distress canary (Campbell-Hilscher-Szilagyi 2008): real data shows
      distressed firms earn LOW subsequent returns. In a survivors-only
      sample the failures are missing, so distress spuriously predicts
      HIGH returns — a positive distress→return relation is the bias
      talking.
   4. Delisting haircut bound (Shumway 1997: ~-30% mean delisting return;
      Fama-French 2004: ~7%/yr attrition among young lists): how much the
      long quintile's return would shrink if its privileged members had
      failed at literature rates.
   ========================================================================= */

export type CohortMetrics = {
  windows: number
  meanIC: number
  meanLongShortPct: number
  samples: number
}

export type SurvivorshipReport = {
  cohorts: {
    core: CohortMetrics
    survivorPrivileged: CohortMetrics
    noFundamentalsSamples: number
  }
  eras: Array<{ label: string; steps: number; meanIC: number; meanLongShortNetPct: number }>
  canary: {
    naiveDdToReturnIc: number | null
    altmanZToReturnIc: number | null
    /** True when distress (LOW DD / LOW Z) predicts HIGH returns — the
     * opposite of CHS 2008 — i.e., the survivorship signature. */
    survivorshipSignature: boolean
  }
  delistingBound: {
    privilegedShareOfLongQuintile: number
    /** Share of the long quintile listed <3y at formation — the subset
     * the FF2004 attrition estimate actually describes. */
    youngShareOfLongQuintile: number
    haircutPpPerWindow: number
  }
}

/** Deposit/policy-reserve-heavy financials in the default universe.
 * Bharath-Shumway (2008) and CHS (2008) both EXCLUDE financials from
 * their samples: liability structure makes leverage-based distress
 * measures a sector dummy there, not a default signal. The distress
 * canary follows suit. (Payments networks, exchanges, and asset-light
 * managers — V, MA, SPGI, ICE, CME, KKR, BX, APO, COIN — stay in.) */
const CANARY_EXCLUDED_FINANCIALS = new Set([
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC', 'TFC', 'COF',
  'BK', 'SCHW', 'AXP', 'MET', 'PRU', 'AIG', 'PGR', 'TRV', 'ALL', 'MCO',
  'AON', 'MMC', 'BLK',
])

export function analyzeSurvivorship(
  samples: HistoricalSample[],
  steps: WalkForwardResult[],
): SurvivorshipReport | null {
  // Raw-feature lookups below index into FULL feature space — pruned
  // sample arrays would silently misread, so refuse them outright.
  if (
    samples.length > 0 &&
    samples[0].rawFeatures.length !== HISTORICAL_FEATURE_NAMES.length
  ) {
    return null
  }
  const details = steps.flatMap((step) => step.testDetails ?? [])
  if (details.length === 0) return null

  // --- 1. Cohort metrics, per window then averaged -----------------------
  const cohortMetrics = (cohort: 'core' | 'survivorPrivileged'): CohortMetrics => {
    const ics: number[] = []
    const longShorts: number[] = []
    let total = 0
    for (const step of steps) {
      const rows = (step.testDetails ?? []).filter((row) => row.cohort === cohort)
      total += rows.length
      if (rows.length < 15) continue
      const ic = pearsonCorrelation(
        rows.map((row) => row.prediction),
        rows.map((row) => row.actual),
      )
      ics.push(ic)
      const sorted = [...rows].sort((a, b) => b.prediction - a.prediction)
      const q = Math.max(1, Math.floor(sorted.length / 5))
      const top = sorted.slice(0, q)
      const bottom = sorted.slice(-q)
      longShorts.push(
        top.reduce((s, r) => s + r.actual, 0) / top.length -
          bottom.reduce((s, r) => s + r.actual, 0) / bottom.length,
      )
    }
    const mean = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0
    return {
      windows: ics.length,
      meanIC: mean(ics),
      meanLongShortPct: mean(longShorts),
      samples: total,
    }
  }

  // --- 2. Era stratification (3-calendar-year buckets) -------------------
  const eraBuckets = new Map<string, WalkForwardResult[]>()
  for (const step of steps) {
    const year = Number(step.testStartDate.slice(0, 4))
    const eraStart = Math.floor(year / 3) * 3
    const label = `${eraStart}-${eraStart + 2}`
    const bucket = eraBuckets.get(label) ?? []
    bucket.push(step)
    eraBuckets.set(label, bucket)
  }
  const eras = [...eraBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, bucket]) => ({
      label,
      steps: bucket.length,
      meanIC:
        bucket.reduce((s, b) => s + b.informationCoefficient, 0) / bucket.length,
      meanLongShortNetPct:
        bucket.reduce((s, b) => s + b.longShortReturnNet, 0) / bucket.length,
    }))

  // --- 3. Distress canary over out-of-sample samples ---------------------
  const firstTestDate = steps[0]?.testStartDate ?? ''
  const ddIdx = HISTORICAL_FEATURE_NAMES.indexOf('fund_naive_dd')
  const zIdx = HISTORICAL_FEATURE_NAMES.indexOf('fund_altman_z')
  const ageIdx = HISTORICAL_FEATURE_NAMES.indexOf('fund_filing_age')
  const oos = samples.filter(
    (sample) =>
      sample.asOf >= firstTestDate &&
      sample.cohort !== 'noFundamentals' &&
      sample.rawFeatures[ageIdx] < FUNDAMENTAL_MISSING_AGE_DAYS &&
      // Financials excluded per BS/CHS practice — see set above.
      !CANARY_EXCLUDED_FINANCIALS.has(sample.ticker),
  )
  const canaryIc = (featureIdx: number): number | null => {
    if (featureIdx < 0) return null
    // Only OBSERVED distress values: imputed medians would dilute the
    // correlation toward zero and fake a "no signature" verdict.
    const observed = oos.filter((sample) => sample.imputedMask?.[featureIdx] !== true)
    if (observed.length < 200) return null
    // Negate the safety measure so the correlation reads as
    // "distress → forward return"; CHS 2008 says it should be NEGATIVE.
    return pearsonCorrelation(
      observed.map((sample) => -sample.rawFeatures[featureIdx]),
      observed.map((sample) => sample.forwardReturn20d),
    )
  }
  const naiveDdToReturnIc = canaryIc(ddIdx)
  const altmanZToReturnIc = canaryIc(zIdx)
  const survivorshipSignature =
    (naiveDdToReturnIc != null && naiveDdToReturnIc > 0.02) ||
    (altmanZToReturnIc != null && altmanZToReturnIc > 0.02)

  // --- 4. Delisting haircut bound ----------------------------------------
  let longQuintileCount = 0
  let longQuintilePrivileged = 0
  let longQuintileYoung = 0
  for (const step of steps) {
    const rows = step.testDetails ?? []
    if (rows.length < 15) continue
    const sorted = [...rows].sort((a, b) => b.prediction - a.prediction)
    const q = Math.max(1, Math.floor(sorted.length / 5))
    for (const row of sorted.slice(0, q)) {
      longQuintileCount++
      if (row.cohort === 'survivorPrivileged') longQuintilePrivileged++
      if (row.young) longQuintileYoung++
    }
  }
  const privilegedShare =
    longQuintileCount > 0 ? longQuintilePrivileged / longQuintileCount : 0
  const youngShare = longQuintileCount > 0 ? longQuintileYoung / longQuintileCount : 0
  // Per-window expected haircut on the long side. The FF2004 ~7%/yr
  // attrition rate describes YOUNG lists specifically, so it applies to
  // the young share only (size-flagged mid-caps delist far less). The
  // -30% delisting return is Shumway (1997)'s NYSE/AMEX estimate;
  // Shumway-Warther (1999) find ~-55% on Nasdaq, so this is the
  // conservative end of the bound.
  const haircutPpPerWindow = youngShare * (0.07 * (20 / 252)) * 30

  return {
    cohorts: {
      core: cohortMetrics('core'),
      survivorPrivileged: cohortMetrics('survivorPrivileged'),
      noFundamentalsSamples: details.filter((row) => row.cohort === 'noFundamentals').length,
    },
    eras,
    canary: { naiveDdToReturnIc, altmanZToReturnIc, survivorshipSignature },
    delistingBound: {
      privilegedShareOfLongQuintile: privilegedShare,
      youngShareOfLongQuintile: youngShare,
      haircutPpPerWindow,
    },
  }
}
