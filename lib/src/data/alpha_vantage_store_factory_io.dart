import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'alpha_vantage_store.dart';

AlphaVantageLocalStore createPlatformAlphaVantageLocalStore({
  required String preferencesKey,
}) {
  return FileBackedAlphaVantageLocalStore(
    fallback: SharedPreferencesAlphaVantageLocalStore(
      preferencesKey: preferencesKey,
    ),
  );
}

class FileBackedAlphaVantageLocalStore implements AlphaVantageLocalStore {
  FileBackedAlphaVantageLocalStore({
    required SharedPreferencesAlphaVantageLocalStore fallback,
    this.fileName = 'alpha_vantage_store_v1.json',
  }) : _fallback = fallback;

  final SharedPreferencesAlphaVantageLocalStore _fallback;
  final String fileName;

  @override
  Future<AlphaVantageLocalStoreState> load() async {
    final file = await _resolveStoreFile();
    if (file == null) {
      return _fallback.load();
    }
    if (!await file.exists()) {
      return _fallback.load();
    }

    try {
      final raw = await file.readAsString();
      if (raw.isEmpty) {
        return AlphaVantageLocalStoreState.empty();
      }
      return AlphaVantageLocalStoreState.fromJson(_decode(raw));
    } catch (_) {
      return _fallback.load();
    }
  }

  @override
  Future<void> save(AlphaVantageLocalStoreState state) async {
    final file = await _resolveStoreFile();
    if (file == null) {
      await _fallback.save(state);
      return;
    }

    try {
      await file.writeAsString(jsonEncode(state.toJson()), flush: true);
    } catch (_) {
      await _fallback.save(state);
    }
  }

  Future<File?> _resolveStoreFile() async {
    if (Platform.environment.containsKey('FLUTTER_TEST')) {
      return null;
    }
    try {
      final directory = await getApplicationSupportDirectory();
      final storeDirectory = Directory(
        '${directory.path}${Platform.pathSeparator}finance_oracle',
      );
      if (!await storeDirectory.exists()) {
        await storeDirectory.create(recursive: true);
      }
      return File('${storeDirectory.path}${Platform.pathSeparator}$fileName');
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

  Map<String, dynamic> _decode(String raw) {
    return raw.isEmpty
        ? const <String, dynamic>{}
        : jsonDecode(raw) as Map<String, dynamic>;
  }
}
