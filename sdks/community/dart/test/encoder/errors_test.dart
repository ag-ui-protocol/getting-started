import 'package:ag_ui/src/encoder/errors.dart';
import 'package:test/test.dart';

void main() {
  group('EncoderError', () {
    test('creates with message only', () {
      final error = EncoderError(message: 'Test error');

      expect(error.message, equals('Test error'));
      expect(error.source, isNull);
      expect(error.cause, isNull);
    });

    test('creates with all parameters', () {
      final sourceData = {'key': 'value'};
      final cause = Exception('Underlying error');
      final error = EncoderError(
        message: 'Test error',
        source: sourceData,
        cause: cause,
      );

      expect(error.message, equals('Test error'));
      expect(error.source, equals(sourceData));
      expect(error.cause, equals(cause));
    });

    test('toString formats correctly with message only', () {
      final error = EncoderError(message: 'Simple error');

      expect(error.toString(), equals('EncoderError: Simple error'));
    });

    test('toString includes source when present', () {
      final error = EncoderError(
        message: 'Error with source',
        source: 'test source',
      );

      final str = error.toString();
      expect(str, contains('EncoderError: Error with source'));
      expect(str, contains('Source: test source'));
    });

    test('toString includes cause when present', () {
      final cause = Exception('Root cause');
      final error = EncoderError(
        message: 'Error with cause',
        cause: cause,
      );

      final str = error.toString();
      expect(str, contains('EncoderError: Error with cause'));
      expect(str, contains('Cause: Exception: Root cause'));
    });

    test('toString includes all fields when present', () {
      final error = EncoderError(
        message: 'Complex error',
        source: {'data': 'test'},
        cause: Exception('Root'),
      );

      final str = error.toString();
      expect(str, contains('EncoderError: Complex error'));
      expect(str, contains('Source: {data: test}'));
      expect(str, contains('Cause: Exception: Root'));
    });
  });

  group('DecodeError', () {
    test('creates with message only', () {
      final error = DecodeError(message: 'Decode failed');

      expect(error.message, equals('Decode failed'));
      expect(error.source, isNull);
      expect(error.cause, isNull);
    });

    test('creates with all parameters', () {
      final sourceData = '{"invalid": json}';
      final cause = FormatException('Invalid JSON');
      final error = DecodeError(
        message: 'JSON decode failed',
        source: sourceData,
        cause: cause,
      );

      expect(error.message, equals('JSON decode failed'));
      expect(error.source, equals(sourceData));
      expect(error.cause, equals(cause));
    });

    test('toString formats correctly', () {
      final error = DecodeError(message: 'Decode error');

      expect(error.toString(), equals('DecodeError: Decode error'));
    });

    test('toString truncates long source', () {
      final longSource = 'x' * 250; // Create a 250 character string
      final error = DecodeError(
        message: 'Error with long source',
        source: longSource,
      );

      final str = error.toString();
      expect(str, contains('DecodeError: Error with long source'));
      expect(str, contains('Source (truncated):'));
      expect(str, contains('x' * 200));
      expect(str, contains('...'));
      expect(str.contains('x' * 250),
          isFalse); // Full string should not be present
    });

    test('toString handles short source without truncation', () {
      final shortSource = 'Short data';
      final error = DecodeError(
        message: 'Error with short source',
        source: shortSource,
      );

      final str = error.toString();
      expect(str, contains('Source: Short data'));
      expect(str.contains('(truncated)'), isFalse);
      expect(str.contains('...'), isFalse);
    });

    test('toString includes cause when present', () {
      final error = DecodeError(
        message: 'Decode with cause',
        cause: Exception('Parse error'),
      );

      final str = error.toString();
      expect(str, contains('DecodeError: Decode with cause'));
      expect(str, contains('Cause: Exception: Parse error'));
    });

    test('inherits from EncoderError', () {
      final error = DecodeError(message: 'Test');
      expect(error, isA<EncoderError>());
    });
  });

  group('EncodeError', () {
    test('creates with message only', () {
      final error = EncodeError(message: 'Encode failed');

      expect(error.message, equals('Encode failed'));
      expect(error.source, isNull);
      expect(error.cause, isNull);
    });

    test('creates with all parameters', () {
      final sourceObject = DateTime.now();
      final cause = Exception('Serialization failed');
      final error = EncodeError(
        message: 'Cannot encode DateTime',
        source: sourceObject,
        cause: cause,
      );

      expect(error.message, equals('Cannot encode DateTime'));
      expect(error.source, equals(sourceObject));
      expect(error.cause, equals(cause));
    });

    test('toString formats correctly', () {
      final error = EncodeError(message: 'Encode error');

      expect(error.toString(), equals('EncodeError: Encode error'));
    });

    test('toString shows source type instead of value', () {
      final complexObject = {
        'nested': {
          'data': [1, 2, 3]
        }
      };
      final error = EncodeError(
        message: 'Complex object error',
        source: complexObject,
      );

      final str = error.toString();
      expect(str, contains('EncodeError: Complex object error'));
      expect(str, contains('Source: _Map<String, Map<String, List<int>>>'));
    });

    test('toString includes cause when present', () {
      final error = EncodeError(
        message: 'Encode with cause',
        cause: ArgumentError('Invalid argument'),
      );

      final str = error.toString();
      expect(str, contains('EncodeError: Encode with cause'));
      expect(str, contains('Cause: Invalid argument'));
    });

    test('inherits from EncoderError', () {
      final error = EncodeError(message: 'Test');
      expect(error, isA<EncoderError>());
    });
  });

  group('ValidationError', () {
    test('creates with message only', () {
      final error = ValidationError(message: 'Validation failed');

      expect(error.message, equals('Validation failed'));
      expect(error.field, isNull);
      expect(error.value, isNull);
      expect(error.source, isNull);
    });

    test('creates with all parameters', () {
      final sourceData = {'email': 'invalid'};
      final error = ValidationError(
        message: 'Invalid email format',
        field: 'email',
        value: 'invalid',
        source: sourceData,
      );

      expect(error.message, equals('Invalid email format'));
      expect(error.field, equals('email'));
      expect(error.value, equals('invalid'));
      expect(error.source, equals(sourceData));
    });

    test('toString formats correctly with message only', () {
      final error = ValidationError(message: 'Validation error');

      expect(error.toString(), equals('ValidationError: Validation error'));
    });

    test('toString includes field when present', () {
      final error = ValidationError(
        message: 'Field error',
        field: 'username',
      );

      final str = error.toString();
      expect(str, contains('ValidationError: Field error'));
      expect(str, contains('Field: username'));
    });

    test('toString includes value when present', () {
      final error = ValidationError(
        message: 'Value error',
        value: 'invalid-value',
      );

      final str = error.toString();
      expect(str, contains('ValidationError: Value error'));
      expect(str, contains('Value: invalid-value'));
    });

    test('toString includes source when present', () {
      final error = ValidationError(
        message: 'Source error',
        source: {'data': 'test'},
      );

      final str = error.toString();
      expect(str, contains('ValidationError: Source error'));
      expect(str, contains('Source: {data: test}'));
    });

    test('toString includes all fields when present', () {
      final error = ValidationError(
        message: 'Complex validation error',
        field: 'age',
        value: -5,
        source: {'age': -5, 'name': 'John'},
      );

      final str = error.toString();
      expect(str, contains('ValidationError: Complex validation error'));
      expect(str, contains('Field: age'));
      expect(str, contains('Value: -5'));
      expect(str, contains('Source: {age: -5, name: John}'));
    });

    test('inherits from EncoderError', () {
      final error = ValidationError(message: 'Test');
      expect(error, isA<EncoderError>());
    });

    test('handles null value correctly', () {
      final error = ValidationError(
        message: 'Null value error',
        field: 'optional_field',
        value: null,
      );

      final str = error.toString();
      expect(str, contains('ValidationError: Null value error'));
      expect(str, contains('Field: optional_field'));
      expect(str.contains('Value:'),
          isFalse); // Should not include value line when null
    });

    test('handles complex value types', () {
      final complexValue = {
        'nested': {
          'array': [1, 2, 3]
        },
        'boolean': true,
      };
      final error = ValidationError(
        message: 'Complex value validation',
        value: complexValue,
      );

      final str = error.toString();
      expect(
          str, contains('Value: {nested: {array: [1, 2, 3]}, boolean: true}'));
    });
  });

  group('Error inheritance', () {
    test('all errors inherit from AGUIError indirectly', () {
      final encoder = EncoderError(message: 'test');
      final decode = DecodeError(message: 'test');
      final encode = EncodeError(message: 'test');
      final validation = ValidationError(message: 'test');

      // All inherit from EncoderError
      expect(encoder, isA<EncoderError>());
      expect(decode, isA<EncoderError>());
      expect(encode, isA<EncoderError>());
      expect(validation, isA<EncoderError>());
    });

    test('error messages are accessible through base class', () {
      EncoderError error;

      error = DecodeError(message: 'decode msg');
      expect(error.message, equals('decode msg'));

      error = EncodeError(message: 'encode msg');
      expect(error.message, equals('encode msg'));

      error = ValidationError(message: 'validation msg');
      expect(error.message, equals('validation msg'));
    });
  });
}
