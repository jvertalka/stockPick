import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/backend_cache_server.dart';

void main() {
  test('backend cache serves health and rejects unknown proxy hosts', () async {
    final port = await _freePort();
    final cacheDir = await Directory.systemTemp.createTemp(
      'finance-cache-test-cache-',
    );
    final webRoot = await Directory.systemTemp.createTemp(
      'finance-cache-test-web-',
    );
    await File(
      '${webRoot.path}${Platform.pathSeparator}index.html',
    ).writeAsString('<html><body>Finance Oracle</body></html>');

    final server = BackendCacheServer(
      BackendCacheConfig(
        host: '127.0.0.1',
        port: port,
        cacheDirectory: cacheDir,
        webRoot: webRoot,
        warmup: false,
      ),
    );
    final serverFuture = server.start();

    try {
      await _waitForServer(port);
      final health = await _getJson('http://127.0.0.1:$port/health');
      expect(health['ok'], isTrue);
      expect(health['proxyPrefix'], 'http://127.0.0.1:$port/proxy?url=');

      final proxyResponse = await _get(
        'http://127.0.0.1:$port/proxy?url=https%3A%2F%2Fexample.com%2Fdata.json',
      );
      expect(proxyResponse.statusCode, HttpStatus.forbidden);
      await proxyResponse.drain<void>();

      final hostileOrigin = await _get(
        'http://127.0.0.1:$port/proxy?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fdata.json',
        headers: {'Origin': 'https://evil.example'},
      );
      expect(hostileOrigin.statusCode, HttpStatus.forbidden);
      expect(
        jsonDecode(await utf8.decoder.bind(hostileOrigin).join()),
        containsPair('error', 'browser_context_not_allowed'),
      );

      final hostileTauriOrigin = await _get(
        'http://127.0.0.1:$port/proxy?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fdata.json',
        headers: {'Origin': 'tauri://evil.example'},
      );
      expect(hostileTauriOrigin.statusCode, HttpStatus.forbidden);
      expect(
        jsonDecode(await utf8.decoder.bind(hostileTauriOrigin).join()),
        containsPair('error', 'browser_context_not_allowed'),
      );

      final crossSiteWithoutOrigin = await _get(
        'http://127.0.0.1:$port/decision/universe?sync=force&syncLimit=1',
        headers: {'Sec-Fetch-Site': 'cross-site'},
      );
      expect(crossSiteWithoutOrigin.statusCode, HttpStatus.forbidden);
      await crossSiteWithoutOrigin.drain<void>();

      // WebView2 may classify localhost -> 127.0.0.1 as cross-site. The
      // explicit approved Origin is stronger evidence and must remain usable.
      final localOriginCrossSite = await _get(
        'http://127.0.0.1:$port/proxy?url=https%3A%2F%2Fexample.com%2Fdata.json',
        headers: {
          'Origin': 'http://localhost:5173',
          'Sec-Fetch-Site': 'cross-site',
        },
      );
      expect(localOriginCrossSite.statusCode, HttpStatus.forbidden);
      expect(
        localOriginCrossSite.headers.value('access-control-expose-headers'),
        contains('X-Finance-Oracle-Cache'),
      );
      expect(
        jsonDecode(await utf8.decoder.bind(localOriginCrossSite).join()),
        containsPair('error', 'url_not_allowed'),
      );

      final localTauriCrossSite = await _get(
        'http://127.0.0.1:$port/proxy?url=https%3A%2F%2Fexample.com%2Fdata.json',
        headers: {
          'Origin': 'tauri://localhost',
          'Sec-Fetch-Site': 'cross-site',
        },
      );
      expect(localTauriCrossSite.statusCode, HttpStatus.forbidden);
      expect(
        jsonDecode(await utf8.decoder.bind(localTauriCrossSite).join()),
        containsPair('error', 'url_not_allowed'),
      );

      final insecureAllowlisted = await _get(
        'http://127.0.0.1:$port/proxy?url=http%3A%2F%2Fquery1.finance.yahoo.com%2Fdata.json',
        headers: {'Origin': 'http://localhost:5173'},
      );
      expect(insecureAllowlisted.statusCode, HttpStatus.forbidden);
      expect(
        jsonDecode(await utf8.decoder.bind(insecureAllowlisted).join()),
        containsPair('error', 'url_not_allowed'),
      );

      final index = await _get('http://127.0.0.1:$port/');
      expect(index.statusCode, HttpStatus.ok);
      expect(await utf8.decoder.bind(index).join(), contains('Finance Oracle'));
    } finally {
      await server.stop();
      await serverFuture.timeout(const Duration(seconds: 2));
      await cacheDir.delete(recursive: true);
      await webRoot.delete(recursive: true);
    }
  });

  test(
    'decision universe pauses recommendations without live price history',
    () async {
      final port = await _freePort();
      final cacheDir = await Directory.systemTemp.createTemp(
        'finance-cache-test-empty-cache-',
      );
      final webRoot = await Directory.systemTemp.createTemp(
        'finance-cache-test-empty-web-',
      );
      await File(
        '${webRoot.path}${Platform.pathSeparator}index.html',
      ).writeAsString('<html><body>Finance Oracle</body></html>');

      final server = BackendCacheServer(
        BackendCacheConfig(
          host: '127.0.0.1',
          port: port,
          cacheDirectory: cacheDir,
          webRoot: webRoot,
          warmup: false,
        ),
      );
      final serverFuture = server.start();

      try {
        await _waitForServer(port);
        final universe = await _getJson(
          'http://127.0.0.1:$port/decision/universe?sync=off',
        );

        expect(universe['returned'], 0);
        expect(universe['rawSignals'], isEmpty);
        expect(universe['detail'], contains('Recommendations paused'));
        expect(
          universe['excludedForInsufficientData'],
          universe['universeSize'],
        );
      } finally {
        await server.stop();
        await serverFuture.timeout(const Duration(seconds: 2));
        await cacheDir.delete(recursive: true);
        await webRoot.delete(recursive: true);
      }
    },
  );

  test(
    'proxy allowlist requires HTTPS without user-info or custom ports',
    () async {
      final cacheDir = await Directory.systemTemp.createTemp(
        'finance-cache-test-allowlist-',
      );
      final client = HttpClient();
      final cache = MarketDataCache(cacheDir, client: client);
      try {
        expect(
          cache.isAllowed(
            Uri.parse('https://api.tradier.com/v1/markets/quotes'),
          ),
          isTrue,
        );
        expect(
          cache.isAllowed(
            Uri.parse('http://api.tradier.com/v1/markets/quotes'),
          ),
          isFalse,
        );
        expect(
          cache.isAllowed(
            Uri.parse('https://api.tradier.com:444/v1/markets/quotes'),
          ),
          isFalse,
        );
        expect(
          cache.isAllowed(
            Uri.parse('https://user:secret@api.tradier.com/v1/markets/quotes'),
          ),
          isFalse,
        );

        final marketUri = Uri.parse(
          'https://api.tradier.com/v1/markets/quotes?symbols=AAPL',
        );
        final jsonKey = cache.cachePartitionKey(
          marketUri,
          acceptHeader: 'application/json',
        );
        final canonicalJsonKey = cache.cachePartitionKey(
          marketUri,
          acceptHeader: '  APPLICATION/JSON  ',
        );
        final xmlKey = cache.cachePartitionKey(
          marketUri,
          acceptHeader: 'application/xml',
        );
        expect(jsonKey, canonicalJsonKey);
        expect(jsonKey, isNot(xmlKey));

        const firstCredential = 'Bearer test-credential-one';
        const secondCredential = 'Bearer test-credential-two';
        final firstCredentialKey = cache.cachePartitionKey(
          marketUri,
          authHeader: firstCredential,
          acceptHeader: 'application/json',
        );
        final secondCredentialKey = cache.cachePartitionKey(
          marketUri,
          authHeader: secondCredential,
          acceptHeader: 'application/json',
        );
        expect(firstCredentialKey, isNot(secondCredentialKey));
        expect(firstCredentialKey, isNot(contains('test-credential-one')));
        expect(cache.isCacheable(marketUri), isTrue);
        expect(
          cache.isCacheable(marketUri, authHeader: firstCredential),
          isFalse,
        );
        expect(
          cache.isCacheable(
            Uri.parse('https://api.tradier.com/v1/accounts/ABC/positions'),
          ),
          isFalse,
        );
      } finally {
        cache.stop();
        client.close(force: true);
        await cacheDir.delete(recursive: true);
      }
    },
  );

  test(
    'shutdown joins an active decision request before cache deletion',
    () async {
      final port = await _freePort();
      final cacheDir = await Directory.systemTemp.createTemp(
        'finance-cache-test-shutdown-cache-',
      );
      final webRoot = await Directory.systemTemp.createTemp(
        'finance-cache-test-shutdown-web-',
      );
      final server = BackendCacheServer(
        BackendCacheConfig(
          host: '127.0.0.1',
          port: port,
          cacheDirectory: cacheDir,
          webRoot: webRoot,
          warmup: false,
        ),
      );
      final serverFuture = server.start();

      try {
        await _waitForServer(port);
        final pending = _get(
          'http://127.0.0.1:$port/decision/universe?limit=1&sync=force&syncLimit=1',
        );
        await Future<void>.delayed(const Duration(milliseconds: 40));
        await server.stop().timeout(const Duration(seconds: 5));
        try {
          final response = await pending.timeout(const Duration(seconds: 2));
          await response.drain<void>();
        } catch (_) {
          // The listener intentionally force-closes active response sockets.
        }
        await serverFuture.timeout(const Duration(seconds: 2));
        await cacheDir.delete(recursive: true);
        await webRoot.delete(recursive: true);
        expect(await cacheDir.exists(), isFalse);
      } finally {
        await server.stop();
        if (await cacheDir.exists()) await cacheDir.delete(recursive: true);
        if (await webRoot.exists()) await webRoot.delete(recursive: true);
      }
    },
  );

  test('stopped SEC service never restarts its queue drain', () async {
    final cacheDir = await Directory.systemTemp.createTemp(
      'finance-cache-test-sec-stop-',
    );
    final client = HttpClient();
    final cache = MarketDataCache(cacheDir, client: client);
    final fundamentals = SecFundamentalsService.instance(cache);
    try {
      await fundamentals.stop(resetSingleton: false);
      await fundamentals.ensureWarm(const ['AAPL']);
      expect(fundamentals.attemptedCount, 0);
    } finally {
      await fundamentals.stop();
      cache.stop();
      client.close(force: true);
      await cacheDir.delete(recursive: true);
    }
  });
}

Future<int> _freePort() async {
  final socket = await ServerSocket.bind('127.0.0.1', 0);
  final port = socket.port;
  await socket.close();
  return port;
}

Future<void> _waitForServer(int port) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (DateTime.now().isBefore(deadline)) {
    try {
      final response = await _get('http://127.0.0.1:$port/health');
      await response.drain<void>();
      if (response.statusCode == HttpStatus.ok) {
        return;
      }
    } catch (_) {
      await Future<void>.delayed(const Duration(milliseconds: 80));
    }
  }
  fail('Backend cache server did not start on port $port.');
}

Future<Map<String, dynamic>> _getJson(String url) async {
  final response = await _get(url);
  final body = await utf8.decoder.bind(response).join();
  return jsonDecode(body) as Map<String, dynamic>;
}

Future<HttpClientResponse> _get(
  String url, {
  Map<String, String> headers = const <String, String>{},
}) async {
  final client = HttpClient();
  addTearDown(client.close);
  final request = await client.getUrl(Uri.parse(url));
  headers.forEach(request.headers.set);
  return request.close();
}
