import 'local_secrets.dart' as local;

enum MarketDataMode { fixtureOnly, livePreferred, liveRequired, alphaVantage }

extension MarketDataModeLabel on MarketDataMode {
  String get label => switch (this) {
    MarketDataMode.fixtureOnly => 'Fixture only',
    MarketDataMode.livePreferred => 'Live preferred',
    MarketDataMode.liveRequired => 'Live required',
    MarketDataMode.alphaVantage => 'Alpha Vantage',
  };
}

class MarketDataConfiguration {
  const MarketDataConfiguration({
    required this.mode,
    this.baseUrl,
    this.apiToken,
    this.alphaVantageApiKey,
    this.alphaVantageProxyUrl,
    this.alphaVantageSymbols = const [],
    this.alphaVantageBenchmarkSymbol = 'SPY',
    this.finnhubApiKey,
    this.fredApiKey,
    this.alphaVantageDailyRequestLimit = 25,
    this.alphaVantageSyncIntervalMinutes = 20,
    this.stockUniverseLimit = 40,
    this.historicalSnapshotLimit = 240,
  });

  final MarketDataMode mode;
  final String? baseUrl;
  final String? apiToken;
  final String? alphaVantageApiKey;
  final String? alphaVantageProxyUrl;
  final List<String> alphaVantageSymbols;
  final String alphaVantageBenchmarkSymbol;
  final String? finnhubApiKey;
  final String? fredApiKey;
  final int alphaVantageDailyRequestLimit;
  final int alphaVantageSyncIntervalMinutes;
  final int stockUniverseLimit;
  final int historicalSnapshotLimit;

  bool get hasBaseUrl => baseUrl != null && baseUrl!.trim().isNotEmpty;

  factory MarketDataConfiguration.fromEnvironment() {
    const modeValue = String.fromEnvironment(
      'ORACLE_DATA_MODE',
      defaultValue: '',
    );
    const baseUrlValue = String.fromEnvironment(
      'ORACLE_DATA_BASE_URL',
      defaultValue: '',
    );
    const apiTokenValue = String.fromEnvironment(
      'ORACLE_DATA_API_TOKEN',
      defaultValue: '',
    );
    const alphaVantageApiKeyEnv = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_API_KEY',
      defaultValue: '',
    );
    const alphaVantageProxyUrlValue = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_PROXY_URL',
      defaultValue: '',
    );
    const alphaVantageSymbolsEnv = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_SYMBOLS',
      defaultValue: '',
    );
    const alphaVantageBenchmarkSymbolValue = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_BENCHMARK',
      defaultValue: '',
    );
    const finnhubApiKeyValue = String.fromEnvironment(
      'ORACLE_FINNHUB_API_KEY',
      defaultValue: '',
    );
    const fredApiKeyValue = String.fromEnvironment(
      'ORACLE_FRED_API_KEY',
      defaultValue: '',
    );
    const alphaVantageDailyRequestLimitValue = int.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_DAILY_LIMIT',
      defaultValue: 0,
    );
    const alphaVantageSyncIntervalMinutesValue = int.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_SYNC_INTERVAL_MINUTES',
      defaultValue: 20,
    );
    const stockUniverseLimitValue = int.fromEnvironment(
      'ORACLE_STOCK_UNIVERSE_LIMIT',
      defaultValue: 0,
    );
    const historicalSnapshotLimitValue = int.fromEnvironment(
      'ORACLE_HISTORICAL_SNAPSHOT_LIMIT',
      defaultValue: 0,
    );

    // Prefer --dart-define values; fall back to lib/src/data/local_secrets.dart.
    final envKey =
        _normalizeOptionalValue(alphaVantageApiKeyEnv) ??
        _normalizeOptionalValue(apiTokenValue);
    final resolvedKey =
        envKey ?? _normalizeOptionalValue(local.kAlphaVantageApiKey);
    final resolvedSymbols = alphaVantageSymbolsEnv.trim().isEmpty
        ? local.kSymbolUniverse
        : _parseSymbolList(alphaVantageSymbolsEnv);
    final resolvedBenchmark =
        _normalizeTicker(alphaVantageBenchmarkSymbolValue) ??
        _normalizeTicker(local.kBenchmarkSymbol) ??
        'SPY';
    final resolvedDailyLimit = alphaVantageDailyRequestLimitValue > 0
        ? alphaVantageDailyRequestLimitValue
        : (local.kAlphaVantageDailyRequestLimit > 0
              ? local.kAlphaVantageDailyRequestLimit
              : 25);
    final resolvedUniverseLimit = stockUniverseLimitValue > 0
        ? stockUniverseLimitValue
        : (local.kStockUniverseLimit > 0 ? local.kStockUniverseLimit : 40);
    final resolvedHistoryLimit = historicalSnapshotLimitValue > 0
        ? historicalSnapshotLimitValue
        : (local.kHistoricalSnapshotLimit > 0
              ? local.kHistoricalSnapshotLimit
              : 240);

    // Auto-select mode: if a real AV key is present and no mode override,
    // switch to alpha-vantage. Otherwise default to live-preferred.
    final resolvedMode = modeValue.trim().isEmpty
        ? (resolvedKey != null
              ? MarketDataMode.alphaVantage
              : MarketDataMode.livePreferred)
        : parseMode(modeValue);

    return MarketDataConfiguration(
      mode: resolvedMode,
      baseUrl: _normalizeOptionalValue(baseUrlValue),
      apiToken: _normalizeOptionalValue(apiTokenValue),
      alphaVantageApiKey: resolvedKey,
      alphaVantageProxyUrl: _normalizeOptionalValue(alphaVantageProxyUrlValue),
      alphaVantageSymbols: resolvedSymbols,
      alphaVantageBenchmarkSymbol: resolvedBenchmark,
      finnhubApiKey:
          _normalizeOptionalValue(finnhubApiKeyValue) ??
          _normalizeOptionalValue(local.kFinnhubApiKey),
      fredApiKey:
          _normalizeOptionalValue(fredApiKeyValue) ??
          _normalizeOptionalValue(local.kFredApiKey),
      alphaVantageDailyRequestLimit: resolvedDailyLimit < 1
          ? 1
          : resolvedDailyLimit,
      alphaVantageSyncIntervalMinutes: alphaVantageSyncIntervalMinutesValue < 1
          ? 1
          : alphaVantageSyncIntervalMinutesValue,
      stockUniverseLimit: resolvedUniverseLimit < 10
          ? 10
          : resolvedUniverseLimit,
      historicalSnapshotLimit: resolvedHistoryLimit < 60
          ? 60
          : resolvedHistoryLimit,
    );
  }

  static MarketDataMode parseMode(String value) {
    final normalized = value.trim().toLowerCase();
    return switch (normalized) {
      'fixture' ||
      'fixture-only' ||
      'fixture_only' => MarketDataMode.fixtureOnly,
      'live-preferred' ||
      'live_preferred' ||
      'livepreferred' => MarketDataMode.livePreferred,
      'live-required' ||
      'live_required' ||
      'liverequired' => MarketDataMode.liveRequired,
      'alpha-vantage' ||
      'alpha_vantage' ||
      'alphavantage' => MarketDataMode.alphaVantage,
      _ => MarketDataMode.livePreferred,
    };
  }

  static String? _normalizeOptionalValue(String value) {
    return value.trim().isEmpty ? null : value;
  }

  static List<String> _parseSymbolList(String value) {
    return value
        .split(',')
        .map(_normalizeTicker)
        .whereType<String>()
        .toSet()
        .toList();
  }

  static String? _normalizeTicker(String value) {
    final normalized = value.trim().toUpperCase();
    return normalized.isEmpty ? null : normalized;
  }
}
