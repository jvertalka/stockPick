/// Template for `local_secrets.dart`. Copy this file to `local_secrets.dart`
/// (which is gitignored) and fill in your keys. Do NOT commit your real keys.
library;

/// Alpha Vantage API key. https://www.alphavantage.co/support/#api-key
const String kAlphaVantageApiKey = '';

/// Finnhub API key (optional, 60/min free). https://finnhub.io/register
const String kFinnhubApiKey = '';

/// FRED API key (optional). https://fredaccount.stlouisfed.org/apikey
const String kFredApiKey = '';

/// Optional CORS proxy for providers that don't send browser CORS headers
/// (Yahoo Finance, Stooq). Example: 'https://corsproxy.io/?'.
/// Leave empty to disable those providers in Chrome.
const String kCorsProxyPrefix = '';

/// Stocks to track. S&P 100 is a good starter universe.
const List<String> kSymbolUniverse = <String>[
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
  // ...
];

const String kBenchmarkSymbol = 'SPY';

const int kAlphaVantageDailyRequestLimit = 25;
const int kStockUniverseLimit = 100;
const int kHistoricalSnapshotLimit = 500;
