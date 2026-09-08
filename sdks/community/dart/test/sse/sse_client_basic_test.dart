import 'package:ag_ui/src/sse/backoff_strategy.dart';
import 'package:ag_ui/src/sse/sse_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  group('SseClient Basic Tests', () {
    test('constructor initializes with default parameters', () {
      final client = SseClient();
      expect(client.isConnected, isFalse);
      expect(client.lastEventId, isNull);
    });

    test('constructor accepts custom parameters', () {
      final customHttpClient = MockClient((request) async {
        return http.Response('', 200);
      });
      final customTimeout = Duration(seconds: 30);
      final customBackoff = ExponentialBackoff();

      final client = SseClient(
        httpClient: customHttpClient,
        idleTimeout: customTimeout,
        backoffStrategy: customBackoff,
      );

      expect(client.isConnected, isFalse);
    });

    test('close is idempotent', () async {
      final client = SseClient();

      // Multiple closes should not throw
      await client.close();
      await client.close();
      await client.close();

      expect(client.isConnected, isFalse);
    });

    test('isConnected returns false when not connected', () {
      final client = SseClient();
      expect(client.isConnected, isFalse);
    });

    test('lastEventId is initially null', () {
      final client = SseClient();
      expect(client.lastEventId, isNull);
    });

    test('different backoff strategies can be used', () {
      // Test with ExponentialBackoff
      var client = SseClient(
        backoffStrategy: ExponentialBackoff(
          initialDelay: Duration(milliseconds: 100),
          maxDelay: Duration(seconds: 10),
        ),
      );
      expect(client.isConnected, isFalse);

      // Test with ConstantBackoff
      client = SseClient(
        backoffStrategy: ConstantBackoff(Duration(seconds: 1)),
      );
      expect(client.isConnected, isFalse);

      // Test with LegacyBackoffStrategy
      client = SseClient(
        backoffStrategy: LegacyBackoffStrategy(),
      );
      expect(client.isConnected, isFalse);
    });
  });
}
