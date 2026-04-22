import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'raw_market_data.dart';

abstract class MarketSnapshotArchive {
  Future<ArchiveSummary> saveSnapshot(
    RawMarketState marketState, {
    required String source,
  });

  Future<ArchiveSummary> loadSummary();
}

class SharedPreferencesMarketSnapshotArchive implements MarketSnapshotArchive {
  SharedPreferencesMarketSnapshotArchive({
    this.preferencesKey = 'market_snapshot_archive_v1',
    this.maxSnapshots = 48,
  });

  final String preferencesKey;
  final int maxSnapshots;

  @override
  Future<ArchiveSummary> saveSnapshot(
    RawMarketState marketState, {
    required String source,
  }) async {
    final preferences = await SharedPreferences.getInstance();
    final records = _readRecords(preferences);
    final snapshotId = '$source:${marketState.asOf.toIso8601String()}';
    final record = ArchivedMarketSnapshot(
      snapshotId: snapshotId,
      source: source,
      capturedAt: DateTime.now(),
      marketState: marketState,
    );
    final existingIndex = records.indexWhere(
      (entry) => entry.snapshotId == record.snapshotId,
    );
    if (existingIndex == -1) {
      records.add(record);
    } else {
      records[existingIndex] = record;
    }
    records.sort(
      (left, right) => left.marketState.asOf.compareTo(right.marketState.asOf),
    );
    final trimmed = records.length > maxSnapshots
        ? records.sublist(records.length - maxSnapshots)
        : records;
    await preferences.setString(
      preferencesKey,
      jsonEncode(trimmed.map((entry) => entry.toJson()).toList()),
    );
    return ArchiveSummary.fromSnapshots(trimmed);
  }

  @override
  Future<ArchiveSummary> loadSummary() async {
    final preferences = await SharedPreferences.getInstance();
    final records = _readRecords(preferences);
    return ArchiveSummary.fromSnapshots(records);
  }

  List<ArchivedMarketSnapshot> _readRecords(SharedPreferences preferences) {
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return <ArchivedMarketSnapshot>[];
    }

    final decoded = jsonDecode(raw) as List<dynamic>;
    return decoded
        .map(
          (entry) =>
              ArchivedMarketSnapshot.fromJson(entry as Map<String, dynamic>),
        )
        .toList();
  }
}

class ArchiveSummary {
  const ArchiveSummary({
    required this.snapshotCount,
    required this.latestSnapshotAsOf,
    required this.oldestSnapshotAsOf,
    required this.sources,
  });

  final int snapshotCount;
  final DateTime? latestSnapshotAsOf;
  final DateTime? oldestSnapshotAsOf;
  final List<String> sources;

  bool get hasSnapshots => snapshotCount > 0;

  String get summaryText {
    if (!hasSnapshots) {
      return 'No point-in-time snapshots archived yet.';
    }

    final latest = latestSnapshotAsOf;
    final sourceText = sources.isEmpty ? 'local' : sources.join(', ');
    final snapshotLabel = snapshotCount == 1 ? 'snapshot' : 'snapshots';
    if (latest == null) {
      return '$snapshotCount archived $snapshotLabel from $sourceText.';
    }
    return '$snapshotCount archived $snapshotLabel from $sourceText. Latest data as of ${latest.toIso8601String()}.';
  }

  factory ArchiveSummary.fromSnapshots(List<ArchivedMarketSnapshot> snapshots) {
    if (snapshots.isEmpty) {
      return const ArchiveSummary(
        snapshotCount: 0,
        latestSnapshotAsOf: null,
        oldestSnapshotAsOf: null,
        sources: [],
      );
    }

    final sorted = [...snapshots]
      ..sort(
        (left, right) =>
            left.marketState.asOf.compareTo(right.marketState.asOf),
      );
    final sources = sorted.map((snapshot) => snapshot.source).toSet().toList()
      ..sort();
    return ArchiveSummary(
      snapshotCount: sorted.length,
      latestSnapshotAsOf: sorted.last.marketState.asOf,
      oldestSnapshotAsOf: sorted.first.marketState.asOf,
      sources: sources,
    );
  }
}

class ArchivedMarketSnapshot {
  const ArchivedMarketSnapshot({
    required this.snapshotId,
    required this.source,
    required this.capturedAt,
    required this.marketState,
  });

  final String snapshotId;
  final String source;
  final DateTime capturedAt;
  final RawMarketState marketState;

  Map<String, dynamic> toJson() => {
    'snapshotId': snapshotId,
    'source': source,
    'capturedAt': capturedAt.toIso8601String(),
    'marketState': marketState.toJson(),
  };

  factory ArchivedMarketSnapshot.fromJson(Map<String, dynamic> json) =>
      ArchivedMarketSnapshot(
        snapshotId: json['snapshotId'] as String,
        source: json['source'] as String,
        capturedAt: DateTime.parse(json['capturedAt'] as String),
        marketState: RawMarketState.fromJson(
          json['marketState'] as Map<String, dynamic>,
        ),
      );
}
