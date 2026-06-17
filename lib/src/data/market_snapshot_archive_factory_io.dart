import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'market_snapshot_archive.dart';
import 'raw_market_data.dart';

MarketSnapshotArchive createPlatformMarketSnapshotArchive({
  required String preferencesKey,
  required int maxSnapshots,
}) {
  return FileBackedMarketSnapshotArchive(
    fallback: SharedPreferencesMarketSnapshotArchive(
      preferencesKey: preferencesKey,
      maxSnapshots: maxSnapshots,
    ),
    maxSnapshots: maxSnapshots,
  );
}

class FileBackedMarketSnapshotArchive implements MarketSnapshotArchive {
  FileBackedMarketSnapshotArchive({
    required SharedPreferencesMarketSnapshotArchive fallback,
    this.maxSnapshots = 240,
    this.fileName = 'market_snapshot_archive_v2.json',
  }) : _fallback = fallback;

  final SharedPreferencesMarketSnapshotArchive _fallback;
  final int maxSnapshots;
  final String fileName;

  @override
  Future<ArchiveSummary> saveSnapshot(
    RawMarketState marketState, {
    required String source,
  }) {
    return saveSnapshots([marketState], source: source);
  }

  @override
  Future<ArchiveSummary> saveSnapshots(
    Iterable<RawMarketState> marketStates, {
    required String source,
  }) async {
    final file = await _resolveArchiveFile();
    if (file == null) {
      return _fallback.saveSnapshots(marketStates, source: source);
    }

    final records = await _readFileRecords(file);
    final capturedAt = DateTime.now();
    for (final marketState in marketStates) {
      final snapshotId = '$source:${marketState.asOf.toIso8601String()}';
      final record = ArchivedMarketSnapshot(
        snapshotId: snapshotId,
        source: source,
        capturedAt: capturedAt,
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
    }

    records.sort(
      (left, right) => left.marketState.asOf.compareTo(right.marketState.asOf),
    );
    final trimmed = records.length > maxSnapshots
        ? records.sublist(records.length - maxSnapshots)
        : records;
    await file.writeAsString(
      jsonEncode(trimmed.map((entry) => entry.toJson()).toList()),
      flush: true,
    );
    return ArchiveSummary.fromSnapshots(trimmed);
  }

  @override
  Future<ArchiveSummary> loadSummary() async {
    final file = await _resolveArchiveFile();
    if (file == null) {
      return _fallback.loadSummary();
    }
    return ArchiveSummary.fromSnapshots(await _readFileRecords(file));
  }

  @override
  Future<List<ArchivedMarketSnapshot>> loadSnapshots() async {
    final file = await _resolveArchiveFile();
    if (file == null) {
      return _fallback.loadSnapshots();
    }
    return _readFileRecords(file);
  }

  Future<File?> _resolveArchiveFile() async {
    if (Platform.environment.containsKey('FLUTTER_TEST')) {
      return null;
    }
    try {
      final directory = await getApplicationSupportDirectory();
      final archiveDirectory = Directory(
        '${directory.path}${Platform.pathSeparator}finance_oracle',
      );
      if (!await archiveDirectory.exists()) {
        await archiveDirectory.create(recursive: true);
      }
      return File(
        '${archiveDirectory.path}${Platform.pathSeparator}$fileName',
      );
    } on MissingPluginException {
      return null;
    } on UnsupportedError {
      return null;
    } on FileSystemException {
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<List<ArchivedMarketSnapshot>> _readFileRecords(File file) async {
    if (!await file.exists()) {
      return <ArchivedMarketSnapshot>[];
    }

    final raw = await file.readAsString();
    if (raw.isEmpty) {
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
