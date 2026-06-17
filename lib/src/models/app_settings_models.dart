import 'dart:convert';

class AppSettings {
  const AppSettings({this.customUniverseTickers = const <String>[]});

  static const empty = AppSettings();

  final List<String> customUniverseTickers;

  AppSettings copyWith({List<String>? customUniverseTickers}) {
    return AppSettings(
      customUniverseTickers:
          customUniverseTickers ?? this.customUniverseTickers,
    );
  }

  AppSettings addTicker(String ticker) {
    final normalized = normalizeSettingsTicker(ticker);
    if (normalized.isEmpty || customUniverseTickers.contains(normalized)) {
      return this;
    }
    final next = [...customUniverseTickers, normalized]..sort();
    return copyWith(customUniverseTickers: next);
  }

  AppSettings removeTicker(String ticker) {
    final normalized = normalizeSettingsTicker(ticker);
    return copyWith(
      customUniverseTickers: customUniverseTickers
          .where((candidate) => candidate != normalized)
          .toList(),
    );
  }

  String toJson() {
    return jsonEncode({'customUniverseTickers': customUniverseTickers});
  }

  factory AppSettings.fromJson(String raw) {
    if (raw.isEmpty) {
      return AppSettings.empty;
    }
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      return AppSettings.empty;
    }
    final tickers = decoded['customUniverseTickers'];
    final normalizedTickers = tickers is List<dynamic>
        ? (tickers
              .whereType<String>()
              .map(normalizeSettingsTicker)
              .where((ticker) => ticker.isNotEmpty)
              .toSet()
              .toList()
            ..sort())
        : const <String>[];
    return AppSettings(customUniverseTickers: normalizedTickers);
  }
}

String normalizeSettingsTicker(String raw) {
  final compact = raw.trim().toUpperCase().split(RegExp(r'\s+')).first;
  return compact.replaceAll(RegExp(r'[^A-Z0-9.\-]'), '');
}
