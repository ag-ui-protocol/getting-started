import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('Tool Types', () {
    test('FunctionCall serialization', () {
      final functionCall = FunctionCall(
        name: 'search_web',
        arguments: '{"query": "AG-UI protocol", "limit": 10}',
      );

      final json = functionCall.toJson();
      expect(json['name'], 'search_web');
      expect(json['arguments'], '{"query": "AG-UI protocol", "limit": 10}');

      final decoded = FunctionCall.fromJson(json);
      expect(decoded.name, functionCall.name);
      expect(decoded.arguments, functionCall.arguments);
    });

    test('ToolCall with nested function', () {
      final toolCall = ToolCall(
        id: 'call_abc123',
        type: 'function',
        function: FunctionCall(
          name: 'calculator',
          arguments: '{"operation": "add", "a": 5, "b": 3}',
        ),
      );

      final json = toolCall.toJson();
      expect(json['id'], 'call_abc123');
      expect(json['type'], 'function');
      expect(json['function'], isA<Map<String, dynamic>>());
      expect(json['function']['name'], 'calculator');

      final decoded = ToolCall.fromJson(json);
      expect(decoded.id, toolCall.id);
      expect(decoded.type, toolCall.type);
      expect(decoded.function.name, 'calculator');
    });

    test('Tool with JSON Schema parameters', () {
      final jsonSchema = {
        'type': 'object',
        'properties': {
          'location': {'type': 'string'},
          'unit': {
            'type': 'string',
            'enum': ['celsius', 'fahrenheit'],
          },
        },
        'required': ['location'],
      };

      final tool = Tool(
        name: 'get_weather',
        description: 'Get current weather for a location',
        parameters: jsonSchema,
      );

      final json = tool.toJson();
      expect(json['name'], 'get_weather');
      expect(json['description'], 'Get current weather for a location');
      expect(json['parameters'], jsonSchema);

      final decoded = Tool.fromJson(json);
      expect(decoded.name, tool.name);
      expect(decoded.description, tool.description);
      expect(decoded.parameters, jsonSchema);
    });

    test('Tool without parameters', () {
      final tool = Tool(
        name: 'get_time',
        description: 'Get current UTC time',
      );

      final json = tool.toJson();
      expect(json.containsKey('parameters'), false);

      final decoded = Tool.fromJson(json);
      expect(decoded.parameters, isNull);
    });

    test('ToolResult with error', () {
      final result = ToolResult(
        toolCallId: 'call_001',
        content: 'Failed to connect to API',
        error: 'ConnectionError: Timeout after 30s',
      );

      final json = result.toJson();
      expect(json['toolCallId'], 'call_001');
      expect(json['content'], 'Failed to connect to API');
      expect(json['error'], 'ConnectionError: Timeout after 30s');

      final decoded = ToolResult.fromJson(json);
      expect(decoded.toolCallId, result.toolCallId);
      expect(decoded.content, result.content);
      expect(decoded.error, result.error);
    });

    test('ToolResult handles snake_case tool_call_id', () {
      final json = {
        'tool_call_id': 'call_002',
        'content': 'Success',
      };

      final result = ToolResult.fromJson(json);
      expect(result.toolCallId, 'call_002');
    });

    group('ToolCall encryptedValue', () {
      test('round-trips encryptedValue', () {
        final call = ToolCall(
          id: 'call_enc',
          function: FunctionCall(name: 'fn', arguments: '{}'),
          encryptedValue: 'ENC==',
        );
        final json = call.toJson();
        expect(json['encryptedValue'], 'ENC==');

        final decoded = ToolCall.fromJson(json);
        expect(decoded.encryptedValue, 'ENC==');
      });

      test('reads snake_case encrypted_value', () {
        final call = ToolCall.fromJson({
          'id': 'call_snake',
          'type': 'function',
          'function': {'name': 'fn', 'arguments': '{}'},
          'encrypted_value': 'SNAKE_ENC',
        });
        expect(call.encryptedValue, 'SNAKE_ENC');
      });

      test('omits encryptedValue from toJson when null', () {
        final call = ToolCall(
          id: 'call_no_enc',
          function: FunctionCall(name: 'fn', arguments: '{}'),
        );
        expect(call.toJson().containsKey('encryptedValue'), false);
      });

      test('copyWith threads encryptedValue', () {
        final original = ToolCall(
          id: 'call_1',
          function: FunctionCall(name: 'fn', arguments: '{}'),
          encryptedValue: 'ENC',
        );
        final copy = original.copyWith(id: 'call_2');
        expect(copy.encryptedValue, 'ENC');

        final updated = original.copyWith(encryptedValue: 'NEW_ENC');
        expect(updated.encryptedValue, 'NEW_ENC');
      });
    });
  });

  group('Context Types', () {
    test('Context serialization', () {
      final context = Context(
        description: 'User preferences',
        value: 'theme=dark,language=en',
      );

      final json = context.toJson();
      expect(json['description'], 'User preferences');
      expect(json['value'], 'theme=dark,language=en');

      final decoded = Context.fromJson(json);
      expect(decoded.description, context.description);
      expect(decoded.value, context.value);
    });

    test('Context with JSON string value', () {
      final jsonValue = '{"settings": {"notifications": true, "sound": false}}';
      final context = Context(
        description: 'Application settings',
        value: jsonValue,
      );

      final json = context.toJson();
      expect(json['value'], jsonValue);

      final decoded = Context.fromJson(json);
      expect(decoded.value, jsonValue);
    });
  });

  group('RunAgentInput', () {
    test('Complete RunAgentInput serialization', () {
      final input = RunAgentInput(
        threadId: 'thread_001',
        runId: 'run_001',
        state: {'counter': 0, 'history': []},
        messages: [
          UserMessage(id: 'msg_001', content: 'Hello'),
          AssistantMessage(id: 'msg_002', content: 'Hi there'),
        ],
        tools: [
          Tool(
            name: 'search',
            description: 'Search the web',
            parameters: {'type': 'object'},
          ),
        ],
        context: [
          Context(
            description: 'session',
            value: 'session_123',
          ),
        ],
        forwardedProps: {'custom': 'data'},
      );

      final json = input.toJson();
      expect(json['threadId'], 'thread_001');
      expect(json['runId'], 'run_001');
      expect(json['state'], {'counter': 0, 'history': []});
      expect(json['messages'].length, 2);
      expect(json['tools'].length, 1);
      expect(json['context'].length, 1);
      expect(json['forwardedProps'], {'custom': 'data'});

      final decoded = RunAgentInput.fromJson(json);
      expect(decoded.threadId, input.threadId);
      expect(decoded.runId, input.runId);
      expect(decoded.state, input.state);
      expect(decoded.messages.length, 2);
      expect(decoded.tools.length, 1);
      expect(decoded.context.length, 1);
      expect(decoded.forwardedProps, input.forwardedProps);
    });

    test('RunAgentInput handles snake_case fields', () {
      final json = {
        'thread_id': 'thread_002',
        'run_id': 'run_002',
        'messages': [],
        'tools': [],
        'context': [],
        'forwarded_props': {'snake': 'case'},
      };

      final input = RunAgentInput.fromJson(json);
      expect(input.threadId, 'thread_002');
      expect(input.runId, 'run_002');
      expect(input.forwardedProps, {'snake': 'case'});
    });

    test('RunAgentInput with minimal required fields', () {
      final json = {
        'threadId': 'thread_003',
        'runId': 'run_003',
        'messages': [],
        'tools': [],
        'context': [],
      };

      final input = RunAgentInput.fromJson(json);
      expect(input.threadId, 'thread_003');
      expect(input.runId, 'run_003');
      expect(input.state, isNull);
      expect(input.forwardedProps, isNull);
    });
  });

  group('Run Type', () {
    test('Run with result', () {
      final run = Run(
        threadId: 'thread_001',
        runId: 'run_001',
        result: {'status': 'completed', 'output': 'Success'},
      );

      final json = run.toJson();
      expect(json['threadId'], 'thread_001');
      expect(json['runId'], 'run_001');
      expect(json['result'], {'status': 'completed', 'output': 'Success'});

      final decoded = Run.fromJson(json);
      expect(decoded.threadId, run.threadId);
      expect(decoded.runId, run.runId);
      expect(decoded.result, run.result);
    });

    test('Run handles snake_case fields', () {
      final json = {
        'thread_id': 'thread_002',
        'run_id': 'run_002',
      };

      final run = Run.fromJson(json);
      expect(run.threadId, 'thread_002');
      expect(run.runId, 'run_002');
    });
  });

  group('copyWith methods', () {
    test('Tool copyWith', () {
      final original = Tool(
        name: 'original',
        description: 'Original description',
        parameters: {'original': true},
      );

      final modified = original.copyWith(
        name: 'modified',
      );

      expect(modified.name, 'modified');
      expect(modified.description, 'Original description');
      expect(modified.parameters, {'original': true});
    });

    test('Context copyWith', () {
      final original = Context(
        description: 'original',
        value: 'value1',
      );

      final modified = original.copyWith(
        value: 'value2',
      );

      expect(modified.description, 'original');
      expect(modified.value, 'value2');
    });

    test(
        'RunAgentInput.copyWith — sentinel-clear semantics for state and '
        'forwardedProps (regression for #1018 review)', () {
      // Before the sentinel sweep these fields used `?? this.field`, so a
      // caller could not clear them explicitly via `copyWith(state: null)`.
      // Now the sentinel allows omitted-vs-explicit-null to be distinguished.
      final original = RunAgentInput(
        threadId: 'thread_001',
        runId: 'run_001',
        state: const {'k': 'v'},
        messages: const [],
        tools: const [],
        context: const [],
        forwardedProps: const {'fp': 1},
      );

      // Omitted argument preserves the existing value.
      final keep = original.copyWith();
      expect(keep.state, equals(const {'k': 'v'}));
      expect(keep.forwardedProps, equals(const {'fp': 1}));

      // Explicit null clears each field independently.
      final clearedState = original.copyWith(state: null);
      expect(clearedState.state, isNull);
      expect(clearedState.forwardedProps, equals(const {'fp': 1}));

      final clearedFP = original.copyWith(forwardedProps: null);
      expect(clearedFP.forwardedProps, isNull);
      expect(clearedFP.state, equals(const {'k': 'v'}));
    });

    test(
        'Run.copyWith(result: null) clears result; omitted preserves it '
        '(regression for #1018 review)', () {
      final original = Run(
        threadId: 't',
        runId: 'r',
        result: const {'ok': true},
      );

      final keep = original.copyWith();
      expect(keep.result, equals(const {'ok': true}));

      final cleared = original.copyWith(result: null);
      expect(cleared.result, isNull);
    });
  });
}
