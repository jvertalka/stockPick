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
  });

  final MarketDataMode mode;
  final String? baseUrl;
  final String? apiToken;

  bool get hasBaseUrl => baseUrl != null && baseUrl!.trim().isNotEmpty;

  factory MarketDataConfiguration.fromEnvironment() {
    return MarketDataConfiguration(
      mode: parseMode(
        const String.fromEnvironment(
          'ORACLE_DATA_MODE',
          defaultValue: 'fixture',
        ),
      ),
      baseUrl: _optionalEnvironmentValue('ORACLE_DATA_BASE_URL'),
      apiToken: _optionalEnvironmentValue('ORACLE_DATA_API_TOKEN'),
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

  static String? _optionalEnvironmentValue(String name) {
    final value = String.fromEnvironment(name, defaultValue: '');
    return value.trim().isEmpty ? null : value;
  }
}
