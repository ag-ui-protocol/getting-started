import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/encoder/decoder.dart';
import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:ag_ui/src/types/base.dart'; // For AGUIValidationError
import 'package:ag_ui/src/types/message.dart';
import 'package:test/test.dart';

void main() {
  group('Event Decoding Integration', () {
    late EventDecoder decoder;
    late EventStreamAdapter adapter;

    setUp(() {
      decoder = const EventDecoder();
      adapter = EventStreamAdapter();
    });

    group('Python Server Events', () {
      test('decodes RUN_STARTED event from Python server format', () {
        // Python server uses snake_case
        final pythonJson = {
          'type': 'RUN_STARTED',
          'thread_id': 'thread-123',
          'run_id': 'run-456',
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<RunStartedEvent>());

        final runEvent = event as RunStartedEvent;
        expect(runEvent.threadId, equals('thread-123'));
        expect(runEvent.runId, equals('run-456'));
      });

      test('decodes MESSAGES_SNAPSHOT with tool calls from Python server', () {
        // Example from tool_based_generative_ui.py
        final pythonJson = {
          'type': 'MESSAGES_SNAPSHOT',
          'messages': [
            {
              'id': 'msg-1',
              'role': 'user',
              'content': 'Generate a haiku',
            },
            {
              'id': 'msg-2',
              'role': 'assistant',
              'tool_calls': [
                {
                  'id': 'tool-call-1',
                  'type': 'function',
                  'function': {
                    'name': 'generate_haiku',
                    'arguments': jsonEncode({
                      'japanese': ['エーアイの', '橋つなぐ道', 'コパキット'],
                      'english': [
                        'From AI\'s realm',
                        'A bridge-road linking us—',
                        'CopilotKit.',
                      ],
                    }),
                  },
                },
              ],
            },
            {
              'id': 'msg-3',
              'role': 'tool',
              'tool_call_id': 'tool-call-1',
              'content': 'Haiku created',
            },
          ],
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<MessagesSnapshotEvent>());

        final messagesEvent = event as MessagesSnapshotEvent;
        expect(messagesEvent.messages.length, equals(3));

        // Check user message
        expect(messagesEvent.messages[0].role, equals(MessageRole.user));
        expect(messagesEvent.messages[0].content, equals('Generate a haiku'));

        // Check assistant message with tool calls
        expect(messagesEvent.messages[1].role, equals(MessageRole.assistant));
        final assistantMsg = messagesEvent.messages[1] as AssistantMessage;
        expect(assistantMsg.toolCalls, isNotNull);
        expect(assistantMsg.toolCalls!.length, equals(1));
        expect(assistantMsg.toolCalls![0].id, equals('tool-call-1'));
        expect(
            assistantMsg.toolCalls![0].function.name, equals('generate_haiku'));

        // Check tool message
        expect(messagesEvent.messages[2].role, equals(MessageRole.tool));
        final toolMsg = messagesEvent.messages[2] as ToolMessage;
        expect(toolMsg.toolCallId, equals('tool-call-1'));
        expect(toolMsg.content, equals('Haiku created'));
      });

      test('decodes RUN_FINISHED event from Python server', () {
        final pythonJson = {
          'type': 'RUN_FINISHED',
          'thread_id': 'thread-123',
          'run_id': 'run-456',
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<RunFinishedEvent>());

        final runEvent = event as RunFinishedEvent;
        expect(runEvent.threadId, equals('thread-123'));
        expect(runEvent.runId, equals('run-456'));
      });

      test('decodes ACTIVITY_SNAPSHOT event from Python server format', () {
        final pythonJson = {
          'type': 'ACTIVITY_SNAPSHOT',
          'message_id': 'act_001',
          'activity_type': 'task.run',
          'content': {'title': 'Hello', 'progress': 0.25},
          'replace': false,
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<ActivitySnapshotEvent>());

        final activity = event as ActivitySnapshotEvent;
        expect(activity.messageId, equals('act_001'));
        expect(activity.activityType, equals('task.run'));
        expect((activity.content as Map)['title'], equals('Hello'));
        expect(activity.replace, isFalse);
      });

      test('decodes ACTIVITY_DELTA event from Python server format', () {
        final pythonJson = {
          'type': 'ACTIVITY_DELTA',
          'message_id': 'act_001',
          'activity_type': 'task.run',
          'patch': [
            {'op': 'replace', 'path': '/progress', 'value': 0.5},
          ],
        };

        final event = decoder.decodeJson(pythonJson);
        expect(event, isA<ActivityDeltaEvent>());

        final delta = event as ActivityDeltaEvent;
        expect(delta.messageId, equals('act_001'));
        expect(delta.activityType, equals('task.run'));
        expect(delta.patch.length, equals(1));
      });

      test('decodes TEXT_MESSAGE_* events from Python server format', () {
        final start = decoder.decodeJson({
          'type': 'TEXT_MESSAGE_START',
          'message_id': 'm1',
          'role': 'assistant',
        });
        expect(start, isA<TextMessageStartEvent>());
        expect((start as TextMessageStartEvent).messageId, 'm1');

        final content = decoder.decodeJson({
          'type': 'TEXT_MESSAGE_CONTENT',
          'message_id': 'm1',
          'delta': 'hello',
        });
        expect(content, isA<TextMessageContentEvent>());

        final end = decoder.decodeJson({
          'type': 'TEXT_MESSAGE_END',
          'message_id': 'm1',
        });
        expect(end, isA<TextMessageEndEvent>());
      });

      test('decodes TOOL_CALL_* events from Python server format', () {
        final start = decoder.decodeJson({
          'type': 'TOOL_CALL_START',
          'tool_call_id': 'c1',
          'tool_call_name': 'search',
          'parent_message_id': 'm1',
        });
        expect(start, isA<ToolCallStartEvent>());
        expect((start as ToolCallStartEvent).toolCallId, 'c1');
        expect(start.toolCallName, 'search');
        expect(start.parentMessageId, 'm1');

        final args = decoder.decodeJson({
          'type': 'TOOL_CALL_ARGS',
          'tool_call_id': 'c1',
          'delta': '{"q":"x"}',
        });
        expect(args, isA<ToolCallArgsEvent>());

        final end = decoder.decodeJson({
          'type': 'TOOL_CALL_END',
          'tool_call_id': 'c1',
        });
        expect(end, isA<ToolCallEndEvent>());

        final result = decoder.decodeJson({
          'type': 'TOOL_CALL_RESULT',
          'message_id': 'm2',
          'tool_call_id': 'c1',
          'content': 'ok',
          'role': 'tool',
        });
        expect(result, isA<ToolCallResultEvent>());
        final r = result as ToolCallResultEvent;
        expect(r.messageId, 'm2');
        expect(r.toolCallId, 'c1');
      });

      test('decodes REASONING_* events from Python server format', () {
        final start = decoder.decodeJson({
          'type': 'REASONING_START',
          'message_id': 'rsn_001',
        });
        expect(start, isA<ReasoningStartEvent>());
        expect((start as ReasoningStartEvent).messageId, equals('rsn_001'));

        final messageStart = decoder.decodeJson({
          'type': 'REASONING_MESSAGE_START',
          'message_id': 'rsn_001',
          'role': 'reasoning',
        });
        expect(messageStart, isA<ReasoningMessageStartEvent>());

        final content = decoder.decodeJson({
          'type': 'REASONING_MESSAGE_CONTENT',
          'message_id': 'rsn_001',
          'delta': 'thinking...',
        });
        expect(content, isA<ReasoningMessageContentEvent>());
        expect(
          (content as ReasoningMessageContentEvent).delta,
          equals('thinking...'),
        );

        final encrypted = decoder.decodeJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'tool-call',
          'entity_id': 'tc_001',
          'encrypted_value': 'cipher',
        });
        expect(encrypted, isA<ReasoningEncryptedValueEvent>());
        final encEvent = encrypted as ReasoningEncryptedValueEvent;
        expect(encEvent.subtype, ReasoningEncryptedValueSubtype.toolCall);
        expect(encEvent.entityId, equals('tc_001'));
        expect(encEvent.encryptedValue, equals('cipher'));
      });
    });

    group('TypeScript Dojo Events', () {
      test('decodes all text message lifecycle events', () {
        final events = [
          {
            'type': 'TEXT_MESSAGE_START',
            'messageId': 'msg-1',
            'role': 'assistant'
          },
          {
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': 'msg-1',
            'delta': 'Hello '
          },
          {
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': 'msg-1',
            'delta': 'world!'
          },
          {'type': 'TEXT_MESSAGE_END', 'messageId': 'msg-1'},
        ];

        final decodedEvents =
            events.map((json) => decoder.decodeJson(json)).toList();

        expect(decodedEvents[0], isA<TextMessageStartEvent>());
        expect(decodedEvents[1], isA<TextMessageContentEvent>());
        expect(decodedEvents[2], isA<TextMessageContentEvent>());
        expect(decodedEvents[3], isA<TextMessageEndEvent>());

        // Verify content accumulation
        final content1 = (decodedEvents[1] as TextMessageContentEvent).delta;
        final content2 = (decodedEvents[2] as TextMessageContentEvent).delta;
        expect(content1 + content2, equals('Hello world!'));
      });

      test('decodes tool call lifecycle events', () {
        final events = [
          {
            'type': 'TOOL_CALL_START',
            'toolCallId': 'tool-1',
            'toolCallName': 'search',
            'parentMessageId': 'msg-1',
          },
          {
            'type': 'TOOL_CALL_ARGS',
            'toolCallId': 'tool-1',
            'delta': '{"query": "AG-UI protocol"}',
          },
          {
            'type': 'TOOL_CALL_END',
            'toolCallId': 'tool-1',
          },
          {
            'type': 'TOOL_CALL_RESULT',
            'messageId': 'msg-2',
            'toolCallId': 'tool-1',
            'content': 'Found 5 results',
            'role': 'tool',
          },
        ];

        final decodedEvents =
            events.map((json) => decoder.decodeJson(json)).toList();

        expect(decodedEvents[0], isA<ToolCallStartEvent>());
        expect(decodedEvents[1], isA<ToolCallArgsEvent>());
        expect(decodedEvents[2], isA<ToolCallEndEvent>());
        expect(decodedEvents[3], isA<ToolCallResultEvent>());

        // Verify tool call details
        final startEvent = decodedEvents[0] as ToolCallStartEvent;
        expect(startEvent.toolCallName, equals('search'));
        expect(startEvent.parentMessageId, equals('msg-1'));

        final resultEvent = decodedEvents[3] as ToolCallResultEvent;
        expect(resultEvent.content, equals('Found 5 results'));
        expect(resultEvent.role, equals(ToolCallResultRole.tool));
      });

      test('decodes thinking events', () {
        final events = [
          {'type': 'THINKING_START', 'title': 'Planning approach'},
          {'type': 'THINKING_TEXT_MESSAGE_START'},
          {'type': 'THINKING_TEXT_MESSAGE_CONTENT', 'delta': 'Let me think...'},
          {'type': 'THINKING_TEXT_MESSAGE_END'},
          {'type': 'THINKING_END'},
        ];

        final decodedEvents =
            events.map((json) => decoder.decodeJson(json)).toList();

        expect(decodedEvents[0], isA<ThinkingStartEvent>());
        expect((decodedEvents[0] as ThinkingStartEvent).title,
            equals('Planning approach'));
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[1], isA<ThinkingTextMessageStartEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[2], isA<ThinkingTextMessageContentEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[3], isA<ThinkingTextMessageEndEvent>());
        expect(decodedEvents[4], isA<ThinkingEndEvent>());
      });

      test('decodes state management events', () {
        final stateSnapshot = {
          'type': 'STATE_SNAPSHOT',
          'snapshot': {
            'counter': 0,
            'users': ['alice', 'bob'],
            'settings': {'theme': 'dark', 'notifications': true},
          },
        };

        final stateDelta = {
          'type': 'STATE_DELTA',
          'delta': [
            {'op': 'replace', 'path': '/counter', 'value': 1},
            {'op': 'add', 'path': '/users/-', 'value': 'charlie'},
          ],
        };

        final snapshotEvent = decoder.decodeJson(stateSnapshot);
        expect(snapshotEvent, isA<StateSnapshotEvent>());
        final snapshot = (snapshotEvent as StateSnapshotEvent).snapshot;
        expect(snapshot['counter'], equals(0));
        expect(snapshot['users'], equals(['alice', 'bob']));

        final deltaEvent = decoder.decodeJson(stateDelta);
        expect(deltaEvent, isA<StateDeltaEvent>());
        final delta = (deltaEvent as StateDeltaEvent).delta;
        expect(delta.length, equals(2));
        expect(delta[0]['op'], equals('replace'));
        expect(delta[1]['op'], equals('add'));
      });

      test('decodes step events', () {
        final events = [
          {'type': 'STEP_STARTED', 'stepName': 'Analyzing request'},
          {'type': 'STEP_FINISHED', 'stepName': 'Analyzing request'},
        ];

        final decodedEvents =
            events.map((json) => decoder.decodeJson(json)).toList();

        expect(decodedEvents[0], isA<StepStartedEvent>());
        expect((decodedEvents[0] as StepStartedEvent).stepName,
            equals('Analyzing request'));
        expect(decodedEvents[1], isA<StepFinishedEvent>());
        expect((decodedEvents[1] as StepFinishedEvent).stepName,
            equals('Analyzing request'));
      });
    });

    group('Stream Processing', () {
      test('processes SSE stream with mixed events', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Simulate server stream
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({
            'type': 'TEXT_MESSAGE_START',
            'messageId': 'm1',
            'role': 'assistant'
          }),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': 'm1',
            'delta': 'Hello'
          }),
        ));
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_END', 'messageId': 'm1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));

        await sseController.close();
        await subscription.cancel();

        expect(events.length, equals(5));
        expect(events.first, isA<RunStartedEvent>());
        expect(events.last, isA<RunFinishedEvent>());
      });

      test('handles malformed events gracefully', () async {
        final sseController = StreamController<SseMessage>();
        final errors = <Object>[];
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => errors.add(error),
        );

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Mix valid and invalid events
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(data: 'not json')); // Invalid
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'INVALID_TYPE'}), // Unknown type
        ));
        sseController.add(SseMessage(
          // Invalid: missing required `messageId`. (Empty `delta` is now
          // accepted per canonical TS/Python parity, so it can no longer
          // serve as the invalid-event trigger here.)
          data: jsonEncode({'type': 'TEXT_MESSAGE_CONTENT', 'delta': 'x'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));

        await sseController.close();
        await subscription.cancel();

        // Should only get valid events
        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());

        // Should have collected errors for invalid events
        expect(errors.length, equals(3));
        expect(errors[0], isA<DecodingError>());
        expect(errors[1], isA<DecodingError>());
        expect(errors[2],
            isA<DecodingError>()); // Validation errors are wrapped in DecodingError
      });

      test('handles unknown fields for forward compatibility', () {
        // Events with extra fields should still decode
        final jsonWithExtra = {
          'type': 'TEXT_MESSAGE_START',
          'messageId': 'msg-1',
          'role': 'assistant',
          'futureField': 'some value', // Unknown field
          'metadata': {'key': 'value'}, // Unknown field
        };

        final event = decoder.decodeJson(jsonWithExtra);
        expect(event, isA<TextMessageStartEvent>());

        final textEvent = event as TextMessageStartEvent;
        expect(textEvent.messageId, equals('msg-1'));
        expect(textEvent.role, equals(TextMessageRole.assistant));
        // Unknown top-level fields are tolerated and ignored — the SDK
        // does NOT preserve them on `rawEvent` (only `json['rawEvent']`
        // populates that field). Re-encoding via `toJson` will drop
        // `futureField` / `metadata`. If forward-preserve becomes a
        // requirement, see the `BaseEvent.fromJson` factory.
      });

      test('validates required fields strictly', () {
        // Missing required field
        expect(
          () => decoder.decodeJson({'type': 'TEXT_MESSAGE_START'}),
          throwsA(isA<DecodingError>()),
        );

        // Empty `messageId` (still a contract violation post-0.2.0
        // parity work — empty `delta` is now accepted to match
        // canonical TS/Python schemas, but identifiers must be
        // non-empty). Validation error is wrapped in DecodingError.
        expect(
          () => decoder.decodeJson({
            'type': 'TEXT_MESSAGE_CONTENT',
            'messageId': '',
            'delta': 'x',
          }),
          throwsA(isA<DecodingError>()),
        );

        // Invalid event type — surfaces as DecodingError through the
        // decoder boundary. The direct factory path (no decoder) sees
        // an `AGUIValidationError` instead; see the companion test in
        // `test/events/event_test.dart` ("should throw AGUIValidationError
        // on invalid event type"). The two together pin down both seams.
        expect(
          () => decoder.decodeJson({'type': 'NOT_A_REAL_EVENT'}),
          throwsA(isA<DecodingError>()),
        );

        // The wrapped `DecodingError.field` must preserve the original
        // failing field name from `AGUIValidationError`, not collapse to
        // `'json'`. Pin the contract on at least one factory-side
        // failure so a future refactor can't silently regress.
        expect(
          () => decoder.decodeJson({
            'type': 'REASONING_MESSAGE_START',
            'messageId': 'msg-1',
            // role intentionally omitted — required since 0.2.0
          }),
          throwsA(
            isA<DecodingError>().having((e) => e.field, 'field', 'role'),
          ),
        );

        // TEXT_MESSAGE_END with empty messageId must fail at the
        // decoder boundary, matching TEXT_MESSAGE_START / _CONTENT.
        expect(
          () => decoder.decodeJson({
            'type': 'TEXT_MESSAGE_END',
            'messageId': '',
          }),
          throwsA(isA<DecodingError>()),
        );
      });

      test(
          'EventDecoder.validate rejects empty required identifiers across '
          'tool, run, step, activity, and reasoning events', () {
        // These cases lock in the boundary contract documented on
        // `EventDecoder.validate`: identifiers that pass the
        // presence/type check in `fromJson` must still be rejected here
        // when they arrive empty from the wire. Adding a new empty-id
        // event class without a `validate` case will fail this test.
        final emptyIdPayloads = <Map<String, dynamic>>[
          {'type': 'TOOL_CALL_ARGS', 'toolCallId': '', 'delta': 'x'},
          // NOTE: empty `delta` on TOOL_CALL_ARGS is now accepted per
          // canonical TS/Python parity; only empty `toolCallId` is
          // still a contract violation.
          {'type': 'TOOL_CALL_END', 'toolCallId': ''},
          {
            'type': 'TOOL_CALL_RESULT',
            'messageId': '',
            'toolCallId': 'c',
            'content': 'x',
          },
          {
            'type': 'TOOL_CALL_RESULT',
            'messageId': 'm',
            'toolCallId': '',
            'content': 'x',
          },
          // NOTE: empty `content` on TOOL_CALL_RESULT is now accepted
          // per canonical TS/Python parity.
          {'type': 'RUN_FINISHED', 'threadId': '', 'runId': 'r'},
          {'type': 'RUN_FINISHED', 'threadId': 't', 'runId': ''},
          {'type': 'RUN_ERROR', 'message': ''},
          {'type': 'STEP_STARTED', 'stepName': ''},
          {'type': 'STEP_FINISHED', 'stepName': ''},
          {'type': 'CUSTOM', 'name': '', 'value': 1},
          // Activity events — empty messageId or activityType.
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': '',
            'activityType': 't',
            'content': null,
          },
          {
            'type': 'ACTIVITY_SNAPSHOT',
            'messageId': 'm',
            'activityType': '',
            'content': null,
          },
          {
            'type': 'ACTIVITY_DELTA',
            'messageId': '',
            'activityType': 't',
            'patch': <dynamic>[],
          },
          {
            'type': 'ACTIVITY_DELTA',
            'messageId': 'm',
            'activityType': '',
            'patch': <dynamic>[],
          },
          // Reasoning events — empty messageId is still a contract
          // violation. Empty `delta` on REASONING_MESSAGE_CONTENT is now
          // accepted per canonical parity. Empty `entityId` /
          // `encryptedValue` on REASONING_ENCRYPTED_VALUE are also
          // accepted (canonical TS `z.string()` / Python `str` impose
          // no minimum length); only the strict subtype discriminator
          // remains.
          {'type': 'REASONING_START', 'messageId': ''},
          {
            'type': 'REASONING_MESSAGE_START',
            'messageId': '',
            'role': 'reasoning',
          },
          {
            'type': 'REASONING_MESSAGE_CONTENT',
            'messageId': '',
            'delta': 'd',
          },
          {'type': 'REASONING_MESSAGE_END', 'messageId': ''},
          {'type': 'REASONING_END', 'messageId': ''},
        ];

        for (final payload in emptyIdPayloads) {
          expect(
            () => decoder.decodeJson(payload),
            throwsA(isA<DecodingError>()),
            reason: 'expected DecodingError for $payload',
          );
        }
      });

      test(
          'REASONING_ENCRYPTED_VALUE with unknown subtype surfaces as '
          'DecodingError', () {
        // The dartdoc on `ReasoningEncryptedValueEvent` and on
        // `ReasoningEncryptedValueSubtype.fromString` documents that
        // an unknown subtype value MUST fail decoding (mis-tagging an
        // encrypted payload is worse than dropping it). This locks in
        // the wire→DecodingError contract end-to-end.
        expect(
          () => decoder.decodeJson({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'future-mode',
            'entityId': 'e',
            'encryptedValue': 'v',
          }),
          throwsA(isA<DecodingError>()),
        );
      });

      test(
          'REASONING_ENCRYPTED_VALUE unknown subtype is skipped under '
          'skipInvalidEvents (forward-compat opt-in)', () async {
        // Companion to the test above: with per-event recovery enabled
        // on the stream adapter, the malformed event is skipped and
        // surrounding events still flow. The dartdoc on
        // `ReasoningEncryptedValueEvent` promises this opt-in.
        final controller = StreamController<SseMessage>();
        final stream = adapter.fromSseStream(
          controller.stream,
          skipInvalidEvents: true,
        );
        final events = <BaseEvent>[];
        final sub = stream.listen(events.add);

        controller.add(SseMessage(
          data: jsonEncode({
            'type': 'REASONING_START',
            'messageId': 'rsn',
          }),
        ));
        controller.add(SseMessage(
          data: jsonEncode({
            'type': 'REASONING_ENCRYPTED_VALUE',
            'subtype': 'future-mode',
            'entityId': 'e',
            'encryptedValue': 'v',
          }),
        ));
        controller.add(SseMessage(
          data: jsonEncode({
            'type': 'REASONING_END',
            'messageId': 'rsn',
          }),
        ));

        await controller.close();
        await sub.cancel();

        expect(events.length, 2);
        expect(events[0], isA<ReasoningStartEvent>());
        expect(events[1], isA<ReasoningEndEvent>());
      });

      test(
          'EventDecoder.decodeJson rejects state/raw/custom events missing '
          'their required value field', () {
        // `StateSnapshotEvent.snapshot`, `RawEvent.event`, and
        // `CustomEvent.value` accept any JSON shape (including null) but
        // the field MUST be present. Distinguishing missing-key from
        // explicit-null is the whole point of these checks.
        expect(
          () => decoder.decodeJson({'type': 'STATE_SNAPSHOT'}),
          throwsA(isA<DecodingError>()),
        );
        expect(
          () => decoder.decodeJson({'type': 'RAW'}),
          throwsA(isA<DecodingError>()),
        );
        expect(
          () => decoder.decodeJson({'type': 'CUSTOM', 'name': 'n'}),
          throwsA(isA<DecodingError>()),
        );

        // Explicit-null should be accepted (round-trips a present-but-null
        // payload — see the matching note in the fromJson factories).
        expect(
          () => decoder.decodeJson({
            'type': 'STATE_SNAPSHOT',
            'snapshot': null,
          }),
          returnsNormally,
        );
        expect(
          () => decoder.decodeJson({
            'type': 'CUSTOM',
            'name': 'n',
            'value': null,
          }),
          returnsNormally,
        );
      });
    });

    group('Error Recovery', () {
      test('continues processing after encountering errors', () async {
        final rawController = StreamController<String>();
        final errors = <Object>[];
        final eventStream = adapter.fromRawSseStream(
          rawController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => errors.add(error),
        );

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Send a mix of valid and invalid SSE data
        rawController.add(
            'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\n\n');
        rawController.add('data: {broken json\n\n'); // Invalid JSON
        rawController
            .add('data: {"type":"TEXT_MESSAGE_START","messageId":"m1"}\n\n');
        rawController.add('data: : \n\n'); // SSE comment/keepalive
        rawController
            .add('data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\n\n');

        await rawController.close();
        await subscription.cancel();

        // Should process valid events and skip invalid ones
        expect(events.length, equals(3));
        expect(errors.length, equals(1)); // Only the broken JSON
      });

      test('preserves event order despite errors', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
        );

        final eventTypes = <String>[];
        final subscription = eventStream.listen((event) {
          eventTypes.add(event.eventType.value);
        });

        // Send events in specific order with errors in between
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_STARTED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));
        sseController.add(SseMessage(data: 'invalid')); // Error - skipped
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_START', 'messageId': 'm1'}),
        ));
        sseController
            .add(SseMessage(data: '{"type": "UNKNOWN"}')); // Error - skipped
        sseController.add(SseMessage(
          data: jsonEncode({'type': 'TEXT_MESSAGE_END', 'messageId': 'm1'}),
        ));
        sseController.add(SseMessage(
          data: jsonEncode(
              {'type': 'RUN_FINISHED', 'thread_id': 't1', 'run_id': 'r1'}),
        ));

        await sseController.close();
        await subscription.cancel();

        // Order should be preserved for valid events
        expect(
            eventTypes,
            equals([
              'RUN_STARTED',
              'TEXT_MESSAGE_START',
              'TEXT_MESSAGE_END',
              'RUN_FINISHED',
            ]));
      });

      test(
          'fromRawSseStream emits events from a CRLF-encoded stream before '
          'close (regression: line-splitter CRLF handling)', () async {
        // The WHATWG SSE spec permits CRLF, lone LF, and lone CR line
        // terminators. Before the CRLF fix, `fromRawSseStream` split
        // only on `\n`, leaving each line ending in `\r` — the
        // `line.isEmpty` event-boundary check never fired and events
        // buffered until stream close. This test asserts the steady-
        // state path: events MUST be emitted before
        // `rawController.close()` even on CRLF input. See
        // `sse-protocol-parsing-edge-cases.md`.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add(
          'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\r\n\r\n',
        );
        rawController.add(
          'data: {"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}\r\n\r\n',
        );
        rawController.add(
          'data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\r\n\r\n',
        );

        // Allow the microtask queue to drain so the line buffer
        // processes everything BEFORE we close the stream.
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        // Pre-close assertion: events must already be flowing.
        expect(
          events.length,
          equals(3),
          reason: 'CRLF input must be parsed in steady state, not buffered '
              'until stream close',
        );

        await rawController.close();
        await subscription.cancel();

        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<TextMessageStartEvent>());
        expect(events[2], isA<TextMessageEndEvent>());
      });

      test('fromRawSseStream handles mixed LF and CRLF in the same stream',
          () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Mix of pure-LF and CRLF event terminators.
        rawController.add(
          'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\n\n',
        );
        rawController.add(
          'data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\r\n\r\n',
        );

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<TextMessageEndEvent>());
      });

      test(
          'fromRawSseStream emits events from a lone-CR-encoded stream '
          '(WHATWG spec: \\r is a valid line terminator)', () async {
        // Companion to the CRLF regression at lines 822-868. The WHATWG SSE
        // spec permits CRLF, lone LF, and lone CR terminators. Pre-fix,
        // `fromRawSseStream` only split on `\n`, so a producer using bare
        // `\r` (rare in practice but spec-valid) buffered indefinitely.
        // The post-fix multi-terminator scanner consumes lone `\r` in
        // steady state, with the trailing-`\r` deferral preserving correct
        // chunk-spanning `\r\n` handling.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add(
          'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\r\r',
        );
        rawController.add(
          'data: {"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}\r\r',
        );
        rawController.add(
          'data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\r\r',
        );

        // Drain microtasks before close to verify steady-state, not
        // flush-on-close. Same pattern as the CRLF test above.
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        expect(
          events.length,
          equals(3),
          reason: 'Lone-CR input must be parsed in steady state, not buffered '
              'until stream close',
        );

        await rawController.close();
        await subscription.cancel();

        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<TextMessageStartEvent>());
        expect(events[2], isA<TextMessageEndEvent>());
      });

      test(
          'fromRawSseStream correctly disambiguates chunk-spanning \\r\\n '
          'from lone \\r + lone \\n', () async {
        // The trailing-`\r` deferral guarantees that a CRLF split across
        // two chunks (chunk1 ends with `\r`, chunk2 starts with `\n`) is
        // treated as a single CRLF terminator, not two separate lone
        // terminators. Without the deferral, the empty-line dispatch would
        // double-fire and the SSE event boundary would be mis-detected.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Split the CRLF terminators so each spans two chunks.
        rawController.add(
          'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\r',
        );
        rawController.add('\n\r');
        rawController.add(
          '\ndata: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}\r\n\r\n',
        );

        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test(
          'fromRawSseStream handles per-line-chunked lone-CR producer without '
          'extra RTT (lastWasLoneCr persists across chunks)', () async {
        // Regression for Important #II2: when a producer uses lone-CR
        // terminators and delivers each `\r` in its own chunk, the
        // `lastWasLoneCr` flag must survive across processChunk calls.
        // Without persistence the trailing-`\r` deferral misfired on every
        // event, delaying dispatch by one chunk-RTT each time.
        //
        // Stream shape: each data line ends with `\r`, each event boundary
        // is a lone `\r`, and each `\r` arrives in a separate chunk.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Event 1: RUN_STARTED — data line `\r` then boundary `\r`, each
        // in its own chunk.
        rawController.add(
          'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}',
        );
        rawController.add('\r'); // data-line terminator
        rawController.add('\r'); // event-boundary terminator

        // Event 2: RUN_FINISHED
        rawController.add(
          'data: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}',
        );
        rawController.add('\r');
        rawController.add('\r');

        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2),
            reason: 'Both events must be emitted without stalling');
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test('decodeSSE handles CRLF terminators (LineSplitter-based)', () {
        // The single-message `decodeSSE` API mirrors the streaming
        // parser: a `data: ...\r\n\r\n` payload must decode the same as
        // a `data: ...\n\n` payload, with no stray `\r` corrupting the
        // joined value.
        final crlfMessage =
            'data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}\r\n\r\n';
        final event = decoder.decodeSSE(crlfMessage);
        expect(event, isA<TextMessageEndEvent>());
        expect((event as TextMessageEndEvent).messageId, equals('m1'));
      });
    });
  });
}
