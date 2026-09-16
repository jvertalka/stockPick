import {
  cachedFetchDailyBars,
  normalizeYahooSymbol,
  type DailyBar,
  type DailyBarAdjustmentSummary,
} from './marketData'
import {
  fitBaggedGradientBoosting,
  fitGradientBoosting,
  fitRidge,
  predictBaggedGradientBoosting,
  fitMarkovRegime,
  logReturns,
  predictGradientBoosting,
  predictRidge,
  pearsonCorrelation,
  type GradientBoostingModel,
} from './quantMath'
import {
  DOLLAR_VOLUME_SIZE_PROXY,
  SIZE_TIERED_BORROW_FEE_ANNUAL,
  SIZE_TIERED_TRADING_COST,
  TRADING_DAYS_PER_YEAR,
} from './quantConfig'
import { benjaminiHochberg } from './selectionStats'
import { isotonicRegression, applyIsotonic, brierScore } from './calibration'

export type { DailyBar }

/** Bump whenever feature formulas, price semantics, missing-data transforms,
 * or label construction change. Same-named features from another version are
 * not evidence-compatible with this serving pipeline. */
export const HISTORICAL_FEATURE_PIPELINE_VERSION =
  'finance-oracle-feature-pipeline-v4-company-descriptors-2026-09-10' as const

/** Where the market cap that placed a name in a cost tier came from.
 * 'filed-cap' is a point-in-time SEC filing; 'dollar-volume-proxy' is the
 * trailing 20-day average dollar volume turned into a cap equivalent
 * (quantConfig DOLLAR_VOLUME_SIZE_PROXY); 'unavailable' means neither
 * existed and the name was charged the bottom, most expensive tier. */
export type CostTierBasis = 'filed-cap' | 'dollar-volume-proxy' | 'unavailable'

/**
 * The market cap the cost tables are read with, and where it came from.
 *
 * A filed cap always wins. Without one (every row before SEC XBRL coverage
 * begins around 2009, and every exchange-traded fund), the trailing 20-day
 * average dollar volume, which the feature builder already computes as the
 * input to the Amihud illiquidity feature, stands in for it: dollar volume
 * divided by a typical daily turnover rate gives a cap equivalent that is
 * looked up in the same tier tables. The turnover rate and its sources are
 * documented on DOLLAR_VOLUME_SIZE_PROXY; the rate is chosen at the high
 * end of the historical range so the proxy can only err toward a MORE
 * expensive tier. Until 2026-09-16 every unfiled name was charged the
 * bottom tier outright, and on the 25-name 40-year smoke run that meant
 * about 268 bps a window in the early years.
 *
 * What this touches: the net long-short return, the Sharpe ratio built on
 * it, and the cost report lines. What it does NOT touch: the information
 * coefficient, which is measured on predictions and outcomes before any
 * cost is subtracted, and which is the number the promotion gate reads.
 */
export function costTierMarketCapUsd(
  marketCapUsd: number,
  avgDollarVolume20d: number | undefined,
): { capUsd: number; basis: CostTierBasis } {
  if (Number.isFinite(marketCapUsd) && marketCapUsd > 0) {
    return { capUsd: marketCapUsd, basis: 'filed-cap' }
  }
  if (avgDollarVolume20d != null && Number.isFinite(avgDollarVolume20d) && avgDollarVolume20d > 0) {
    return {
      capUsd: avgDollarVolume20d / DOLLAR_VOLUME_SIZE_PROXY.dailyTurnoverOfMarketCap,
      basis: 'dollar-volume-proxy',
    }
  }
  return { capUsd: Number.NaN, basis: 'unavailable' }
}

/** One-way effective trading cost (bps) for a name of the given market
 * cap, per the size-tiered table (Frazzini-Israel-Moskowitz 2018;
 * Novy-Marx-Velikov 2016). Unknown cap uses the table's most conservative
 * observed tier; an uncited synthetic cap must never make costs look cheaper.
 * Callers resolve the cap through costTierMarketCapUsd first, so "unknown"
 * here means neither a filed cap nor a dollar-volume proxy existed. */
function oneWayCostBps(marketCapUsd: number): number {
  if (!Number.isFinite(marketCapUsd)) {
    return SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1].oneWayBps
  }
  const cap = marketCapUsd
  for (const tier of SIZE_TIERED_TRADING_COST) {
    if (cap >= tier.minMarketCapUsd) return tier.oneWayBps
  }
  return SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1].oneWayBps
}

/** Annualized stock-borrow fee (bps) for the SHORT leg by size tier
 * (D'Avolio 2002; Drechsler-Drechsler 2014). */
function borrowFeeAnnualBps(marketCapUsd: number): number {
  if (!Number.isFinite(marketCapUsd)) {
    return SIZE_TIERED_BORROW_FEE_ANNUAL[SIZE_TIERED_BORROW_FEE_ANNUAL.length - 1].annualBps
  }
  const cap = marketCapUsd
  for (const tier of SIZE_TIERED_BORROW_FEE_ANNUAL) {
    if (cap >= tier.minMarketCapUsd) return tier.annualBps
  }
  return SIZE_TIERED_BORROW_FEE_ANNUAL[SIZE_TIERED_BORROW_FEE_ANNUAL.length - 1].annualBps
}

/** Mean over a basket. Empty → 0. */
function meanOf(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

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
 *   4. BASELINE COMPARISONS: every walk-forward step also scores, on the
 *      identical purged training rows and identical test rows, the
 *      yardsticks the tree model has to beat: a random ranking (its
 *      expected IC is exactly zero), twelve-month momentum in both the
 *      12-1 form (skips the latest month, Jegadeesh-Titman 1993) and the
 *      12-0 form (includes it), a ridge regression on the same feature
 *      columns, and a blend of trees and momentum whose mix is measured on
 *      training rows only. Paired differences carry moving-block bootstrap
 *      intervals so IC numbers have context.
 *
 *   5. TRANSACTION COST MODELLING: long-short returns are reported both
 *      gross AND net of a size-tiered cost. Every window rebalances the
 *      whole book, so each side pays a one-way cost on entry AND on exit
 *      (four legs in all), tiered by each constituent's market cap
 *      (quantConfig SIZE_TIERED_TRADING_COST), and the short side also
 *      pays a borrow fee pro-rated over the holding period
 *      (SIZE_TIERED_BORROW_FEE_ANNUAL). There is no flat per-trade rate.
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
  // Expanded training pool: the curated large/mid-cap bellwethers (first,
  // sector-organized) + the rest of the live catalog, deduped. Train on a
  // prefix via the CLI --limit N flag (e.g. 500 de-risk, then 1000 target).
  // All survivors: breadth shrinks cross-sectional Z/IC variance but does NOT
  // correct survivorship bias (the CHS canary still flags inflated absolutes).
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AVGO',
  'ORCL', 'CRM', 'ADBE', 'CSCO', 'NFLX', 'AMD', 'INTC', 'QCOM',
  'TXN', 'IBM', 'NOW', 'PANW', 'MU', 'AMAT', 'LRCX', 'KLAC',
  'SNPS', 'CDNS', 'CRWD', 'FTNT', 'WDAY', 'TEAM', 'DDOG', 'NET',
  'ZS', 'MDB', 'SNOW', 'PLTR', 'UBER', 'ABNB', 'SHOP', 'SQ',
  'PYPL', 'INTU', 'ANET', 'MRVL', 'NXPI', 'ON', 'ADI', 'MCHP',
  'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'EA', 'TTWO',
  'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'BLK',
  'SCHW', 'AXP', 'C', 'USB', 'PNC', 'TFC', 'COF', 'BK',
  'SPGI', 'MCO', 'ICE', 'CME', 'AON', 'MMC', 'PGR', 'TRV',
  'ALL', 'MET', 'PRU', 'AIG', 'KKR', 'BX', 'APO', 'COIN',
  'UNH', 'JNJ', 'LLY', 'MRK', 'ABBV', 'PFE', 'TMO', 'ABT',
  'DHR', 'BMY', 'AMGN', 'GILD', 'VRTX', 'REGN', 'ISRG', 'SYK',
  'BSX', 'MDT', 'EW', 'ZTS', 'CI', 'CVS', 'ELV', 'HUM',
  'MCK', 'BIIB', 'MRNA', 'HCA', 'WMT', 'PG', 'KO', 'PEP',
  'COST', 'HD', 'NKE', 'MCD', 'LOW', 'TGT', 'SBUX', 'CMG',
  'BKNG', 'MAR', 'HLT', 'YUM', 'DG', 'DLTR', 'ROST', 'TJX',
  'ORLY', 'AZO', 'EL', 'CL', 'KMB', 'GIS', 'KHC', 'HSY',
  'STZ', 'MDLZ', 'MO', 'PM', 'F', 'GM', 'RIVN', 'LULU',
  'XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'MPC', 'VLO',
  'OXY', 'PXD', 'KMI', 'WMB', 'LIN', 'APD', 'SHW', 'ECL',
  'FCX', 'NEM', 'NUE', 'DOW', 'CAT', 'BA', 'DE', 'GE',
  'HON', 'UNP', 'UPS', 'FDX', 'RTX', 'LMT', 'NOC', 'GD',
  'MMM', 'EMR', 'ETN', 'ITW', 'PH', 'CMI', 'PCAR', 'CSX',
  'NSC', 'WM', 'RSG', 'URI', 'PWR', 'GWW', 'TT', 'CARR',
  'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL',
  'PLD', 'AMT', 'EQIX', 'CCI', 'PSA', 'SPG', 'O', 'WELL',
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV',
  'GOOG', 'TSM', 'ASML', 'ARM', 'MPWR', 'TER', 'SWKS', 'QRVO',
  'GFS', 'LSCC', 'WOLF', 'COHR', 'ALAB', 'OKTA', 'ADSK', 'HUBS',
  'VEEV', 'APP', 'DT', 'ESTC', 'GTLB', 'CFLT', 'BILL', 'S',
  'TENB', 'CYBR', 'CHKP', 'GEN', 'PATH', 'AI', 'DOCU', 'ZM',
  'TWLO', 'U', 'DELL', 'HPE', 'HPQ', 'SMCI', 'WDC', 'STX',
  'NTAP', 'KEYS', 'GLW', 'APH', 'TEL', 'MSI', 'JNPR', 'BRK.B',
  'STT', 'NTRS', 'CFG', 'FITB', 'HBAN', 'RF', 'KEY', 'MTB',
  'CMA', 'ZION', 'ALLY', 'IBKR', 'HOOD', 'SOFI', 'NU', 'CBOE',
  'MKTX', 'WTW', 'CB', 'AFL', 'HIG', 'AMP', 'TROW', 'FI',
  'FIS', 'GPN', 'ARES', 'OWL', 'RJF', 'DFS', 'NVO', 'INCY',
  'ALNY', 'UTHR', 'BMRN', 'EXAS', 'NBIX', 'TECH', 'RPRX', 'ARGX',
  'BGNE', 'CNC', 'COR', 'BDX', 'IDXX', 'ILMN', 'DXCM', 'RMD',
  'A', 'WAT', 'IQV', 'MTD', 'ALGN', 'HOLX', 'DGX', 'LH',
  'GEHC', 'PODD', 'TNDM', 'DASH', 'RBLX', 'SPOT', 'ROKU', 'PINS',
  'SNAP', 'SE', 'MELI', 'BABA', 'JD', 'LCID', 'NIO', 'XPEV',
  'LI', 'CVNA', 'CART', 'DRI', 'ETSY', 'EBAY', 'LVS', 'MGM',
  'NCLH', 'RCL', 'CCL', 'DPZ', 'PHM', 'DHI', 'LEN', 'NVR',
  'ULTA', 'BURL', 'WSM', 'RH', 'TSCO', 'BBY', 'KMX', 'GPC',
  'AAP', 'ANF', 'ELF', 'CELH', 'CAVA', 'WING', 'TXRH', 'DECK',
  'CROX', 'CHWY', 'W', 'K', 'TAP', 'KDP', 'MNST', 'CHD',
  'CLX', 'SYY', 'KR', 'ADM', 'TSN', 'CPB', 'CAG', 'HRL',
  'MKC', 'LW', 'BG', 'CASY', 'WBA', 'HES', 'DVN', 'FANG',
  'HAL', 'BKR', 'TRGP', 'EQT', 'CTRA', 'APA', 'OKE', 'LNG',
  'SHEL', 'BP', 'TTE', 'ENB', 'EPD', 'DD', 'PPG', 'VMC',
  'MLM', 'STLD', 'ALB', 'LYB', 'TECK', 'SCCO', 'RIO', 'BHP',
  'AA', 'CF', 'MOS', 'CE', 'EMN', 'IFF', 'FMC', 'CCJ',
  'MP', 'LHX', 'TDG', 'ROP', 'IR', 'FAST', 'CTAS', 'OTIS',
  'HWM', 'JCI', 'DAL', 'UAL', 'LUV', 'XYL', 'HUBB', 'VRT',
  'GNRC', 'AYI', 'ROK', 'DOV', 'TXT', 'NDSN', 'IEX', 'WAB',
  'ALLE', 'EXPD', 'CHRW', 'JBHT', 'SAIA', 'ODFL', 'HEI', 'AXON',
  'PAYX', 'ADP', 'PCG', 'PEG', 'WEC', 'ED', 'ETR', 'AWK',
  'DTE', 'FE', 'PPL', 'AEE', 'CMS', 'CNP', 'EIX', 'CEG',
  'VST', 'NRG', 'AES', 'FSLR', 'ENPH', 'SEDG', 'BEPC', 'NXT',
  'DLR', 'VICI', 'CBRE', 'AVB', 'EQR', 'EXR', 'ARE', 'SBAC',
  'INVH', 'ELS', 'MAA', 'UDR', 'CPT', 'ESS', 'BXP', 'VTR',
  'DOC', 'CUBE', 'AMH', 'KIM', 'REG', 'FRT', 'IRM', 'WBD',
  'LYV', 'OMC', 'IPG', 'FOXA', 'NWSA', 'PARA', 'RDDT', 'TTD',
  'MTCH', 'IAC', 'DJT', 'IONQ', 'RKLB', 'ASTS', 'SOUN', 'UPST',
  'AFRM', 'BIRK', 'IREN', 'MSTR', 'MARA', 'RIOT', 'HIMS', 'DNA',
  'JOBY', 'ACHR', 'ACLS', 'ACMR', 'AEHR', 'AEIS', 'ALGM', 'AMBA',
  'AMKR', 'APPF', 'ARLO', 'ATEN', 'AVT', 'AZTA', 'CEVA', 'CLS',
  'COHU', 'CRDO', 'DIOD', 'DOX', 'FORM', 'HLIT', 'IDCC', 'IPGP',
  'JBL', 'LITE', 'LOGI', 'MKSI', 'MTSI', 'NABL', 'NOVT', 'NVMI',
  'PDFS', 'PLAB', 'POWI', 'RMBS', 'SANM', 'SIMO', 'SITM', 'SNX',
  'SYNA', 'TDC', 'TTMI', 'UCTT', 'VECO', 'VIAV', 'VICR', 'VSH',
  'ZBRA', 'ACIW', 'ALKT', 'ASAN', 'BL', 'BLKB', 'BOX', 'BRZE',
  'CXM', 'DBX', 'DOCN', 'DUOL', 'FIVN', 'FRSH', 'GWRE', 'IOT',
  'INST', 'JAMF', 'LSPD', 'MNDY', 'NCNO', 'PAYC', 'PCOR', 'PEGA',
  'PRGS', 'QTWO', 'QLYS', 'RBRK', 'RNG', 'RPD', 'SEMR', 'SMAR',
  'SPSC', 'TOST', 'UPWK', 'WK', 'WIX', 'ZETA', 'ZI', 'BMBL',
  'CARG', 'CARS', 'CNNE', 'DV', 'EB', 'EVER', 'FUBO', 'GRND',
  'IAS', 'IMAX', 'LQDT', 'MDIA', 'OUT', 'PUBM', 'RAMP', 'SSTK',
  'TBLA', 'TRIP', 'YELP', 'YY', 'ZH', 'ABCL', 'ADUS', 'AGIO',
  'ALKS', 'AMED', 'AMRX', 'APLS', 'ARDX', 'ARVN', 'ARWR', 'BCRX',
  'BEAM', 'BHC', 'BPMC', 'CORT', 'CNMD', 'CPRX', 'CRBU', 'CRL',
  'CRNX', 'CYRX', 'DNLI', 'DYN', 'EBS', 'EHC', 'ENTA', 'EXEL',
  'EYE', 'FATE', 'FOLD', 'FULC', 'GERN', 'GH', 'GOSS', 'HAE',
  'HALO', 'HROW', 'IART', 'IBRX', 'ICUI', 'IMCR', 'IMVT', 'INMD',
  'INSM', 'IONS', 'IRWD', 'ITCI', 'ITGR', 'KNSA', 'KRYS', 'LQDA',
  'MDGL', 'MIRM', 'MMSI', 'NARI', 'NTRA', 'NVCR', 'PACB', 'PCRX',
  'PDCO', 'PEN', 'PRAX', 'PRGO', 'PRTA', 'PTCT', 'RCKT', 'RGEN',
  'RXRX', 'SGMO', 'SGRY', 'SHC', 'TGTX', 'TMDX', 'TWST', 'VCEL',
  'VCYT', 'VIR', 'XENE', 'ZLAB', 'AER', 'AFG', 'AGO', 'AMAL',
  'APAM', 'ARCC', 'ASB', 'BANC', 'BANF', 'BHF', 'BOH', 'BPOP',
  'CACC', 'CATY', 'CBSH', 'CBU', 'CFR', 'COLB', 'EBC', 'EGBN',
  'ENVA', 'EWBC', 'FHN', 'FIBK', 'FNB', 'FRME', 'FULT', 'GBCI',
  'GCMG', 'GSHD', 'HWC', 'JEF', 'LAZ', 'LOB', 'MAIN', 'MC',
  'NMIH', 'OMF', 'ONB', 'OZK', 'PB', 'PFSI', 'PIPR', 'PRI',
  'RDN', 'SFBS', 'SLM', 'SNV', 'TCBI', 'TFIN', 'UCB', 'UMBF',
  'VIRT', 'WAL', 'WBS', 'WEX', 'WSFS', 'WTFC', 'ABG', 'ACVA',
  'ADNT', 'AEO', 'AN', 'ARCO', 'ASO', 'ATGE', 'BECN', 'BJRI',
  'BLMN', 'BROS', 'BYD', 'CHDN', 'CHH', 'CHPT', 'CPRI', 'CWH',
  'DKS', 'DORM', 'DRVN', 'EAT', 'ETD', 'EVRI', 'FIGS', 'FIVE',
  'FL', 'FND', 'FOXF', 'GIL', 'GME', 'GOOS', 'GPI', 'GIII',
  'H', 'HBI', 'HGV', 'HOG', 'JACK', 'JWN', 'KAR', 'LESL',
  'LTH', 'M', 'MOD', 'MOV', 'MTN', 'OLLI', 'PAG', 'PENN',
  'PLNT', 'PSNY', 'RUSHA', 'SAH', 'SHAK', 'SIG', 'SKX', 'TNL',
  'TPR', 'VAC', 'VFC', 'VRA', 'VSCO', 'YETI', 'ZUMZ', 'BRBR',
  'CALM', 'CHEF', 'COKE', 'DAR', 'FDP', 'FLO', 'FRPT', 'GO',
  'HAIN', 'HELE', 'KLG', 'LANC', 'NOMD', 'POST', 'PPC', 'SAM',
  'SFM', 'SJM', 'SMPL', 'SPB', 'THS', 'TR', 'UNFI', 'USFD',
  'UTZ', 'VITL', 'AAON', 'AIN', 'ALG', 'AMRC', 'ATKR', 'AUR',
  'B', 'BERY', 'CCK', 'CR', 'CSWI', 'CW', 'DNOW', 'ENS',
  'ERJ', 'FIX', 'FLS', 'GATX', 'GEF', 'GGG', 'HAYW', 'HRI',
  'IBP', 'ITT', 'JBT', 'JELD', 'KAI', 'KBR', 'KNF', 'LII',
  'LNN', 'MIDD', 'MTZ', 'MWA', 'NEX', 'NPO', 'NSSC', 'ODC',
  'OI', 'OSK', 'PACK', 'POWL', 'PRIM', 'REZI', 'RXO', 'SITE',
  'SSD', 'TEX', 'TKR', 'TREX', 'TRMB', 'VMI', 'WCC', 'WMS',
  'WTS', 'XPO', 'AEM', 'AG', 'AGI', 'AM', 'AMR', 'AR',
  'BTG', 'CDE', 'CHRD', 'CNX', 'CRC', 'CRK', 'DMLP', 'DTM',
  'EGO', 'GEL', 'HCC', 'HL', 'KGC', 'LBRT', 'LTHM', 'MGY',
  'MTDR', 'MUR', 'NFG', 'NG', 'NOG', 'NOV', 'NXE', 'OII',
  'OR', 'PAAS', 'PARR', 'PBF', 'PTEN', 'RIG', 'RRC', 'SBSW',
  'SM', 'TALO', 'TMC', 'TNK', 'UEC', 'UUUU', 'VAL', 'VET',
  'VIST', 'VNOM', 'WFRD', 'YPF', 'ASH', 'AVNT', 'BALL', 'BCPC',
  'CENX', 'CLF', 'CMC', 'CSTM', 'ESI', 'EXP', 'FUL', 'HUN',
  'IOSP', 'KALU', 'KOP', 'KRO', 'MATV', 'MEOH', 'MT', 'NEU',
  'OLN', 'SEE', 'SLGN', 'SMG', 'TROX', 'WLK', 'WDFC', 'AKR',
  'ALE', 'AQN', 'AVA', 'BKH', 'BRX', 'COLD', 'CUZ', 'CWT',
  'DEI', 'EGP', 'EPR', 'FCPT', 'FR', 'GLPI', 'HIW', 'HR',
  'IDA', 'KRG', 'LAMR', 'LTC', 'MGEE', 'NNN', 'NSA', 'NWE',
  'OHI', 'ORA', 'OTTR', 'PECO', 'PCH', 'PK', 'PNW', 'POR',
  'REXR', 'RHP', 'RYN', 'SITC', 'SLG', 'SR', 'STAG', 'STWD',
  'SWX', 'TAC', 'UGI', 'VNO', 'WPC', 'IVV', 'VOO', 'VTI',
  'SPLG', 'QQQM', 'QQQJ', 'RSP', 'MDY', 'IJR', 'VB', 'VO',
  'IWB', 'IWF', 'IWD', 'IWO', 'IWN', 'XLY', 'XLP', 'XLI',
  'XLU', 'XLRE', 'XLB', 'XLC', 'SMH', 'SOXX', 'XSD', 'IGV',
  'FDN', 'IBB', 'XBI', 'IHI', 'IHF', 'KRE', 'KBE', 'ITB',
  'XHB', 'IYT', 'XRT', 'XME', 'XOP', 'OIH', 'TAN', 'ICLN',
  'URA', 'REMX', 'COPX', 'HYG', 'JNK', 'LQD', 'AGG', 'BND',
  'GOVT', 'TLT', 'IEF', 'SHY', 'BIL', 'SGOV', 'TIP', 'MUB',
  'EMB', 'GLD', 'SLV', 'USO', 'UNG', 'DBC', 'DBA', 'UUP',
  'FXE', 'FXY', 'VEA', 'VWO', 'EFA', 'EEM', 'IEMG', 'VXUS',
  'ACWI', 'EWG', 'EWJ', 'EWU', 'EWZ', 'INDA', 'MCHI', 'KWEB',
  'SCHD', 'VIG', 'VYM', 'DGRO', 'ARKK', 'ARKG', 'ARKW', 'IPO',
  'BOTZ', 'ROBO', 'CLOU', 'BUG', 'HACK', 'FINX', 'ITOT', 'SCHX',
  'SCHB', 'IJH', 'VBR', 'VBK', 'VOE', 'VOT', 'IVE', 'IVW',
  'VUG', 'VTV', 'VONG', 'VOOG', 'VOOV', 'SCHG', 'SCHV', 'SPYG',
  'SPYV', 'IUSG', 'IUSV', 'MTUM', 'QUAL', 'USMV', 'SPLV', 'VLUE',
  'SPHQ', 'PRF', 'FNDX', 'DGRW', 'NOBL', 'SDY', 'DIV', 'DHS',
  'RDVY', 'COWZ', 'CALF', 'DON', 'DLN', 'DES', 'FNDA', 'FNDB',
  'FNDC', 'VGT', 'FTEC', 'IYW', 'VFH', 'IYF', 'VHT', 'IYH',
  'VDE', 'IYE', 'VIS', 'IYJ', 'VPU', 'IDU', 'VNQ', 'IYR',
  'RWR', 'VNQI', 'XAR', 'ITA', 'IAI', 'KIE', 'PAVE', 'GRID',
  'PHO', 'XTL', 'XHE', 'XPH', 'IAT', 'FTXO', 'PBW', 'QCLN',
  'CIBR', 'SKYY', 'PNQI', 'ARKF', 'ARKQ', 'ARKX', 'DRIV', 'LIT',
  'BLOK', 'AIQ', 'IRBO', 'HERO', 'NERD', 'MOON', 'UFO', 'BSV',
  'BIV', 'BLV', 'VGIT', 'VGLT', 'VGSH', 'SPTL', 'SPTS', 'SHV',
  'MINT', 'NEAR', 'JPST', 'ICSH', 'FLOT', 'FLRN', 'SRLN', 'BKLN',
  'VCIT', 'VCSH', 'VCLT', 'IGSB', 'IGIB', 'IGLB', 'MBB', 'VMBS',
  'TFI', 'HYLB', 'ANGL', 'PDBC', 'COMT', 'CPER', 'UGA', 'CORN',
  'WEAT', 'SOYB', 'GDX', 'GDXJ', 'SIL', 'SILJ', 'URNM', 'BNO',
  'FXB', 'FXC', 'CYB', 'IBIT', 'FBTC', 'BITB', 'ARKB', 'GBTC',
  'ETHA', 'FETH', 'IEFA', 'IDEV', 'EFG', 'EFV', 'SCZ', 'VSS',
  'VEU', 'EPP', 'AAXJ', 'EMXC', 'SPEM', 'ILF', 'EWZS', 'EWC',
  'EWW', 'EWT', 'EWY', 'EWS', 'EWA', 'EWH', 'FXI', 'ASHR',
  'EPI', 'EWQ', 'EWN', 'EWL', 'EWP', 'EWI', 'EIDO', 'EPOL',
  'TUR', 'GREK', 'EZA', 'EWM', 'THD', 'NORW', 'ARGT', 'ECH',
  'EPHE', 'GXG', 'QAT', 'GEV', 'BLDR', 'EME', 'SKYW', 'BMI',
  'LOAR', 'SARO', 'CSL', 'SOLV', 'TEM', 'WAY', 'DOCS', 'RVMD',
  'CVLT', 'NTNX', 'GDDY', 'MANH', 'PCTY', 'SAP', 'KVYO', 'FOUR',
  'SONY', 'MLI', 'AMCR', 'TPL', 'FCNCA', 'RELX', 'TM',
]

/* =========================================================================
   Names in the pre-registered list that Yahoo no longer serves
   -------------------------------------------------------------------------
   DEFAULT_BACKTEST_TICKERS is a pre-registered list and the artifact records
   it word for word, so its entries are never edited. On 2026-09-16 a full
   probe found 57 of its non-fund names answering HTTP 404 from Yahoo. A
   second probe the same day, of every remaining name's last year of bars,
   found nine more that Yahoo still answers with HTTP 200 but with a STUB in
   place of the history: a single bar, a series that starts on 2026-07-17,
   or (WOLF) a series that restarts at a 2025 re-listing of new shares. Each
   of the 66 was then checked against the SEC's ticker map and filings,
   Yahoo's own search and chart endpoints, and Alpha Vantage's delisted
   list. They fall into two groups, kept in the two ledgers below:

   1. TICKER_RENAMES: the company still trades, under a new symbol, and
      Yahoo serves its WHOLE price history under that symbol (the chart
      under the successor starts on the company's original listing day).
      The dataset builder fetches under the successor and keeps the
      original symbol as the sample's identity, so the universe in the
      artifact stays comparable with earlier runs. Yahoo recycles symbols,
      so a rename is accepted only when the SEC lists the successor under
      the old company's own CIK, and it is applied only when the
      successor's history starts no later than the company's own listing
      day (originalFirstTrade, from a source other than the successor's
      chart) and before the change took effect. A Chapter 11 name whose
      shares keep trading under a "Q" symbol (SGMO -> SGMOQ) is a rename,
      not an exclusion: its collapse is exactly the price path a
      survivorship-honest sample must keep.

   2. EXCLUDED_UNFETCHABLE: the company left the market (acquired, taken
      private, merged, or its shares cancelled in a bankruptcy) and no free
      source serves its price history. These are taken out of the universe
      before any fetch is attempted, so the runner's fail-loud guard does
      not fire on them, and they are recorded in the artifact as
      "registered but excluded" with the date and reason. The names that
      remain are MORE survivor-biased, not less, and the share is
      reported with the survivorship diagnostics.

   A name that is not in either ledger and still cannot be fetched is a
   real failure, and the runner stops on it as before. So is a name that
   comes back as a stub: the runner's warm-up (tools/preregistered-run.ts,
   classifyStubSeries) flags a registered name whose series starts after
   2025-01-01 or holds fewer than a year of bars, prints it, and stops.

   A third way a symbol can lie, which neither of those rules can see: the
   symbol was handed to a DIFFERENT company after the registered one left
   the market, and the new holder's own chart is long enough to pass both
   stub rules (PARA is now Banzai International, listed 2021; B is now
   Barrick Mining, listed 1985). Such an entry carries `recycledBy`, and
   the general guard is the identity ledger: tools/registered_identity.json
   records, for every fetchable registered name, the SEC CIK and the Yahoo
   long name and first-trade date the run is pre-registered against, and
   the warm-up compares each name's live CIK and meta with it (checkIdentity
   in tools/preregistered-run.ts). A different CIK is a wrong company and
   stops the run whatever flags were given.
   ========================================================================= */

/** The day the 66 unserved names were resolved. Unresolved entries in the
 * exclusion ledger carry this date in their reason. */
export const UNFETCHABLE_RESOLVED_ON = '2026-09-16'

/** A symbol change. The company is the same and Yahoo serves its whole
 * price history under the new symbol, so the backtest fetches under the
 * successor and keeps the original symbol as the sample's identity. */
export type TickerRename = {
  /** The symbol Yahoo serves the history under today. */
  successor: string
  /** When the old symbol stopped applying. With basis 'sec-filing' this is
   * the date of the SEC filing that recorded the change. With basis
   * 'latest-possible' the exact day is not in the evidence gathered, so
   * this is the day the old symbol was confirmed to answer 404 and the
   * change happened on or before it. */
  effectiveDate: string
  effectiveDateBasis: 'sec-filing' | 'latest-possible'
  /** First bar of the successor's Yahoo chart. The rename is applied only
   * when this is no later than originalFirstTrade (the successor carries
   * the whole history) and predates effectiveDate (it is the same series
   * continued, not a fresh listing that starts at the change). */
  successorFirstTrade: string
  /** The company's first trading day as a source other than the successor's
   * chart records it: Alpha Vantage's listing date for the company (for
   * listings older than 1990 that is often Alpha Vantage's own data floor,
   * which only makes the test stricter), or the SEC-dated listing. This is
   * the earliest date the original symbol could have contributed a bar, so
   * a successor whose chart starts after it cannot be the same series. A
   * recycled symbol, whose chart starts at its re-listing, fails here. */
  originalFirstTrade: string
  note: string
}

/** Old symbol -> where its history lives now. Resolved 2026-09-16. */
export const TICKER_RENAMES: Readonly<Record<string, TickerRename>> = {
  SQ: {
    successor: 'XYZ',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2015-11-19',
    originalFirstTrade: '2015-11-19',
    note: 'Square, Inc. became Block, Inc. Yahoo chart XYZ (Block, Inc.) starts on 2015-11-19, the Square IPO day, with adjusted closes; SEC CIK 1512673 (formerly Square, Inc.) lists ticker XYZ. The exact day the symbol switched is not in the evidence gathered; SQ was confirmed unserved on 2026-09-16. Alpha Vantage lists XYZ with listing date 2015-11-19.',
  },
  BK: {
    successor: 'BNY',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '1973-05-03',
    originalFirstTrade: '1973-05-03',
    note: 'The Bank of New York Mellon Corporation. Yahoo chart BNY starts on 1973-05-03 with adjusted closes; SEC CIK 1390777 lists ticker BNY. The exact switch day is not in the evidence gathered; BK was confirmed unserved on 2026-09-16. Alpha Vantage lists BNY with listing date 1973-05-03.',
  },
  MMC: {
    successor: 'MRSH',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '1973-02-21',
    originalFirstTrade: '1987-12-30',
    note: 'Marsh & McLennan Companies, Inc. Yahoo chart MRSH starts on 1973-02-21 with adjusted closes; SEC CIK 62709 lists ticker MRSH. The exact switch day is not in the evidence gathered; MMC was confirmed unserved on 2026-09-16. Alpha Vantage lists MRSH with listing date 1987-12-30 (its data floor; the Yahoo chart reaches further back).',
  },
  FI: {
    successor: 'FISV',
    effectiveDate: '2025-11-10',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1986-09-25',
    originalFirstTrade: '1990-03-26',
    note: 'Fiserv, Inc. moved its listing from the NYSE back to Nasdaq under FISV: SEC CIK 798354 filed an 8-K on 2025-10-29 (item 3.01) and a Form 25 on 2025-11-10 recording the transfer. Yahoo chart FISV starts on 1986-09-25. Alpha Vantage lists FISV with listing date 1990-03-26 (its data floor; the Yahoo chart reaches further back).',
  },
  BGNE: {
    successor: 'ONC',
    effectiveDate: '2025-05-27',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '2016-02-03',
    originalFirstTrade: '2016-02-03',
    note: 'BeiGene, Ltd. became BeOne Medicines AG: SEC CIK 1651308 filed a Form 8-K12G3 successor-issuer notice on 2025-05-27 and lists ticker ONC. Yahoo chart ONC starts on 2016-02-03, the BeiGene IPO day. Alpha Vantage lists ONC with listing date 2016-02-03.',
  },
  IAC: {
    successor: 'PPLI',
    effectiveDate: '2026-06-02',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1993-01-19',
    originalFirstTrade: '1993-01-19',
    note: 'IAC Inc. became People Inc: SEC CIK 1800227 records the rename on 2026-06-02 with ticker PPLI on Nasdaq. Yahoo chart PPLI (People Incorporated) starts on 1993-01-19, so the history predates the change. Alpha Vantage lists the company with listing date 1993-01-19 both as IACI (2015 listing status) and as PPLI today.',
  },
  ZI: {
    successor: 'GTM',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2020-06-04',
    originalFirstTrade: '2020-06-04',
    note: 'ZoomInfo Technologies Inc. Yahoo chart GTM starts on 2020-06-04, the ZoomInfo IPO day; SEC CIK 1794515 lists ticker GTM. The exact switch day is not in the evidence gathered; ZI was confirmed unserved on 2026-09-16. Alpha Vantage lists GTM with listing date 2020-06-04.',
  },
  YY: {
    successor: 'JOYY',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2012-11-21',
    originalFirstTrade: '2012-11-21',
    note: 'YY Inc. became JOYY Inc. Yahoo chart JOYY starts on 2012-11-21, the YY IPO day; SEC CIK 1530238 lists ticker JOYY. The exact switch day is not in the evidence gathered; YY was confirmed unserved on 2026-09-16. Alpha Vantage lists JOYY with listing date 2012-11-21.',
  },
  ATGE: {
    successor: 'CVSA',
    effectiveDate: '2026-01-28',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1991-06-21',
    originalFirstTrade: '1991-06-28',
    note: 'Adtalem Global Education Inc. became Covista Inc.: SEC CIK 730464 records the rename on 2026-01-28 with ticker CVSA on the NYSE. Yahoo chart CVSA starts on 1991-06-21, the DeVry IPO. Alpha Vantage lists CVSA with listing date 1991-06-28 (a week after the first Yahoo bar).',
  },
  KAR: {
    successor: 'OPLN',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2009-12-11',
    originalFirstTrade: '2009-12-11',
    note: 'KAR Auction Services, Inc. became OPENLANE, Inc. Yahoo chart OPLN starts on 2009-12-11, the KAR IPO day; SEC CIK 1395942 lists ticker OPLN. The exact switch day is not in the evidence gathered; KAR was confirmed unserved on 2026-09-16. Alpha Vantage lists OPLN with listing date 2009-12-11.',
  },
  VSCO: {
    successor: 'VSXY',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2021-07-21',
    originalFirstTrade: '2021-07-21',
    note: "Victoria's Secret & Co. Yahoo chart VSXY starts on 2021-07-21, the 2021 spin-off; SEC CIK 1856437 lists ticker VSXY. The exact switch day is not in the evidence gathered; VSCO was confirmed unserved on 2026-09-16. Alpha Vantage lists VSXY with listing date 2021-07-21.",
  },
  FDP: {
    successor: 'DMC',
    effectiveDate: '2026-06-04',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1997-10-24',
    originalFirstTrade: '1997-10-24',
    note: 'Fresh Del Monte Produce Inc became Del Monte Corp: SEC CIK 1047340 records the rename on 2026-06-04 with ticker DMC on the NYSE. Yahoo chart DMC starts on 1997-10-24, the Fresh Del Monte IPO. Alpha Vantage lists DMC with listing date 1997-10-24.',
  },
  LANC: {
    successor: 'MZTI',
    effectiveDate: '2025-05-16',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1980-03-17',
    originalFirstTrade: '1990-03-26',
    note: 'Lancaster Colony Corp became The Marzetti Company: SEC CIK 57515 records the rename on 2025-05-16 with ticker MZTI on Nasdaq. Yahoo chart MZTI starts on 1980-03-17. Alpha Vantage lists MZTI with listing date 1990-03-26 (its data floor; the Yahoo chart reaches further back).',
  },
  CSWI: {
    successor: 'CSW',
    effectiveDate: '2025-06-06',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '2015-09-30',
    originalFirstTrade: '2015-10-01',
    note: 'CSW Industrials, Inc. moved its listing from Nasdaq to the NYSE under CSW: SEC CIK 1624794 filed an 8-K on 2025-05-01 (items 2.01, 3.01) and a Form 25 on 2025-06-06. Yahoo chart CSW starts on 2015-09-30, the 2015 spin-off. The Alpha Vantage row that shows CSWI as delisted on 2026-09-15 carries a snapshot placeholder date, not a real delisting. Alpha Vantage lists CSW with listing date 2015-10-01 (the day after the when-issued first Yahoo bar).',
  },
  ERJ: {
    successor: 'EMBJ',
    effectiveDate: UNFETCHABLE_RESOLVED_ON,
    effectiveDateBasis: 'latest-possible',
    successorFirstTrade: '2000-07-21',
    originalFirstTrade: '2000-07-21',
    note: 'Embraer S.A. (the NYSE ADR). Yahoo chart EMBJ starts on 2000-07-21, the ADR listing; SEC CIK 1355444 lists ticker EMBJ. The exact switch day is not in the evidence gathered; ERJ was confirmed unserved on 2026-09-16. Alpha Vantage lists EMBJ with listing date 2000-07-21.',
  },
  JBT: {
    successor: 'JBTM',
    effectiveDate: '2025-01-07',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '2008-07-22',
    originalFirstTrade: '2008-07-22',
    note: 'John Bean Technologies became JBT Marel Corporation after the Marel combination: SEC CIK 1433660 records the rename on 2024-12-20 and an 8-K on 2025-01-07 (item 2.01), and lists ticker JBTM. Yahoo chart JBTM starts on 2008-07-22, the John Bean spin-off. Alpha Vantage lists JBTM with listing date 2008-07-22.',
  },
  EQR: {
    successor: 'VMRK',
    effectiveDate: '2026-08-17',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '1993-08-12',
    originalFirstTrade: '1993-08-12',
    note: "Equity Residential changed its name to Vivmark Residential when it completed its acquisition of AvalonBay Communities: SEC CIK 906107 (formerly Equity Residential) filed an 8-K on 2026-08-17 (items 2.01, 5.03) saying the company changed its name, that its shares continue to trade on the NYSE and trade under VMRK from 2026-08-18, and that share certificates are unaffected; the SEC ticker map lists VMRK under that CIK. Yahoo chart VMRK starts on 1993-08-12, Equity Residential's listing day (Alpha Vantage lists VMRK with listing date 1993-08-12), with adjusted closes on all 8,330 daily bars, and its closes equal the EQR stub's closes on every shared day before the rename (69.00 on 2026-07-17, 63.66 on 2026-08-17) while the AVB stub's differ, so the series is Equity Residential's; Yahoo's longName on VMRK reads AvalonBay, a label error, and its shortName is Vivmark Residential. Yahoo still answers HTTP 200 for EQR with a stub from 2026-07-17 that freezes at 63.66 after the rename. AvalonBay itself is in the exclusion ledger.",
  },
  SGMO: {
    successor: 'SGMOQ',
    effectiveDate: '2026-06-23',
    effectiveDateBasis: 'sec-filing',
    successorFirstTrade: '2000-04-06',
    originalFirstTrade: '2000-04-06',
    note: 'Chapter 11 2026-06-23; still files; history continues under SGMOQ. Sangamo Therapeutics (SEC CIK 1001233) moved from Nasdaq to OTCQB on 2026-05-05 (8-K filed 2026-07-20, item 3.01, after the 2026-04-28 delisting determination), filed its Chapter 11 petition on 2026-06-23 (8-K filed 2026-06-23, item 1.03; Case 26-10989, D. Del.), and keeps filing (8-Ks of 2026-08-28 and 2026-09-08 on the court-approved asset sale); the SEC ticker map lists SGMOQ under that CIK. Yahoo chart SGMOQ starts on 2000-04-06, the Nasdaq IPO day, with adjusted closes on all 6,650 daily bars through 2026-09-16. A bankruptcy whose full price path is available is exactly what a survivorship-honest sample must keep. SGMO is absent from both Alpha Vantage delisted pulls, and Yahoo answers 404 for SGMO itself.',
  },
}

/** A registered name that no free source serves any more. */
export type ExcludedUnfetchable = {
  ticker: string
  /** The last trading day: Alpha Vantage's delisting date where it gives a
   * real one, otherwise the SEC closing filing. Null for an unresolved name. */
  delistingDate: string | null
  reason: string
  evidence: string
  /** Set when the symbol has since been handed to a DIFFERENT company, so
   * that a fetch under it comes back with someone else's history. Names
   * the new holder (with its SEC CIK and where its chart starts), so the
   * record explains why a symbol that Yahoo answers, with plenty of bars,
   * is still excluded. A recycled symbol whose new holder has a long
   * history passes both stub rules; only the identity check at warm-up
   * (tools/preregistered-run.ts, checkIdentity, against the pre-registered
   * identity ledger tools/registered_identity.json) catches it. */
  recycledBy?: string
}

/** The entry an unresolved name gets: no date, and a reason that says when
 * the question was left open, so a later pass knows what to revisit. */
export function unresolvedExclusion(ticker: string, evidence: string): ExcludedUnfetchable {
  return { ticker: ticker.trim().toUpperCase(), delistingDate: null, reason: `unresolved on ${UNFETCHABLE_RESOLVED_ON}`, evidence }
}

/** Registered names that left the market. Resolved 2026-09-16; every entry
 * was delisted, and no name was left unresolved. Eight came from the stub
 * probe: Yahoo answers HTTP 200 for them with a one-bar stub or a series
 * that starts on 2026-07-17 (WOLF: at its 2025 re-listing), so the 404
 * probe missed them and, unlisted, they would have passed the warm-up and
 * dropped out of the build uncounted. The last two (PARA, B) came from the
 * identity re-probe: their symbols now belong to other companies with long
 * charts, so they pass both stub rules and only the CIK check tells. */
export const EXCLUDED_UNFETCHABLE: readonly ExcludedUnfetchable[] = [
  { ticker: 'PXD', delistingDate: '2024-05-03', reason: 'acquired by Exxon Mobil', evidence: "Alpha Vantage row 'PXD, Pioneer Natural Resources Company, NYSE, delisted 2024-05-03'; SEC 8-K filed 2024-05-03 (items 2.01, 3.01, 5.01) names Exxon Mobil Corporation as acquirer at 2.3234 XOM shares per share; Form 25-NSE 2024-05-03; Form 15-12G 2024-05-13." },
  { ticker: 'CFLT', delistingDate: '2026-03-17', reason: 'acquired by International Business Machines (IBM)', evidence: "Alpha Vantage row 'CFLT, Confluent Inc Class A, NASDAQ, delisted 2026-03-17'; SEC 8-K filed 2026-03-17 (items 2.01, 3.01, 5.01) names International Business Machines Corporation (Corvo Merger Sub) as acquirer; Form 25-NSE 2026-03-17; Form 15-12G 2026-03-27." },
  { ticker: 'CYBR', delistingDate: '2026-02-11', reason: 'acquired by Palo Alto Networks', evidence: "Alpha Vantage row 'CYBR, CyberArk Software Ltd, NASDAQ, delisted 2026-02-11'; SEC 6-K filed 2026-02-11 reports completion of the merger with Palo Alto Networks via Athens Strategies Ltd.; Form 25-NSE 2026-02-11; Form 15-12G 2026-02-23." },
  { ticker: 'JNPR', delistingDate: '2025-07-02', reason: 'acquired by Hewlett Packard Enterprise', evidence: 'Not in either Alpha Vantage delisted pull; SEC 8-K filed 2025-07-02 (items 2.01, 3.01, 5.01) names Hewlett Packard Enterprise Company as Parent; Form 25-NSE 2025-07-02; Form 15-12G 2025-07-14.' },
  { ticker: 'CMA', delistingDate: '2026-01-30', reason: 'acquired by Fifth Third Bancorp', evidence: "Alpha Vantage row 'CMA, Comerica Inc, NYSE, delisted 2026-01-30' (last trading day); SEC 8-K filed 2026-02-02 (items 2.01, 3.01, 5.01) records the 2026-02-01 closing with Comerica merged into Fifth Third Financial Corporation; Form 25-NSE 2026-02-02; Form 15-12G 2026-02-12." },
  { ticker: 'DFS', delistingDate: '2025-05-16', reason: 'acquired by Capital One Financial', evidence: "Alpha Vantage row 'DFS, Discover Financial Services, NYSE, delisted 2025-05-16'; SEC 8-K filed 2025-05-19 (items 2.01, 3.01, 5.01) records the 2025-05-18 closing with Discover merged into Capital One Financial Corporation; Form 25-NSE 2025-05-19; Form 15-12G 2025-05-29." },
  { ticker: 'EXAS', delistingDate: '2026-03-24', reason: 'acquired by Abbott Laboratories', evidence: "Alpha Vantage row 'EXAS, Exact Sciences Corp, NASDAQ, delisted 2026-03-24'; SEC 8-K filed 2026-03-23 (items 2.01, 3.01, 5.01) names Abbott Laboratories (Badger Merger Sub I) as acquirer; Form 25-NSE 2026-03-23; Form 15-12G 2026-04-02." },
  { ticker: 'HOLX', delistingDate: '2026-04-07', reason: 'taken private by Blackstone and TPG', evidence: "Alpha Vantage row 'HOLX, Hologic Inc, NASDAQ, delisted 2026-04-07'; SEC 8-K filed 2026-04-07 (items 2.01, 3.01, 5.01) states Hopper Parent Inc. is an affiliate of funds managed by Blackstone Inc. and TPG Global; Form 25-NSE 2026-04-07; Form 15-12G 2026-04-17." },
  { ticker: 'K', delistingDate: '2025-12-11', reason: 'acquired by Mars, Incorporated', evidence: "Alpha Vantage row 'K, Kellanova, NYSE, delisted 2025-12-11'; SEC 8-K filed 2025-12-11 (items 2.01, 3.01, 5.01) names Mars, Incorporated as Parent (Acquiror 10VB8, LLC); Form 25-NSE 2025-12-11; Form 15-12G 2025-12-22." },
  { ticker: 'WBA', delistingDate: '2025-08-28', reason: 'taken private by Sycamore Partners', evidence: "Alpha Vantage row 'WBA, Walgreens Boots Alliance Inc, NASDAQ, delisted 2025-08-28'; SEC 8-K filed 2025-08-28 (items 2.01, 3.01, 5.01) states Blazing Star Parent LLC is an affiliate of funds managed by Sycamore Partners Management, with Schedule 13E-3 going-private filings; Form 25-NSE 2025-08-28; Form 15-12G 2025-09-08." },
  { ticker: 'HES', delistingDate: '2025-07-18', reason: 'acquired by Chevron', evidence: 'Not in either Alpha Vantage delisted pull; SEC 8-K filed 2025-07-18 (items 2.01, 3.01, 5.01) names Chevron Corporation (Yankee Merger Sub) as acquirer and says NYSE trading was suspended on the closing date; Form 25-NSE 2025-07-18; Form 15-12G 2025-07-28.' },
  { ticker: 'CTRA', delistingDate: '2026-05-06', reason: 'acquired by Devon Energy', evidence: "Alpha Vantage row 'CTRA, Coterra Energy Inc, NYSE, delisted 2026-05-06'; SEC 8-K filed 2026-05-07 (items 2.01, 3.01, 5.01) records the 2026-05-07 closing with each share converted into 0.70 Devon Energy shares; Form 25-NSE 2026-05-07; Form 15-12G 2026-05-19." },
  { ticker: 'IPG', delistingDate: '2025-11-26', reason: 'acquired by Omnicom Group', evidence: "Alpha Vantage row 'IPG, Interpublic Group Of Cos. Inc, NYSE, delisted 2025-11-26'; SEC 8-K filed 2025-11-26 (items 2.01, 3.01, 5.01) records 0.344 Omnicom shares per share; Form 25-NSE 2025-11-28; Form 15-12G 2025-12-08." },
  { ticker: 'INST', delistingDate: '2024-11-13', reason: 'taken private by KKR', evidence: "Alpha Vantage row 'INST, Instructure Holdings Inc, NYSE, delisted 2024-11-13'; SEC (CIK 1841804) 8-K filed 2024-11-13 (items 2.01, 3.01, 5.01) states Icon Parent Inc. is an affiliate of funds managed by Kohlberg Kravis Roberts; Form 25-NSE 2024-11-13; Form 15-12G 2024-11-25." },
  { ticker: 'JAMF', delistingDate: '2026-01-30', reason: 'taken private by Francisco Partners', evidence: "Alpha Vantage row 'JAMF, Jamf Holding Corp, NASDAQ, delisted 2026-01-30'; SEC 8-K filed 2026-02-02 (items 2.01, 3.01, 5.01) records the 2026-01-30 closing with Jawbreaker Parent, an affiliate of Francisco Partners; Form 25-NSE 2026-01-30; Form 15-12G 2026-02-09." },
  { ticker: 'SEMR', delistingDate: '2026-04-28', reason: 'acquired by Adobe', evidence: "Alpha Vantage row 'SEMR, SEMrush Holdings Inc - Class A, NYSE, delisted 2026-04-28'; SEC 8-K filed 2026-04-28 (items 2.01, 3.01, 5.01) states Adobe Inc. completed its acquisition; Form 25-NSE 2026-04-28; Form 15-12G 2026-05-08." },
  { ticker: 'SMAR', delistingDate: '2025-01-22', reason: 'taken private by Blackstone, Vista Equity Partners and ADIA', evidence: "Alpha Vantage row 'SMAR, Smartsheet Inc - Class A, NYSE, delisted 2025-01-22'; SEC 8-K filed 2025-01-22 (items 2.01, 3.01, 5.01) states Einstein Parent was formed by affiliates of Blackstone, Vista Equity Partners and the Abu Dhabi Investment Authority; Form 25-NSE 2025-01-22." },
  { ticker: 'EB', delistingDate: '2026-03-10', reason: 'acquired by Bending Spoons', evidence: "Alpha Vantage row 'EB, Eventbrite Inc - Class A, NYSE, delisted 2026-03-10'; SEC 8-K filed 2026-03-10 (items 2.01, 3.01, 5.01) names Bending Spoons US Inc., a subsidiary of Bending Spoons S.p.A.; Form 25-NSE 2026-03-10; Form 15-12G 2026-03-20." },
  { ticker: 'AMED', delistingDate: '2025-08-14', reason: 'acquired by UnitedHealth Group', evidence: "Alpha Vantage row 'AMED, Amedisys Inc, NASDAQ, delisted 2025-08-14'; SEC 8-K filed 2025-08-14 (items 2.01, 3.01, 5.01) names UnitedHealth Group Incorporated at $101 cash per share; Form 25-NSE 2025-08-14; Form 15-12G 2025-08-25." },
  { ticker: 'APLS', delistingDate: '2026-05-14', reason: 'acquired by Biogen', evidence: "Alpha Vantage row 'APLS, Apellis Pharmaceuticals Inc, NASDAQ, delisted 2026-05-14'; SEC 8-K filed 2026-05-14 (items 2.01, 3.01, 5.01) records completion of Biogen Inc.'s tender offer ($41 cash plus a CVR) with Nasdaq trading suspended after 2026-05-13; SC TO-T 2026-04-14; Form 25-NSE 2026-05-14; Form 15-12G 2026-05-26." },
  { ticker: 'BPMC', delistingDate: '2025-07-18', reason: 'acquired by Sanofi', evidence: "Not in either Alpha Vantage delisted pull; SEC 8-K filed 2025-07-18 (items 2.01, 3.01, 5.01) records completion of Sanofi's tender offer (Aventis Inc. / Rothko Merger Sub) on 2025-07-17; Form 25-NSE 2025-07-18; Form 15-12G 2025-07-29." },
  { ticker: 'FOLD', delistingDate: '2026-04-27', reason: 'acquired by BioMarin Pharmaceutical', evidence: "Alpha Vantage row 'FOLD, Amicus Therapeutics Inc, NASDAQ, delisted 2026-04-27'; SEC 8-K filed 2026-04-27 (items 2.01, 3.01, 5.01) names BioMarin Pharmaceutical Inc. (Lynx Merger Sub 1) as acquirer; Form 25-NSE 2026-04-27; Form 15-12G 2026-05-07." },
  { ticker: 'ITCI', delistingDate: '2025-04-02', reason: 'acquired by Johnson & Johnson', evidence: "Alpha Vantage row 'ITCI, Intra-Cellular Therapies Inc, NASDAQ, delisted 2025-04-02'; SEC 8-K filed 2025-04-02 (items 2.01, 3.01, 5.01) names Johnson & Johnson (Fleming Merger Sub) as acquirer; Form 25-NSE 2025-04-02; Form 15-12G 2025-04-14." },
  { ticker: 'NARI', delistingDate: '2025-02-19', reason: 'acquired by Stryker', evidence: "Alpha Vantage row 'NARI, Inari Medical Inc, NASDAQ, delisted 2025-02-19'; SEC (CIK 1531048) 8-K filed 2025-02-19 (items 2.01, 3.01, 5.01) records completion of Stryker Corporation's $80 cash tender offer; Form 25-NSE 2025-02-19; Form 15-12G 2025-03-03." },
  { ticker: 'PDCO', delistingDate: '2025-04-17', reason: 'taken private by Patient Square Capital', evidence: "Alpha Vantage row 'PDCO, Patterson Companies Inc, NASDAQ, delisted 2025-04-17'; SEC 8-K filed 2025-04-17 (items 2.01, 3.01, 5.01) states Paradigm Parent LLC is a subsidiary of funds managed by Patient Square Capital ($31.35 cash per share); Form 25-NSE 2025-04-17; Form 15-12G 2025-04-28." },
  { ticker: 'SNV', delistingDate: '2025-12-31', reason: 'merged into Pinnacle Financial Partners', evidence: "Alpha Vantage row 'SNV, Synovus Financial Corp, NYSE, delisted 2025-12-31'; SEC 8-K filed 2026-01-02 (items 2.01, 3.01, 5.01) records that on 2026-01-01 Synovus and Pinnacle both merged into Steel Newco Inc., renamed Pinnacle Financial Partners, Inc.; Form 25-NSE 2026-01-02; Form 15-12G 2026-01-12." },
  { ticker: 'BECN', delistingDate: '2025-04-29', reason: 'acquired by QXO', evidence: "Alpha Vantage row 'BECN, Beacon Roofing Supply Inc - Class A, NASDAQ, delisted 2025-04-29'; the SEC registrant is now named QXO Building Products, Inc., and its 8-K filed 2025-04-29 (items 2.01, 3.01, 5.01) records completion of QXO, Inc.'s $124.35 cash tender offer; Form 25-NSE 2025-04-29; Form 15-12G 2025-05-09." },
  { ticker: 'EVRI', delistingDate: '2025-07-01', reason: 'taken private by Apollo Global Management funds', evidence: "Alpha Vantage row 'EVRI, Everi Holdings Inc, NYSE, delisted 2025-07-01'; SEC 8-K filed 2025-07-01 (items 2.01, 3.01, 5.01) describes the combined purchase of Everi and IGT's gaming business by a buyer backed by Apollo Global Management funds; Form 25-NSE 2025-07-01; Form 15-12G 2025-07-11." },
  { ticker: 'FL', delistingDate: '2025-09-08', reason: "acquired by DICK'S Sporting Goods", evidence: "The Alpha Vantage row for FL carries the snapshot placeholder date (2026-09-09 in the Sep 10 pull, 2026-09-15 in the Sep 16 pull), so the date comes from the SEC: 8-K filed 2025-09-08 (items 2.01, 3.01, 5.01) names DICK'S Sporting Goods (RJS Sub LLC) with closing on 2025-09-08; Form 25-NSE 2025-09-08; Form 15-12G 2025-09-18." },
  { ticker: 'HBI', delistingDate: '2025-12-01', reason: 'acquired by Gildan Activewear', evidence: "The Alpha Vantage row for HBI carries the snapshot placeholder date (2026-09-15); SEC 8-K filed 2025-12-01 (items 2.01, 3.01, 5.01) records Gildan Activewear's acquisition on 2025-12-01 at 0.102 Gildan shares plus cash per share; Form 25-NSE 2025-12-01; Form 15-12G 2025-12-11." },
  { ticker: 'JWN', delistingDate: '2025-05-20', reason: 'taken private by the Nordstrom family and El Puerto de Liverpool', evidence: "Alpha Vantage row 'JWN, Nordstrom Inc, NYSE, delisted 2025-05-20'; SEC 8-K filed 2025-05-20 (items 2.01, 3.01, 5.01) states Nordstrom Holdings, Inc. was formed by members of the Nordstrom family with Liverpool holding rollover shares, alongside Schedule 13E-3 going-private filings; Form 25-NSE 2025-05-21; Form 15-12G 2025-06-02." },
  { ticker: 'SKX', delistingDate: '2025-09-12', reason: 'taken private by 3G Capital', evidence: "Alpha Vantage row 'SKX, Skechers U S A Inc - Class A, NYSE, delisted 2025-09-12'; SEC 8-K filed 2025-09-12 (items 2.01, 3.01, 5.01) states the buyer parties are affiliates of funds managed by 3G Capital Partners; Form 25-NSE 2025-09-12; Form 15-12G 2025-09-23." },
  { ticker: 'KLG', delistingDate: '2025-09-25', reason: 'acquired by Ferrero', evidence: "Alpha Vantage row 'KLG, WK Kellogg Company, NYSE, delisted 2025-09-25'; SEC 8-K filed 2025-09-26 (items 2.01, 3.01, 5.01) names Ferrero International S.A. with closing on 2025-09-26; Form 25-NSE 2025-09-26; Form 15-12G 2025-10-06." },
  { ticker: 'THS', delistingDate: '2026-02-11', reason: 'taken private (parent Industrial F&B Investments II, Inc.; sponsor not named in the closing 8-K)', evidence: "Alpha Vantage row 'THS, Treehouse Foods Inc, NYSE, delisted 2026-02-11'; SEC 8-K filed 2026-02-11 (items 2.01, 3.01, 5.01) records the merger into a subsidiary of Industrial F&B Investments II, Inc.; Form 25-NSE 2026-02-11; Form 15-12G 2026-02-23." },
  { ticker: 'BERY', delistingDate: '2025-04-29', reason: 'acquired by Amcor', evidence: "Alpha Vantage row 'BERY, Berry Global Group Inc, NYSE, delisted 2025-04-29'; SEC 8-K filed 2025-04-30 (items 2.01, 3.01, 5.01) records 7.25 Amcor plc shares per share with closing on 2025-04-30; Form 25-NSE 2025-04-30; Form 15-12G 2025-05-12." },
  { ticker: 'NEX', delistingDate: '2023-08-31', reason: 'merged into Patterson-UTI Energy', evidence: "Alpha Vantage row 'NEX, NexTier Oilfield Solutions Inc, NYSE, delisted 2023-08-31'; SEC 8-K filed 2023-09-01 (items 2.01, 3.01, 5.01) records the merger of equals with Patterson-UTI Energy completed 2023-09-01; Form 25-NSE 2023-09-01; Form 15-12G 2023-09-12." },
  { ticker: 'LTHM', delistingDate: '2024-01-04', reason: 'merged into Arcadium Lithium (ALTM), which was itself delisted 2025-03-05', evidence: "Alpha Vantage row 'LTHM, Livent Corp, NYSE, delisted 2024-01-04'; SEC 8-K filed 2024-01-04 (items 3.01, 5.01) records the combination of Livent and Allkem under Arcadium Lithium plc; Form 25-NSE 2024-01-10; Form 15-12G 2024-01-22; Alpha Vantage also lists 'ALTM, Arcadium Lithium PLC, NYSE, delisted 2025-03-05' and Yahoo returns 404 for ALTM, so there is no live successor." },
  { ticker: 'SEE', delistingDate: '2026-04-09', reason: 'taken private by Clayton, Dubilier & Rice', evidence: "Alpha Vantage row 'SEE, Sealed Air Corp, NYSE, delisted 2026-04-09'; SEC 8-K filed 2026-04-09 (items 2.01, 3.01, 5.01) states Sword Purchaser LLC is an affiliate of Clayton, Dubilier & Rice; Form 25-NSE 2026-04-09; Form 15-12G 2026-04-20." },
  { ticker: 'ALE', delistingDate: '2025-12-15', reason: 'taken private (parent Alloy Parent LLC; sponsors not named in the closing 8-K)', evidence: 'The Alpha Vantage row for ALE carries the snapshot placeholder date (2026-09-15); SEC 8-K filed 2025-12-15 (items 2.01, 3.01, 5.01) records the cash merger into Alloy Parent LLC on 2025-12-15 at $67 per share; Form 25-NSE 2025-12-15; Form 15-12G 2025-12-29.' },
  { ticker: 'PCH', delistingDate: '2026-02-02', reason: 'acquired by Rayonier', evidence: "Alpha Vantage row 'PCH, PotlatchDeltic Corp, NASDAQ, delisted 2026-02-02'; SEC 8-K filed 2026-02-02 (items 2.01, 3.01, 5.01) records the merger with Rayonier Inc. closed 2026-01-30 at 1.8185 Rayonier shares plus $0.61 cash per share; Form 15-12G 2026-02-12." },
  { ticker: 'EA', delistingDate: '2026-08-04', reason: 'taken private by a consortium of the Public Investment Fund, Silver Lake and Affinity Partners', evidence: "Alpha Vantage row 'EA, Electronic Arts Inc, NASDAQ, delisted 2026-08-04'; SEC (CIK 712515) 8-K filed 2026-08-04 (items 2.01, 3.01, 5.01) records the merger with Oak-Eagle AcquireCo, formed by a consortium of the Public Investment Fund, Silver Lake and Affinity Partners, at $210 cash per share; DEFM14A 2025-11-20; Form 25-NSE 2026-08-04; Form 15-12G 2026-08-14; the SEC ticker map no longer lists EA. Yahoo answers HTTP 200 for EA with a one-bar stub dated 2026-08-04, which is why the 404 probe missed it." },
  { ticker: 'IAS', delistingDate: '2025-12-23', reason: 'taken private by Novacap', evidence: "Not in either Alpha Vantage delisted pull; SEC (CIK 1842718) 8-K filed 2025-12-23 (items 2.01, 3.01, 5.01) records the merger with Igloo Group Parent, an affiliate of investment funds managed by Novacap Management Inc., at $10.30 cash per share; Form 25-NSE 2025-12-23; Form 15-12G 2026-01-02; the SEC ticker map no longer lists IAS. Yahoo answers HTTP 200 with a one-bar stub dated 2025-12-22." },
  { ticker: 'CPRX', delistingDate: '2026-07-16', reason: 'acquired by Angelini Pharma', evidence: "Alpha Vantage row 'CPRX, Catalyst Pharmaceuticals Inc, NASDAQ, delisted 2026-07-16'; SEC (CIK 1369568) 8-K filed 2026-07-16 (items 2.01, 3.01, 5.01) records the 2026-07-15 merger with Angelini Cielo Inc., a subsidiary of Angelini Pharma S.p.A., at $31.50 cash per share; DEFM14A 2026-06-08; Form 25-NSE 2026-07-15; Form 15-12G 2026-07-24. Yahoo answers HTTP 200 with a one-bar stub dated 2026-07-14." },
  { ticker: 'NSA', delistingDate: '2026-07-22', reason: 'acquired by Public Storage', evidence: "Alpha Vantage row 'NSA, National Storage Affiliates Trust, NYSE, delisted 2026-07-22'; SEC (CIK 1618563) 8-K filed 2026-07-22 (items 2.01, 3.01, 5.01) records completion of Public Storage's acquisition at 0.1400 Public Storage common shares per NSA share; DEFM14A 2026-06-12; Form 25-NSE 2026-07-22; Form 15-12G 2026-08-03; the SEC ticker map no longer lists NSA. Yahoo answers HTTP 200 with a one-bar stub dated 2026-07-21." },
  { ticker: 'AVB', delistingDate: '2026-08-17', reason: 'acquired by Equity Residential (now Vivmark Residential, VMRK)', evidence: "Alpha Vantage row 'AVB, Avalonbay Communities Inc, NYSE, delisted 2026-08-17'; SEC (CIK 915912) 8-K filed 2026-08-17 (items 2.01, 3.01, 5.01) records the merger into a subsidiary of Equity Residential, renamed Vivmark Residential, at 2.793 Vivmark common shares per AvalonBay share; DEFM14A 2026-07-13; Form 25-NSE 2026-08-17; Form 15-12G 2026-08-27; the SEC ticker map no longer lists AVB. Yahoo answers HTTP 200 for AVB with a 43-bar stub from 2026-07-17 whose closes track the Vivmark series scaled by the exchange ratio, not AvalonBay's own history; the acquirer's history continues under VMRK (see the EQR rename)." },
  { ticker: 'WBS', delistingDate: '2026-08-20', reason: 'acquired by Banco Santander', evidence: "Alpha Vantage row 'WBS, Webster Financial Corp, NYSE, delisted 2026-08-20'; SEC (CIK 801337) 8-K filed 2026-08-20 (items 2.01, 3.01, 5.01) records that Banco Santander, S.A. acquired all outstanding Webster common stock through a share exchange at 2.0548 Banco Santander American Depositary Shares plus $48.75 cash per share and contributed it to Santander Holdings USA; DEFM14A 2026-04-23; Form 25-NSE 2026-08-20; Form 15-12G 2026-08-31. Yahoo answers HTTP 200 with a 43-bar stub from 2026-07-17." },
  { ticker: 'CRNX', delistingDate: '2026-09-01', reason: 'acquired by Vertex Pharmaceuticals', evidence: "Alpha Vantage row 'CRNX, Crinetics Pharmaceuticals Inc, NASDAQ, delisted 2026-09-01'; SEC (CIK 1658247) 8-K filed 2026-09-01 (items 2.01, 3.01, 5.01) records the merger with Clark Merger Sub, a subsidiary of Vertex Pharmaceuticals Incorporated, at $85.00 cash per share (about $10.0 billion in all); DEFM14A 2026-07-31; Form 25-NSE 2026-09-01; Form 15-12G 2026-09-11. Yahoo answers HTTP 200 with a 43-bar stub from 2026-07-17." },
  { ticker: 'WOLF', delistingDate: '2025-09-26', reason: 'old common stock cancelled in Chapter 11; the WOLF listed on the NYSE since 2025-09-29 is a new security', evidence: "Alpha Vantage rows 'WOLF, Wolfspeed Inc, NASDAQ, delisted 2025-09-26' and 'WOLF, Wolfspeed Inc (New), NYSE, listed 2025-09-29'; SEC (CIK 895419) 8-K filed 2025-07-01 (items 1.03, 2.04) records the Chapter 11 petition, Form 8-A12B 2025-09-26 registers the new common stock on the NYSE, Form 25-NSE 2025-09-29 removes the old stock, and the 8-K filed 2025-09-30 (items 1.03, 3.03, 5.01, 5.03) records the plan's effectiveness on 2025-09-29 with the old shares cancelled and retired and 25,840,656 shares of new common stock issued. Yahoo serves only the new security under WOLF: 243 daily bars from 2025-09-29 and none of the registered company's 1993-2025 history, so the warm-up's stub rule flags it and the ledger sets it aside." },
  // The two recycled symbols. Both left the market in 2025, and Yahoo and
  // the SEC ticker map have since handed each symbol to a different company
  // whose own chart is long enough to pass both stub rules, so the warm-up
  // would have fetched the wrong company's history under the registered
  // name without a word. The identity re-probe of 2026-09-16 (every
  // fetchable name's SEC CIK and Yahoo meta against the catalog's sector
  // placement) found them; the identity ledger and the warm-up identity
  // check now catch any future case of the same kind.
  {
    ticker: 'PARA',
    delistingDate: '2025-08-07',
    reason: 'merged into Paramount Skydance (PSKY), a new SEC registrant; the symbol has since been reused by Banzai International',
    recycledBy: 'Banzai International, Inc. (SEC CIK 1826011; Nasdaq; SIC 7372 prepackaged software; Yahoo chart under PARA from 2021-02-12)',
    evidence:
      "SEC (CIK 813828, Paramount Global; formerly ViacomCBS Inc., CBS Corp and Viacom Inc) 8-K filed 2025-08-07 (items 1.01, 1.02, 2.01, 3.01, 3.03, 5.01, 5.02, 5.03) records the closing of the Skydance Media transaction with Paramount Skydance Corporation (f/k/a New Pluto Global, Inc.) as the new parent, says trading in Paramount's Class A and Class B shares was halted at the close on 2025-08-06 and that the Form 25 delisting them from Nasdaq would be filed on 2025-08-07; Form 25-NSE filed 2025-08-07; Form 15-12G filed 2025-08-18; the SEC ticker map lists no ticker under CIK 813828. " +
      'The combined company files under a NEW CIK, 2041610 (Paramount Skydance Corp, registered 2024-11-04 as New Pluto Global, Inc.; 8-K12B successor-issuer notice filed 2025-08-07; ticker PSKY on Nasdaq), so PSKY is a different registrant and the rename rule (the successor must sit under the company\'s own CIK) does not apply, although Yahoo\'s PSKY chart reaches back to 2005-12-05; this is a merger, not a rename. ' +
      "Yahoo and the SEC ticker map now serve PARA as Banzai International, Inc. (CIK 1826011, Nasdaq, SIC 7372; 7GC & Co. Holdings Inc., a SPAC, until 2023-12-15; Yahoo chart from 2021-02-12, 1,404 daily bars on 2026-09-16), so the symbol passes both stub rules with the wrong company's history. The catalog filed PARA under Communications beside WBD, FOXA and NWSA, i.e. Paramount Global.",
  },
  {
    ticker: 'B',
    delistingDate: '2025-01-27',
    reason: 'taken private by Apollo Global Management funds; the symbol has since been reused by Barrick Mining',
    recycledBy: 'Barrick Mining Corporation (SEC CIK 756894, Barrick Gold Corp until 2025-04-29; NYSE; Yahoo chart under B with first-trade date 1985-02-13)',
    evidence:
      "SEC (CIK 9984, Barnes Group Inc.) 8-K filed 2025-01-27 (items 1.01, 1.02, 2.01, 2.03, 3.01, 3.03, 5.01, 5.02, 5.03, 8.01) records that Goat Holdco, LLC completed its acquisition of Barnes Group through Goat Merger Sub, Inc., that Parent and Merger Sub are affiliates of funds managed by affiliates of Apollo Global Management, Inc., and that NYSE trading was halted before the open on the closing date; Form 25-NSE filed 2025-01-27; Form 15-12G filed 2025-02-06; the SEC ticker map lists no ticker under CIK 9984, and Barnes's own price history is served nowhere. " +
      "Yahoo and the SEC ticker map now serve B as Barrick Mining Corporation (CIK 756894, Barrick Gold Corp until 2025-04-29, NYSE; Yahoo meta first-trade date 1985-02-13, 10,076 daily bars on a 40-year fetch on 2026-09-16), so the symbol passes both stub rules with the wrong company's four decades of history. The catalog filed B under Industrials beside AUR and CCK, i.e. Barnes Group.",
  },
]

/** Why a rename cannot be applied, in plain words, or null when the
 * successor's chart carries the history the original symbol would have
 * contributed. Two things must hold:
 *
 *   1. The successor's chart starts no later than the company's own first
 *      trading day (originalFirstTrade). That day is the earliest sample
 *      the original symbol could contribute to any run, whatever its range
 *      or burn-in (for names older than the run's first sample date the
 *      run's own floor is later still), so a successor that starts after it
 *      would be missing history the original would have had. A recycled
 *      symbol, whose chart starts at its 2026 re-listing, fails here.
 *   2. The successor's chart starts before the change took effect, so it
 *      is the same series continued and not a fresh listing that starts at
 *      the change.
 *
 * The earlier version of this guard compared the successor's first bar with
 * the resolution day (in effect "today") for renames whose exact switch day
 * was unknown, which any existing chart passes; it could not have caught a
 * recycled symbol. All three dates must be ISO calendar dates. */
export function renameContinuityProblem(rename: Pick<TickerRename, 'successorFirstTrade' | 'effectiveDate' | 'originalFirstTrade'>): string | null {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/
  const dates: Array<[string, unknown]> = [
    ['successorFirstTrade', rename.successorFirstTrade],
    ['effectiveDate', rename.effectiveDate],
    ['originalFirstTrade', rename.originalFirstTrade],
  ]
  for (const [field, value] of dates) {
    if (typeof value !== 'string' || !isoDate.test(value)) return `${field} is not an ISO calendar date (${String(value)})`
  }
  if (rename.successorFirstTrade > rename.originalFirstTrade) {
    return (
      `the successor's first trade (${rename.successorFirstTrade}) is after the company's own first trading day (${rename.originalFirstTrade}), ` +
      'so its chart cannot be the same series: it looks like a recycled symbol or a fresh listing'
    )
  }
  if (rename.successorFirstTrade >= rename.effectiveDate) {
    return `the successor's first trade (${rename.successorFirstTrade}) does not predate the rename (${rename.effectiveDate}), so its chart would be a fresh listing, not the same series`
  }
  return null
}

/** True when renameContinuityProblem finds nothing wrong. */
export function renameHasHistoryContinuity(rename: Pick<TickerRename, 'successorFirstTrade' | 'effectiveDate' | 'originalFirstTrade'>): boolean {
  return renameContinuityProblem(rename) == null
}

/** The symbol a registered name's history is fetched under: its successor
 * when the rename ledger has one with a continuous history, otherwise the
 * name itself. */
export function resolveFetchSymbol(
  ticker: string,
  renames: Readonly<Record<string, TickerRename>> = TICKER_RENAMES,
): string {
  const normalized = ticker.trim().toUpperCase()
  const rename = renames[normalized]
  if (rename == null) return normalized
  const problem = renameContinuityProblem(rename)
  if (problem != null) {
    throw new Error(`Ticker rename ${normalized} -> ${rename.successor} lacks history continuity: ${problem}.`)
  }
  return rename.successor.trim().toUpperCase()
}

/** How much of the registered universe left the market and could not be
 * included, in the words the run prints and the artifact stores. */
export type UniverseAttrition = {
  registeredNames: number
  excludedNames: number
  /** excludedNames / registeredNames; 0 when nothing was registered. */
  excludedShare: number
  statement: string
}

export function describeUniverseAttrition(registeredNames: number, excludedNames: number): UniverseAttrition {
  const excludedShare = registeredNames > 0 ? excludedNames / registeredNames : 0
  return {
    registeredNames,
    excludedNames,
    excludedShare,
    statement:
      `${excludedNames} of ${registeredNames} registered names (${(excludedShare * 100).toFixed(1)}%) left the market during the window ` +
      'and could not be included: no free source serves their price history, or the business continues only under a new SEC registrant; results are survivor-biased by at least this share.',
  }
}

export type UniverseFetchPlan = {
  /** The registered names, normalized, in the order given. */
  registered: string[]
  /** What will actually be fetched, in registered order: the sample keeps
   * `ticker` as its identity and the request goes out under `fetchedAs`. */
  fetch: Array<{ ticker: string; fetchedAs: string }>
  renamed: Array<{ original: string; fetchedAs: string; effectiveDate: string; note: string }>
  excluded: Array<ExcludedUnfetchable & { status: 'registered but excluded' }>
  attrition: UniverseAttrition
}

/**
 * Splits a registered ticker list into what gets fetched (and under which
 * symbol) and what is set aside as registered but excluded. The ledgers
 * default to the two above; tests pass their own. Refuses a ledger that
 * lists a name as both renamed and excluded, a rename without history
 * continuity, and two registered names that would fetch the same symbol
 * (the same history twice would double-weight one company).
 */
export function planUniverseFetch(
  tickers: readonly string[],
  ledger: { renames?: Readonly<Record<string, TickerRename>>; excluded?: readonly ExcludedUnfetchable[] } = {},
): UniverseFetchPlan {
  const renames = ledger.renames ?? TICKER_RENAMES
  const excludedLedger = ledger.excluded ?? EXCLUDED_UNFETCHABLE
  const excludedByTicker = new Map(excludedLedger.map((entry) => [entry.ticker.trim().toUpperCase(), entry]))
  for (const original of Object.keys(renames)) {
    if (excludedByTicker.has(original.trim().toUpperCase())) {
      throw new Error(`Ticker ${original} is listed both as renamed and as excluded; the ledgers must disagree on nothing.`)
    }
  }
  const registered = tickers.map((ticker) => ticker.trim().toUpperCase())
  const fetch: UniverseFetchPlan['fetch'] = []
  const renamed: UniverseFetchPlan['renamed'] = []
  const excluded: UniverseFetchPlan['excluded'] = []
  for (const ticker of registered) {
    const exclusion = excludedByTicker.get(ticker)
    if (exclusion != null) {
      excluded.push({ ...exclusion, ticker, status: 'registered but excluded' })
      continue
    }
    const fetchedAs = resolveFetchSymbol(ticker, renames)
    if (fetchedAs !== ticker) {
      const rename = renames[ticker]
      renamed.push({ original: ticker, fetchedAs, effectiveDate: rename.effectiveDate, note: rename.note })
    }
    fetch.push({ ticker, fetchedAs })
  }
  const seenFetchSymbols = new Map<string, string>()
  for (const entry of fetch) {
    const providerSymbol = normalizeYahooSymbol(entry.fetchedAs)
    const earlier = seenFetchSymbols.get(providerSymbol)
    if (earlier != null) {
      throw new Error(
        `Registered names ${earlier} and ${entry.ticker} would both fetch ${entry.fetchedAs}; one company's history would enter the dataset twice.`,
      )
    }
    seenFetchSymbols.set(providerSymbol, entry.ticker)
  }
  return {
    registered,
    fetch,
    renamed,
    excluded,
    attrition: describeUniverseAttrition(registered.length, excluded.length),
  }
}

export type HorizonKey = 5 | 20 | 60 | 120

export type HistoricalSample = {
  ticker: string
  asOf: string
  asOfIndex: number   // bar index within the ticker's series — needed for purging
  features: number[]
  rawFeatures: number[]  // pre-normalization values for diagnostic display
  // RAW forward returns at multiple horizons — what the L/S portfolio
  // actually earns (the tradeable spread).
  forwardReturn5d: number
  forwardReturn20d: number
  forwardReturn60d: number
  forwardReturn120d: number
  // RELATIVE forward returns: raw minus that date's cross-sectional mean
  // return at the same horizon. The TRAINING TARGET and the IC are measured
  // against these — a cross-sectional model can only predict RELATIVE
  // (idiosyncratic) performance; the common market/cross-section move is
  // unpredictable noise that, left in the target, just dilutes the loss.
  // (Filled by applyCrossSectionalReturnDemeaning; default to raw until then.)
  forwardReturn5dRel: number
  forwardReturn20dRel: number
  forwardReturn60dRel: number
  forwardReturn120dRel: number
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
  /** Raw natural-log market cap at formation (NaN when no fundamentals),
   * captured at build time so the size-tiered cost model survives feature
   * pruning — it must not depend on fund_log_market_cap staying in the
   * model's column set. */
  logMarketCap: number
  /** Trailing 20-day average dollar volume at formation (raw exchange price
   * times shares, the same number the Amihud feature is built from), kept
   * beside logMarketCap so the cost model can size a name that has no filed
   * cap (see costTierMarketCapUsd). Absent on rows built before 2026-09-16
   * and on synthetic fixtures, in which case an unfiled name falls to the
   * bottom tier as before. */
  avgDollarVolume20d?: number
  /** True when a real SEC snapshot was available at formation. Kept separate
   * from capped filing age: a stale-but-real snapshot and the no-data sentinel
   * can both equal FUNDAMENTAL_MISSING_AGE_DAYS. */
  pitFundamentalsObserved?: boolean
  /** Survivorship cohort AT FORMATION (assigned per cross-section date):
   *  'survivorPrivileged' = listed < 3y (Fama-French 2004 new-list
   *  failure window) OR bottom size-quintile of that date's cross-section
   *  (Hou-Xue-Zhang 2020 microcap screen) — where survivor bias lives.
   *  'core' = established-then. 'noFundamentals' = ETFs/non-filers,
   *  excluded from cohort diagnostics. */
  cohort?: 'core' | 'survivorPrivileged' | 'noFundamentals'
  /** Twelve-month momentum that SKIPS the most recent month: close 21 bars
   * before formation over close 252 bars before, minus one, in percent. This
   * is the Jegadeesh-Titman (1993) "12-1" convention. It is kept OUT of the
   * feature vector so the model's inputs do not change; it exists only as
   * the momentum yardstick the model is compared against. Raw as computed
   * from the bars; `momentum12to1` is the same number Z-scored within its
   * date exactly as the feature columns are. Absent on rows built before
   * this field existed, in which case the 12-1 baseline reads unavailable. */
  momentum12to1Raw?: number
  momentum12to1?: number
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
  // Tail/lottery (3) — candidates added 2026-07-07; the FDR screen decides
  // whether they ship, same as every other feature.
  //   max_daily_ret_21d — Bali-Cakici-Whitelaw (2011): the "MAX" lottery
  //   effect; a big recent one-day pop attracts lottery demand that then
  //   underperforms.
  //   downside_vol_60d — Ang-Chen-Xing (2006): semi-deviation of negative
  //   days only; downside risk is priced differently than total vol.
  //   vol_of_vol_60d — instability of the volatility regime itself
  //   (Baltas-Karyampas 2018): how much the rolling 20d vol wobbles.
  'max_daily_ret_21d',
  'downside_vol_60d',
  'vol_of_vol_60d',
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
  // ---------------------------------------------------------------------
  // Company-type descriptors (3) — added 2026-09-10 as CANDIDATES only. They
  // are appended AFTER the fundamentals block on purpose, so not one existing
  // feature changes position and the saved model bundle keeps resolving its
  // columns by name exactly as before. The FDR screen decides whether any of
  // them ship, the same as every other candidate here.
  //
  // The owner asked for variables that say what KIND of company a name is.
  // The obvious answer would have been the sector label, and this repository
  // does hold one for every symbol - but every single one of the 1,359
  // backtest names draws its label from the hand-curated half of the universe
  // file, which is one person's 2026 judgement about companies whose whole
  // return history is already known, and which includes outcome-flavoured
  // buckets such as "Speculative Growth". Stamping that onto a 2013 sample
  // tells the model how the story ended. The SEC's own numeric industry code
  // would be the defensible point-in-time answer, and the universe generator
  // already fetches it per company and caches it - but it immediately folds it
  // down into one of those coarse sector strings and keeps only that, so the
  // number itself never reaches this file. So the descriptors below are read
  // out of the price and filing record that already existed at each sample's
  // own date instead:
  //
  //   payout_yield_252d - trailing 12-month cash-distribution yield, taken
  //   from the ratio of two historical adjustment factors. Fama-French (2001,
  //   "Disappearing Dividends") establish payers and non-payers as
  //   structurally different kinds of firm; payout level is also a duration
  //   descriptor. It is the only company-type number that exists for the ~286
  //   funds in the universe, which otherwise carry no filings at all.
  //
  //   filing_cadence_3y - distinct SEC filing dates over the trailing three
  //   years, per year. A US domestic filer reports about four times a year, a
  //   foreign private issuer once or twice, a fund never. It is the only
  //   proxy available here for domicile and depositary-receipt status, and
  //   disclosure frequency is the information-environment variable behind
  //   post-earnings drift (Bernard-Thomas 1989).
  //
  //   capital_intensity_3y - capital spending as a share of revenue over the
  //   latest annual periods on file. This is the company type stated as a
  //   number rather than a label: utilities, energy producers and chip makers
  //   are capital-hungry, software and services are not, and unlike a sector
  //   label it also catches the asset-light firm sitting inside a heavy
  //   sector (Titman-Wei-Xie 2004; Fama-French 2015).
  //
  // Three descriptors and no more. Five were drafted and two were withdrawn
  // the same day, because each one only restated something the pipeline
  // already had. A "does this name file with the SEC" flag was the same fact
  // as sample.pitFundamentalsObserved, which buildHistoricalDataset already
  // records from the identical lookup at the identical date, and it was
  // already implied by filing_cadence_3y, which reads zero exactly when no
  // filing landed in three years. A "is it losing money" flag was a fixed
  // threshold on fund_net_margin, whose clamp keeps the sign, so the two
  // columns agreed everywhere the margin was observed; a depth-three boosted
  // tree can already put a split at zero, and the argument for handing a
  // model a ready-made indicator is an argument about straight-line models.
  // Six peer-relative columns were withdrawn as well - the note further down
  // this file, where their code used to live, says why and what would bring
  // them back.
  'payout_yield_252d',
  'filing_cadence_3y',
  'capital_intensity_3y',
]

export const FUNDAMENTAL_FEATURE_COUNT = 13
/** Number of company-type descriptor columns appended after the
 * fundamentals block. */
export const COMPANY_DESCRIPTOR_FEATURE_COUNT = 3
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
    /** Start of the fetch window the bars came from (the 40-year boundary
     * of a 'max' fetch). A name whose first bar sits on this boundary was
     * not listed there, its history was CUT there, so its listing age is
     * unknown and reads as the missing sentinel (NaN), which the causal
     * imputation later fills and flags. Leave unset (the live path does)
     * and the first bar is taken at face value. */
    fetchWindowStartMs?: number
  },
): number[] | null {
  if (dateIndex < 252) return null  // need 252 bars for the 1-year features
  const window = bars.slice(0, dateIndex)
  const closes = window.map((bar) => bar.close)
  // Ratios/returns use total-return-adjusted close. Absolute price and dollar
  // volume must use the contemporaneous raw exchange price: Yahoo adjclose is
  // back-adjusted for later distributions, so multiplying it by historical
  // shares would corrupt market cap and leak future distributions into level
  // features even though return ratios themselves remain valid.
  const rawCloses = window.map((bar) => bar.rawClose ?? bar.close)
  const highs = window.map((bar) => bar.high)
  const lows = window.map((bar) => bar.low)
  const volumes = window.map((bar) => bar.volume)
  if (closes.length < 252) return null
  const lastClose = closes[closes.length - 1]
  const rawLastClose = rawCloses[rawCloses.length - 1]
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
  const dollarVolumes = volumes
    .slice(-20)
    .map((volume, index) => volume * rawCloses[rawCloses.length - 20 + index])
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

  // Tail/lottery candidates (see HISTORICAL_FEATURE_NAMES for citations).
  // MAX: largest single-day simple return (%) over the last 21 sessions.
  let maxDailyRet21 = 0
  for (let i = closes.length - 21; i < closes.length; i++) {
    const prev = closes[i - 1]
    if (prev > 0) {
      const r = (closes[i] / prev - 1) * 100
      if (r > maxDailyRet21) maxDailyRet21 = r
    }
  }
  // Downside vol: annualized semi-deviation of negative log-return days.
  const downLogs60 = log60.filter((value) => value < 0)
  const downsideVol60 =
    downLogs60.length > 0
      ? Math.sqrt(
          downLogs60.reduce((sum, value) => sum + value * value, 0) / downLogs60.length,
        ) * Math.sqrt(252)
      : 0
  // Vol-of-vol: std of nine overlapping 20d vols stepped 5d apart (~60d span).
  const volWindows: number[] = []
  for (let offset = 0; offset <= 40; offset += 5) {
    const segment = log252.slice(log252.length - 20 - offset, log252.length - offset || undefined)
    if (segment.length === 20) volWindows.push(stdOf(segment) * Math.sqrt(252))
  }
  const volOfVol60 = volWindows.length >= 3 ? stdOf(volWindows) : 0

  // Trailing 12-month cash-distribution yield, read straight off the two
  // adjustment factors the price adapter already stores on every bar. A bar's
  // factor is its total-return close divided by its raw exchange close, so it
  // carries every distribution paid AFTER that bar. Dividing the recent bar's
  // factor by the year-old bar's factor cancels everything that happened after
  // the recent bar and leaves only what was paid in between. That cancellation
  // is what makes this causal even though the factors themselves are
  // back-adjusted from today: a dividend paid next month multiplies both
  // factors by the same number and drops straight out of the ratio.
  //
  // The cancellation of SPLITS rests on one assumption about the provider,
  // namely that Yahoo's raw close series is already split-adjusted. It is, in
  // the chart interface this pipeline uses, but that is a fact about somebody
  // else's data rather than a guarantee. If it ever stopped being true, a
  // ten-for-one split would read as a nine-hundred-percent distribution, so
  // the value is clamped to a plausible zero-to-twenty-percent band below and
  // the clamp bounds the damage rather than hiding it.
  const adjustmentFactorBarsBack = (barsBack: number): number | null => {
    const bar = window[window.length - 1 - barsBack]
    const factor = bar?.adjustmentFactor
    return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : null
  }
  const factorNow = adjustmentFactorBarsBack(0)
  const factorOneYearAgo = adjustmentFactorBarsBack(252)
  const payoutYield252 =
    factorNow != null && factorOneYearAgo != null
      ? (factorNow / factorOneYearAgo - 1) * 100
      : null

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
    // Tail/lottery (3)
    maxDailyRet21,
    downsideVol60,
    volOfVol60,
    // Survivorship-visibility (2)
    listingAgeYears(
      options?.firstBarDateMs ?? Date.parse(bars[0].date),
      bars[dateIndex].date,
      options?.fetchWindowStartMs,
    ),
    Math.log(Math.max(0.01, rawLastClose)),
    // Fundamentals (13) — point-in-time as of this bar's date
    ...fundamentalFeaturesAt(fundamentals ?? null, bars[dateIndex].date, rawLastClose, {
      vol252Annualized: vol252,
      return252Pct: ret(252),
    }),
    // Company-type descriptors (3) — every one of them reads only the price
    // and filing record that existed at this bar's date, and every one of
    // them can be computed for a single name on its own, which is what the
    // live scoring path has to work with.
    clampTo(payoutYield252, 0, 20),
    ...filingDescriptorsAt(fundamentals ?? null, bars[dateIndex].date),
  ]
}

/**
 * Twelve-month momentum measured the way the momentum literature measures
 * it: the return from twelve months ago to ONE month ago, skipping the most
 * recent month. Jegadeesh and Titman (1993, "Returns to Buying Winners and
 * Selling Losers", Journal of Finance 48(1)) form their portfolios on the
 * past J-month return and leave a month between formation and holding; the
 * skip is standard because the latest month carries short-term reversal
 * (Jegadeesh 1990, Journal of Finance 45(3)). The feature column
 * momentum_252d is the 12-0 form, close today over close 252 bars ago, which
 * INCLUDES that reversal month.
 *
 * Same windowing as computeFeaturesAtDate: only bars strictly before
 * `dateIndex` are read, and 21 bars stands for one month. Returns null when
 * fewer than 252 bars precede the date, the rule the features use. When the
 * bar 252 back is missing or non-positive the value is 0, mirroring the
 * feature's own ret() convention so the two definitions share every quirk.
 */
export function computeMomentum12to1AtDate(bars: DailyBar[], dateIndex: number): number | null {
  if (dateIndex < 252) return null
  const window = bars.slice(0, dateIndex)
  const start = window[window.length - 1 - 252]?.close
  const oneMonthBack = window[window.length - 1 - 21]?.close
  if (!start || start <= 0 || !oneMonthBack || oneMonthBack <= 0) return 0
  return (oneMonthBack / start - 1) * 100
}

/** Years of history a 'max' fetch asks for. Mirrors RANGE_YEARS.max in
 * marketData.ts, which is not exported; the two must move together. */
const MAX_FETCH_RANGE_YEARS = 40

/**
 * Trailing 20-day average dollar volume before `dateIndex`: the mean of
 * volume times raw exchange close over bars[dateIndex - 20 .. dateIndex - 1],
 * exactly the twenty bars and the price basis the Amihud illiquidity feature
 * reads inside computeFeaturesAtDate. It is a size stand-in for the cost
 * model (see costTierMarketCapUsd), not a feature, so it lives beside the
 * vector rather than in it. Zero when no bar in the span traded.
 */
function averageDollarVolume20d(bars: DailyBar[], dateIndex: number): number {
  const start = Math.max(0, dateIndex - 20)
  let sum = 0
  let count = 0
  for (let i = start; i < dateIndex; i++) {
    const bar = bars[i]
    const price = bar.rawClose ?? bar.close
    const dollars = bar.volume * price
    if (Number.isFinite(dollars) && dollars > 0) {
      sum += dollars
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

/**
 * How far past the fetch boundary a first bar may sit and still count as
 * sitting ON it. The boundary is a clock time, not a trading day, so the
 * first bar of a name older than the fetch window lands on the first
 * session at or after it, up to a weekend plus a holiday later; and the
 * boundary is recomputed from the clock when the dataset is built, a little
 * after the bars were fetched. A week covers both. A name that genuinely
 * listed inside that week is treated as unknown too, which is disclosed
 * here and is the price of not knowing the fetch's exact timestamp.
 */
const FETCH_BOUNDARY_TOLERANCE_MS = 7 * 86_400_000

/**
 * Years since the first bar, capped at 25, or NaN when the first bar sits
 * on the fetch boundary.
 *
 * The NaN branch fires ONLY at the fetch boundary: when the caller passes
 * `fetchWindowStartMs` and the first bar is at or within a week after it.
 * On a 40-year fetch every name listed before the boundary starts its
 * history on the boundary's first session, so all of them would otherwise
 * read as listed on the same day and then, once past 25, as the same capped
 * age. The doc's pre-registered default (docs/EVIDENCE_QUALITY.md, "Listing-
 * age treatment on a 40-year fetch") is to call that age unknown instead.
 * NaN is the missing sentinel the rest of the pipeline already understands:
 * imputeMissingWithDateMedians replaces it with the date's median from
 * names whose age IS known and records the cell in imputedMask, and the
 * survivorship cohort never calls an imputed age "young". The feature name
 * and its slot in the vector are unchanged. Without `fetchWindowStartMs`
 * (the live scoring path) the first bar is taken at face value.
 */
function listingAgeYears(
  firstBarDateMs: number,
  isoDate: string,
  fetchWindowStartMs?: number,
): number {
  const dateMs = Date.parse(isoDate)
  if (
    fetchWindowStartMs != null &&
    Number.isFinite(fetchWindowStartMs) &&
    Number.isFinite(firstBarDateMs) &&
    firstBarDateMs <= fetchWindowStartMs + FETCH_BOUNDARY_TOLERANCE_MS
  ) {
    return Number.NaN
  }
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
  /** Capital spending as a percentage of revenue across the latest annual
   * periods on file at this filing date (up to three years). Deliberately a
   * multi-year figure so it describes the business model rather than one
   * year's spending decision. Null when fewer than two years line up. */
  capexToRevenue3y: number | null
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

  /** How many separate filings landed in the `years` before `dateMs`,
   * expressed per year. Only filings dated STRICTLY BEFORE the sample date
   * count, the same one-day lag the snapshot lookup above uses, so this can
   * never see a statement the market had not yet read. A US company that
   * reports quarterly lands near four, a foreign private issuer near one or
   * two, and anything that files nothing at all reads zero. */
  filingsPerYearBefore(dateMs: number, years = 3): number {
    if (!Number.isFinite(dateMs) || years <= 0) return 0
    const windowStart = dateMs - years * 365.25 * 86_400_000
    let count = 0
    for (const snapshot of this.snapshots) {
      if (snapshot.filed >= dateMs) break  // snapshots are sorted by filed date
      if (snapshot.filed >= windowStart) count++
    }
    return count / years
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

      // Capital intensity over the latest annual periods visible at this
      // filing date. Capex years are matched to revenue years by period end
      // rather than just taking the last three of each, because a company
      // that tags capex in some years and not others would otherwise divide
      // three years of spending by two years of sales. At least two matched
      // years are required, so one odd reporting year cannot define the
      // company's type on its own.
      let capexToRevenue3y: number | null = null
      {
        const annualRevenue = rev.filter((row) => row.span === 'annual').slice(-3)
        const annualCapex = cap.filter((row) => row.span === 'annual')
        let capexSum = 0
        let revenueSum = 0
        let matchedYears = 0
        for (const revenueRow of annualRevenue) {
          if (!(revenueRow.value > 0)) continue
          const capexRow = annualCapex.find(
            (row) => Math.abs(row.end - revenueRow.end) <= 5 * 86_400_000,
          )
          if (!capexRow) continue
          capexSum += Math.abs(capexRow.value)
          revenueSum += revenueRow.value
          matchedYears++
        }
        if (matchedYears >= 2 && revenueSum > 0) {
          capexToRevenue3y = (capexSum / revenueSum) * 100
        }
      }

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
        capexToRevenue3y,
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

/**
 * The two company-type descriptors that come out of the SEC filing record:
 * how often the name files, and how capital-hungry its business is.
 *
 * Both read only filings whose FILED date is strictly before the sample date,
 * so they carry exactly the same point-in-time guarantee as the thirteen
 * fundamental features above, and a filing that lands tomorrow can never
 * change what this returns today.
 *
 * The counting descriptor returns a real zero rather than "missing" for a fund
 * or any other non-filer. That is not a silent zero standing in for absent
 * data: "this thing files no financial statements" is an observed fact about
 * what kind of thing it is, and it is the fact the model needs. The measured
 * descriptor returns NaN when it genuinely cannot be computed, and NaN flows
 * into the same causal per-date median imputation every other feature uses, so
 * a gap is recorded on the sample's imputed mask instead of masquerading as a
 * real reading.
 */
function filingDescriptorsAt(
  fundamentals: FundamentalsTimeline | null,
  isoDate: string,
): number[] {
  const dateMs = Date.parse(isoDate)
  if (!Number.isFinite(dateMs)) {
    return [Number.NaN, Number.NaN]
  }
  const snapshot = fundamentals ? fundamentals.at(dateMs) : null
  const filingsPerYear = fundamentals ? fundamentals.filingsPerYearBefore(dateMs, 3) : 0
  const capitalIntensity = clampTo(snapshot?.capexToRevenue3y ?? null, 0, 200)
  return [filingsPerYear, capitalIntensity]
}

/** In-module cache: successful timelines persist; transient failures are
 * evicted so backend/SEC recovery heals the live feature path. */
const fundamentalsCache = new Map<string, Promise<FundamentalsTimeline | null>>()

/**
 * How long the client waits for /fundamentals/history. The backend gives a
 * cold SEC companyfacts download 20 seconds (tool/backend_cache_server.dart,
 * the `/api/xbrl/companyfacts/` policy at line 1232) on top of an 8-second
 * connection timeout (line 136). This client used to give up after 8 seconds
 * (the old literal on the setTimeout line below), so on a cold backend the
 * request was abandoned while the backend was still working, and the row was
 * built with no fundamentals as though the company filed none. Thirty
 * seconds covers the backend's whole budget with room to spare.
 */
export const FUNDAMENTALS_FETCH_TIMEOUT_MS = 30_000

/** How the latest /fundamentals/history request for a name ended. "failed"
 * is a request that timed out, could not connect, or got a server error; it
 * is a lost fetch, not a fact about the company, and the pre-registered
 * runner treats it like a lost price fetch. "not-a-filer" is the backend's
 * own answer that there are no SEC filings for the name (a fund or a foreign
 * filer); the backend gives that same answer when its own SEC download
 * failed, which this client cannot tell apart. */
export type FundamentalsFetchOutcome =
  | { kind: 'timeline' }
  | { kind: 'not-a-filer'; detail: string }
  | { kind: 'failed'; detail: string }

const fundamentalsFetchOutcomes = new Map<string, FundamentalsFetchOutcome>()

/** The outcome of the latest fundamentals request for a name, or null when
 * none was made in this process. */
export function fundamentalsFetchOutcome(ticker: string): FundamentalsFetchOutcome | null {
  return fundamentalsFetchOutcomes.get(ticker) ?? null
}

/** Names whose latest fundamentals request failed (timed out or errored), sorted. */
export function fundamentalsFetchFailures(): string[] {
  return [...fundamentalsFetchOutcomes.entries()]
    .filter(([, outcome]) => outcome.kind === 'failed')
    .map(([ticker]) => ticker)
    .sort()
}

export function fetchFundamentalsTimeline(ticker: string): Promise<FundamentalsTimeline | null> {
  const cached = fundamentalsCache.get(ticker)
  if (cached) return cached
  const promise = (async () => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), FUNDAMENTALS_FETCH_TIMEOUT_MS)
    try {
      const base = import.meta.env.VITE_ORACLE_BACKEND_URL ?? 'http://127.0.0.1:8787'
      const response = await fetch(
        `${base}/fundamentals/history?symbol=${encodeURIComponent(ticker)}`,
        { headers: { Accept: 'application/json' }, signal: controller.signal },
      )
      if (!response.ok) {
        // 404 is the backend saying "no SEC filings for this name"; anything
        // else (a 500, a 502 from a proxy) is a request that did not work.
        if (response.status === 404) {
          fundamentalsFetchOutcomes.set(ticker, { kind: 'not-a-filer', detail: 'backend answered 404: no SEC companyfacts' })
        } else {
          fundamentalsFetchOutcomes.set(ticker, { kind: 'failed', detail: `backend answered HTTP ${response.status}` })
        }
        return null
      }
      const payload = (await response.json()) as Parameters<typeof FundamentalsTimeline.fromHistory>[0]
      const timeline = FundamentalsTimeline.fromHistory(payload)
      if (timeline.size > 0) {
        fundamentalsFetchOutcomes.set(ticker, { kind: 'timeline' })
        return timeline
      }
      fundamentalsFetchOutcomes.set(ticker, { kind: 'not-a-filer', detail: 'backend answered with an empty filing history' })
      return null
    } catch (error) {
      const detail = controller.signal.aborted
        ? `timed out after ${FUNDAMENTALS_FETCH_TIMEOUT_MS} ms`
        : (error as Error)?.message ?? 'request failed'
      fundamentalsFetchOutcomes.set(ticker, { kind: 'failed', detail })
      return null
    } finally {
      window.clearTimeout(timer)
    }
  })()
  fundamentalsCache.set(ticker, promise)
  void promise.then((timeline) => {
    if (timeline == null && fundamentalsCache.get(ticker) === promise) {
      fundamentalsCache.delete(ticker)
    }
  })
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

export type BacktestDatasetProvenance = {
  schemaVersion: 2
  builtAt: string
  featurePipelineVersion: typeof HISTORICAL_FEATURE_PIPELINE_VERSION
  priceSource: 'Yahoo Finance chart via local cache proxy'
  fundamentalsSource: 'SEC EDGAR XBRL companyfacts via local backend'
  /** Exact caller-supplied symbols. This is intentionally retained: a model
   * artifact without its training universe cannot be reproduced or audited. */
  universeTickers: string[]
  universeConstruction:
    | 'caller-supplied current-symbol list'
    | 'point-in-time security master with delistings'
  universeEvidence:
    | {
        kind: 'current-symbol-list'
        membershipSource: string
        constituentEffectiveDateField: null
        delistedSecuritySource: null
        delistingReturnSource: null
      }
    | {
        kind: 'point-in-time-with-delistings'
        membershipSource: string
        constituentEffectiveDateField: string
        delistedSecuritySource: string
        delistingReturnSource: string
      }
  /** Registered names whose history was fetched under a successor symbol
   * (TICKER_RENAMES). The sample keeps the original symbol as its identity.
   * Optional only so that older artifacts still validate; every dataset this
   * module builds fills it in, empty when nothing was renamed. */
  universeRenames?: Array<{ original: string; fetchedAs: string; effectiveDate: string; note: string }>
  /** Registered names taken out before any fetch because no free source
   * serves their history (EXCLUDED_UNFETCHABLE). They stay in
   * universeTickers, which is the list as registered; this is the ledger of
   * why they are not in the samples. */
  universeExcluded?: Array<ExcludedUnfetchable & { status: 'registered but excluded' }>
  /** The excluded names as a share of the registered names, worded as the
   * survivorship diagnostics print it. */
  universeAttrition?: UniverseAttrition
  /** Where the company-type descriptors came from, recorded so an auditor
   * never has to take it on trust. Optional only so that model artifacts
   * written before these columns existed still validate; every dataset this
   * module builds fills it in. */
  companyDescriptors?: {
    basis: 'derived-point-in-time-from-price-and-filing-history'
    /** Present-day sector and industry labels are deliberately unused. The
     * only labels this repository holds for the backtest universe are 2026
     * hand-curated judgements about companies whose returns are already known,
     * and the SEC's numeric industry code is not stored here at all. */
    presentDaySectorLabelsUsed: false
    limitation: string
  }
  requestedRange: '1y' | '2y' | '5y' | '10y' | '15y' | 'max'
  fetchedRange: 'max'
  cadenceTradingDays: number
  minimumBarsPerTicker: number
  featureNames: string[]
  labelHorizonsTradingDays: HorizonKey[]
  sampleCount: number
  sampleDateRange: { start: string | null; end: string | null }
}

/** Reproducible xorshift32 stream seeded from the measured series. Bootstrap
 * CIs and permutation importance are evidence artifacts, so identical data
 * must produce identical promotion decisions across runs. */
function deterministicRandom(values: readonly number[], salt = 0): () => number {
  let state = (0x811c9dc5 ^ salt) >>> 0
  for (const value of values) {
    const token = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0x7fc00000
    state = Math.imul(state ^ token, 0x01000193) >>> 0
  }
  if (state === 0) state = 0x6d2b79f5
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

export type BacktestDatasetQuality = {
  schemaVersion: 1
  universe: {
    pointInTimeMembership: boolean
    includesDelistedSecurities: boolean
    includesDelistingReturns: boolean
    survivorshipBiasControlled: boolean
    intendedMemberCount: number
    membersWithUsablePriceHistory: number
    membersWithExplicitNoHistoryOutcome: number
    memberOutcomeCoverage: number
    limitation: string
  }
  returns: {
    /** computeFeaturesAtDate and every forward label currently read DailyBar.close. */
    labelPriceField: string
    labelAdjustment: 'unadjusted-close' | 'adjusted-close' | 'total-return' | 'mixed' | 'unknown'
    barsObserved: number
    /** Source completeness is tracked before local filtering so a missing
     * OHLCV row cannot disappear and make analytical coverage look perfect. */
    sourceRowsObserved: number
    sourceInvalidRawBars: number
    sourceRowAcceptanceCoverage: number
    sourceEligibleRawBars: number
    sourceMissingAdjustedBars: number
    sourceAdjustmentCoverage: number
    /** Coverage of accepted bars whose `close` is proven to be on the
     * adjusted-total-return basis used by features and labels. */
    barsWithAdjustedCloseAvailable: number
    adjustedCloseAvailabilityCoverage: number
    adjustedReturnLabelCoverage: number
    totalReturnLabelCoverage: number
    dividendsIncludedInLabels: boolean
    limitation: string
  }
  fundamentals: {
    source: 'SEC EDGAR XBRL companyfacts'
    alignedByFiledDate: boolean
    tickersWithTimeline: number
    usableTickers: number
    tickerTimelineCoverage: number
    samplesWithPointInTimeSnapshot: number
    totalSamples: number
    sampleSnapshotCoverage: number
    observedFeatureCells: number
    totalFeatureCells: number
    observedFeatureCellCoverage: number
    limitation: string
  }
  evaluation: {
    purgedWalkForwardSupported: boolean
    embargoSupported: boolean
    /** False until imputation/global fallback statistics are fit within each
     * training fold rather than once across the complete dataset. */
    foldLocalPreprocessing: boolean
    lockedPostSelectionHoldout: boolean
    limitation: string
  }
}

export type DatasetBuildResult = {
  samples: HistoricalSample[]
  /** Every trading day seen in any usable name's bars, sorted. This is the
   * calendar the walk-forward windows are cut on (see buildCalendarWindows):
   * samples are formed only every tenth bar, so the sample dates alone are
   * one trading day in ten and cannot define a 20-trading-day window. */
  tradingDates: string[]
  provenance: BacktestDatasetProvenance
  quality: BacktestDatasetQuality
  diagnostics: {
    tickersAttempted: number
    tickersWithUsableBars: number
    tickersWithZeroBars: number
    tickersBelowMinBars: number
    /** Names whose samples carry real point-in-time EDGAR fundamentals. */
    tickersWithFundamentals?: number
    /** Names whose first bar sits on the fetch boundary, so their listing
     * age is unknown (NaN, then imputed and flagged) rather than measured
     * from a cut-off history. See listingAgeYears. */
    tickersAtFetchBoundary?: number
    /** Names fetched under a successor symbol (see TICKER_RENAMES). */
    tickersRenamed?: number
    /** Registered names set aside before any fetch (see EXCLUDED_UNFETCHABLE).
     * They are not counted in tickersAttempted and never appear in
     * perTickerSummary, because nothing was attempted for them. */
    excludedBeforeFetch?: Array<{ ticker: string; delistingDate: string | null; reason: string }>
    perTickerSummary: Array<{
      ticker: string
      /** Present when the history was fetched under a successor symbol. */
      fetchedAs?: string
      bars: number
      samplesGenerated: number
      reason?: string
    }>
  }
}

/* =========================================================================
   Peer-relative company-type features — REMOVED 2026-09-10, and this note is
   here so nobody deletes it and builds the same thing again badly.

   WHAT USED TO BE HERE. Six extra columns, each one an existing feature minus
   the median of that same feature among companies of the same kind on the same
   date: volatility, momentum, illiquidity, leverage, net margin and earnings
   yield. The idea behind them is right, and it is worth keeping. Asking "is
   this company unusual for its type" is a better question than "is this
   company unusual", a bank and a software firm are not the same kind of thing
   at the same leverage reading, and centring on a same-date median is one of
   the few ways to encode company type that cannot leak the future, because
   nothing is fitted on one date and carried into another.

   WHY THEY WERE PULLED. Two things had to be true for them to work, and
   neither was.

   First, we could not tell one kind of company from another. The grouping key
   was whether a name files with the SEC plus which third of that date's
   capital-spending range it fell into. That puts a bank, a software firm and a
   biotech in the same bucket whenever they happen to spend alike, so the six
   columns were not measuring "unusual for its type" at all. Getting this right
   needs a real point-in-time classification of what the company actually does.
   The honest one is the SEC's own numeric industry code, which this repository
   already fetches per company while building the universe and then throws
   away: the generator caches the number, folds it into a coarse sector string,
   and keeps only the string. Carrying the number through to the fundamentals
   record is the work. Note the trap that made us reach for a substitute in the
   first place: the sector labels stored here are present-day hand judgements
   about companies whose returns are already known, so stamping them onto a
   2013 sample tells the model how the story ended. Those must never be used,
   no matter how convenient.

   Second, we could not serve them. These were the only features in this file
   that need a whole cross-section of companies on one date to compute. The
   live app scores one name at a time and has no cross-section, so a served
   model would have found these columns simply unavailable and filled them with
   a neutral stand-in — a different quantity from the one it was trained on,
   which is the train-versus-serve gap this project has already paid for once.
   Closing it means either widening the scoring path to score the warm universe
   together, or freezing a per-group median table into the saved model bundle
   next to the feature means and standard deviations it already stores.

   WHEN TO BRING THEM BACK. When the point-in-time industry code is stored
   alongside the fundamentals, and when the scoring path can produce whatever
   the grouping needs for a single name. Until both hold, adding these columns
   trains a model on numbers the live app cannot reproduce.
   ========================================================================= */

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
export function imputeMissingWithDateMedians(samples: HistoricalSample[]): void {
  if (samples.length === 0) return
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  const featureCount = samples[0].rawFeatures.length
  // CAUSAL fallback medians (fixes a promotion BLOCK): the fallback for a
  // date whose whole cross-section is missing a feature used to be the
  // median over ALL dates — a 2012 gap could be filled with a value that
  // includes 2026 observations, leaking future information into training
  // features. The pool below only ever contains observations from dates
  // AT OR BEFORE the date being imputed (same-date data is knowable at
  // that date's close — identical footing to the per-date median branch).
  const observedSoFar: number[][] = Array.from({ length: featureCount }, () => [])
  const causalFallbackMedian = (f: number): number => {
    const pool = observedSoFar[f]
    if (pool.length === 0) return 0
    const sorted = [...pool].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const orderedDates = [...byDate.keys()].sort()
  for (const date of orderedDates) {
    const indices = byDate.get(date)!
    // Admit this date's observations into the pool FIRST, mirroring how
    // the per-date branch uses same-date values.
    for (let f = 0; f < featureCount; f++) {
      for (const idx of indices) {
        const value = samples[idx].rawFeatures[f]
        if (!Number.isNaN(value)) observedSoFar[f].push(value)
      }
    }
    for (let f = 0; f < featureCount; f++) {
      const present: number[] = []
      for (const idx of indices) {
        const value = samples[idx].rawFeatures[f]
        if (!Number.isNaN(value)) present.push(value)
      }
      if (present.length === indices.length) continue  // nothing missing
      present.sort((a, b) => a - b)
      const median =
        present.length > 0
          ? present[Math.floor(present.length / 2)]
          : causalFallbackMedian(f)
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
/** Column of the 12-0 momentum feature in the FULL feature list. Callers
 * that prune features must pass their own index (see walkForwardStep). */
const MOMENTUM_252D_FEATURE_INDEX = HISTORICAL_FEATURE_NAMES.indexOf('momentum_252d')

/**
 * Tag each sample's survivorship cohort AT ITS FORMATION DATE:
 * 'survivorPrivileged' = listed under 3 years (Fama-French 2004: new-list
 * failure risk is front-loaded) OR in the bottom size quintile of that
 * date's cross-section (Hou-Xue-Zhang 2020: microcaps drive most anomaly
 * returns and are exactly what a survivors-only sample misrepresents).
 * Runs AFTER imputation. New datasets use the explicit
 * pitFundamentalsObserved bit; the filing-age sentinel remains only as a
 * backward-compatible fallback for older/synthetic samples. The explicit bit
 * matters because a real but stale filing can reach the same capped age as the
 * no-data sentinel. ETFs/non-filers sit outside the cohort diagnostics.
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
      const hasFundamentals =
        sample.pitFundamentalsObserved ??
        sample.rawFeatures[ageIdx] < FUNDAMENTAL_MISSING_AGE_DAYS
      const capImputed = sample.imputedMask?.[LOG_MKTCAP_FEATURE_INDEX] === true
      if (hasFundamentals && !capImputed) {
        caps.push(sample.rawFeatures[LOG_MKTCAP_FEATURE_INDEX])
      }
    }
    caps.sort((a, b) => a - b)
    const quintileCut = caps.length >= 10 ? caps[Math.floor(caps.length * 0.2)] : -Infinity
    for (const idx of indices) {
      const sample = samples[idx]
      const hasFundamentals =
        sample.pitFundamentalsObserved ??
        sample.rawFeatures[ageIdx] < FUNDAMENTAL_MISSING_AGE_DAYS
      if (!hasFundamentals) {
        sample.cohort = 'noFundamentals'
        continue
      }
      // An imputed listing age (a name whose history was cut at the fetch
      // boundary, see listingAgeYears) is unknown, not young: the median it
      // was filled with says nothing about this name.
      const ageImputed = sample.imputedMask?.[LISTING_AGE_FEATURE_INDEX] === true
      const young = !ageImputed && sample.rawFeatures[LISTING_AGE_FEATURE_INDEX] < 3
      const capImputed = sample.imputedMask?.[LOG_MKTCAP_FEATURE_INDEX] === true
      const smallThen =
        !capImputed && sample.rawFeatures[LOG_MKTCAP_FEATURE_INDEX] <= quintileCut
      sample.youngAtFormation = young
      sample.cohort = young || smallThen ? 'survivorPrivileged' : 'core'
    }
  }
}

/**
 * Demean each forward-return target by its date's cross-sectional mean,
 * so the model's TARGET is RELATIVE (idiosyncratic) return, not raw.
 *
 * A cross-sectional ranking model can only predict how a stock does
 * RELATIVE to its peers that day — the common market/cross-section move
 * (everyone +5% one day, −3% the next) is unpredictable from per-name
 * features and, left in the target, just inflates the loss with noise the
 * model can't fit. Subtracting the per-date mean focuses the model on
 * relative alpha. The RAW forward returns are kept untouched: the L/S
 * portfolio earns those (the tradeable spread), and only the training
 * target + IC use the relative version. Dates below a small breadth floor
 * keep raw (a 1–2 name "cross-section" has no meaningful mean).
 */
function applyCrossSectionalReturnDemeaning(samples: HistoricalSample[]): void {
  if (samples.length === 0) return
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  const MIN_BREADTH = 5
  const pairs = [
    ['forwardReturn5d', 'forwardReturn5dRel'],
    ['forwardReturn20d', 'forwardReturn20dRel'],
    ['forwardReturn60d', 'forwardReturn60dRel'],
    ['forwardReturn120d', 'forwardReturn120dRel'],
  ] as const
  for (const indices of byDate.values()) {
    if (indices.length < MIN_BREADTH) continue // too thin to demean meaningfully
    for (const [rawKey, relKey] of pairs) {
      let sum = 0
      for (const idx of indices) sum += samples[idx][rawKey]
      const meanReturn = sum / indices.length
      for (const idx of indices) samples[idx][relKey] = samples[idx][rawKey] - meanReturn
    }
  }
}

/**
 * Apply cross-sectional Z-score normalization to features WITHIN each
 * as-of date. After this, every feature has mean 0 and stddev 1 across
 * stocks at any given date — the model learns relative ranking rather
 * than absolute level.
 */
export function applyCrossSectionalNormalization(samples: HistoricalSample[]): void {
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

  // CAUSAL sparse-date fallback (fixes a promotion BLOCK): sparse dates
  // (< MIN_GROUP_FOR_ZSCORE names) used to be Z-scored against a mean/std
  // pooled over ALL dates — a thin 2011 date was normalized with statistics
  // containing 2026 data. The running accumulators below only ever hold
  // observations from dates at or before the one being normalized, so no
  // preprocessing statistic can see the future. Dense dates are untouched:
  // their per-date Z uses same-date data only, which was always causal.
  // Runs AFTER imputation, so every rawFeature is finite here.
  const runningSum = new Array<number>(featureCount).fill(0)
  const runningSumSq = new Array<number>(featureCount).fill(0)
  let runningCount = 0

  const orderedDates = [...byDate.keys()].sort()
  for (const date of orderedDates) {
    const indices = byDate.get(date)!
    // Admit this date's values first — a sparse date's own names belong in
    // its cross-section, the same footing the dense branch gives them.
    for (const idx of indices) {
      for (let f = 0; f < featureCount; f++) {
        const value = samples[idx].rawFeatures[f]
        runningSum[f] += value
        runningSumSq[f] += value * value
      }
    }
    runningCount += indices.length

    if (indices.length < MIN_GROUP_FOR_ZSCORE) {
      // Sparse date — expanding-window Z so we don't lose the sample's
      // information without borrowing statistics from the future. The
      // earliest sparse dates normalize against thin pools; that costs
      // estimate quality, never causality.
      indices.forEach((idx) => {
        for (let f = 0; f < featureCount; f++) {
          const mean = runningSum[f] / runningCount
          const variance = Math.max(0, runningSumSq[f] / runningCount - mean * mean)
          const sigma = Math.sqrt(Math.max(1e-12, variance))
          samples[idx].features[f] = (samples[idx].rawFeatures[f] - mean) / sigma
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

/**
 * Z-score the 12-1 momentum yardstick within each formation date by the
 * same rule applyCrossSectionalNormalization applies to every feature
 * column: a dense date (five or more names) uses its own cross-section, a
 * sparse date uses the expanding pool of dates at or before it, so no
 * statistic can see the future. The 12-0 baseline the gate read until now
 * is the Z-scored momentum_252d column, so the two definitions get the
 * identical treatment and their ICs can be read side by side. Rows that
 * carry no raw value (built before the field existed) are left without one.
 */
export function normalizeMomentum12to1ByDate(samples: HistoricalSample[]): void {
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    if (!Number.isFinite(sample.momentum12to1Raw)) return
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  const MIN_GROUP_FOR_ZSCORE = 5
  let runningSum = 0
  let runningSumSq = 0
  let runningCount = 0
  for (const date of [...byDate.keys()].sort()) {
    const indices = byDate.get(date)!
    const values = indices.map((idx) => samples[idx].momentum12to1Raw as number)
    for (const value of values) {
      runningSum += value
      runningSumSq += value * value
    }
    runningCount += values.length
    let mean: number
    let variance: number
    if (values.length < MIN_GROUP_FOR_ZSCORE) {
      mean = runningSum / runningCount
      variance = Math.max(0, runningSumSq / runningCount - mean * mean)
    } else {
      mean = values.reduce((sum, value) => sum + value, 0) / values.length
      variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    }
    const sigma = Math.sqrt(Math.max(1e-12, variance))
    indices.forEach((idx, position) => {
      samples[idx].momentum12to1 = (values[position] - mean) / sigma
    })
  }
}

/** The canonical Yahoo adapter marks `close` as adjusted-total-return. Keep the
 * conventional adjusted-close aliases as a compatibility inventory for custom
 * importers, but only the canonical marker proves that `close` itself is on the
 * adjusted basis consumed by features and labels. */
function hasTotalReturnPriceBasis(bar: DailyBar): boolean {
  if (bar.priceBasis === 'adjusted-total-return') return true
  const candidate = bar as DailyBar & {
    adjustedClose?: unknown
    adjClose?: unknown
    adjclose?: unknown
  }
  const value = candidate.adjustedClose ?? candidate.adjClose ?? candidate.adjclose
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value - bar.close) <= Math.max(1e-8, Math.abs(value) * 1e-10)
  )
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
  const normalizedTickers = tickers.map((ticker) => ticker.trim().toUpperCase())
  if (normalizedTickers.some((ticker) => ticker.length === 0)) {
    throw new Error('Historical dataset universe contains an empty ticker.')
  }
  if (new Set(normalizedTickers).size !== normalizedTickers.length) {
    throw new Error('Historical dataset universe contains duplicate tickers after normalization.')
  }
  if (new Set(normalizedTickers.map(normalizeYahooSymbol)).size !== normalizedTickers.length) {
    throw new Error('Historical dataset universe contains duplicate Yahoo provider aliases.')
  }
  tickers = normalizedTickers
  // The registered list is kept as given for the artifact. Names that left
  // the market are set aside here, before anything is fetched, and renamed
  // names are fetched under their successor while keeping their own symbol
  // as the sample's identity (see the ledgers next to DEFAULT_BACKTEST_TICKERS).
  const plan = planUniverseFetch(tickers)
  const fetchPlan = plan.fetch
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
  // The 'max' fetch reaches back MAX_FETCH_RANGE_YEARS from today (the
  // period1 that marketData.fetchDailyBars sends). A name whose first bar
  // sits on that boundary has a cut-off history, not a listing date, so its
  // listing age is unknown; computeFeaturesAtDate turns that into the
  // missing sentinel (see listingAgeYears). Only this boundary case fires.
  const fetchWindowStartMs = Date.now() - MAX_FETCH_RANGE_YEARS * 365.25 * 86_400_000
  let tickersAtFetchBoundary = 0
  const samples: HistoricalSample[] = []
  const perTickerSummary: DatasetBuildResult['diagnostics']['perTickerSummary'] = []
  // Union of the bar dates of every usable name: the trading calendar the
  // walk-forward windows are cut on.
  const tradingDateSet = new Set<string>()
  let tickersWithUsableBars = 0
  let tickersWithZeroBars = 0
  let tickersBelowMinBars = 0
  let tickersWithFundamentals = 0
  let barsObserved = 0
  let barsWithAdjustedCloseAvailable = 0
  let sourceRowsObserved = 0
  let sourceInvalidRawBars = 0
  let sourceEligibleRawBars = 0
  let sourceMissingAdjustedBars = 0
  let samplesWithPointInTimeSnapshot = 0
  let observedFundamentalFeatureCells = 0
  const filingAgeIndex = HISTORICAL_FEATURE_NAMES.indexOf('fund_filing_age')
  // Located by name rather than by counting back from the end of the list.
  // The company-type descriptors are appended after the fundamentals block, so
  // "the last thirteen columns" stopped being the fundamentals; the coverage
  // count below must stay pinned to the thirteen real fundamental columns or
  // it would start crediting descriptor cells as observed fundamentals.
  const fundamentalStartIndex = HISTORICAL_FEATURE_NAMES.indexOf('fund_revenue_growth_yoy')
  const fundamentalEndIndex = fundamentalStartIndex + FUNDAMENTAL_FEATURE_COUNT

  for (let t = 0; t < fetchPlan.length; t++) {
    const { ticker, fetchedAs } = fetchPlan[t]
    // Every row in the per-name summary names the sample identity, and says
    // which symbol the request went out under when that differs.
    const summaryBase = fetchedAs !== ticker ? { ticker, fetchedAs } : { ticker }
    options.onProgress?.(t, fetchPlan.length, ticker)
    let bars: DailyBar[]
    let adjustmentSummary: DailyBarAdjustmentSummary | undefined
    try {
      const fetched = await cachedFetchDailyBars(fetchedAs, fetchRange)
      bars = fetched
      adjustmentSummary = fetched.adjustment
    } catch {
      bars = []
    }
    sourceRowsObserved += adjustmentSummary?.sourceRows ?? bars.length
    sourceInvalidRawBars += adjustmentSummary?.invalidRawBars ?? 0
    sourceEligibleRawBars += adjustmentSummary?.eligibleRawBars ?? bars.length
    sourceMissingAdjustedBars +=
      adjustmentSummary?.missingAdjustedBars ?? bars.filter((bar) => !hasTotalReturnPriceBasis(bar)).length
    // Listing age must come from the FULL history even when the backtest
    // window is trimmed — a 1998 listing trimmed to 15y is still old.
    const firstBarDateMs = bars.length > 0 ? Date.parse(bars[0].date) : Number.NaN
    if (
      Number.isFinite(firstBarDateMs) &&
      firstBarDateMs <= fetchWindowStartMs + FETCH_BOUNDARY_TOLERANCE_MS
    ) {
      tickersAtFetchBoundary++
    }
    if (trimBars != null && bars.length > trimBars) {
      bars = bars.slice(-trimBars)
    }
    if (bars.length === 0) {
      tickersWithZeroBars++
      perTickerSummary.push({ ...summaryBase, bars: 0, samplesGenerated: 0, reason: 'fetch failed or empty' })
      continue
    }
    if ((adjustmentSummary?.rejectedBars ?? 0) > 0) {
      tickersBelowMinBars++
      perTickerSummary.push({
        ...summaryBase,
        bars: bars.length,
        samplesGenerated: 0,
        reason: `${adjustmentSummary!.rejectedBars} incomplete/unaligned provider rows; series rejected fail-closed`,
      })
      continue
    }
    if (bars.length < minBars) {
      tickersBelowMinBars++
      perTickerSummary.push({
        ...summaryBase,
        bars: bars.length,
        samplesGenerated: 0,
        reason: `< ${minBars} bars`,
      })
      continue
    }
    // Point-in-time fundamentals (null for ETFs/non-filers — the ten
    // fundamental features stay at their neutral encoding for them).
    // Coverage describes bars eligible to enter model features/labels, not
    // short/failed ticker histories excluded before sample creation.
    barsObserved += bars.length
    for (const bar of bars) tradingDateSet.add(bar.date)
    barsWithAdjustedCloseAvailable += bars.filter(hasTotalReturnPriceBasis).length
    // SEC's ticker map knows only the current symbol, so a renamed name
    // asks for its filings under the successor as well.
    const fundamentals = await fetchFundamentalsTimeline(fetchedAs)
    if (fundamentals) tickersWithFundamentals++
    let generated = 0
    // Need 252 bars history (for 252d momentum, vol, moments) + 120 future
    // (longest horizon in the ensemble)
    for (let i = 252; i < bars.length - 120; i += cadence) {
      const features = computeFeaturesAtDate(bars, i, fundamentals, {
        firstBarDateMs,
        fetchWindowStartMs,
      })
      // The 12-1 momentum yardstick rides alongside the features, never
      // inside them, so the feature vector itself is untouched.
      const momentum12to1Raw = computeMomentum12to1AtDate(bars, i)
      if (!features || momentum12to1Raw == null) continue
      const fwd5 = computeForwardReturn(bars, i, 5)
      const fwd20 = computeForwardReturn(bars, i, 20)
      const fwd60 = computeForwardReturn(bars, i, 60)
      const fwd120 = computeForwardReturn(bars, i, 120)
      if (fwd5 == null || fwd20 == null || fwd60 == null || fwd120 == null) continue
      const hasPointInTimeSnapshot =
        fundamentals?.at(Date.parse(bars[i].date)) != null && filingAgeIndex >= 0
      if (hasPointInTimeSnapshot) {
        samplesWithPointInTimeSnapshot++
        for (let featureIndex = fundamentalStartIndex; featureIndex < fundamentalEndIndex; featureIndex++) {
          if (Number.isFinite(features[featureIndex])) observedFundamentalFeatureCells++
        }
      }
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
        // Seeded to raw; overwritten by applyCrossSectionalReturnDemeaning.
        forwardReturn5dRel: fwd5,
        forwardReturn20dRel: fwd20,
        forwardReturn60dRel: fwd60,
        forwardReturn120dRel: fwd120,
        labelEnd5d: bars[i + 5].date,
        labelEnd20d: bars[i + 20].date,
        labelEnd60d: bars[i + 60].date,
        labelEnd120d: bars[i + 120].date,
        // Raw log market cap (NaN if no fundamentals) — full-feature index,
        // captured before pruning so the cost model always has it.
        logMarketCap: features[LOG_MKTCAP_FEATURE_INDEX],
        // The size stand-in for names with no filed cap (pre-2009 rows,
        // ETFs), read from the same 20 bars the Amihud feature reads.
        avgDollarVolume20d: averageDollarVolume20d(bars, i),
        pitFundamentalsObserved: hasPointInTimeSnapshot,
        momentum12to1Raw,
      })
      generated++
    }
    tickersWithUsableBars++
    perTickerSummary.push({ ...summaryBase, bars: bars.length, samplesGenerated: generated })
  }

  // Impute missing values with per-date cross-sectional medians (must run
  // BEFORE normalization so NaNs never reach the Z-scores), then tag
  // survivorship cohorts, then normalize, then demean the forward-return
  // targets cross-sectionally (relative-alpha target).
  imputeMissingWithDateMedians(samples)
  assignSurvivorshipCohorts(samples)
  applyCrossSectionalNormalization(samples)
  normalizeMomentum12to1ByDate(samples)
  applyCrossSectionalReturnDemeaning(samples)
  // NOTE (2026-06-21): target transforms were tested and REVERTED. Both
  // ±3-MAD winsorization AND Gaussian rank-transform of the Rel target HURT on
  // the curated 224 (fair Spearman IC 0.058 -> 0.048 / 0.044; Sharpe 1.54 ->
  // 1.37 / 1.11; DSR@N=6 97% -> 94% / 79%). The raw relative-return MAGNITUDE
  // carries ranking signal (the model scales confidence by expected move), so
  // the pointwise squared loss on the raw demeaned target already ranks well.
  // Keep the raw target; do not winsorize or rank-transform it.

  const sampleDates = samples.map((sample) => sample.asOf).sort()
  const ratio = (numerator: number, denominator: number): number =>
    denominator > 0 ? numerator / denominator : 0
  const totalFundamentalFeatureCells = samples.length * FUNDAMENTAL_FEATURE_COUNT
  const adjustedReturnLabelCoverage = ratio(barsWithAdjustedCloseAvailable, barsObserved)
  const sourceAdjustmentCoverage = ratio(
    sourceEligibleRawBars - sourceMissingAdjustedBars,
    sourceEligibleRawBars,
  )
  const labelAdjustment: BacktestDatasetQuality['returns']['labelAdjustment'] =
    adjustedReturnLabelCoverage === 1
      ? 'total-return'
      : adjustedReturnLabelCoverage === 0
        ? 'unadjusted-close'
        : 'mixed'

  return {
    samples,
    tradingDates: [...tradingDateSet].sort(),
    provenance: {
      schemaVersion: 2,
      builtAt: new Date().toISOString(),
      featurePipelineVersion: HISTORICAL_FEATURE_PIPELINE_VERSION,
      priceSource: 'Yahoo Finance chart via local cache proxy',
      fundamentalsSource: 'SEC EDGAR XBRL companyfacts via local backend',
      universeTickers: [...tickers],
      universeConstruction: 'caller-supplied current-symbol list',
      universeEvidence: {
        kind: 'current-symbol-list',
        membershipSource: 'caller-supplied current symbols',
        constituentEffectiveDateField: null,
        delistedSecuritySource: null,
        delistingReturnSource: null,
      },
      universeRenames: plan.renamed.map((entry) => ({ ...entry })),
      universeExcluded: plan.excluded.map((entry) => ({ ...entry })),
      universeAttrition: { ...plan.attrition },
      companyDescriptors: {
        basis: 'derived-point-in-time-from-price-and-filing-history',
        presentDaySectorLabelsUsed: false,
        limitation:
          'No sector or industry label is used. The only labels this repository holds for these symbols are 2026 hand-curated judgements about companies whose returns are already known, so applying them backwards would tell a past sample how its story ended. The SEC numeric industry code would be a defensible point-in-time answer, and the universe generator fetches it, but it is collapsed into a coarse sector string and the number is never kept.',
      },
      requestedRange: range,
      fetchedRange: 'max',
      cadenceTradingDays: cadence,
      minimumBarsPerTicker: minBars,
      featureNames: [...HISTORICAL_FEATURE_NAMES],
      labelHorizonsTradingDays: [...ENSEMBLE_HORIZONS],
      sampleCount: samples.length,
      sampleDateRange: {
        start: sampleDates[0] ?? null,
        end: sampleDates[sampleDates.length - 1] ?? null,
      },
    },
    quality: {
      schemaVersion: 1,
      universe: {
        pointInTimeMembership: false,
        includesDelistedSecurities: false,
        includesDelistingReturns: false,
        survivorshipBiasControlled: false,
        intendedMemberCount: tickers.length,
        membersWithUsablePriceHistory: tickersWithUsableBars,
        // The names set aside before the fetch have a known outcome (they
        // left the market, with the date and reason in universeExcluded);
        // what is missing is their price history, not the fact of it.
        membersWithExplicitNoHistoryOutcome: plan.excluded.length,
        memberOutcomeCoverage: ratio(tickersWithUsableBars + plan.excluded.length, tickers.length),
        limitation:
          'The caller supplies symbols that exist today; historical constituents, dead symbols, and delisting returns are absent, so absolute performance is survivorship-biased. ' +
          plan.attrition.statement,
      },
      returns: {
        labelPriceField: 'close',
        labelAdjustment,
        barsObserved,
        sourceRowsObserved,
        sourceInvalidRawBars,
        sourceRowAcceptanceCoverage: ratio(
          sourceRowsObserved - sourceInvalidRawBars,
          sourceRowsObserved,
        ),
        sourceEligibleRawBars,
        sourceMissingAdjustedBars,
        sourceAdjustmentCoverage,
        barsWithAdjustedCloseAvailable,
        adjustedCloseAvailabilityCoverage: ratio(barsWithAdjustedCloseAvailable, barsObserved),
        adjustedReturnLabelCoverage,
        totalReturnLabelCoverage: adjustedReturnLabelCoverage,
        dividendsIncludedInLabels: adjustedReturnLabelCoverage === 1,
        limitation:
          adjustedReturnLabelCoverage === 1
            ? `Every accepted bar uses Yahoo adjclose total-return prices; ${sourceMissingAdjustedBars} of ${sourceEligibleRawBars} otherwise-valid source rows without adjclose were excluded fail-closed.`
            : 'One or more accepted bars lack a proven adjusted-total-return basis; do not promote until every feature and label bar is adjusted for splits and distributions.',
      },
      fundamentals: {
        source: 'SEC EDGAR XBRL companyfacts',
        alignedByFiledDate: true,
        tickersWithTimeline: tickersWithFundamentals,
        usableTickers: tickersWithUsableBars,
        tickerTimelineCoverage: ratio(tickersWithFundamentals, tickersWithUsableBars),
        samplesWithPointInTimeSnapshot,
        totalSamples: samples.length,
        sampleSnapshotCoverage: ratio(samplesWithPointInTimeSnapshot, samples.length),
        observedFeatureCells: observedFundamentalFeatureCells,
        totalFeatureCells: totalFundamentalFeatureCells,
        observedFeatureCellCoverage: ratio(
          observedFundamentalFeatureCells,
          totalFundamentalFeatureCells,
        ),
        limitation:
          'Coverage is measured before median imputation. ETFs, pre-EDGAR history, and missing XBRL concepts remain neutral/imputed rather than being mistaken for observed data.',
      },
      evaluation: {
        purgedWalkForwardSupported: true,
        embargoSupported: true,
        // True since 2026-08-03: every preprocessing statistic is causal.
        // Per-date cross-sectional stats use same-date data only, and the
        // sparse-date/empty-date fallbacks (imputation medians, Z-score
        // mean/std) use EXPANDING-WINDOW pools over dates at or before the
        // sample's date — strictly stronger than fold-local fitting, since
        // no fold's training features can embed statistics from any later
        // period, including its own test window.
        foldLocalPreprocessing: true,
        lockedPostSelectionHoldout: false,
        limitation:
          'Walk-forward folds purge labels and embargo dates, and all preprocessing statistics are causal (expanding-window; nothing sees future data). There is still no untouched final post-selection holdout period.',
      },
    },
    diagnostics: {
      tickersAttempted: fetchPlan.length,
      tickersWithUsableBars,
      tickersWithZeroBars,
      tickersBelowMinBars,
      tickersWithFundamentals,
      tickersAtFetchBoundary,
      tickersRenamed: plan.renamed.length,
      excludedBeforeFetch: plan.excluded.map((entry) => ({
        ticker: entry.ticker,
        delistingDate: entry.delistingDate,
        reason: entry.reason,
      })),
      perTickerSummary,
    },
  }
}

/**
 * Per-feature mean/std of the RAW feature values that live single-name
 * prediction normalizes against. The model trains on features Z-scored
 * CROSS-SECTIONALLY PER DATE (within-date mean 0, std 1), so the serving
 * scale must match that WITHIN-DATE unit-variance space.
 *
 * The std is therefore the RMS of each date's WITHIN-DATE std — NOT the
 * global pooled std. The pooled std conflates within-date dispersion with
 * across-date level drift (volatility_252d, fund_log_market_cap,
 * log_price_level all drift over the 15y sample), making it far larger
 * than any single date's spread; dividing live deviations by it would
 * compress served Z-scores toward 0 and push the trees' split thresholds
 * into the tails — collapsing live forecasts toward the base value. The
 * mean is the global mean (≈ the average within-date mean, since per-date
 * centering makes each date's mean 0). Compute AFTER pruning so columns
 * line up with the stored model.
 */
export function computeFeatureStats(samples: HistoricalSample[]): {
  means: number[]
  stds: number[]
} {
  if (samples.length === 0) return { means: [], stds: [] }
  const featureCount = samples[0].rawFeatures.length
  const means = new Array(featureCount).fill(0)
  const stds = new Array(featureCount).fill(1)

  // Group sample indices by date for the within-date std.
  const byDate = new Map<string, number[]>()
  samples.forEach((sample, idx) => {
    const arr = byDate.get(sample.asOf) ?? []
    arr.push(idx)
    byDate.set(sample.asOf, arr)
  })
  const MIN_DATE_BREADTH = 5

  for (let f = 0; f < featureCount; f++) {
    const all = samples.map((sample) => sample.rawFeatures[f])
    const globalMean = all.reduce((sum, value) => sum + value, 0) / all.length
    means[f] = globalMean

    // RMS of within-date stds over dates with enough breadth.
    let sumSqStd = 0
    let dateCount = 0
    for (const indices of byDate.values()) {
      if (indices.length < MIN_DATE_BREADTH) continue
      const vals = indices.map((i) => samples[i].rawFeatures[f])
      const m = vals.reduce((s, v) => s + v, 0) / vals.length
      const variance = vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length
      sumSqStd += variance // variance = std^2; RMS of std = sqrt(mean of variance)
      dateCount++
    }
    if (dateCount > 0) {
      stds[f] = Math.sqrt(Math.max(1e-12, sumSqStd / dateCount))
    } else {
      // No date had breadth — fall back to the global std.
      const variance =
        all.reduce((sum, value) => sum + (value - globalMean) ** 2, 0) / all.length
      stds[f] = Math.sqrt(Math.max(1e-12, variance))
    }
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
  /** Exact end of the latest 20-trading-day forward label in this test
   * window. Used to measure dependence between adjacent evaluation windows. */
  testLabelEndDate: string
  informationCoefficient: number
  spearmanIc: number
  hitRate: number
  longShortReturnGross: number
  longShortReturnNet: number   // net of size-tiered trading + borrow costs
  /** Total cost (bps) actually subtracted this step: long entry + long
   * exit + short entry + short exit + short borrow, size-tiered by
   * constituent market cap. */
  realizedCostBps: number
  /** The four trading legs and the borrow fee that add up to
   * realizedCostBps, each in bps. */
  costBreakdownBps?: {
    longEntry: number
    longExit: number
    shortEntry: number
    shortExit: number
    shortBorrow: number
  }
  /** How the names actually charged this window (the long and the short
   * basket together) were placed in a cost tier: by a filed market cap, by
   * the dollar-volume proxy, or by neither (bottom tier). The proxy count is
   * the number of names whose net-return cost rests on the stand-in rather
   * than a filing; see costTierMarketCapUsd. */
  costTierBasis?: {
    filedCap: number
    dollarVolumeProxy: number
    unavailable: number
    chargedNames: number
  }
  longShortSharpe: number
  predictedDecileReturns: number[]
  // Baseline comparisons
  baselineRandomIc: number
  /** 12-0 momentum (the momentum_252d feature column, close today over
   * close 252 bars ago), Pearson IC against the relative 20-day return.
   * NaN when the column is not in the feature set. */
  baselineMomentumIc: number
  /** The same 12-0 baseline as a Spearman (rank) IC. */
  baselineMomentumSpearmanIc?: number
  /** 12-1 momentum (skips the latest month; HistoricalSample.momentum12to1),
   * Pearson and Spearman ICs. NaN when the rows carry no 12-1 value. */
  baselineMomentum12to1Ic?: number
  baselineMomentum12to1SpearmanIc?: number
  /** Ridge regression fitted on the identical purged training rows and
   * scored on the identical test rows, both correlations, with the penalty
   * leave-one-out picked it. NaN when the fit was skipped or failed;
   * `ridgeFailure` says why. */
  ridgeIc?: number
  ridgeSpearmanIc?: number
  ridgeLambda?: number | null
  ridgeFailure?: string
  /** Trees-plus-momentum blend scored on the test rows, both correlations.
   * NaN when no blend could be formed. */
  blendIc?: number
  blendSpearmanIc?: number
  /** Weight on momentum in the blend, from BLEND_MOMENTUM_WEIGHT_GRID; null
   * when no weight could be measured. */
  blendWeight?: number | null
  /** 'out-of-bag': the weight was scored on training rows using only the bag
   * members that never trained on each row. 'unavailable': too few such
   * rows, or no momentum values, so no blend was formed. */
  blendWeightBasis?: 'out-of-bag' | 'unavailable'
  /** Training rows the weight was scored on. */
  blendWeightRows?: number
  /** Which momentum definition the blend was built on. */
  blendMomentumBaseline?: MomentumBaselineDefinition
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
 * The sample list sorted by formation date, with each row's position in that
 * order kept on the row. Every walk-forward window reads rows from this order.
 */
export type IndexedSample = HistoricalSample & { sortIndex: number }

export function indexSamples(samples: HistoricalSample[]): IndexedSample[] {
  const sorted = [...samples].sort((a, b) => a.asOf.localeCompare(b.asOf))
  return sorted.map((sample, idx) => ({ ...sample, sortIndex: idx }))
}

/* -------------------------------------------------------------------------
   Calendar-defined walk-forward windows
   ------------------------------------------------------------------------- */

/**
 * The three numbers that decide where the walk-forward test windows fall.
 * They describe the trading CALENDAR, never the row count, so adding names
 * to the universe adds rows to each window and never changes how many
 * windows there are. The CLI and the in-app worker both start from this one
 * object, so the two produce the same windows on the same data.
 */
export type WindowRule = {
  /** Trading days per test window. Twenty matches the 20-day label, so one
   * window is one non-overlapping holding period. */
  stepTradingDays: number
  /** Years of history, counted from the first sample date, that are used for
   * training only before the first test window opens. */
  burnInYears: number
  /** Trading days dropped from the end of the training set right before each
   * test window opens (Lopez de Prado 2018). Counted on the trading calendar.
   * The value 5 was carried over from the old rule, where it meant five
   * CALENDAR days, so the embargo is now a little longer than it was. */
  embargoTradingDays: number
}

export const DEFAULT_WINDOW_RULE: Readonly<WindowRule> = Object.freeze({
  stepTradingDays: 20,
  burnInYears: 10,
  embargoTradingDays: 5,
})

/**
 * Fill in the defaults for whichever window settings the caller left out and
 * refuse values that cannot describe a window.
 */
export function resolveWindowRule(overrides: Partial<WindowRule> = {}): WindowRule {
  const rule: WindowRule = {
    stepTradingDays: overrides.stepTradingDays ?? DEFAULT_WINDOW_RULE.stepTradingDays,
    burnInYears: overrides.burnInYears ?? DEFAULT_WINDOW_RULE.burnInYears,
    embargoTradingDays: overrides.embargoTradingDays ?? DEFAULT_WINDOW_RULE.embargoTradingDays,
  }
  if (!Number.isInteger(rule.stepTradingDays) || rule.stepTradingDays < 1) {
    throw new Error(`stepTradingDays must be a whole number of at least 1 (got ${rule.stepTradingDays}).`)
  }
  if (!Number.isFinite(rule.burnInYears) || rule.burnInYears < 0) {
    throw new Error(`burnInYears must be zero or more (got ${rule.burnInYears}).`)
  }
  if (!Number.isInteger(rule.embargoTradingDays) || rule.embargoTradingDays < 0) {
    throw new Error(
      `embargoTradingDays must be a whole number of zero or more (got ${rule.embargoTradingDays}).`,
    )
  }
  return rule
}

/** One test window, described entirely by dates. */
export type CalendarWindow = {
  /** Position in date order, starting at zero. */
  index: number
  /** First and last trading day of the test block, inclusive. */
  testStartDate: string
  testEndDate: string
  /** Trading days the block spans; always equal to stepTradingDays. */
  tradingDayCount: number
  /** Latest formation date a training row may carry once the embargo is
   * taken off. Null when the embargo reaches back past the first trading
   * day, which leaves no training rows at all. */
  trainAsOfCutoff: string | null
  /** Rows and distinct names formed inside the block. */
  testRowCount: number
  testNameCount: number
}

/** The ISO date `years` after `isoDate`. Whole years keep the month and day;
 * a fractional part is added as days. */
function addYearsIso(isoDate: string, years: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const wholeYears = Math.floor(years)
  const extraDays = Math.round((years - wholeYears) * 365.25)
  return new Date(Date.UTC(year + wholeYears, month - 1, day + extraDays)).toISOString().slice(0, 10)
}

/**
 * Cut the walk-forward test windows on the trading calendar.
 *
 * The calendar is the sorted list of distinct trading days. When the caller
 * passes `tradingDates` (the dataset builder collects every bar date it saw),
 * that list is the calendar, with any sample date that is somehow missing
 * from it added in. Without it, the distinct sample dates stand in for the
 * calendar. That is exact only when samples are formed on every trading day;
 * with the ten-day sampling cadence and a universe whose histories all start
 * on the same day, the sample dates are one trading day in ten and a
 * "20-day" window would really span 200, so pass the real calendar whenever
 * it is available.
 *
 * Steps: the first `burnInYears` after the first sample date are training
 * only. From the first trading day on or after that point, consecutive
 * blocks of `stepTradingDays` trading days each become one test window that
 * holds every sample formed inside it, across all names. A trailing block
 * shorter than a full step is dropped so every window covers the same span,
 * and a block that holds no samples is dropped because there is nothing to
 * score. The training set for each window is expanding: every row formed
 * before the window, minus the purge and the embargo (see windowRows).
 */
export function buildCalendarWindows(
  samples: readonly HistoricalSample[],
  options: Partial<WindowRule> & { tradingDates?: readonly string[] } = {},
): CalendarWindow[] {
  const rule = resolveWindowRule(options)
  if (samples.length === 0) return []

  // Rows and names per formation date, so each block can report its size
  // without a second pass over the samples.
  const rowsByDate = new Map<string, { rows: number; names: Set<string> }>()
  for (const sample of samples) {
    const entry = rowsByDate.get(sample.asOf) ?? { rows: 0, names: new Set<string>() }
    entry.rows++
    entry.names.add(sample.ticker)
    rowsByDate.set(sample.asOf, entry)
  }
  const dateSet = new Set<string>(options.tradingDates ?? [])
  for (const date of rowsByDate.keys()) dateSet.add(date)
  const dates = [...dateSet].sort()
  const sampleDates = [...rowsByDate.keys()].sort()
  const firstSampleDate = sampleDates[0]
  const lastSampleDate = sampleDates[sampleDates.length - 1]

  const burnInEnd = addYearsIso(firstSampleDate, rule.burnInYears)
  let start = dates.findIndex((date) => date >= burnInEnd)
  if (start < 0) return []

  const windows: CalendarWindow[] = []
  for (; start + rule.stepTradingDays <= dates.length; start += rule.stepTradingDays) {
    const testStartDate = dates[start]
    if (testStartDate > lastSampleDate) break
    const testEndDate = dates[start + rule.stepTradingDays - 1]
    let testRowCount = 0
    const names = new Set<string>()
    for (let i = start; i < start + rule.stepTradingDays; i++) {
      const entry = rowsByDate.get(dates[i])
      if (!entry) continue
      testRowCount += entry.rows
      for (const name of entry.names) names.add(name)
    }
    if (testRowCount === 0) continue
    // The embargo removes the `embargoTradingDays` trading days right before
    // the window, so the last allowed training date sits one day earlier.
    const cutoffIndex = start - rule.embargoTradingDays - 1
    windows.push({
      index: windows.length,
      testStartDate,
      testEndDate,
      tradingDayCount: rule.stepTradingDays,
      trainAsOfCutoff: cutoffIndex >= 0 ? dates[cutoffIndex] : null,
      testRowCount,
      testNameCount: names.size,
    })
  }
  return windows
}

/** First index whose formation date is on or after `date`; the list must be
 * sorted by formation date. */
function lowerBoundByDate(sorted: readonly HistoricalSample[], date: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid].asOf < date) low = mid + 1
    else high = mid
  }
  return low
}

/** First index whose formation date is after `date`; the list must be sorted
 * by formation date. */
function upperBoundByDate(sorted: readonly HistoricalSample[], date: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid].asOf <= date) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * The rows one window trains on and tests on, taken from the date-sorted
 * sample list. Test rows are every sample formed inside the block. Training
 * rows are every sample formed before the block, minus two cuts that keep the
 * test outcomes out of training: the PURGE drops rows whose 20-trading-day
 * label closes on or after the window opens (compared in label space, on
 * real bar dates, because 20 trading days span about 28 calendar days and
 * calendar arithmetic would under-purge), and the EMBARGO drops rows formed
 * within the last `embargoTradingDays` trading days before the window opens
 * (Lopez de Prado 2018).
 */
export function windowRows<T extends HistoricalSample>(
  sortedSamples: readonly T[],
  window: CalendarWindow,
): { train: T[]; test: T[] } {
  const testStart = lowerBoundByDate(sortedSamples, window.testStartDate)
  const testEnd = upperBoundByDate(sortedSamples, window.testEndDate)
  const test = sortedSamples.slice(testStart, testEnd)
  const cutoff = window.trainAsOfCutoff
  const train: T[] = []
  if (cutoff != null) {
    for (let i = 0; i < testStart; i++) {
      const sample = sortedSamples[i]
      if (sample.asOf <= cutoff && sample.labelEnd20d < window.testStartDate) train.push(sample)
    }
  }
  return { train, test }
}

/** The window rule plus what it produced, for the run report. */
export type CalendarWindowSummary = {
  rule: WindowRule
  windowsBuilt: number
  /** Windows that produced a scored step. A window with fewer than 10 test
   * rows or fewer than 50 training rows after the purge is skipped. */
  windowsScored: number
  namesPerWindow: { min: number; median: number; max: number }
  rowsPerWindow: { min: number; median: number; max: number }
  firstTestDate: string | null
  lastTestDate: string | null
  /** Where the samples start and end, which explains a low window count. */
  firstSampleDate: string | null
  lastSampleDate: string | null
}

function minMedianMax(values: readonly number[]): { min: number; median: number; max: number } {
  if (values.length === 0) return { min: 0, median: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return { min: sorted[0], median, max: sorted[sorted.length - 1] }
}

export function summarizeCalendarWindows(
  samples: readonly HistoricalSample[],
  windows: readonly CalendarWindow[],
  rule: WindowRule,
  windowsScored: number = windows.length,
): CalendarWindowSummary {
  let firstSampleDate: string | null = null
  let lastSampleDate: string | null = null
  for (const sample of samples) {
    if (firstSampleDate == null || sample.asOf < firstSampleDate) firstSampleDate = sample.asOf
    if (lastSampleDate == null || sample.asOf > lastSampleDate) lastSampleDate = sample.asOf
  }
  return {
    rule: { ...rule },
    windowsBuilt: windows.length,
    windowsScored,
    namesPerWindow: minMedianMax(windows.map((window) => window.testNameCount)),
    rowsPerWindow: minMedianMax(windows.map((window) => window.testRowCount)),
    firstTestDate: windows[0]?.testStartDate ?? null,
    lastTestDate: windows[windows.length - 1]?.testEndDate ?? null,
    firstSampleDate,
    lastSampleDate,
  }
}

/**
 * Run a single walk-forward step on one calendar window with PURGE + EMBARGO.
 *   - Test set:  every sample formed inside the window, across all names
 *   - Train set: every sample formed before the window, after the
 *                label-space purge and the trading-day embargo (windowRows)
 */
export function walkForwardStep(
  samples: IndexedSample[],
  window: CalendarWindow,
  options: {
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
    /** Train q10/q90 models + split-conformal calibration per step (two
     * extra GBT fits). Default true; the nested-CV inner loop turns it
     * off for speed. */
    computeIntervals?: boolean
    /** Column of the 12-0 momentum feature (momentum_252d) used as the
     * naive baseline. Callers that prune/reorder features MUST pass the real
     * index (featureNames.indexOf('momentum_252d')) or the "edge over
     * momentum" metric silently compares against the wrong feature. Defaults
     * to the column's position in the full, unpruned feature list. */
    baselineMomentumFeatureIndex?: number
    /** Which momentum definition feeds the trees-plus-momentum blend. Both
     * definitions are always scored as baselines; this only picks the one
     * the blend is built on, and defaults to the gate's definition. */
    momentumBaseline?: MomentumBaselineDefinition
    /** Correlation used to pick the blend weight on training rows. Defaults
     * to the gate's correlation. */
    correlation?: CorrelationKind
    /** Fit the ridge and blend alternatives on this window. Default true;
     * the nested hyperparameter search turns it off because it only needs
     * the tree IC. */
    computeAlternatives?: boolean
    /** Keep per-test-sample (cohort, prediction, actual) for survivorship
     * diagnostics. Off by default (memory). */
    captureTestDetails?: boolean
  } = {},
): WalkForwardResult | null {
  const horizonDays = options.horizonDays ?? 20
  const momentumBaseline = options.momentumBaseline ?? DEFAULT_GATE_MOMENTUM_BASELINE
  const correlation = options.correlation ?? DEFAULT_GATE_CORRELATION
  const computeAlternatives = options.computeAlternatives !== false
  // txCostBps is retained on the options for API/back-compat but no longer
  // sets the cost — costs are size-tiered per constituent (see below).

  // The window carries the purge and embargo; windowRows applies them
  // (label-space purge against the window's first trading day, embargo
  // counted in trading days).
  const { train: trainSamples, test: testSamples } = windowRows(samples, window)
  if (testSamples.length < 10) return null
  const testStartDate = window.testStartDate
  if (trainSamples.length < 50) return null

  const trainFeatures = trainSamples.map((sample) => sample.features)
  // TRAIN on RELATIVE (cross-sectionally demeaned) return — the model
  // learns idiosyncratic alpha, not the unpredictable market move.
  const trainTargets = trainSamples.map((sample) => sample.forwardReturn20dRel)
  // Bagged ensemble per fold (5 members × 80% row subsamples, fold-seeded)
  // so the walk-forward measures the SAME object that ships live — the
  // ensemble mean — not a single model the app then doesn't use.
  // Each member's row set is kept as a byte mask so the blend below can score
  // training rows with the members that never trained on them (out-of-bag).
  const memberRowMasks: Array<Uint8Array | null> = []
  const bag = fitBaggedGradientBoosting(trainFeatures, trainTargets, {
    ...(options.modelOptions ?? {}),
    bags: 5,
    sampleFraction: 0.8,
    seed: (Date.parse(testStartDate) / 86_400_000) | 0,
    onMemberRows: (memberIndex, rowIndices) => {
      if (rowIndices == null) {
        memberRowMasks[memberIndex] = null
        return
      }
      const mask = new Uint8Array(trainSamples.length)
      for (const row of rowIndices) mask[row] = 1
      memberRowMasks[memberIndex] = mask
    },
  })

  const predictions = testSamples.map((sample) =>
    predictBaggedGradientBoosting(bag, sample.features),
  )
  // IC / hit rate measured against RELATIVE actuals (the ranking skill the
  // model is actually trained for; raw actuals carry market noise the
  // model never tries to predict). The L/S quintile below uses RAW returns
  // — that is the tradeable spread the strategy earns.
  const actuals = testSamples.map((sample) => sample.forwardReturn20dRel)

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
      // Quantile heads + conformal calibration on the RELATIVE target, so
      // the prediction interval is an interval on the same (relative)
      // quantity the point model predicts.
      const properTargets = properTrain.map((sample) => sample.forwardReturn20dRel)
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
        return Math.max(lo - sample.forwardReturn20dRel, sample.forwardReturn20dRel - hi)
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
        if (sample.forwardReturn20dRel >= lo && sample.forwardReturn20dRel <= hi) covered++
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

  // Long-short quintile portfolio — sorted by the (relative) prediction
  // but earning RAW returns (the actual tradeable spread). Carry each
  // name's market cap so the trading + borrow cost can be size-tiered.
  // The cap the tier tables are read with comes from the filing when there
  // is one, and otherwise from the dollar-volume proxy (costTierMarketCapUsd).
  // The tier only reaches the net return, the Sharpe built on it and the
  // cost report lines; the IC the gate reads is computed above, before any
  // cost exists, and does not see this.
  const indexed = predictions.map((value, idx) => {
    const tier = costTierMarketCapUsd(
      Math.exp(testSamples[idx].logMarketCap), // NaN-safe: exp(NaN)=NaN
      testSamples[idx].avgDollarVolume20d,
    )
    return {
      pred: value,
      actual: testSamples[idx].forwardReturn20d, // RAW — the return earned
      marketCapUsd: tier.capUsd,
      costTierBasis: tier.basis,
    }
  })
  indexed.sort((left, right) => right.pred - left.pred)
  const quintileSize = Math.max(1, Math.floor(indexed.length / 5))
  const topQ = indexed.slice(0, quintileSize)
  const bottomQ = indexed.slice(-quintileSize)
  const topMean = topQ.reduce((sum, item) => sum + item.actual, 0) / topQ.length
  const bottomMean = bottomQ.reduce((sum, item) => sum + item.actual, 0) / bottomQ.length
  const longShortReturnGross = topMean - bottomMean
  // SIZE-TIERED COSTS (replaces the flat 2×10bps). Every window rebalances
  // the whole book: the names bought when the window opens are sold when it
  // closes, and the names shorted are bought back. So each side pays the
  // one-way cost TWICE, on entry and on exit, tiered by its constituents'
  // market caps, and the SHORT side also pays a stock-borrow fee pro-rated
  // over the holding horizon. Until 2026-09-16 only the two entry legs were
  // charged, which understated every round trip by half. A flat rate
  // understated costs for any small-cap tilt — see quantConfig
  // SIZE_TIERED_TRADING_COST / SIZE_TIERED_BORROW_FEE_ANNUAL for sources.
  const longEntryBps = meanOf(topQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const longExitBps = meanOf(topQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const shortEntryBps = meanOf(bottomQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const shortExitBps = meanOf(bottomQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const shortBorrowBps = meanOf(
    bottomQ.map(
      (item) => borrowFeeAnnualBps(item.marketCapUsd) * (horizonDays / TRADING_DAYS_PER_YEAR),
    ),
  )
  const costBreakdownBps = {
    longEntry: longEntryBps,
    longExit: longExitBps,
    shortEntry: shortEntryBps,
    shortExit: shortExitBps,
    shortBorrow: shortBorrowBps,
  }
  // Per window, how many of the charged names were sized by a filing, by
  // the dollar-volume proxy, or by neither, so a reader of the net-return
  // line can see how much of the cost rests on the stand-in.
  const costTierBasis = { filedCap: 0, dollarVolumeProxy: 0, unavailable: 0, chargedNames: 0 }
  for (const item of [...topQ, ...bottomQ]) {
    costTierBasis.chargedNames++
    if (item.costTierBasis === 'filed-cap') costTierBasis.filedCap++
    else if (item.costTierBasis === 'dollar-volume-proxy') costTierBasis.dollarVolumeProxy++
    else costTierBasis.unavailable++
  }
  const realizedCostBps =
    longEntryBps + longExitBps + shortEntryBps + shortExitBps + shortBorrowBps
  const longShortReturnNet = longShortReturnGross - realizedCostBps / 100
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

  // BASELINE: the expected information coefficient of an independent random
  // ranking is exactly zero. Using the analytical expectation avoids letting
  // one lucky random draw change a model's promotion result.
  const baselineRandomIc = 0

  // BASELINE: twelve-month momentum, scored two ways on the same test rows.
  //   12-0: the momentum_252d feature column, close today over close 252
  //         bars ago, which includes the most recent month. NaN when the
  //         column isn't in the (possibly pruned) set — better an honest
  //         "n/a" than silently scoring an unrelated column as momentum.
  //   12-1: close one month ago over close twelve months ago, the
  //         Jegadeesh-Titman (1993) convention that skips the reversal-prone
  //         latest month (HistoricalSample.momentum12to1, Z-scored within
  //         its date like the column). NaN when the rows carry no value.
  // Both get a Pearson and a Spearman IC; computeBaselineEvidence decides
  // which definition and which correlation the gate reads.
  const momentumIndex = options.baselineMomentumFeatureIndex ?? MOMENTUM_252D_FEATURE_INDEX
  const featureWidth = testSamples[0]?.features.length ?? 0
  const momentum12to0Test =
    momentumIndex >= 0 && momentumIndex < featureWidth
      ? testSamples.map((sample) => sample.features[momentumIndex])
      : null
  const momentum12to1Test = testSamples.every((sample) => Number.isFinite(sample.momentum12to1))
    ? testSamples.map((sample) => sample.momentum12to1 as number)
    : null
  const baselineMomentumIc = momentum12to0Test
    ? pearsonCorrelation(momentum12to0Test, actuals)
    : Number.NaN
  const baselineMomentumSpearmanIc = momentum12to0Test
    ? spearmanCorrelation(momentum12to0Test, actuals)
    : Number.NaN
  const baselineMomentum12to1Ic = momentum12to1Test
    ? pearsonCorrelation(momentum12to1Test, actuals)
    : Number.NaN
  const baselineMomentum12to1SpearmanIc = momentum12to1Test
    ? spearmanCorrelation(momentum12to1Test, actuals)
    : Number.NaN

  // ALTERNATIVE MODEL: ridge regression (quantMath fitRidge) on the SAME
  // purged training rows and the SAME feature columns, scored on the SAME
  // test rows. Any lift the trees show over it is lift a straight line
  // through the same inputs could not produce. The penalty is chosen by
  // leave-one-out inside the training rows, so nothing here sees the test
  // window. A fit that cannot be formed is recorded, never silently zeroed.
  let ridgeIc = Number.NaN
  let ridgeSpearmanIc = Number.NaN
  let ridgeLambda: number | null = null
  let ridgeFailure: string | undefined
  if (computeAlternatives) {
    try {
      const ridge = fitRidge(trainFeatures, trainTargets)
      const ridgePredictions = testSamples.map((sample) => predictRidge(ridge, sample.features))
      ridgeIc = pearsonCorrelation(ridgePredictions, actuals)
      ridgeSpearmanIc = spearmanCorrelation(ridgePredictions, actuals)
      ridgeLambda = ridge.lambda
    } catch (error) {
      ridgeFailure = error instanceof Error ? error.message : String(error)
    }
  }

  // ALTERNATIVE MODEL: trees blended with momentum. The momentum weight is
  // measured on this window's TRAINING rows only (see measureMomentumBlend)
  // and then applied to the test rows.
  const momentumOf = (sample: HistoricalSample): number | undefined =>
    momentumBaseline === '12-1'
      ? sample.momentum12to1
      : momentumIndex >= 0 && momentumIndex < sample.features.length
        ? sample.features[momentumIndex]
        : undefined
  const blend: BlendMeasurement = computeAlternatives
    ? measureMomentumBlend({
        trainSamples,
        trainTargets,
        bag,
        memberRowMasks,
        testSamples,
        testTreePredictions: predictions,
        momentumOf,
        correlation,
        seedSalt: (Date.parse(testStartDate) / 86_400_000) | 0,
      })
    : { weight: null, basis: 'unavailable', rows: 0, testPredictions: null }
  const blendIc = blend.testPredictions
    ? pearsonCorrelation(blend.testPredictions, actuals)
    : Number.NaN
  const blendSpearmanIc = blend.testPredictions
    ? spearmanCorrelation(blend.testPredictions, actuals)
    : Number.NaN

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
    const permutationRandom = deterministicRandom(
      actuals,
      (Date.parse(testStartDate) ^ f) >>> 0,
    )
    for (let i = indicesShuf.length - 1; i > 0; i--) {
      const j = Math.floor(permutationRandom() * (i + 1))
      ;[indicesShuf[i], indicesShuf[j]] = [indicesShuf[j], indicesShuf[i]]
    }
    permutedFeatures.forEach((features, i) => {
      features[f] = testSamples[indicesShuf[i]].features[f]
    })
    const permutedPredictions = permutedFeatures.map((features) =>
      predictBaggedGradientBoosting(bag, features),
    )
    const permutedIc = pearsonCorrelation(permutedPredictions, actuals)
    featureImportance.push(ic - permutedIc)
  }

  return {
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    testStartDate,
    testEndDate: window.testEndDate,
    testLabelEndDate: testSamples.reduce(
      (latest, sample) => sample.labelEnd20d > latest ? sample.labelEnd20d : latest,
      testSamples[0].labelEnd20d,
    ),
    informationCoefficient: ic,
    spearmanIc,
    hitRate,
    longShortReturnGross,
    longShortReturnNet,
    realizedCostBps,
    costBreakdownBps,
    costTierBasis,
    longShortSharpe,
    predictedDecileReturns: decileReturns,
    baselineRandomIc,
    baselineMomentumIc,
    baselineMomentumSpearmanIc,
    baselineMomentum12to1Ic,
    baselineMomentum12to1SpearmanIc,
    ridgeIc,
    ridgeSpearmanIc,
    ridgeLambda,
    ridgeFailure,
    blendIc,
    blendSpearmanIc,
    blendWeight: blend.weight,
    blendWeightBasis: blend.basis,
    blendWeightRows: blend.rows,
    blendMomentumBaseline: momentumBaseline,
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

/**
 * Weights on momentum tried for the trees-plus-momentum blend, from "trees
 * only" (0) to "momentum only" (1) in quarter steps. The grid is coarse on
 * purpose: the weight is read off a training-row correlation whose noise is
 * about 1/sqrt(rows) (see BLEND_WEIGHT_MAX_TRAINING_ROWS), and quarter steps
 * are about the finest spacing that noise can still tell apart. It is fine
 * enough to say whether the trees add a little, a lot, or nothing on top of
 * momentum, which is the question the blend exists to answer
 * (docs/EVIDENCE_QUALITY.md, outcome (b) of the pre-registered rule).
 */
export const BLEND_MOMENTUM_WEIGHT_GRID: readonly number[] = [0, 0.25, 0.5, 0.75, 1]

/**
 * Cap on the training rows the blend weight is scored on. The standard error
 * of a sample correlation is close to 1/sqrt(n) (Fisher 1921, "On the
 * probable error of a coefficient of correlation deduced from a small
 * sample", Metron 1(4)), so 20,000 rows pin every candidate weight's
 * training-row IC to about +/-0.007, comfortably inside what the quarter-step
 * grid has to resolve, while the out-of-bag scoring stays negligible next to
 * the tree fits on a million-row window. It is a compute budget, not a model
 * parameter: a larger cap returns the same weight to within that error.
 */
export const BLEND_WEIGHT_MAX_TRAINING_ROWS = 20_000

export type BlendMeasurement = {
  weight: number | null
  basis: 'out-of-bag' | 'unavailable'
  rows: number
  /** Blended score per test row, or null when no blend could be formed. */
  testPredictions: number[] | null
}

/**
 * Pick the momentum weight from BLEND_MOMENTUM_WEIGHT_GRID: score every
 * candidate mix of the two standardised signals against the targets with
 * the chosen correlation and keep the best. Ties go to MORE momentum: the
 * grid runs from "all trees" to "all momentum" and a later candidate
 * replaces an earlier one when it scores the same, because momentum is the
 * yardstick and a tie means the trees added nothing the correlation could
 * see. Null when no candidate produced a finite score. Exported so the tie
 * rule can be pinned on an exact fixture.
 */
export function selectBlendWeight(
  zTree: readonly number[],
  zMomentum: readonly number[],
  targets: readonly number[],
  correlation: CorrelationKind,
): { weight: number; score: number } | null {
  const correlate = correlation === 'spearman' ? spearmanCorrelation : pearsonCorrelation
  let best: { weight: number; score: number } | null = null
  for (const weight of BLEND_MOMENTUM_WEIGHT_GRID) {
    const combined = zTree.map((value, k) => (1 - weight) * value + weight * zMomentum[k])
    const score = correlate(combined, [...targets])
    if (!Number.isFinite(score)) continue
    if (best === null || score >= best.score) best = { weight, score }
  }
  return best
}

function meanAndStd(values: readonly number[]): { mean: number; std: number } {
  const n = values.length
  if (n === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
  return { mean, std: Math.sqrt(variance) }
}

/** Values as Z-scores over themselves, or null when they do not vary. */
function standardize(values: readonly number[]): number[] | null {
  const { mean, std } = meanAndStd(values)
  if (!(std > 0)) return null
  return values.map((value) => (value - mean) / std)
}

/**
 * Measure how much momentum to mix into the trees, using this window's
 * TRAINING rows only, then form the blended score for the test rows.
 *
 * The weight comes from the training rows, so it cannot peek at the test
 * window: a weight chosen on the outcomes the test rows will later reveal
 * would be selection on the test set. But the trees' own predictions on the
 * rows they trained on are over-fitted, and scoring the weight on those
 * would hand the trees the win before the test starts. So each training row
 * is scored only by the bag members that never trained on it, Breiman's
 * out-of-bag estimate (Breiman 1996, "Out-of-bag estimation", UC Berkeley
 * technical report; the same device random forests use for their error
 * rate, Breiman 2001, Machine Learning 45(1)). Tree scores and momentum are
 * each standardised, every grid weight is scored by the chosen correlation
 * against the training targets, and ties go to MORE momentum, because
 * momentum is the yardstick and a tie means the trees added nothing the
 * correlation could see.
 *
 * On the test rows the two signals are standardised over the test window
 * (their own predictions and momentum values, never their outcomes) and
 * combined with the chosen weight.
 *
 * Exported so a test can hand it the same bag with the real out-of-bag
 * masks and with masks that admit every member, and check that the weight
 * walkForwardStep reports is the out-of-bag one.
 */
export function measureMomentumBlend(input: {
  trainSamples: readonly HistoricalSample[]
  trainTargets: readonly number[]
  bag: GradientBoostingModel[]
  memberRowMasks: ReadonlyArray<Uint8Array | null>
  testSamples: readonly HistoricalSample[]
  testTreePredictions: readonly number[]
  momentumOf: (sample: HistoricalSample) => number | undefined
  correlation: CorrelationKind
  seedSalt: number
}): BlendMeasurement {
  const unavailable: BlendMeasurement = {
    weight: null,
    basis: 'unavailable',
    rows: 0,
    testPredictions: null,
  }
  const n = input.trainSamples.length
  if (n === 0 || input.bag.length === 0) return unavailable

  // Thin to the row budget with a draw seeded by the training targets and
  // the window, so the same window always scores the same rows.
  const keepProbability = Math.min(1, BLEND_WEIGHT_MAX_TRAINING_ROWS / n)
  const random = deterministicRandom(input.trainTargets, input.seedSalt ^ 0x626c6e64)
  const treeScores: number[] = []
  const momentumScores: number[] = []
  const targets: number[] = []
  for (let i = 0; i < n; i++) {
    if (keepProbability < 1 && random() >= keepProbability) continue
    const momentum = input.momentumOf(input.trainSamples[i])
    if (momentum == null || !Number.isFinite(momentum)) continue
    let sum = 0
    let members = 0
    for (let b = 0; b < input.bag.length; b++) {
      const mask = input.memberRowMasks[b]
      if (mask == null || mask[i] === 1) continue
      sum += predictGradientBoosting(input.bag[b], input.trainSamples[i].features)
      members++
    }
    if (members === 0) continue
    treeScores.push(sum / members)
    momentumScores.push(momentum)
    targets.push(input.trainTargets[i])
  }
  if (treeScores.length < 2) return unavailable
  const zTree = standardize(treeScores)
  const zMomentum = standardize(momentumScores)
  if (!zTree || !zMomentum) return unavailable

  const best = selectBlendWeight(zTree, zMomentum, targets, input.correlation)
  if (best === null) return unavailable
  const chosen = best.weight
  const measured = { weight: chosen, basis: 'out-of-bag' as const, rows: treeScores.length }

  const testMomentum = input.testSamples.map((sample) => input.momentumOf(sample))
  if (testMomentum.some((value) => value == null || !Number.isFinite(value))) {
    return { ...measured, testPredictions: null }
  }
  const zTestTree = standardize(input.testTreePredictions)
  const zTestMomentum = standardize(testMomentum as number[])
  if (!zTestTree || !zTestMomentum) return { ...measured, testPredictions: null }
  return {
    ...measured,
    testPredictions: zTestTree.map((value, k) => (1 - chosen) * value + chosen * zTestMomentum[k]),
  }
}

/**
 * Spearman rank correlation: Pearson on the ranks of each series. Ranks
 * are positions in sort order, so tied values receive neighbouring ranks
 * in the order the sort left them rather than a shared average rank.
 */
export function spearmanCorrelation(x: number[], y: number[]): number {
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

/** Which correlation an information coefficient is measured with. Pearson
 * is the linear correlation of prediction and outcome; Spearman is the same
 * thing on ranks, so it ignores how big each prediction is and reads only
 * the ordering. */
export type CorrelationKind = 'pearson' | 'spearman'

/** The two twelve-month momentum definitions. '12-1' skips the most recent
 * month (Jegadeesh-Titman 1993, the literature standard); '12-0' includes it
 * (the momentum_252d feature column, the gate's baseline until 2026-09-16). */
export type MomentumBaselineDefinition = '12-1' | '12-0'

/** Defaults for the promotion gate. Both can be overridden per run through
 * the runWalkForwardBacktest / computeBaselineEvidence options, and both
 * momentum definitions and both correlations are always reported side by
 * side, so changing the gate never hides the other reading. */
export const DEFAULT_GATE_MOMENTUM_BASELINE: MomentumBaselineDefinition = '12-1'
export const DEFAULT_GATE_CORRELATION: CorrelationKind = 'pearson'

/** The name a momentum definition carries in the evidence record. */
export function momentumBaselineName(
  definition: MomentumBaselineDefinition,
): 'momentum_12_1' | 'momentum_252d' {
  return definition === '12-1' ? 'momentum_12_1' : 'momentum_252d'
}

export type BaselineComparisonEvidence = {
  /** 'momentum_252d' is the 12-0 definition (the feature column);
   * 'momentum_12_1' skips the latest month. */
  baseline: 'random' | 'momentum_252d' | 'momentum_12_1'
  metric: 'information-coefficient'
  /** Correlation the paired ICs were measured with. Records written before
   * 2026-09-16 omit it and were Pearson. */
  correlation?: CorrelationKind
  /** Differences are paired by the same out-of-sample walk-forward window:
   * model IC minus baseline IC. */
  pairedStepCount: number
  meanDifference: number | null
  bootstrapIterations: number
  blockLength: number | null
  ci95: ConfidenceInterval | null
  ciClearOfZero: boolean
}

/** A paired difference between two of the models scored in every window,
 * built by the same block bootstrap as the gate comparisons. */
export type ModelComparisonEvidence = Omit<BaselineComparisonEvidence, 'baseline' | 'correlation'> & {
  comparison: 'trees-minus-ridge' | 'trees-minus-momentum' | 'blend-minus-momentum'
  correlation: CorrelationKind
  /** Momentum definition on the right-hand side; null for the ridge comparison. */
  momentumBaseline: MomentumBaselineDefinition | null
}

/** Report lines only: the alternative models fitted alongside the trees in
 * every window. Nothing in here decides promotion. */
export type AlternativeModelEvidence = {
  /** Mean IC per model over the windows where that model produced one,
   * under both correlations. */
  models: Array<{
    model: 'trees' | 'ridge' | 'momentum_12_1' | 'momentum_252d' | 'blend'
    windows: number
    meanPearsonIc: number | null
    meanSpearmanIc: number | null
  }>
  comparisons: ModelComparisonEvidence[]
  ridge: {
    lambdaRule: string
    medianLambda: number | null
    failedWindows: number
  }
  blend: {
    momentumBaseline: MomentumBaselineDefinition
    weightGrid: number[]
    weightBasis: 'out-of-bag'
    meanMomentumWeight: number | null
    windowsWithWeight: number
  }
}

export type BaselineEvidence = {
  method: 'paired moving-block bootstrap (Kunsch 1989; Politis-Romano 1994)'
  confidenceLevel: 0.95
  random: BaselineComparisonEvidence
  /** The gate's momentum comparison, under gate.momentumBaseline and
   * gate.correlation. */
  momentum: BaselineComparisonEvidence
  /** What the two gate comparisons above were measured with. Records
   * written before 2026-09-16 omit it: Pearson against the 12-0 column. */
  gate?: { correlation: CorrelationKind; momentumBaseline: MomentumBaselineDefinition }
  /** Trees minus momentum under BOTH definitions, at the gate correlation,
   * so the owner can see the difference the definition makes. One of the
   * two is the `momentum` comparison above. */
  momentumByDefinition?: Record<MomentumBaselineDefinition, BaselineComparisonEvidence>
  /** Ridge, momentum-only and blend alternatives with their paired
   * intervals. Report lines only. */
  alternatives?: AlternativeModelEvidence
}

export type ModelPromotionReason = {
  code:
    | 'POINT_IN_TIME_UNIVERSE_AND_DELISTINGS'
    | 'TOTAL_RETURN_LABELS'
    | 'POINT_IN_TIME_FUNDAMENTALS'
    | 'FUNDAMENTALS_COVERAGE'
    | 'FOLD_LOCAL_PREPROCESSING'
    | 'LOCKED_POST_SELECTION_HOLDOUT'
    | 'EDGE_OVER_RANDOM'
    | 'EDGE_OVER_MOMENTUM'
  status: 'pass' | 'block' | 'warning'
  title: string
  detail: string
}

export type ModelPromotionAssessment = {
  schemaVersion: 1
  policy: 'research-evidence-promotion-v1'
  status: 'promotable' | 'advisory-only'
  promotable: boolean
  /** Complete, UI-ready audit trail. A criterion is never silently omitted. */
  reasons: ModelPromotionReason[]
  blockerCodes: ModelPromotionReason['code'][]
  baselineEvidence: BaselineEvidence
}

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
  /** 12-0 momentum (the momentum_252d column), Pearson, mean over windows. */
  meanBaselineMomentumIc: number
  /** 12-1 momentum, Pearson, mean over the windows where it was available;
   * NaN when it never was. */
  meanBaselineMomentum12to1Ic: number
  /** Ridge and blend alternatives, Pearson, same convention. */
  meanRidgeIc: number
  meanBlendIc: number
  /** The yardsticks the gate read on this run. */
  gateMomentumBaseline: MomentumBaselineDefinition
  gateCorrelation: CorrelationKind
  /** Paired model-minus-baseline IC differences with moving-block bootstrap
   * CIs. Promotion requires both lower bounds to clear zero. */
  baselineEvidence: BaselineEvidence
  cumulativeReturn: number
  maxDrawdown: number
  meanFeatureImportance: number[]
  totalSamples: number
  /** Backward-compat: the 20-day median model */
  trainedModel: GradientBoostingModel
  /** Bagged 20d ensemble — the measured + served scorer (member mean). */
  bag20: GradientBoostingModel[]
  /** Multi-horizon ensemble: one bundle per horizon, each containing
   *  median + p10 + p90 models for prediction intervals. */
  horizonBundles: HorizonModelBundle[]
  /** The embargo the walk-forward windows used, in TRADING days (it was
   * calendar days before the windows moved onto the trading calendar). */
  embargoDaysUsed: number
  txCostBpsUsed: number
  /** Mean per-step realized cost (bps) actually subtracted from the L/S
   * spread — size-tiered (entry both legs + short borrow). This, not
   * txCostBpsUsed, is what the net returns reflect. */
  meanRealizedCostBps: number
  icCI: ConfidenceInterval
  hitRateCI: ConfidenceInterval
  longShortReturnNetCI: ConfidenceInterval
  longShortSharpeCI: ConfidenceInterval
  /** Out-of-sample coverage of the conformalized 80% interval across
   * walk-forward steps (target 0.80) with bootstrap CI, plus mean width.
   * Honest interval validation per Romano et al. 2019. */
  intervalCoverage80CI?: ConfidenceInterval
  intervalMeanWidthPct?: number
  /** LIVE-APPLICABLE 20d IC: the held-out IC the model realizes when the
   * test set is normalized the way SERVING normalizes (global train-window
   * stats), not the per-date cross-sectional Z the walk-forward meanIC is
   * measured under. meanIC is the validated-pipeline number; this is what
   * single-ticker live predictions actually get. NaN if too few samples. */
  servingConsistentIC20d?: number
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
  /** How the hyperparameters were chosen: 'frozen' is FROZEN_HYPERPARAMETERS
   * (the pre-registered default), 'nested-search' the inner walk-forward
   * search, 'caller-supplied' explicit modelOptions. */
  hyperparameterSelection: 'frozen' | 'nested-search' | 'caller-supplied'
  /** How the test windows were cut on the trading calendar and how big
   * they came out. The window count is the number of independent tests
   * behind every confidence interval above, so it is reported, not
   * assumed. */
  windowSummary: CalendarWindowSummary
}

/**
 * Single purged + embargoed train/test split for a quick OUT-OF-FOLD IC
 * (+ hit rate) at one horizon — replaces the upward-biased in-sample
 * correlation that was being shown as "horizon IC". Trains on the older
 * ~70%, scores the newest ~30%, train side purged in label space +
 * embargoed. NaN when too few samples to measure honestly.
 */
function heldOutHorizonMetrics(
  sorted: HistoricalSample[],
  horizon: HorizonKey,
  modelOptions: { numTrees?: number; depth?: number; learningRate?: number },
  embargoDays: number,
): { ic: number; hitRate: number } {
  // RELATIVE target — same as the shipped models train on.
  const targetFn = (s: HistoricalSample): number =>
    horizon === 5
      ? s.forwardReturn5dRel
      : horizon === 20
        ? s.forwardReturn20dRel
        : horizon === 60
          ? s.forwardReturn60dRel
          : s.forwardReturn120dRel
  const labelEndFn = (s: HistoricalSample): string =>
    horizon === 5
      ? s.labelEnd5d
      : horizon === 20
        ? s.labelEnd20d
        : horizon === 60
          ? s.labelEnd60d
          : s.labelEnd120d
  const splitIndex = Math.floor(sorted.length * 0.7)
  if (splitIndex < 100 || sorted.length - splitIndex < 30) {
    return { ic: Number.NaN, hitRate: Number.NaN }
  }
  const testStartDate = sorted[splitIndex].asOf
  const embargoCutoff = new Date(testStartDate).getTime() - embargoDays * 86_400_000
  const train = sorted
    .slice(0, splitIndex)
    .filter(
      (s) => labelEndFn(s) < testStartDate && new Date(s.asOf).getTime() <= embargoCutoff,
    )
  const test = sorted.slice(splitIndex)
  if (train.length < 100) return { ic: Number.NaN, hitRate: Number.NaN }
  const model = fitGradientBoosting(
    train.map((s) => s.features),
    train.map(targetFn),
    { ...modelOptions, quantile: 0.5 },
  )
  const preds = test.map((s) => predictGradientBoosting(model, s.features))
  const actuals = test.map(targetFn)
  const hits = preds.filter((v, i) => Math.sign(v) === Math.sign(actuals[i])).length
  return { ic: pearsonCorrelation(preds, actuals), hitRate: hits / Math.max(1, preds.length) }
}

/**
 * LIVE-APPLICABLE 20d IC. Trains the model on per-date-Z features exactly
 * as shipped, but SCORES the held-out test set under the global train-
 * window normalization that live single-ticker serving uses
 * (computeFeatureStats over the train window). This is the honest answer
 * to "does the validated IC survive the train/serve normalization skew?"
 * — the per-date-Z walk-forward IC is not the transform live reproduces.
 */
function servingConsistentIC(
  sorted: HistoricalSample[],
  modelOptions: { numTrees?: number; depth?: number; learningRate?: number },
  embargoDays: number,
): number {
  const splitIndex = Math.floor(sorted.length * 0.7)
  if (splitIndex < 100 || sorted.length - splitIndex < 30) return Number.NaN
  const testStartDate = sorted[splitIndex].asOf
  const embargoCutoff = new Date(testStartDate).getTime() - embargoDays * 86_400_000
  const train = sorted
    .slice(0, splitIndex)
    .filter(
      (s) => s.labelEnd20d < testStartDate && new Date(s.asOf).getTime() <= embargoCutoff,
    )
  const test = sorted.slice(splitIndex)
  if (train.length < 100) return Number.NaN
  const model = fitGradientBoosting(
    train.map((s) => s.features),
    train.map((s) => s.forwardReturn20dRel), // RELATIVE target, as shipped
    modelOptions,
  )
  // Global train-window raw-feature stats = exactly what live serving
  // normalizes against (computeFeatureStats / model.featureMeans/Stds).
  const stats = computeFeatureStats(train)
  const preds = test.map((s) => {
    const norm = s.rawFeatures.map((v, i) => {
      const m = stats.means[i] ?? 0
      const sd = stats.stds[i] ?? 1
      const filled = Number.isNaN(v) ? m : v
      return (filled - m) / Math.max(1e-12, sd)
    })
    return predictGradientBoosting(model, norm)
  })
  return pearsonCorrelation(preds, test.map((s) => s.forwardReturn20dRel))
}


/**
 * MOVING-BLOCK bootstrap CI of a statistic over a SERIALLY-DEPENDENT
 * series. The walk-forward steps are NOT i.i.d. — consecutive test windows
 * overlap in label space (each step's 20d-forward labels reach into the
 * next window), so the plain i.i.d. bootstrap above understates the CI
 * width and overstates precision. Resampling contiguous blocks of length
 * `blockLen` preserves that local dependence, widening the interval to an
 * honest one (Künsch 1989; Politis-Romano 1994). blockLen ≈ how many
 * adjacent windows share label space.
 */
function blockBootstrapStat(
  values: number[],
  statistic: (sample: number[]) => number,
  blockLen: number,
  iterations = 1000,
): ConfidenceInterval {
  const n = values.length
  if (n === 0) return { lower: 0, mean: 0, upper: 0 }
  const point = statistic(values)
  if (n <= blockLen) return { lower: point, mean: point, upper: point }
  const stats: number[] = []
  const random = deterministicRandom(values, iterations ^ blockLen)
  for (let it = 0; it < iterations; it++) {
    const resample: number[] = []
    while (resample.length < n) {
      const start = Math.floor(random() * (n - blockLen + 1))
      for (let k = 0; k < blockLen && resample.length < n; k++) {
        resample.push(values[start + k])
      }
    }
    stats.push(statistic(resample))
  }
  stats.sort((a, b) => a - b)
  return {
    lower: stats[Math.floor(0.025 * stats.length)],
    mean: point,
    upper: stats[Math.floor(0.975 * stats.length)],
  }
}

/** Measure how many consecutive evaluation windows share 20-day label
 * information using the artifact's exact dates. This replaces the former
 * hand-set block length of three with a reproducible property of the split. */
export function measuredOverlapBlockLength(
  steps: ReadonlyArray<Pick<WalkForwardResult, 'testStartDate' | 'testLabelEndDate'>>,
): number {
  if (steps.length <= 1) return 1
  const ordered = [...steps].sort((left, right) => left.testStartDate.localeCompare(right.testStartDate))
  let maximum = 1
  for (let i = 0; i < ordered.length; i++) {
    let span = 1
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].testStartDate > ordered[i].testLabelEndDate) break
      span++
    }
    maximum = Math.max(maximum, span)
  }
  return maximum
}

/**
 * Pair each model IC with the baseline IC from the exact same test window,
 * then bootstrap the DIFFERENCE in contiguous blocks. Pairing removes common
 * regime/window noise; blocks retain the serial dependence caused by
 * overlapping forward labels. A single window cannot estimate uncertainty,
 * so its CI is deliberately unavailable rather than reported as degenerate.
 */
/** The per-window numbers computeBaselineEvidence reads. WalkForwardResult
 * satisfies it; older step records that lack the newer optional fields still
 * work, with every comparison that needs them reported as unavailable. */
export type BaselineEvidenceStep = {
  testStartDate: string
  testLabelEndDate: string
  informationCoefficient: number
  spearmanIc?: number
  baselineRandomIc: number
  baselineMomentumIc: number
  baselineMomentumSpearmanIc?: number
  baselineMomentum12to1Ic?: number
  baselineMomentum12to1SpearmanIc?: number
  ridgeIc?: number
  ridgeSpearmanIc?: number
  ridgeLambda?: number | null
  ridgeFailure?: string
  blendIc?: number
  blendSpearmanIc?: number
  blendWeight?: number | null
}

type EvidenceModel = 'trees' | 'ridge' | 'momentum_12_1' | 'momentum_252d' | 'blend' | 'random'

/** One window's IC for one model under one correlation; NaN when the step
 * does not carry it. */
function evidenceModelIc(
  step: BaselineEvidenceStep,
  model: EvidenceModel,
  correlation: CorrelationKind,
): number {
  const pick = (pearson: number | undefined, spearman: number | undefined): number =>
    (correlation === 'pearson' ? pearson : spearman) ?? Number.NaN
  switch (model) {
    case 'trees':
      return pick(step.informationCoefficient, step.spearmanIc)
    case 'ridge':
      return pick(step.ridgeIc, step.ridgeSpearmanIc)
    case 'momentum_12_1':
      return pick(step.baselineMomentum12to1Ic, step.baselineMomentum12to1SpearmanIc)
    case 'momentum_252d':
      return pick(step.baselineMomentumIc, step.baselineMomentumSpearmanIc)
    case 'blend':
      return pick(step.blendIc, step.blendSpearmanIc)
    case 'random':
      // The expected IC of an independent random ranking is exactly zero
      // under either correlation, so the analytical value is used rather
      // than one lucky draw (see walkForwardStep).
      return step.baselineRandomIc
  }
}

type PairedDifferenceEvidence = Pick<
  BaselineComparisonEvidence,
  'metric' | 'pairedStepCount' | 'meanDifference' | 'bootstrapIterations' | 'blockLength' | 'ci95' | 'ciClearOfZero'
>

/**
 * Pair the left model's IC with the right model's IC from the exact same
 * test window, then bootstrap the DIFFERENCE in contiguous blocks. Pairing
 * removes common regime/window noise; blocks retain the serial dependence
 * caused by overlapping forward labels. Windows where either side is
 * unavailable drop out of the pairing. A single window cannot estimate
 * uncertainty, so its CI is deliberately unavailable rather than reported
 * as degenerate.
 */
function pairedDifferenceEvidence(
  steps: readonly BaselineEvidenceStep[],
  left: EvidenceModel,
  right: EvidenceModel,
  correlation: CorrelationKind,
  iterations: number,
): PairedDifferenceEvidence {
  const paired = steps
    .map((step) => ({
      step,
      left: evidenceModelIc(step, left, correlation),
      right: evidenceModelIc(step, right, correlation),
    }))
    .filter((pair) => Number.isFinite(pair.left) && Number.isFinite(pair.right))
  const differences = paired.map((pair) => pair.left - pair.right)
  const meanDifference =
    differences.length > 0
      ? differences.reduce((sum, value) => sum + value, 0) / differences.length
      : null
  const blockLength = measuredOverlapBlockLength(paired.map((pair) => pair.step))
  const ci95 =
    differences.length >= 2 && blockLength < differences.length
      ? blockBootstrapStat(
          differences,
          (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
          blockLength,
          iterations,
        )
      : null
  return {
    metric: 'information-coefficient',
    pairedStepCount: differences.length,
    meanDifference,
    bootstrapIterations: iterations,
    blockLength: differences.length >= 2 ? blockLength : null,
    ci95,
    ciClearOfZero: ci95 != null && ci95.lower > 0,
  }
}

/**
 * Pair each model IC with the baseline IC from the exact same test window
 * and bootstrap the differences in blocks (see pairedDifferenceEvidence).
 *
 * The two gate comparisons, `random` and `momentum`, are measured with the
 * correlation and the momentum definition in `options` (defaults:
 * DEFAULT_GATE_CORRELATION, DEFAULT_GATE_MOMENTUM_BASELINE). Everything
 * else in the record is a report line: trees minus momentum under the other
 * definition, and the ridge, momentum-only and blend alternatives with
 * their own paired intervals under both correlations.
 */
export function computeBaselineEvidence(
  steps: BaselineEvidenceStep[],
  bootstrapIterations = 1000,
  options: { momentumBaseline?: MomentumBaselineDefinition; correlation?: CorrelationKind } = {},
): BaselineEvidence {
  const iterations = Math.max(1, Math.floor(bootstrapIterations))
  const gateCorrelation = options.correlation ?? DEFAULT_GATE_CORRELATION
  const gateMomentum = options.momentumBaseline ?? DEFAULT_GATE_MOMENTUM_BASELINE
  const otherMomentum: MomentumBaselineDefinition = gateMomentum === '12-1' ? '12-0' : '12-1'
  const gateName = momentumBaselineName(gateMomentum)

  const random: BaselineComparisonEvidence = {
    baseline: 'random',
    correlation: gateCorrelation,
    ...pairedDifferenceEvidence(steps, 'trees', 'random', gateCorrelation, iterations),
  }
  const momentum: BaselineComparisonEvidence = {
    baseline: gateName,
    correlation: gateCorrelation,
    ...pairedDifferenceEvidence(steps, 'trees', gateName, gateCorrelation, iterations),
  }
  const momentumOther: BaselineComparisonEvidence = {
    baseline: momentumBaselineName(otherMomentum),
    correlation: gateCorrelation,
    ...pairedDifferenceEvidence(
      steps,
      'trees',
      momentumBaselineName(otherMomentum),
      gateCorrelation,
      iterations,
    ),
  }

  const comparisons: ModelComparisonEvidence[] = []
  for (const correlation of ['pearson', 'spearman'] as const) {
    comparisons.push({
      comparison: 'trees-minus-ridge',
      correlation,
      momentumBaseline: null,
      ...pairedDifferenceEvidence(steps, 'trees', 'ridge', correlation, iterations),
    })
    comparisons.push({
      comparison: 'trees-minus-momentum',
      correlation,
      momentumBaseline: gateMomentum,
      ...pairedDifferenceEvidence(steps, 'trees', gateName, correlation, iterations),
    })
    comparisons.push({
      comparison: 'blend-minus-momentum',
      correlation,
      momentumBaseline: gateMomentum,
      ...pairedDifferenceEvidence(steps, 'blend', gateName, correlation, iterations),
    })
  }

  const meanOfFinite = (values: number[]): number | null => {
    const finite = values.filter((value) => Number.isFinite(value))
    return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length
  }
  const models: AlternativeModelEvidence['models'] = (
    ['trees', 'ridge', 'momentum_12_1', 'momentum_252d', 'blend'] as const
  ).map((model) => {
    const pearson = steps.map((step) => evidenceModelIc(step, model, 'pearson'))
    const spearman = steps.map((step) => evidenceModelIc(step, model, 'spearman'))
    return {
      model,
      windows: pearson.filter((value, index) => Number.isFinite(value) || Number.isFinite(spearman[index])).length,
      meanPearsonIc: meanOfFinite(pearson),
      meanSpearmanIc: meanOfFinite(spearman),
    }
  })
  const lambdas = steps
    .map((step) => step.ridgeLambda)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  const weights = steps
    .map((step) => step.blendWeight)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  return {
    method: 'paired moving-block bootstrap (Kunsch 1989; Politis-Romano 1994)',
    confidenceLevel: 0.95,
    random,
    momentum,
    gate: { correlation: gateCorrelation, momentumBaseline: gateMomentum },
    momentumByDefinition: {
      [gateMomentum]: momentum,
      [otherMomentum]: momentumOther,
    } as Record<MomentumBaselineDefinition, BaselineComparisonEvidence>,
    alternatives: {
      models,
      comparisons,
      ridge: {
        lambdaRule:
          'exact leave-one-out over RIDGE_LAMBDA_GRID_MULTIPLIERS x feature count, inside each window\'s training rows (quantMath fitRidge)',
        medianLambda: lambdas.length === 0 ? null : lambdas[lambdas.length >> 1],
        failedWindows: steps.filter((step) => step.ridgeFailure != null).length,
      },
      blend: {
        momentumBaseline: gateMomentum,
        weightGrid: [...BLEND_MOMENTUM_WEIGHT_GRID],
        weightBasis: 'out-of-bag',
        meanMomentumWeight: meanOfFinite(weights),
        windowsWithWeight: weights.length,
      },
    },
  }
}

/** Promotion policy encoded as auditable statistical/provenance predicates.
 * There are no hand-tuned score cutoffs: data gates are booleans/full
 * coverage, and skill gates require the paired 95% CI lower bound > 0, exactly
 * matching the product doctrine's "CI clear of zero" rule. */
export function assessModelPromotion(
  quality: BacktestDatasetQuality,
  baselineEvidence: BaselineEvidence,
): ModelPromotionAssessment {
  const reasons: ModelPromotionReason[] = []
  const add = (
    code: ModelPromotionReason['code'],
    passed: boolean,
    title: string,
    passDetail: string,
    blockDetail: string,
  ): void => {
    reasons.push({
      code,
      status: passed ? 'pass' : 'block',
      title,
      detail: passed ? passDetail : blockDetail,
    })
  }

  const universeReady =
    quality.universe.pointInTimeMembership &&
    quality.universe.includesDelistedSecurities &&
    quality.universe.includesDelistingReturns &&
    quality.universe.survivorshipBiasControlled &&
    quality.universe.memberOutcomeCoverage === 1
  add(
    'POINT_IN_TIME_UNIVERSE_AND_DELISTINGS',
    universeReady,
    'Point-in-time universe and delistings',
    'Universe membership is point-in-time and includes dead securities plus delisting returns.',
    quality.universe.limitation,
  )

  // This check verifies the LABELS' price basis. It used to also demand
  // sourceRowAcceptanceCoverage === 1 — i.e. that the third-party raw feed
  // contained ZERO malformed rows across ~1.7M — which made the check
  // unpassable forever even when every accepted bar was fully adjusted
  // (the Aug-3 run printed a success-voiced detail under a BLOCK status).
  // Rows the pipeline rejects fail-closed never become labels, so their
  // mere existence in the source cannot contaminate the label basis.
  // Severity now matches the actual risk:
  //   labels not fully adjusted            -> BLOCK (real contamination)
  //   labels clean, material exclusions    -> BLOCK (>1% of source rows
  //     excluded can bias which names/periods the panel represents)
  //   labels clean, minor exclusions       -> WARN with the rate disclosed
  //   labels clean, zero exclusions        -> PASS
  const labelsFullyAdjusted =
    quality.returns.labelAdjustment === 'total-return' &&
    quality.returns.adjustedReturnLabelCoverage === 1 &&
    quality.returns.totalReturnLabelCoverage === 1 &&
    quality.returns.dividendsIncludedInLabels
  const excludedSourceRows =
    quality.returns.sourceInvalidRawBars + quality.returns.sourceMissingAdjustedBars
  const excludedShare =
    quality.returns.sourceRowsObserved > 0
      ? excludedSourceRows / quality.returns.sourceRowsObserved
      : 0
  const MATERIAL_EXCLUSION_SHARE = 0.01
  if (!labelsFullyAdjusted) {
    add(
      'TOTAL_RETURN_LABELS',
      false,
      'Corporate-action-adjusted total-return labels',
      'Every return label includes split and dividend adjustments.',
      quality.returns.limitation,
    )
  } else if (excludedShare > MATERIAL_EXCLUSION_SHARE) {
    add(
      'TOTAL_RETURN_LABELS',
      false,
      'Corporate-action-adjusted total-return labels',
      'Every return label includes split and dividend adjustments.',
      `Every accepted bar is adjusted, but ${excludedSourceRows} of ` +
        `${quality.returns.sourceRowsObserved} source rows ` +
        `(${(excludedShare * 100).toFixed(2)}%) were excluded fail-closed — ` +
        `an exclusion rate this material can bias which names and periods ` +
        `the panel represents.`,
    )
  } else {
    reasons.push({
      code: 'TOTAL_RETURN_LABELS',
      status: excludedSourceRows === 0 ? 'pass' : 'warning',
      title: 'Corporate-action-adjusted total-return labels',
      detail:
        excludedSourceRows === 0
          ? 'Every return label includes split and dividend adjustments; no source rows required exclusion.'
          : `Every return label includes split and dividend adjustments. ` +
            `${excludedSourceRows} of ${quality.returns.sourceRowsObserved} source rows ` +
            `(${(excludedShare * 100).toFixed(3)}%) were malformed or lacked an adjusted close ` +
            `and were excluded fail-closed — disclosed here, never used as labels.`,
    })
  }

  add(
    'POINT_IN_TIME_FUNDAMENTALS',
    quality.fundamentals.alignedByFiledDate,
    'Point-in-time fundamentals alignment',
    'Fundamental snapshots are keyed by their public filed date.',
    'Fundamental inputs are not proven to be aligned by public filed date.',
  )
  const snapshotCoveragePct = (quality.fundamentals.sampleSnapshotCoverage * 100).toFixed(1)
  reasons.push({
    code: 'FUNDAMENTALS_COVERAGE',
    status: quality.fundamentals.sampleSnapshotCoverage === 1 ? 'pass' : 'warning',
    title: 'Point-in-time fundamentals coverage',
    detail:
      `${snapshotCoveragePct}% of samples have a filed snapshot; ` +
      `${(quality.fundamentals.observedFeatureCellCoverage * 100).toFixed(1)}% of fundamental cells were observed before imputation. ` +
      quality.fundamentals.limitation,
  })

  add(
    'FOLD_LOCAL_PREPROCESSING',
    quality.evaluation.foldLocalPreprocessing,
    'Causal preprocessing statistics',
    'Every preprocessing statistic is causal: per-date cross-sectional stats use same-date data only, and sparse-date fallbacks use expanding-window pools over dates at or before each sample — no training feature embeds future/test-period information.',
    'Global fallback preprocessing statistics are derived before walk-forward folds and can see future/test-period features.',
  )

  const lockedEvaluationReady =
    quality.evaluation.purgedWalkForwardSupported &&
    quality.evaluation.embargoSupported &&
    quality.evaluation.lockedPostSelectionHoldout
  add(
    'LOCKED_POST_SELECTION_HOLDOUT',
    lockedEvaluationReady,
    'Purged evaluation with locked post-selection holdout',
    'Evaluation is purged and embargoed, with a final period locked before feature/model selection.',
    quality.evaluation.limitation,
  )

  const evidenceDetail = (comparison: BaselineComparisonEvidence): string =>
    comparison.ci95
      ? `Paired model-minus-${comparison.baseline} IC is ${comparison.ci95.mean.toFixed(4)} ` +
        `(95% moving-block bootstrap CI ${comparison.ci95.lower.toFixed(4)} to ${comparison.ci95.upper.toFixed(4)}, ` +
        `n=${comparison.pairedStepCount} windows, block=${comparison.blockLength ?? 'unavailable'}, ` +
        `${comparison.bootstrapIterations} resamples).`
      : `A paired bootstrap CI versus ${comparison.baseline} is unavailable ` +
        `(n=${comparison.pairedStepCount} usable windows).`
  // Efron & Tibshirani (1993), An Introduction to the Bootstrap, recommend
  // at least 1,000 resamples for interval estimation. Requiring block<n is a
  // structural identifiability check: one all-covering block has no resampling
  // variation and therefore cannot estimate uncertainty.
  const baselineReady = (comparison: BaselineComparisonEvidence): boolean =>
    comparison.ci95 != null &&
    comparison.ci95.lower > 0 &&
    comparison.bootstrapIterations >= 1000 &&
    comparison.blockLength != null &&
    comparison.blockLength < comparison.pairedStepCount
  add(
    'EDGE_OVER_RANDOM',
    baselineReady(baselineEvidence.random),
    'Out-of-sample edge over random',
    evidenceDetail(baselineEvidence.random),
    evidenceDetail(baselineEvidence.random),
  )
  add(
    'EDGE_OVER_MOMENTUM',
    baselineReady(baselineEvidence.momentum),
    'Out-of-sample edge over momentum',
    evidenceDetail(baselineEvidence.momentum),
    evidenceDetail(baselineEvidence.momentum),
  )

  const blockerCodes = reasons
    .filter((reason) => reason.status === 'block')
    .map((reason) => reason.code)
  return {
    schemaVersion: 1,
    policy: 'research-evidence-promotion-v1',
    status: blockerCodes.length === 0 ? 'promotable' : 'advisory-only',
    promotable: blockerCodes.length === 0,
    reasons,
    blockerCodes,
    baselineEvidence,
  }
}

/* =========================================================================
   Selection-inflation analysis (offline honesty layer)
   -------------------------------------------------------------------------
   How much of the headline IC / Sharpe is real vs the artifact of screening a
   feature zoo and a hyperparameter grid? These run in the backtest CLI only.
   ========================================================================= */

/** Moving-block-bootstrap p-value for H0: mean(series) = 0, two-sided. Blocks
 * preserve the serial dependence created by overlapping 20d-forward label
 * windows (the same reason blockBootstrapStat exists), so the null variance is
 * not understated the way an i.i.d. shuffle would. Add-one smoothed. */
function blockBootstrapPValueMeanZero(values: number[], blockLen: number, iterations = 1000): number {
  const n = values.length
  if (n < 3) return 1
  const obsMean = values.reduce((s, v) => s + v, 0) / n
  const centered = values.map((v) => v - obsMean) // impose the null
  const eff = Math.min(blockLen, n)
  let extreme = 0
  const random = deterministicRandom(centered, iterations ^ eff ^ 0x42535450)
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    let count = 0
    while (count < n) {
      const start = Math.floor(random() * (n - eff + 1))
      for (let k = 0; k < eff && count < n; k++) {
        sum += centered[start + k]
        count++
      }
    }
    if (Math.abs(sum / n) >= Math.abs(obsMean)) extreme++
  }
  return (extreme + 1) / (iterations + 1)
}

export type FeatureFDRResult = {
  perFeature: Array<{ name: string; meanIC: number; pValue: number; significant: boolean }>
  q: number
  significantCount: number
}

/**
 * FDR-controlled feature screen. For each feature: per-date cross-sectional IC
 * (Pearson of the feature vs the 20d RELATIVE forward return) → a block-
 * bootstrap p-value for mean-IC ≠ 0 → Benjamini-Hochberg across all features.
 * Replaces the eyeballed "+0.001 importance" cut with a multiple-testing-
 * controlled keeper set (Harvey-Liu-Zhu 2016; Benjamini-Hochberg 1995).
 */
export function featureSelectionFDR(
  samples: HistoricalSample[],
  featureNames: string[],
  q: number,
  iterations = 2000,
): FeatureFDRResult {
  if (!Number.isFinite(q) || q <= 0 || q >= 1) {
    throw new Error('FDR q must be explicitly pre-registered between 0 and 1.')
  }
  const byDate = new Map<string, number[]>()
  samples.forEach((s, i) => {
    const a = byDate.get(s.asOf) ?? []
    a.push(i)
    byDate.set(s.asOf, a)
  })
  const datedGroups = [...byDate.entries()].filter(([, group]) => group.length >= 5)
  const dateGroups = datedGroups.map(([, group]) => group)
  const blockLength = measuredOverlapBlockLength(
    datedGroups.map(([date, group]) => ({
      testStartDate: date,
      testLabelEndDate: group.reduce(
        (latest, index) => samples[index].labelEnd20d > latest ? samples[index].labelEnd20d : latest,
        samples[group[0]].labelEnd20d,
      ),
    })),
  )
  const perFeature: FeatureFDRResult['perFeature'] = []
  const pValues: number[] = []
  for (let f = 0; f < featureNames.length; f++) {
    const icSeries: number[] = []
    for (const g of dateGroups) {
      const ic = pearsonCorrelation(
        g.map((i) => samples[i].features[f]),
        g.map((i) => samples[i].forwardReturn20dRel),
      )
      if (Number.isFinite(ic)) icSeries.push(ic)
    }
    const meanIC = icSeries.length ? icSeries.reduce((s, v) => s + v, 0) / icSeries.length : 0
    const pValue = blockBootstrapPValueMeanZero(icSeries, blockLength, iterations)
    perFeature.push({ name: featureNames[f], meanIC, pValue, significant: false })
    pValues.push(pValue)
  }
  const reject = benjaminiHochberg(pValues, q)
  reject.forEach((sig, i) => (perFeature[i].significant = sig))
  return { perFeature, q, significantCount: reject.filter(Boolean).length }
}

/**
 * Per-feature single-signal long/short quintile Sharpe (non-annualized, the
 * mean/std of the per-date top-minus-bottom RAW 20d return). The dispersion of
 * these across the feature zoo estimates the cross-trial Sharpe variance the
 * Deflated Sharpe Ratio needs (Bailey-López de Prado 2014).
 */
export function singleFeatureSharpes(
  samples: HistoricalSample[],
  featureNames: string[],
): number[] {
  const byDate = new Map<string, number[]>()
  samples.forEach((s, i) => {
    const a = byDate.get(s.asOf) ?? []
    a.push(i)
    byDate.set(s.asOf, a)
  })
  const dateGroups = [...byDate.values()].filter((g) => g.length >= 10)
  const out: number[] = []
  for (let f = 0; f < featureNames.length; f++) {
    const dateReturns: number[] = []
    for (const g of dateGroups) {
      const sorted = [...g].sort((a, b) => samples[a].features[f] - samples[b].features[f])
      const qn = Math.max(1, Math.floor(sorted.length / 5))
      const mean = (idxs: number[]) =>
        idxs.reduce((s, i) => s + samples[i].forwardReturn20d, 0) / idxs.length
      dateReturns.push(mean(sorted.slice(sorted.length - qn)) - mean(sorted.slice(0, qn)))
    }
    if (dateReturns.length >= 5) {
      const m = dateReturns.reduce((s, v) => s + v, 0) / dateReturns.length
      const sd = Math.sqrt(dateReturns.reduce((s, v) => s + (v - m) ** 2, 0) / dateReturns.length)
      out.push(sd > 0 ? m / sd : 0)
    }
  }
  return out
}

export type CalibrationSizingAudit = {
  baseRate: number
  brierCalibrated: number
  brierBaseRate: number
  reliability: Array<{ binMeanProb: number; winRate: number; n: number }>
  equalWeightSharpe: number
  convictionWeightedSharpe: number
  equalWeightMeanPct: number
  convictionWeightedMeanPct: number
  evalN: number
}

/**
 * Offline CALIBRATION + SIZING audit from the per-test-sample (prediction,
 * realized-relative-return) pairs the walk-forward already captures.
 *  (a) Calibration: isotonic-fit prediction → P(outperform) on the first 60%
 *      of OOS dates, then score Brier on the last 40% vs a base-rate
 *      forecaster (held-out, so no in-sample optimism) + a reliability table.
 *  (b) Sizing A/B: per date, equal-weight quintile L/S vs conviction-weighted
 *      (weight ∝ cross-sectionally demeaned prediction, dollar-neutral, matched
 *      gross), compared by annualized Sharpe — does sizing by the model's own
 *      magnitude beat the crude quintile cut? (The target-transform tests
 *      implied the magnitude is informative; this measures it for sizing.)
 */
export function calibrationAndSizingAudit(
  steps: Array<{ testDetails?: Array<{ asOf: string; prediction: number; actual: number }> }>,
  horizonDays = 20,
): CalibrationSizingAudit | null {
  const details = steps.flatMap((s) => s.testDetails ?? [])
  if (details.length < 500) return null
  // (a) calibration — fit on early 60% of dates, score on late 40%
  const dates = [...new Set(details.map((d) => d.asOf))].sort()
  const splitDate = dates[Math.floor(dates.length * 0.6)]
  const fit = details.filter((d) => d.asOf < splitDate)
  const ev = details.filter((d) => d.asOf >= splitDate)
  const calFit = isotonicRegression(
    fit.map((d) => d.prediction),
    fit.map((d) => (d.actual > 0 ? 1 : 0)),
  )
  const baseRate = fit.length ? fit.filter((d) => d.actual > 0).length / fit.length : 0.5
  const evProbs = ev.map((d) => applyIsotonic(calFit, d.prediction))
  const evOut = ev.map((d) => (d.actual > 0 ? 1 : 0))
  const brierCalibrated = brierScore(evProbs, evOut)
  const brierBaseRate = brierScore(
    ev.map(() => baseRate),
    evOut,
  )
  const reliability: CalibrationSizingAudit['reliability'] = []
  const idxByProb = ev.map((_, i) => i).sort((a, b) => evProbs[a] - evProbs[b])
  const bins = 5
  for (let b = 0; b < bins; b++) {
    const slice = idxByProb.slice(
      Math.floor((b * idxByProb.length) / bins),
      Math.floor(((b + 1) * idxByProb.length) / bins),
    )
    if (slice.length === 0) continue
    reliability.push({
      binMeanProb: slice.reduce((s, i) => s + evProbs[i], 0) / slice.length,
      winRate: slice.reduce((s, i) => s + evOut[i], 0) / slice.length,
      n: slice.length,
    })
  }
  // (b) sizing A/B over all OOS dates
  const byDate = new Map<string, Array<{ prediction: number; actual: number }>>()
  for (const d of details) {
    const a = byDate.get(d.asOf) ?? []
    a.push(d)
    byDate.set(d.asOf, a)
  }
  const ewRets: number[] = []
  const cwRets: number[] = []
  for (const rows of byDate.values()) {
    const n = rows.length
    if (n < 10) continue
    const sorted = [...rows].sort((a, b) => a.prediction - b.prediction)
    const qn = Math.max(1, Math.floor(n / 5))
    const meanA = (arr: typeof rows) => arr.reduce((s, r) => s + r.actual, 0) / arr.length
    ewRets.push(meanA(sorted.slice(n - qn)) - meanA(sorted.slice(0, qn)))
    const meanPred = rows.reduce((s, r) => s + r.prediction, 0) / n
    let posSum = 0
    let negSum = 0
    const w = rows.map((r) => {
      const x = r.prediction - meanPred
      if (x > 0) posSum += x
      else negSum += -x
      return x
    })
    let cw = 0
    for (let i = 0; i < n; i++) {
      const norm =
        w[i] > 0 ? (posSum > 0 ? w[i] / posSum : 0) : negSum > 0 ? w[i] / negSum : 0
      cw += norm * rows[i].actual
    }
    cwRets.push(cw)
  }
  const sharpe = (xs: number[]) => {
    if (xs.length < 2) return 0
    const m = xs.reduce((s, v) => s + v, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length)
    return sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR / horizonDays) : 0
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
  return {
    baseRate,
    brierCalibrated,
    brierBaseRate,
    reliability,
    equalWeightSharpe: sharpe(ewRets),
    convictionWeightedSharpe: sharpe(cwRets),
    equalWeightMeanPct: mean(ewRets),
    convictionWeightedMeanPct: mean(cwRets),
    evalN: ev.length,
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
  rule: WindowRule,
  horizonDays: number,
  tradingDates: readonly string[] | undefined,
): { numTrees: number; depth: number; learningRate: number } {
  const grid: Array<{ numTrees: number; depth: number; learningRate: number }> = [
    { numTrees: 30, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.05 },
    { numTrees: 50, depth: 3, learningRate: 0.10 },
    { numTrees: 50, depth: 4, learningRate: 0.05 },
    { numTrees: 80, depth: 3, learningRate: 0.05 },
    { numTrees: 80, depth: 4, learningRate: 0.05 },
  ]
  // Use only the first ~70% of the rows for inner CV (so we don't peek at
  // the outer test windows during hyperparameter selection). The inner
  // windows are cut on the same calendar with the same rule; only the
  // burn-in is scaled by that same 0.7, as the old row-count version scaled
  // its inner training start, so a shorter history still leaves inner
  // windows to score.
  const innerScope = sortedSamples.slice(0, Math.floor(sortedSamples.length * 0.7))
  // Just take the first 3 inner windows to keep this fast.
  const innerWindows = buildCalendarWindows(innerScope, {
    ...rule,
    burnInYears: rule.burnInYears * 0.7,
    tradingDates,
  }).slice(0, 3)
  if (innerWindows.length === 0) {
    return grid[2]  // default fallback
  }
  let bestParams = grid[2]
  let bestMeanIc = -Infinity
  for (const params of grid) {
    let total = 0
    let count = 0
    for (const window of innerWindows) {
      const result = walkForwardStep(innerScope, window, {
        horizonDays,
        modelOptions: params,
        computeIntervals: false,  // hyperparameter scoring needs IC only
        computeAlternatives: false,  // no ridge or blend inside the search
      })
      if (result) {
        total += result.informationCoefficient
        count++
      }
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

/**
 * The tree settings every pre-registered run uses: the values in the saved
 * artifact (tools/ml_trained_model.json, `hyperparameters`) and in the
 * pre-registered stopping rule (docs/EVIDENCE_QUALITY.md, section 1). They
 * are frozen because the nested search that used to pick them scores six
 * settings on only three inner windows and flipped to 80 trees / depth 4 /
 * rate 0.05 on the 500-name run (tools/backtest-1000-derisk-500.log:61); a
 * choice that moves that much on that little data is not stable enough to
 * pre-register.
 */
export const FROZEN_HYPERPARAMETERS: Readonly<{ numTrees: number; depth: number; learningRate: number }> =
  Object.freeze({ numTrees: 50, depth: 3, learningRate: 0.1 })

export function runWalkForwardBacktest(
  samples: HistoricalSample[],
  options: {
    /** Window rule; whatever is left out comes from DEFAULT_WINDOW_RULE.
     * The CLI's --window-days and --burn-in-years flags land here. */
    stepTradingDays?: number
    burnInYears?: number
    embargoTradingDays?: number
    /** Every trading day the dataset builder saw
     * (DatasetBuildResult.tradingDates). Pass it: without it the windows
     * are cut on sample dates, which are one trading day in ten. */
    tradingDates?: readonly string[]
    horizonDays?: number
    txCostBps?: number
    modelOptions?: { numTrees?: number; depth?: number; learningRate?: number }
    /** When true (the default), the tree settings are FROZEN_HYPERPARAMETERS
     * and the nested search never runs, which is what the pre-registered
     * run requires (docs/EVIDENCE_QUALITY.md, section 1). Pass false to let
     * the nested search choose them again; it stays available behind this
     * flag. Explicit modelOptions win over both. */
    freezeHyperparameters?: boolean
    /** Only read when freezeHyperparameters is false: false skips the
     * nested search and uses FROZEN_HYPERPARAMETERS. */
    nestedHyperparameterSearch?: boolean
    /** See walkForwardStep — pass featureNames.indexOf('momentum_252d'). */
    baselineMomentumFeatureIndex?: number
    /** Momentum definition the gate reads, and the one the blend is built
     * on. Default DEFAULT_GATE_MOMENTUM_BASELINE ('12-1'). Both definitions
     * are always reported. */
    momentumBaseline?: MomentumBaselineDefinition
    /** Correlation the gate reads. Default DEFAULT_GATE_CORRELATION
     * ('pearson'). Both are always reported. */
    correlation?: CorrelationKind
    /** See walkForwardStep.captureTestDetails. */
    captureTestDetails?: boolean
  } = {},
): FullBacktestResult | null {
  const sorted = indexSamples(samples)
  const rule = resolveWindowRule({
    stepTradingDays: options.stepTradingDays,
    burnInYears: options.burnInYears,
    embargoTradingDays: options.embargoTradingDays,
  })
  // The two single-split diagnostics further down (heldOutHorizonMetrics,
  // servingConsistentIC) still read this number as calendar days; they are
  // separate splits, not walk-forward windows, and were left as they were.
  const embargoDays = rule.embargoTradingDays
  const horizonDays = options.horizonDays ?? 20
  const txCostBps = options.txCostBps ?? 10

  // Test windows are a property of the trading calendar, not of the row
  // count: the same rule gives the same windows however wide the universe.
  const windows = buildCalendarWindows(sorted, { ...rule, tradingDates: options.tradingDates })
  if (windows.length === 0) return null

  // Hyperparameters: frozen by default at the pre-registered values. The
  // nested search (training-side data only) runs only when the caller
  // unfreezes them, and explicit modelOptions always win.
  const momentumBaseline = options.momentumBaseline ?? DEFAULT_GATE_MOMENTUM_BASELINE
  const correlation = options.correlation ?? DEFAULT_GATE_CORRELATION
  let chosenParams: { numTrees?: number; depth?: number; learningRate?: number }
  let hyperparameterSelection: FullBacktestResult['hyperparameterSelection']
  if (options.modelOptions) {
    chosenParams = options.modelOptions
    hyperparameterSelection = 'caller-supplied'
  } else if (options.freezeHyperparameters !== false || options.nestedHyperparameterSearch === false) {
    chosenParams = { ...FROZEN_HYPERPARAMETERS }
    hyperparameterSelection = 'frozen'
  } else {
    chosenParams = nestedCvHyperparameterSearch(sorted, rule, horizonDays, options.tradingDates)
    hyperparameterSelection = 'nested-search'
  }

  const steps: WalkForwardResult[] = []
  for (const window of windows) {
    const result = walkForwardStep(sorted, window, {
      horizonDays,
      txCostBps,
      modelOptions: chosenParams,
      baselineMomentumFeatureIndex: options.baselineMomentumFeatureIndex,
      momentumBaseline,
      correlation,
      captureTestDetails: options.captureTestDetails,
    })
    if (result) steps.push(result)
  }
  if (steps.length === 0) return null
  const windowSummary = summarizeCalendarWindows(sorted, windows, rule, steps.length)

  // Final ensemble: per-horizon median + p10 + p90 models.
  // Median trains on ALL samples (best point estimate). Quantile models
  // train on the older 85% with the newest 15% held out as the conformal
  // calibration slice (split-conformal needs calibration data the
  // quantile models never saw — Romano et al. 2019), purged by the
  // horizon so calibration labels don't overlap quantile training.
  const allFeatures = sorted.map((sample) => sample.features)
  // RELATIVE targets for the shipped median/quantile ensemble — the
  // models predict idiosyncratic outperformance, not raw return.
  const targetForHorizon = (sample: HistoricalSample, horizon: HorizonKey): number => {
    if (horizon === 5) return sample.forwardReturn5dRel
    if (horizon === 20) return sample.forwardReturn20dRel
    if (horizon === 60) return sample.forwardReturn60dRel
    return sample.forwardReturn120dRel
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

    // This horizon's IC + hit rate from a genuine OUT-OF-FOLD split (was
    // an in-sample correlation of the all-data model against its own
    // training targets — upward-biased and previously shown to the user
    // as the horizon's skill). The shipped medianModel still trains on
    // ALL samples for the best live point estimate; only the REPORTED
    // metric is now honest.
    const oof = heldOutHorizonMetrics(sorted, horizon, chosenParams, embargoDays)
    return {
      horizon,
      medianModel,
      p10Model,
      p90Model,
      meanIC: oof.ic,
      meanHitRate: oof.hitRate,
      icCI: { lower: oof.ic, mean: oof.ic, upper: oof.ic },
      conformalOffsetPct,
      conformalCalibrationSize: calibration.length,
    }
  })
  // Live-applicable IC measured under serving's global normalization.
  const servingIC = servingConsistentIC(sorted, chosenParams, embargoDays)
  // Serve the SQUARED-LOSS (conditional-MEAN) 20d model — the SAME
  // estimator the walk-forward validated (walkForwardStep fits mean
  // models, no quantile), so the served point forecast matches the
  // reported meanIC. The 20d MEDIAN is no longer the served point
  // estimate; the median + p10/p90 quantile models are kept only for the
  // prediction interval. (Was: trainedModel = the q=0.5 median model,
  // whose OOS IC was never the measured number.)
  const trainedModel = fitGradientBoosting(
    allFeatures,
    sorted.map((sample) => sample.forwardReturn20dRel), // RELATIVE target
    chosenParams,
  )
  // The BAGGED ensemble is what the walk-forward now measures per fold, so
  // it is also what ships as the live scorer (serving prefers bag20 when
  // present; trainedModel stays as the single-model fallback for older
  // app versions reading only `model`). Fixed seed => reproducible members.
  const bag20 = fitBaggedGradientBoosting(
    allFeatures,
    sorted.map((sample) => sample.forwardReturn20dRel),
    { ...chosenParams, bags: 5, sampleFraction: 0.8, seed: 20260707 },
  )

  const mean = (key: keyof WalkForwardResult): number =>
    steps.reduce((sum, step) => sum + (step[key] as number), 0) / steps.length
  // For the optional per-window numbers: the mean over the windows that
  // carry a finite value, NaN when none does.
  const meanFinite = (key: keyof WalkForwardResult): number => {
    const values = steps
      .map((step) => step[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.length === 0
      ? Number.NaN
      : values.reduce((sum, value) => sum + value, 0) / values.length
  }

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

  // PORTFOLIO Sharpe from the TIME SERIES of per-step net L/S returns —
  // mean / std of the return series, annualized. The previous per-step
  // longShortSharpe divided ONE window's spread by that window's CROSS-
  // SECTIONAL return dispersion, which is not a Sharpe at all; averaging
  // those was meaningless. This is the real thing.
  const stepNetReturns = steps.map((step) => step.longShortReturnNet)
  const meanOfArr = (s: number[]): number =>
    s.length === 0 ? 0 : s.reduce((a, b) => a + b, 0) / s.length
  const sharpeOf = (s: number[]): number => {
    if (s.length < 2) return 0
    const m = meanOfArr(s)
    const sd = Math.sqrt(s.reduce((a, v) => a + (v - m) ** 2, 0) / s.length)
    return sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR / horizonDays) : 0
  }
  const portfolioSharpe = sharpeOf(stepNetReturns)

  // 95% CIs via MOVING-BLOCK bootstrap (steps are serially dependent —
  // overlapping label windows). i.i.d. bootstrap here would report a
  // spuriously tight interval. The block length is measured from the exact
  // test/label dates rather than selected by a hand-tuned constant.
  const evidenceBlockLength = measuredOverlapBlockLength(steps)
  const icCI = blockBootstrapStat(steps.map((step) => step.informationCoefficient), meanOfArr, evidenceBlockLength)
  const hitRateCI = blockBootstrapStat(steps.map((step) => step.hitRate), meanOfArr, evidenceBlockLength)
  const longShortReturnNetCI = blockBootstrapStat(stepNetReturns, meanOfArr, evidenceBlockLength)
  const longShortSharpeCI = blockBootstrapStat(stepNetReturns, sharpeOf, evidenceBlockLength)
  const coverageSteps = steps.filter((step) => step.intervalCoverage80 != null)
  const intervalCoverage80CI =
    coverageSteps.length > 0
      ? blockBootstrapStat(
          coverageSteps.map((step) => step.intervalCoverage80!),
          meanOfArr,
          measuredOverlapBlockLength(coverageSteps),
        )
      : undefined
  const intervalMeanWidthPct =
    coverageSteps.length > 0
      ? coverageSteps.reduce((sum, step) => sum + (step.intervalMeanWidthPct ?? 0), 0) /
        coverageSteps.length
      : undefined
  const baselineEvidence = computeBaselineEvidence(steps, 1000, { momentumBaseline, correlation })

  return {
    steps,
    meanIC: mean('informationCoefficient'),
    meanSpearmanIC: mean('spearmanIc'),
    meanHitRate: mean('hitRate'),
    meanLongShortReturnGross: mean('longShortReturnGross'),
    meanLongShortReturnNet: mean('longShortReturnNet'),
    meanLongShortSharpe: portfolioSharpe,
    meanBaselineRandomIc: mean('baselineRandomIc'),
    meanBaselineMomentumIc: mean('baselineMomentumIc'),
    meanBaselineMomentum12to1Ic: meanFinite('baselineMomentum12to1Ic'),
    meanRidgeIc: meanFinite('ridgeIc'),
    meanBlendIc: meanFinite('blendIc'),
    gateMomentumBaseline: momentumBaseline,
    gateCorrelation: correlation,
    baselineEvidence,
    cumulativeReturn: runningCumReturn,
    maxDrawdown: maxDD,
    meanFeatureImportance,
    totalSamples: sorted.length,
    trainedModel,
    bag20,
    horizonBundles,
    embargoDaysUsed: embargoDays,
    txCostBpsUsed: txCostBps,
    windowSummary,
    meanRealizedCostBps: mean('realizedCostBps'),
    icCI,
    hitRateCI,
    longShortReturnNetCI,
    longShortSharpeCI,
    intervalCoverage80CI,
    intervalMeanWidthPct,
    servingConsistentIC20d: servingIC,
    hyperparameters: {
      numTrees: chosenParams.numTrees ?? FROZEN_HYPERPARAMETERS.numTrees,
      depth: chosenParams.depth ?? FROZEN_HYPERPARAMETERS.depth,
      learningRate: chosenParams.learningRate ?? FROZEN_HYPERPARAMETERS.learningRate,
    },
    hyperparameterSelection,
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
 * FDR-CONTROLLED keeper set (replaces the prior eyeballed "+0.001 mean
 * permutation importance" cut). Each candidate's per-date cross-sectional IC
 * vs the 20d RELATIVE return is tested against a moving-block-bootstrap null
 * (respecting the overlapping-label serial dependence), and the 13 survivors
 * below clear Benjamini-Hochberg FDR at q=0.10 over all 45 candidates on the
 * 224-name / 15y / 70-window run (2026-06-20). Built by featureSelectionFDR.
 *
 * Why this changed: the old importance cut KEPT 6 features that FAIL a proper
 * multiple-testing test (price_to_high_60d, fund_revenue_accel, kurt_252d,
 * sma_50_distance, fund_margin_trend, vol_change_60_20) and DROPPED 8 that
 * PASS — including momentum_252d and the short-window vols. Deflating the
 * Sharpe for that 45-feature search (Bailey-López de Prado 2014) gave DSR≈58%
 * (the old edge was partly the lucky winner of the search); a pre-registered
 * FDR set removes the free search, so the relevant deflation is just the
 * 6-config hyperparameter grid (DSR≈95%).
 *
 * The survivors are mostly the classic, most-replicated cross-sectional
 * factors: size (Banz 1981), illiquidity (Amihud 2002), momentum
 * (Jegadeesh-Titman 1993), plus survivorship-visibility (listing age). The
 * volatility columns survive too, but with the OPPOSITE sign to the
 * low-volatility anomaly (Ang-Hodrick-Xing-Zhang 2006); see the note on
 * volatility_252d below. Annotations are the measured mean per-date IC of
 * the feature against the 20-day RELATIVE forward return.
 */
export const PRUNED_FEATURE_NAMES: string[] = [
  // UNCHANGED by the 2026-09-10 company-descriptor work, deliberately. Three
  // new candidates were added to HISTORICAL_FEATURE_NAMES (48 -> 51) and the
  // screen has not been re-run against them yet, so nothing here was
  // hand-picked in or out. One thing to hold on to when it is re-run: a wider
  // candidate list tightens every existing keeper's acceptance threshold on
  // the Benjamini-Hochberg arithmetic alone, so a keeper sitting near the edge
  // - fund_altman_z is annotated below as exactly that - can fail without its
  // own evidence changing at all.
  //
  // Refreshed 2026-07-07 from the 48-feature FDR screen (q=0.1, bagged
  // walk-forward): 13/48 clear control. Two prior keepers FAILED the wider
  // screen and drop (fund_revenue_growth_yoy, last_close_over_sma_20); two
  // of the three new tail-risk candidates earn entry. Annotations are the
  // 2026-07-07 run's measured mean per-date IC.
  // The sign on volatility_252d needs saying plainly. The measured per-date
  // IC is POSITIVE: in this sample, higher trailing volatility went with a
  // HIGHER relative 20-day return. That is the opposite of the low-volatility
  // anomaly (Ang, Hodrick, Xing and Zhang 2006, Journal of Finance 61(1),
  // where high idiosyncratic volatility predicts LOW returns), so the column
  // is kept on the strength of the FDR screen alone, not on that paper's
  // sign. An earlier annotation here put the paper's name on the wrong sign.
  'volatility_252d',             // +0.070  observed: high vol -> higher next-20d relative return
  'volatility_60d',              // +0.068
  'range_compression_20d',       // +0.067
  'downside_vol_60d',            // +0.059  semi-deviation (Ang-Chen-Xing 2006) — NEW
  'volatility_20d',              // +0.055
  'momentum_252d',               // +0.050  Jegadeesh-Titman 1993
  'listing_age_years',           // -0.050  survivorship visibility
  'log_price_level',             // -0.046  CHS 2008
  'fund_log_market_cap',         // -0.045  Banz 1981 size
  'vol_of_vol_60d',              // +0.045  vol-regime instability — NEW
  'price_velocity_acceleration', // -0.043
  'amihud_illiquidity_20d',      // +0.042  Amihud 2002
  'fund_altman_z',               // FDR-significant (smaller |IC|)
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
/** 'unknown' is NOT a regime — it means the SPY history was too short
 * (or failed to load) to label this step. It is reported separately and
 * excluded from the low/high breakdown so a fetch failure can never
 * masquerade as a wall of genuine calm (the bug that collapsed all 70
 * windows to low-vol when the SPY fetch transiently returned []). */
export type RegimeLabelOrUnknown = RegimeLabel | 'unknown'

export type RegimeStepLabel = {
  testStartDate: string
  regime: RegimeLabelOrUnknown
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
      return { testStartDate: step.testStartDate, regime: 'unknown', highProb: 0 }
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
  RegimeLabelOrUnknown,
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
  const buckets: Record<RegimeLabelOrUnknown, WalkForwardResult[]> = {
    'low-vol': [],
    'high-vol': [],
    unknown: [],
  }
  for (const step of steps) {
    const regime = byDate.get(step.testStartDate) ?? 'unknown'
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
    unknown: summarize(buckets.unknown),
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
  /** Registered names that left the market during the window and could not
   * be included at all (EXCLUDED_UNFETCHABLE). The names that remain are
   * more survivor-biased, not less, by at least this share. Present when
   * the caller passes the dataset's attrition record. */
  leftMarket?: UniverseAttrition
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
  /** The dataset's record of registered names that left the market
   * (provenance.universeAttrition); reported alongside the other
   * diagnostics when given. */
  leftMarket?: UniverseAttrition,
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
  const oos = samples.filter(
    (sample) =>
      sample.asOf >= firstTestDate &&
      sample.cohort !== 'noFundamentals' &&
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
    ...(leftMarket ? { leftMarket: { ...leftMarket } } : {}),
  }
}
