import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'alpha_vantage_models.dart';

class AlphaVantageLocalStoreState {
  const AlphaVantageLocalStoreState({
    required this.quota,
    required this.sync,
    required this.seriesBySymbol,
  });

  final AlphaVantageQuotaState quota;
  final AlphaVantageSyncState sync;
  final Map<String, AlphaVantageDailySeries> seriesBySymbol;

  AlphaVantageLocalStoreState copyWith({
    AlphaVantageQuotaState? quota,
    AlphaVantageSyncState? sync,
    Map<String, AlphaVantageDailySeries>? seriesBySymbol,
  }) {
    return AlphaVantageLocalStoreState(
      quota: quota ?? this.quota,
      sync: sync ?? this.sync,
      seriesBySymbol: seriesBySymbol ?? this.seriesBySymbol,
    );
  }

  Map<String, dynamic> toJson() => {
    'quota': quota.toJson(),
    'sync': sync.toJson(),
    'seriesBySymbol': {
      for (final entry in seriesBySymbol.entries)
        entry.key: entry.value.toJson(),
    },
  };

  factory AlphaVantageLocalStoreState.empty() {
    return AlphaVantageLocalStoreState(
      quota: AlphaVantageQuotaState.today(),
      sync: AlphaVantageSyncState.empty(),
      seriesBySymbol: const <String, AlphaVantageDailySeries>{},
    );
  }

  factory AlphaVantageLocalStoreState.fromJson(Map<String, dynamic> json) {
    return AlphaVantageLocalStoreState(
      quota: json['quota'] is Map<String, dynamic>
          ? AlphaVantageQuotaState.fromJson(
              json['quota'] as Map<String, dynamic>,
            )
          : AlphaVantageQuotaState.today(),
      sync: json['sync'] is Map<String, dynamic>
          ? AlphaVantageSyncState.fromJson(json['sync'] as Map<String, dynamic>)
          : AlphaVantageSyncState.empty(),
      seriesBySymbol: json['seriesBySymbol'] is Map<String, dynamic>
          ? (json['seriesBySymbol'] as Map<String, dynamic>).map(
              (key, value) => MapEntry(
                key,
                AlphaVantageDailySeries.fromJson(value as Map<String, dynamic>),
              ),
            )
          : <String, AlphaVantageDailySeries>{},
    );
  }
}

class AlphaVantageSyncState {
  const AlphaVantageSyncState({
    this.lastAttemptedAt,
    this.lastSuccessfulSyncAt,
    this.nextEligibleSyncAt,
    this.requestedSymbols = const <String>[],
    this.availableSymbols = const <String>[],
    this.missingSymbols = const <String>[],
    this.networkRequestsUsed = 0,
    this.summary,
    this.messages = const <String>[],
  });

  final DateTime? lastAttemptedAt;
  final DateTime? lastSuccessfulSyncAt;
  final DateTime? nextEligibleSyncAt;
  final List<String> requestedSymbols;
  final List<String> availableSymbols;
  final List<String> missingSymbols;
  final int networkRequestsUsed;
  final String? summary;
  final List<String> messages;

  bool get hasSuccessfulSync => lastSuccessfulSyncAt != null;

  bool isDue(DateTime now) =>
      nextEligibleSyncAt == null || !nextEligibleSyncAt!.isAfter(now);

  AlphaVantageSyncState copyWith({
    DateTime? lastAttemptedAt,
    DateTime? lastSuccessfulSyncAt,
    DateTime? nextEligibleSyncAt,
    List<String>? requestedSymbols,
    List<String>? availableSymbols,
    List<String>? missingSymbols,
    int? networkRequestsUsed,
    String? summary,
    List<String>? messages,
  }) {
    return AlphaVantageSyncState(
      lastAttemptedAt: lastAttemptedAt ?? this.lastAttemptedAt,
      lastSuccessfulSyncAt: lastSuccessfulSyncAt ?? this.lastSuccessfulSyncAt,
      nextEligibleSyncAt: nextEligibleSyncAt ?? this.nextEligibleSyncAt,
      requestedSymbols: requestedSymbols ?? this.requestedSymbols,
      availableSymbols: availableSymbols ?? this.availableSymbols,
      missingSymbols: missingSymbols ?? this.missingSymbols,
      networkRequestsUsed: networkRequestsUsed ?? this.networkRequestsUsed,
      summary: summary ?? this.summary,
      messages: messages ?? this.messages,
    );
  }

  Map<String, dynamic> toJson() => {
    'lastAttemptedAt': lastAttemptedAt?.toIso8601String(),
    'lastSuccessfulSyncAt': lastSuccessfulSyncAt?.toIso8601String(),
    'nextEligibleSyncAt': nextEligibleSyncAt?.toIso8601String(),
    'requestedSymbols': requestedSymbols,
    'availableSymbols': availableSymbols,
    'missingSymbols': missingSymbols,
    'networkRequestsUsed': networkRequestsUsed,
    'summary': summary,
    'messages': messages,
  };

  factory AlphaVantageSyncState.empty() => const AlphaVantageSyncState();

  factory AlphaVantageSyncState.fromJson(Map<String, dynamic> json) {
    return AlphaVantageSyncState(
      lastAttemptedAt: _readOptionalDateTime(json, 'lastAttemptedAt'),
      lastSuccessfulSyncAt: _readOptionalDateTime(json, 'lastSuccessfulSyncAt'),
      nextEligibleSyncAt: _readOptionalDateTime(json, 'nextEligibleSyncAt'),
      requestedSymbols: _readStringList(json['requestedSymbols']),
      availableSymbols: _readStringList(json['availableSymbols']),
      missingSymbols: _readStringList(json['missingSymbols']),
      networkRequestsUsed: json['networkRequestsUsed'] as int? ?? 0,
      summary: json['summary'] as String?,
      messages: _readStringList(json['messages']),
    );
  }
}

class AlphaVantageStoreSnapshot {
  const AlphaVantageStoreSnapshot({
    required this.sync,
    required this.quota,
    required this.cachedSymbolCount,
    required this.cachedBarCount,
    required this.coverageStart,
    required this.coverageEnd,
  });

  final AlphaVantageSyncState sync;
  final AlphaVantageQuotaState quota;
  final int cachedSymbolCount;
  final int cachedBarCount;
  final DateTime? coverageStart;
  final DateTime? coverageEnd;

  bool get hasHistory => cachedSymbolCount > 0 && cachedBarCount > 0;
}

abstract class AlphaVantageLocalStore {
  Future<AlphaVantageLocalStoreState> load();

  Future<void> save(AlphaVantageLocalStoreState state);
}

class SharedPreferencesAlphaVantageLocalStore
    implements AlphaVantageLocalStore {
  SharedPreferencesAlphaVantageLocalStore({
    this.preferencesKey = 'finance_oracle_alpha_vantage_store_v1',
  });

  final String preferencesKey;

  @override
  Future<AlphaVantageLocalStoreState> load() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return AlphaVantageLocalStoreState.empty();
    }

    try {
      return AlphaVantageLocalStoreState.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      );
    } catch (_) {
      return AlphaVantageLocalStoreState.empty();
    }
  }

  @override
  Future<void> save(AlphaVantageLocalStoreState state) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferencesKey, jsonEncode(state.toJson()));
  }
}

DateTime? _readOptionalDateTime(Map<String, dynamic> json, String key) {
  final raw = json[key] as String?;
  if (raw == null || raw.isEmpty) {
    return null;
  }
  return DateTime.tryParse(raw);
}

List<String> _readStringList(Object? raw) {
  if (raw is! List<dynamic>) {
    return const <String>[];
  }
  return raw.whereType<String>().toList();
}
