import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:finance_app/src/data/default_symbol_universe.dart';

Future<void> main(List<String> args) async {
  final config = BackendCacheConfig.fromArgs(args);
  final server = BackendCacheServer(config);
  await server.start();
}

class BackendCacheConfig {
  const BackendCacheConfig({
    required this.host,
    required this.port,
    required this.cacheDirectory,
    required this.webRoot,
  });

  factory BackendCacheConfig.fromArgs(List<String> args) {
    var host = '127.0.0.1';
    var port = 8787;
    var cacheDirectory = Directory('.dart_tool/market_data_cache');
    var webRoot = Directory('build/web');

    for (var index = 0; index < args.length; index++) {
      final arg = args[index];
      final next = index + 1 < args.length ? args[index + 1] : null;
      switch (arg) {
        case '--host':
          if (next != null) {
            host = next;
            index++;
          }
          break;
        case '--port':
          if (next != null) {
            port = int.tryParse(next) ?? port;
            index++;
          }
          break;
        case '--cache-dir':
          if (next != null) {
            cacheDirectory = Directory(next);
            index++;
          }
          break;
        case '--web-root':
          if (next != null) {
            webRoot = Directory(next);
            index++;
          }
          break;
        case '--help':
          stdout.writeln(_usage);
          exit(0);
      }
    }

    return BackendCacheConfig(
      host: host,
      port: port,
      cacheDirectory: cacheDirectory,
      webRoot: webRoot,
    );
  }

  final String host;
  final int port;
  final Directory cacheDirectory;
  final Directory webRoot;

  static const String _usage = '''
Finance Oracle backend cache

Usage:
  dart run tool/backend_cache_server.dart [--host 127.0.0.1] [--port 8787] [--web-root build/web] [--cache-dir .dart_tool/market_data_cache]

Routes:
  GET /                         Serves the Flutter web build from --web-root.
  GET /health                   Health check and cache path.
  GET /cache/status             Basic cache counters.
  GET /decision/universe        Backend-fed decision signals for the JS workstation.
  GET /proxy?url=<encoded-url>  CORS-safe cached proxy for allowed market-data hosts.
''';
}

class BackendCacheServer {
  BackendCacheServer(this.config) : _client = HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 8);
    _cache = MarketDataCache(config.cacheDirectory, client: _client);
  }

  final BackendCacheConfig config;
  final HttpClient _client;
  late final MarketDataCache _cache;
  HttpServer? _server;

  Future<void> start() async {
    await config.cacheDirectory.create(recursive: true);
    final server = await HttpServer.bind(config.host, config.port);
    _server = server;
    stdout.writeln(
      'Finance Oracle cache listening on http://${config.host}:${config.port}',
    );
    stdout.writeln(
      'Proxy prefix: http://${config.host}:${config.port}/proxy?url=',
    );
    stdout.writeln('Cache dir: ${config.cacheDirectory.absolute.path}');
    stdout.writeln('Web root: ${config.webRoot.absolute.path}');
    await for (final request in server) {
      unawaited(_handleRequest(request));
    }
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _client.close(force: true);
  }

  Future<void> _handleRequest(HttpRequest request) async {
    _addCorsHeaders(request.response);

    try {
      if (request.method == 'OPTIONS') {
        request.response.statusCode = HttpStatus.noContent;
        await request.response.close();
        return;
      }

      final path = request.uri.path;
      if (path == '/health') {
        await _writeJson(request.response, {
          'ok': true,
          'cacheDirectory': config.cacheDirectory.absolute.path,
          'webRoot': config.webRoot.absolute.path,
          'proxyPrefix': 'http://${config.host}:${config.port}/proxy?url=',
        });
        return;
      }
      if (path == '/cache/status') {
        await _writeJson(request.response, await _cache.status());
        return;
      }
      if (path == '/decision/universe') {
        await _writeJson(
          request.response,
          await DecisionUniverseService(
            config.cacheDirectory,
          ).build(request.uri),
        );
        return;
      }
      if (path == '/proxy') {
        await _handleProxy(request);
        return;
      }

      await _serveStatic(request);
    } catch (error) {
      try {
        request.response.statusCode = HttpStatus.internalServerError;
        await _writeJson(request.response, {
          'error': 'backend_cache_error',
          'detail': '$error',
        });
      } catch (_) {
        await request.response.close();
      }
    }
  }

  Future<void> _handleProxy(HttpRequest request) async {
    final target = _targetFromProxyRequest(request.uri);
    if (target == null || !_cache.isAllowed(target)) {
      request.response.statusCode = HttpStatus.forbidden;
      await _writeJson(request.response, {
        'error': 'url_not_allowed',
        'detail':
            'Only configured market-data hosts can be fetched through this cache.',
      });
      return;
    }

    final entry = await _cache.fetch(target);
    request.response.statusCode = entry.statusCode;
    request.response.headers.set(
      HttpHeaders.contentTypeHeader,
      entry.contentType,
    );
    request.response.headers.set('X-Finance-Oracle-Cache', entry.cacheState);
    request.response.headers.set(
      HttpHeaders.cacheControlHeader,
      'public, max-age=${entry.remainingTtlSeconds}',
    );
    request.response.add(entry.body);
    await request.response.close();
  }

  Uri? _targetFromProxyRequest(Uri requestUri) {
    final rawUrl = requestUri.queryParameters['url'];
    final parsed = rawUrl == null ? null : Uri.tryParse(rawUrl);
    if (parsed == null) {
      return null;
    }

    final passthrough = Map<String, String>.from(requestUri.queryParameters)
      ..remove('url');
    if (passthrough.isEmpty) {
      return parsed;
    }
    return parsed.replace(
      queryParameters: {...parsed.queryParameters, ...passthrough},
    );
  }

  Future<void> _serveStatic(HttpRequest request) async {
    if (!await config.webRoot.exists()) {
      request.response.statusCode = HttpStatus.notFound;
      await _writeJson(request.response, {
        'error': 'web_root_missing',
        'detail':
            'Run `flutter build web --release --dart-define=ORACLE_CORS_PROXY_PREFIX=http://${config.host}:${config.port}/proxy?url=` first.',
      });
      return;
    }

    final path = _safeStaticPath(request.uri.path);
    final file = File('${config.webRoot.path}${Platform.pathSeparator}$path');
    final selected = await file.exists()
        ? file
        : File('${config.webRoot.path}${Platform.pathSeparator}index.html');

    if (!await selected.exists()) {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      return;
    }

    request.response.statusCode = HttpStatus.ok;
    request.response.headers.set(
      HttpHeaders.contentTypeHeader,
      _contentTypeFor(selected.path),
    );
    request.response.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    await request.response.addStream(selected.openRead());
    await request.response.close();
  }

  String _safeStaticPath(String rawPath) {
    final normalized = rawPath == '/' ? 'index.html' : rawPath.substring(1);
    if (normalized.contains('..') || normalized.startsWith('/')) {
      return 'index.html';
    }
    return normalized.replaceAll('/', Platform.pathSeparator);
  }

  String _contentTypeFor(String path) {
    final lower = path.toLowerCase();
    if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
    if (lower.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
    if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.wasm')) return 'application/wasm';
    if (lower.endsWith('.ttf')) return 'font/ttf';
    if (lower.endsWith('.otf')) return 'font/otf';
    return 'application/octet-stream';
  }

  void _addCorsHeaders(HttpResponse response) {
    response.headers.set(HttpHeaders.accessControlAllowOriginHeader, '*');
    response.headers.set(
      HttpHeaders.accessControlAllowMethodsHeader,
      'GET, OPTIONS',
    );
    response.headers.set(
      HttpHeaders.accessControlAllowHeadersHeader,
      'Accept, Content-Type',
    );
  }

  Future<void> _writeJson(HttpResponse response, Object value) async {
    response.headers.set(
      HttpHeaders.contentTypeHeader,
      'application/json; charset=utf-8',
    );
    response.write(const JsonEncoder.withIndent('  ').convert(value));
    await response.close();
  }
}

class MarketDataCache {
  MarketDataCache(this.directory, {required HttpClient client})
    : _client = client;

  final Directory directory;
  final HttpClient _client;

  static const _allowedHosts = {
    'www.alphavantage.co',
    'api.stlouisfed.org',
    'api.fiscaldata.treasury.gov',
    'www.sec.gov',
    'data.sec.gov',
    'api.gdeltproject.org',
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com',
    'stooq.com',
  };

  bool isAllowed(Uri uri) {
    final host = uri.host.toLowerCase();
    return (uri.scheme == 'https' || uri.scheme == 'http') &&
        _allowedHosts.contains(host);
  }

  Future<CachedProxyResponse> fetch(Uri uri) async {
    final key = _stableHash(uri.toString());
    final paths = _CachePaths(
      metadata: File('${directory.path}${Platform.pathSeparator}$key.json'),
      body: File('${directory.path}${Platform.pathSeparator}$key.body'),
    );
    final policy = _CachePolicy.forUri(uri);
    final cached = await _read(paths);
    if (cached != null && !cached.isExpired) {
      return cached.toResponse(cacheState: 'HIT');
    }

    try {
      final fresh = await _fetchNetwork(uri, policy);
      if (fresh.statusCode >= 200 && fresh.statusCode < 300) {
        await _write(paths, fresh);
        return fresh.toResponse(cacheState: 'MISS');
      }
      if (cached != null) {
        return cached.toResponse(cacheState: 'STALE');
      }
      return fresh.toResponse(cacheState: 'BYPASS');
    } catch (_) {
      if (cached != null) {
        return cached.toResponse(cacheState: 'STALE');
      }
      return CachedProxyResponse(
        statusCode: HttpStatus.badGateway,
        contentType: 'application/json; charset=utf-8',
        body: utf8.encode(
          jsonEncode({'error': 'upstream_unavailable', 'host': uri.host}),
        ),
        cacheState: 'ERROR',
        remainingTtlSeconds: 0,
      );
    }
  }

  Future<Map<String, Object>> status() async {
    await directory.create(recursive: true);
    final files = await directory
        .list()
        .where((entity) => entity is File && entity.path.endsWith('.json'))
        .length;
    return {
      'cacheDirectory': directory.absolute.path,
      'metadataEntries': files,
      'allowedHosts': _allowedHosts.toList()..sort(),
    };
  }

  Future<_StoredCacheEntry?> _read(_CachePaths paths) async {
    if (!await paths.metadata.exists() || !await paths.body.exists()) {
      return null;
    }
    try {
      final decoded =
          jsonDecode(await paths.metadata.readAsString())
              as Map<String, dynamic>;
      final fetchedAt = DateTime.parse(decoded['fetchedAt'] as String);
      final ttlSeconds = decoded['ttlSeconds'] as int;
      return _StoredCacheEntry(
        statusCode: decoded['statusCode'] as int,
        contentType:
            decoded['contentType'] as String? ?? 'application/octet-stream',
        fetchedAt: fetchedAt,
        ttl: Duration(seconds: ttlSeconds),
        body: await paths.body.readAsBytes(),
      );
    } catch (_) {
      return null;
    }
  }

  Future<_StoredCacheEntry> _fetchNetwork(Uri uri, _CachePolicy policy) async {
    final request = await _client.getUrl(uri).timeout(policy.timeout);
    request.headers.set(HttpHeaders.acceptHeader, '*/*');
    request.headers.set(
      HttpHeaders.userAgentHeader,
      'FinanceOracleLocalCache/1.0 (${Platform.operatingSystem})',
    );
    final response = await request.close().timeout(policy.timeout);
    final body = await _readAll(response).timeout(policy.timeout);
    return _StoredCacheEntry(
      statusCode: response.statusCode,
      contentType:
          response.headers.contentType?.toString() ??
          'application/octet-stream',
      fetchedAt: DateTime.now().toUtc(),
      ttl: policy.ttl,
      body: body,
    );
  }

  Future<void> _write(_CachePaths paths, _StoredCacheEntry entry) async {
    await directory.create(recursive: true);
    await paths.body.writeAsBytes(entry.body, flush: true);
    await paths.metadata.writeAsString(
      jsonEncode({
        'statusCode': entry.statusCode,
        'contentType': entry.contentType,
        'fetchedAt': entry.fetchedAt.toIso8601String(),
        'ttlSeconds': entry.ttl.inSeconds,
      }),
      flush: true,
    );
  }

  Future<Uint8List> _readAll(HttpClientResponse response) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  String _stableHash(String input) {
    const offset = 0xcbf29ce484222325;
    const prime = 0x100000001b3;
    const mask = 0xffffffffffffffff;
    var hash = offset;
    for (final byte in utf8.encode(input)) {
      hash ^= byte;
      hash = (hash * prime) & mask;
    }
    return hash.toRadixString(16).padLeft(16, '0');
  }
}

class _CachePolicy {
  const _CachePolicy({required this.ttl, required this.timeout});

  factory _CachePolicy.forUri(Uri uri) {
    final host = uri.host.toLowerCase();
    final path = uri.path.toLowerCase();
    if (host == 'data.sec.gov' || host == 'www.sec.gov') {
      if (path.contains('company_tickers')) {
        return const _CachePolicy(
          ttl: Duration(hours: 24),
          timeout: Duration(seconds: 10),
        );
      }
      return const _CachePolicy(
        ttl: Duration(hours: 12),
        timeout: Duration(seconds: 12),
      );
    }
    if (host == 'api.gdeltproject.org') {
      return const _CachePolicy(
        ttl: Duration(minutes: 20),
        timeout: Duration(seconds: 8),
      );
    }
    if (host.contains('yahoo.com')) {
      return const _CachePolicy(
        ttl: Duration(minutes: 20),
        timeout: Duration(seconds: 8),
      );
    }
    if (host == 'stooq.com') {
      return const _CachePolicy(
        ttl: Duration(hours: 6),
        timeout: Duration(seconds: 8),
      );
    }
    if (host == 'api.fiscaldata.treasury.gov' || host == 'api.stlouisfed.org') {
      return const _CachePolicy(
        ttl: Duration(hours: 24),
        timeout: Duration(seconds: 8),
      );
    }
    return const _CachePolicy(
      ttl: Duration(minutes: 20),
      timeout: Duration(seconds: 8),
    );
  }

  final Duration ttl;
  final Duration timeout;
}

class _CachePaths {
  const _CachePaths({required this.metadata, required this.body});

  final File metadata;
  final File body;
}

class _StoredCacheEntry {
  const _StoredCacheEntry({
    required this.statusCode,
    required this.contentType,
    required this.fetchedAt,
    required this.ttl,
    required this.body,
  });

  final int statusCode;
  final String contentType;
  final DateTime fetchedAt;
  final Duration ttl;
  final Uint8List body;

  bool get isExpired => remainingTtlSeconds <= 0;

  int get remainingTtlSeconds {
    final expiresAt = fetchedAt.add(ttl);
    return expiresAt
        .difference(DateTime.now().toUtc())
        .inSeconds
        .clamp(0, 1 << 31)
        .toInt();
  }

  CachedProxyResponse toResponse({required String cacheState}) {
    return CachedProxyResponse(
      statusCode: statusCode,
      contentType: contentType,
      body: body,
      cacheState: cacheState,
      remainingTtlSeconds: remainingTtlSeconds,
    );
  }
}

class CachedProxyResponse {
  const CachedProxyResponse({
    required this.statusCode,
    required this.contentType,
    required this.body,
    required this.cacheState,
    required this.remainingTtlSeconds,
  });

  final int statusCode;
  final String contentType;
  final Uint8List body;
  final String cacheState;
  final int remainingTtlSeconds;
}

class DecisionUniverseService {
  DecisionUniverseService(this.cacheDirectory);

  final Directory cacheDirectory;

  Future<Map<String, Object?>> build(Uri uri) async {
    await cacheDirectory.create(recursive: true);
    final asOf = DateTime.now().toUtc();
    final scenario = uri.queryParameters['scenario'] ?? 'base';
    final limit = int.tryParse(uri.queryParameters['limit'] ?? '0') ?? 0;
    final historyLimit =
        int.tryParse(uri.queryParameters['historyLimit'] ?? '8') ?? 8;
    final ownedTickers = _splitSymbols(uri.queryParameters['owned']);
    final fullUniverse = kDefaultSymbolUniverse;
    final selectedSymbols = limit > 0
        ? fullUniverse.take(limit).toList()
        : fullUniverse;
    final signals = <Map<String, Object?>>[];

    for (var index = 0; index < selectedSymbols.length; index++) {
      final symbol = selectedSymbols[index];
      final profile = defaultSymbolProfileFor(symbol);
      if (profile == null) {
        continue;
      }
      signals.add(_rawSignalFor(profile, scenario: scenario, index: index));
    }

    final summaries = signals.map(_summaryForRawSignal).toList();
    final topBuy = summaries
        .where((row) => row.action == 'Buy Now' || row.action == 'Accumulate')
        .fold<DecisionSummary?>(null, (best, row) {
          if (best == null || row.opportunityScore > best.opportunityScore) {
            return row;
          }
          return best;
        });
    final topRisk = summaries
        .where(
          (row) =>
              row.action == 'Sell' ||
              row.action == 'Trim' ||
              row.action == 'Avoid',
        )
        .fold<DecisionSummary?>(null, (best, row) {
          if (best == null || row.riskPriority > best.riskPriority) {
            return row;
          }
          return best;
        });
    final counts = <String, int>{};
    for (final summary in summaries) {
      counts.update(summary.action, (value) => value + 1, ifAbsent: () => 1);
    }

    final snapshot = <String, Object?>{
      'asOf': asOf.toIso8601String(),
      'universeSize': fullUniverse.length,
      'returned': signals.length,
      'scenario': scenario,
      'topBuy': topBuy?.toJson(),
      'topRisk': topRisk?.toJson(),
      'actionCounts': counts,
    };
    final history = await _appendHistory(snapshot, limit: historyLimit);

    return {
      'asOf': asOf.toIso8601String(),
      'source': 'finance-oracle-backend-cache',
      'detail':
          'Generated from the configured free-layer universe and deterministic signal priors. Live price/fundamental adapters can replace these raw signals without changing the JS contract.',
      'universeSize': fullUniverse.length,
      'returned': signals.length,
      'scenario': scenario,
      'marketContext': _marketContextFor(summaries),
      'rawSignals': signals,
      'history': history,
      'actionCounts': counts,
      'portfolio': {
        'ownedTickers': ownedTickers.toList()..sort(),
        'ownedCount': ownedTickers.length,
      },
    };
  }

  Map<String, Object?> _rawSignalFor(
    DefaultSymbolProfile profile, {
    required String scenario,
    required int index,
  }) {
    final symbol = profile.symbol;
    final seed = _stableSeed('$symbol:$scenario');
    final isEtf = profile.isEtf || isCoreEtfSymbol(symbol);
    final momentum = _bounded(58 + profile.momentumBias + _noise(seed, 1, 20));
    final quality = _bounded(62 + profile.qualityBias + _noise(seed, 2, 18));
    final valuation = _bounded(
      55 + profile.valuationBias + _noise(seed, 3, 20),
    );
    final risk = _bounded(48 + profile.riskBias + _noise(seed, 4, 22));
    final growth = _bounded(50 + profile.growthBias + _noise(seed, 5, 24));
    final defensive = _bounded(
      45 + profile.defensiveBias + _noise(seed, 6, 20),
    );
    final credit = _bounded(35 + profile.creditBias + _noise(seed, 7, 22));
    final rates = _bounded(36 + profile.rateBias + _noise(seed, 8, 24));
    final breadth = _bounded(
      57 + profile.momentumBias / 2 + _noise(seed, 9, 18),
    );
    final relativeStrength = _bounded(momentum + _noise(seed, 10, 12));
    final residualStrength = _bounded(relativeStrength + _noise(seed, 11, 8));
    final revisionTrend = _bounded(
      58 + profile.growthBias / 2 + _noise(seed, 12, 18),
    );
    final realizedVol = _bounded(
      risk + (isEtf ? -10 : 0) + _noise(seed, 13, 10),
    );
    final impliedVol = _bounded(realizedVol + _noise(seed, 14, 12));
    final skewRisk = _bounded(risk + _noise(seed, 15, 14));
    final drawdownRisk = _bounded(
      risk + (100 - breadth) * 0.2 + _noise(seed, 16, 10),
    );
    final trend60 = _bounded(momentum + _noise(seed, 17, 8));

    return {
      'ticker': symbol,
      'name': profile.displayName,
      'assetType': isEtf ? 'ETF' : 'Stock',
      'sector': profile.sector,
      'industry': profile.industry,
      'style': _styleFor(profile, isEtf: isEtf),
      'trend20': _bounded(momentum + _noise(seed, 18, 12)),
      'trend60': trend60,
      'trend120': _bounded(trend60 + _noise(seed, 19, 10)),
      'relativeStrength': relativeStrength,
      'residualStrength': residualStrength,
      'revisionTrend': revisionTrend,
      'surpriseMomentum': _bounded(revisionTrend + _noise(seed, 20, 12)),
      'marginTrend': _bounded(quality + _noise(seed, 21, 10)),
      'revenueAcceleration': _bounded(growth + _noise(seed, 22, 10)),
      'freeCashFlowTrend': _bounded(quality + _noise(seed, 23, 12)),
      'quality': quality,
      'valuationSupport': valuation,
      'liquidity': _bounded(
        isEtf ? 90 + _noise(seed, 24, 8) : 76 + _noise(seed, 24, 18),
      ),
      'breadth': breadth,
      'impliedVolRank': impliedVol,
      'realizedVol': realizedVol,
      'skewRisk': skewRisk,
      'eventRisk': _bounded((isEtf ? 18 : 42) + _noise(seed, 25, 20)),
      'crowding': _bounded(
        momentum * 0.5 + growth * 0.3 + _noise(seed, 26, 16),
      ),
      'drawdownRisk': drawdownRisk,
      'creditSensitivity': credit,
      'rateSensitivity': rates,
      'growthSensitivity': growth,
      'defensiveScore': defensive,
      'universeRankSeed': index,
    };
  }

  Map<String, Object?> _marketContextFor(List<DecisionSummary> summaries) {
    if (summaries.isEmpty) {
      return {
        'regime': 'No universe loaded',
        'confidence': 0,
        'riskLevel': 'Unknown',
        'riskScore': 0,
        'breadth': 0,
        'volatilityPressure': 0,
        'creditStress': 0,
        'leadership': 'No leadership map available.',
        'liquidity': 'No cache coverage available.',
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      };
    }
    final averageRisk =
        summaries.fold<double>(0, (sum, row) => sum + row.riskScore) /
        summaries.length;
    final averageConfidence =
        summaries.fold<double>(0, (sum, row) => sum + row.confidence) /
        summaries.length;
    final buyCount = summaries
        .where((row) => row.action == 'Buy Now' || row.action == 'Accumulate')
        .length;
    final riskCount = summaries
        .where(
          (row) =>
              row.action == 'Sell' ||
              row.action == 'Trim' ||
              row.action == 'Avoid',
        )
        .length;
    final riskLevel = averageRisk >= 68
        ? 'High'
        : averageRisk >= 54
        ? 'Moderate'
        : 'Constructive';
    return {
      'regime': buyCount >= riskCount
          ? 'Opportunity led, risk aware'
          : 'Defensive, deterioration led',
      'confidence': averageConfidence.round(),
      'riskLevel': riskLevel,
      'riskScore': averageRisk.round(),
      'breadth': (buyCount / summaries.length * 100).round(),
      'volatilityPressure': (averageRisk * 0.9).round(),
      'creditStress': (riskCount / summaries.length * 100).round(),
      'leadership':
          'Generated across ${summaries.length} configured stocks and ETFs.',
      'liquidity':
          'Backend cache endpoint is reachable; live vendor coverage depends on synced free-layer history.',
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
  }

  Future<List<Object?>> _appendHistory(
    Map<String, Object?> snapshot, {
    required int limit,
  }) async {
    final file = File(
      '${cacheDirectory.path}${Platform.pathSeparator}decision_history.json',
    );
    var entries = <Object?>[];
    if (await file.exists()) {
      try {
        final decoded = jsonDecode(await file.readAsString());
        if (decoded is List) {
          entries = decoded;
        }
      } catch (_) {
        entries = <Object?>[];
      }
    }
    entries.add(snapshot);
    final trimmed = entries.length > 48
        ? entries.sublist(entries.length - 48)
        : entries;
    await file.writeAsString(jsonEncode(trimmed), flush: true);
    final requested = limit.clamp(1, 48);
    return trimmed.reversed.take(requested).toList();
  }

  Set<String> _splitSymbols(String? raw) {
    if (raw == null || raw.trim().isEmpty) {
      return const {};
    }
    return raw
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .where((value) => value.isNotEmpty)
        .toSet();
  }

  String _styleFor(DefaultSymbolProfile profile, {required bool isEtf}) {
    if (isEtf) {
      return profile.industry;
    }
    if (profile.growthBias >= 8) {
      return 'Growth leadership';
    }
    if (profile.defensiveBias >= 8) {
      return 'Defensive compounder';
    }
    if (profile.valuationBias >= 6) {
      return 'Value/cyclical';
    }
    if (profile.qualityBias >= 6) {
      return 'Quality';
    }
    return profile.sector;
  }

  double _bounded(num value) => value.clamp(0, 100).toDouble();

  double _noise(int seed, int salt, double spread) {
    final mixed = _stableSeed('$seed:$salt');
    final unit = (mixed % 10000) / 10000.0;
    return (unit * 2 - 1) * spread;
  }

  int _stableSeed(String input) {
    const offset = 0x811c9dc5;
    const prime = 0x01000193;
    var hash = offset;
    for (final unit in input.codeUnits) {
      hash ^= unit;
      hash = (hash * prime) & 0x7fffffff;
    }
    return hash;
  }
}

class DecisionSummary {
  const DecisionSummary({
    required this.ticker,
    required this.action,
    required this.opportunityScore,
    required this.confidence,
    required this.riskScore,
    required this.fragilityScore,
    required this.thesisDamage,
  });

  final String ticker;
  final String action;
  final int opportunityScore;
  final int confidence;
  final int riskScore;
  final int fragilityScore;
  final int thesisDamage;

  double get riskPriority {
    final actionPenalty = switch (action) {
      'Sell' => 28,
      'Trim' => 18,
      'Avoid' => 12,
      _ => 0,
    };
    return thesisDamage * 0.45 +
        riskScore * 0.3 +
        fragilityScore * 0.18 +
        actionPenalty;
  }

  Map<String, Object?> toJson() {
    return {
      'ticker': ticker,
      'action': action,
      'opportunityScore': opportunityScore,
      'confidence': confidence,
      'riskScore': riskScore,
      'fragilityScore': fragilityScore,
      'thesisDamage': thesisDamage,
      'riskPriority': riskPriority,
    };
  }
}

DecisionSummary _summaryForRawSignal(Map<String, Object?> raw) {
  final trendQuality =
      _num(raw['trend20']) * 0.25 +
      _num(raw['trend60']) * 0.35 +
      _num(raw['trend120']) * 0.4;
  final fundamentalDirection =
      _num(raw['revisionTrend']) * 0.32 +
      _num(raw['surpriseMomentum']) * 0.18 +
      _num(raw['marginTrend']) * 0.16 +
      _num(raw['revenueAcceleration']) * 0.18 +
      _num(raw['freeCashFlowTrend']) * 0.16;
  final regimeFit = _clamp(
    trendQuality * 0.23 +
        _num(raw['relativeStrength']) * 0.18 +
        _num(raw['residualStrength']) * 0.16 +
        _num(raw['breadth']) * 0.14 +
        _num(raw['growthSensitivity']) * 0.12 +
        _num(raw['defensiveScore']) * 0.07 +
        (100 - _num(raw['creditSensitivity'])) * 0.05 +
        (100 - _num(raw['rateSensitivity'])) * 0.05,
  );
  final fragility = _clamp(
    _num(raw['impliedVolRank']) * 0.2 +
        _num(raw['skewRisk']) * 0.18 +
        _num(raw['crowding']) * 0.18 +
        _num(raw['drawdownRisk']) * 0.2 +
        _num(raw['eventRisk']) * 0.12 +
        (100 - _num(raw['breadth'])) * 0.12,
  );
  final risk = _clamp(
    fragility * 0.45 +
        _num(raw['realizedVol']) * 0.15 +
        _num(raw['creditSensitivity']) * 0.12 +
        _num(raw['rateSensitivity']) * 0.08 +
        _num(raw['eventRisk']) * 0.1 +
        (100 - _num(raw['liquidity'])) * 0.1,
  );
  final opportunity = _clamp(
    trendQuality * 0.19 +
        _num(raw['relativeStrength']) * 0.14 +
        _num(raw['residualStrength']) * 0.14 +
        fundamentalDirection * 0.18 +
        _num(raw['quality']) * 0.11 +
        _num(raw['valuationSupport']) * 0.08 +
        regimeFit * 0.12 +
        _num(raw['breadth']) * 0.08 -
        risk * 0.05 -
        fragility * 0.04,
  );
  final agreement = [
    trendQuality,
    _num(raw['relativeStrength']),
    _num(raw['residualStrength']),
    fundamentalDirection,
    _num(raw['quality']),
    _num(raw['breadth']),
    100 - risk,
  ];
  final average = agreement.reduce((a, b) => a + b) / agreement.length;
  final dispersion =
      agreement.fold<double>(0, (sum, value) => sum + (value - average).abs()) /
      agreement.length;
  final confidence = _clamp(
    average * 0.72 + _num(raw['liquidity']) * 0.12 + (100 - dispersion) * 0.16,
  );
  final thesisDamage = _clamp(
    (100 - _num(raw['relativeStrength'])) * 0.24 +
        (100 - _num(raw['residualStrength'])) * 0.18 +
        (100 - _num(raw['revisionTrend'])) * 0.16 +
        risk * 0.22 +
        fragility * 0.2,
  );
  return DecisionSummary(
    ticker: raw['ticker'] as String? ?? '',
    action: _classifyAction(
      opportunity: opportunity,
      confidence: confidence,
      risk: risk,
      regimeFit: regimeFit,
      thesisDamage: thesisDamage,
    ),
    opportunityScore: opportunity.round(),
    confidence: confidence.round(),
    riskScore: risk.round(),
    fragilityScore: fragility.round(),
    thesisDamage: thesisDamage.round(),
  );
}

String _classifyAction({
  required double opportunity,
  required double confidence,
  required double risk,
  required double regimeFit,
  required double thesisDamage,
}) {
  if (thesisDamage >= 58 && risk >= 56) return 'Sell';
  if (thesisDamage >= 54 || (risk >= 58 && opportunity < 66)) return 'Trim';
  if (risk >= 70 && opportunity < 60) return 'Avoid';
  if (opportunity >= 74 && confidence >= 68 && regimeFit >= 62 && risk <= 55) {
    return 'Buy Now';
  }
  if (opportunity >= 68 && confidence >= 62 && risk <= 64) {
    return 'Accumulate';
  }
  if (opportunity < 54 && regimeFit < 52) return 'Avoid';
  return 'Hold';
}

double _num(Object? value) {
  if (value is num) {
    return value.toDouble();
  }
  return 0;
}

double _clamp(num value) => value.clamp(0, 100).toDouble();
