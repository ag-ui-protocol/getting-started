import 'package:ag_ui/src/client/config.dart';
import 'package:ag_ui/src/sse/backoff_strategy.dart';
import 'package:test/test.dart';

void main() {
  group('AgUiClientConfig', () {
    test('creates with required baseUrl only', () {
      final config = AgUiClientConfig(baseUrl: 'http://localhost:8000');

      expect(config.baseUrl, equals('http://localhost:8000'));
      expect(config.defaultHeaders, isEmpty);
      expect(config.requestTimeout, equals(Duration(seconds: 30)));
      expect(config.connectionTimeout, equals(Duration(seconds: 60)));
      expect(config.backoffStrategy, isA<ExponentialBackoff>());
      expect(config.maxRetries, equals(3));
      expect(config.withCredentials, isFalse);
    });

    test('creates with all parameters', () {
      final customBackoff = ConstantBackoff(Duration(seconds: 1));
      final customHeaders = {
        'Authorization': 'Bearer token',
        'X-Custom': 'value',
      };

      final config = AgUiClientConfig(
        baseUrl: 'https://api.example.com',
        defaultHeaders: customHeaders,
        requestTimeout: Duration(seconds: 45),
        connectionTimeout: Duration(seconds: 90),
        backoffStrategy: customBackoff,
        maxRetries: 5,
        withCredentials: true,
      );

      expect(config.baseUrl, equals('https://api.example.com'));
      expect(config.defaultHeaders, equals(customHeaders));
      expect(config.requestTimeout, equals(Duration(seconds: 45)));
      expect(config.connectionTimeout, equals(Duration(seconds: 90)));
      expect(config.backoffStrategy, equals(customBackoff));
      expect(config.maxRetries, equals(5));
      expect(config.withCredentials, isTrue);
    });

    test('default backoff strategy is ExponentialBackoff', () {
      final config = AgUiClientConfig(baseUrl: 'http://localhost');
      expect(config.backoffStrategy, isA<ExponentialBackoff>());
    });

    test('accepts custom backoff strategy', () {
      final customBackoff = LegacyBackoffStrategy();
      final config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        backoffStrategy: customBackoff,
      );

      expect(config.backoffStrategy, equals(customBackoff));
      expect(config.backoffStrategy, isA<LegacyBackoffStrategy>());
    });

    test('copyWith returns new instance with updated values', () {
      final original = AgUiClientConfig(
        baseUrl: 'http://original.com',
        defaultHeaders: {'Original': 'header'},
        maxRetries: 3,
      );

      final modified = original.copyWith(
        baseUrl: 'http://modified.com',
        maxRetries: 5,
      );

      // Modified values should be updated
      expect(modified.baseUrl, equals('http://modified.com'));
      expect(modified.maxRetries, equals(5));

      // Unmodified values should remain the same
      expect(modified.defaultHeaders, equals({'Original': 'header'}));
      expect(modified.requestTimeout, equals(original.requestTimeout));
      expect(modified.connectionTimeout, equals(original.connectionTimeout));
      expect(modified.withCredentials, equals(original.withCredentials));

      // Should be different instances
      expect(identical(original, modified), isFalse);
    });

    test('copyWith without arguments returns equivalent config', () {
      final original = AgUiClientConfig(
        baseUrl: 'http://example.com',
        defaultHeaders: {'Key': 'value'},
        requestTimeout: Duration(seconds: 15),
        connectionTimeout: Duration(seconds: 45),
        maxRetries: 7,
        withCredentials: true,
      );

      final copy = original.copyWith();

      expect(copy.baseUrl, equals(original.baseUrl));
      expect(copy.defaultHeaders, equals(original.defaultHeaders));
      expect(copy.requestTimeout, equals(original.requestTimeout));
      expect(copy.connectionTimeout, equals(original.connectionTimeout));
      expect(copy.maxRetries, equals(original.maxRetries));
      expect(copy.withCredentials, equals(original.withCredentials));

      // Should be different instances
      expect(identical(original, copy), isFalse);
    });

    test('copyWith can update all fields', () {
      final original = AgUiClientConfig(baseUrl: 'http://original.com');
      final newBackoff = ConstantBackoff(Duration(milliseconds: 500));

      final modified = original.copyWith(
        baseUrl: 'http://new.com',
        defaultHeaders: {'New': 'header'},
        requestTimeout: Duration(seconds: 10),
        connectionTimeout: Duration(seconds: 20),
        backoffStrategy: newBackoff,
        maxRetries: 10,
        withCredentials: true,
      );

      expect(modified.baseUrl, equals('http://new.com'));
      expect(modified.defaultHeaders, equals({'New': 'header'}));
      expect(modified.requestTimeout, equals(Duration(seconds: 10)));
      expect(modified.connectionTimeout, equals(Duration(seconds: 20)));
      expect(modified.backoffStrategy, equals(newBackoff));
      expect(modified.maxRetries, equals(10));
      expect(modified.withCredentials, isTrue);
    });

    test('defaultHeaders accepts empty map', () {
      final config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        defaultHeaders: {},
      );

      expect(config.defaultHeaders, isEmpty);
    });

    test('defaultHeaders preserves map contents', () {
      final headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-API-Key': '12345',
      };

      final config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        defaultHeaders: headers,
      );

      expect(config.defaultHeaders, equals(headers));
      expect(config.defaultHeaders['Content-Type'], equals('application/json'));
      expect(config.defaultHeaders['Accept'], equals('text/event-stream'));
      expect(config.defaultHeaders['X-API-Key'], equals('12345'));
    });

    test('timeout durations work with various values', () {
      final config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        requestTimeout: Duration(milliseconds: 100),
        connectionTimeout: Duration(hours: 1),
      );

      expect(config.requestTimeout.inMilliseconds, equals(100));
      expect(config.connectionTimeout.inHours, equals(1));
    });

    test('maxRetries accepts various values', () {
      // Zero retries
      var config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        maxRetries: 0,
      );
      expect(config.maxRetries, equals(0));

      // Large number of retries
      config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        maxRetries: 100,
      );
      expect(config.maxRetries, equals(100));
    });

    test('baseUrl handles various URL formats', () {
      // HTTP URL
      var config = AgUiClientConfig(baseUrl: 'http://example.com');
      expect(config.baseUrl, equals('http://example.com'));

      // HTTPS URL
      config = AgUiClientConfig(baseUrl: 'https://secure.example.com');
      expect(config.baseUrl, equals('https://secure.example.com'));

      // URL with port
      config = AgUiClientConfig(baseUrl: 'http://localhost:8080');
      expect(config.baseUrl, equals('http://localhost:8080'));

      // URL with path
      config = AgUiClientConfig(baseUrl: 'https://api.example.com/v1');
      expect(config.baseUrl, equals('https://api.example.com/v1'));

      // URL with trailing slash
      config = AgUiClientConfig(baseUrl: 'http://example.com/');
      expect(config.baseUrl, equals('http://example.com/'));
    });

    test('configuration example from documentation works', () {
      // Test the example from the class documentation
      final config = AgUiClientConfig(
        baseUrl: 'http://localhost:8000',
        defaultHeaders: {'Authorization': 'Bearer token'},
        maxRetries: 5,
      );

      expect(config.baseUrl, equals('http://localhost:8000'));
      expect(config.defaultHeaders['Authorization'], equals('Bearer token'));
      expect(config.maxRetries, equals(5));
    });

    test('withCredentials flag works correctly', () {
      // Default is false
      var config = AgUiClientConfig(baseUrl: 'http://localhost');
      expect(config.withCredentials, isFalse);

      // Can be set to true
      config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        withCredentials: true,
      );
      expect(config.withCredentials, isTrue);

      // Can be explicitly set to false
      config = AgUiClientConfig(
        baseUrl: 'http://localhost',
        withCredentials: false,
      );
      expect(config.withCredentials, isFalse);

      // copyWith preserves the value
      final original = AgUiClientConfig(
        baseUrl: 'http://localhost',
        withCredentials: true,
      );
      final copy = original.copyWith();
      expect(copy.withCredentials, isTrue);
    });

    group('edge cases', () {
      test('handles empty baseUrl', () {
        final config = AgUiClientConfig(baseUrl: '');
        expect(config.baseUrl, equals(''));
      });

      test('handles negative maxRetries', () {
        // This should work since Dart doesn't enforce non-negative integers
        final config = AgUiClientConfig(
          baseUrl: 'http://localhost',
          maxRetries: -1,
        );
        expect(config.maxRetries, equals(-1));
      });

      test('handles Duration.zero for timeouts', () {
        final config = AgUiClientConfig(
          baseUrl: 'http://localhost',
          requestTimeout: Duration.zero,
          connectionTimeout: Duration.zero,
        );
        expect(config.requestTimeout, equals(Duration.zero));
        expect(config.connectionTimeout, equals(Duration.zero));
      });
    });
  });
}
