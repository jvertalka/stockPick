import 'dart:io';

Future<void> main(List<String> args) async {
  final port = _parsePort(args) ?? 8081;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);

  stdout.writeln(
    'Alpha Vantage dev proxy listening on http://${server.address.address}:$port',
  );

  await for (final request in server) {
    if (request.method == 'OPTIONS') {
      _writeCorsHeaders(request.response);
      request.response
        ..statusCode = HttpStatus.noContent
        ..close();
      continue;
    }

    if (request.method != 'GET' || request.uri.path != '/query') {
      _writeCorsHeaders(request.response);
      request.response
        ..statusCode = HttpStatus.notFound
        ..write('Expected GET /query')
        ..close();
      continue;
    }

    final upstreamUri = Uri.https(
      'www.alphavantage.co',
      '/query',
      request.uri.queryParameters,
    );

    try {
      final client = HttpClient();
      final upstreamRequest = await client.getUrl(upstreamUri);
      final upstreamResponse = await upstreamRequest.close();
      final body = await upstreamResponse
          .transform(const SystemEncoding().decoder)
          .join();

      _writeCorsHeaders(request.response);
      final contentType = upstreamResponse.headers.contentType;
      if (contentType != null) {
        request.response.headers.contentType = contentType;
      }

      request.response.statusCode = upstreamResponse.statusCode;
      request.response.write(body);
      await request.response.close();
      client.close();
    } catch (error) {
      _writeCorsHeaders(request.response);
      request.response
        ..statusCode = HttpStatus.badGateway
        ..write('Alpha Vantage proxy error: $error');
      await request.response.close();
    }
  }
}

int? _parsePort(List<String> args) {
  for (final arg in args) {
    if (arg.startsWith('--port=')) {
      return int.tryParse(arg.substring('--port='.length));
    }
  }
  return null;
}

void _writeCorsHeaders(HttpResponse response) {
  response.headers
    ..set('Access-Control-Allow-Origin', '*')
    ..set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    ..set('Access-Control-Allow-Headers', 'Content-Type');
}
