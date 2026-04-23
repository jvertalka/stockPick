import 'dart:convert';
import 'dart:io';

import 'package:finance_app/src/data/raw_market_data.dart';
import 'package:http/http.dart' as http;

Future<void> main(List<String> args) async {
  if (args.contains('--help') || args.contains('-h')) {
    _printUsage();
    return;
  }

  final baseUrl =
      _option(args, '--base-url') ??
      Platform.environment['ORACLE_DATA_BASE_URL'];
  if (baseUrl == null || baseUrl.trim().isEmpty) {
    stderr.writeln(
      'Missing base URL. Pass --base-url or set ORACLE_DATA_BASE_URL.',
    );
    _printUsage();
    exitCode = 64;
    return;
  }

  final token =
      _option(args, '--token') ?? Platform.environment['ORACLE_DATA_API_TOKEN'];
  final stockLimit = _intOption(
    args,
    '--stock-limit',
    Platform.environment['ORACLE_STOCK_UNIVERSE_LIMIT'],
    fallback: 100,
  );
  final historyLimit = _intOption(
    args,
    '--history-limit',
    Platform.environment['ORACLE_HISTORICAL_SNAPSHOT_LIMIT'],
    fallback: 252,
  );
  final client = http.Client();

  try {
    final environment = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/market/environment',
      token: token,
      parser: (data) =>
          RawMarketEnvironment.fromJson(data as Map<String, dynamic>),
    );
    _printCheck(
      'Market and breadth',
      'indexTrend=${environment.payload.indexTrend.toStringAsFixed(0)} '
          'asOf=${environment.asOfText}',
    );

    final styles = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/market/styles',
      token: token,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawStyleSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
    );
    _printCheck('Style and factor rotation', '${styles.payload.length} rows');

    final sectors = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/market/sectors',
      token: token,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawSectorSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
    );
    _printCheck('Sector sponsorship', '${sectors.payload.length} rows');

    final stocks = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/market/stocks',
      queryParameters: {'limit': stockLimit.toString()},
      token: token,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawStockSignal.fromJson(item as Map<String, dynamic>))
          .toList(),
    );
    _printCheck('Stock universe', '${stocks.payload.length} rows');

    final history = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/market/history',
      queryParameters: {'limit': historyLimit.toString()},
      token: token,
      parser: (data) => (data as List<dynamic>)
          .map((item) => RawMarketState.fromJson(item as Map<String, dynamic>))
          .toList(),
    );
    _printCheck('Historical market states', '${history.payload.length} rows');

    final validation = await _load(
      client: client,
      baseUrl: baseUrl,
      path: '/research/validation-windows',
      token: token,
      parser: (data) => (data as List<dynamic>)
          .map(
            (item) => ValidationWindow.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
    );
    _printCheck(
      'Research labels and windows',
      '${validation.payload.length} rows',
    );

    stdout.writeln('');
    stdout.writeln('Live feed contract validation passed.');
  } catch (error, stackTrace) {
    stderr.writeln('');
    stderr.writeln('Live feed contract validation failed.');
    stderr.writeln(error);
    stderr.writeln(stackTrace);
    exitCode = 1;
  } finally {
    client.close();
  }
}

Future<_ValidatedPayload<T>> _load<T>({
  required http.Client client,
  required String baseUrl,
  required String path,
  required String? token,
  required T Function(Object? data) parser,
  Map<String, String>? queryParameters,
}) async {
  final baseUri = Uri.parse(baseUrl).resolve(path);
  final uri = queryParameters == null || queryParameters.isEmpty
      ? baseUri
      : baseUri.replace(
          queryParameters: {...baseUri.queryParameters, ...queryParameters},
        );
  final response = await client.get(uri, headers: _headers(token));
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw StateError('$uri returned HTTP ${response.statusCode}.');
  }

  final decoded = jsonDecode(response.body);
  final envelope =
      decoded is Map<String, dynamic> && decoded.containsKey('data')
      ? decoded
      : <String, dynamic>{'data': decoded};
  return _ValidatedPayload(
    payload: parser(envelope['data']),
    asOf: envelope['asOf'] is String
        ? DateTime.parse(envelope['asOf'] as String)
        : null,
  );
}

Map<String, String> _headers(String? token) {
  if (token == null || token.isEmpty) {
    return const {'Accept': 'application/json'};
  }
  return {'Accept': 'application/json', 'Authorization': 'Bearer $token'};
}

String? _option(List<String> args, String name) {
  final index = args.indexOf(name);
  if (index == -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

int _intOption(
  List<String> args,
  String name,
  String? environmentValue, {
  required int fallback,
}) {
  final raw = _option(args, name) ?? environmentValue;
  if (raw == null || raw.trim().isEmpty) {
    return fallback;
  }
  return int.tryParse(raw) ?? fallback;
}

void _printCheck(String name, String detail) {
  stdout.writeln('[ok] $name: $detail');
}

void _printUsage() {
  stdout.writeln('''
Validate Finance Oracle live endpoint contracts.

Usage:
  dart run tool/validate_live_feed_contract.dart --base-url https://your-api.example

Options:
  --base-url       Live feed base URL. Falls back to ORACLE_DATA_BASE_URL.
  --token          Bearer token. Falls back to ORACLE_DATA_API_TOKEN.
  --stock-limit    Stock universe limit. Defaults to 100.
  --history-limit  Historical snapshot limit. Defaults to 252.
''');
}

class _ValidatedPayload<T> {
  const _ValidatedPayload({required this.payload, required this.asOf});

  final T payload;
  final DateTime? asOf;

  String get asOfText => asOf?.toIso8601String() ?? 'not provided';
}
