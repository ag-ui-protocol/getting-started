import 'package:test/test.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/client/validators.dart';
import 'package:ag_ui/src/types/message.dart';

void main() {
  group('Validators.requireNonEmpty', () {
    test('accepts non-empty strings', () {
      expect(
          () => Validators.requireNonEmpty('value', 'field'), returnsNormally);
    });

    test('rejects null strings', () {
      expect(
        () => Validators.requireNonEmpty(null, 'field'),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'field')
            .having((e) => e.constraint, 'constraint', 'non-empty')),
      );
    });

    test('rejects empty strings', () {
      expect(
        () => Validators.requireNonEmpty('', 'field'),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'field')
            .having((e) => e.constraint, 'constraint', 'non-empty')),
      );
    });
  });

  group('Validators.requireNonNull', () {
    test('returns non-null values', () {
      expect(Validators.requireNonNull('value', 'field'), equals('value'));
      expect(Validators.requireNonNull(123, 'field'), equals(123));
    });

    test('throws on null values', () {
      expect(
        () => Validators.requireNonNull(null, 'field'),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'field')
            .having((e) => e.constraint, 'constraint', 'non-null')),
      );
    });
  });

  group('Validators.validateUrl', () {
    test('accepts valid HTTP URLs', () {
      expect(() => Validators.validateUrl('http://example.com', 'url'),
          returnsNormally);
      expect(
          () => Validators.validateUrl('https://api.example.com/path', 'url'),
          returnsNormally);
      expect(() => Validators.validateUrl('https://example.com:8080', 'url'),
          returnsNormally);
    });

    test('rejects invalid URLs', () {
      expect(
        () => Validators.validateUrl('not-a-url', 'url'),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'url')
            .having((e) => e.constraint, 'constraint', 'valid-url')),
      );
    });

    test('rejects non-HTTP schemes', () {
      expect(
        () => Validators.validateUrl('ftp://example.com', 'url'),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'http-or-https')),
      );
    });

    test('rejects empty URLs', () {
      expect(
        () => Validators.validateUrl('', 'url'),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'non-empty')),
      );
    });

    test('rejects credential-bearing URLs (userInfo component)', () {
      expect(
        () => Validators.validateUrl('http://user:pass@example.com', 'url'),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'no-user-credentials')),
      );
      expect(
        () => Validators.validateUrl('https://token@api.example.com', 'url'),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'no-user-credentials')),
      );
    });

    test('rejects bare-scheme URL http://', () {
      // Uri.parse('http://').hasAuthority is true but host is '' — the
      // uri.host.isEmpty check is load-bearing and must be exercised.
      expect(
        () => Validators.validateUrl('http://', 'baseUrl'),
        throwsA(isA<ValidationError>()),
      );
    });
  });

  group('Validators.validateAgentId', () {
    test('accepts valid agent IDs', () {
      expect(() => Validators.validateAgentId('agent1'), returnsNormally);
      expect(() => Validators.validateAgentId('my-agent'), returnsNormally);
      expect(() => Validators.validateAgentId('agent_123'), returnsNormally);
      expect(() => Validators.validateAgentId('MyAgent2'), returnsNormally);
    });

    test('rejects invalid characters', () {
      expect(
        () => Validators.validateAgentId('agent@123'),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'agentId')
            .having((e) => e.constraint, 'constraint',
                'alphanumeric-with-hyphens-underscores')),
      );
    });

    test('rejects IDs starting with special characters', () {
      expect(
        () => Validators.validateAgentId('-agent'),
        throwsA(isA<ValidationError>()),
      );
      expect(
        () => Validators.validateAgentId('_agent'),
        throwsA(isA<ValidationError>()),
      );
    });

    test('rejects too long IDs', () {
      final longId = 'a' * 101;
      expect(
        () => Validators.validateAgentId(longId),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'max-length-100')),
      );
    });

    test('rejects empty IDs', () {
      expect(
        () => Validators.validateAgentId(''),
        throwsA(isA<ValidationError>()),
      );
    });
  });

  group('Validators.validateRunId', () {
    test('accepts valid run IDs', () {
      expect(() => Validators.validateRunId('run-123'), returnsNormally);
      expect(
          () =>
              Validators.validateRunId('550e8400-e29b-41d4-a716-446655440000'),
          returnsNormally);
    });

    test('rejects too long IDs', () {
      final longId = 'x' * 101;
      expect(
        () => Validators.validateRunId(longId),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'max-length-100')),
      );
    });

    test('rejects empty IDs', () {
      expect(
        () => Validators.validateRunId(''),
        throwsA(isA<ValidationError>()),
      );
    });
  });

  group('Validators.validateThreadId', () {
    test('accepts valid thread IDs', () {
      expect(() => Validators.validateThreadId('thread-123'), returnsNormally);
      expect(
          () => Validators.validateThreadId(
              '550e8400-e29b-41d4-a716-446655440000'),
          returnsNormally);
    });

    test('rejects too long IDs', () {
      final longId = 'x' * 101;
      expect(
        () => Validators.validateThreadId(longId),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'max-length-100')),
      );
    });
  });

  group('Validators.validateUserMessageContent', () {
    test('accepts text content', () {
      expect(
        () => Validators.validateUserMessageContent(const TextContent('Hello')),
        returnsNormally,
      );
    });

    test('accepts multimodal content with valid parts', () {
      // Regression: multimodal content must validate, not throw on a null
      // `content` getter as the retired validateMessageContent did.
      final content = MultimodalContent([
        TextInputContent('look'),
        const ImageInputContent(
          source: UrlSource(value: 'https://example.com/i.png'),
        ),
      ]);
      expect(
        () => Validators.validateUserMessageContent(content),
        returnsNormally,
      );
    });

    test('rejects empty parts list', () {
      expect(
        () => Validators.validateUserMessageContent(
          const MultimodalContent([]),
        ),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'content')
            .having((e) => e.constraint, 'constraint', 'non-empty')),
      );
    });
  });

  group('Validators.validateTimeout', () {
    test('accepts valid timeouts', () {
      expect(() => Validators.validateTimeout(null), returnsNormally);
      expect(() => Validators.validateTimeout(Duration(seconds: 30)),
          returnsNormally);
      expect(() => Validators.validateTimeout(Duration(minutes: 5)),
          returnsNormally);
    });

    test('rejects negative timeouts', () {
      expect(
        () => Validators.validateTimeout(Duration(seconds: -1)),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'non-negative')),
      );
    });

    test('rejects too long timeouts', () {
      expect(
        () => Validators.validateTimeout(Duration(minutes: 11)),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'max-10-minutes')),
      );
    });
  });

  group('Validators.requireFields', () {
    test('accepts maps with all required fields', () {
      final map = {'field1': 'value1', 'field2': 'value2'};
      expect(
        () => Validators.requireFields(map, ['field1', 'field2']),
        returnsNormally,
      );
    });

    test('rejects maps missing required fields', () {
      final map = {'field1': 'value1'};
      expect(
        () => Validators.requireFields(map, ['field1', 'field2']),
        throwsA(isA<ValidationError>()
            .having((e) => e.field, 'field', 'field2')
            .having((e) => e.constraint, 'constraint', 'required')),
      );
    });
  });

  group('Validators.validateJson', () {
    test('accepts valid JSON objects', () {
      final json = {'key': 'value'};
      expect(Validators.validateJson(json, 'test'), equals(json));
    });

    test('rejects null', () {
      expect(
        () => Validators.validateJson(null, 'test'),
        throwsA(isA<DecodingError>()
            .having((e) => e.field, 'field', 'test')
            .having(
                (e) => e.expectedType, 'expectedType', 'Map<String, dynamic>')),
      );
    });

    test('rejects non-map types', () {
      expect(
        () => Validators.validateJson('string', 'test'),
        throwsA(isA<DecodingError>()
            .having((e) => e.field, 'field', 'test')
            .having(
                (e) => e.expectedType, 'expectedType', 'Map<String, dynamic>')),
      );
    });
  });

  group('Validators.validateEventType', () {
    test('accepts valid event types', () {
      expect(
          () => Validators.validateEventType('RUN_STARTED'), returnsNormally);
      expect(() => Validators.validateEventType('TEXT_MESSAGE_START'),
          returnsNormally);
      expect(
          () => Validators.validateEventType('TOOL_CALL_END'), returnsNormally);
    });

    test('rejects invalid formats', () {
      expect(
        () => Validators.validateEventType('runStarted'),
        throwsA(isA<ValidationError>()
            .having((e) => e.constraint, 'constraint', 'upper-snake-case')),
      );
      expect(
        () => Validators.validateEventType('run-started'),
        throwsA(isA<ValidationError>()),
      );
    });

    test('rejects empty event types', () {
      expect(
        () => Validators.validateEventType(''),
        throwsA(isA<ValidationError>()),
      );
    });
  });

  group('Validators.validateStatusCode', () {
    test('accepts success status codes', () {
      expect(() => Validators.validateStatusCode(200, '/api/test'),
          returnsNormally);
      expect(() => Validators.validateStatusCode(201, '/api/test'),
          returnsNormally);
      expect(() => Validators.validateStatusCode(204, '/api/test'),
          returnsNormally);
    });

    test('throws on client errors', () {
      expect(
        () => Validators.validateStatusCode(400, '/api/test', 'Error response'),
        throwsA(isA<TransportError>()
            .having((e) => e.statusCode, 'statusCode', 400)
            .having((e) => e.endpoint, 'endpoint', '/api/test')
            .having((e) => e.responseBody, 'responseBody', 'Error response')
            .having((e) => e.message, 'message', contains('Client error'))),
      );
    });

    test('throws on server errors', () {
      expect(
        () => Validators.validateStatusCode(500, '/api/test', 'Server error'),
        throwsA(isA<TransportError>()
            .having((e) => e.statusCode, 'statusCode', 500)
            .having((e) => e.responseBody, 'responseBody', 'Server error')
            .having((e) => e.message, 'message', contains('Server error'))),
      );
    });
  });

  group('Validators.validateSseEvent', () {
    test('accepts valid SSE events', () {
      expect(
        () => Validators.validateSseEvent({'data': 'content'}),
        returnsNormally,
      );
    });

    test('rejects empty events', () {
      expect(
        () => Validators.validateSseEvent({}),
        throwsA(isA<DecodingError>()),
      );
    });

    test('rejects events without data field', () {
      expect(
        () => Validators.validateSseEvent({'id': '123'}),
        throwsA(isA<DecodingError>().having((e) => e.field, 'field', 'data')),
      );
    });
  });

  group('Validators.validateEventSequence', () {
    test('accepts valid RUN_STARTED at beginning', () {
      expect(
        () => Validators.validateEventSequence('RUN_STARTED', null, null),
        returnsNormally,
      );
    });

    test('accepts RUN_STARTED after RUN_FINISHED', () {
      expect(
        () => Validators.validateEventSequence(
            'RUN_STARTED', 'RUN_FINISHED', 'finished'),
        returnsNormally,
      );
    });

    test('rejects RUN_STARTED in wrong sequence', () {
      expect(
        () => Validators.validateEventSequence(
            'RUN_STARTED', 'TEXT_MESSAGE_START', 'running'),
        throwsA(isA<ProtocolViolationError>()
            .having((e) => e.rule, 'rule', 'run-lifecycle')),
      );
    });

    test('rejects RUN_FINISHED without RUN_STARTED', () {
      expect(
        () => Validators.validateEventSequence('RUN_FINISHED', null, 'idle'),
        throwsA(isA<ProtocolViolationError>()
            .having((e) => e.rule, 'rule', 'run-lifecycle')),
      );
    });

    test('rejects tool calls outside of run', () {
      expect(
        () => Validators.validateEventSequence(
            'TOOL_CALL_START', 'RUN_FINISHED', 'idle'),
        throwsA(isA<ProtocolViolationError>()
            .having((e) => e.rule, 'rule', 'tool-call-lifecycle')),
      );
    });

    test('accepts tool calls within run', () {
      expect(
        () => Validators.validateEventSequence(
            'TOOL_CALL_START', 'RUN_STARTED', 'running'),
        returnsNormally,
      );
    });
  });

  group('Validators.validateModel', () {
    test('decodes valid model', () {
      final json = {'id': '123', 'name': 'Test'};
      final result = Validators.validateModel(
        json,
        'TestModel',
        (data) => TestModel(data['id'] as String, data['name'] as String),
      );
      expect(result.id, equals('123'));
      expect(result.name, equals('Test'));
    });

    test('throws on invalid JSON', () {
      expect(
        () => Validators.validateModel(
          'not-json',
          'TestModel',
          (data) => TestModel(data['id'] as String, data['name'] as String),
        ),
        throwsA(isA<DecodingError>()),
      );
    });

    test('throws on decoding failure', () {
      final json = {'invalid': 'data'};
      expect(
        () => Validators.validateModel(
          json,
          'TestModel',
          (data) => TestModel(data['id'] as String, data['name'] as String),
        ),
        throwsA(
            isA<DecodingError>().having((e) => e.field, 'field', 'TestModel')),
      );
    });
  });

  group('Validators.validateModelList', () {
    test('decodes valid model list', () {
      final list = [
        {'id': '1', 'name': 'One'},
        {'id': '2', 'name': 'Two'},
      ];
      final result = Validators.validateModelList(
        list,
        'TestModel',
        (data) => TestModel(data['id'] as String, data['name'] as String),
      );
      expect(result.length, equals(2));
      expect(result[0].id, equals('1'));
      expect(result[1].name, equals('Two'));
    });

    test('throws on non-list', () {
      expect(
        () => Validators.validateModelList(
          {'not': 'list'},
          'TestModel',
          (data) => TestModel(data['id'] as String, data['name'] as String),
        ),
        throwsA(isA<DecodingError>()
            .having((e) => e.expectedType, 'expectedType', 'List')),
      );
    });

    test('throws on invalid item in list', () {
      final list = [
        {'id': '1', 'name': 'One'},
        {'invalid': 'data'},
      ];
      expect(
        () => Validators.validateModelList(
          list,
          'TestModel',
          (data) => TestModel(data['id'] as String, data['name'] as String),
        ),
        throwsA(isA<DecodingError>()
            .having((e) => e.field, 'field', 'TestModel[1]')),
      );
    });
  });
}

class TestModel {
  final String id;
  final String name;
  TestModel(this.id, this.name);
}
