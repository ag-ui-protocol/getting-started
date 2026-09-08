import 'package:test/test.dart';
import 'package:ag_ui/src/client/errors.dart';

void main() {
  group('AgUiError', () {
    test('base error formats correctly', () {
      final error = TestError('Test message');
      expect(error.message, equals('Test message'));
      expect(error.toString(), contains('TestError: Test message'));
    });

    test('base error includes details', () {
      final error = TestError(
        'Test message',
        details: {'key': 'value'},
      );
      expect(error.toString(), contains('details: {key: value}'));
    });

    test('base error includes cause', () {
      final cause = Exception('Original error');
      final error = TestError(
        'Test message',
        cause: cause,
      );
      expect(
          error.toString(), contains('Caused by: Exception: Original error'));
    });
  });

  group('TransportError', () {
    test('includes endpoint information', () {
      final error = TransportError(
        'Connection failed',
        endpoint: 'https://api.example.com/runs',
        statusCode: 500,
      );
      expect(
          error.toString(), contains('endpoint: https://api.example.com/runs'));
      expect(error.toString(), contains('status: 500'));
    });

    test('truncates long response bodies', () {
      final longResponse = 'x' * 300;
      final error = TransportError(
        'Request failed',
        responseBody: longResponse,
      );
      expect(error.toString(), contains('x' * 200));
      expect(error.toString(), contains('...'));
    });

    test('shows full short response bodies', () {
      final error = TransportError(
        'Request failed',
        responseBody: 'Short error message',
      );
      expect(error.toString(), contains('Short error message'));
      expect(error.toString(), isNot(contains('...')));
    });
  });

  group('AGUITimeoutError', () {
    test('includes timeout duration', () {
      final error = AGUITimeoutError(
        'Operation timed out',
        timeout: Duration(seconds: 30),
        operation: 'POST /runs',
      );
      expect(error.toString(), contains('timeout: 30s'));
      expect(error.toString(), contains('operation: POST /runs'));
    });

    test('deprecated TimeoutError typedef resolves to AGUITimeoutError', () {
      // Backward-compat: pre-rename callers using the bare name still work.
      // ignore: deprecated_member_use_from_same_package
      final TimeoutError error = AGUITimeoutError(
        'Legacy alias',
        timeout: Duration(seconds: 5),
      );
      expect(error, isA<AGUITimeoutError>());
    });
  });

  group('CancellationError', () {
    test('includes cancellation reason', () {
      final error = CancellationError(
        'Operation cancelled',
        reason: 'User requested cancellation',
      );
      expect(error.toString(), contains('reason: User requested cancellation'));
    });
  });

  group('DecodingError', () {
    test('includes field and type information', () {
      final error = DecodingError(
        'Invalid JSON',
        field: 'message.content',
        expectedType: 'String',
        actualValue: 123,
      );
      expect(error.toString(), contains('field: message.content'));
      expect(error.toString(), contains('expected: String'));
      expect(error.toString(), contains('actual: int'));
    });

    test('handles null actual value', () {
      final error = DecodingError(
        'Missing field',
        field: 'required_field',
        expectedType: 'String',
        actualValue: null,
      );
      expect(error.toString(), contains('field: required_field'));
      expect(error.toString(), contains('expected: String'));
    });
  });

  group('ValidationError', () {
    test('includes field and constraint information', () {
      final error = ValidationError(
        'Invalid value',
        field: 'agentId',
        constraint: 'alphanumeric',
        value: 'invalid-@-id',
      );
      expect(error.toString(), contains('field: agentId'));
      expect(error.toString(), contains('constraint: alphanumeric'));
      expect(error.toString(), contains('value: invalid-@-id'));
    });

    test('truncates long values', () {
      final longValue = 'x' * 150;
      final error = ValidationError(
        'Value too long',
        field: 'content',
        constraint: 'max-length',
        value: longValue,
      );
      expect(error.toString(), contains('x' * 100));
      expect(error.toString(), contains('...'));
    });
  });

  group('ProtocolViolationError', () {
    test('includes protocol details', () {
      final error = ProtocolViolationError(
        'Invalid event sequence',
        rule: 'run-lifecycle',
        state: 'idle',
        expected: 'RUN_STARTED before other events',
      );
      expect(error.toString(), contains('rule: run-lifecycle'));
      expect(error.toString(), contains('state: idle'));
      expect(error.toString(),
          contains('expected: RUN_STARTED before other events'));
    });
  });

  group('ServerError', () {
    test('includes server error details', () {
      final error = ServerError(
        'Internal server error',
        errorCode: 'INTERNAL_ERROR',
        errorType: 'DatabaseError',
        stackTrace: 'at function xyz...',
      );
      expect(error.toString(), contains('code: INTERNAL_ERROR'));
      expect(error.toString(), contains('type: DatabaseError'));
      expect(error.toString(), contains('Stack trace: at function xyz...'));
    });
  });

  group('Deprecated aliases', () {
    test('AgUiHttpException maps to TransportError', () {
      // ignore: deprecated_member_use_from_same_package
      expect(AgUiHttpException, equals(TransportError));
    });

    test('AgUiConnectionException maps to TransportError', () {
      // ignore: deprecated_member_use_from_same_package
      expect(AgUiConnectionException, equals(TransportError));
    });

    test('AgUiTimeoutException maps to TimeoutError', () {
      // ignore: deprecated_member_use_from_same_package
      expect(AgUiTimeoutException, equals(TimeoutError));
    });

    test('AgUiValidationException maps to ValidationError', () {
      // ignore: deprecated_member_use_from_same_package
      expect(AgUiValidationException, equals(ValidationError));
    });

    test('AgUiClientException maps to AgUiError', () {
      // ignore: deprecated_member_use_from_same_package
      expect(AgUiClientException, equals(AgUiError));
    });
  });
}

// Test implementation of AgUiError for testing
class TestError extends AgUiError {
  TestError(super.message, {super.details, super.cause});
}
