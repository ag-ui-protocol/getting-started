import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('Message Types', () {
    group('DeveloperMessage', () {
      test('should serialize and deserialize correctly', () {
        final message = DeveloperMessage(
          id: 'msg_001',
          content: 'This is a developer message',
          name: 'dev_system',
        );

        final json = message.toJson();
        expect(json['id'], 'msg_001');
        expect(json['role'], 'developer');
        expect(json['content'], 'This is a developer message');
        expect(json['name'], 'dev_system');

        final decoded = DeveloperMessage.fromJson(json);
        expect(decoded.id, message.id);
        expect(decoded.content, message.content);
        expect(decoded.name, message.name);
        expect(decoded.role, MessageRole.developer);
      });

      test('should handle missing optional fields', () {
        final json = {
          'id': 'msg_002',
          'role': 'developer',
          'content': 'Minimal developer message',
        };

        final message = DeveloperMessage.fromJson(json);
        expect(message.id, 'msg_002');
        expect(message.content, 'Minimal developer message');
        expect(message.name, isNull);
      });

      test('should throw on missing required fields', () {
        final json = {
          'id': 'msg_003',
          'role': 'developer',
        };

        expect(
          () => DeveloperMessage.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });
    });

    group('AssistantMessage', () {
      test('should handle tool calls', () {
        final message = AssistantMessage(
          id: 'asst_001',
          content: 'I will help you with that',
          toolCalls: [
            ToolCall(
              id: 'call_001',
              function: FunctionCall(
                name: 'get_weather',
                arguments: '{"location": "New York"}',
              ),
            ),
          ],
        );

        final json = message.toJson();
        expect(json['id'], 'asst_001');
        expect(json['role'], 'assistant');
        expect(json['content'], 'I will help you with that');
        expect(json['toolCalls'], isA<List>());
        expect(json['toolCalls']!.length, 1);

        final decoded = AssistantMessage.fromJson(json);
        expect(decoded.id, message.id);
        expect(decoded.content, message.content);
        expect(decoded.toolCalls?.length, 1);
        expect(decoded.toolCalls![0].id, 'call_001');
        expect(decoded.toolCalls![0].function.name, 'get_weather');
      });

      test('should handle both camelCase and snake_case tool calls', () {
        final snakeCaseJson = {
          'id': 'asst_002',
          'role': 'assistant',
          'tool_calls': [
            {
              'id': 'call_002',
              'type': 'function',
              'function': {
                'name': 'search',
                'arguments': '{"query": "AG-UI"}',
              },
            },
          ],
        };

        final message = AssistantMessage.fromJson(snakeCaseJson);
        expect(message.toolCalls?.length, 1);
        expect(message.toolCalls![0].id, 'call_002');
      });
    });

    group('ToolMessage', () {
      test('should handle error field', () {
        final message = ToolMessage(
          id: 'tool_001',
          content: 'Tool execution failed',
          toolCallId: 'call_001',
          error: 'Connection timeout',
        );

        final json = message.toJson();
        expect(json['error'], 'Connection timeout');

        final decoded = ToolMessage.fromJson(json);
        expect(decoded.error, 'Connection timeout');
      });

      test('should handle both camelCase and snake_case tool_call_id', () {
        final snakeCaseJson = {
          'id': 'tool_002',
          'role': 'tool',
          'content': 'Result',
          'tool_call_id': 'call_002',
        };

        final message = ToolMessage.fromJson(snakeCaseJson);
        expect(message.toolCallId, 'call_002');
      });
    });

    group('ActivityMessage', () {
      test('round-trips canonical wire shape', () {
        final message = ActivityMessage(
          id: 'act_001',
          activityType: 'task.run',
          activityContent: const {'progress': 0.5, 'items': []},
        );

        final json = message.toJson();
        expect(json['id'], 'act_001');
        expect(json['role'], 'activity');
        expect(json['activityType'], 'task.run');
        expect(json['content'], const {'progress': 0.5, 'items': []});

        final decoded = ActivityMessage.fromJson(json);
        expect(decoded.id, 'act_001');
        expect(decoded.activityType, 'task.run');
        expect(decoded.activityContent, equals(message.activityContent));
        expect(decoded.role, MessageRole.activity);
      });

      test('accepts snake_case activity_type (Python server)', () {
        final message = ActivityMessage.fromJson({
          'id': 'act_002',
          'role': 'activity',
          'activity_type': 'task.run',
          'content': {'progress': 0.0},
        });

        expect(message.activityType, 'task.run');
        expect(message.activityContent['progress'], 0.0);
      });

      test('rejects missing required content', () {
        expect(
          () => ActivityMessage.fromJson({
            'id': 'act_003',
            'role': 'activity',
            'activityType': 'task.run',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('copyWith preserves subtype', () {
        final original = ActivityMessage(
          id: 'act_004',
          activityType: 'task.run',
          activityContent: const {'progress': 0.0},
        );

        final updated = original.copyWith(
          activityContent: const {'progress': 1.0},
        );

        expect(updated, isA<ActivityMessage>());
        expect(updated.id, original.id);
        expect(updated.activityType, original.activityType);
        expect(updated.activityContent['progress'], 1.0);
      });

      test(
          'strips camelCase encryptedValue silently (not a BaseMessage extension)',
          () {
        final msg = ActivityMessage.fromJson({
          'id': 'act_005',
          'role': 'activity',
          'activityType': 'task.run',
          'content': {'progress': 0.5},
          'encryptedValue': 'ZW5jcnlwdGVkLXBheWxvYWQ=',
        });
        expect(msg.id, 'act_005');
        expect(msg.activityType, 'task.run');
        // encryptedValue is not exposed on ActivityMessage — stripping is silent.
        expect(msg.toJson().containsKey('encryptedValue'), isFalse);
      });

      test(
          'strips snake_case encrypted_value silently (not a BaseMessage extension)',
          () {
        final msg = ActivityMessage.fromJson({
          'id': 'act_006',
          'role': 'activity',
          'activityType': 'task.run',
          'content': {'progress': 0.5},
          'encrypted_value': 'ZW5jcnlwdGVkLXBheWxvYWQ=',
        });
        expect(msg.id, 'act_006');
        expect(msg.activityType, 'task.run');
        expect(msg.toJson().containsKey('encryptedValue'), isFalse);
      });

      test(
          'LSP: name is always null; encryptedValue returns null on ActivityMessage',
          () {
        // ActivityMessage is NOT a BaseMessage extension — cipher-payload
        // forwarding does not apply. `name` is always null; `encryptedValue`
        // returns null (wire-correct) so polymorphic List<Message> iteration
        // does not crash. toJson never emits either field.
        final direct = ActivityMessage(
          id: 'act_007',
          activityType: 'task.run',
          activityContent: const {'x': 1},
        );
        expect(direct.name, isNull,
            reason: 'name must be null on ActivityMessage');
        // Fix for Opus2 I2: returns null instead of throwing — LSP compliance.
        expect(direct.encryptedValue, isNull,
            reason:
                'encryptedValue must return null on ActivityMessage (not throw)');
        expect(direct.toJson().containsKey('name'), isFalse);
        expect(direct.toJson().containsKey('encryptedValue'), isFalse);

        // Also via fromJson — even if a proxy emits name/encryptedValue.
        final fromJson = ActivityMessage.fromJson({
          'id': 'act_008',
          'role': 'activity',
          'activityType': 'task.run',
          'content': {'x': 1},
          'name': 'should_be_stripped',
          'encryptedValue': 'should_be_stripped',
        });
        expect(fromJson.name, isNull);
        expect(fromJson.encryptedValue, isNull,
            reason:
                'encryptedValue must return null on ActivityMessage (not throw)');
        expect(fromJson.toJson().containsKey('name'), isFalse);
        expect(fromJson.toJson().containsKey('encryptedValue'), isFalse);
      });
    });

    group('ReasoningMessage', () {
      test('round-trips canonical wire shape with encryptedValue', () {
        final message = ReasoningMessage(
          id: 'rsn_001',
          content: 'Analyzing the request...',
          encryptedValue: 'ZW5jcnlwdGVkLXBheWxvYWQ=',
        );

        final json = message.toJson();
        expect(json['id'], 'rsn_001');
        expect(json['role'], 'reasoning');
        expect(json['content'], 'Analyzing the request...');
        expect(json['encryptedValue'], 'ZW5jcnlwdGVkLXBheWxvYWQ=');

        final decoded = ReasoningMessage.fromJson(json);
        expect(decoded.id, 'rsn_001');
        expect(decoded.content, message.content);
        expect(decoded.encryptedValue, message.encryptedValue);
        expect(decoded.role, MessageRole.reasoning);
      });

      test('omits encryptedValue when null', () {
        final message = ReasoningMessage(
          id: 'rsn_002',
          content: 'Plain reasoning text',
        );

        final json = message.toJson();
        expect(json.containsKey('encryptedValue'), isFalse);

        final decoded = ReasoningMessage.fromJson(json);
        expect(decoded.encryptedValue, isNull);
      });

      test('accepts snake_case encrypted_value (Python server)', () {
        final message = ReasoningMessage.fromJson({
          'id': 'rsn_003',
          'role': 'reasoning',
          'content': 'Thinking',
          'encrypted_value': 'cGF5bG9hZA==',
        });

        expect(message.encryptedValue, 'cGF5bG9hZA==');
      });

      test('copyWith preserves subtype', () {
        final original = ReasoningMessage(
          id: 'rsn_005',
          content: 'first',
        );

        final updated = original.copyWith(content: 'second');

        expect(updated, isA<ReasoningMessage>());
        expect(updated.id, original.id);
        expect(updated.content, 'second');
        expect(updated.encryptedValue, isNull);
      });
    });

    group('Message Factory', () {
      test('should create correct message type based on role', () {
        final messages = [
          {'id': '1', 'role': 'developer', 'content': 'Dev msg'},
          {'id': '2', 'role': 'system', 'content': 'System msg'},
          {'id': '3', 'role': 'user', 'content': 'User msg'},
          {'id': '4', 'role': 'assistant', 'content': 'Assistant msg'},
          {
            'id': '5',
            'role': 'tool',
            'content': 'Tool result',
            'toolCallId': 'call_001'
          },
          {
            'id': '6',
            'role': 'activity',
            'activityType': 'task.run',
            'content': {'progress': 0.0},
          },
          {
            'id': '7',
            'role': 'reasoning',
            'content': 'Thinking out loud',
          },
        ];

        final decoded = messages.map((json) => Message.fromJson(json)).toList();

        expect(decoded[0], isA<DeveloperMessage>());
        expect(decoded[1], isA<SystemMessage>());
        expect(decoded[2], isA<UserMessage>());
        expect(decoded[3], isA<AssistantMessage>());
        expect(decoded[4], isA<ToolMessage>());
        expect(decoded[5], isA<ActivityMessage>());
        expect(decoded[6], isA<ReasoningMessage>());
      });

      test('should throw on invalid role', () {
        final json = {
          'id': 'invalid_001',
          'role': 'invalid_role',
          'content': 'Some content',
        };

        expect(
          () => Message.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });
    });

    group('copyWith null-clearing parity (sentinel pattern)', () {
      test('DeveloperMessage.copyWith(name: null) clears name', () {
        // Sentinel pattern parity with the event layer: a nullable field
        // must be clearable via `copyWith(field: null)`. The default
        // `?? this.field` pattern (events.dart calls this out via
        // `_unsetCopyWith`) cannot distinguish "omitted" from
        // "explicitly null" — sentinel resolves it.
        final msg = DeveloperMessage(
          id: 'd1',
          content: 'x',
          name: 'devbot',
        );
        expect(msg.copyWith(name: null).name, isNull);
        expect(msg.copyWith().name, equals('devbot'));
      });

      test('SystemMessage.copyWith(name: null) clears name', () {
        final msg = SystemMessage(id: 's1', content: 'x', name: 'sys');
        expect(msg.copyWith(name: null).name, isNull);
        expect(msg.copyWith().name, equals('sys'));
      });

      test('UserMessage.copyWith(name: null) clears name', () {
        final msg = UserMessage(id: 'u1', content: 'x', name: 'alice');
        expect(msg.copyWith(name: null).name, isNull);
        expect(msg.copyWith().name, equals('alice'));
      });

      test(
          'AssistantMessage.copyWith with explicit null clears '
          'content/name/toolCalls', () {
        // All three nullable fields use the sentinel — verify each one
        // independently.
        final msg = AssistantMessage(
          id: 'a1',
          content: 'hi',
          name: 'asst',
          toolCalls: [
            ToolCall(
              id: 'c1',
              function: FunctionCall(name: 'fn', arguments: '{}'),
            ),
          ],
        );
        expect(msg.copyWith(content: null).content, isNull);
        expect(msg.copyWith(name: null).name, isNull);
        expect(msg.copyWith(toolCalls: null).toolCalls, isNull);

        // Argument omitted preserves all three fields.
        final cloned = msg.copyWith();
        expect(cloned.content, equals('hi'));
        expect(cloned.name, equals('asst'));
        expect(cloned.toolCalls, isNotNull);
      });

      test(
          'ToolMessage.copyWith with explicit null clears error and '
          'encryptedValue', () {
        final msg = ToolMessage(
          id: 't1',
          content: 'result',
          toolCallId: 'c1',
          error: 'oops',
          encryptedValue: 'cipher',
        );
        expect(msg.copyWith(error: null).error, isNull);
        expect(msg.copyWith(encryptedValue: null).encryptedValue, isNull);

        final cloned = msg.copyWith();
        expect(cloned.error, equals('oops'));
        expect(cloned.encryptedValue, equals('cipher'));
      });

      test('ReasoningMessage.copyWith(encryptedValue: null) clears it', () {
        final msg = ReasoningMessage(
          id: 'r1',
          content: 'thinking',
          encryptedValue: 'cipher',
        );
        expect(msg.copyWith(encryptedValue: null).encryptedValue, isNull);
        expect(msg.copyWith().encryptedValue, equals('cipher'));
      });

      test('ActivityMessage.copyWith(id: null) clears id', () {
        final msg = ActivityMessage(
          id: 'act_1',
          activityType: 'task.run',
          activityContent: const {'progress': 0.0},
        );
        expect(msg.copyWith(id: null).id, isNull);
        expect(msg.copyWith().id, equals('act_1'));
      });
    });

    group('AssistantMessage.fromJson dual-key precedence', () {
      test(
          'empty toolCalls does not silently win over snake_case '
          'tool_calls (regression for #1018 review)', () {
        // Before the fix, the `??`-on-value chain only fired on null;
        // an empty `toolCalls: []` short-circuited and silently
        // dropped the populated `tool_calls` snake_case alias.
        // `optionalEitherField` resolves on the KEY itself: camelCase
        // wins when present (matching the documented falsy-non-null
        // contract in `requireEitherField`), and falls back to
        // snake_case ONLY when camelCase is entirely absent.
        final emptyCamel = AssistantMessage.fromJson({
          'id': 'a1',
          'role': 'assistant',
          'toolCalls': <dynamic>[],
          'tool_calls': [
            {
              'id': 'call_1',
              'type': 'function',
              'function': {'name': 'fn', 'arguments': '{}'},
            },
          ],
        });
        // Documented behavior: camelCase wins when the key is present,
        // even when the list is empty. The snake_case payload is
        // silently ignored — surprising if you read the code as a
        // "fallback", correct if you read it as
        // "camelCase-key-present always wins".
        expect(emptyCamel.toolCalls, isEmpty);

        // When camelCase is absent, snake_case is consulted.
        final onlySnake = AssistantMessage.fromJson({
          'id': 'a2',
          'role': 'assistant',
          'tool_calls': [
            {
              'id': 'call_2',
              'type': 'function',
              'function': {'name': 'fn', 'arguments': '{}'},
            },
          ],
        });
        expect(onlySnake.toolCalls, isNotNull);
        expect(onlySnake.toolCalls!.length, 1);
        expect(onlySnake.toolCalls![0].id, equals('call_2'));
      });
    });

    group('ToolCall.encryptedValue parity', () {
      test(
          'round-trips encryptedValue (camelCase) on AssistantMessage.toolCalls',
          () {
        final msg = AssistantMessage.fromJson({
          'id': 'a1',
          'role': 'assistant',
          'content': null,
          'toolCalls': [
            {
              'id': 'call_1',
              'type': 'function',
              'function': {'name': 'fn', 'arguments': '{"a":1}'},
              'encryptedValue': 'cipher-camel',
            },
          ],
        });
        expect(msg.toolCalls!.single.encryptedValue, equals('cipher-camel'));

        final round = AssistantMessage.fromJson(msg.toJson());
        expect(round.toolCalls!.single.encryptedValue, equals('cipher-camel'));
      });

      test(
          'accepts snake_case encrypted_value alias and emits camelCase '
          'on toJson', () {
        final tc = ToolCall.fromJson({
          'id': 'call_1',
          'type': 'function',
          'function': {'name': 'fn', 'arguments': '{}'},
          'encrypted_value': 'cipher-snake',
        });
        expect(tc.encryptedValue, equals('cipher-snake'));
        expect(tc.toJson()['encryptedValue'], equals('cipher-snake'));
        expect(tc.toJson().containsKey('encrypted_value'), isFalse);
      });

      test('omits encryptedValue from toJson when null', () {
        final tc = ToolCall(
          id: 'call_1',
          function: const FunctionCall(name: 'fn', arguments: '{}'),
        );
        expect(tc.encryptedValue, isNull);
        expect(tc.toJson().containsKey('encryptedValue'), isFalse);
      });

      test('copyWith preserves encryptedValue when omitted', () {
        final tc = ToolCall(
          id: 'call_1',
          function: const FunctionCall(name: 'fn', arguments: '{}'),
          encryptedValue: 'cipher',
        );
        expect(tc.copyWith(id: 'call_2').encryptedValue, equals('cipher'));
      });

      test('copyWith(encryptedValue: null) clears the field', () {
        final tc = ToolCall(
          id: 'call_1',
          function: const FunctionCall(name: 'fn', arguments: '{}'),
          encryptedValue: 'cipher',
        );
        expect(tc.copyWith(encryptedValue: null).encryptedValue, isNull);
        expect(tc.copyWith().encryptedValue, equals('cipher'));
      });
    });

    group('Unknown field tolerance', () {
      test('should ignore unknown fields in JSON', () {
        final json = {
          'id': 'msg_unknown',
          'role': 'user',
          'content': 'User message',
          'unknown_field': 'should be ignored',
          'another_unknown': {'nested': 'data'},
        };

        final message = UserMessage.fromJson(json);
        expect(message.id, 'msg_unknown');
        expect(message.content, 'User message');

        // Verify unknown fields are not included in serialized output
        final serialized = message.toJson();
        expect(serialized.containsKey('unknown_field'), false);
        expect(serialized.containsKey('another_unknown'), false);
      });
    });

    group('BaseMessage.encryptedValue parity', () {
      // Closes the cross-SDK parity gap noted in the #1018 review:
      // canonical TS `BaseMessageSchema.encryptedValue: z.string().optional()`
      // and Python `BaseMessage.encrypted_value: Optional[str]` mean every
      // BaseMessage extension (Developer/System/Assistant/User/Tool) must
      // round-trip the field. Before this fix, only `ToolMessage` and
      // `ReasoningMessage` (the latter not strictly a BaseMessage) carried
      // it; a Dart proxy decoding an `assistant.encryptedValue` from a
      // TS or Python server silently dropped the value on every hop.

      test('AssistantMessage round-trips encryptedValue (camelCase)', () {
        final original = AssistantMessage(
          id: 'asst_001',
          content: 'Routed via cipher.',
          encryptedValue: 'YXNzaXN0YW50LWNpcGhlcg==',
        );

        final json = original.toJson();
        expect(json['encryptedValue'], 'YXNzaXN0YW50LWNpcGhlcg==');
        expect(json.containsKey('encrypted_value'), isFalse,
            reason: 'wire output is camelCase regardless of input spelling');

        final decoded = AssistantMessage.fromJson(json);
        expect(decoded.encryptedValue, original.encryptedValue);
        expect(decoded.role, MessageRole.assistant);
      });

      test('AssistantMessage accepts snake_case encrypted_value', () {
        final decoded = AssistantMessage.fromJson({
          'id': 'asst_002',
          'role': 'assistant',
          'content': 'From a Python server',
          'encrypted_value': 'cHl0aG9uLWNpcGhlcg==',
        });
        expect(decoded.encryptedValue, 'cHl0aG9uLWNpcGhlcg==');
        // Re-emit on the next hop in canonical camelCase.
        expect(decoded.toJson()['encryptedValue'], 'cHl0aG9uLWNpcGhlcg==');
      });

      test('UserMessage round-trips encryptedValue (camelCase)', () {
        final original = UserMessage(
          id: 'user_001',
          content: 'hi',
          encryptedValue: 'dXNlci1jaXBoZXI=',
        );

        final json = original.toJson();
        expect(json['encryptedValue'], 'dXNlci1jaXBoZXI=');

        final decoded = UserMessage.fromJson(json);
        expect(decoded.encryptedValue, original.encryptedValue);
        expect(decoded.role, MessageRole.user);
      });

      test('UserMessage accepts snake_case encrypted_value', () {
        final decoded = UserMessage.fromJson({
          'id': 'user_002',
          'role': 'user',
          'content': 'hi',
          'encrypted_value': 'cHk=',
        });
        expect(decoded.encryptedValue, 'cHk=');
      });

      test(
          'DeveloperMessage and SystemMessage round-trip encryptedValue '
          '(camelCase + snake_case)', () {
        final dev = DeveloperMessage(
          id: 'd1',
          content: 'dev',
          encryptedValue: 'ZGV2LWNpcGhlcg==',
        );
        expect(dev.toJson()['encryptedValue'], 'ZGV2LWNpcGhlcg==');
        expect(
          DeveloperMessage.fromJson(dev.toJson()).encryptedValue,
          'ZGV2LWNpcGhlcg==',
        );
        expect(
          DeveloperMessage.fromJson({
            'id': 'd2',
            'role': 'developer',
            'content': 'dev',
            'encrypted_value': 'ZGV2LXNuYWtl',
          }).encryptedValue,
          'ZGV2LXNuYWtl',
        );

        final sys = SystemMessage(
          id: 's1',
          content: 'sys',
          encryptedValue: 'c3lzLWNpcGhlcg==',
        );
        expect(sys.toJson()['encryptedValue'], 'c3lzLWNpcGhlcg==');
        expect(
          SystemMessage.fromJson(sys.toJson()).encryptedValue,
          'c3lzLWNpcGhlcg==',
        );
        expect(
          SystemMessage.fromJson({
            'id': 's2',
            'role': 'system',
            'content': 'sys',
            'encrypted_value': 'c3lzLXNuYWtl',
          }).encryptedValue,
          'c3lzLXNuYWtl',
        );
      });

      test(
          'AssistantMessage.copyWith(encryptedValue: null) clears the '
          'field; omitted argument preserves it', () {
        final msg = AssistantMessage(
          id: 'asst_003',
          content: 'hi',
          encryptedValue: 'cipher',
        );
        expect(msg.copyWith(encryptedValue: null).encryptedValue, isNull);
        expect(msg.copyWith().encryptedValue, equals('cipher'));
      });

      test(
          'UserMessage.copyWith(encryptedValue: null) clears the field; '
          'omitted argument preserves it', () {
        final msg = UserMessage(
          id: 'user_003',
          content: 'hi',
          encryptedValue: 'cipher',
        );
        expect(msg.copyWith(encryptedValue: null).encryptedValue, isNull);
        expect(msg.copyWith().encryptedValue, equals('cipher'));
      });

      test('omits encryptedValue from toJson when null', () {
        final msg = AssistantMessage(id: 'asst_004', content: 'hi');
        expect(msg.toJson().containsKey('encryptedValue'), isFalse);
      });
    });

    group('ReasoningMessage', () {
      test('Message.fromJson routes role=reasoning to ReasoningMessage', () {
        final msg = Message.fromJson({
          'id': 'r1',
          'role': 'reasoning',
          'content': 'I reasoned about X',
          'thinking': 'step-by-step...',
        });
        expect(msg, isA<ReasoningMessage>());
        expect(msg.role, MessageRole.reasoning);
      });

      test('round-trips all fields', () {
        final msg = ReasoningMessage(
          id: 'r1',
          content: 'conclusion',
          thinking: 'step-by-step',
          encryptedValue: 'ENC==',
        );
        final json = msg.toJson();
        expect(json['role'], 'reasoning');
        expect(json['content'], 'conclusion');
        expect(json['thinking'], 'step-by-step');
        expect(json['encryptedValue'], 'ENC==');

        final decoded = ReasoningMessage.fromJson(json);
        expect(decoded.id, 'r1');
        expect(decoded.content, 'conclusion');
        expect(decoded.thinking, 'step-by-step');
        expect(decoded.encryptedValue, 'ENC==');
      });

      test('accepts absent optional fields', () {
        final msg = ReasoningMessage.fromJson({'role': 'reasoning'});
        expect(msg.id, isNull);
        expect(msg.content, isNull);
        expect(msg.thinking, isNull);
        expect(msg.encryptedValue, isNull);
        expect(msg.toJson().containsKey('thinking'), false);
        expect(msg.toJson().containsKey('encryptedValue'), false);
      });

      test('reads snake_case encrypted_value', () {
        final msg = ReasoningMessage.fromJson({
          'role': 'reasoning',
          'encrypted_value': 'SNAKE_ENC',
        });
        expect(msg.encryptedValue, 'SNAKE_ENC');
      });

      test('copyWith overrides fields', () {
        final original = ReasoningMessage(
          id: 'r1',
          content: 'old',
          thinking: 'think',
          encryptedValue: 'ENC',
        );
        final copy = original.copyWith(content: 'new', encryptedValue: 'ENC2');
        expect(copy.id, 'r1');
        expect(copy.content, 'new');
        expect(copy.thinking, 'think');
        expect(copy.encryptedValue, 'ENC2');
      });

      test('MESSAGES_SNAPSHOT list containing reasoning message decodes without throwing', () {
        final snapshot = [
          {'id': '1', 'role': 'user', 'content': 'hi'},
          {'id': '2', 'role': 'assistant', 'content': 'thinking...'},
          {'id': '3', 'role': 'reasoning', 'thinking': 'step 1', 'content': 'answer'},
          {'id': '4', 'role': 'assistant', 'content': 'done'},
        ];
        final messages = snapshot.map((j) => Message.fromJson(j)).toList();
        expect(messages[2], isA<ReasoningMessage>());
        expect((messages[2] as ReasoningMessage).thinking, 'step 1');
      });
    });

    group('encryptedValue on Message types', () {
      test('AssistantMessage round-trips encryptedValue', () {
        final msg = AssistantMessage(
          id: 'a1',
          content: 'hello',
          encryptedValue: 'ENC==',
        );
        final json = msg.toJson();
        expect(json['encryptedValue'], 'ENC==');

        final decoded = AssistantMessage.fromJson(json);
        expect(decoded.encryptedValue, 'ENC==');
      });

      test('UserMessage round-trips encryptedValue', () {
        final msg = UserMessage.fromJson({
          'id': 'u1',
          'role': 'user',
          'content': 'hi',
          'encryptedValue': 'EU==',
        });
        expect(msg.encryptedValue, 'EU==');
        expect(msg.toJson()['encryptedValue'], 'EU==');
      });

      test('ToolMessage round-trips encryptedValue', () {
        final msg = ToolMessage(
          id: 't1',
          content: 'result',
          toolCallId: 'call_1',
          encryptedValue: 'ET==',
        );
        final decoded = ToolMessage.fromJson(msg.toJson());
        expect(decoded.encryptedValue, 'ET==');
      });

      test('reads snake_case encrypted_value on AssistantMessage', () {
        final msg = AssistantMessage.fromJson({
          'id': 'a2',
          'role': 'assistant',
          'content': 'hi',
          'encrypted_value': 'SNAKE_ENC',
        });
        expect(msg.encryptedValue, 'SNAKE_ENC');
      });

      test('omits encryptedValue from toJson when null', () {
        final msg = AssistantMessage(id: 'a3', content: 'hi');
        expect(msg.toJson().containsKey('encryptedValue'), false);
      });

      test('copyWith threads encryptedValue through AssistantMessage', () {
        final original = AssistantMessage(
          id: 'a4',
          content: 'original',
          encryptedValue: 'ENC',
        );
        final copy = original.copyWith(content: 'updated');
        expect(copy.encryptedValue, 'ENC');

        final cleared = original.copyWith(encryptedValue: 'NEW');
        expect(cleared.encryptedValue, 'NEW');
      });
    });
  });
}
