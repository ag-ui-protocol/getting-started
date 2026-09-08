import 'dart:convert';

import 'package:test/test.dart';
import 'package:ag_ui/ag_ui.dart';

void main() {
  group('Event Types', () {
    group('TextMessageEvents', () {
      test('TextMessageStartEvent serialization', () {
        final event = TextMessageStartEvent(
          messageId: 'msg_001',
          role: TextMessageRole.assistant,
          timestamp: 1234567890,
        );

        final json = event.toJson();
        expect(json['type'], 'TEXT_MESSAGE_START');
        expect(json['messageId'], 'msg_001');
        expect(json['role'], 'assistant');
        expect(json['timestamp'], 1234567890);

        final decoded = TextMessageStartEvent.fromJson(json);
        expect(decoded.messageId, event.messageId);
        expect(decoded.role, event.role);
        expect(decoded.timestamp, event.timestamp);
      });

      test('TextMessageContentEvent accepts empty delta (canonical parity)',
          () {
        // Canonical TS/Python schemas allow empty `delta`
        // (`TextMessageContentEventSchema.delta: z.string()` /
        // pydantic `delta: str` with no `min_length`). Servers may
        // legitimately emit a deliberate empty content chunk.
        final validEvent = TextMessageContentEvent(
          messageId: 'msg_001',
          delta: 'Hello world',
        );
        expect(validEvent.delta, 'Hello world');

        final empty = TextMessageContentEvent.fromJson({
          'type': 'TEXT_MESSAGE_CONTENT',
          'messageId': 'msg_001',
          'delta': '',
        });
        expect(empty.delta, isEmpty);
      });

      test('TextMessage* events accept snake_case (Python server)', () {
        final start = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'message_id': 'msg_001',
          'role': 'assistant',
        });
        expect(start.messageId, 'msg_001');

        final content = TextMessageContentEvent.fromJson({
          'type': 'TEXT_MESSAGE_CONTENT',
          'message_id': 'msg_001',
          'delta': 'hello',
        });
        expect(content.messageId, 'msg_001');
        expect(content.delta, 'hello');

        final end = TextMessageEndEvent.fromJson({
          'type': 'TEXT_MESSAGE_END',
          'message_id': 'msg_001',
        });
        expect(end.messageId, 'msg_001');

        final chunk = TextMessageChunkEvent.fromJson({
          'type': 'TEXT_MESSAGE_CHUNK',
          'message_id': 'msg_001',
          'delta': 'partial',
        });
        expect(chunk.messageId, 'msg_001');
        expect(chunk.delta, 'partial');
      });

      test('TextMessageChunkEvent optional fields', () {
        final event = TextMessageChunkEvent(
          messageId: 'msg_001',
          role: TextMessageRole.user,
          delta: 'chunk content',
        );

        final json = event.toJson();
        expect(json['messageId'], 'msg_001');
        expect(json['role'], 'user');
        expect(json['delta'], 'chunk content');

        // Test with all fields null
        final minimalEvent = TextMessageChunkEvent();
        final minimalJson = minimalEvent.toJson();
        expect(minimalJson.containsKey('messageId'), false);
        expect(minimalJson.containsKey('role'), false);
        expect(minimalJson.containsKey('delta'), false);
      });

      test('TextMessageRole.fromString throws on unknown values', () {
        // Aligned with `ReasoningMessageRole.fromString` — unknown wire
        // values throw at the enum so direct callers see a visible
        // failure mode. Wire decoding still succeeds via the factory's
        // absorb (see the `falls back to assistant` test below).
        expect(
          () => TextMessageRole.fromString('bogus'),
          throwsA(isA<ArgumentError>()),
        );
      });

      test(
          'TextMessageStartEvent falls back to assistant for an unknown '
          'role (forward-compat, no stream tear-down)', () {
        final decoded = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg_001',
          'role': 'bogus',
        });
        expect(decoded.role, TextMessageRole.assistant);
        expect(decoded.messageId, 'msg_001');
      });

      test(
          'TextMessageChunkEvent falls back to null for an unknown role '
          '(forward-compat: nullable field, not required like TextMessageStartEvent)',
          () {
        final decoded = TextMessageChunkEvent.fromJson({
          'type': 'TEXT_MESSAGE_CHUNK',
          'messageId': 'msg_001',
          'role': 'bogus',
          'delta': 'partial',
        });
        // role is nullable/optional on TextMessageChunkEvent — an unknown wire
        // value should produce null so callers can distinguish "absent" from
        // "unrecognized." Contrast: TextMessageStartEvent has a required role,
        // so the assistant fallback is appropriate there.
        expect(decoded.role, isNull);
        expect(decoded.messageId, 'msg_001');
        expect(decoded.delta, 'partial');
      });

      test('TextMessageStartEvent preserves name across round-trip', () {
        // Regression guard for #1018: pre-PR `name` was silently dropped
        // on decode. Now decode/re-encode preserves the field, and
        // omitting it round-trips as absent (no `'name': null`).
        final withName = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg_001',
          'role': 'assistant',
          'name': 'tool_response',
        });
        expect(withName.name, 'tool_response');
        expect(withName.toJson()['name'], 'tool_response');

        final withoutName = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg_002',
          'role': 'assistant',
        });
        expect(withoutName.name, isNull);
        expect(withoutName.toJson().containsKey('name'), false);
      });

      test('TextMessageChunkEvent preserves name across round-trip', () {
        // Same parity fix as TextMessageStartEvent. `name` on chunk is
        // optional; presence/absence must round-trip cleanly.
        final withName = TextMessageChunkEvent.fromJson({
          'type': 'TEXT_MESSAGE_CHUNK',
          'messageId': 'msg_001',
          'name': 'tool_response',
          'delta': 'hello',
        });
        expect(withName.name, 'tool_response');
        expect(withName.toJson()['name'], 'tool_response');

        final withoutName = TextMessageChunkEvent.fromJson({
          'type': 'TEXT_MESSAGE_CHUNK',
          'messageId': 'msg_002',
          'delta': 'hello',
        });
        expect(withoutName.name, isNull);
        expect(withoutName.toJson().containsKey('name'), false);
      });

      test('TextMessageStartEvent.copyWith(name: null) clears name', () {
        // Sentinel-pattern verification — `name` uses `_unsetCopyWith`.
        final event = TextMessageStartEvent(
          messageId: 'msg_001',
          name: 'foo',
        );
        expect(event.copyWith(name: null).name, isNull);
        expect(event.copyWith().name, 'foo');
      });
    });

    group('ToolCallEvents', () {
      test('ToolCallStartEvent with parent message', () {
        final event = ToolCallStartEvent(
          toolCallId: 'call_001',
          toolCallName: 'get_weather',
          parentMessageId: 'msg_001',
        );

        final json = event.toJson();
        expect(json['type'], 'TOOL_CALL_START');
        expect(json['toolCallId'], 'call_001');
        expect(json['toolCallName'], 'get_weather');
        expect(json['parentMessageId'], 'msg_001');

        final decoded = ToolCallStartEvent.fromJson(json);
        expect(decoded.toolCallId, event.toolCallId);
        expect(decoded.toolCallName, event.toolCallName);
        expect(decoded.parentMessageId, event.parentMessageId);
      });

      test('ToolCall* events accept snake_case (Python server)', () {
        final start = ToolCallStartEvent.fromJson({
          'type': 'TOOL_CALL_START',
          'tool_call_id': 'call_001',
          'tool_call_name': 'get_weather',
          'parent_message_id': 'msg_001',
        });
        expect(start.toolCallId, 'call_001');
        expect(start.toolCallName, 'get_weather');
        expect(start.parentMessageId, 'msg_001');

        final args = ToolCallArgsEvent.fromJson({
          'type': 'TOOL_CALL_ARGS',
          'tool_call_id': 'call_001',
          'delta': '{"q":"x"}',
        });
        expect(args.toolCallId, 'call_001');

        final end = ToolCallEndEvent.fromJson({
          'type': 'TOOL_CALL_END',
          'tool_call_id': 'call_001',
        });
        expect(end.toolCallId, 'call_001');

        final chunk = ToolCallChunkEvent.fromJson({
          'type': 'TOOL_CALL_CHUNK',
          'tool_call_id': 'call_001',
          'tool_call_name': 'get_weather',
          'parent_message_id': 'msg_001',
          'delta': '{',
        });
        expect(chunk.toolCallId, 'call_001');
        expect(chunk.toolCallName, 'get_weather');
        expect(chunk.parentMessageId, 'msg_001');

        final result = ToolCallResultEvent.fromJson({
          'type': 'TOOL_CALL_RESULT',
          'message_id': 'msg_001',
          'tool_call_id': 'call_001',
          'content': '72F sunny',
          'role': 'tool',
        });
        expect(result.messageId, 'msg_001');
        expect(result.toolCallId, 'call_001');
      });

      test('ToolCallResultEvent role field', () {
        final event = ToolCallResultEvent(
          messageId: 'msg_001',
          toolCallId: 'call_001',
          content: 'Weather: Sunny, 72°F',
          role: ToolCallResultRole.tool,
        );

        final json = event.toJson();
        expect(json['role'], 'tool');

        final decoded = ToolCallResultEvent.fromJson(json);
        expect(decoded.role, ToolCallResultRole.tool);
      });

      test('ToolCallResultEvent absorbs unknown wire role', () {
        // Forward-compat: an unknown role on the wire falls back to
        // `tool` so the stream stays alive. Mirrors `TextMessageRole` /
        // `ReasoningMessageRole` semantics — see
        // `dart-enum-parsing-safety.md`.
        final decoded = ToolCallResultEvent.fromJson({
          'type': 'TOOL_CALL_RESULT',
          'messageId': 'msg_001',
          'toolCallId': 'call_001',
          'content': 'ok',
          'role': 'developer',
        });
        expect(decoded.role, ToolCallResultRole.tool);
      });

      test('ToolCallResultEvent.copyWith(role: null) clears the role', () {
        final event = ToolCallResultEvent(
          messageId: 'msg_001',
          toolCallId: 'call_001',
          content: 'ok',
          role: ToolCallResultRole.tool,
        );
        expect(event.copyWith(role: null).role, isNull);
        expect(event.copyWith().role, ToolCallResultRole.tool);
      });

      test('ToolCallStartEvent.copyWith(parentMessageId: null) clears it', () {
        // Sentinel-pattern verification for `parentMessageId`.
        final event = ToolCallStartEvent(
          toolCallId: 'call_001',
          toolCallName: 'get_weather',
          parentMessageId: 'msg_001',
        );
        expect(event.copyWith(parentMessageId: null).parentMessageId, isNull);
        expect(event.copyWith().parentMessageId, 'msg_001');
      });

      test('ToolCallArgsEvent accepts empty delta (canonical parity)', () {
        // Canonical TS/Python schemas allow empty `delta`
        // (`ToolCallArgsEventSchema.delta: z.string()` / pydantic
        // `delta: str`). Direct factory and decoder pipeline both
        // accept it.
        final ev = ToolCallArgsEvent.fromJson({
          'type': 'TOOL_CALL_ARGS',
          'toolCallId': 'call_001',
          'delta': '',
        });
        expect(ev.delta, isEmpty);
      });

      test('ToolCallChunkEvent allows all-optional payload', () {
        // Pins the deliberate `case ToolCallChunkEvent(): break;` in
        // `EventDecoder.validate` (decoder.dart). An entirely empty chunk
        // is a valid wire shape; it round-trips and survives the decoder
        // boundary. Mirrors the equivalent assertion for
        // `ReasoningMessageChunkEvent`.
        final empty = ToolCallChunkEvent();
        final emptyJson = empty.toJson();
        expect(emptyJson['type'], 'TOOL_CALL_CHUNK');
        expect(emptyJson.containsKey('toolCallId'), false);
        expect(emptyJson.containsKey('toolCallName'), false);
        expect(emptyJson.containsKey('parentMessageId'), false);
        expect(emptyJson.containsKey('delta'), false);

        final decoded = ToolCallChunkEvent.fromJson(emptyJson);
        expect(decoded.toolCallId, isNull);
        expect(decoded.toolCallName, isNull);
        expect(decoded.parentMessageId, isNull);
        expect(decoded.delta, isNull);

        const decoder = EventDecoder();
        final viaDecoder = decoder.decodeJson({'type': 'TOOL_CALL_CHUNK'});
        expect(viaDecoder, isA<ToolCallChunkEvent>());
      });
    });

    group('StateEvents', () {
      test('StateSnapshotEvent with complex state', () {
        final complexState = {
          'counter': 42,
          'messages': ['msg1', 'msg2'],
          'metadata': {
            'timestamp': 1234567890,
            'user': 'test_user',
          },
        };

        final event = StateSnapshotEvent(snapshot: complexState);

        final json = event.toJson();
        expect(json['type'], 'STATE_SNAPSHOT');
        expect(json['snapshot'], complexState);

        final decoded = StateSnapshotEvent.fromJson(json);
        expect(decoded.snapshot, complexState);
      });

      test('StateDeltaEvent with JSON Patch operations', () {
        final delta = [
          {'op': 'add', 'path': '/foo', 'value': 'bar'},
          {'op': 'remove', 'path': '/baz'},
          {'op': 'replace', 'path': '/qux', 'value': 42},
        ];

        final event = StateDeltaEvent(delta: delta);

        final json = event.toJson();
        expect(json['type'], 'STATE_DELTA');
        expect(json['delta'], delta);

        final decoded = StateDeltaEvent.fromJson(json);
        expect(decoded.delta, delta);
      });

      test('MessagesSnapshotEvent with mixed message types', () {
        final messages = [
          UserMessage(id: '1', content: 'Hello'),
          AssistantMessage(id: '2', content: 'Hi there'),
          ToolMessage(
            id: '3',
            content: 'Result',
            toolCallId: 'call_001',
          ),
        ];

        final event = MessagesSnapshotEvent(messages: messages);

        final json = event.toJson();
        expect(json['type'], 'MESSAGES_SNAPSHOT');
        expect(json['messages'].length, 3);

        final decoded = MessagesSnapshotEvent.fromJson(json);
        expect(decoded.messages.length, 3);
        expect(decoded.messages[0], isA<UserMessage>());
        expect(decoded.messages[1], isA<AssistantMessage>());
        expect(decoded.messages[2], isA<ToolMessage>());
      });

      test('MessagesSnapshotEvent round-trips activity and reasoning messages',
          () {
        final messages = <Message>[
          UserMessage(id: 'u1', content: 'Index this directory.'),
          ActivityMessage(
            id: 'act1',
            activityType: 'task.run',
            activityContent: const {'progress': 0.0, 'items': []},
          ),
          ReasoningMessage(
            id: 'rsn1',
            content: 'Considering file types',
            encryptedValue: 'cGF5bG9hZA==',
          ),
        ];

        final event = MessagesSnapshotEvent(messages: messages);
        final json = event.toJson();

        final decoded = MessagesSnapshotEvent.fromJson(json);
        expect(decoded.messages.length, 3);
        expect(decoded.messages[1], isA<ActivityMessage>());
        expect(decoded.messages[2], isA<ReasoningMessage>());

        final activity = decoded.messages[1] as ActivityMessage;
        expect(activity.activityType, 'task.run');
        expect(activity.activityContent['progress'], 0.0);

        final reasoning = decoded.messages[2] as ReasoningMessage;
        expect(reasoning.content, 'Considering file types');
        expect(reasoning.encryptedValue, 'cGF5bG9hZA==');
      });
    });

    test(
        'MessagesSnapshotEvent.fromJson scrubs rawEvent when any message '
        'carries cipher data (S1 regression)', () {
      // Parallel to RunStartedEvent C1 regression. Verifies that the auto-scrub
      // in fromJson fires when the wire JSON contains both a rawEvent key AND a
      // cipher-bearing inner message.
      final wireJson = {
        'type': 'MESSAGES_SNAPSHOT',
        'messages': [
          {'id': 'm1', 'role': 'user', 'content': 'hi'},
          {
            'id': 'm2',
            'role': 'reasoning',
            'content': 'thinking',
            'encryptedValue': 'c2VjcmV0',
          },
        ],
        'rawEvent': {'original': 'wire-map'},
      };
      final event = MessagesSnapshotEvent.fromJson(wireJson);
      expect(
        event.rawEvent,
        isNull,
        reason:
            'rawEvent must be scrubbed when any message carries cipher data',
      );
      expect(event.messages.length, 2);
    });

    test(
        'MessagesSnapshotEvent.fromJson scrubs rawEvent when ActivityMessage '
        'carries wire-level encryptedValue (I1 regression)', () {
      // I1: ActivityMessage.fromJson silently strips encryptedValue from the
      // structured field, so the structured-field hasCipher predicate alone
      // returns false for an ActivityMessage with a wire-level cipher. The
      // fix extends the predicate to also check the raw wire messages list.
      final wireJson = {
        'type': 'MESSAGES_SNAPSHOT',
        'messages': [
          {
            'id': 'a1',
            'role': 'activity',
            'activityType': 'task.run',
            'content': <String, dynamic>{},
            'encryptedValue': 'should-not-leak',
          },
        ],
        'rawEvent': {'_passthrough': 'arbitrary'},
      };
      final event = MessagesSnapshotEvent.fromJson(wireJson);
      expect(
        event.rawEvent,
        isNull,
        reason:
            'rawEvent must be scrubbed when ActivityMessage carries '
            'wire-level encryptedValue',
      );
      final emitted = event.toJson();
      expect(
        jsonEncode(emitted),
        isNot(contains('should-not-leak')),
        reason: 'cipher must not leak through rawEvent passthrough',
      );
    });

    test(
        'MessagesSnapshotEvent.fromJson preserves rawEvent when no cipher '
        'data is present (S1 regression)', () {
      final wireJson = {
        'type': 'MESSAGES_SNAPSHOT',
        'messages': [
          {'id': 'm1', 'role': 'user', 'content': 'hi'},
        ],
        'rawEvent': {'seq': 1},
      };
      final event = MessagesSnapshotEvent.fromJson(wireJson);
      expect(
        event.rawEvent,
        {'seq': 1},
        reason: 'rawEvent must be preserved when no cipher data is present',
      );
    });

    test(
        'MessagesSnapshotEvent.copyWith forces rawEvent null when messages '
        'gain cipher data (I-3, release-mode safe)', () {
      // I-3: the assert in copyWith fires only in debug mode. This test
      // verifies the actual force-to-null branch, not the assert, so it
      // catches a regression even in release builds.
      final base = MessagesSnapshotEvent(
        messages: [UserMessage(id: '1', content: 'hi')],
        rawEvent: {'preserved': true},
      );
      expect(base.rawEvent, isNotNull);

      MessagesSnapshotEvent updated;
      try {
        updated = base.copyWith(
          messages: [
            ReasoningMessage(id: '2', content: 'r', encryptedValue: 'cipher'),
          ],
          rawEvent: {'attacker': 'leak'},
        );
      } on AssertionError {
        // Debug mode: assert fires before the force-to-null branch.
        // Fall through to construct via copyWith without rawEvent arg so
        // the branch itself is tested.
        updated = base.copyWith(
          messages: [
            ReasoningMessage(id: '2', content: 'r', encryptedValue: 'cipher'),
          ],
        );
      }
      expect(
        updated.rawEvent,
        isNull,
        reason:
            'cipher-scrub must apply in all build modes, not just debug/test',
      );
    });

    group('LifecycleEvents', () {
      test('RunStartedEvent handles both camelCase and snake_case', () {
        // Test camelCase
        final camelJson = {
          'type': 'RUN_STARTED',
          'threadId': 'thread_001',
          'runId': 'run_001',
        };

        final camelEvent = RunStartedEvent.fromJson(camelJson);
        expect(camelEvent.threadId, 'thread_001');
        expect(camelEvent.runId, 'run_001');

        // Test snake_case
        final snakeJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread_002',
          'run_id': 'run_002',
        };

        final snakeEvent = RunStartedEvent.fromJson(snakeJson);
        expect(snakeEvent.threadId, 'thread_002');
        expect(snakeEvent.runId, 'run_002');
      });

      test('RunFinishedEvent with result', () {
        final result = {
          'status': 'success',
          'data': [1, 2, 3]
        };
        final event = RunFinishedEvent(
          threadId: 'thread_001',
          runId: 'run_001',
          result: result,
        );

        final json = event.toJson();
        expect(json['result'], result);

        final decoded = RunFinishedEvent.fromJson(json);
        expect(decoded.result, result);
      });

      test('RunFinishedEvent.copyWith(result: null) clears the result', () {
        // The sentinel pattern lets a caller intentionally clear `result`,
        // matching the factory contract (which already accepts an absent
        // / null `result`).
        final original = RunFinishedEvent(
          threadId: 't',
          runId: 'r',
          result: {'status': 'success'},
        );
        final keep = original.copyWith();
        expect(keep.result, equals({'status': 'success'}));

        final cleared = original.copyWith(result: null);
        expect(cleared.result, isNull);
        expect(cleared.threadId, equals('t'));
        expect(cleared.runId, equals('r'));
      });

      test(
          'RunFinishedEvent absent result key decodes identically to explicit null',
          () {
        final absentJson = {
          'type': 'RUN_FINISHED',
          'threadId': 't',
          'runId': 'r'
        };
        final nullJson = {
          'type': 'RUN_FINISHED',
          'threadId': 't',
          'runId': 'r',
          'result': null
        };
        expect(RunFinishedEvent.fromJson(absentJson).result, isNull);
        expect(RunFinishedEvent.fromJson(nullJson).result, isNull);
        expect(
            RunFinishedEvent.fromJson(absentJson)
                .toJson()
                .containsKey('result'),
            isFalse);
        expect(
            RunFinishedEvent.fromJson(nullJson).toJson().containsKey('result'),
            isFalse);
      });

      test('RunFinishedEvent round-trip with null result drops the key', () {
        // Pins the contract that null result is NOT emitted on the wire, and
        // that a null-result event survives a toJson → fromJson round-trip.
        final original = RunFinishedEvent(
          threadId: 't1',
          runId: 'r1',
          result: null,
        );
        final encoded = original.toJson();
        expect(encoded.containsKey('result'), isFalse,
            reason: 'null result must not appear on wire');
        final decoded = RunFinishedEvent.fromJson(encoded);
        expect(decoded.result, isNull);
        expect(decoded.threadId, original.threadId);
        expect(decoded.runId, original.runId);
      });

      test('RunErrorEvent with error code', () {
        final event = RunErrorEvent(
          message: 'Something went wrong',
          code: 'ERR_TIMEOUT',
        );

        final json = event.toJson();
        expect(json['message'], 'Something went wrong');
        expect(json['code'], 'ERR_TIMEOUT');

        final decoded = RunErrorEvent.fromJson(json);
        expect(decoded.message, event.message);
        expect(decoded.code, event.code);
      });

      test('StepEvents handle both camelCase and snake_case', () {
        // StepStartedEvent
        final stepStartSnake = {
          'type': 'STEP_STARTED',
          'step_name': 'processing',
        };

        final stepStart = StepStartedEvent.fromJson(stepStartSnake);
        expect(stepStart.stepName, 'processing');

        // StepFinishedEvent
        final stepEndCamel = {
          'type': 'STEP_FINISHED',
          'stepName': 'processing',
        };

        final stepEnd = StepFinishedEvent.fromJson(stepEndCamel);
        expect(stepEnd.stepName, 'processing');
      });

      test('RunStartedEvent preserves parentRunId and input across round-trip',
          () {
        // Regression guard for #1018: pre-PR `parentRunId` and `input`
        // were silently dropped on decode. Both fields now round-trip,
        // including via the camelCase and snake_case wire spellings for
        // `parentRunId`. `input` itself has no snake_case variant for the
        // event-level key (single-word).
        final inputJson = {
          'threadId': 'tid',
          'runId': 'rid',
          'messages': <Map<String, dynamic>>[],
          'tools': <Map<String, dynamic>>[],
          'context': <Map<String, dynamic>>[],
        };
        final camelJson = {
          'type': 'RUN_STARTED',
          'threadId': 'tid',
          'runId': 'rid',
          'parentRunId': 'parent_rid',
          'input': inputJson,
        };
        final fromCamel = RunStartedEvent.fromJson(camelJson);
        expect(fromCamel.parentRunId, 'parent_rid');
        expect(fromCamel.input, isNotNull);
        expect(fromCamel.input!.threadId, 'tid');
        expect(fromCamel.input!.runId, 'rid');

        final reEmitted = fromCamel.toJson();
        expect(reEmitted['parentRunId'], 'parent_rid');
        expect(reEmitted['input'], isA<Map<String, dynamic>>());
        expect(reEmitted['input']['threadId'], 'tid');

        // snake_case parity for parentRunId
        final snakeJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'tid2',
          'run_id': 'rid2',
          'parent_run_id': 'parent_rid2',
        };
        final fromSnake = RunStartedEvent.fromJson(snakeJson);
        expect(fromSnake.parentRunId, 'parent_rid2');
        expect(fromSnake.input, isNull);

        // omitted parent / input → both null and omitted from toJson
        final minimal = RunStartedEvent.fromJson({
          'type': 'RUN_STARTED',
          'threadId': 'tid3',
          'runId': 'rid3',
        });
        expect(minimal.parentRunId, isNull);
        expect(minimal.input, isNull);
        expect(minimal.toJson().containsKey('parentRunId'), false);
        expect(minimal.toJson().containsKey('input'), false);
      });

      test(
          'RunStartedEvent.input.parentRunId round-trips '
          '(camelCase and snake_case)', () {
        // Parity follow-up: `RunStartedEvent.parentRunId` already
        // round-trips at the event level; this pins the embedded
        // `RunAgentInput.parentRunId` field, which canonical TS/Python
        // schemas also expose (`RunAgentInputSchema.parentRunId` /
        // `RunAgentInput.parent_run_id`). Pre-fix, the embedded field
        // was silently dropped at decode even when the event-level one
        // survived.
        final camelInputJson = {
          'threadId': 'tid',
          'runId': 'rid',
          'parentRunId': 'input-parent-rid',
          'messages': <Map<String, dynamic>>[],
          'tools': <Map<String, dynamic>>[],
          'context': <Map<String, dynamic>>[],
        };
        final camelEvent = RunStartedEvent.fromJson({
          'type': 'RUN_STARTED',
          'threadId': 'tid',
          'runId': 'rid',
          'input': camelInputJson,
        });
        expect(camelEvent.input!.parentRunId, 'input-parent-rid');
        final reEmitted = camelEvent.toJson();
        expect(
          (reEmitted['input'] as Map<String, dynamic>)['parentRunId'],
          'input-parent-rid',
        );

        // snake_case alias on the embedded input also decodes.
        final snakeInputJson = {
          'thread_id': 'tid',
          'run_id': 'rid',
          'parent_run_id': 'input-parent-snake',
          'messages': <Map<String, dynamic>>[],
          'tools': <Map<String, dynamic>>[],
          'context': <Map<String, dynamic>>[],
        };
        final snakeEvent = RunStartedEvent.fromJson({
          'type': 'RUN_STARTED',
          'threadId': 'tid',
          'runId': 'rid',
          'input': snakeInputJson,
        });
        expect(snakeEvent.input!.parentRunId, 'input-parent-snake');
      });

      test(
          'optionalIntField accepts JS/TS-shaped float timestamps '
          '(regression: cross-runtime decode)', () {
        // JS/TS producers serialize all numbers through a single Number
        // type, so a server emitting `Date.now() / 1000` arrives as
        // `double`. The previous `optionalField<int>` rejected `double`
        // even when integer-valued. `optionalIntField` accepts any
        // `num` and coerces via `.toInt()`. See
        // `dart-enum-parsing-safety.md` (cross-runtime decode notes).
        final fromDouble = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg_001',
          'role': 'assistant',
          'timestamp': 1.7e9, // a float — used to fail decode
        });
        expect(fromDouble.timestamp, equals(1700000000));

        final fromInt = TextMessageStartEvent.fromJson({
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg_002',
          'role': 'assistant',
          'timestamp': 1234567890,
        });
        expect(fromInt.timestamp, equals(1234567890));

        // Wrong type still rejects (string is not a num).
        expect(
          () => TextMessageStartEvent.fromJson({
            'type': 'TEXT_MESSAGE_START',
            'messageId': 'msg_003',
            'role': 'assistant',
            'timestamp': 'not-a-number',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('RunStartedEvent.copyWith(parentRunId: null) clears parentRunId',
          () {
        // Sentinel-pattern verification: per `_Unset` dartdoc, passing
        // `null` to a sentinel-using `copyWith` parameter MUST clear the
        // field, distinct from "argument omitted" which keeps it.
        final event = RunStartedEvent(
          threadId: 'tid',
          runId: 'rid',
          parentRunId: 'pid',
        );
        expect(event.copyWith(parentRunId: null).parentRunId, isNull);
        // Argument omitted → parentRunId preserved
        expect(event.copyWith().parentRunId, 'pid');
      });

      test('RunStartedEvent.copyWith(input: null) clears input', () {
        final input = RunAgentInput(
          threadId: 'tid',
          runId: 'rid',
          messages: const [],
          tools: const [],
          context: const [],
        );
        final event = RunStartedEvent(
          threadId: 'tid',
          runId: 'rid',
          input: input,
        );
        expect(event.copyWith(input: null).input, isNull);
        // Argument omitted → input preserved
        expect(event.copyWith().input, isNotNull);
      });

      test(
          'RunStartedEvent.fromJson scrubs rawEvent when input.messages '
          'carry cipher data (C1 regression)', () {
        // Regression: RunStartedEvent.fromJson previously forwarded the
        // verbatim wire map into rawEvent even when input.messages contained
        // encryptedValue payloads, undoing the cipher scrubbing that the
        // ReasoningMessage factory applied to the structured field.
        final wireJson = {
          'type': 'RUN_STARTED',
          'threadId': 'thread-1',
          'runId': 'run-1',
          'input': {
            'threadId': 'thread-1',
            'runId': 'run-1',
            'messages': [
              {
                'id': 'msg-1',
                'role': 'assistant',
                'content': 'hi',
              },
              {
                'id': 'msg-2',
                'role': 'reasoning',
                'content': 'thinking',
                'encryptedValue': 'c2VjcmV0',
              },
            ],
            'tools': <dynamic>[],
            'context': <dynamic>[],
          },
          'rawEvent': {'original': 'wire-map'},
        };
        final event = RunStartedEvent.fromJson(wireJson);
        // rawEvent MUST be null — the wire map carries encryptedValue in
        // input.messages[1] and must not leak through rawEvent.
        expect(
          event.rawEvent,
          isNull,
          reason:
              'rawEvent must be scrubbed when input.messages carry cipher data',
        );
        expect(event.input!.messages.length, 2);
      });

      test(
          'RunStartedEvent.fromJson scrubs rawEvent when input.messages '
          'contain ActivityMessage with wire-level encryptedValue (I1 regression)',
          () {
        // I1: ActivityMessage.fromJson silently strips wire-level
        // encryptedValue from the structured field, so the structured-field
        // hasCipher predicate alone returns false. The fix extends the
        // predicate to check the raw inputJson['messages'] directly.
        final wireJson = {
          'type': 'RUN_STARTED',
          'threadId': 'thread-1',
          'runId': 'run-1',
          'input': {
            'threadId': 'thread-1',
            'runId': 'run-1',
            'messages': [
              {
                'id': 'a1',
                'role': 'activity',
                'activityType': 'task.run',
                'content': <String, dynamic>{},
                'encryptedValue': 'should-not-leak',
              },
            ],
            'tools': <dynamic>[],
            'context': <dynamic>[],
          },
          'rawEvent': {'_passthrough': 'arbitrary'},
        };
        final event = RunStartedEvent.fromJson(wireJson);
        expect(
          event.rawEvent,
          isNull,
          reason:
              'rawEvent must be scrubbed when ActivityMessage in input.messages '
              'carries wire-level encryptedValue',
        );
        final emitted = event.toJson();
        expect(
          jsonEncode(emitted),
          isNot(contains('should-not-leak')),
          reason: 'cipher must not leak through rawEvent passthrough',
        );
      });

      test(
          'RunStartedEvent.fromJson preserves rawEvent when no cipher data '
          'is present', () {
        final wireJson = {
          'type': 'RUN_STARTED',
          'threadId': 'thread-1',
          'runId': 'run-1',
          'input': {
            'threadId': 'thread-1',
            'runId': 'run-1',
            'messages': [
              {
                'id': 'msg-1',
                'role': 'user',
                'content': 'hello',
              },
            ],
            'tools': <dynamic>[],
            'context': <dynamic>[],
          },
          'rawEvent': {'seq': 1},
        };
        final event = RunStartedEvent.fromJson(wireJson);
        expect(
          event.rawEvent,
          {'seq': 1},
          reason: 'rawEvent must be preserved when no cipher data is present',
        );
      });

      test(
          'RunStartedEvent.copyWith scrubs rawEvent when new input carries '
          'cipher data (C1 regression)', () {
        final cipherInput = RunAgentInput(
          threadId: 'tid',
          runId: 'rid',
          messages: [
            ReasoningMessage(
              id: 'r1',
              content: 'thinking',
              encryptedValue: 'c2VjcmV0',
            ),
          ],
          tools: const [],
          context: const [],
        );
        final event = RunStartedEvent(
          threadId: 'tid',
          runId: 'rid',
          rawEvent: {'original': 'map'},
        );
        final updated = event.copyWith(input: cipherInput);
        expect(
          updated.rawEvent,
          isNull,
          reason:
              'copyWith must scrub rawEvent when updated input carries cipher data',
        );
      });

      test('RunStartedEvent.fromJson rethrow does not leak input payload', () {
        expect(
          () => RunStartedEvent.fromJson({
            'type': 'RUN_STARTED',
            'threadId': 't',
            'runId': 'r',
            'input': {
              'runId': 'r',
              'threadId': 't',
              'messages': [{'id': 123, 'role': 'user', 'content': 'hi', 'encryptedValue': 'cipher'}],
              'tools': [],
              'context': [],
              'forwardedProps': {},
              'state': {},
            },
          }),
          throwsA(isA<AGUIValidationError>().having((e) => e.json, 'json', isNull)),
        );
      });
    });

    group('Event Factory', () {
      test('should create correct event type based on type field', () {
        final eventJsons = [
          {'type': 'TEXT_MESSAGE_START', 'messageId': 'msg_001'},
          {
            'type': 'TOOL_CALL_START',
            'toolCallId': 'call_001',
            'toolCallName': 'test'
          },
          {'type': 'STATE_SNAPSHOT', 'snapshot': {}},
          {'type': 'RUN_STARTED', 'threadId': 'thread_001', 'runId': 'run_001'},
          {'type': 'THINKING_START'},
          {'type': 'CUSTOM', 'name': 'my_event', 'value': 'data'},
        ];

        final events =
            eventJsons.map((json) => BaseEvent.fromJson(json)).toList();

        expect(events[0], isA<TextMessageStartEvent>());
        expect(events[1], isA<ToolCallStartEvent>());
        expect(events[2], isA<StateSnapshotEvent>());
        expect(events[3], isA<RunStartedEvent>());
        expect(events[4], isA<ThinkingStartEvent>());
        expect(events[5], isA<CustomEvent>());
      });

      test('should throw AGUIValidationError on invalid event type', () {
        // The factory wraps `EventType.fromString`'s raw `ArgumentError`
        // as `AGUIValidationError` so direct callers see the same error
        // surface as every other validation failure. Through the public
        // `EventDecoder` pipeline this surfaces as `DecodingError` —
        // see `event_decoding_integration_test.dart` ("validates
        // required fields strictly", invalid event type case).
        final json = {
          'type': 'INVALID_EVENT_TYPE',
          'data': 'some data',
        };

        expect(
          () => BaseEvent.fromJson(json),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('every event toJson preserves the type discriminator after spread',
          () {
        // Pins the invariant that `BaseEvent.toJson` emits `'type':
        // eventType.value` AND that no subclass `toJson` ever shadows it
        // via `...super.toJson()` spread. A future subclass that
        // accidentally adds a `'type'` key would silently overwrite the
        // discriminator and the analyzer wouldn't catch it — this test
        // would fail concretely. See `dart-sealed-classes-json-serialization.md`
        // ("`toJson()` that uses spread `...super.toJson()` will overwrite
        // the base's discriminator key").
        final samples = <BaseEvent>[
          TextMessageStartEvent(messageId: 'm'),
          TextMessageContentEvent(messageId: 'm', delta: 'd'),
          TextMessageEndEvent(messageId: 'm'),
          TextMessageChunkEvent(),
          // ignore: deprecated_member_use_from_same_package
          ThinkingTextMessageStartEvent(),
          // ignore: deprecated_member_use_from_same_package
          ThinkingTextMessageContentEvent(delta: 'd'),
          // ignore: deprecated_member_use_from_same_package
          ThinkingTextMessageEndEvent(),
          ToolCallStartEvent(toolCallId: 'c', toolCallName: 'n'),
          ToolCallArgsEvent(toolCallId: 'c', delta: 'd'),
          ToolCallEndEvent(toolCallId: 'c'),
          ToolCallChunkEvent(),
          ToolCallResultEvent(
            messageId: 'm',
            toolCallId: 'c',
            content: 'ok',
          ),
          ThinkingStartEvent(),
          ThinkingEndEvent(),
          StateSnapshotEvent(snapshot: <String, dynamic>{}),
          StateDeltaEvent(delta: const []),
          MessagesSnapshotEvent(messages: const []),
          ActivitySnapshotEvent(
            messageId: 'm',
            activityType: 't',
            content: null,
          ),
          ActivityDeltaEvent(
            messageId: 'm',
            activityType: 't',
            patch: const [],
          ),
          RawEvent(event: const {'k': 'v'}),
          CustomEvent(name: 'n', value: 'v'),
          RunStartedEvent(threadId: 'tid', runId: 'rid'),
          RunFinishedEvent(threadId: 'tid', runId: 'rid'),
          RunErrorEvent(message: 'oops'),
          StepStartedEvent(stepName: 's'),
          StepFinishedEvent(stepName: 's'),
          ReasoningStartEvent(messageId: 'm'),
          ReasoningMessageStartEvent(messageId: 'm'),
          ReasoningMessageContentEvent(messageId: 'm', delta: 'd'),
          ReasoningMessageEndEvent(messageId: 'm'),
          ReasoningMessageChunkEvent(),
          ReasoningEndEvent(messageId: 'm'),
          ReasoningEncryptedValueEvent(
            subtype: ReasoningEncryptedValueSubtype.message,
            entityId: 'e',
            encryptedValue: 'v',
          ),
        ];

        for (final e in samples) {
          expect(
            e.toJson()['type'],
            equals(e.eventType.value),
            reason:
                'discriminator must survive ...super.toJson() spread for ${e.runtimeType}',
          );
        }

        // Sanity: the sample list covers every non-deprecated EventType.
        // `thinkingContent` is intentionally excluded: it is the only
        // Dart-only legacy event type (no protocol-level wire value), so it
        // gets its own dedicated round-trip test ('deprecated
        // ThinkingContentEvent still round-trips') rather than sharing this
        // sample list. Keeping the deprecation surface narrow makes the 1.0.0
        // removal sweep a single-file edit.
        final coveredTypes = samples.map((e) => e.eventType).toSet();
        // ignore: deprecated_member_use_from_same_package
        final expectedTypes = EventType.values.toSet()
          ..remove(EventType.thinkingContent);
        expect(coveredTypes, equals(expectedTypes));
      });
    });

    group('ThinkingEvents', () {
      test('ThinkingStartEvent with title', () {
        final event = ThinkingStartEvent(title: 'Processing request');

        final json = event.toJson();
        expect(json['type'], 'THINKING_START');
        expect(json['title'], 'Processing request');

        final decoded = ThinkingStartEvent.fromJson(json);
        expect(decoded.title, 'Processing request');
      });

      test('ThinkingTextMessageContentEvent accepts empty delta', () {
        // Relaxed to match canonical `z.string()` contract — empty `delta`
        // is now accepted. Migrate to [ReasoningMessageContentEvent].
        final json = {
          'type': 'THINKING_TEXT_MESSAGE_CONTENT',
          'delta': '',
        };

        // ignore: deprecated_member_use_from_same_package
        final event = ThinkingTextMessageContentEvent.fromJson(json);
        expect(event.delta, isEmpty);
      });

      test('deprecated ThinkingContentEvent still round-trips', () {
        // Locks in the backward-compat contract on the deprecation:
        // decoding/encoding must keep working until the planned removal.
        // ignore: deprecated_member_use_from_same_package
        final original = ThinkingContentEvent(delta: 'still works');
        final json = original.toJson();
        expect(json['type'], 'THINKING_CONTENT');
        expect(json['delta'], 'still works');

        // ignore: deprecated_member_use_from_same_package
        final decoded = ThinkingContentEvent.fromJson(json);
        expect(decoded.delta, 'still works');
      });

      test('EventDecoder still decodes deprecated THINKING_CONTENT', () {
        // Backs the CHANGELOG promise that the deprecated path remains
        // decodable end-to-end through the public decoder boundary.
        const decoder = EventDecoder();

        final event = decoder.decodeJson({
          'type': 'THINKING_CONTENT',
          'delta': 'legacy payload',
        });

        // ignore: deprecated_member_use_from_same_package
        expect(event, isA<ThinkingContentEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect((event as ThinkingContentEvent).delta, 'legacy payload');
      });
    });

    group('Raw and Custom Events', () {
      test('RawEvent with source', () {
        final rawEventData = {
          'original': 'event',
          'data': [1, 2, 3],
        };

        final event = RawEvent(
          event: rawEventData,
          source: 'external_api',
        );

        final json = event.toJson();
        expect(json['event'], rawEventData);
        expect(json['source'], 'external_api');

        final decoded = RawEvent.fromJson(json);
        expect(decoded.event, rawEventData);
        expect(decoded.source, 'external_api');
      });

      test('rawEvent / raw_event dual-key — Python snake_case is preserved',
          () {
        // Python emits `raw_event`; TS emits `rawEvent`. Both must decode
        // into `BaseEvent.rawEvent` so a Dart proxy can re-emit it
        // (camelCase) on the next hop. Regression for the silent-drop bug
        // that pre-existed across every event factory.
        final upstreamPayload = {'origin': 'python-server', 'seq': 7};

        // 1. Python-style snake_case input on RunStartedEvent.
        final pythonJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread_001',
          'run_id': 'run_001',
          'raw_event': upstreamPayload,
        };
        final fromSnake = RunStartedEvent.fromJson(pythonJson);
        expect(fromSnake.rawEvent, upstreamPayload);
        // Output is canonical camelCase.
        expect(fromSnake.toJson()['rawEvent'], upstreamPayload);

        // 2. camelCase wins when both keys are present.
        final bothKeys = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread_001',
          'run_id': 'run_001',
          'rawEvent': {'winner': 'camel'},
          'raw_event': {'winner': 'snake'},
        };
        final fromBoth = RunStartedEvent.fromJson(bothKeys);
        expect(fromBoth.rawEvent, {'winner': 'camel'});

        // 3. camelCase explicit-null wins (containsKey precedence).
        final nullCamel = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread_001',
          'run_id': 'run_001',
          'rawEvent': null,
          'raw_event': {'winner': 'snake'},
        };
        final fromNullCamel = RunStartedEvent.fromJson(nullCamel);
        expect(fromNullCamel.rawEvent, isNull);
      });

      test('CustomEvent with complex value', () {
        final customValue = {
          'action': 'update_ui',
          'parameters': {'theme': 'dark', 'language': 'en'},
        };

        final event = CustomEvent(
          name: 'ui_config_change',
          value: customValue,
        );

        final json = event.toJson();
        expect(json['name'], 'ui_config_change');
        expect(json['value'], customValue);

        final decoded = CustomEvent.fromJson(json);
        expect(decoded.name, 'ui_config_change');
        expect(decoded.value, customValue);
      });

      test('RawEvent.copyWith(event: null) clears the payload', () {
        // The sentinel pattern (mirroring `ActivitySnapshotEvent.content`)
        // distinguishes "argument omitted" from "argument explicitly
        // null", so an explicit null actually clears the field.
        final original = RawEvent(
          event: {'foo': 'bar'},
          source: 'agent',
        );
        final keep = original.copyWith();
        expect(keep.event, equals({'foo': 'bar'}));

        final cleared = original.copyWith(event: null);
        expect(cleared.event, isNull);
        expect(cleared.source, equals('agent'));
      });

      test('RawEvent.copyWith(source: null) clears source', () {
        // Sentinel parity for the second nullable field (was `?? this.source`
        // before the sentinel sweep). Without the sentinel, an explicit
        // `null` was indistinguishable from "argument omitted".
        final original = RawEvent(
          event: const {'foo': 'bar'},
          source: 'agent',
        );
        final keep = original.copyWith();
        expect(keep.source, equals('agent'));

        final cleared = original.copyWith(source: null);
        expect(cleared.source, isNull);
        // Other fields preserved.
        expect(cleared.event, equals(const {'foo': 'bar'}));
      });

      test('CustomEvent.copyWith(value: null) clears the payload', () {
        final original = CustomEvent(name: 'evt', value: 42);
        final keep = original.copyWith();
        expect(keep.value, equals(42));

        final cleared = original.copyWith(value: null);
        expect(cleared.value, isNull);
        expect(cleared.name, equals('evt'));
      });
    });

    group('ActivityEvents', () {
      test('ActivitySnapshotEvent serialization round-trip', () {
        final content = {
          'title': 'Processing',
          'progress': 0.5,
          'steps': ['fetch', 'parse'],
        };

        final event = ActivitySnapshotEvent(
          messageId: 'msg_001',
          activityType: 'task.run',
          content: content,
          replace: false,
        );

        final json = event.toJson();
        expect(json['type'], 'ACTIVITY_SNAPSHOT');
        expect(json['messageId'], 'msg_001');
        expect(json['activityType'], 'task.run');
        expect(json['content'], content);
        expect(json['replace'], false);

        final decoded = ActivitySnapshotEvent.fromJson(json);
        expect(decoded.messageId, 'msg_001');
        expect(decoded.activityType, 'task.run');
        expect(decoded.content, content);
        expect(decoded.replace, false);
      });

      test('ActivitySnapshotEvent defaults replace to true', () {
        final json = {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg_001',
          'activityType': 'task.run',
          'content': {'foo': 'bar'},
        };

        final decoded = ActivitySnapshotEvent.fromJson(json);
        expect(decoded.replace, true);
      });

      test(
          'ActivitySnapshotEvent.toJson omits replace when true (default), '
          'emits replace when false', () {
        // Canonical TS/Python wire behavior: `replace` is omitted when it
        // equals the default `true`; emitted only when `false`. `fromJson`
        // defaults to `true` when absent, so round-trip semantics hold.
        final defaultEvent = ActivitySnapshotEvent(
          messageId: 'm',
          activityType: 't',
          content: null,
        );
        expect(defaultEvent.replace, isTrue);
        expect(defaultEvent.toJson().containsKey('replace'), isFalse,
            reason: 'replace=true (default) must be omitted from wire output');

        final replaceEvent = ActivitySnapshotEvent(
          messageId: 'm',
          activityType: 't',
          content: null,
          replace: false,
        );
        expect(replaceEvent.toJson()['replace'], isFalse,
            reason: 'replace=false (non-default) must be emitted');
      });

      test('ActivitySnapshotEvent treats explicit-null replace as default-true',
          () {
        // `optionalField<bool>` returns null for both an absent key and
        // an explicit-null value; the `?? true` coercion at the factory
        // pins the documented behavior. This test locks the contract so
        // a future change to `optionalField<bool>` semantics doesn't
        // silently drift.
        final decoded = ActivitySnapshotEvent.fromJson({
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg_001',
          'activityType': 'task.run',
          'content': null,
          'replace': null,
        });
        expect(decoded.replace, isTrue);
      });

      test('ActivitySnapshotEvent accepts snake_case (Python server)', () {
        final pythonJson = {
          'type': 'ACTIVITY_SNAPSHOT',
          'message_id': 'msg_002',
          'activity_type': 'task.run',
          'content': 'hello',
          'replace': true,
        };

        final decoded = ActivitySnapshotEvent.fromJson(pythonJson);
        expect(decoded.messageId, 'msg_002');
        expect(decoded.activityType, 'task.run');
        expect(decoded.content, 'hello');
        expect(decoded.replace, true);
      });

      test('ActivityDeltaEvent serialization round-trip', () {
        final patch = [
          {'op': 'replace', 'path': '/progress', 'value': 0.75},
          {'op': 'add', 'path': '/steps/-', 'value': 'finalize'},
        ];

        final event = ActivityDeltaEvent(
          messageId: 'msg_001',
          activityType: 'task.run',
          patch: patch,
        );

        final json = event.toJson();
        expect(json['type'], 'ACTIVITY_DELTA');
        expect(json['messageId'], 'msg_001');
        expect(json['activityType'], 'task.run');
        expect(json['patch'], patch);

        final decoded = ActivityDeltaEvent.fromJson(json);
        expect(decoded.messageId, 'msg_001');
        expect(decoded.activityType, 'task.run');
        expect(decoded.patch, patch);
      });

      test('ActivityDeltaEvent accepts snake_case (Python server)', () {
        final pythonJson = {
          'type': 'ACTIVITY_DELTA',
          'message_id': 'msg_003',
          'activity_type': 'task.run',
          'patch': [
            {'op': 'replace', 'path': '/x', 'value': 1},
          ],
        };

        final decoded = ActivityDeltaEvent.fromJson(pythonJson);
        expect(decoded.messageId, 'msg_003');
        expect(decoded.activityType, 'task.run');
        expect(decoded.patch.length, 1);
      });

      test('Activity events dispatch via BaseEvent.fromJson', () {
        final snapshot = BaseEvent.fromJson({
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'm',
          'activityType': 't',
          'content': null,
        });
        expect(snapshot, isA<ActivitySnapshotEvent>());
        expect((snapshot as ActivitySnapshotEvent).content, isNull);

        final delta = BaseEvent.fromJson({
          'type': 'ACTIVITY_DELTA',
          'messageId': 'm',
          'activityType': 't',
          'patch': <dynamic>[],
        });
        expect(delta, isA<ActivityDeltaEvent>());
      });

      test('ActivitySnapshotEvent rejects missing content key', () {
        // Mirrors the `StateSnapshotEvent` / `RawEvent` contract: the
        // payload field may be any JSON shape (including `null`) but the
        // KEY must be present. Distinguishing missing-key from
        // explicit-null is the whole point of this check.
        expect(
          () => ActivitySnapshotEvent.fromJson({
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'msg_001',
            'activityType': 'task.run',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivitySnapshotEvent accepts explicit-null content', () {
        // The companion to "rejects missing content key": an explicit
        // `null` is a valid wire payload (Python's `content: Any`
        // permits None) and must round-trip without error.
        final decoded = ActivitySnapshotEvent.fromJson({
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'msg_001',
          'activityType': 'task.run',
          'content': null,
        });
        expect(decoded.content, isNull);
      });

      test('ActivitySnapshotEvent.copyWith(content: null) clears content', () {
        // The factory contract permits explicit-null `content`, and so
        // must `copyWith` — distinguishing "argument omitted" from
        // "argument explicitly set to null" via the
        // `_unsetCopyWith` sentinel.
        final original = ActivitySnapshotEvent(
          messageId: 'msg_001',
          activityType: 'task.run',
          content: {'progress': 0.25},
        );
        // Omitted content keeps the existing value.
        final keep = original.copyWith();
        expect(keep.content, equals({'progress': 0.25}));

        // Explicit-null clears the content.
        final cleared = original.copyWith(content: null);
        expect(cleared.content, isNull);
      });

      test('ActivitySnapshotEvent rejects missing messageId', () {
        expect(
          () => ActivitySnapshotEvent.fromJson({
            'type': 'ACTIVITY_SNAPSHOT',
            'activityType': 'task.run',
            'content': null,
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivityDeltaEvent rejects missing messageId', () {
        expect(
          () => ActivityDeltaEvent.fromJson({
            'type': 'ACTIVITY_DELTA',
            'activityType': 'task.run',
            'patch': <dynamic>[],
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivityDeltaEvent rejects missing activityType', () {
        expect(
          () => ActivityDeltaEvent.fromJson({
            'type': 'ACTIVITY_DELTA',
            'messageId': 'msg_001',
            'patch': <dynamic>[],
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivityDeltaEvent rejects missing patch', () {
        expect(
          () => ActivityDeltaEvent.fromJson({
            'type': 'ACTIVITY_DELTA',
            'messageId': 'msg_001',
            'activityType': 'task.run',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ActivitySnapshotEvent copyWith preserves untouched fields', () {
        final original = ActivitySnapshotEvent(
          messageId: 'msg_001',
          activityType: 'task.run',
          content: 'original',
        );

        final updated = original.copyWith(content: 'new');
        expect(updated.messageId, original.messageId);
        expect(updated.activityType, original.activityType);
        expect(updated.content, 'new');
        expect(updated.replace, original.replace);
      });
    });

    group('ReasoningEvents', () {
      test('ReasoningStartEvent serialization round-trip', () {
        final event = ReasoningStartEvent(messageId: 'msg_r1');

        final json = event.toJson();
        expect(json['type'], 'REASONING_START');
        expect(json['messageId'], 'msg_r1');

        final decoded = ReasoningStartEvent.fromJson(json);
        expect(decoded.messageId, 'msg_r1');
      });

      test('ReasoningStartEvent accepts snake_case', () {
        final decoded = ReasoningStartEvent.fromJson({
          'type': 'REASONING_START',
          'message_id': 'msg_r1',
        });
        expect(decoded.messageId, 'msg_r1');
      });

      test('ReasoningMessageStartEvent accepts snake_case', () {
        final decoded = ReasoningMessageStartEvent.fromJson({
          'type': 'REASONING_MESSAGE_START',
          'message_id': 'msg_r2',
          'role': 'reasoning',
        });
        expect(decoded.messageId, 'msg_r2');
        expect(decoded.role, ReasoningMessageRole.reasoning);
      });

      test('ReasoningMessageContentEvent accepts snake_case', () {
        final decoded = ReasoningMessageContentEvent.fromJson({
          'type': 'REASONING_MESSAGE_CONTENT',
          'message_id': 'msg_r3',
          'delta': 'thinking step',
        });
        expect(decoded.messageId, 'msg_r3');
        expect(decoded.delta, 'thinking step');
      });

      test('ReasoningMessageEndEvent accepts snake_case', () {
        final decoded = ReasoningMessageEndEvent.fromJson({
          'type': 'REASONING_MESSAGE_END',
          'message_id': 'msg_r4',
        });
        expect(decoded.messageId, 'msg_r4');
      });

      test('ReasoningEndEvent accepts snake_case', () {
        final decoded = ReasoningEndEvent.fromJson({
          'type': 'REASONING_END',
          'message_id': 'msg_r6',
        });
        expect(decoded.messageId, 'msg_r6');
      });

      test('ReasoningMessageStartEvent default role is reasoning', () {
        final event = ReasoningMessageStartEvent(messageId: 'msg_r2');
        expect(event.role, ReasoningMessageRole.reasoning);

        final json = event.toJson();
        expect(json['type'], 'REASONING_MESSAGE_START');
        expect(json['role'], 'reasoning');

        final decoded = ReasoningMessageStartEvent.fromJson(json);
        expect(decoded.role, ReasoningMessageRole.reasoning);
        expect(decoded.messageId, 'msg_r2');
      });

      test('ReasoningMessageContentEvent serialization round-trip', () {
        final event = ReasoningMessageContentEvent(
          messageId: 'msg_r3',
          delta: 'thinking step',
        );

        final json = event.toJson();
        expect(json['type'], 'REASONING_MESSAGE_CONTENT');
        expect(json['delta'], 'thinking step');

        final decoded = ReasoningMessageContentEvent.fromJson(json);
        expect(decoded.messageId, 'msg_r3');
        expect(decoded.delta, 'thinking step');
      });

      test('ReasoningMessageEndEvent serialization round-trip', () {
        final event = ReasoningMessageEndEvent(messageId: 'msg_r4');

        final json = event.toJson();
        expect(json['type'], 'REASONING_MESSAGE_END');

        final decoded = ReasoningMessageEndEvent.fromJson(json);
        expect(decoded.messageId, 'msg_r4');
      });

      test('ReasoningMessageChunkEvent allows all-optional payload', () {
        final empty = ReasoningMessageChunkEvent();
        final emptyJson = empty.toJson();
        expect(emptyJson['type'], 'REASONING_MESSAGE_CHUNK');
        expect(emptyJson.containsKey('messageId'), false);
        expect(emptyJson.containsKey('delta'), false);

        final decoded = ReasoningMessageChunkEvent.fromJson(emptyJson);
        expect(decoded.messageId, isNull);
        expect(decoded.delta, isNull);

        final populated = ReasoningMessageChunkEvent(
          messageId: 'msg_r5',
          delta: 'partial',
        );
        final pjson = populated.toJson();
        expect(pjson['messageId'], 'msg_r5');
        expect(pjson['delta'], 'partial');
      });

      test('ReasoningMessageChunkEvent.copyWith(delta: null) clears delta', () {
        // Sentinel-pattern verification for both `messageId` and `delta`.
        final event = ReasoningMessageChunkEvent(
          messageId: 'msg_r5',
          delta: 'partial',
        );
        expect(event.copyWith(delta: null).delta, isNull);
        expect(event.copyWith(messageId: null).messageId, isNull);
        // Argument omitted preserves both
        final cloned = event.copyWith();
        expect(cloned.messageId, 'msg_r5');
        expect(cloned.delta, 'partial');
      });

      test('ReasoningEndEvent serialization round-trip', () {
        final event = ReasoningEndEvent(messageId: 'msg_r6');

        final json = event.toJson();
        expect(json['type'], 'REASONING_END');

        final decoded = ReasoningEndEvent.fromJson(json);
        expect(decoded.messageId, 'msg_r6');
      });

      test('ReasoningEncryptedValueEvent supports both subtypes', () {
        final tool = ReasoningEncryptedValueEvent(
          subtype: ReasoningEncryptedValueSubtype.toolCall,
          entityId: 'tc_1',
          encryptedValue: 'cipher-1',
        );
        final toolJson = tool.toJson();
        expect(toolJson['type'], 'REASONING_ENCRYPTED_VALUE');
        expect(toolJson['subtype'], 'tool-call');
        expect(toolJson['entityId'], 'tc_1');
        expect(toolJson['encryptedValue'], 'cipher-1');

        final decodedTool = ReasoningEncryptedValueEvent.fromJson(toolJson);
        expect(decodedTool.subtype, ReasoningEncryptedValueSubtype.toolCall);
        expect(decodedTool.entityId, 'tc_1');
        expect(decodedTool.encryptedValue, 'cipher-1');

        final msg = ReasoningEncryptedValueEvent(
          subtype: ReasoningEncryptedValueSubtype.message,
          entityId: 'm_1',
          encryptedValue: 'cipher-2',
        );
        expect(msg.toJson()['subtype'], 'message');
      });

      test('ReasoningEncryptedValueEvent accepts snake_case', () {
        final decoded = ReasoningEncryptedValueEvent.fromJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'tool-call',
          'entity_id': 'tc_2',
          'encrypted_value': 'cipher-3',
        });
        expect(decoded.subtype, ReasoningEncryptedValueSubtype.toolCall);
        expect(decoded.entityId, 'tc_2');
        expect(decoded.encryptedValue, 'cipher-3');
      });

      test('ReasoningEncryptedValueSubtype.fromString throws on unknown values',
          () {
        // Unlike other enum fromString helpers (which throw ArgumentError),
        // ReasoningEncryptedValueSubtype.fromString throws AGUIValidationError
        // so the cipher-data path can surface a typed, structured error.
        expect(
          () => ReasoningEncryptedValueSubtype.fromString('bogus'),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ReasoningMessageRole.fromString throws on unknown values', () {
        expect(
          () => ReasoningMessageRole.fromString('bogus'),
          throwsA(isA<ArgumentError>()),
        );
      });

      test(
          'ReasoningMessageStartEvent falls back to `reasoning` for an '
          'unknown role (forward-compat, no stream tear-down)', () {
        // `ReasoningMessageRole` is currently a single-variant enum
        // mirroring the canonical `Literal["reasoning"]` in the Python
        // and TypeScript SDKs (see the dartdoc on `ReasoningMessageRole`
        // in `lib/src/events/events.dart`). The forward-compat machinery
        // — `fromString` throw + factory absorb + fallback — therefore
        // exercises a path that cannot legitimately fire today, but
        // pins the contract for the day a future spec adds a second
        // role value. Do not delete this as tautological.
        final decoded = ReasoningMessageStartEvent.fromJson({
          'type': 'REASONING_MESSAGE_START',
          'messageId': 'msg_r2',
          'role': 'bogus',
        });
        expect(decoded.role, ReasoningMessageRole.reasoning);
        expect(decoded.messageId, 'msg_r2');
      });

      test(
          'ReasoningMessageStartEvent rejects missing role (parity with TS/Python)',
          () {
        // The canonical TypeScript and Python schemas both mark `role` as
        // required on REASONING_MESSAGE_START. A producer bug that drops
        // the field must surface as a protocol violation here, not be
        // silently coerced to `reasoning` (which would let malformed
        // payloads pass undetected and diverge from the reference SDKs).
        expect(
          () => ReasoningMessageStartEvent.fromJson({
            'type': 'REASONING_MESSAGE_START',
            'messageId': 'msg_r2',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ReasoningMessageChunkEvent accepts snake_case', () {
        final decoded = ReasoningMessageChunkEvent.fromJson({
          'type': 'REASONING_MESSAGE_CHUNK',
          'message_id': 'msg_r5',
          'delta': 'partial',
        });

        expect(decoded.messageId, 'msg_r5');
        expect(decoded.delta, 'partial');
      });

      test('ReasoningMessageContentEvent rejects missing delta', () {
        expect(
          () => ReasoningMessageContentEvent.fromJson({
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': 'msg_r3',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test(
          'ReasoningMessageContentEvent accepts empty delta (canonical parity)',
          () {
        // Canonical TS/Python schemas allow empty `delta`
        // (`ReasoningMessageContentEventSchema.delta: z.string()` /
        // pydantic `delta: str`). The Dart SDK matches.
        final ev = ReasoningMessageContentEvent.fromJson({
          'type': 'REASONING_MESSAGE_CONTENT',
          'messageId': 'msg_r3',
          'delta': '',
        });
        expect(ev.delta, isEmpty);
      });

      test('ReasoningEncryptedValueEvent rejects missing subtype', () {
        expect(
          () => ReasoningEncryptedValueEvent.fromJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'entityId': 'tc_1',
            'encryptedValue': 'cipher-1',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ReasoningEncryptedValueEvent rejects missing entityId', () {
        expect(
          () => ReasoningEncryptedValueEvent.fromJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'message',
            'encryptedValue': 'cipher',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ReasoningEncryptedValueEvent rejects missing encryptedValue', () {
        expect(
          () => ReasoningEncryptedValueEvent.fromJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'message',
            'entityId': 'msg_1',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test(
          'ReasoningEncryptedValueEvent accepts empty entityId / '
          'encryptedValue (canonical-schema parity)', () {
        // Canonical schemas: TS `events.ts` declares `entityId: z.string()`
        // and `encryptedValue: z.string()`; Python `events.py` declares
        // `entity_id: str` and `encrypted_value: str`. Neither imposes a
        // minimum length. Dart must not be stricter than the protocol —
        // a payload accepted by TS/Python must decode in Dart.
        final emptyEntity = ReasoningEncryptedValueEvent.fromJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': '',
          'encryptedValue': 'cipher',
        });
        expect(emptyEntity.entityId, '');
        expect(emptyEntity.encryptedValue, 'cipher');

        final emptyCipher = ReasoningEncryptedValueEvent.fromJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': 'rsn_01',
          'encryptedValue': '',
        });
        expect(emptyCipher.entityId, 'rsn_01');
        expect(emptyCipher.encryptedValue, '');
      });

      test('ReasoningEncryptedValueEvent rejects unknown subtype', () {
        // Pins the dartdoc contract: an unknown `subtype` must surface
        // to direct factory callers as `AGUIValidationError` (not as
        // the raw `ArgumentError` that the enum itself throws). The
        // matching wire→DecodingError contract is locked in by the
        // integration test in
        // event_decoding_integration_test.dart.
        expect(
          () => ReasoningEncryptedValueEvent.fromJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'bogus',
            'entityId': 'rsn_01',
            'encryptedValue': 'cipher',
          }),
          throwsA(isA<AGUIValidationError>()),
        );
      });

      test('ReasoningEncryptedValueEvent.fromJson scrubs rawEvent', () {
        final decoded = ReasoningEncryptedValueEvent.fromJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': 'r-1',
          'encryptedValue': 'cipher',
          'rawEvent': {'leak': true},
        });
        expect(decoded.rawEvent, isNull);
      });

      test('Reasoning events dispatch via BaseEvent.fromJson', () {
        final cases = <Map<String, dynamic>, Type>{
          {'type': 'REASONING_START', 'messageId': 'm'}: ReasoningStartEvent,
          {
            'type': 'REASONING_MESSAGE_START',
            'messageId': 'm',
            'role': 'reasoning',
          }: ReasoningMessageStartEvent,
          {'type': 'REASONING_MESSAGE_CONTENT', 'messageId': 'm', 'delta': 'd'}:
              ReasoningMessageContentEvent,
          {'type': 'REASONING_MESSAGE_END', 'messageId': 'm'}:
              ReasoningMessageEndEvent,
          {'type': 'REASONING_MESSAGE_CHUNK'}: ReasoningMessageChunkEvent,
          {'type': 'REASONING_END', 'messageId': 'm'}: ReasoningEndEvent,
          {
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'message',
            'entityId': 'e',
            'encryptedValue': 'v',
          }: ReasoningEncryptedValueEvent,
        };

        cases.forEach((json, type) {
          final event = BaseEvent.fromJson(json);
          expect(event.runtimeType, type, reason: 'for $json');
        });
      });
    });
  });
}
