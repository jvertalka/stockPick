import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:finance_app/src/data/default_symbol_universe.dart';
import 'package:finance_app/src/data/local_secrets.dart';

/// Provider tokens are resolved HERE, server-side, so they never ship inside
/// the browser bundle. An environment variable wins when set (rotate a key or
/// run CI without a recompile); otherwise the compiled-in local_secrets.dart
/// value is used. The proxy injects these onto the matching upstream host and
/// nowhere else, so a secret can never ride to the wrong domain.
String _resolveSecret(String envKey, String compiledFallback) {
  final env = Platform.environment[envKey];
  if (env != null && env.trim().isNotEmpty) return env.trim();
  return compiledFallback.trim();
}

final String kServerFinnhubToken = _resolveSecret(
  'FINNHUB_TOKEN',
  kFinnhubApiKey,
);
final String kServerTradierToken = _resolveSecret(
  'TRADIER_TOKEN',
  kTradierToken,
);
final String kServerTradierEnv =
    _resolveSecret('TRADIER_ENV', kTradierEnv) == 'production'
    ? 'production'
    : 'sandbox';
final String kServerPolygonToken = _resolveSecret(
  'POLYGON_TOKEN',
  kPolygonToken,
);
final String kServerFredToken = _resolveSecret('FRED_API_KEY', kFredApiKey);

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
    this.warmup = true,
  });

  factory BackendCacheConfig.fromArgs(List<String> args) {
    var host = '127.0.0.1';
    var port = 8787;
    var cacheDirectory = Directory('.dart_tool/market_data_cache');
    var webRoot = Directory('build/web');
    var warmup = true;

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
        case '--warmup':
          // '--warmup off' skips the boot-time universe sync. Used by the
          // historical study server so thousands of warmup fetches don't
          // burn the Yahoo rate budget the study's own fetches need.
          if (next != null) {
            warmup = next.toLowerCase() != 'off' && next != '0';
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
      warmup: warmup,
    );
  }

  final String host;
  final int port;
  final Directory cacheDirectory;
  final Directory webRoot;
  final bool warmup;

  static const String _usage = '''
Finance Oracle backend cache

Usage:
  dart run tool/backend_cache_server.dart [--host 127.0.0.1] [--port 8787] [--web-root build/web] [--cache-dir .dart_tool/market_data_cache] [--warmup off]

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
  Future<void>? _warmupFuture;
  Future<void>? _stopFuture;
  final Set<Future<void>> _inFlightRequests = <Future<void>>{};
  bool _stopping = false;

  Future<void> start() async {
    _stopping = false;
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
    if (config.warmup) {
      final warmup = _warmUpUniverse();
      _warmupFuture = warmup;
      unawaited(warmup);
    } else {
      stdout.writeln('Universe warmup disabled (--warmup off).');
    }
    await for (final request in server) {
      _trackRequest(request);
    }
  }

  void _trackRequest(HttpRequest request) {
    late final Future<void> tracked;
    tracked = _handleRequest(request)
        .catchError((Object _, StackTrace _) {
          // _handleRequest normally turns errors into JSON responses. Socket
          // teardown can still throw while stop() force-closes connections;
          // that is an expected shutdown condition, not an unhandled future.
        })
        .whenComplete(() => _inFlightRequests.remove(tracked));
    _inFlightRequests.add(tracked);
    unawaited(tracked);
  }

  /// Warms the decision universe in the background so a freshly started
  /// server is useful immediately instead of returning 0 scoreable names
  /// until someone manually clicks "Sync prices". Each pass syncs up to
  /// 96 symbols through the same code path the HTTP route uses; passes
  /// continue until coverage stops improving.
  Future<void> _warmUpUniverse() async {
    try {
      var noProgressPasses = 0;
      // The pass ceiling is a runaway backstop, NOT the expected exit — the
      // three-strike no-progress break below is what actually ends warmup.
      // 40 proved too small in practice: a fully stale 2,500-name universe
      // under provider throttling landed only ~35-45 names per pass and the
      // budget ran out at 2055/2500 while still progressing.
      for (var pass = 1; pass <= 150; pass++) {
        if (_stopping) return;
        final result =
            await DecisionUniverseService(
              config.cacheDirectory,
              cache: _cache,
            ).build(
              // AUTO, not force: auto's candidate set is "genuinely needs
              // work" (missing/unproven/stale series, minus chronic-futility
              // cooldowns), so `requested` reaching zero really means done.
              // Force makes every symbol a candidate on every pass, which
              // kept `requested` pinned at the limit and made the
              // nothing-left-to-sync exit unreachable.
              Uri.parse(
                '/decision/universe?limit=0&historyLimit=0&sync=auto&syncLimit=96',
              ),
            );
        if (_stopping) return;
        final returned = (result['returned'] as num?)?.toInt() ?? 0;
        final universe = (result['universeSize'] as num?)?.toInt() ?? 0;
        final sync = result['sync'];
        final updatedThisPass = sync is Map
            ? ((sync['updated'] as num?)?.toInt() ?? 0)
            : 0;
        final requestedThisPass = sync is Map
            ? ((sync['requested'] as num?)?.toInt() ?? 0)
            : 0;
        stdout.writeln(
          'Universe warmup pass $pass: $returned/$universe symbols scoreable '
          '(synced $updatedThisPass/$requestedThisPass this pass)',
        );
        // DONE means the SYNC ran dry, not that the scoreable count went
        // flat. After a short offline gap every name is already "scoreable"
        // on slightly stale bars, so the count is pinned from pass 1 — the
        // old returned-count exit fired after 3 passes and left ~2,000
        // names days out of date. A pass that requested nothing has no
        // stale symbols left: that is completion.
        if (requestedThisPass == 0) {
          stdout.writeln(
            'Universe warmup complete: nothing left to sync '
            '($returned/$universe scoreable).',
          );
          break;
        }
        // A pass that requested work but landed NONE of it is a throttled
        // pass, not completion. Require three consecutive fully-failed
        // passes (with cool-downs so a throttle window can lapse) before
        // giving up — one 429-storm pass once ended warmup at 736/2500.
        if (updatedThisPass == 0) {
          noProgressPasses++;
          if (noProgressPasses >= 3) {
            stdout.writeln(
              'Universe warmup stopped: provider unreachable for 3 passes '
              '($returned/$universe scoreable; stale symbols remain).',
            );
            break;
          }
          await Future<void>.delayed(const Duration(seconds: 30));
        } else {
          noProgressPasses = 0;
        }
      }
      // Each pass above queued EDGAR fundamentals for its scoreable stocks;
      // wait for that queue to drain so boot ends with fundamentals ready.
      if (_stopping) return;
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

  Future<void> stop() => _stopFuture ??= _stop();

  Future<void> _stop() async {
    _stopping = true;
    // Mark every data service stopped before aborting sockets. Work that was
    // already awaiting I/O can then observe the lifecycle boundary and must
    // not enqueue another drain or start a cache/history write.
    _cache.stop();
    final fundamentals = SecFundamentalsService.instance(_cache);
    final fundamentalsStop = fundamentals.stop(resetSingleton: false);
    await _server?.close(force: true);
    _client.close(force: true);

    // Joining handler futures is essential on Windows: closing the listener
    // only closes sockets; request bodies and service futures can otherwise
    // keep cache files open after stop() returns.
    while (_inFlightRequests.isNotEmpty) {
      await Future.wait(_inFlightRequests.toList());
    }
    final warmup = _warmupFuture;
    if (warmup != null) await warmup;
    await fundamentalsStop;
    // Keep the stopped singleton installed until every request and warmup has
    // joined, so a late continuation cannot create a fresh SEC drain. It is
    // safe to release only now for a future server instance in the same VM.
    await fundamentals.stop();
  }

  Future<void> _handleRequest(HttpRequest request) async {
    if (_stopping) {
      request.response.statusCode = HttpStatus.serviceUnavailable;
      await _writeJson(request.response, {
        'error': 'backend_stopping',
        'detail': 'The local cache is shutting down; retry after restart.',
      });
      return;
    }
    // DNS-rebinding defense: a malicious website can re-resolve its own
    // domain to 127.0.0.1 and then fetch this server SAME-ORIGIN (no CORS
    // involved). The tell is the Host header, which still names the
    // attacker's domain — so only local host names are served.
    if (!_isLocalHostHeader(request.headers.value(HttpHeaders.hostHeader))) {
      request.response.statusCode = HttpStatus.forbidden;
      await _writeJson(request.response, {
        'error': 'host_not_allowed',
        'detail':
            'This cache only serves local host names (DNS-rebinding guard).',
      });
      return;
    }
    if (_requiresTrustedBrowserContext(request) &&
        !_hasTrustedBrowserContext(request)) {
      request.response.statusCode = HttpStatus.forbidden;
      await _writeJson(request.response, {
        'error': 'browser_context_not_allowed',
        'detail':
            'Network-backed and credential-bearing routes only accept local '
            'app origins or native requests without browser fetch metadata.',
      });
      return;
    }
    _addCorsHeaders(request);

    try {
      if (request.method == 'OPTIONS') {
        // Preflight: CORS approval headers were only attached above for
        // local origins, so cross-origin writes from arbitrary websites
        // fail here before the real request is ever sent.
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
      if (path == '/config/providers') {
        // Booleans only — which providers have a server-side token wired.
        // Never returns the token values themselves. The frontend reads this
        // to decide which live feeds to switch on, instead of embedding keys.
        await _writeJson(request.response, {
          'finnhub': kServerFinnhubToken.isNotEmpty,
          'tradier': kServerTradierToken.isNotEmpty,
          'polygon': kServerPolygonToken.isNotEmpty,
          'fred': kServerFredToken.isNotEmpty,
          'tradierEnv': kServerTradierEnv,
        });
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
          // Write gate: the model store decides what the app RECOMMENDS, so
          // writes must carry X-Oracle-Write. The header itself is no secret —
          // the protection is that a CUSTOM header forces a CORS preflight,
          // and only local origins get preflight approval (_addCorsHeaders),
          // so a malicious website can never reach this branch. Legit callers
          // (backtest CLI, in-app persist, a manual curl restore) just send
          // the header. Native local processes are inside the trust boundary
          // either way — they could edit ml_trained_model.json on disk.
          if (request.headers.value('x-oracle-write') == null) {
            request.response.statusCode = HttpStatus.forbidden;
            await _writeJson(request.response, {
              'error': 'write_not_authorized',
              'detail':
                  'Model writes require the X-Oracle-Write header (any '
                  'value). Example: curl -X PUT -H "X-Oracle-Write: 1" ...',
            });
            return;
          }
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
          if (_stopping || _cache.isStopped) {
            request.response.statusCode = HttpStatus.serviceUnavailable;
            await _writeJson(request.response, {
              'error': 'backend_stopping',
              'detail': 'Model persistence was cancelled during shutdown.',
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
            : await SecFundamentalsService.instance(_cache).historyFor(symbol);
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
    // X-Finnhub-Token rides a HEADER instead of a ?token= URL param so the
    // secret never lands in cache keys/filenames or log lines on disk.
    final authHeader = request.headers.value(HttpHeaders.authorizationHeader);
    final acceptHeader = request.headers.value(HttpHeaders.acceptHeader);
    final finnhubToken = request.headers.value('x-finnhub-token');
    final entry = await _cache.fetch(
      target,
      authHeader: authHeader,
      acceptHeader: acceptHeader,
      finnhubToken: finnhubToken,
    );
    request.response.statusCode = entry.statusCode;
    request.response.headers.set(
      HttpHeaders.contentTypeHeader,
      entry.contentType,
    );
    request.response.headers.set('X-Finance-Oracle-Cache', entry.cacheState);
    request.response.headers.set(
      HttpHeaders.cacheControlHeader,
      entry.cacheState == 'BYPASS' || entry.cacheState == 'ERROR'
          ? 'no-store'
          : 'public, max-age=${entry.remainingTtlSeconds}',
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

  /// True when the Host header names THIS machine (any port). Anything else
  /// is a DNS-rebinding attempt or a misdirected request.
  bool _isLocalHostHeader(String? hostHeader) {
    if (hostHeader == null || hostHeader.isEmpty) return false;
    final lower = hostHeader.toLowerCase();
    String hostOnly;
    if (lower.startsWith('[')) {
      final end = lower.indexOf(']');
      if (end < 0) return false;
      // Only an optional :port may follow the bracket — reject junk like
      // "[::1]evil.com" that would otherwise truncate to the loopback literal.
      final rest = lower.substring(end + 1);
      if (rest.isNotEmpty && !rest.startsWith(':')) return false;
      hostOnly = lower.substring(0, end + 1);
    } else {
      hostOnly = lower.split(':').first;
    }
    return hostOnly == '127.0.0.1' ||
        hostOnly == 'localhost' ||
        hostOnly == '[::1]' ||
        hostOnly == config.host.toLowerCase();
  }

  /// CORS: was `*`, which let ANY website a browser visits read this server's
  /// responses and preflight writes through. Now only LOCAL origins (the Vite
  /// dev server, the packaged Tauri webview) get approval; requests without an
  /// Origin (curl, the CLI, same-origin pages) need no CORS at all. Internet
  /// origins get no approval headers, so the browser blocks them — including
  /// the preflight for PUT /ml/model (see the x-oracle-write gate there).
  /// Native local processes are inside the trust boundary regardless (they
  /// can touch the files directly), so this targets the actual attack
  /// surface: drive-by browser requests.
  void _addCorsHeaders(HttpRequest request) {
    final origin = request.headers.value('origin');
    if (origin == null || origin.isEmpty) return;
    if (!_isLocalOrigin(origin)) return; // no approval — browser blocks
    final headers = request.response.headers;
    headers.set(HttpHeaders.accessControlAllowOriginHeader, origin);
    headers.set('Vary', 'Origin');
    headers.set(
      HttpHeaders.accessControlAllowMethodsHeader,
      'GET, PUT, OPTIONS',
    );
    headers.set(
      HttpHeaders.accessControlAllowHeadersHeader,
      'Accept, Authorization, Content-Type, X-Finnhub-Token, X-Oracle-Write',
    );
    // The frontend uses cache provenance to fail closed on stale FRED and
    // market-data responses. Custom response headers are unreadable to
    // cross-origin JavaScript unless explicitly exposed.
    headers.set('Access-Control-Expose-Headers', 'X-Finance-Oracle-Cache');
    // Private Network Access: if a Chromium/WebView2 build preflights a
    // private-network request (public/local origin -> 127.0.0.1), echo
    // approval so PNA enforcement can't silently block the packaged app's
    // tauri.localhost -> loopback calls. Harmless when the browser doesn't ask.
    if (request.headers.value('access-control-request-private-network') ==
        'true') {
      headers.set('Access-Control-Allow-Private-Network', 'true');
    }
  }

  /// Local-app origins: localhost/127.0.0.1/[::1] on any port (Vite dev,
  /// previews) plus the Tauri webview origins (http(s)://tauri.localhost on
  /// Windows WebView2, tauri://localhost elsewhere). Port-agnostic on purpose
  /// — an exact port list would break the app on a dev-port change, while a
  /// remote attacker can never present a local origin.
  bool _isLocalOrigin(String origin) {
    final lower = origin.toLowerCase();
    final uri = Uri.tryParse(lower);
    if (uri == null) return false;
    if (uri.scheme == 'tauri') return uri.host == 'localhost';
    if (uri.scheme != 'http' && uri.scheme != 'https') {
      return false;
    }
    final host = uri.host;
    return host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        host == 'tauri.localhost';
  }

  /// Routes that can spend upstream quota, expose a provider credential, or
  /// mutate recommendation authority require more than passive CORS. CORS
  /// prevents a hostile page from reading a response, but a no-cors request
  /// can still execute and burn quota. Native callers (CLI/curl/Tauri sidecar)
  /// normally send neither Origin nor Sec-Fetch-Site and remain supported.
  bool _requiresTrustedBrowserContext(HttpRequest request) {
    final path = request.uri.path;
    return path == '/proxy' ||
        path == '/decision/universe' ||
        path == '/fundamentals/history' ||
        (path == '/ml/model' && request.method == 'PUT');
  }

  bool _hasTrustedBrowserContext(HttpRequest request) {
    final origin = request.headers.value('origin');
    // Chromium/WebView2 can label localhost -> 127.0.0.1 as cross-site even
    // though both are trusted loopback app origins. An explicit Origin is the
    // stronger signal; use Sec-Fetch-Site only when Origin is absent.
    if (origin != null && origin.isNotEmpty) return _isLocalOrigin(origin);
    final fetchSite = request.headers.value('sec-fetch-site')?.toLowerCase();
    return fetchSite != 'cross-site';
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
  final Map<String, Future<void>> _writesByPartition = <String, Future<void>>{};
  bool _stopped = false;

  bool get isStopped => _stopped;

  void stop() {
    _stopped = true;
  }

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
    'finnhub.io',
  };

  bool isAllowed(Uri uri) {
    final host = uri.host.toLowerCase();
    // Every allowlisted host is external. HTTP, embedded user-info, and
    // nonstandard ports would either expose injected provider credentials or
    // turn an allowlisted DNS name into an SSRF/token-exfiltration primitive.
    return uri.scheme.toLowerCase() == 'https' &&
        uri.userInfo.isEmpty &&
        (!uri.hasPort || uri.port == 443) &&
        _allowedHosts.contains(host);
  }

  Future<CachedProxyResponse> fetch(
    Uri uri, {
    String? authHeader,
    String? acceptHeader,
    String? finnhubToken,
  }) async {
    if (_stopped) {
      throw StateError('Market-data cache is stopped.');
    }
    if (!isAllowed(uri)) {
      throw ArgumentError.value(uri, 'uri', 'Upstream URL is not allowed.');
    }
    final cacheable = isCacheable(uri, authHeader: authHeader);
    final key = cachePartitionKey(
      uri,
      authHeader: authHeader,
      acceptHeader: acceptHeader,
      finnhubToken: finnhubToken,
    );
    final paths = _CachePaths(
      metadata: File('${directory.path}${Platform.pathSeparator}$key.json'),
      body: File('${directory.path}${Platform.pathSeparator}$key.body'),
    );
    final policy = _CachePolicy.forUri(uri);
    final cached = cacheable ? await _read(paths) : null;
    if (cached != null && !cached.isExpired) {
      return cached.toResponse(cacheState: 'HIT');
    }

    try {
      final fresh = await _fetchNetwork(
        uri,
        policy,
        authHeader: authHeader,
        acceptHeader: acceptHeader,
        finnhubToken: finnhubToken,
      );
      if (fresh.statusCode >= 200 && fresh.statusCode < 300) {
        if (!cacheable) {
          return fresh.toResponse(cacheState: 'BYPASS');
        }
        if (_stopped) {
          throw StateError('Market-data cache stopped before persistence.');
        }
        await _writeSerialized(key, paths, fresh);
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

  /// Account/user routes and requests carrying a caller-supplied Bearer are
  /// never persisted. Tradier market-data requests using the workstation's
  /// server-held credential remain cacheable, but are credential-partitioned
  /// below so a token/entitlement change cannot reuse another response.
  bool isCacheable(Uri uri, {String? authHeader}) {
    if (authHeader != null && authHeader.trim().isNotEmpty) return false;
    final host = uri.host.toLowerCase();
    if (host != 'sandbox.tradier.com' && host != 'api.tradier.com') {
      return true;
    }
    final path = uri.path.toLowerCase();
    return !(path == '/v1/user' ||
        path.startsWith('/v1/user/') ||
        path == '/v1/accounts' ||
        path.startsWith('/v1/accounts/') ||
        path == '/v1/watchlists' ||
        path.startsWith('/v1/watchlists/') ||
        path == '/v1/orders' ||
        path.startsWith('/v1/orders/'));
  }

  /// A URL alone is not an HTTP cache identity. Accept can select XML vs JSON
  /// (notably on Tradier), while provider credentials can select entitlement
  /// variants. Only a hash-of-a-hash reaches the filename; token text is never
  /// written to cache metadata, paths, or logs.
  String cachePartitionKey(
    Uri uri, {
    String? authHeader,
    String? acceptHeader,
    String? finnhubToken,
  }) {
    final canonicalAccept = _canonicalAccept(acceptHeader);
    final credential = _effectiveCredentialIdentity(
      uri,
      authHeader: authHeader,
      finnhubToken: finnhubToken,
    );
    final credentialFingerprint = credential.isEmpty
        ? 'none'
        : _stableHash('credential:$credential');
    return _stableHash(
      'cache-key-v2\n${uri.toString()}\naccept:$canonicalAccept\n'
      'credential:$credentialFingerprint',
    );
  }

  String _canonicalAccept(String? value) {
    final trimmed = value?.trim().toLowerCase() ?? '';
    return trimmed.isEmpty ? '*/*' : trimmed.replaceAll(RegExp(r'\s+'), ' ');
  }

  String _effectiveCredentialIdentity(
    Uri uri, {
    String? authHeader,
    String? finnhubToken,
  }) {
    final host = uri.host.toLowerCase();
    if (host == 'sandbox.tradier.com' || host == 'api.tradier.com') {
      final caller = authHeader?.trim() ?? '';
      if (caller.isNotEmpty) return caller;
      return kServerTradierToken.isEmpty ? '' : 'Bearer $kServerTradierToken';
    }
    if (host == 'finnhub.io') {
      final caller = finnhubToken?.trim() ?? '';
      return caller.isNotEmpty ? caller : kServerFinnhubToken;
    }
    return '';
  }

  Future<Map<String, Object>> status() async {
    if (_stopped) {
      throw StateError('Market-data cache is stopped.');
    }
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
      final body = await paths.body.readAsBytes();
      final expectedBodyHash = decoded['bodyHash'];
      if (expectedBodyHash is String &&
          expectedBodyHash != _stableHashBytes(body)) {
        return null;
      }
      return _StoredCacheEntry(
        statusCode: decoded['statusCode'] as int,
        contentType:
            decoded['contentType'] as String? ?? 'application/octet-stream',
        fetchedAt: fetchedAt,
        ttl: Duration(seconds: ttlSeconds),
        body: body,
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
    String? finnhubToken,
  }) async {
    // Follow redirects MANUALLY, re-checking the allowlist on EVERY hop.
    // dart:io auto-follows 3xx by default, so an allowlisted host emitting a
    // redirect (open-redirect, or a normal 30x) would be chased to an
    // arbitrary target — a blind-SSRF pivot to internal services — AND dart:io
    // forwards custom request headers (X-Finnhub-Token, Authorization) across
    // cross-domain redirects, leaking those secrets. Manual handling closes
    // both: secrets are re-attached per hop against THIS hop's host, and an
    // off-allowlist Location is refused rather than fetched.
    var current = uri;
    final originalHost = uri.host.toLowerCase();
    for (var hop = 0; hop < 6; hop++) {
      if (_stopped) {
        throw StateError('Market-data cache stopped during fetch.');
      }
      final host = current.host.toLowerCase();
      var upstream = current;
      if (host == 'api.stlouisfed.org' &&
          originalHost == 'api.stlouisfed.org' &&
          kServerFredToken.isNotEmpty) {
        // FRED authenticates with a query parameter. Add it only at the last
        // possible moment so the secret is absent from browser URLs, cache
        // keys/metadata, and every non-FRED request (including redirects).
        upstream = current.replace(
          queryParameters: {
            ...current.queryParameters,
            'api_key': kServerFredToken,
          },
        );
      }
      final request = await _client.getUrl(upstream).timeout(policy.timeout);
      request.followRedirects = false;
      // Finnhub token: an inbound header wins (back-compat / the CLI); else the
      // server-held token is injected — and only ever toward finnhub.io.
      final effectiveFinnhub = (finnhubToken != null && finnhubToken.isNotEmpty)
          ? finnhubToken
          : kServerFinnhubToken;
      if (effectiveFinnhub.isNotEmpty &&
          host == 'finnhub.io' &&
          originalHost == 'finnhub.io') {
        request.headers.set('X-Finnhub-Token', effectiveFinnhub);
      }
      request.headers.set(
        HttpHeaders.acceptHeader,
        acceptHeader != null && acceptHeader.isNotEmpty ? acceptHeader : '*/*',
      );
      request.headers.set(
        HttpHeaders.userAgentHeader,
        // SEC fair-access policy requires the User-Agent to identify the
        // requester with a contact address (https://www.sec.gov/os/accessing-
        // edgar-data); generic UAs get 403 "Request Rate Threshold Exceeded".
        current.host.toLowerCase().endsWith('sec.gov')
            ? 'FinanceOracleWorkstation/1.0 (personal research; '
                  'joshua.j.vertalka@gmail.com)'
            : 'FinanceOracleLocalCache/1.0 (${Platform.operatingSystem})',
      );
      // Authorization: an inbound Bearer wins (back-compat / the CLI); else the
      // server-held Tradier token is injected as a Bearer — and ONLY toward the
      // Tradier hosts, so the secret never rides to SEC/finnhub/etc.
      // The inbound header is pinned to the host the caller originally
      // requested: without that pin, a cross-domain 30x from one allowlisted
      // host to another would re-send the caller's Bearer to the new host —
      // the same cross-domain leak this loop exists to prevent.
      final isTradierHost =
          host == 'sandbox.tradier.com' || host == 'api.tradier.com';
      String? effectiveAuth;
      if (isTradierHost &&
          authHeader != null &&
          authHeader.isNotEmpty &&
          host == uri.host.toLowerCase()) {
        effectiveAuth = authHeader;
      } else if (isTradierHost &&
          (originalHost == 'sandbox.tradier.com' ||
              originalHost == 'api.tradier.com') &&
          kServerTradierToken.isNotEmpty) {
        effectiveAuth = 'Bearer $kServerTradierToken';
      }
      if (effectiveAuth != null && effectiveAuth.isNotEmpty) {
        request.headers.set(HttpHeaders.authorizationHeader, effectiveAuth);
      }
      final response = await request.close().timeout(policy.timeout);
      if (_stopped) {
        await response.drain<void>();
        throw StateError('Market-data cache stopped during fetch.');
      }
      final location = response.headers.value(HttpHeaders.locationHeader);
      if (response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location != null) {
        await response.drain<void>(); // release the socket before re-issuing
        final next = current.resolveUri(Uri.parse(location));
        if (!isAllowed(next)) {
          return _StoredCacheEntry(
            statusCode: HttpStatus.forbidden,
            contentType: 'application/json; charset=utf-8',
            fetchedAt: DateTime.now().toUtc(),
            ttl: Duration.zero,
            body: utf8.encode(
              jsonEncode({
                'error': 'redirect_not_allowed',
                'detail':
                    'Upstream redirected to a non-allowlisted host; not followed.',
                'host': next.host,
              }),
            ),
          );
        }
        if (isCacheable(current, authHeader: authHeader) &&
            !isCacheable(next, authHeader: authHeader)) {
          return _StoredCacheEntry(
            statusCode: HttpStatus.forbidden,
            contentType: 'application/json; charset=utf-8',
            fetchedAt: DateTime.now().toUtc(),
            ttl: Duration.zero,
            body: utf8.encode(
              jsonEncode({
                'error': 'redirect_not_cache_safe',
                'detail':
                    'A cacheable upstream route redirected to an account or '
                    'caller-authenticated route; not followed.',
                'host': next.host,
              }),
            ),
          );
        }
        current = next;
        continue;
      }
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
    return _StoredCacheEntry(
      statusCode: HttpStatus.loopDetected,
      contentType: 'application/json; charset=utf-8',
      fetchedAt: DateTime.now().toUtc(),
      ttl: Duration.zero,
      body: utf8.encode(jsonEncode({'error': 'too_many_redirects'})),
    );
  }

  Future<void> _write(_CachePaths paths, _StoredCacheEntry entry) async {
    if (_stopped) return;
    await directory.create(recursive: true);
    if (_stopped) return;
    final suffix = '$pid-${DateTime.now().microsecondsSinceEpoch}';
    final bodyTemp = File('${paths.body.path}.$suffix.tmp');
    final metadataTemp = File('${paths.metadata.path}.$suffix.tmp');
    try {
      await bodyTemp.writeAsBytes(entry.body, flush: true);
      await metadataTemp.writeAsString(
        jsonEncode({
          'statusCode': entry.statusCode,
          'contentType': entry.contentType,
          'fetchedAt': entry.fetchedAt.toIso8601String(),
          'ttlSeconds': entry.ttl.inSeconds,
          // A two-file cache cannot commit body+metadata in one filesystem
          // operation. The checksum makes an interrupted midpoint fail closed
          // as a cache miss instead of pairing stale metadata with new bytes.
          'bodyHash': _stableHashBytes(entry.body),
        }),
        flush: true,
      );
      if (_stopped) return;
      await _replaceFile(bodyTemp, paths.body);
      if (_stopped) return;
      await _replaceFile(metadataTemp, paths.metadata);
    } finally {
      if (await bodyTemp.exists()) await bodyTemp.delete();
      if (await metadataTemp.exists()) await metadataTemp.delete();
    }
  }

  Future<void> _writeSerialized(
    String partition,
    _CachePaths paths,
    _StoredCacheEntry entry,
  ) {
    Future<void> write() => _write(paths, entry);

    final previous = _writesByPartition[partition];
    final started = previous == null
        ? write()
        : previous.then<void>(
            (_) => write(),
            onError: (Object _, StackTrace _) => write(),
          );
    late final Future<void> tracked;
    tracked = started.whenComplete(() {
      if (identical(_writesByPartition[partition], tracked)) {
        _writesByPartition.remove(partition);
      }
    });
    _writesByPartition[partition] = tracked;
    return tracked;
  }

  Future<void> _replaceFile(File source, File target) async {
    try {
      await source.rename(target.path);
    } on FileSystemException {
      // Windows does not consistently replace an existing destination. A
      // missing target is safe: readers treat it as a miss and refetch.
      if (await target.exists()) await target.delete();
      await source.rename(target.path);
    }
  }

  Future<Uint8List> _readAll(HttpClientResponse response) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  String _stableHash(String input) {
    return _stableHashBytes(utf8.encode(input));
  }

  String _stableHashBytes(List<int> input) {
    const offset = 0xcbf29ce484222325;
    const prime = 0x100000001b3;
    const mask = 0xffffffffffffffff;
    var hash = offset;
    for (final byte in input) {
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
    if (host == 'finnhub.io') {
      // Analyst recommendation trends update ~monthly and earnings
      // surprises ~quarterly, so a 12h TTL keeps the free-tier rate
      // budget (60 req/min) from being re-spent every session.
      return const _CachePolicy(
        ttl: Duration(hours: 12),
        timeout: Duration(seconds: 12),
      );
    }
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
    if (_cache.isStopped) {
      throw StateError('Decision-universe service is stopped.');
    }
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

    // HISTORICAL STUDY MODE (?asOf=YYYY-MM-DD): rebuild the raw signals as
    // they would have looked on a past date, through this same production
    // signal builder, so the JS engine's action rules can be event-studied
    // against what actually happened next. Uses full-history (range=max)
    // series truncated at asOf; never touches the live price store, the
    // rolling history file, or the fundamentals warm queue.
    final asOfParam = uri.queryParameters['asOf'];
    if (asOfParam != null && asOfParam.isNotEmpty) {
      final parsed = DateTime.tryParse('${asOfParam}T23:59:59Z');
      if (parsed == null) {
        return {
          'error': 'bad_asof',
          'detail': 'asOf must be YYYY-MM-DD, got "$asOfParam".',
        };
      }
      return _buildHistorical(
        symbols: selectedSymbols,
        asOf: parsed.toUtc(),
        scenario: scenario,
        // fundamentals=pit fills quality/value/growth from SEC filings as
        // they were FILED by the asOf date (no look-ahead) — unlocks the
        // engine's bullish actions historically. Omit for price-only.
        pointInTimeFundamentals: uri.queryParameters['fundamentals'] == 'pit',
      );
    }

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

    // Score aggregation ONLY — the backend no longer classifies stocks into
    // actions. Its old _classifyAction used different thresholds than the
    // desktop's JS scoreUniverse and disagreed on ~half the labels (see the
    // engine-divergence audit, desktop-js/tools/engine-divergence.ts), so the
    // desktop's JS engine is now the SOLE per-stock classifier and this
    // payload stopped emitting topBuy/topRisk/actionCounts. The summaries
    // survive purely to aggregate market-tone scores for marketContext.
    final summaries = signals.map(_summaryForRawSignal).toList();

    final snapshot = <String, Object?>{
      'asOf': asOf.toIso8601String(),
      'universeSize': fullUniverse.length,
      'returned': signals.length,
      'scenario': scenario,
      'priceCoverage': analytics.coverage.toJson(),
    };
    final history = await _appendHistory(snapshot, limit: historyLimit);

    return {
      'asOf': asOf.toIso8601String(),
      'source': 'finance-oracle-backend-cache',
      'detail': signals.isNotEmpty
          ? 'Decision signals use Yahoo adjusted-total-return OHLCV for trend, volatility, liquidity, breadth, drawdown, and relative strength; raw closes are retained separately for live-price display. SEC EDGAR XBRL fundamentals cover $fundamentalsCoverage of ${signals.length} names (quality, margin trend, free cash flow, revenue acceleration, valuation — ranked cross-sectionally with sector adjustment). Estimate revisions and listed-options feeds are not connected, so those fields stay neutral/proxied instead of simulated.'
          : 'Recommendations paused: no symbols have enough fresh cached OHLCV to support Buy/Hold/Sell decisions. Run Sync prices and wait for usable price coverage.',
      'universeSize': fullUniverse.length,
      'returned': signals.length,
      'excludedForInsufficientData': fullUniverse.length - signals.length,
      'fundamentalsCoverage': fundamentalsCoverage,
      'scenario': scenario,
      'marketContext': _marketContextFor(summaries, analytics),
      'rawSignals': signals,
      'history': history,
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

  /// Consecutive FUTILE-sync streaks per symbol, process-lifetime (the
  /// service is constructed per request, so this must be static). Futile
  /// means the attempt moved nothing forward: the fetch failed (delisted/
  /// renamed tickers), OR it succeeded but the stored series still cannot
  /// prove its adjusted analytics window (thin tickers with legitimate
  /// no-trade rows in their latest-200 — they can never pass). Both kinds
  /// used to re-enter the FRONT of the priority queue every pass and
  /// starve it: measured live as the same 96 symbols "syncing" every pass
  /// with scoreable frozen at 73/2500. Three futile attempts sends a
  /// symbol to the back of the queue AND (in auto mode) into a 7-day
  /// cooldown out of the candidate pool — without the cooldown, permanent
  /// candidates keep `requested` above zero forever and the warmup's
  /// nothing-left-to-sync exit can never fire. One eligible success
  /// clears everything, so a recovered ticker heals normally.
  static final Map<String, int> _syncFailureStreaks = <String, int>{};
  static final Map<String, DateTime> _lastFutileAttempt = <String, DateTime>{};
  static const int _kChronicFailureStreak = 3;
  static const Duration _kChronicRetryCooldown = Duration(days: 7);

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
      // Chronic-futility cooldown (auto mode only — an explicit force sync
      // is a user demand and includes everything): a symbol whose last 3+
      // attempts were futile sits out for 7 days. This is what lets
      // `requested` reach zero so callers can tell "done" from "looping".
      if (!force) {
        final chronic =
            (_syncFailureStreaks[symbol] ?? 0) >= _kChronicFailureStreak;
        final lastFutile = _lastFutileAttempt[symbol];
        if (chronic &&
            lastFutile != null &&
            now.difference(lastFutile) < _kChronicRetryCooldown) {
          return false;
        }
      }
      final series = state.seriesBySymbol[symbol];
      if (series == null) {
        return true;
      }
      // Pre-v3 cache rows either stored only raw close or could not prove that
      // Yahoo supplied every OHLCV field. They remain explicitly unverified
      // and must refresh before supporting return analytics; a fresh fetch
      // timestamp never makes legacy evidence look usable.
      return force ||
          !series.hasAdjustedTotalReturnPrices ||
          series.fetchedAt.isBefore(staleBefore);
    }).toList();

    final order = <String, int>{
      for (var index = 0; index < symbols.length; index++)
        symbols[index]: index,
    };
    candidates.sort((left, right) {
      // Chronic failures retry LAST (see _syncFailureStreaks above).
      final leftChronic =
          (_syncFailureStreaks[left] ?? 0) >= _kChronicFailureStreak ? 1 : 0;
      final rightChronic =
          (_syncFailureStreaks[right] ?? 0) >= _kChronicFailureStreak ? 1 : 0;
      if (leftChronic != rightChronic) {
        return leftChronic.compareTo(rightChronic);
      }
      final leftNeedsAdjustment =
          !(state.seriesBySymbol[left]?.hasAdjustedTotalReturnPrices ?? false);
      final rightNeedsAdjustment =
          !(state.seriesBySymbol[right]?.hasAdjustedTotalReturnPrices ?? false);
      if (leftNeedsAdjustment != rightNeedsAdjustment) {
        return leftNeedsAdjustment ? -1 : 1;
      }
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
      if (_cache.isStopped) {
        return DecisionPriceSyncResult.skipped(state: state, mode: syncMode);
      }
      final chunk = requested.skip(offset).take(8).toList();
      final results = await Future.wait(
        chunk.map((symbol) async {
          final series = await _fetchYahooSeries(symbol, now);
          return MapEntry(symbol, series);
        }),
      );
      for (final result in results) {
        if (_cache.isStopped) {
          return DecisionPriceSyncResult.skipped(state: state, mode: syncMode);
        }
        if (result.value == null) {
          failed.add(result.key);
          _syncFailureStreaks[result.key] =
              (_syncFailureStreaks[result.key] ?? 0) + 1;
          _lastFutileAttempt[result.key] = now;
        } else {
          final series = result.value!;
          // A fetch that SUCCEEDS but still cannot prove its adjusted
          // analytics window is exactly as futile as a failure. Thin
          // tickers (preferred shares, notes) have legitimate no-trade
          // rows inside their latest-200 window, so they can never pass
          // hasAdjustedTotalReturnPrices — yet each "successful" refetch
          // used to clear their streak AND re-enter them at the front of
          // the needs-adjustment priority, starving the whole queue:
          // measured live 2026-08-19 as 96/96 "synced" per pass with the
          // SAME symbols every pass and scoreable frozen at 73/2500.
          if (series.hasAdjustedTotalReturnPrices) {
            _syncFailureStreaks.remove(result.key);
            _lastFutileAttempt.remove(result.key);
          } else {
            _syncFailureStreaks[result.key] =
                (_syncFailureStreaks[result.key] ?? 0) + 1;
            _lastFutileAttempt[result.key] = now;
          }
          nextSeries[result.key] = series;
          updated.add(result.key);
        }
      }
    }

    final nextState = DecisionPriceHistoryState(
      lastSyncAt: DateTime.now().toUtc(),
      seriesBySymbol: nextSeries,
    );
    if (_cache.isStopped) {
      return DecisionPriceSyncResult.skipped(state: state, mode: syncMode);
    }
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
        'https://query1.finance.yahoo.com/v8/finance/chart/${Uri.encodeComponent(_toYahooSymbol(symbol))}?interval=1d&range=18mo&includeAdjustedClose=true',
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

  /// Full-history series for historical study mode, keyed by symbol and held
  /// in memory for the life of the server process (the service itself is
  /// constructed per request, so this must be static). Only SUCCESSES are
  /// cached: a failed fetch is often transient (Yahoo rate limit while the
  /// warmup sync is also running), so pinning a null would silently drop the
  /// name from every study date. Failures retry on later calls, up to a cap
  /// so a genuinely dead ticker stops burning fetches. Never persisted into
  /// the live price store.
  static final Map<String, DecisionPriceSeries> _studySeriesCache =
      <String, DecisionPriceSeries>{};
  static final Map<String, int> _studySeriesFailures = <String, int>{};
  static const int _kStudyFetchMaxAttempts = 3;

  Future<DecisionPriceSeries?> _fetchYahooMaxSeries(String symbol) async {
    try {
      // NOT range=max: Yahoo silently degrades range=max to coarse (monthly)
      // bars. Explicit period1/period2 epoch bounds keep interval=1d honored
      // over long windows — same trick the desktop's marketData.ts uses.
      // period2 anchors to the next UTC midnight so the URL (and the proxy
      // cache key) is stable within a day; 16 years covers a 15-year study
      // window plus the 200-row structural analytics window the signal
      // builder requires.
      final period2 =
          ((DateTime.now().toUtc().millisecondsSinceEpoch ~/ 86400000) + 1) *
          86400;
      final period1 = period2 - (16 * 365.25 * 86400).round();
      final uri = Uri.parse(
        'https://query1.finance.yahoo.com/v8/finance/chart/${Uri.encodeComponent(_toYahooSymbol(symbol))}?period1=$period1&period2=$period2&interval=1d&includePrePost=false&includeAdjustedClose=true&events=div%2Csplits',
      );
      final response = await _cache.fetch(uri);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        stdout.writeln(
          'study fetch for $symbol: upstream HTTP ${response.statusCode}',
        );
        return null;
      }
      final body = utf8.decode(response.body, allowMalformed: true);
      final series = DecisionPriceSeries.fromYahooChart(
        symbol: symbol,
        fetchedAt: DateTime.now().toUtc(),
        body: body,
        maxBars: 0, // keep FULL history — the study truncates per asOf date
      );
      if (series.bars.length < 5) {
        stdout.writeln(
          'study fetch for $symbol: only ${series.bars.length} bars parsed',
        );
      }
      return series;
    } catch (error) {
      // Surface WHY a study fetch failed — a silent null here once hid a
      // deterministic bug behind what looked like rate limiting.
      stdout.writeln('study fetch failed for $symbol: $error');
      return null;
    }
  }

  Future<void> _ensureStudySeries(List<String> symbols) async {
    final missing = symbols
        .where(
          (symbol) =>
              !_studySeriesCache.containsKey(symbol) &&
              (_studySeriesFailures[symbol] ?? 0) < _kStudyFetchMaxAttempts,
        )
        .toList();
    for (var offset = 0; offset < missing.length; offset += 8) {
      final chunk = missing.skip(offset).take(8).toList();
      await Future.wait(
        chunk.map((symbol) async {
          final series = await _fetchYahooMaxSeries(symbol);
          if (series != null && series.bars.length >= 5) {
            _studySeriesCache[symbol] = series;
            _studySeriesFailures.remove(symbol);
          } else {
            _studySeriesFailures[symbol] =
                (_studySeriesFailures[symbol] ?? 0) + 1;
          }
        }),
      );
    }
  }

  /// Rebuild raw signals as of a past date. Same metrics math, same
  /// cross-sectional ranks, same freshness gates as live — just anchored at
  /// [asOf] over series truncated at [asOf]. Fundamentals overlay is SKIPPED
  /// (the EDGAR overlay ranks current filings — using it here would be
  /// look-ahead), so quality/value/growth stay neutral exactly like today's
  /// uncovered names. Price-only by design; labeled in the payload.
  Future<Map<String, Object?>> _buildHistorical({
    required List<String> symbols,
    required DateTime asOf,
    required String scenario,
    bool pointInTimeFundamentals = false,
  }) async {
    await _ensureStudySeries(symbols);
    final truncated = <String, DecisionPriceSeries>{};
    for (final symbol in symbols) {
      final series = _studySeriesCache[symbol];
      if (series == null) continue;
      final bars = series.bars.where((bar) => !bar.date.isAfter(asOf)).toList();
      if (bars.length < 5) continue;
      truncated[symbol] = DecisionPriceSeries(
        symbol: series.symbol,
        source: series.source,
        fetchedAt: asOf,
        bars: bars,
      );
    }
    final state = DecisionPriceHistoryState(
      lastSyncAt: asOf,
      seriesBySymbol: truncated,
    );
    final analytics = DecisionPriceAnalytics.build(
      state,
      selectedSymbols: symbols,
      anchor: asOf,
    );
    final signals = <Map<String, Object?>>[];
    for (var index = 0; index < symbols.length; index++) {
      final profile = defaultSymbolProfileFor(symbols[index]);
      if (profile == null) continue;
      final rawSignal = _rawSignalFor(
        profile,
        analytics: analytics,
        scenario: scenario,
        index: index,
        anchor: asOf,
      );
      if (rawSignal != null) {
        signals.add(rawSignal);
      }
    }

    // Point-in-time fundamentals: fill quality/value/growth from filings
    // FILED on or before asOf, through the same overlay transforms live
    // uses. Ranks come from this date's own cross-section; live rank state
    // is never touched.
    var fundamentalsCoverage = 0;
    if (pointInTimeFundamentals) {
      final fundamentalsService = SecFundamentalsService.instance(_cache);
      await fundamentalsService.ensureStudyFacts([
        for (final signal in signals)
          if (signal['assetType'] != 'ETF') signal['ticker'] as String,
      ]);
      fundamentalsCoverage = fundamentalsService.overlayOnSignalsPointInTime(
        signals,
        asOf,
      );
    }

    final summaries = signals.map(_summaryForRawSignal).toList();
    return {
      'asOf': asOf.toIso8601String(),
      'historicalMode': true,
      'source': 'finance-oracle-backend-cache',
      'detail': pointInTimeFundamentals
          ? 'HISTORICAL STUDY MODE with POINT-IN-TIME fundamentals: signals '
                'rebuilt from Yahoo adjusted-total-return bars on or before the asOf date; quality/value/'
                'growth filled from SEC filings as FILED by that date (no '
                'look-ahead), covering $fundamentalsCoverage names. Revisions '
                'and options fields stay neutral. Universe is the CURRENT '
                'symbol list applied to the past (survivorship).'
          : 'HISTORICAL STUDY MODE: signals rebuilt from Yahoo adjusted-total-return bars on or before '
                'the asOf date through the production signal builder. '
                'Fundamentals, revisions, and options fields are neutral '
                '(price-only), matching how uncovered names run live. '
                'Universe is the CURRENT symbol list applied to the past, so '
                'delisted names are absent (survivorship).',
      'universeSize': symbols.length,
      'returned': signals.length,
      'excludedForInsufficientData': symbols.length - signals.length,
      'fundamentalsCoverage': fundamentalsCoverage,
      'scenario': scenario,
      'marketContext': _marketContextFor(summaries, analytics),
      'rawSignals': signals,
      'history': const <Object?>[],
      'priceCoverage': analytics.coverage.toJson(),
    };
  }

  Map<String, Object?>? _rawSignalFor(
    DefaultSymbolProfile profile, {
    required DecisionPriceAnalytics analytics,
    required String scenario,
    required int index,
    DateTime? anchor,
  }) {
    final symbol = profile.symbol;
    final isEtf = profile.isEtf || isCoreEtfSymbol(symbol);
    final metrics = analytics.metricsBySymbol[symbol];
    // Freshness is judged against the anchor date (the study date in
    // historical mode, the wall clock live) so a past bar isn't "stale".
    if (metrics == null ||
        metrics.barCount < 120 ||
        (anchor ?? DateTime.now().toUtc())
                .difference(metrics.priceAsOf)
                .inDays >
            8) {
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
      'dataSource': '${metrics.source}-adjusted-total-return-ohlcv',
      'priceBasis': metrics.priceBasis,
      'priceAdjustmentCoveragePct': metrics.adjustmentCoveragePct,
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
    // Market-TONE counts from raw scores, not per-stock actions — the backend
    // no longer classifies stocks (the desktop's JS engine is the sole
    // classifier). These thresholds only shade the regime/creditStress
    // aggregate strings; they never label an individual name.
    final buyCount = summaries
        .where((row) => row.opportunityScore >= 68 && row.riskScore <= 60)
        .length;
    final riskCount = summaries.where((row) => row.riskScore >= 60).length;
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
          'Adjusted-total-return OHLCV coverage ${analytics.coverage.usableSymbolCount}/${summaries.length}; top buy/risk signals are regime-scored after price-history replacement.',
      'liquidity': analytics.coverage.usableSymbolCount > 0
          ? 'Using cached Yahoo Finance adjusted daily history through ${analytics.coverage.latestPriceDateLabel}. Fundamentals/options remain proxy fields.'
          : 'Backend cache is reachable; price-history sync has not produced usable coverage yet.',
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
  }

  Future<List<Object?>> _appendHistory(
    Map<String, Object?> snapshot, {
    required int limit,
  }) async {
    if (_cache.isStopped) return const <Object?>[];
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
    if (_cache.isStopped) return const <Object?>[];
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

  /// All store file access is serialized process-wide. During the
  /// 2026-07-29 catch-up sync, one request READ this file while another
  /// was mid-WRITE: the torn read failed to parse, load() silently fell
  /// back to an empty store, that build synced 96 names onto the
  /// emptiness, and its save PERSISTED the wipe — 1,460 freshly synced
  /// names gone in one write. Three defenses below: the lock (no torn
  /// reads), tmp+rotate saves with a .bak (no half-written live file,
  /// recovery if a write dies), and a shrink guard (a suspiciously small
  /// state is refused rather than allowed to clobber the store).
  static Future<void> _fileLock = Future<void>.value();

  Future<T> _withFileLock<T>(Future<T> Function() action) {
    final previous = _fileLock;
    final gate = Completer<void>();
    _fileLock = gate.future;
    return previous.then((_) => action()).whenComplete(gate.complete);
  }

  File get _file => File(
    '${cacheDirectory.path}${Platform.pathSeparator}decision_price_history.json',
  );
  File get _backupFile => File('${_file.path}.bak');
  File get _tmpFile => File('${_file.path}.tmp');

  Future<DecisionPriceHistoryState> load() => _withFileLock(_loadLocked);

  Future<DecisionPriceHistoryState> _loadLocked() async {
    for (final candidate in [_file, _backupFile]) {
      if (!await candidate.exists()) {
        continue;
      }
      try {
        final decoded = jsonDecode(await candidate.readAsString());
        if (decoded is Map<String, dynamic>) {
          if (identical(candidate, _backupFile)) {
            stdout.writeln(
              'price store: primary unreadable — recovered from backup',
            );
          }
          return DecisionPriceHistoryState.fromJson(decoded);
        }
      } catch (error) {
        stdout.writeln('price store: could not read ${candidate.path}: $error');
      }
    }
    return DecisionPriceHistoryState.empty();
  }

  Future<void> save(DecisionPriceHistoryState state) =>
      _withFileLock(() => _saveLocked(state));

  Future<void> _saveLocked(DecisionPriceHistoryState state) async {
    await cacheDirectory.create(recursive: true);
    // Wipe guard: a state carrying under half the symbols currently on
    // disk almost certainly began from a failed (empty) load rather than
    // a genuine universe change. Refuse it loudly; the next honest build
    // reloads the intact store and re-syncs whatever this one fetched.
    final current = await _loadLocked();
    if (current.seriesBySymbol.length >= 50 &&
        state.seriesBySymbol.length < current.seriesBySymbol.length ~/ 2) {
      stdout.writeln(
        'price store: REFUSED save of ${state.seriesBySymbol.length} symbols '
        'over ${current.seriesBySymbol.length} on disk (wipe guard)',
      );
      return;
    }
    await _tmpFile.writeAsString(jsonEncode(state.toJson()), flush: true);
    // Rotate live -> .bak, tmp -> live. Windows rename cannot overwrite,
    // so targets are cleared first; the whole sequence runs under the
    // file lock, so no reader can observe the intermediate states.
    if (await _backupFile.exists()) {
      await _backupFile.delete();
    }
    if (await _file.exists()) {
      await _file.rename(_backupFile.path);
    }
    await _tmpFile.rename(_file.path);
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
  static const int currentSchemaVersion = 3;
  static const int analyticsWindowSize = 200;

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

  int get adjustedBarCount =>
      bars.where((bar) => bar.isAdjustedTotalReturn).length;

  int get unadjustedBarCount => bars.length - adjustedBarCount;

  int get incompleteProviderBarCount =>
      bars.where((bar) => !bar.isProviderRowComplete).length;

  double get adjustmentCoveragePct =>
      bars.isEmpty ? 0 : adjustedBarCount / bars.length * 100;

  List<DecisionPriceBar> get currentAnalyticsWindow =>
      bars.length < analyticsWindowSize
      ? const <DecisionPriceBar>[]
      : bars.sublist(bars.length - analyticsWindowSize);

  int get currentAnalyticsGapCount {
    final window = currentAnalyticsWindow;
    if (window.isEmpty) return analyticsWindowSize;
    var gaps = window.where((bar) => !bar.isAdjustedTotalReturn).length;
    for (var index = 1; index < window.length; index++) {
      if (!window[index].date.isAfter(window[index - 1].date)) gaps++;
    }
    return gaps;
  }

  bool get hasOlderAnalyticalGaps {
    final olderCount = bars.length - analyticsWindowSize;
    if (olderCount <= 0) return false;
    return bars.take(olderCount).any((bar) => !bar.isAdjustedTotalReturn);
  }

  // A count anywhere in the series is not sufficient: filtering through an
  // internal provider gap silently changes 20/60/120-day horizons. Decision
  // metrics require the exact latest 200 provider rows to be complete,
  // adjusted, and strictly ordered. Any tail gap forces a source refresh.
  bool get hasAdjustedTotalReturnPrices =>
      bars.length >= analyticsWindowSize && currentAnalyticsGapCount == 0;

  String get priceBasis {
    if (adjustedBarCount == bars.length && bars.isNotEmpty) {
      return 'adjusted-total-return';
    }
    if (adjustedBarCount > 0) {
      return 'mixed-adjusted-and-unadjusted';
    }
    return 'unadjusted-close';
  }

  String get adjustmentSource {
    if (adjustedBarCount > 0) return 'yahoo-chart-adjclose';
    if (bars.isEmpty) return 'unknown';
    final sources = bars.map((bar) => bar.adjustmentSource).toSet();
    return sources.length == 1 ? sources.first : 'mixed-unadjusted-sources';
  }

  Map<String, Object?> toJson() {
    return {
      'schemaVersion': currentSchemaVersion,
      'symbol': symbol,
      'source': source,
      'fetchedAt': fetchedAt.toIso8601String(),
      'priceBasis': priceBasis,
      'adjustmentSource': adjustmentSource,
      'adjustedBarCount': adjustedBarCount,
      'unadjustedBarCount': unadjustedBarCount,
      'incompleteProviderBarCount': incompleteProviderBarCount,
      'adjustmentCoveragePct': adjustmentCoveragePct,
      'analyticsWindowSize': analyticsWindowSize,
      'currentAnalyticsGapCount': currentAnalyticsGapCount,
      'hasOlderAnalyticalGaps': hasOlderAnalyticalGaps,
      'bars': bars.map((bar) => bar.toJson()).toList(),
    };
  }

  factory DecisionPriceSeries.fromJson(Map<String, dynamic> json) {
    final rawBars = json['bars'];
    if (rawBars is! List<dynamic>) {
      throw const FormatException('Cached price series had no bar list.');
    }
    final bars = <DecisionPriceBar>[];
    for (var index = 0; index < rawBars.length; index++) {
      final rawBar = rawBars[index];
      if (rawBar is! Map<String, dynamic>) {
        throw FormatException(
          'Cached price row at provider index $index was malformed.',
        );
      }
      bars.add(DecisionPriceBar.fromJson(rawBar));
    }
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
          rawOpen: open,
          rawHigh: high,
          rawLow: low,
          rawClose: close,
          adjustmentFactor: 1,
          adjustmentSource: 'stooq-unadjusted-close',
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
    // Live sync only needs the recent window, so it keeps the trailing 320
    // bars. Historical study mode passes 0 (unlimited): capping a 16-year
    // fetch to the newest 320 bars would silently erase all past history —
    // every as-of truncation before ~15 months ago would come back empty.
    int maxBars = 320,
  }) {
    final decoded = jsonDecode(body) as Map<String, dynamic>;
    final chart = decoded['chart'] as Map<String, dynamic>?;
    final result = chart?['result'];
    if (result is! List<dynamic> || result.isEmpty) {
      throw const FormatException('Yahoo chart response had no result rows.');
    }
    final entry = result.first as Map<String, dynamic>;
    // Preserve provider indexes. Filtering null timestamps before reading
    // quote/adjclose arrays would shift every subsequent price onto the
    // wrong date.
    final timestamps = entry['timestamp'] as List<dynamic>? ?? const [];
    final indicators = entry['indicators'] as Map<String, dynamic>?;
    final quoteList = indicators?['quote'];
    if (timestamps.isEmpty ||
        quoteList is! List<dynamic> ||
        quoteList.isEmpty) {
      throw const FormatException('Yahoo chart response had no OHLCV rows.');
    }
    final quote = quoteList.first as Map<String, dynamic>;
    final adjustedList = indicators?['adjclose'];
    if (adjustedList is! List<dynamic> ||
        adjustedList.isEmpty ||
        adjustedList.first is! Map<String, dynamic>) {
      // Never silently fall back to raw close: historical returns must use
      // Yahoo's split/distribution-adjusted total-return series.
      throw const FormatException(
        'Yahoo chart response had no adjusted-close rows.',
      );
    }
    final adjusted = adjustedList.first as Map<String, dynamic>;
    final bars = <DecisionPriceBar>[];
    int? previousTimestampMs;
    for (var index = 0; index < timestamps.length; index++) {
      final timestamp = timestamps[index];
      if (timestamp is! num || !timestamp.toDouble().isFinite) {
        throw FormatException(
          'Yahoo chart timestamp at provider index $index was invalid.',
        );
      }
      final timestampMsValue = timestamp.toDouble() * 1000;
      if (!timestampMsValue.isFinite) {
        throw FormatException(
          'Yahoo chart timestamp at provider index $index was non-finite.',
        );
      }
      final timestampMs = timestampMsValue.round();
      if (previousTimestampMs != null && timestampMs <= previousTimestampMs) {
        throw FormatException(
          'Yahoo chart timestamps were not strictly increasing at provider '
          'index $index.',
        );
      }
      final DateTime date;
      try {
        date = DateTime.fromMillisecondsSinceEpoch(timestampMs, isUtc: true);
      } on ArgumentError {
        throw FormatException(
          'Yahoo chart timestamp at provider index $index was out of range.',
        );
      }
      previousTimestampMs = timestampMs;
      final rawClose = _numberAt(quote['close'], index);
      final rawOpen = _numberAt(quote['open'], index);
      final rawHigh = _numberAt(quote['high'], index);
      final rawLow = _numberAt(quote['low'], index);
      final rawVolume = _numberAt(quote['volume'], index);
      final adjustedClose = _numberAt(adjusted['adjclose'], index);
      final hasRawClose = rawClose != null && rawClose > 0;
      final hasAdjustment = adjustedClose != null && adjustedClose > 0;
      var providerRowComplete = false;
      if (rawClose != null &&
          rawClose > 0 &&
          rawOpen != null &&
          rawOpen > 0 &&
          rawHigh != null &&
          rawHigh > 0 &&
          rawLow != null &&
          rawLow > 0 &&
          rawVolume != null &&
          rawVolume >= 0) {
        // A provider row is not complete merely because every field parses.
        // Impossible OHLC bounds are data corruption and stay display-only.
        providerRowComplete =
            rawHigh >= math.max(math.max(rawOpen, rawClose), rawLow) &&
            rawLow <= math.min(math.min(rawOpen, rawClose), rawHigh);
      }
      final factor = hasAdjustment && hasRawClose
          ? adjustedClose / rawClose
          : 1.0;
      bars.add(
        DecisionPriceBar(
          date: date,
          // Missing values remain explicit zero placeholders only so the
          // timestamp/provider row survives serialization. providerRowStatus
          // makes the row categorically ineligible for analytical use; no
          // flat OHLC or zero-volume bar is ever synthesized into metrics.
          open: rawOpen == null ? 0 : rawOpen * factor,
          high: rawHigh == null ? 0 : rawHigh * factor,
          low: rawLow == null ? 0 : rawLow * factor,
          close: hasAdjustment ? adjustedClose : (rawClose ?? 0),
          volume: rawVolume ?? 0,
          rawOpen: rawOpen,
          rawHigh: rawHigh,
          rawLow: rawLow,
          rawClose: rawClose,
          adjustmentFactor: factor,
          adjustmentSource: hasAdjustment
              ? 'yahoo-chart-adjclose'
              : 'yahoo-close-missing-adjclose',
          providerRowStatus: providerRowComplete
              ? 'complete'
              : 'invalid-or-incomplete-yahoo-ohlcv',
        ),
      );
    }
    if (bars.length < 5) {
      throw const FormatException('Yahoo chart response had too few bars.');
    }
    return DecisionPriceSeries(
      symbol: symbol,
      source: 'yahoo-finance',
      fetchedAt: fetchedAt,
      bars: maxBars > 0 && bars.length > maxBars
          ? bars.sublist(bars.length - maxBars)
          : bars,
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
    this.rawOpen,
    this.rawHigh,
    this.rawLow,
    this.rawClose,
    this.adjustmentFactor = 1,
    this.adjustmentSource = 'unadjusted-provider-close',
    this.providerRowStatus = 'complete',
  });

  final DateTime date;
  final double open;
  final double high;
  final double low;
  final double close;
  final double volume;
  final double? rawOpen;
  final double? rawHigh;
  final double? rawLow;
  final double? rawClose;
  final double adjustmentFactor;
  final String adjustmentSource;
  final String providerRowStatus;

  bool get isProviderRowComplete => providerRowStatus == 'complete';

  bool get isAdjustedTotalReturn =>
      adjustmentSource == 'yahoo-chart-adjclose' &&
      isProviderRowComplete &&
      open.isFinite &&
      open > 0 &&
      high.isFinite &&
      high > 0 &&
      low.isFinite &&
      low > 0 &&
      close.isFinite &&
      close > 0 &&
      high >= math.max(math.max(open, close), low) &&
      low <= math.min(math.min(open, close), high) &&
      volume.isFinite &&
      volume >= 0 &&
      rawOpen != null &&
      rawOpen!.isFinite &&
      rawOpen! > 0 &&
      rawHigh != null &&
      rawHigh!.isFinite &&
      rawHigh! > 0 &&
      rawLow != null &&
      rawLow!.isFinite &&
      rawLow! > 0 &&
      rawClose != null &&
      rawClose!.isFinite &&
      rawClose! > 0 &&
      rawHigh! >= math.max(math.max(rawOpen!, rawClose!), rawLow!) &&
      rawLow! <= math.min(math.min(rawOpen!, rawClose!), rawHigh!) &&
      adjustmentFactor.isFinite &&
      adjustmentFactor > 0;

  double get liveClose => rawClose ?? close;

  Map<String, Object?> toJson() {
    return {
      'date': date.toIso8601String(),
      'open': open,
      'high': high,
      'low': low,
      'close': close,
      'volume': volume,
      'rawOpen': rawOpen,
      'rawHigh': rawHigh,
      'rawLow': rawLow,
      'rawClose': rawClose,
      'adjustmentFactor': adjustmentFactor,
      'adjustmentSource': adjustmentSource,
      'providerRowStatus': providerRowStatus,
    };
  }

  factory DecisionPriceBar.fromJson(Map<String, dynamic> json) {
    final rawDate = json['date'];
    final parsedDate = rawDate is String ? DateTime.tryParse(rawDate) : null;
    return DecisionPriceBar(
      date: parsedDate ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      open: _num(json['open']),
      high: _num(json['high']),
      low: _num(json['low']),
      close: _num(json['close']),
      volume: _num(json['volume']),
      rawOpen: json['rawOpen'] is num ? _num(json['rawOpen']) : null,
      rawHigh: json['rawHigh'] is num ? _num(json['rawHigh']) : null,
      rawLow: json['rawLow'] is num ? _num(json['rawLow']) : null,
      rawClose: json['rawClose'] is num ? _num(json['rawClose']) : null,
      adjustmentFactor: json['adjustmentFactor'] is num
          ? _num(json['adjustmentFactor'])
          : 1,
      // Absence means this is a schema-v1 cache row. Keep it explicitly
      // raw and ineligible for analytics until the sync refreshes it.
      adjustmentSource:
          json['adjustmentSource'] as String? ?? 'legacy-unadjusted-close',
      // Missing status can never be inferred as complete: schema v2 could not
      // distinguish real Yahoo OHLCV from parser-filled flat/zero values, and
      // a damaged v3 row must also fail closed. A fresh v3 parser persists the
      // explicit status on every provider row.
      providerRowStatus: parsedDate == null
          ? 'invalid-cached-timestamp'
          : json['providerRowStatus'] as String? ?? 'legacy-unverified',
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
    DateTime? anchor,
  }) {
    final metricsBySymbol = <String, DecisionPriceMetrics>{};
    for (final symbol in selectedSymbols) {
      final series = state.seriesBySymbol[symbol];
      if (series == null) continue;
      final metrics = DecisionPriceMetrics.fromSeriesOrNull(
        series,
        anchor: anchor,
      );
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
    final coverage = DecisionPriceCoverage.fromState(
      state,
      selectedSymbols: selectedSymbols,
      usableSymbols: usableMetrics.length,
      anchor: anchor,
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
    required this.analyticalBarCount,
    required this.adjustedInventoryBarCount,
    required this.unadjustedBarCount,
    required this.incompleteProviderBarCount,
    required this.adjustedSeriesCount,
    required this.unadjustedOnlySeriesCount,
    required this.structurallyUsableSeriesCount,
    required this.currentAnalyticsGapSeriesCount,
    required this.latestPriceDate,
    required this.oldestPriceDate,
  });

  final int cachedSymbolCount;
  final int usableSymbolCount;
  final int freshSymbolCount;
  final int staleSymbolCount;
  final int totalBarCount;
  final int analyticalBarCount;
  final int adjustedInventoryBarCount;
  final int unadjustedBarCount;
  final int incompleteProviderBarCount;
  final int adjustedSeriesCount;
  final int unadjustedOnlySeriesCount;
  final int structurallyUsableSeriesCount;
  final int currentAnalyticsGapSeriesCount;
  final DateTime? latestPriceDate;
  final DateTime? oldestPriceDate;

  double get adjustmentCoveragePct =>
      totalBarCount <= 0 ? 0 : adjustedInventoryBarCount / totalBarCount * 100;

  String get priceBasis {
    if (adjustedInventoryBarCount > 0 && unadjustedBarCount == 0) {
      return 'adjusted-total-return';
    }
    if (adjustedInventoryBarCount > 0) {
      return 'mixed-adjusted-and-unadjusted';
    }
    return 'unadjusted-or-unavailable';
  }

  String get latestPriceDateLabel =>
      latestPriceDate == null ? 'unknown' : _dateLabel(latestPriceDate!);

  factory DecisionPriceCoverage.fromState(
    DecisionPriceHistoryState state, {
    required List<String> selectedSymbols,
    required int usableSymbols,
    DateTime? anchor,
  }) {
    final now = anchor ?? DateTime.now().toUtc();
    final selectedSet = selectedSymbols.toSet();
    var fresh = 0;
    var stale = 0;
    var totalBars = 0;
    var analyticalBars = 0;
    var adjustedInventoryBars = 0;
    var unadjustedBars = 0;
    var incompleteProviderBars = 0;
    var adjustedSeries = 0;
    var unadjustedOnlySeries = 0;
    var structurallyUsableSeries = 0;
    var currentAnalyticsGapSeries = 0;
    DateTime? latest;
    DateTime? oldest;
    for (final entry in state.seriesBySymbol.entries) {
      if (!selectedSet.contains(entry.key) || entry.value.bars.isEmpty) {
        continue;
      }
      final series = entry.value;
      totalBars += series.bars.length;
      adjustedInventoryBars += series.adjustedBarCount;
      unadjustedBars += series.unadjustedBarCount;
      incompleteProviderBars += series.incompleteProviderBarCount;
      if (series.adjustedBarCount > 0) adjustedSeries++;
      if (series.adjustedBarCount == 0) unadjustedOnlySeries++;
      // Fresh/stale coverage is meaningful only for a structurally usable
      // current window. Selecting adjusted rows from around a gap would make
      // an ineligible series look current.
      if (!series.hasAdjustedTotalReturnPrices) {
        currentAnalyticsGapSeries++;
        continue;
      }
      structurallyUsableSeries++;
      final currentWindow = series.currentAnalyticsWindow;
      analyticalBars += currentWindow.length;
      final date = currentWindow.last.date;
      final firstDate = currentWindow.first.date;
      if (now.difference(date).inDays <= 10) {
        fresh++;
      } else {
        stale++;
      }
      if (latest == null || date.isAfter(latest)) latest = date;
      if (oldest == null || firstDate.isBefore(oldest)) oldest = firstDate;
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
      analyticalBarCount: analyticalBars,
      adjustedInventoryBarCount: adjustedInventoryBars,
      unadjustedBarCount: unadjustedBars,
      incompleteProviderBarCount: incompleteProviderBars,
      adjustedSeriesCount: adjustedSeries,
      unadjustedOnlySeriesCount: unadjustedOnlySeries,
      structurallyUsableSeriesCount: structurallyUsableSeries,
      currentAnalyticsGapSeriesCount: currentAnalyticsGapSeries,
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
      'analyticalBarCount': analyticalBarCount,
      'adjustedInventoryBarCount': adjustedInventoryBarCount,
      'unadjustedBarCount': unadjustedBarCount,
      'incompleteProviderBarCount': incompleteProviderBarCount,
      'adjustedSeriesCount': adjustedSeriesCount,
      'unadjustedOnlySeriesCount': unadjustedOnlySeriesCount,
      'structurallyUsableSeriesCount': structurallyUsableSeriesCount,
      'currentAnalyticsGapSeriesCount': currentAnalyticsGapSeriesCount,
      'analyticsWindowSize': DecisionPriceSeries.analyticsWindowSize,
      'priceBasis': priceBasis,
      'adjustmentSource': adjustedInventoryBarCount > 0
          ? 'yahoo-chart-adjclose'
          : 'none',
      'adjustmentCoveragePct': adjustmentCoveragePct,
      'latestPriceDate': latestPriceDate?.toIso8601String(),
      'oldestPriceDate': oldestPriceDate?.toIso8601String(),
    };
  }
}

class DecisionPriceMetrics {
  const DecisionPriceMetrics({
    required this.symbol,
    required this.source,
    required this.priceBasis,
    required this.adjustmentCoveragePct,
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
  final String priceBasis;
  final double adjustmentCoveragePct;
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

  factory DecisionPriceMetrics.fromSeries(
    DecisionPriceSeries series, {
    DateTime? anchor,
  }) {
    // Never filter bad rows and compress a horizon. The exact latest 200
    // provider rows must be complete adjusted bars; one internal gap rejects
    // the series and puts it back in the refresh queue.
    if (!series.hasAdjustedTotalReturnPrices) {
      throw const FormatException(
        'Current 200-row analytics window is incomplete or unadjusted.',
      );
    }
    final bars = series.currentAnalyticsWindow;
    return DecisionPriceMetrics._fromBars(
      series.symbol,
      series.source,
      bars,
      adjustmentCoveragePct: series.adjustmentCoveragePct,
      hasOlderAnalyticalGaps: series.hasOlderAnalyticalGaps,
      anchor: anchor,
    );
  }

  static DecisionPriceMetrics? fromSeriesOrNull(
    DecisionPriceSeries series, {
    DateTime? anchor,
  }) {
    try {
      return DecisionPriceMetrics.fromSeries(series, anchor: anchor);
    } catch (_) {
      return null;
    }
  }

  factory DecisionPriceMetrics._fromBars(
    String symbol,
    String source,
    List<DecisionPriceBar> bars, {
    required double adjustmentCoveragePct,
    bool hasOlderAnalyticalGaps = false,
    // Historical study mode evaluates freshness relative to the study date,
    // not the wall clock — otherwise every past bar looks years stale.
    DateTime? anchor,
  }) {
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
    final dollarVolume = averageVolume20 * latest.liveClose;
    final ageDays = (anchor ?? DateTime.now().toUtc())
        .difference(latest.date)
        .inDays;
    final barScore = bars.length >= 180
        ? 100.0
        : bars.length >= 120
        ? 85.0
        : bars.length >= 60
        ? 65.0
        : bars.length >= 30
        ? 45.0
        : 25.0;
    // Tight freshness for daily-bar TRADING: a normal weekend/holiday gap is
    // <=4 days and stays clean; beyond that the last close is materially stale
    // and should not back a live buy/sell call at full confidence.
    final freshnessScore = ageDays <= 2
        ? 100.0
        : ageDays <= 4
        ? 82.0
        : ageDays <= 6
        ? 55.0
        : ageDays <= 10
        ? 30.0
        : 15.0;
    final warnings = <String>[];
    if (ageDays > 4) {
      warnings.add(
        'Latest daily bar is $ageDays days old — stale for a live decision.',
      );
    }
    if (dollarVolume < 10000000) {
      warnings.add('Liquidity proxy is thin.');
    }
    warnings.add(
      'Return features use Yahoo adjusted close '
      '(${adjustmentCoveragePct.toStringAsFixed(1)}% of cached rows); '
      'raw close is retained separately for live-price display.',
    );
    if (hasOlderAnalyticalGaps) {
      warnings.add(
        'Provider gaps exist before the current 200-row analytics window; '
        'metrics use only the contiguous adjusted tail.',
      );
    }
    // Staleness is a HARD ceiling on confidence, not just a 35%-weighted score:
    // a name with great history but a multi-day-old last bar is not a fresh
    // decision. >6d falls below the 45 scoreable floor (drops out); 4-6d shown
    // but de-rated. <=4d (normal weekend/holiday gap) is untouched.
    var dataConfidenceScore = _bounded(barScore * 0.65 + freshnessScore * 0.35);
    if (ageDays > 6) {
      dataConfidenceScore = math.min(dataConfidenceScore, 40);
    } else if (ageDays > 4) {
      dataConfidenceScore = math.min(dataConfidenceScore, 60);
    }
    return DecisionPriceMetrics(
      symbol: symbol,
      source: source,
      priceBasis: 'adjusted-total-return',
      adjustmentCoveragePct: adjustmentCoveragePct,
      priceAsOf: latest.date,
      barCount: bars.length,
      lastPrice: latest.liveClose,
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
      dataConfidence: dataConfidenceScore,
      warnings: warnings,
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

/// Score aggregate for one raw signal. NOT a classification: the backend's
/// per-stock action labeler (_classifyAction) was retired 2026-06-22 after the
/// engine-divergence audit showed it disagreed with the desktop's JS
/// scoreUniverse on ~half the labels — two classifiers, one screen. The
/// desktop's JS engine is the sole classifier; these scores only feed the
/// market-tone aggregates in _marketContextFor.
class DecisionSummary {
  const DecisionSummary({
    required this.ticker,
    required this.opportunityScore,
    required this.confidence,
    required this.riskScore,
    required this.fragilityScore,
    required this.thesisDamage,
  });

  final String ticker;
  final int opportunityScore;
  final int confidence;
  final int riskScore;
  final int fragilityScore;
  final int thesisDamage;
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
    opportunityScore: opportunity.round(),
    confidence: confidence.round(),
    riskScore: risk.round(),
    fragilityScore: fragility.round(),
    thesisDamage: thesisDamage.round(),
  );
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
    final number = value.toDouble();
    return number.isFinite ? number : null;
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
  bool _stopped = false;

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
  // Distress-model inputs (Altman 1983 Z''; Bharath-Shumway 2008 naive DD)
  static const List<String> _currentAssetConcepts = ['AssetsCurrent'];
  static const List<String> _currentLiabilityConcepts = ['LiabilitiesCurrent'];
  static const List<String> _retainedEarningsConcepts = [
    'RetainedEarningsAccumulatedDeficit',
  ];
  static const List<String> _operatingIncomeConcepts = ['OperatingIncomeLoss'];
  // Bharath-Shumway's F is DEBT (Compustat DLC + 0.5·DLTT), NOT total
  // liabilities — accounts payable, deposits, and policy reserves don't
  // belong in the default barrier.
  static const List<String> _shortTermDebtConcepts = [
    'DebtCurrent',
    'LongTermDebtCurrent',
    'ShortTermBorrowings',
  ];
  static const List<String> _longTermDebtConcepts = [
    'LongTermDebtNoncurrent',
    'LongTermDebt',
  ];
  static const List<String> _shareFallbackConcepts = [
    'CommonStockSharesOutstanding',
    'WeightedAverageNumberOfDilutedSharesOutstanding',
  ];

  int get coveredCount => _bySymbol.values.where((f) => f != null).length;
  int get attemptedCount => _computedAt.length;

  /// Stop accepting queued work and join the current SEC request. This makes
  /// BackendCacheServer.stop a real lifecycle boundary and releases cache
  /// handles before tests, updates, or app shutdown remove the directory.
  Future<void> stop({bool resetSingleton = true}) async {
    _stopped = true;
    _queue.clear();
    try {
      await _drain;
    } finally {
      if (resetSingleton && identical(_singleton, this)) _singleton = null;
    }
  }

  /// Queue stale/missing symbols and return a future that completes when
  /// the queue is drained. Safe to call repeatedly: symbols queued while a
  /// drain is running are handled by that same drain.
  Future<void> ensureWarm(Iterable<String> symbols) {
    if (_stopped) return Future<void>.value();
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
    if (_stopped) return Future<void>.value();
    return _drain ??= _drainQueue().whenComplete(() => _drain = null);
  }

  Future<void> _drainQueue() async {
    var attempted = 0;
    var computed = 0;
    while (!_stopped && _queue.isNotEmpty) {
      final symbol = _queue.first;
      _queue.remove(symbol);
      attempted++;
      try {
        final fundamentals = await _compute(symbol);
        if (_stopped) break;
        _bySymbol[symbol] = fundamentals;
        if (fundamentals != null) {
          computed++;
        }
      } catch (_) {
        // Best-effort: leave the symbol uncovered (fields stay neutral);
        // it is retried after _recomputeAfter.
      }
      if (_stopped) break;
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

  /// Full filing-occurrence bundles for the historical study, held for the
  /// process lifetime (fetch+parse of a companyfacts JSON is the expensive
  /// part; per-date knowledge cuts are cheap). Successes only; failures are
  /// capped so a CIK-less ETF stops burning fetch attempts.
  final Map<String, _FactBundle> _studyBundles = {};
  final Map<String, int> _studyBundleFailures = {};
  static const int _kStudyFactsMaxAttempts = 3;

  /// Warm the study fact bundles for [symbols] (SEC-paced, progress-logged).
  Future<void> ensureStudyFacts(Iterable<String> symbols) async {
    if (_stopped) return;
    final missing = [
      for (final symbol in symbols)
        if (!_studyBundles.containsKey(symbol) &&
            (_studyBundleFailures[symbol] ?? 0) < _kStudyFactsMaxAttempts)
          symbol,
    ];
    if (missing.isEmpty) {
      return;
    }
    var processed = 0;
    for (final symbol in missing) {
      if (_stopped) break;
      try {
        final bundle = await _loadFactBundle(symbol, dedup: false);
        if (_stopped) break;
        if (bundle != null) {
          _studyBundles[symbol] = bundle;
        } else {
          _studyBundleFailures[symbol] =
              (_studyBundleFailures[symbol] ?? 0) + 1;
        }
      } catch (_) {
        _studyBundleFailures[symbol] = (_studyBundleFailures[symbol] ?? 0) + 1;
      }
      processed++;
      if (!_stopped && _lastFetchTouchedNetwork) {
        await Future<void>.delayed(_politePause);
      }
      if (processed % 50 == 0) {
        stdout.writeln(
          'study fundamentals: $processed/${missing.length} bundles loaded '
          '(${_studyBundles.length} cached total)',
        );
      }
    }
    if (processed > 0) {
      stdout.writeln(
        'study fundamentals ready: ${_studyBundles.length} symbols with '
        'filing history (${_studyBundleFailures.length} without).',
      );
    }
  }

  /// Derived-snapshot memo: fundamentals only change when a NEW FILING
  /// crosses the knowledge date, so two knowledge dates that fall between
  /// the same two filings share one snapshot. Keyed by (symbol, count of
  /// filings known) — a weekly 15-year study reuses each quarterly filing
  /// epoch ~13 times, cutting 366k derivations to ~28k.
  final Map<String, List<DateTime>> _studyFiledDates = {};
  final Map<String, Map<int, _SymbolFundamentals?>> _studyDerived = {};

  /// Point-in-time snapshot for one symbol at [knowledge], from the study
  /// bundle cache. Null when the symbol has no filing history loaded or
  /// nothing had been filed yet by [knowledge].
  _SymbolFundamentals? _studyFundamentalsAsOf(
    String symbol,
    DateTime knowledge,
  ) {
    final bundle = _studyBundles[symbol];
    if (bundle == null) {
      return null;
    }
    final filed = _studyFiledDates[symbol] ??= _collectFiledDates(bundle);
    // Count of filings with filed <= knowledge (binary search on the
    // sorted unique filed dates). Same count => same knowable fact set.
    var lo = 0;
    var hi = filed.length;
    while (lo < hi) {
      final mid = (lo + hi) >> 1;
      if (filed[mid].isAfter(knowledge)) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    final epoch = lo;
    if (epoch == 0) {
      return null; // nothing filed yet — genuinely unknown at that date
    }
    final cache = _studyDerived[symbol] ??= {};
    if (cache.containsKey(epoch)) {
      return cache[epoch];
    }
    return cache[epoch] = _deriveAsOf(bundle, knowledge);
  }

  static List<DateTime> _collectFiledDates(_FactBundle bundle) {
    final set = <DateTime>{};
    for (final series in [
      bundle.revenue,
      bundle.netIncome,
      bundle.cashFlow,
      bundle.capex,
      bundle.assets,
      bundle.liabilities,
      bundle.equity,
      bundle.shares,
    ]) {
      for (final row in series) {
        set.add(row.filed);
      }
    }
    return set.toList()..sort();
  }

  /// Fill signals from point-in-time snapshots at [knowledge]. Ranks come
  /// ONLY from this cross-section (never the live full-universe ranks, and
  /// never stored back) so study calls cannot pollute live state.
  int overlayOnSignalsPointInTime(
    List<Map<String, Object?>> signals,
    DateTime knowledge,
  ) {
    final bySymbol = <String, _SymbolFundamentals?>{
      for (final signal in signals)
        if (signal['assetType'] != 'ETF')
          signal['ticker'] as String: _studyFundamentalsAsOf(
            signal['ticker'] as String,
            knowledge,
          ),
    };
    return _overlayWith(
      bySymbol,
      signals,
      useStoredRanks: false,
      storeRanks: false,
    );
  }

  /// Fill fundamental fields of stock raw-signals in place; returns how
  /// many symbols got at least one field. Must run BEFORE the signals are
  /// scored so the filled values flow into composites. [isFullUniverse]
  /// marks builds whose cross-section spans the whole scored universe;
  /// those refresh the stored ranks that limited builds reuse.
  int overlayOnSignals(
    List<Map<String, Object?>> signals, {
    required bool isFullUniverse,
  }) {
    return _overlayWith(
      _bySymbol,
      signals,
      useStoredRanks: !isFullUniverse,
      storeRanks: isFullUniverse,
    );
  }

  /// Shared overlay body: reads snapshots from [bySymbol] (live current map
  /// or a point-in-time map), ranks the covered cross-section, and fills the
  /// fundamental fields in place.
  int _overlayWith(
    Map<String, _SymbolFundamentals?> bySymbol,
    List<Map<String, Object?>> signals, {
    required bool useStoredRanks,
    required bool storeRanks,
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
      final fund = bySymbol[symbol];
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
    if (storeRanks && ranks.isNotEmpty) {
      _lastFullRanks = ranks;
    } else if (useStoredRanks && _lastFullRanks.isNotEmpty) {
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
      final fund = bySymbol[symbol];
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
        // No real fundamentals for this name — quality/margins/valuation stay
        // fabricated-neutral (50), which otherwise lets a weakly-supported name
        // look as average/safe as a fully-covered one. Surface the missing
        // evidence as LOW confidence (so the <55 low-data penalty + the UI data
        // pill fire) and tag provenance for the trust gate. Non-ETF only — ETFs
        // are already excluded from this overlay, so they are not penalized.
        signal['fundamentalsCovered'] = false;
        final c = (signal['dataConfidence'] as num?)?.toDouble() ?? 50;
        signal['dataConfidence'] = math.min(c, 50);
        continue;
      }
      covered++;
      signal['fundamentalsCovered'] = true;
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
          if (!warning.startsWith('Fundamental and estimate-revision')) warning,
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
    if (_stopped) return null;
    final cik = (await _loadCikMap())[_normalizeTicker(symbol)];
    if (_stopped) return null;
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
    var shares = _series(
      facts,
      'dei',
      const ['EntityCommonStockSharesOutstanding'],
      'shares',
      dedup: false,
    );
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
          _series(facts, 'us-gaap', const ['Liabilities'], 'USD', dedup: false),
        ),
        'equity': rows(
          _series(facts, 'us-gaap', _equityConcepts, 'USD', dedup: false),
        ),
        // Distress-model inputs: Altman (1983) Z'' needs working capital,
        // retained earnings, and operating income; Bharath-Shumway (2008)
        // naive distance-to-default needs the liability split.
        'currentAssets': rows(
          _series(facts, 'us-gaap', _currentAssetConcepts, 'USD', dedup: false),
        ),
        'currentLiabilities': rows(
          _series(
            facts,
            'us-gaap',
            _currentLiabilityConcepts,
            'USD',
            dedup: false,
          ),
        ),
        'retainedEarnings': rows(
          _series(
            facts,
            'us-gaap',
            _retainedEarningsConcepts,
            'USD',
            dedup: false,
          ),
        ),
        'operatingIncome': rows(
          _series(
            facts,
            'us-gaap',
            _operatingIncomeConcepts,
            'USD',
            dedup: false,
          ),
        ),
        'shortTermDebt': rows(
          _series(
            facts,
            'us-gaap',
            _shortTermDebtConcepts,
            'USD',
            dedup: false,
          ),
        ),
        'longTermDebt': rows(
          _series(facts, 'us-gaap', _longTermDebtConcepts, 'USD', dedup: false),
        ),
        'shares': rows(shares),
      },
      'metrics': _bySymbol[symbol]?.toJson(),
    };
  }

  Future<_SymbolFundamentals?> _compute(String symbol) async {
    final bundle = await _loadFactBundle(symbol, dedup: true);
    return bundle == null ? null : _derive(bundle);
  }

  /// Fetch + parse one symbol's companyfacts into raw fact series. With
  /// [dedup] each (start,end) period keeps only the latest-filed restatement
  /// (live "current best estimate"); with dedup:false every filing
  /// occurrence survives so [deriveAsOf] can reconstruct what was knowable
  /// at any past date without later restatements leaking backward.
  Future<_FactBundle?> _loadFactBundle(
    String symbol, {
    required bool dedup,
  }) async {
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
    var shares = _series(
      facts,
      'dei',
      const ['EntityCommonStockSharesOutstanding'],
      'shares',
      dedup: dedup,
    );
    if (shares.isEmpty) {
      shares = _series(
        facts,
        'us-gaap',
        _shareFallbackConcepts,
        'shares',
        dedup: dedup,
      );
    }
    return _FactBundle(
      revenue: _series(facts, 'us-gaap', _revenueConcepts, 'USD', dedup: dedup),
      netIncome: _series(
        facts,
        'us-gaap',
        _netIncomeConcepts,
        'USD',
        dedup: dedup,
      ),
      cashFlow: _series(
        facts,
        'us-gaap',
        _operatingCashFlowConcepts,
        'USD',
        dedup: dedup,
      ),
      capex: _series(facts, 'us-gaap', _capexConcepts, 'USD', dedup: dedup),
      assets: _series(facts, 'us-gaap', const ['Assets'], 'USD', dedup: dedup),
      liabilities: _series(
        facts,
        'us-gaap',
        const ['Liabilities'],
        'USD',
        dedup: dedup,
      ),
      equity: _series(facts, 'us-gaap', _equityConcepts, 'USD', dedup: dedup),
      shares: shares,
    );
  }

  /// What the metrics WOULD have read on [knowledge]: only facts FILED on or
  /// before that date participate, and per period the latest restatement
  /// filed by then wins. Feed a dedup:false bundle — a dedup:true bundle has
  /// already collapsed restatements using future knowledge.
  _SymbolFundamentals? _deriveAsOf(_FactBundle bundle, DateTime knowledge) {
    return _derive(
      _FactBundle(
        revenue: _knowledgeCut(bundle.revenue, knowledge),
        netIncome: _knowledgeCut(bundle.netIncome, knowledge),
        cashFlow: _knowledgeCut(bundle.cashFlow, knowledge),
        capex: _knowledgeCut(bundle.capex, knowledge),
        assets: _knowledgeCut(bundle.assets, knowledge),
        liabilities: _knowledgeCut(bundle.liabilities, knowledge),
        equity: _knowledgeCut(bundle.equity, knowledge),
        shares: _knowledgeCut(bundle.shares, knowledge),
      ),
    );
  }

  /// Knowledge filter: drop rows filed after [knowledge], then keep the
  /// latest-filed restatement per (start,end) period — the same collapse
  /// _series does with dedup:true, but bounded by what was filed in time.
  static List<_FactRow> _knowledgeCut(List<_FactRow> rows, DateTime knowledge) {
    final deduped = <String, _FactRow>{};
    for (final row in rows) {
      if (row.filed.isAfter(knowledge)) {
        continue;
      }
      final key =
          '${row.start?.toIso8601String() ?? 'instant'}:${row.end.toIso8601String()}';
      final existing = deduped[key];
      if (existing == null || row.filed.isAfter(existing.filed)) {
        deduped[key] = row;
      }
    }
    return deduped.values.toList()..sort((a, b) {
      final byEnd = a.end.compareTo(b.end);
      return byEnd != 0 ? byEnd : a.filed.compareTo(b.filed);
    });
  }

  /// Derive the metric snapshot from fact series. Shared verbatim by the
  /// live path (dedup:true, latest knowledge) and the point-in-time study
  /// path (knowledge-cut series) so the two can never drift apart.
  _SymbolFundamentals? _derive(_FactBundle bundle) {
    final revenue = bundle.revenue;
    final netIncome = bundle.netIncome;
    final cashFlow = bundle.cashFlow;
    final capex = bundle.capex;
    final assets = bundle.assets;
    final liabilities = bundle.liabilities;
    final equity = bundle.equity;
    final shares = bundle.shares;

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
          revenueAccelPp = revenueGrowthYoY - (lagTtm / lagPriorTtm - 1) * 100;
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
    if (assets.isNotEmpty && liabilities.isNotEmpty && assets.last.value > 0) {
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
    if (_stopped) return const <String, String>{};
    final cached = _cikByTicker;
    if (cached != null) {
      return cached;
    }
    final json = await _fetchJson(
      Uri.parse('https://www.sec.gov/files/company_tickers.json'),
    );
    if (_stopped) return const <String, String>{};
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
        map[_normalizeTicker(ticker)] = cik.toInt().toString().padLeft(10, '0');
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
    if (_stopped) return null;
    try {
      final entry = await _cache.fetch(uri);
      if (_stopped) return null;
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
  bool get isQuarterFlow => start != null && spanDays >= 70 && spanDays <= 110;
  bool get isAnnualFlow => start != null && spanDays >= 330 && spanDays <= 400;
}

/// Computed trailing metrics for one symbol; all fields nullable because
/// XBRL coverage varies by filer (banks lack Revenues, young filers lack
/// history, foreign filers report annually).
/// Raw fact series for one symbol — the parse-once form the derivations run
/// on. dedup:true bundles hold current-best-estimate series; dedup:false
/// bundles keep every filing occurrence for point-in-time reconstruction.
class _FactBundle {
  const _FactBundle({
    required this.revenue,
    required this.netIncome,
    required this.cashFlow,
    required this.capex,
    required this.assets,
    required this.liabilities,
    required this.equity,
    required this.shares,
  });

  final List<_FactRow> revenue;
  final List<_FactRow> netIncome;
  final List<_FactRow> cashFlow;
  final List<_FactRow> capex;
  final List<_FactRow> assets;
  final List<_FactRow> liabilities;
  final List<_FactRow> equity;
  final List<_FactRow> shares;
}

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
