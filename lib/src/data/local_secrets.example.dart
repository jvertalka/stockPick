/// Template for `local_secrets.dart`. Copy this file to `local_secrets.dart`
/// (which is gitignored) and fill in your keys. Do NOT commit your real keys.
library;

/// Alpha Vantage API key. https://www.alphavantage.co/support/#api-key
const String kAlphaVantageApiKey = '';

/// Finnhub API key (optional, 60/min free). https://finnhub.io/register
const String kFinnhubApiKey = '';

/// FRED API key (optional). https://fredaccount.stlouisfed.org/apikey
const String kFredApiKey = '';

/// Tradier options token (optional). https://developer.tradier.com
/// Powers real implied-vol / skew in the options card; empty = price-derived
/// proxies. Injected server-side by the backend proxy — never ships to the
/// browser bundle. You can also set the TRADIER_TOKEN environment variable.
const String kTradierToken = '';

/// Which Tradier environment the token above belongs to: 'sandbox' or
/// 'production'. Override with the TRADIER_ENV environment variable.
const String kTradierEnv = 'sandbox';

/// Polygon.io options token (optional). https://polygon.io
/// Also settable via the POLYGON_TOKEN environment variable.
const String kPolygonToken = '';

/// Optional CORS proxy/cache for providers that don't send browser CORS headers
/// (Yahoo Finance, Stooq, SEC EDGAR in Flutter web).
///
/// Recommended local cache:
/// 'http://127.0.0.1:8787/proxy?url='
///
/// You can also override this at build time:
/// --dart-define=ORACLE_CORS_PROXY_PREFIX=http://127.0.0.1:8787/proxy?url=
const String kCorsProxyPrefix = 'http://127.0.0.1:8787/proxy?url=';

/// Optional tickers to add on top of the tracked default universe in
/// `default_symbol_universe.dart`. Keep this short and personal: holdings,
/// watchlist names, or niche ETFs you care about.
const List<String> kSymbolUniverse = <String>[
  // 'AAPL', 'MSFT', 'NVDA', 'SPY',
];

const String kBenchmarkSymbol = 'SPY';

const int kAlphaVantageDailyRequestLimit = 25;
const int kStockUniverseLimit = 900;
const int kHistoricalSnapshotLimit = 500;
