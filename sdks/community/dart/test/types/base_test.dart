import 'dart:convert';

import 'package:ag_ui/src/types/base.dart';
import 'package:test/test.dart';

// Test implementation of AGUIModel
class TestModel extends AGUIModel {
  final String name;
  final int value;

  const TestModel({required this.name, required this.value});

  @override
  Map<String, dynamic> toJson() => {
        'name': name,
        'value': value,
      };

  @override
  TestModel copyWith({String? name, int? value}) {
    return TestModel(
      name: name ?? this.name,
      value: value ?? this.value,
    );
  }
}

// Test implementation with TypeDiscriminator mixin
class TestTypedModel extends AGUIModel with TypeDiscriminator {
  final String data;

  const TestTypedModel({required this.data});

  @override
  String get type => 'test_type';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'data': data,
      };

  @override
  TestTypedModel copyWith({String? data}) {
    return TestTypedModel(data: data ?? this.data);
  }
}

void main() {
  group('AGUIModel', () {
    test('toJson returns correct map', () {
      final model = TestModel(name: 'test', value: 42);
      final json = model.toJson();

      expect(json['name'], equals('test'));
      expect(json['value'], equals(42));
    });

    test('toJsonString returns valid JSON string', () {
      final model = TestModel(name: 'test', value: 42);
      final jsonString = model.toJsonString();

      expect(jsonString, equals('{"name":"test","value":42}'));

      // Verify it can be decoded
      final decoded = json.decode(jsonString);
      expect(decoded['name'], equals('test'));
      expect(decoded['value'], equals(42));
    });

    test('copyWith creates new instance with updated values', () {
      final original = TestModel(name: 'original', value: 1);
      final copied = original.copyWith(value: 2);

      expect(copied.name, equals('original'));
      expect(copied.value, equals(2));
      expect(identical(original, copied), isFalse);
    });

    test('const constructor works', () {
      const model = TestModel(name: 'const', value: 100);
      expect(model.name, equals('const'));
      expect(model.value, equals(100));
    });
  });

  group('TypeDiscriminator', () {
    test('provides type field', () {
      final model = TestTypedModel(data: 'test data');
      expect(model.type, equals('test_type'));
    });

    test('includes type in JSON output', () {
      final model = TestTypedModel(data: 'test data');
      final json = model.toJson();

      expect(json['type'], equals('test_type'));
      expect(json['data'], equals('test data'));
    });
  });

  group('AGUIValidationError', () {
    test('creates with message only', () {
      final error = AGUIValidationError(message: 'Test error');
      expect(error.message, equals('Test error'));
      expect(error.field, isNull);
      expect(error.value, isNull);
      expect(error.json, isNull);
    });

    test('creates with all fields', () {
      final testJson = {'key': 'value'};
      final error = AGUIValidationError(
        message: 'Test error',
        field: 'testField',
        value: 'testValue',
        json: testJson,
      );

      expect(error.message, equals('Test error'));
      expect(error.field, equals('testField'));
      expect(error.value, equals('testValue'));
      expect(error.json, equals(testJson));
    });

    test('toString includes message', () {
      final error = AGUIValidationError(message: 'Test message');
      expect(error.toString(), contains('AGUIValidationError: Test message'));
    });

    test('toString includes field when present', () {
      final error = AGUIValidationError(
        message: 'Test',
        field: 'myField',
      );
      expect(error.toString(), contains('(field: myField)'));
    });

    test('toString includes value when present', () {
      final error = AGUIValidationError(
        message: 'Test',
        value: 'myValue',
      );
      expect(error.toString(), contains('(value: myValue)'));
    });
  });

  group('AGUIError', () {
    test('creates with message', () {
      final error = AGUIError('Test error message');
      expect(error.message, equals('Test error message'));
    });

    test('toString formats correctly', () {
      final error = AGUIError('Something went wrong');
      expect(error.toString(), equals('AGUIError: Something went wrong'));
    });

    test('const constructor works', () {
      const error = AGUIError('Const error');
      expect(error.message, equals('Const error'));
    });
  });

  group('JsonDecoder', () {
    group('requireField', () {
      test('extracts required field', () {
        final json = {'name': 'John', 'age': 30};
        final name = JsonDecoder.requireField<String>(json, 'name');
        expect(name, equals('John'));
      });

      test('throws when field is missing', () {
        final json = {'age': 30};
        expect(
          () => JsonDecoder.requireField<String>(json, 'name'),
          throwsA(isA<AGUIValidationError>()
              .having((e) => e.message, 'message',
                  contains('Missing required field'))
              .having((e) => e.field, 'field', 'name')),
        );
      });

      test('throws when field is null', () {
        final json = {'name': null};
        expect(
          () => JsonDecoder.requireField<String>(json, 'name'),
          throwsA(isA<AGUIValidationError>().having(
              (e) => e.message, 'message', contains('Required field is null'))),
        );
      });

      test('throws when type is incorrect', () {
        final json = {'age': '30'}; // String instead of int
        expect(
          () => JsonDecoder.requireField<int>(json, 'age'),
          throwsA(isA<AGUIValidationError>()
              .having((e) => e.message, 'message', contains('incorrect type'))),
        );
      });

      test('applies transform function', () {
        final json = {'age': '30'};
        final age = JsonDecoder.requireField<int>(
          json,
          'age',
          transform: (value) => int.parse(value as String),
        );
        expect(age, equals(30));
      });

      test('throws when transform fails', () {
        final json = {'age': 'invalid'};
        expect(
          () => JsonDecoder.requireField<int>(
            json,
            'age',
            transform: (value) => int.parse(value as String),
          ),
          throwsA(isA<AGUIValidationError>().having(
              (e) => e.message, 'message', contains('Failed to transform'))),
        );
      });
    });

    group('optionalField', () {
      test('extracts optional field when present', () {
        final json = {'name': 'John', 'nickname': 'Johnny'};
        final nickname = JsonDecoder.optionalField<String>(json, 'nickname');
        expect(nickname, equals('Johnny'));
      });

      test('returns null when field is missing', () {
        final json = {'name': 'John'};
        final nickname = JsonDecoder.optionalField<String>(json, 'nickname');
        expect(nickname, isNull);
      });

      test('returns null when field is null', () {
        final json = {'nickname': null};
        final nickname = JsonDecoder.optionalField<String>(json, 'nickname');
        expect(nickname, isNull);
      });

      test('throws when type is incorrect', () {
        final json = {'age': '30'}; // String instead of int
        expect(
          () => JsonDecoder.optionalField<int>(json, 'age'),
          throwsA(isA<AGUIValidationError>()
              .having((e) => e.message, 'message', contains('incorrect type'))),
        );
      });

      test('applies transform function', () {
        final json = {'age': '25'};
        final age = JsonDecoder.optionalField<int>(
          json,
          'age',
          transform: (value) => int.parse(value as String),
        );
        expect(age, equals(25));
      });
    });

    group('requireListField', () {
      test('extracts required list field', () {
        final json = {
          'items': ['a', 'b', 'c']
        };
        final items = JsonDecoder.requireListField<String>(json, 'items');
        expect(items, equals(['a', 'b', 'c']));
      });

      test('throws when list field is missing', () {
        final json = {'other': 'value'};
        expect(
          () => JsonDecoder.requireListField<String>(json, 'items'),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('applies item transform', () {
        final json = {
          'numbers': ['1', '2', '3']
        };
        final numbers = JsonDecoder.requireListField<int>(
          json,
          'numbers',
          itemTransform: (value) => int.parse(value as String),
        );
        expect(numbers, equals([1, 2, 3]));
      });

      test('throws when item transform fails', () {
        final json = {
          'numbers': ['1', 'invalid', '3']
        };
        expect(
          () => JsonDecoder.requireListField<int>(
            json,
            'numbers',
            itemTransform: (value) => int.parse(value as String),
          ),
          throwsA(isA<AGUIValidationError>().having((e) => e.message, 'message',
              contains('Failed to transform list item'))),
        );
      });

      test('item transform error reports index in field name', () {
        // Regression for I3: itemTransform errors must name the bad index
        // (`numbers[1]`) rather than the bare field name (`numbers`), matching
        // the _eagerCast no-transform path's `field: '$field[$i]'` contract.
        final json = {
          'numbers': ['1', 'bad', '3']
        };
        AGUIValidationError? caught;
        try {
          JsonDecoder.requireListField<int>(
            json,
            'numbers',
            itemTransform: (value) => int.parse(value as String),
          );
        } on AGUIValidationError catch (e) {
          caught = e;
        }
        expect(caught, isNotNull);
        expect(caught!.field, equals('numbers[1]'));
      });
    });

    group('optionalListField', () {
      test('extracts optional list field when present', () {
        final json = {
          'items': ['a', 'b']
        };
        final items = JsonDecoder.optionalListField<String>(json, 'items');
        expect(items, equals(['a', 'b']));
      });

      test('returns null when list field is missing', () {
        final json = {'other': 'value'};
        final items = JsonDecoder.optionalListField<String>(json, 'items');
        expect(items, isNull);
      });

      test('returns null when list field is null', () {
        final json = {'items': null};
        final items = JsonDecoder.optionalListField<String>(json, 'items');
        expect(items, isNull);
      });

      test('applies item transform', () {
        final json = {
          'numbers': ['5', '10']
        };
        final numbers = JsonDecoder.optionalListField<int>(
          json,
          'numbers',
          itemTransform: (value) => int.parse(value as String),
        );
        expect(numbers, equals([5, 10]));
      });
    });
  });

  group('Case conversion utilities', () {
    group('snakeToCamel', () {
      test('converts snake_case to camelCase', () {
        expect(snakeToCamel('snake_case'), equals('snakeCase'));
        expect(snakeToCamel('my_long_variable'), equals('myLongVariable'));
        expect(snakeToCamel('a_b_c'), equals('aBC'));
      });

      test('handles single word', () {
        expect(snakeToCamel('word'), equals('word'));
      });

      test('handles empty string', () {
        expect(snakeToCamel(''), equals(''));
      });

      test('handles leading underscore', () {
        expect(snakeToCamel('_private'), equals('Private'));
      });

      test('handles multiple consecutive underscores', () {
        expect(snakeToCamel('double__underscore'), equals('doubleUnderscore'));
      });
    });

    group('camelToSnake', () {
      test('converts camelCase to snake_case', () {
        expect(camelToSnake('camelCase'), equals('camel_case'));
        expect(camelToSnake('myLongVariable'), equals('my_long_variable'));
        expect(camelToSnake('aBC'), equals('a_b_c'));
      });

      test('handles single word', () {
        expect(camelToSnake('word'), equals('word'));
      });

      test('handles empty string', () {
        expect(camelToSnake(''), equals(''));
      });

      test('handles PascalCase', () {
        expect(camelToSnake('PascalCase'), equals('pascal_case'));
      });

      test('handles consecutive capital letters', () {
        expect(camelToSnake('XMLHttpRequest'), equals('x_m_l_http_request'));
      });

      test('handles single letter', () {
        expect(camelToSnake('a'), equals('a'));
        expect(camelToSnake('A'), equals('a'));
      });
    });

    test('round trip conversion', () {
      final original = 'myVariableName';
      final snake = camelToSnake(original);
      final camel = snakeToCamel(snake);
      expect(camel, equals(original));
    });
  });
}
