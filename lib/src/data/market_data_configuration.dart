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
    this.alphaVantageSymbols = const [],
    this.alphaVantageBenchmarkSymbol = 'SPY',
    this.alphaVantageDailyRequestLimit = 25,
    this.stockUniverseLimit = 40,
    this.historicalSnapshotLimit = 240,
  });

  final MarketDataMode mode;
  final String? baseUrl;
  final String? apiToken;
  final String? alphaVantageApiKey;
  final List<String> alphaVantageSymbols;
  final String alphaVantageBenchmarkSymbol;
  final int alphaVantageDailyRequestLimit;
  final int stockUniverseLimit;
  final int historicalSnapshotLimit;

  bool get hasBaseUrl => baseUrl != null && baseUrl!.trim().isNotEmpty;

  factory MarketDataConfiguration.fromEnvironment() {
    const modeValue = String.fromEnvironment(
      'ORACLE_DATA_MODE',
      defaultValue: 'fixture',
    );
    const baseUrlValue = String.fromEnvironment(
      'ORACLE_DATA_BASE_URL',
      defaultValue: '',
    );
    const apiTokenValue = String.fromEnvironment(
      'ORACLE_DATA_API_TOKEN',
      defaultValue: '',
    );
    const alphaVantageApiKeyValue = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_API_KEY',
      defaultValue: '',
    );
    const alphaVantageSymbolsValue = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_SYMBOLS',
      defaultValue: '',
    );
    const alphaVantageBenchmarkSymbolValue = String.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_BENCHMARK',
      defaultValue: 'SPY',
    );
    const alphaVantageDailyRequestLimitValue = int.fromEnvironment(
      'ORACLE_ALPHA_VANTAGE_DAILY_LIMIT',
      defaultValue: 25,
    );
    const stockUniverseLimitValue = int.fromEnvironment(
      'ORACLE_STOCK_UNIVERSE_LIMIT',
      defaultValue: 40,
    );
    const historicalSnapshotLimitValue = int.fromEnvironment(
      'ORACLE_HISTORICAL_SNAPSHOT_LIMIT',
      defaultValue: 240,
    );

    return MarketDataConfiguration(
      mode: parseMode(modeValue),
      baseUrl: _normalizeOptionalValue(baseUrlValue),
      apiToken: _normalizeOptionalValue(apiTokenValue),
      alphaVantageApiKey:
          _normalizeOptionalValue(alphaVantageApiKeyValue) ??
          _normalizeOptionalValue(apiTokenValue),
      alphaVantageSymbols: _parseSymbolList(alphaVantageSymbolsValue),
      alphaVantageBenchmarkSymbol:
          _normalizeTicker(alphaVantageBenchmarkSymbolValue) ?? 'SPY',
      alphaVantageDailyRequestLimit: alphaVantageDailyRequestLimitValue < 1
          ? 1
          : alphaVantageDailyRequestLimitValue,
      stockUniverseLimit: stockUniverseLimitValue < 10
          ? 10
          : stockUniverseLimitValue,
      historicalSnapshotLimit: historicalSnapshotLimitValue < 60
          ? 60
          : historicalSnapshotLimitValue,
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
      _ => MarketDataMode.fixtureOnly,
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
