enum MarketDataMode { fixtureOnly, livePreferred, liveRequired }

extension MarketDataModeLabel on MarketDataMode {
  String get label => switch (this) {
    MarketDataMode.fixtureOnly => 'Fixture only',
    MarketDataMode.livePreferred => 'Live preferred',
    MarketDataMode.liveRequired => 'Live required',
  };
}

class MarketDataConfiguration {
  const MarketDataConfiguration({
    required this.mode,
    this.baseUrl,
    this.apiToken,
    this.stockUniverseLimit = 40,
    this.historicalSnapshotLimit = 240,
  });

  final MarketDataMode mode;
  final String? baseUrl;
  final String? apiToken;
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
      _ => MarketDataMode.fixtureOnly,
    };
  }

  static String? _normalizeOptionalValue(String value) {
    return value.trim().isEmpty ? null : value;
  }
}
