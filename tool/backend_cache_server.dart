import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

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
