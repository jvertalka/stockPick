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

Future<HttpClientResponse> _get(String url) async {
  final client = HttpClient();
  addTearDown(client.close);
  final request = await client.getUrl(Uri.parse(url));
  return request.close();
}
