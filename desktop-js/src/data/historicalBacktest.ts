import { cachedFetchDailyBars, type DailyBar } from './marketData'
import {
  fitGradientBoosting,
  fitMarkovRegime,
  logReturns,
  predictGradientBoosting,
  pearsonCorrelation,
  type GradientBoostingModel,
} from './quantMath'
import {
  MISSING_CAP_FALLBACK_USD,
  SIZE_TIERED_BORROW_FEE_ANNUAL,
  SIZE_TIERED_TRADING_COST,
  TRADING_DAYS_PER_YEAR,
} from './quantConfig'
import { benjaminiHochberg } from './selectionStats'
import { isotonicRegression, applyIsotonic, brierScore } from './calibration'

export type { DailyBar }

/** One-way effective trading cost (bps) for a name of the given market
 * cap, per the size-tiered table (Frazzini-Israel-Moskowitz 2018;
 * Novy-Marx-Velikov 2016). NaN/missing cap → liquid large-cap fallback. */
function oneWayCostBps(marketCapUsd: number): number {
  const cap = Number.isFinite(marketCapUsd) ? marketCapUsd : MISSING_CAP_FALLBACK_USD
  for (const tier of SIZE_TIERED_TRADING_COST) {
    if (cap >= tier.minMarketCapUsd) return tier.oneWayBps
  }
  return SIZE_TIERED_TRADING_COST[SIZE_TIERED_TRADING_COST.length - 1].oneWayBps
}

/** Annualized stock-borrow fee (bps) for the SHORT leg by size tier
 * (D'Avolio 2002; Drechsler-Drechsler 2014). */
function borrowFeeAnnualBps(marketCapUsd: number): number {
  const cap = Number.isFinite(marketCapUsd) ? marketCapUsd : MISSING_CAP_FALLBACK_USD
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
      })
      generated++
    }
    tickersWithUsableBars++
    perTickerSummary.push({ ticker, bars: bars.length, samplesGenerated: generated })
  }

  // Impute missing fundamentals with per-date cross-sectional medians
  // (must run BEFORE normalization so NaNs never reach the Z-scores),
  // then tag survivorship cohorts, then normalize, then demean the
  // forward-return targets cross-sectionally (relative-alpha target).
  imputeMissingWithDateMedians(samples)
  assignSurvivorshipCohorts(samples)
  applyCrossSectionalNormalization(samples)
  applyCrossSectionalReturnDemeaning(samples)
  // NOTE (2026-06-21): target transforms were tested and REVERTED. Both
  // ±3-MAD winsorization AND Gaussian rank-transform of the Rel target HURT on
  // the curated 224 (fair Spearman IC 0.058 -> 0.048 / 0.044; Sharpe 1.54 ->
  // 1.37 / 1.11; DSR@N=6 97% -> 94% / 79%). The raw relative-return MAGNITUDE
  // carries ranking signal (the model scales confidence by expected move), so
  // the pointwise squared loss on the raw demeaned target already ranks well.
  // Keep the raw target; do not winsorize or rank-transform it.

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
  informationCoefficient: number
  spearmanIc: number
  hitRate: number
  longShortReturnGross: number
  longShortReturnNet: number   // net of size-tiered trading + borrow costs
  /** Total cost (bps) actually subtracted this step: long entry + short
   * entry + short borrow, size-tiered by constituent market cap. */
  realizedCostBps: number
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
  // txCostBps is retained on the options for API/back-compat but no longer
  // sets the cost — costs are size-tiered per constituent (see below).

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
  // TRAIN on RELATIVE (cross-sectionally demeaned) return — the model
  // learns idiosyncratic alpha, not the unpredictable market move.
  const trainTargets = trainSamples.map((sample) => sample.forwardReturn20dRel)
  const model = fitGradientBoosting(trainFeatures, trainTargets, options.modelOptions ?? {})

  const predictions = testSamples.map((sample) => predictGradientBoosting(model, sample.features))
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
  const indexed = predictions.map((value, idx) => ({
    pred: value,
    actual: testSamples[idx].forwardReturn20d, // RAW — the return earned
    marketCapUsd: Math.exp(testSamples[idx].logMarketCap),  // NaN-safe: exp(NaN)=NaN
  }))
  indexed.sort((left, right) => right.pred - left.pred)
  const quintileSize = Math.max(1, Math.floor(indexed.length / 5))
  const topQ = indexed.slice(0, quintileSize)
  const bottomQ = indexed.slice(-quintileSize)
  const topMean = topQ.reduce((sum, item) => sum + item.actual, 0) / topQ.length
  const bottomMean = bottomQ.reduce((sum, item) => sum + item.actual, 0) / bottomQ.length
  const longShortReturnGross = topMean - bottomMean
  // SIZE-TIERED COSTS (replaces the flat 2×10bps). Each leg pays a one-way
  // entry cost set by its constituents' market caps; the SHORT leg also
  // pays a stock-borrow fee pro-rated over the holding horizon. A flat
  // rate understated costs for any small-cap tilt — see quantConfig
  // SIZE_TIERED_TRADING_COST / SIZE_TIERED_BORROW_FEE_ANNUAL for sources.
  const longEntryBps = meanOf(topQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const shortEntryBps = meanOf(bottomQ.map((item) => oneWayCostBps(item.marketCapUsd)))
  const shortBorrowBps = meanOf(
    bottomQ.map(
      (item) => borrowFeeAnnualBps(item.marketCapUsd) * (horizonDays / TRADING_DAYS_PER_YEAR),
    ),
  )
  const realizedCostBps = longEntryBps + shortEntryBps + shortBorrowBps
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

  // BASELINE: random predictions
  const randomPredictions = predictions.map(() => Math.random())
  const baselineRandomIc = pearsonCorrelation(randomPredictions, actuals)

  // BASELINE: long-horizon momentum ranking (Jegadeesh-Titman). NaN when
  // the momentum feature isn't in the (possibly pruned) set — better an
  // honest "n/a" than silently scoring whatever sits in column 0, which
  // would mislabel an unrelated feature's IC as the momentum baseline.
  const momentumIndex = options.baselineMomentumFeatureIndex ?? 2
  const featureWidth = testSamples[0]?.features.length ?? 0
  const baselineMomentumIc =
    momentumIndex >= 0 && momentumIndex < featureWidth
      ? pearsonCorrelation(
          testSamples.map((sample) => sample.features[momentumIndex]),
          actuals,
        )
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
    realizedCostBps,
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
  blockLen = 3,
  iterations = 1000,
): ConfidenceInterval {
  const n = values.length
  if (n === 0) return { lower: 0, mean: 0, upper: 0 }
  const point = statistic(values)
  if (n <= blockLen) return { lower: point, mean: point, upper: point }
  const stats: number[] = []
  for (let it = 0; it < iterations; it++) {
    const resample: number[] = []
    while (resample.length < n) {
      const start = Math.floor(Math.random() * (n - blockLen + 1))
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
function blockBootstrapPValueMeanZero(values: number[], blockLen = 3, iterations = 1000): number {
  const n = values.length
  if (n < 3) return 1
  const obsMean = values.reduce((s, v) => s + v, 0) / n
  const centered = values.map((v) => v - obsMean) // impose the null
  const eff = Math.min(blockLen, n)
  let extreme = 0
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    let count = 0
    while (count < n) {
      const start = Math.floor(Math.random() * (n - eff + 1))
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
  q = 0.1,
  iterations = 2000,
): FeatureFDRResult {
  const byDate = new Map<string, number[]>()
  samples.forEach((s, i) => {
    const a = byDate.get(s.asOf) ?? []
    a.push(i)
    byDate.set(s.asOf, a)
  })
  const dateGroups = [...byDate.values()].filter((g) => g.length >= 5)
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
    const pValue = blockBootstrapPValueMeanZero(icSeries, 3, iterations)
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
  // spuriously tight interval.
  const icCI = blockBootstrapStat(steps.map((step) => step.informationCoefficient), meanOfArr)
  const hitRateCI = blockBootstrapStat(steps.map((step) => step.hitRate), meanOfArr)
  const longShortReturnNetCI = blockBootstrapStat(stepNetReturns, meanOfArr)
  const longShortSharpeCI = blockBootstrapStat(stepNetReturns, sharpeOf)
  const coverageSteps = steps.filter((step) => step.intervalCoverage80 != null)
  const intervalCoverage80CI =
    coverageSteps.length > 0
      ? blockBootstrapStat(coverageSteps.map((step) => step.intervalCoverage80!), meanOfArr)
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
    meanLongShortSharpe: portfolioSharpe,
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
    meanRealizedCostBps: mean('realizedCostBps'),
    icCI,
    hitRateCI,
    longShortReturnNetCI,
    longShortSharpeCI,
    intervalCoverage80CI,
    intervalMeanWidthPct,
    servingConsistentIC20d: servingIC,
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
 * The survivors are the classic, most-replicated cross-sectional factors:
 * low-volatility (Ang-Hodrick-Xing-Zhang 2006), size (Banz 1981), illiquidity
 * (Amihud 2002), momentum (Jegadeesh-Titman 1993), plus survivorship-
 * visibility (listing age). Annotations are the measured mean per-date IC.
 */
export const PRUNED_FEATURE_NAMES: string[] = [
  'volatility_252d',             // +0.074  low-vol (Ang et al. 2006)
  'volatility_60d',              // +0.072
  'range_compression_20d',       // +0.069
  'volatility_20d',              // +0.058
  'listing_age_years',           // -0.053  survivorship visibility
  'momentum_252d',               // +0.050  Jegadeesh-Titman 1993
  'fund_log_market_cap',         // -0.046  Banz 1981 size
  'log_price_level',             // -0.046  CHS 2008
  'price_velocity_acceleration', // -0.046
  'amihud_illiquidity_20d',      // +0.043  Amihud 2002
  'fund_revenue_growth_yoy',     // +0.039
  'last_close_over_sma_20',      // -0.035
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
