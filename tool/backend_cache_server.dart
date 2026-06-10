import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
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
    unawaited(_warmUpUniverse());
    await for (final request in server) {
      unawaited(_handleRequest(request));
    }
  }

  /// Warms the decision universe in the background so a freshly started
  /// server is useful immediately instead of returning 0 scoreable names
  /// until someone manually clicks "Sync prices". Each pass syncs up to
  /// 96 symbols through the same code path the HTTP route uses; passes
  /// continue until coverage stops improving.
  Future<void> _warmUpUniverse() async {
    try {
      var previousReturned = -1;
      // 24 passes × 96 symbols comfortably covers the full universe even
      // with per-symbol failures; the no-progress break exits earlier.
      for (var pass = 1; pass <= 24; pass++) {
        final result = await DecisionUniverseService(
          config.cacheDirectory,
          cache: _cache,
        ).build(
          Uri.parse(
            '/decision/universe?limit=0&historyLimit=0&sync=force&syncLimit=96',
          ),
        );
        final returned = (result['returned'] as num?)?.toInt() ?? 0;
        final universe = (result['universeSize'] as num?)?.toInt() ?? 0;
        stdout.writeln(
          'Universe warmup pass $pass: $returned/$universe symbols scoreable',
        );
        if (returned >= universe || returned == previousReturned) {
          stdout.writeln('Universe warmup complete.');
          break;
        }
        previousReturned = returned;
      }
      // Each pass above queued EDGAR fundamentals for its scoreable stocks;
      // wait for that queue to drain so boot ends with fundamentals ready.
      final fundamentals = SecFundamentalsService.instance(_cache);
      await fundamentals.ensureWarm(const []);
      stdout.writeln(
        'EDGAR fundamentals ready: ${fundamentals.coveredCount}/'
        '${fundamentals.attemptedCount} stocks with computed metrics.',
      );
    } catch (error) {
      // Warmup is best-effort; the HTTP routes still work without it.
      stdout.writeln('Universe warmup stopped: $error');
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
            cache: _cache,
          ).build(request.uri),
        );
        return;
      }
      if (path == '/ml/model') {
        // Trained-model store: the backtest CLI PUTs the walk-forward-
        // validated model bundle here; app instances (dev browser AND the
        // packaged desktop app) adopt it on boot when it is newer than
        // their IndexedDB copy. One retrain reaches every surface.
        final modelFile = File(
          '${config.cacheDirectory.path}${Platform.pathSeparator}ml_trained_model.json',
        );
        if (request.method == 'PUT') {
          final body = await utf8.decoder.bind(request).join();
          final decoded = jsonDecode(body);
          if (decoded is! Map || decoded['model'] == null) {
            request.response.statusCode = HttpStatus.badRequest;
            await _writeJson(request.response, {
              'error': 'invalid_model_payload',
              'detail': 'Expected a StoredMlModel-shaped JSON object.',
            });
            return;
          }
          await modelFile.writeAsString(body, flush: true);
          await _writeJson(request.response, {
            'ok': true,
            'bytes': body.length,
            'trainedAt': decoded['trainedAt'],
          });
          return;
        }
        if (!await modelFile.exists()) {
          request.response.statusCode = HttpStatus.notFound;
          await _writeJson(request.response, {
            'error': 'no_model',
            'detail':
                'No trained model stored yet. Run the backtest CLI with '
                '--persist or train in the app\'s Model Lab.',
          });
          return;
        }
        request.response.headers.set(
          HttpHeaders.contentTypeHeader,
          'application/json; charset=utf-8',
        );
        await request.response.addStream(modelFile.openRead());
        await request.response.close();
        return;
      }
      if (path == '/fundamentals/history') {
        final symbol =
            request.uri.queryParameters['symbol']?.trim().toUpperCase() ?? '';
        final payload = symbol.isEmpty
            ? null
            : await SecFundamentalsService.instance(
                _cache,
              ).historyFor(symbol);
        if (payload == null) {
          request.response.statusCode = HttpStatus.notFound;
          await _writeJson(request.response, {
            'error': 'fundamentals_not_available',
            'detail':
                'No SEC companyfacts for "$symbol" — ETFs and non-SEC '
                'filers have no XBRL filings.',
          });
        } else {
          await _writeJson(request.response, payload);
        }
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

    // Forward the inbound Authorization + Accept headers so hosts that
    // care (Tradier auths via Bearer; Tradier returns XML by default
    // unless you ask for JSON via Accept) get what the caller intended.
    final authHeader = request.headers.value(HttpHeaders.authorizationHeader);
    final acceptHeader = request.headers.value(HttpHeaders.acceptHeader);
    final entry = await _cache.fetch(
      target,
      authHeader: authHeader,
      acceptHeader: acceptHeader,
    );
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
      'GET, PUT, OPTIONS',
    );
    response.headers.set(
      HttpHeaders.accessControlAllowHeadersHeader,
      'Accept, Authorization, Content-Type',
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
    'sandbox.tradier.com',
    'api.tradier.com',
  };

  bool isAllowed(Uri uri) {
    final host = uri.host.toLowerCase();
    return (uri.scheme == 'https' || uri.scheme == 'http') &&
        _allowedHosts.contains(host);
  }

  Future<CachedProxyResponse> fetch(
    Uri uri, {
    String? authHeader,
    String? acceptHeader,
  }) async {
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
      final fresh = await _fetchNetwork(
        uri,
        policy,
        authHeader: authHeader,
        acceptHeader: acceptHeader,
      );
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

  Future<_StoredCacheEntry> _fetchNetwork(
    Uri uri,
    _CachePolicy policy, {
    String? authHeader,
    String? acceptHeader,
  }) async {
    final request = await _client.getUrl(uri).timeout(policy.timeout);
    request.headers.set(
      HttpHeaders.acceptHeader,
      acceptHeader != null && acceptHeader.isNotEmpty ? acceptHeader : '*/*',
    );
    request.headers.set(
      HttpHeaders.userAgentHeader,
      // SEC fair-access policy requires the User-Agent to identify the
      // requester with a contact address (https://www.sec.gov/os/accessing-
      // edgar-data); generic UAs get 403 "Request Rate Threshold Exceeded".
      uri.host.toLowerCase().endsWith('sec.gov')
          ? 'FinanceOracleWorkstation/1.0 (personal research; '
                'joshua.j.vertalka@gmail.com)'
          : 'FinanceOracleLocalCache/1.0 (${Platform.operatingSystem})',
    );
    if (authHeader != null && authHeader.isNotEmpty) {
      request.headers.set(HttpHeaders.authorizationHeader, authHeader);
    }
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
      if (path.contains('/api/xbrl/companyfacts/')) {
        // Fundamentals change on filing cadence (10-Q every ~90 days), and
        // these payloads are megabytes each across hundreds of tickers; a
        // 7-day TTL keeps us at most a week behind a new filing without
        // re-pulling gigabytes from SEC daily.
        return const _CachePolicy(
          ttl: Duration(days: 7),
          timeout: Duration(seconds: 20),
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
  DecisionUniverseService(this.cacheDirectory, {required MarketDataCache cache})
    : _cache = cache,
      _priceStore = DecisionPriceHistoryStore(cacheDirectory);

  final Directory cacheDirectory;
  final MarketDataCache _cache;
  final DecisionPriceHistoryStore _priceStore;

  Future<Map<String, Object?>> build(Uri uri) async {
    await cacheDirectory.create(recursive: true);
    final asOf = DateTime.now().toUtc();
    final scenario = uri.queryParameters['scenario'] ?? 'base';
    final limit = int.tryParse(uri.queryParameters['limit'] ?? '0') ?? 0;
    final historyLimit =
        int.tryParse(uri.queryParameters['historyLimit'] ?? '8') ?? 8;
    final syncMode = uri.queryParameters['sync'] ?? 'auto';
    final syncLimit =
        int.tryParse(uri.queryParameters['syncLimit'] ?? '') ??
        (syncMode == 'force' ? 96 : 24);
    final ownedTickers = _splitSymbols(uri.queryParameters['owned']);
    final watchTickers = _splitSymbols(uri.queryParameters['watch']);
    final fullUniverse = kDefaultSymbolUniverse;
    final selectedSymbols = limit > 0
        ? fullUniverse.take(limit).toList()
        : fullUniverse;

    var priceState = await _priceStore.load();
    final syncResult = await _maybeSyncPriceHistory(
      state: priceState,
      symbols: fullUniverse,
      syncMode: syncMode,
      syncLimit: syncLimit,
      now: asOf,
    );
    priceState = syncResult.state;
    final analytics = DecisionPriceAnalytics.build(
      priceState,
      selectedSymbols: selectedSymbols,
    );
    final signals = <Map<String, Object?>>[];

    for (var index = 0; index < selectedSymbols.length; index++) {
      final symbol = selectedSymbols[index];
      final profile = defaultSymbolProfileFor(symbol);
      if (profile == null) {
        continue;
      }
      final rawSignal = _rawSignalFor(
        profile,
        analytics: analytics,
        scenario: scenario,
        index: index,
      );
      if (rawSignal != null) {
        signals.add(rawSignal);
      }
    }

    // SEC EDGAR fundamentals: fill quality/value/growth fields with
    // cross-sectionally ranked XBRL metrics for whatever stocks have been
    // computed so far, and queue a background warm for stale/missing ones.
    // Uncovered names keep neutral values — never simulated (CLAUDE.md).
    final fundamentalsService = SecFundamentalsService.instance(_cache);
    unawaited(
      fundamentalsService.ensureWarm([
        for (final signal in signals)
          if (signal['assetType'] != 'ETF') signal['ticker'] as String,
      ]),
    );
    final fundamentalsCoverage = fundamentalsService.overlayOnSignals(
      signals,
      isFullUniverse: limit <= 0,
    );

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
      'priceCoverage': analytics.coverage.toJson(),
    };
    final history = await _appendHistory(snapshot, limit: historyLimit);

    return {
      'asOf': asOf.toIso8601String(),
      'source': 'finance-oracle-backend-cache',
      'detail': signals.isNotEmpty
          ? 'Decision signals use cached OHLCV for trend, volatility, liquidity, breadth, drawdown, and relative strength. SEC EDGAR XBRL fundamentals cover $fundamentalsCoverage of ${signals.length} names (quality, margin trend, free cash flow, revenue acceleration, valuation — ranked cross-sectionally with sector adjustment). Estimate revisions and listed-options feeds are not connected, so those fields stay neutral/proxied instead of simulated.'
          : 'Recommendations paused: no symbols have enough fresh cached OHLCV to support Buy/Hold/Sell decisions. Run Sync prices and wait for usable price coverage.',
      'universeSize': fullUniverse.length,
      'returned': signals.length,
      'excludedForInsufficientData': fullUniverse.length - signals.length,
      'fundamentalsCoverage': fundamentalsCoverage,
      'scenario': scenario,
      'marketContext': _marketContextFor(summaries, analytics),
      'rawSignals': signals,
      'history': history,
      'actionCounts': counts,
      'priceCoverage': analytics.coverage.toJson(),
      'sync': syncResult.toJson(),
      'portfolio': {
        'ownedTickers': ownedTickers.toList()..sort(),
        'ownedCount': ownedTickers.length,
        'watchTickers': watchTickers.toList()..sort(),
        'watchCount': watchTickers.length,
      },
    };
  }

  Future<DecisionPriceSyncResult> _maybeSyncPriceHistory({
    required DecisionPriceHistoryState state,
    required List<String> symbols,
    required String syncMode,
    required int syncLimit,
    required DateTime now,
  }) async {
    if (syncMode == 'off' || syncLimit <= 0) {
      return DecisionPriceSyncResult.skipped(state: state, mode: syncMode);
    }
    final force = syncMode == 'force' || syncMode == '1' || syncMode == 'true';
    final staleBefore = now.subtract(const Duration(hours: 18));
    final candidates = symbols.where((symbol) {
      final series = state.seriesBySymbol[symbol];
      if (series == null) {
        return true;
      }
      return force || series.fetchedAt.isBefore(staleBefore);
    }).toList();

    final order = <String, int>{
      for (var index = 0; index < symbols.length; index++)
        symbols[index]: index,
    };
    candidates.sort((left, right) {
      final leftDate = state.seriesBySymbol[left]?.fetchedAt;
      final rightDate = state.seriesBySymbol[right]?.fetchedAt;
      if (leftDate == null && rightDate == null) {
        return (order[left] ?? 0).compareTo(order[right] ?? 0);
      }
      if (leftDate == null) return -1;
      if (rightDate == null) return 1;
      return leftDate.compareTo(rightDate);
    });

    final requested = candidates
        .take(syncLimit.clamp(0, symbols.length))
        .toList();
    if (requested.isEmpty) {
      return DecisionPriceSyncResult.skipped(state: state, mode: syncMode);
    }

    final startedAt = DateTime.now().toUtc();
    final updated = <String>[];
    final failed = <String>[];
    final nextSeries = Map<String, DecisionPriceSeries>.from(
      state.seriesBySymbol,
    );

    for (var offset = 0; offset < requested.length; offset += 8) {
      final chunk = requested.skip(offset).take(8).toList();
      final results = await Future.wait(
        chunk.map((symbol) async {
          final series = await _fetchYahooSeries(symbol, now);
          return MapEntry(symbol, series);
        }),
      );
      for (final result in results) {
        if (result.value == null) {
          failed.add(result.key);
        } else {
          nextSeries[result.key] = result.value!;
          updated.add(result.key);
        }
      }
    }

    final nextState = DecisionPriceHistoryState(
      lastSyncAt: DateTime.now().toUtc(),
      seriesBySymbol: nextSeries,
    );
    await _priceStore.save(nextState);
    return DecisionPriceSyncResult(
      state: nextState,
      mode: syncMode,
      requested: requested.length,
      updated: updated.length,
      failed: failed.length,
      updatedSymbols: updated.take(12).toList(),
      failedSymbols: failed.take(12).toList(),
      durationMs: DateTime.now().toUtc().difference(startedAt).inMilliseconds,
    );
  }

  Future<DecisionPriceSeries?> _fetchYahooSeries(
    String symbol,
    DateTime fetchedAt,
  ) async {
    try {
      final uri = Uri.parse(
        'https://query1.finance.yahoo.com/v8/finance/chart/${Uri.encodeComponent(_toYahooSymbol(symbol))}?interval=1d&range=18mo',
      );
      final response = await _cache.fetch(uri);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return null;
      }
      final body = utf8.decode(response.body, allowMalformed: true);
      return DecisionPriceSeries.fromYahooChart(
        symbol: symbol,
        fetchedAt: fetchedAt,
        body: body,
      );
    } catch (_) {
      return null;
    }
  }

  Map<String, Object?>? _rawSignalFor(
    DefaultSymbolProfile profile, {
    required DecisionPriceAnalytics analytics,
    required String scenario,
    required int index,
  }) {
    final symbol = profile.symbol;
    final isEtf = profile.isEtf || isCoreEtfSymbol(symbol);
    final metrics = analytics.metricsBySymbol[symbol];
    if (metrics == null ||
        metrics.barCount < 120 ||
        DateTime.now().toUtc().difference(metrics.priceAsOf).inDays > 10) {
      return null;
    }
    final marketMetrics = analytics.marketMetrics;
    final sectorBenchmark = analytics.benchmarkFor(profile.sector);
    final sectorBreadth = analytics.sectorBreadthBySector[profile.sector];

    final relativeStrength = metrics.relativeStrengthScore(marketMetrics);
    final residualStrength = metrics.relativeStrengthScore(sectorBenchmark);
    final impliedVol = _bounded(
      metrics.realizedVolScore * 0.7 + metrics.volatilityExpansionScore * 0.3,
    );
    final skewRisk = _bounded(
      metrics.drawdownRiskScore * 0.45 +
          metrics.downsideVolumePressure * 0.35 +
          metrics.volatilityExpansionScore * 0.2,
    );
    final dataWarnings = <String>{
      ...metrics.warnings,
      'Fundamental and estimate-revision fields are neutral because real feeds are not connected yet.',
      'Listed-options skew and term structure are not connected; options fields use OHLCV-derived proxies only.',
    }.toList();
    const neutral = 50.0;

    return {
      'ticker': symbol,
      'name': profile.displayName,
      'assetType': isEtf ? 'ETF' : 'Stock',
      'sector': profile.sector,
      'industry': profile.industry,
      'style': _styleFor(profile, isEtf: isEtf),
      'trend20': metrics.trend20Score,
      'trend60': metrics.trend60Score,
      'trend120': metrics.trend120Score,
      'relativeStrength': relativeStrength,
      'residualStrength': residualStrength,
      'revisionTrend': neutral,
      'surpriseMomentum': neutral,
      'marginTrend': neutral,
      'revenueAcceleration': neutral,
      'freeCashFlowTrend': neutral,
      'quality': neutral,
      'valuationSupport': neutral,
      'liquidity': metrics.liquidityScore,
      'breadth': sectorBreadth ?? metrics.breadthScore,
      'impliedVolRank': impliedVol,
      'realizedVol': metrics.realizedVolScore,
      'skewRisk': skewRisk,
      'eventRisk': isEtf ? 25.0 : neutral,
      'crowding': _bounded(
        metrics.trend60Score * 0.35 +
            relativeStrength * 0.35 +
            metrics.volumeTrendScore * 0.2 +
            metrics.breakoutQualityScore * 0.1,
      ),
      'drawdownRisk': metrics.drawdownRiskScore,
      'creditSensitivity': neutral,
      'rateSensitivity': neutral,
      'growthSensitivity': neutral,
      'defensiveScore': neutral,
      'universeRankSeed': index,
      'dataConfidence': math.min(metrics.dataConfidence, 78),
      'dataSource': '${metrics.source}-ohlcv',
      'dataWarnings': dataWarnings,
      'priceAsOf': metrics.priceAsOf.toIso8601String(),
      'historyBars': metrics.barCount,
      'lastPrice': metrics.lastPrice,
      'priceChange20d': metrics.return20d,
      'priceChange60d': metrics.return60d,
      'priceChange120d': metrics.return120d,
      'realizedVolatilityPct': metrics.annualVolatilityPct,
      'maxDrawdown60d': metrics.maxDrawdown60d,
      'volumeTrend': metrics.volumeTrendRatio,
      'downsideVolumePressure': metrics.downsideVolumePressure,
      'volatilityExpansion': metrics.volatilityExpansionScore,
      'optionsProxySource':
          'Free layer proxy: realized volatility, downside volume pressure, and volatility expansion from cached OHLCV. Listed-options skew/term-structure feed is not connected yet.',
    };
  }

  Map<String, Object?> _marketContextFor(
    List<DecisionSummary> summaries,
    DecisionPriceAnalytics analytics,
  ) {
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
    final breadth = analytics.coverage.usableSymbolCount > 0
        ? analytics.marketBreadth.round()
        : (buyCount / summaries.length * 100).round();
    final volatilityPressure = analytics.coverage.usableSymbolCount > 0
        ? analytics.averageVolatilityScore.round()
        : (averageRisk * 0.9).round();
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
      'breadth': breadth,
      'volatilityPressure': volatilityPressure,
      'creditStress': (riskCount / summaries.length * 100).round(),
      'leadership':
          'OHLCV coverage ${analytics.coverage.usableSymbolCount}/${summaries.length}; top buy/risk signals are regime-scored after price-history replacement.',
      'liquidity': analytics.coverage.usableSymbolCount > 0
          ? 'Using cached Yahoo Finance daily history through ${analytics.coverage.latestPriceDateLabel}. Fundamentals/options remain proxy fields.'
          : 'Backend cache is reachable; price-history sync has not produced usable coverage yet.',
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
}

class DecisionPriceHistoryStore {
  DecisionPriceHistoryStore(this.cacheDirectory);

  final Directory cacheDirectory;

  File get _file => File(
    '${cacheDirectory.path}${Platform.pathSeparator}decision_price_history.json',
  );

  Future<DecisionPriceHistoryState> load() async {
    if (!await _file.exists()) {
      return DecisionPriceHistoryState.empty();
    }
    try {
      final decoded = jsonDecode(await _file.readAsString());
      if (decoded is Map<String, dynamic>) {
        return DecisionPriceHistoryState.fromJson(decoded);
      }
    } catch (_) {
      return DecisionPriceHistoryState.empty();
    }
    return DecisionPriceHistoryState.empty();
  }

  Future<void> save(DecisionPriceHistoryState state) async {
    await cacheDirectory.create(recursive: true);
    await _file.writeAsString(jsonEncode(state.toJson()), flush: true);
  }
}

class DecisionPriceHistoryState {
  const DecisionPriceHistoryState({
    required this.lastSyncAt,
    required this.seriesBySymbol,
  });

  final DateTime? lastSyncAt;
  final Map<String, DecisionPriceSeries> seriesBySymbol;

  factory DecisionPriceHistoryState.empty() {
    return const DecisionPriceHistoryState(
      lastSyncAt: null,
      seriesBySymbol: <String, DecisionPriceSeries>{},
    );
  }

  Map<String, Object?> toJson() {
    return {
      'lastSyncAt': lastSyncAt?.toIso8601String(),
      'seriesBySymbol': {
        for (final entry in seriesBySymbol.entries)
          entry.key: entry.value.toJson(),
      },
    };
  }

  factory DecisionPriceHistoryState.fromJson(Map<String, dynamic> json) {
    final rawSeries = json['seriesBySymbol'];
    return DecisionPriceHistoryState(
      lastSyncAt: DateTime.tryParse(json['lastSyncAt'] as String? ?? ''),
      seriesBySymbol: rawSeries is Map<String, dynamic>
          ? rawSeries.map((key, value) {
              return MapEntry(
                key,
                DecisionPriceSeries.fromJson(value as Map<String, dynamic>),
              );
            })
          : <String, DecisionPriceSeries>{},
    );
  }
}

class DecisionPriceSeries {
  const DecisionPriceSeries({
    required this.symbol,
    required this.source,
    required this.fetchedAt,
    required this.bars,
  });

  final String symbol;
  final String source;
  final DateTime fetchedAt;
  final List<DecisionPriceBar> bars;

  Map<String, Object?> toJson() {
    return {
      'symbol': symbol,
      'source': source,
      'fetchedAt': fetchedAt.toIso8601String(),
      'bars': bars.map((bar) => bar.toJson()).toList(),
    };
  }

  factory DecisionPriceSeries.fromJson(Map<String, dynamic> json) {
    final bars =
        (json['bars'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(DecisionPriceBar.fromJson)
            .toList()
          ..sort((left, right) => left.date.compareTo(right.date));
    return DecisionPriceSeries(
      symbol: json['symbol'] as String? ?? '',
      source: json['source'] as String? ?? 'yahoo-finance',
      fetchedAt:
          DateTime.tryParse(json['fetchedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      bars: bars,
    );
  }

  factory DecisionPriceSeries.fromStooqCsv({
    required String symbol,
    required DateTime fetchedAt,
    required String body,
  }) {
    final lines = const LineSplitter().convert(body.trim());
    if (lines.length < 2 || !lines.first.toLowerCase().contains('date')) {
      throw const FormatException('Stooq response did not include OHLCV rows.');
    }
    final bars = <DecisionPriceBar>[];
    for (final line in lines.skip(1)) {
      final row = line.trim();
      if (row.isEmpty) continue;
      final parts = row.split(',');
      if (parts.length < 6) continue;
      final date = DateTime.tryParse(parts[0]);
      final open = double.tryParse(parts[1]);
      final high = double.tryParse(parts[2]);
      final low = double.tryParse(parts[3]);
      final close = double.tryParse(parts[4]);
      final volume = double.tryParse(parts[5]);
      if (date == null ||
          open == null ||
          high == null ||
          low == null ||
          close == null ||
          close <= 0 ||
          volume == null) {
        continue;
      }
      bars.add(
        DecisionPriceBar(
          date: date,
          open: open,
          high: high,
          low: low,
          close: close,
          volume: volume,
        ),
      );
    }
    bars.sort((left, right) => left.date.compareTo(right.date));
    if (bars.length < 5) {
      throw const FormatException('Stooq response had too few usable bars.');
    }
    return DecisionPriceSeries(
      symbol: symbol,
      source: 'stooq',
      fetchedAt: fetchedAt,
      bars: bars.length > 320 ? bars.sublist(bars.length - 320) : bars,
    );
  }

  factory DecisionPriceSeries.fromYahooChart({
    required String symbol,
    required DateTime fetchedAt,
    required String body,
  }) {
    final decoded = jsonDecode(body) as Map<String, dynamic>;
    final chart = decoded['chart'] as Map<String, dynamic>?;
    final result = chart?['result'];
    if (result is! List<dynamic> || result.isEmpty) {
      throw const FormatException('Yahoo chart response had no result rows.');
    }
    final entry = result.first as Map<String, dynamic>;
    final timestamps = (entry['timestamp'] as List<dynamic>? ?? const [])
        .whereType<num>()
        .map((value) => value.toInt())
        .toList();
    final indicators = entry['indicators'] as Map<String, dynamic>?;
    final quoteList = indicators?['quote'];
    if (timestamps.isEmpty ||
        quoteList is! List<dynamic> ||
        quoteList.isEmpty) {
      throw const FormatException('Yahoo chart response had no OHLCV rows.');
    }
    final quote = quoteList.first as Map<String, dynamic>;
    final bars = <DecisionPriceBar>[];
    for (var index = 0; index < timestamps.length; index++) {
      final close = _numberAt(quote['close'], index);
      if (close == null || close <= 0) {
        continue;
      }
      bars.add(
        DecisionPriceBar(
          date: DateTime.fromMillisecondsSinceEpoch(
            timestamps[index] * 1000,
            isUtc: true,
          ),
          open: _numberAt(quote['open'], index) ?? close,
          high: _numberAt(quote['high'], index) ?? close,
          low: _numberAt(quote['low'], index) ?? close,
          close: close,
          volume: _numberAt(quote['volume'], index) ?? 0,
        ),
      );
    }
    bars.sort((left, right) => left.date.compareTo(right.date));
    if (bars.length < 5) {
      throw const FormatException('Yahoo chart response had too few bars.');
    }
    return DecisionPriceSeries(
      symbol: symbol,
      source: 'yahoo-finance',
      fetchedAt: fetchedAt,
      bars: bars.length > 320 ? bars.sublist(bars.length - 320) : bars,
    );
  }
}

class DecisionPriceBar {
  const DecisionPriceBar({
    required this.date,
    required this.open,
    required this.high,
    required this.low,
    required this.close,
    required this.volume,
  });

  final DateTime date;
  final double open;
  final double high;
  final double low;
  final double close;
  final double volume;

  Map<String, Object?> toJson() {
    return {
      'date': date.toIso8601String(),
      'open': open,
      'high': high,
      'low': low,
      'close': close,
      'volume': volume,
    };
  }

  factory DecisionPriceBar.fromJson(Map<String, dynamic> json) {
    return DecisionPriceBar(
      date:
          DateTime.tryParse(json['date'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      open: _num(json['open']),
      high: _num(json['high']),
      low: _num(json['low']),
      close: _num(json['close']),
      volume: _num(json['volume']),
    );
  }
}

class DecisionPriceSyncResult {
  const DecisionPriceSyncResult({
    required this.state,
    required this.mode,
    required this.requested,
    required this.updated,
    required this.failed,
    required this.updatedSymbols,
    required this.failedSymbols,
    required this.durationMs,
  });

  final DecisionPriceHistoryState state;
  final String mode;
  final int requested;
  final int updated;
  final int failed;
  final List<String> updatedSymbols;
  final List<String> failedSymbols;
  final int durationMs;

  factory DecisionPriceSyncResult.skipped({
    required DecisionPriceHistoryState state,
    required String mode,
  }) {
    return DecisionPriceSyncResult(
      state: state,
      mode: mode,
      requested: 0,
      updated: 0,
      failed: 0,
      updatedSymbols: const <String>[],
      failedSymbols: const <String>[],
      durationMs: 0,
    );
  }

  Map<String, Object?> toJson() {
    return {
      'mode': mode,
      'requested': requested,
      'updated': updated,
      'failed': failed,
      'updatedSymbols': updatedSymbols,
      'failedSymbols': failedSymbols,
      'durationMs': durationMs,
      'lastSyncAt': state.lastSyncAt?.toIso8601String(),
    };
  }
}

class DecisionPriceAnalytics {
  const DecisionPriceAnalytics({
    required this.metricsBySymbol,
    required this.sectorBreadthBySector,
    required this.coverage,
    required this.marketMetrics,
    required this.averageVolatilityScore,
    required this.marketBreadth,
  });

  final Map<String, DecisionPriceMetrics> metricsBySymbol;
  final Map<String, double> sectorBreadthBySector;
  final DecisionPriceCoverage coverage;
  final DecisionPriceMetrics? marketMetrics;
  final double averageVolatilityScore;
  final double marketBreadth;

  factory DecisionPriceAnalytics.build(
    DecisionPriceHistoryState state, {
    required List<String> selectedSymbols,
  }) {
    final metricsBySymbol = <String, DecisionPriceMetrics>{};
    for (final symbol in selectedSymbols) {
      final series = state.seriesBySymbol[symbol];
      if (series == null) continue;
      final metrics = DecisionPriceMetrics.fromSeriesOrNull(series);
      if (metrics != null) {
        metricsBySymbol[symbol] = metrics;
      }
    }

    final sectorGroups = <String, List<DecisionPriceMetrics>>{};
    for (final entry in metricsBySymbol.entries) {
      final profile = defaultSymbolProfileFor(entry.key);
      if (profile == null) continue;
      sectorGroups.putIfAbsent(profile.sector, () => []).add(entry.value);
    }

    final sectorBreadth = <String, double>{};
    for (final entry in sectorGroups.entries) {
      sectorBreadth[entry.key] =
          entry.value.fold<double>(0, (sum, row) => sum + row.breadthScore) /
          entry.value.length;
    }

    final usableMetrics = metricsBySymbol.values
        .where((metrics) => metrics.dataConfidence >= 45)
        .toList();
    final totalBars = state.seriesBySymbol.values.fold<int>(
      0,
      (sum, series) => sum + series.bars.length,
    );
    final coverage = DecisionPriceCoverage.fromState(
      state,
      selectedSymbols: selectedSymbols,
      usableSymbols: usableMetrics.length,
      totalBars: totalBars,
    );
    final averageVolatility = usableMetrics.isEmpty
        ? 0.0
        : usableMetrics.fold<double>(
                0,
                (sum, metrics) => sum + metrics.realizedVolScore,
              ) /
              usableMetrics.length;
    final breadth = usableMetrics.isEmpty
        ? 0.0
        : usableMetrics.fold<double>(
                0,
                (sum, metrics) => sum + metrics.breadthScore,
              ) /
              usableMetrics.length;

    return DecisionPriceAnalytics(
      metricsBySymbol: metricsBySymbol,
      sectorBreadthBySector: sectorBreadth,
      coverage: coverage,
      marketMetrics: metricsBySymbol['SPY'] ?? metricsBySymbol['QQQ'],
      averageVolatilityScore: averageVolatility,
      marketBreadth: breadth,
    );
  }

  DecisionPriceMetrics? benchmarkFor(String sector) {
    final symbol = _sectorBenchmarkSymbols[sector] ?? 'SPY';
    return metricsBySymbol[symbol] ?? marketMetrics;
  }
}

class DecisionPriceCoverage {
  const DecisionPriceCoverage({
    required this.cachedSymbolCount,
    required this.usableSymbolCount,
    required this.freshSymbolCount,
    required this.staleSymbolCount,
    required this.totalBarCount,
    required this.latestPriceDate,
    required this.oldestPriceDate,
  });

  final int cachedSymbolCount;
  final int usableSymbolCount;
  final int freshSymbolCount;
  final int staleSymbolCount;
  final int totalBarCount;
  final DateTime? latestPriceDate;
  final DateTime? oldestPriceDate;

  String get latestPriceDateLabel =>
      latestPriceDate == null ? 'unknown' : _dateLabel(latestPriceDate!);

  factory DecisionPriceCoverage.fromState(
    DecisionPriceHistoryState state, {
    required List<String> selectedSymbols,
    required int usableSymbols,
    required int totalBars,
  }) {
    final now = DateTime.now().toUtc();
    final selectedSet = selectedSymbols.toSet();
    var fresh = 0;
    var stale = 0;
    DateTime? latest;
    DateTime? oldest;
    for (final entry in state.seriesBySymbol.entries) {
      if (!selectedSet.contains(entry.key) || entry.value.bars.isEmpty) {
        continue;
      }
      final date = entry.value.bars.last.date;
      if (now.difference(date).inDays <= 10) {
        fresh++;
      } else {
        stale++;
      }
      if (latest == null || date.isAfter(latest)) latest = date;
      if (oldest == null || date.isBefore(oldest)) oldest = date;
    }
    final cached = state.seriesBySymbol.keys
        .where((symbol) => selectedSet.contains(symbol))
        .length;
    return DecisionPriceCoverage(
      cachedSymbolCount: cached,
      usableSymbolCount: usableSymbols,
      freshSymbolCount: fresh,
      staleSymbolCount: stale,
      totalBarCount: totalBars,
      latestPriceDate: latest,
      oldestPriceDate: oldest,
    );
  }

  Map<String, Object?> toJson() {
    return {
      'cachedSymbolCount': cachedSymbolCount,
      'usableSymbolCount': usableSymbolCount,
      'freshSymbolCount': freshSymbolCount,
      'staleSymbolCount': staleSymbolCount,
      'totalBarCount': totalBarCount,
      'latestPriceDate': latestPriceDate?.toIso8601String(),
      'oldestPriceDate': oldestPriceDate?.toIso8601String(),
    };
  }
}

class DecisionPriceMetrics {
  const DecisionPriceMetrics({
    required this.symbol,
    required this.source,
    required this.priceAsOf,
    required this.barCount,
    required this.lastPrice,
    required this.return20d,
    required this.return60d,
    required this.return120d,
    required this.trend20Score,
    required this.trend60Score,
    required this.trend120Score,
    required this.breadthScore,
    required this.realizedVolScore,
    required this.annualVolatilityPct,
    required this.volatilityExpansionScore,
    required this.maxDrawdown60d,
    required this.drawdownRiskScore,
    required this.liquidityScore,
    required this.volumeTrendRatio,
    required this.volumeTrendScore,
    required this.downsideVolumePressure,
    required this.breakoutQualityScore,
    required this.dataConfidence,
    required this.warnings,
  });

  final String symbol;
  final String source;
  final DateTime priceAsOf;
  final int barCount;
  final double lastPrice;
  final double? return20d;
  final double? return60d;
  final double? return120d;
  final double trend20Score;
  final double trend60Score;
  final double trend120Score;
  final double breadthScore;
  final double realizedVolScore;
  final double annualVolatilityPct;
  final double volatilityExpansionScore;
  final double maxDrawdown60d;
  final double drawdownRiskScore;
  final double liquidityScore;
  final double volumeTrendRatio;
  final double volumeTrendScore;
  final double downsideVolumePressure;
  final double breakoutQualityScore;
  final double dataConfidence;
  final List<String> warnings;

  factory DecisionPriceMetrics.fromSeries(DecisionPriceSeries series) {
    final bars = series.bars.where((bar) => bar.close > 0).toList();
    if (bars.length < 5) {
      throw const FormatException('Not enough bars for metrics.');
    }
    return DecisionPriceMetrics._fromBars(series.symbol, series.source, bars);
  }

  static DecisionPriceMetrics? fromSeriesOrNull(DecisionPriceSeries series) {
    try {
      return DecisionPriceMetrics.fromSeries(series);
    } catch (_) {
      return null;
    }
  }

  factory DecisionPriceMetrics._fromBars(
    String symbol,
    String source,
    List<DecisionPriceBar> bars,
  ) {
    final latest = bars.last;
    final return20 = _returnOver(bars, 20);
    final return60 = _returnOver(bars, 60);
    final return120 = _returnOver(bars, 120);
    final annualVol = _annualizedVolatility(bars, 60);
    final annualVol20 = _annualizedVolatility(bars, 20);
    final drawdown60 = _maxDrawdown(bars, 60);
    final ma50 = _movingAverageClose(bars, 50);
    final ma200 = _movingAverageClose(bars, 200);
    final averageVolume20 = _averageVolume(bars, 20);
    final averageVolume60 = _averageVolume(bars, 60);
    final volumeRatio = averageVolume60 <= 0
        ? 1.0
        : averageVolume20 / averageVolume60;
    final dollarVolume = averageVolume20 * latest.close;
    final ageDays = DateTime.now().toUtc().difference(latest.date).inDays;
    final barScore = bars.length >= 180
        ? 100.0
        : bars.length >= 120
        ? 85.0
        : bars.length >= 60
        ? 65.0
        : bars.length >= 30
        ? 45.0
        : 25.0;
    final freshnessScore = ageDays <= 5
        ? 100.0
        : ageDays <= 10
        ? 84.0
        : ageDays <= 20
        ? 58.0
        : 32.0;
    final warnings = <String>[];
    if (bars.length < 120) {
      warnings.add('Short price history lowers model confidence.');
    }
    if (ageDays > 10) {
      warnings.add('Latest daily bar is stale.');
    }
    if (dollarVolume < 10000000) {
      warnings.add('Liquidity proxy is thin.');
    }
    return DecisionPriceMetrics(
      symbol: symbol,
      source: source,
      priceAsOf: latest.date,
      barCount: bars.length,
      lastPrice: latest.close,
      return20d: return20,
      return60d: return60,
      return120d: return120,
      trend20Score: _trendScore(return20, 20),
      trend60Score: _trendScore(return60, 60),
      trend120Score: _trendScore(return120, 120),
      breadthScore: _breadthScore(latest.close, ma50, ma200, return60),
      realizedVolScore: _bounded(annualVol * 1.25),
      annualVolatilityPct: annualVol,
      volatilityExpansionScore: _bounded(50 + (annualVol20 - annualVol) * 1.4),
      maxDrawdown60d: drawdown60,
      drawdownRiskScore: _bounded(drawdown60.abs() * 4.2),
      liquidityScore: _liquidityScore(dollarVolume),
      volumeTrendRatio: volumeRatio,
      volumeTrendScore: _bounded(50 + (volumeRatio - 1) * 75),
      downsideVolumePressure: _downsideVolumePressure(bars, 20),
      breakoutQualityScore: _breakoutQuality(bars, 60),
      dataConfidence: _bounded(barScore * 0.65 + freshnessScore * 0.35),
      warnings: warnings.isEmpty
          ? const <String>['Price-derived signals are backed by cached OHLCV.']
          : warnings,
    );
  }

  double relativeStrengthScore(DecisionPriceMetrics? benchmark) {
    if (benchmark == null) {
      return trend60Score;
    }
    final diff60 = (return60d ?? 0) - (benchmark.return60d ?? 0);
    final diff20 = (return20d ?? 0) - (benchmark.return20d ?? 0);
    return _bounded(50 + diff60 * 1.65 + diff20 * 1.05);
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
  final baseRisk = _clamp(
    fragility * 0.45 +
        _num(raw['realizedVol']) * 0.15 +
        _num(raw['creditSensitivity']) * 0.12 +
        _num(raw['rateSensitivity']) * 0.08 +
        _num(raw['eventRisk']) * 0.1 +
        (100 - _num(raw['liquidity'])) * 0.1,
  );
  final baseOpportunity = _clamp(
    trendQuality * 0.19 +
        _num(raw['relativeStrength']) * 0.14 +
        _num(raw['residualStrength']) * 0.14 +
        fundamentalDirection * 0.18 +
        _num(raw['quality']) * 0.11 +
        _num(raw['valuationSupport']) * 0.08 +
        regimeFit * 0.12 +
        _num(raw['breadth']) * 0.08 -
        baseRisk * 0.05 -
        fragility * 0.04,
  );
  final agreement = [
    trendQuality,
    _num(raw['relativeStrength']),
    _num(raw['residualStrength']),
    fundamentalDirection,
    _num(raw['quality']),
    _num(raw['breadth']),
    100 - baseRisk,
  ];
  final average = agreement.reduce((a, b) => a + b) / agreement.length;
  final dispersion =
      agreement.fold<double>(0, (sum, value) => sum + (value - average).abs()) /
      agreement.length;
  final baseConfidence = _clamp(
    average * 0.72 + _num(raw['liquidity']) * 0.12 + (100 - dispersion) * 0.16,
  );
  final dataConfidence = _numOr(raw['dataConfidence'], 65);
  final lowDataPenalty = math.max(0, 55 - dataConfidence);
  final risk = _clamp(baseRisk + lowDataPenalty * 0.12);
  final opportunity = _clamp(baseOpportunity - lowDataPenalty * 0.18);
  final confidence = _clamp(baseConfidence * 0.78 + dataConfidence * 0.22);
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

double _numOr(Object? value, double fallback) {
  if (value is num) {
    return value.toDouble();
  }
  return fallback;
}

double _clamp(num value) => value.clamp(0, 100).toDouble();

double _bounded(num value) => value.clamp(0, 100).toDouble();

const Map<String, String> _sectorBenchmarkSymbols = {
  'Technology': 'XLK',
  'Software': 'XLK',
  'Communications': 'XLC',
  'Consumer': 'XLY',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  'Healthcare': 'XLV',
  'Financials': 'XLF',
  'Energy': 'XLE',
  'Industrials': 'XLI',
  'Materials': 'XLB',
  'Real Estate': 'XLRE',
  'Utilities': 'XLU',
  'ETF / Macro': 'SPY',
  'Speculative Growth': 'QQQ',
};

String _toYahooSymbol(String symbol) {
  return symbol.toUpperCase().replaceAll('.', '-');
}

double? _numberAt(Object? values, int index) {
  if (values is! List<dynamic> || index >= values.length) {
    return null;
  }
  final value = values[index];
  if (value is num) {
    return value.toDouble();
  }
  return null;
}

String _dateLabel(DateTime date) {
  return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
}

double? _returnOver(List<DecisionPriceBar> bars, int tradingDays) {
  if (bars.length <= tradingDays) {
    return null;
  }
  final current = bars.last.close;
  final prior = bars[bars.length - 1 - tradingDays].close;
  if (prior <= 0) {
    return null;
  }
  return (current - prior) / prior * 100;
}

double _trendScore(double? returnPct, int horizon) {
  if (returnPct == null) {
    return 50;
  }
  final multiplier = switch (horizon) {
    <= 20 => 2.3,
    <= 60 => 1.15,
    _ => 0.68,
  };
  return _bounded(50 + returnPct * multiplier);
}

double _movingAverageClose(List<DecisionPriceBar> bars, int lookback) {
  if (bars.isEmpty) {
    return 0;
  }
  final slice = bars.length > lookback
      ? bars.sublist(bars.length - lookback)
      : bars;
  return slice.fold<double>(0, (sum, bar) => sum + bar.close) / slice.length;
}

double _averageVolume(List<DecisionPriceBar> bars, int lookback) {
  if (bars.isEmpty) {
    return 0;
  }
  final slice = bars.length > lookback
      ? bars.sublist(bars.length - lookback)
      : bars;
  return slice.fold<double>(0, (sum, bar) => sum + bar.volume) / slice.length;
}

double _annualizedVolatility(List<DecisionPriceBar> bars, int lookback) {
  if (bars.length < 3) {
    return 0;
  }
  final start = math.max(1, bars.length - lookback);
  final returns = <double>[];
  for (var index = start; index < bars.length; index++) {
    final prior = bars[index - 1].close;
    final current = bars[index].close;
    if (prior > 0 && current > 0) {
      returns.add(math.log(current / prior));
    }
  }
  if (returns.length < 2) {
    return 0;
  }
  final average = returns.reduce((a, b) => a + b) / returns.length;
  final variance =
      returns.fold<double>(
        0,
        (sum, value) => sum + math.pow(value - average, 2),
      ) /
      (returns.length - 1);
  return math.sqrt(variance) * math.sqrt(252) * 100;
}

double _maxDrawdown(List<DecisionPriceBar> bars, int lookback) {
  if (bars.isEmpty) {
    return 0;
  }
  final slice = bars.length > lookback
      ? bars.sublist(bars.length - lookback)
      : bars;
  var peak = slice.first.close;
  var maxDrawdown = 0.0;
  for (final bar in slice) {
    if (bar.close > peak) {
      peak = bar.close;
    }
    if (peak > 0) {
      final drawdown = (bar.close - peak) / peak * 100;
      if (drawdown < maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }
  return maxDrawdown.abs();
}

double _breadthScore(
  double close,
  double movingAverage50,
  double movingAverage200,
  double? return60,
) {
  var score = 35.0;
  if (movingAverage50 > 0 && close > movingAverage50) score += 25;
  if (movingAverage200 > 0 && close > movingAverage200) score += 20;
  if ((return60 ?? 0) > 0) score += 20;
  return _bounded(score);
}

double _liquidityScore(double dollarVolume) {
  if (dollarVolume <= 0) {
    return 20;
  }
  final logDollarVolume = math.log(dollarVolume) / math.ln10;
  return _bounded((logDollarVolume - 5.2) * 18);
}

double _downsideVolumePressure(List<DecisionPriceBar> bars, int lookback) {
  if (bars.length < 3) {
    return 50;
  }
  final slice = bars.length > lookback
      ? bars.sublist(bars.length - lookback)
      : bars;
  var downsideVolume = 0.0;
  var downsideCount = 0;
  var totalVolume = 0.0;
  for (var index = 1; index < slice.length; index++) {
    final volume = slice[index].volume;
    totalVolume += volume;
    if (slice[index].close < slice[index - 1].close) {
      downsideVolume += volume;
      downsideCount++;
    }
  }
  if (totalVolume <= 0 || slice.length <= 1) {
    return 50;
  }
  final downsideShare = downsideVolume / totalVolume;
  final dayShare = downsideCount / (slice.length - 1);
  return _bounded(35 + downsideShare * 55 + dayShare * 20);
}

double _breakoutQuality(List<DecisionPriceBar> bars, int lookback) {
  if (bars.isEmpty) {
    return 50;
  }
  final slice = bars.length > lookback
      ? bars.sublist(bars.length - lookback)
      : bars;
  final high = slice.fold<double>(
    0,
    (current, bar) => math.max(current, bar.high),
  );
  if (high <= 0) {
    return 50;
  }
  final distanceFromHigh = (bars.last.close / high - 1) * 100;
  return _bounded(82 + distanceFromHigh * 3.4);
}

/// SEC EDGAR XBRL fundamentals.
///
/// Pulls point-in-time facts from the official companyfacts API, reduces
/// them to trailing-twelve-month metrics, and fills the decision universe's
/// fundamental fields with cross-sectional percentile ranks. Symbols without
/// computed fundamentals (ETFs, non-SEC filers, not-yet-warmed names) keep
/// their neutral values — never simulated.
///
/// Sources (both already on the proxy allowlist):
///   - https://www.sec.gov/files/company_tickers.json          ticker -> CIK
///   - https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json  all facts
///
/// Metric direction follows the published factor literature:
///   - profitability/quality: Novy-Marx (2013, JFE); Asness-Frazzini-
///     Pedersen "Quality Minus Junk" (2019, RAS) — and like QMJ, ranks are
///     industry-adjusted (averaged with within-sector ranks when the sector
///     has enough names).
///   - value as earnings yield: Basu (1977, JF).
///   - leverage penalty: Fama-French (1992, JF) leverage/distress loadings.
///   - net share issuance penalty: Pontiff-Woodgate (2008, JF).
class SecFundamentalsService {
  SecFundamentalsService._(this._cache);

  static SecFundamentalsService? _singleton;

  /// Process-wide instance so computed metrics survive across requests
  /// (DecisionUniverseService is constructed per request).
  factory SecFundamentalsService.instance(MarketDataCache cache) =>
      _singleton ??= SecFundamentalsService._(cache);

  final MarketDataCache _cache;
  final Map<String, _SymbolFundamentals?> _bySymbol = {};
  final Map<String, DateTime> _computedAt = {};
  final Set<String> _queue = {};
  Future<void>? _drain;
  Map<String, String>? _cikByTicker;
  bool _lastFetchTouchedNetwork = false;

  /// Companyfacts changes only when a company files (10-Q cadence is ~90
  /// days), so re-parsing daily is plenty; the network TTL is governed by
  /// _CachePolicy (7 days for companyfacts).
  static const Duration _recomputeAfter = Duration(hours: 24);

  /// SEC fair-access guidance caps clients at 10 req/s; pause only after
  /// real network fetches so cache-hit re-warms stay fast.
  static const Duration _politePause = Duration(milliseconds: 150);

  static const List<String> _revenueConcepts = [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ];
  static const List<String> _netIncomeConcepts = [
    'NetIncomeLoss',
    'ProfitLoss',
  ];
  static const List<String> _operatingCashFlowConcepts = [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ];
  static const List<String> _capexConcepts = [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ];
  static const List<String> _equityConcepts = [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ];
  static const List<String> _shareFallbackConcepts = [
    'CommonStockSharesOutstanding',
    'WeightedAverageNumberOfDilutedSharesOutstanding',
  ];

  int get coveredCount => _bySymbol.values.where((f) => f != null).length;
  int get attemptedCount => _computedAt.length;

  /// Queue stale/missing symbols and return a future that completes when
  /// the queue is drained. Safe to call repeatedly: symbols queued while a
  /// drain is running are handled by that same drain.
  Future<void> ensureWarm(Iterable<String> symbols) {
    final now = DateTime.now().toUtc();
    for (final symbol in symbols) {
      final at = _computedAt[symbol];
      if (at == null || now.difference(at) > _recomputeAfter) {
        _queue.add(symbol);
      }
    }
    if (_queue.isEmpty) {
      return _drain ?? Future<void>.value();
    }
    return _drain ??= _drainQueue().whenComplete(() => _drain = null);
  }

  Future<void> _drainQueue() async {
    var attempted = 0;
    var computed = 0;
    while (_queue.isNotEmpty) {
      final symbol = _queue.first;
      _queue.remove(symbol);
      attempted++;
      try {
        final fundamentals = await _compute(symbol);
        _bySymbol[symbol] = fundamentals;
        if (fundamentals != null) {
          computed++;
        }
      } catch (_) {
        // Best-effort: leave the symbol uncovered (fields stay neutral);
        // it is retried after _recomputeAfter.
      }
      _computedAt[symbol] = DateTime.now().toUtc();
      if (_lastFetchTouchedNetwork) {
        await Future<void>.delayed(_politePause);
      }
    }
    if (attempted > 0) {
      stdout.writeln(
        'EDGAR fundamentals: computed $computed/$attempted symbols this pass '
        '($coveredCount covered total)',
      );
    }
  }

  /// Ranks from the most recent full-universe build, reused for limited
  /// builds so a symbol's percentile never depends on the request's
  /// `limit` parameter.
  Map<String, Map<String, double>> _lastFullRanks = {};

  /// Fill fundamental fields of stock raw-signals in place; returns how
  /// many symbols got at least one field. Must run BEFORE the signals are
  /// scored so the filled values flow into composites. [isFullUniverse]
  /// marks builds whose cross-section spans the whole scored universe;
  /// those refresh the stored ranks that limited builds reuse.
  int overlayOnSignals(
    List<Map<String, Object?>> signals, {
    required bool isFullUniverse,
  }) {
    final eligible = [
      for (final signal in signals)
        if (signal['assetType'] != 'ETF') signal,
    ];
    if (eligible.isEmpty) {
      return 0;
    }
    final sectorBySymbol = <String, String>{
      for (final signal in eligible)
        signal['ticker'] as String: (signal['sector'] as String?) ?? 'Unknown',
    };

    // Gather raw metric vectors across the covered cross-section.
    final values = <String, Map<String, double>>{};
    for (final signal in eligible) {
      final symbol = signal['ticker'] as String;
      final fund = _bySymbol[symbol];
      if (fund == null) {
        continue;
      }
      void put(String metric, double? value) {
        if (value != null && value.isFinite) {
          (values[metric] ??= {})[symbol] = value;
        }
      }

      put('revGrowth', fund.revenueGrowthYoYPct);
      put('revAccel', fund.revenueAccelPp);
      put('margin', fund.netMarginPct);
      put('marginTrend', fund.marginTrendPp);
      put('fcfMargin', fund.fcfMarginPct);
      put('leverage', fund.leveragePct);
      put('roe', fund.roePct);
      put('shareChange', fund.shareChangeYoYPct);
      final lastPrice = (signal['lastPrice'] as num?)?.toDouble();
      final shares = fund.sharesOutstanding;
      final ttmNetIncome = fund.ttmNetIncomeUsd;
      if (lastPrice != null &&
          lastPrice > 0 &&
          shares != null &&
          shares > 0 &&
          ttmNetIncome != null) {
        // Basu (1977): earnings yield E/P, computed against live price.
        put('earningsYield', ttmNetIncome / (lastPrice * shares) * 100);
      }
    }

    // Cross-sectional ranks need breadth to mean anything; below this the
    // fields stay neutral until the warm pass covers more names.
    const minBreadth = 20;
    var ranks = <String, Map<String, double>>{};
    values.forEach((metric, bySymbol) {
      if (bySymbol.length >= minBreadth) {
        ranks[metric] = _sectorAdjustedRanks(bySymbol, sectorBySymbol);
      }
    });
    if (isFullUniverse && ranks.isNotEmpty) {
      _lastFullRanks = ranks;
    } else if (!isFullUniverse && _lastFullRanks.isNotEmpty) {
      // Limited build: reuse the full-universe percentiles so the same
      // symbol scores identically regardless of the request's limit.
      ranks = _lastFullRanks;
    }
    if (ranks.isEmpty) {
      return 0;
    }

    var covered = 0;
    for (final signal in eligible) {
      final symbol = signal['ticker'] as String;
      final fund = _bySymbol[symbol];
      if (fund == null) {
        continue;
      }
      double? rank(String metric) => ranks[metric]?[symbol];

      var fieldsFilled = 0;
      void fill(String field, double? value) {
        if (value == null || !value.isFinite) {
          return;
        }
        signal[field] = _bounded(value);
        fieldsFilled++;
      }

      // Growth: level + change. Weighting the level higher reflects that
      // YoY growth is the better-attested predictor; acceleration is a
      // second-order refinement (Jegadeesh-Livnat 2006 revenue surprises).
      final growthRank = rank('revGrowth');
      final accelRank = rank('revAccel');
      fill(
        'revenueAcceleration',
        growthRank == null
            ? null
            : (accelRank == null
                  ? growthRank
                  : growthRank * 0.6 + accelRank * 0.4),
      );

      // Margin: level and trend equally weighted (level = profitability per
      // Novy-Marx 2013; trend = improving fundamentals).
      final marginRank = rank('margin');
      final marginTrendRank = rank('marginTrend');
      fill(
        'marginTrend',
        marginRank == null && marginTrendRank == null
            ? null
            : ((marginRank ?? marginTrendRank)! * 0.5 +
                  (marginTrendRank ?? marginRank)! * 0.5),
      );

      fill('freeCashFlowTrend', rank('fcfMargin'));

      // Quality composite: profitability + ROE + low leverage + low net
      // issuance, equal-weighted across whichever parts exist (QMJ-style).
      final qualityParts = <double>[
        if (rank('margin') != null) rank('margin')!,
        if (rank('roe') != null) rank('roe')!,
        if (rank('leverage') != null) 100 - rank('leverage')!,
        if (rank('shareChange') != null) 100 - rank('shareChange')!,
      ];
      fill(
        'quality',
        qualityParts.length >= 2
            ? qualityParts.reduce((a, b) => a + b) / qualityParts.length
            : null,
      );

      fill('valuationSupport', rank('earningsYield'));

      if (fieldsFilled == 0) {
        continue;
      }
      covered++;
      final filedThrough = fund.filedThrough?.toIso8601String().split('T')[0];
      signal['fundamentalsAsOf'] = filedThrough;
      signal['fundamentalsSource'] = 'sec-edgar-xbrl';
      signal['dataSource'] = '${signal['dataSource']}+edgar';
      final confidence = (signal['dataConfidence'] as num?)?.toDouble() ?? 50;
      signal['dataConfidence'] = math.min(confidence + 10, 88);
      final warnings =
          (signal['dataWarnings'] as List?)?.cast<String>() ?? <String>[];
      signal['dataWarnings'] = [
        for (final warning in warnings)
          if (!warning.startsWith('Fundamental and estimate-revision'))
            warning,
        'Fundamentals from SEC EDGAR XBRL filings (filed through '
            '${filedThrough ?? 'n/a'}). Estimate-revision fields remain '
            'neutral: no analyst feed is connected.',
      ];
    }
    return covered;
  }

  /// Percentile ranks averaged with within-sector ranks when the sector has
  /// enough names (industry adjustment per Novy-Marx 2013 / QMJ 2019; the
  /// equal blend is a neutral shrinkage prior pending a measured backtest).
  Map<String, double> _sectorAdjustedRanks(
    Map<String, double> bySymbol,
    Map<String, String> sectorBySymbol,
  ) {
    const minSectorBreadth = 8;
    final global = _percentileRanks(bySymbol);
    final bySector = <String, Map<String, double>>{};
    bySymbol.forEach((symbol, value) {
      final sector = sectorBySymbol[symbol] ?? 'Unknown';
      (bySector[sector] ??= {})[symbol] = value;
    });
    final out = <String, double>{};
    bySector.forEach((sector, group) {
      if (group.length >= minSectorBreadth) {
        final local = _percentileRanks(group);
        group.forEach((symbol, _) {
          out[symbol] = (local[symbol]! + global[symbol]!) / 2;
        });
      } else {
        group.forEach((symbol, _) {
          out[symbol] = global[symbol]!;
        });
      }
    });
    return out;
  }

  /// Mid-rank percentiles on [0, 100] with proper tie handling.
  Map<String, double> _percentileRanks(Map<String, double> bySymbol) {
    final entries = bySymbol.entries.toList()
      ..sort((a, b) => a.value.compareTo(b.value));
    final n = entries.length;
    final out = <String, double>{};
    var index = 0;
    while (index < n) {
      var j = index;
      while (j + 1 < n && entries[j + 1].value == entries[index].value) {
        j++;
      }
      final midRank = (index + j) / 2;
      final pct = n == 1 ? 50.0 : midRank / (n - 1) * 100;
      for (var k = index; k <= j; k++) {
        out[entries[k].key] = pct;
      }
      index = j + 1;
    }
    return out;
  }

  /// Raw filing series + computed metrics for one symbol — feeds the
  /// /fundamentals/history endpoint and (later) point-in-time ML features.
  /// Every row carries both the period `end` and the `filed` date; ML must
  /// key features by `filed` to stay look-ahead safe.
  Future<Map<String, Object?>?> historyFor(String symbol) async {
    final cik = (await _loadCikMap())[_normalizeTicker(symbol)];
    if (cik == null) {
      return null;
    }
    final json = await _fetchJson(
      Uri.parse('https://data.sec.gov/api/xbrl/companyfacts/CIK$cik.json'),
    );
    final facts = json?['facts'];
    if (facts is! Map) {
      return null;
    }

    List<Map<String, Object?>> rows(List<_FactRow> series) => [
      for (final row in series)
        {
          'end': row.end.toIso8601String().split('T')[0],
          if (row.start != null)
            'start': row.start!.toIso8601String().split('T')[0],
          'filed': row.filed.toIso8601String().split('T')[0],
          'value': row.value,
          'form': row.form,
          'span': row.start == null
              ? 'instant'
              : row.isQuarterFlow
              ? 'quarter'
              : row.isAnnualFlow
              ? 'annual'
              : 'other',
        },
    ];

    // dedup: false — keep every filing occurrence (originals AND
    // restatements) so point-in-time consumers can use only what was
    // filed on or before their sample date.
    var shares = _series(facts, 'dei', const [
      'EntityCommonStockSharesOutstanding',
    ], 'shares', dedup: false);
    if (shares.isEmpty) {
      shares = _series(
        facts,
        'us-gaap',
        _shareFallbackConcepts,
        'shares',
        dedup: false,
      );
    }

    return {
      'symbol': symbol,
      'cik': cik,
      'source': 'sec-edgar-xbrl',
      'note':
          'Rows carry period end AND filed dates, including restatement '
          'duplicates. For look-ahead-safe features, keep only rows with '
          'filed <= your sample date, then per period keep the latest '
          'such filing.',
      'series': {
        'revenue': rows(
          _series(facts, 'us-gaap', _revenueConcepts, 'USD', dedup: false),
        ),
        'netIncome': rows(
          _series(facts, 'us-gaap', _netIncomeConcepts, 'USD', dedup: false),
        ),
        'operatingCashFlow': rows(
          _series(
            facts,
            'us-gaap',
            _operatingCashFlowConcepts,
            'USD',
            dedup: false,
          ),
        ),
        'capex': rows(
          _series(facts, 'us-gaap', _capexConcepts, 'USD', dedup: false),
        ),
        'assets': rows(
          _series(facts, 'us-gaap', const ['Assets'], 'USD', dedup: false),
        ),
        'liabilities': rows(
          _series(
            facts,
            'us-gaap',
            const ['Liabilities'],
            'USD',
            dedup: false,
          ),
        ),
        'equity': rows(
          _series(facts, 'us-gaap', _equityConcepts, 'USD', dedup: false),
        ),
        'shares': rows(shares),
      },
      'metrics': _bySymbol[symbol]?.toJson(),
    };
  }

  Future<_SymbolFundamentals?> _compute(String symbol) async {
    final cik = (await _loadCikMap())[_normalizeTicker(symbol)];
    if (cik == null) {
      return null;
    }
    final json = await _fetchJson(
      Uri.parse('https://data.sec.gov/api/xbrl/companyfacts/CIK$cik.json'),
    );
    final facts = json?['facts'];
    if (facts is! Map) {
      return null;
    }

    final revenue = _series(facts, 'us-gaap', _revenueConcepts, 'USD');
    final netIncome = _series(facts, 'us-gaap', _netIncomeConcepts, 'USD');
    final cashFlow = _series(
      facts,
      'us-gaap',
      _operatingCashFlowConcepts,
      'USD',
    );
    final capex = _series(facts, 'us-gaap', _capexConcepts, 'USD');
    final assets = _series(facts, 'us-gaap', const ['Assets'], 'USD');
    final liabilities = _series(facts, 'us-gaap', const [
      'Liabilities',
    ], 'USD');
    final equity = _series(facts, 'us-gaap', _equityConcepts, 'USD');
    var shares = _series(facts, 'dei', const [
      'EntityCommonStockSharesOutstanding',
    ], 'shares');
    if (shares.isEmpty) {
      shares = _series(facts, 'us-gaap', _shareFallbackConcepts, 'shares');
    }

    final ttmRevenue = _ttm(revenue);
    final ttmNetIncome = _ttm(netIncome);
    final latestEnd = revenue.isEmpty ? null : revenue.last.end;

    double? revenueGrowthYoY;
    double? revenueAccelPp;
    if (ttmRevenue != null && latestEnd != null) {
      final priorEnd = DateTime(
        latestEnd.year - 1,
        latestEnd.month,
        latestEnd.day,
      );
      final priorTtm = _ttm(revenue, asOf: priorEnd);
      if (priorTtm != null && priorTtm > 0) {
        revenueGrowthYoY = (ttmRevenue / priorTtm - 1) * 100;
        // Growth one quarter earlier, for acceleration.
        final lagEnd = DateTime(
          latestEnd.year,
          latestEnd.month - 3,
          latestEnd.day,
        );
        final lagTtm = _ttm(revenue, asOf: lagEnd);
        final lagPriorTtm = _ttm(
          revenue,
          asOf: DateTime(lagEnd.year - 1, lagEnd.month, lagEnd.day),
        );
        if (lagTtm != null && lagPriorTtm != null && lagPriorTtm > 0) {
          revenueAccelPp =
              revenueGrowthYoY - (lagTtm / lagPriorTtm - 1) * 100;
        }
      }
    }

    double? netMarginPct;
    double? marginTrendPp;
    if (ttmRevenue != null && ttmRevenue > 0 && ttmNetIncome != null) {
      netMarginPct = ttmNetIncome / ttmRevenue * 100;
      if (latestEnd != null) {
        final priorEnd = DateTime(
          latestEnd.year - 1,
          latestEnd.month,
          latestEnd.day,
        );
        final priorNetIncome = _ttm(netIncome, asOf: priorEnd);
        final priorRevenue = _ttm(revenue, asOf: priorEnd);
        if (priorNetIncome != null &&
            priorRevenue != null &&
            priorRevenue > 0) {
          marginTrendPp = netMarginPct - priorNetIncome / priorRevenue * 100;
        }
      }
    }

    double? fcfMarginPct;
    final ttmCashFlow = _ttm(cashFlow);
    if (ttmCashFlow != null && ttmRevenue != null && ttmRevenue > 0) {
      final ttmCapex = _ttm(capex) ?? 0;
      fcfMarginPct = (ttmCashFlow - ttmCapex.abs()) / ttmRevenue * 100;
    }

    double? leveragePct;
    if (assets.isNotEmpty &&
        liabilities.isNotEmpty &&
        assets.last.value > 0) {
      leveragePct = liabilities.last.value / assets.last.value * 100;
    }

    double? roePct;
    if (ttmNetIncome != null && equity.isNotEmpty && equity.last.value > 0) {
      roePct = ttmNetIncome / equity.last.value * 100;
    }

    final sharesOutstanding = shares.isEmpty ? null : shares.last.value;
    double? shareChangeYoYPct;
    if (shares.length >= 2 && shares.last.value > 0) {
      final latest = shares.last;
      final prior = _closestByEnd(
        shares,
        DateTime(latest.end.year - 1, latest.end.month, latest.end.day),
        toleranceDays: 100,
      );
      if (prior != null && prior.value > 0 && !identical(prior, latest)) {
        shareChangeYoYPct = (latest.value / prior.value - 1) * 100;
      }
    }

    DateTime? filedThrough;
    for (final series in [revenue, netIncome, cashFlow, assets, shares]) {
      if (series.isNotEmpty &&
          (filedThrough == null || series.last.filed.isAfter(filedThrough))) {
        filedThrough = series.last.filed;
      }
    }

    final hasAnything =
        revenueGrowthYoY != null ||
        netMarginPct != null ||
        fcfMarginPct != null ||
        leveragePct != null ||
        roePct != null;
    if (!hasAnything) {
      return null;
    }

    return _SymbolFundamentals(
      revenueGrowthYoYPct: revenueGrowthYoY,
      revenueAccelPp: revenueAccelPp,
      netMarginPct: netMarginPct,
      marginTrendPp: marginTrendPp,
      fcfMarginPct: fcfMarginPct,
      leveragePct: leveragePct,
      roePct: roePct,
      shareChangeYoYPct: shareChangeYoYPct,
      ttmRevenueUsd: ttmRevenue,
      ttmNetIncomeUsd: ttmNetIncome,
      sharesOutstanding: sharesOutstanding,
      filedThrough: filedThrough,
      quarterlyRevenuePoints: revenue.where((r) => r.isQuarterFlow).length,
    );
  }

  /// Trailing-twelve-month total of a flow series as of [asOf] (default:
  /// latest available). Prefers latest-FY + post-FY quarters − matching
  /// prior-year quarters, which handles US filers' implicit Q4 (annual
  /// 10-K flows are full-year, Q4 is never filed separately); falls back
  /// to the sum of four contiguous quarters, then to the latest annual.
  double? _ttm(List<_FactRow> rows, {DateTime? asOf}) {
    final eligible = asOf == null
        ? rows
        : [
            for (final row in rows)
              if (!row.end.isAfter(asOf)) row,
          ];
    if (eligible.isEmpty) {
      return null;
    }
    final annuals = [
      for (final row in eligible)
        if (row.isAnnualFlow) row,
    ];
    final quarters = [
      for (final row in eligible)
        if (row.isQuarterFlow) row,
    ];
    if (annuals.isNotEmpty) {
      final fiscalYear = annuals.last;
      final after = [
        for (final quarter in quarters)
          if (quarter.end.isAfter(fiscalYear.end)) quarter,
      ];
      if (after.isEmpty) {
        return fiscalYear.value;
      }
      var sumAfter = 0.0;
      var sumPrior = 0.0;
      var matched = true;
      for (final quarter in after) {
        sumAfter += quarter.value;
        final prior = _closestByEnd(
          quarters,
          DateTime(quarter.end.year - 1, quarter.end.month, quarter.end.day),
          toleranceDays: 21,
        );
        if (prior == null) {
          matched = false;
          break;
        }
        sumPrior += prior.value;
      }
      if (matched) {
        return fiscalYear.value + sumAfter - sumPrior;
      }
    }
    if (quarters.length >= 4) {
      final last4 = quarters.sublist(quarters.length - 4);
      // Four quarter-ends spanning ~3 quarters of calendar = contiguous.
      final spanDays = last4.last.end.difference(last4.first.end).inDays;
      if (spanDays >= 240 && spanDays <= 320) {
        return last4.fold<double>(0, (sum, row) => sum + row.value);
      }
    }
    return annuals.isNotEmpty ? annuals.last.value : null;
  }

  _FactRow? _closestByEnd(
    List<_FactRow> rows,
    DateTime target, {
    required int toleranceDays,
  }) {
    _FactRow? best;
    var bestDelta = toleranceDays + 1;
    for (final row in rows) {
      final delta = row.end.difference(target).inDays.abs();
      if (delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    }
    return best;
  }

  /// Extract one concept's filing series: statement forms only, sorted by
  /// period end. Concepts are tried in order; the first with data wins.
  /// With [dedup] (default), one row per period keeping the latest-filed
  /// restatement — right for "current best estimate" metrics. With
  /// dedup: false every filing occurrence is kept so point-in-time
  /// consumers can reconstruct what was knowable at any date without
  /// future restatements leaking backward.
  List<_FactRow> _series(
    Map facts,
    String taxonomy,
    List<String> concepts,
    String unitKey, {
    bool dedup = true,
  }) {
    final tax = facts[taxonomy];
    if (tax is! Map) {
      return const [];
    }
    for (final concept in concepts) {
      final node = tax[concept];
      if (node is! Map) {
        continue;
      }
      final units = node['units'];
      if (units is! Map) {
        continue;
      }
      final rows = units[unitKey];
      if (rows is! List) {
        continue;
      }
      final deduped = <String, _FactRow>{};
      for (final raw in rows) {
        if (raw is! Map) {
          continue;
        }
        final form = (raw['form'] as String?) ?? '';
        if (!_isStatementForm(form)) {
          continue;
        }
        final end = DateTime.tryParse((raw['end'] as String?) ?? '');
        final filed = DateTime.tryParse((raw['filed'] as String?) ?? '');
        final value = (raw['val'] as num?)?.toDouble();
        if (end == null || filed == null || value == null) {
          continue;
        }
        final start = DateTime.tryParse((raw['start'] as String?) ?? '');
        final key = dedup
            ? '${start?.toIso8601String() ?? 'instant'}:${end.toIso8601String()}'
            : '${start?.toIso8601String() ?? 'instant'}:${end.toIso8601String()}'
                  ':${filed.toIso8601String()}';
        final row = _FactRow(
          end: end,
          start: start,
          filed: filed,
          value: value,
          form: form,
        );
        final existing = deduped[key];
        if (existing == null || row.filed.isAfter(existing.filed)) {
          deduped[key] = row;
        }
      }
      if (deduped.isEmpty) {
        continue;
      }
      final list = deduped.values.toList()
        ..sort((a, b) {
          final byEnd = a.end.compareTo(b.end);
          return byEnd != 0 ? byEnd : a.filed.compareTo(b.filed);
        });
      return list;
    }
    return const [];
  }

  static bool _isStatementForm(String form) =>
      form == '10-Q' ||
      form == '10-K' ||
      form == '20-F' ||
      form == '40-F' ||
      form == '10-Q/A' ||
      form == '10-K/A';

  Future<Map<String, String>> _loadCikMap() async {
    final cached = _cikByTicker;
    if (cached != null) {
      return cached;
    }
    final json = await _fetchJson(
      Uri.parse('https://www.sec.gov/files/company_tickers.json'),
    );
    final map = <String, String>{};
    if (json != null) {
      for (final row in json.values) {
        if (row is! Map) {
          continue;
        }
        final ticker = row['ticker'] as String?;
        final cik = row['cik_str'];
        if (ticker == null || cik is! num) {
          continue;
        }
        map[_normalizeTicker(ticker)] = cik
            .toInt()
            .toString()
            .padLeft(10, '0');
      }
    }
    // Keep even an empty map only for this call; retry next time on failure.
    if (map.isNotEmpty) {
      _cikByTicker = map;
    }
    return map;
  }

  /// SEC tickers use dashes for share classes (BRK-B); the universe uses
  /// dots (BRK.B).
  static String _normalizeTicker(String symbol) =>
      symbol.trim().toUpperCase().replaceAll('.', '-').replaceAll('/', '-');

  Future<Map?> _fetchJson(Uri uri) async {
    try {
      final entry = await _cache.fetch(uri);
      _lastFetchTouchedNetwork = entry.cacheState != 'HIT';
      if (entry.statusCode != 200) {
        return null;
      }
      final decoded = jsonDecode(utf8.decode(entry.body));
      return decoded is Map ? decoded : null;
    } catch (_) {
      _lastFetchTouchedNetwork = true;
      return null;
    }
  }
}

/// One XBRL fact occurrence: value for a period (start..end for flows,
/// instant for balances) from a specific filing (filed date + form).
class _FactRow {
  const _FactRow({
    required this.end,
    required this.start,
    required this.filed,
    required this.value,
    required this.form,
  });

  final DateTime end;
  final DateTime? start;
  final DateTime filed;
  final double value;
  final String form;

  int get spanDays => start == null ? 0 : end.difference(start!).inDays;
  bool get isQuarterFlow =>
      start != null && spanDays >= 70 && spanDays <= 110;
  bool get isAnnualFlow =>
      start != null && spanDays >= 330 && spanDays <= 400;
}

/// Computed trailing metrics for one symbol; all fields nullable because
/// XBRL coverage varies by filer (banks lack Revenues, young filers lack
/// history, foreign filers report annually).
class _SymbolFundamentals {
  const _SymbolFundamentals({
    required this.revenueGrowthYoYPct,
    required this.revenueAccelPp,
    required this.netMarginPct,
    required this.marginTrendPp,
    required this.fcfMarginPct,
    required this.leveragePct,
    required this.roePct,
    required this.shareChangeYoYPct,
    required this.ttmRevenueUsd,
    required this.ttmNetIncomeUsd,
    required this.sharesOutstanding,
    required this.filedThrough,
    required this.quarterlyRevenuePoints,
  });

  final double? revenueGrowthYoYPct;
  final double? revenueAccelPp;
  final double? netMarginPct;
  final double? marginTrendPp;
  final double? fcfMarginPct;
  final double? leveragePct;
  final double? roePct;
  final double? shareChangeYoYPct;
  final double? ttmRevenueUsd;
  final double? ttmNetIncomeUsd;
  final double? sharesOutstanding;
  final DateTime? filedThrough;
  final int quarterlyRevenuePoints;

  Map<String, Object?> toJson() => {
    'revenueGrowthYoYPct': revenueGrowthYoYPct,
    'revenueAccelPp': revenueAccelPp,
    'netMarginPct': netMarginPct,
    'marginTrendPp': marginTrendPp,
    'fcfMarginPct': fcfMarginPct,
    'leveragePct': leveragePct,
    'roePct': roePct,
    'shareChangeYoYPct': shareChangeYoYPct,
    'ttmRevenueUsd': ttmRevenueUsd,
    'ttmNetIncomeUsd': ttmNetIncomeUsd,
    'sharesOutstanding': sharesOutstanding,
    'filedThrough': filedThrough?.toIso8601String(),
    'quarterlyRevenuePoints': quarterlyRevenuePoints,
  };
}
