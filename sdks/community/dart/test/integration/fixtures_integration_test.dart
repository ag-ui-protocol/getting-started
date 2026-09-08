import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ag_ui/src/encoder/decoder.dart';
import 'package:ag_ui/src/encoder/encoder.dart';
import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_parser.dart';
import 'package:ag_ui/src/types/message.dart';
import 'package:test/test.dart';

void main() {
  group('Fixtures Integration Tests', () {
    late EventDecoder decoder;
    late EventEncoder encoder;
    late EventStreamAdapter adapter;
    late SseParser parser;

    setUp(() {
      decoder = const EventDecoder();
      encoder = EventEncoder();
      adapter = EventStreamAdapter();
      parser = SseParser();
    });

    group('JSON Fixtures', () {
      late Map<String, dynamic> fixtures;

      setUpAll(() async {
        final fixtureFile = File('test/fixtures/events.json');
        final content = await fixtureFile.readAsString();
        fixtures = json.decode(content) as Map<String, dynamic>;
      });

      test('processes simple text message sequence', () {
        final events = fixtures['simple_text_message'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        expect(decodedEvents.length, equals(6));
        expect(decodedEvents[0], isA<RunStartedEvent>());
        expect(decodedEvents[1], isA<TextMessageStartEvent>());
        expect(decodedEvents[2], isA<TextMessageContentEvent>());
        expect(decodedEvents[3], isA<TextMessageContentEvent>());
        expect(decodedEvents[4], isA<TextMessageEndEvent>());
        expect(decodedEvents[5], isA<RunFinishedEvent>());

        // Verify content accumulation
        final content1 = (decodedEvents[2] as TextMessageContentEvent).delta;
        final content2 = (decodedEvents[3] as TextMessageContentEvent).delta;
        expect(
            '$content1$content2', equals('Hello, how can I help you today?'));
      });

      test('processes tool call sequence', () {
        final events = fixtures['tool_call_sequence'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        expect(decodedEvents.length, equals(12));

        // Find tool call events
        final toolStart = decodedEvents.whereType<ToolCallStartEvent>().first;
        expect(toolStart.toolCallName, equals('search'));
        expect(toolStart.parentMessageId, equals('msg_02'));

        final toolArgs = decodedEvents.whereType<ToolCallArgsEvent>().first;
        expect(toolArgs.delta, contains('AG-UI protocol'));

        final toolResult = decodedEvents.whereType<ToolCallResultEvent>().first;
        expect(toolResult.content, contains('event-based protocol'));
      });

      test('processes state management events', () {
        final events = fixtures['state_management'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        // Find state events
        final snapshot = decodedEvents.whereType<StateSnapshotEvent>().first;
        expect(snapshot.snapshot['count'], equals(0));
        expect(snapshot.snapshot['user']['name'], equals('Alice'));

        final delta = decodedEvents.whereType<StateDeltaEvent>().first;
        expect(delta.delta.length, equals(2));
        expect(delta.delta[0]['op'], equals('replace'));
        expect(delta.delta[0]['path'], equals('/count'));
        expect(delta.delta[0]['value'], equals(1));
      });

      test('processes messages snapshot', () {
        final events = fixtures['messages_snapshot'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final snapshot = decodedEvents
            .whereType<MessagesSnapshotEvent>()
            .first;
        expect(snapshot.messages.length, equals(4));

        // Check message types
        expect(snapshot.messages[0], isA<UserMessage>());
        expect(snapshot.messages[1], isA<AssistantMessage>());
        expect(snapshot.messages[2], isA<ToolMessage>());
        expect(snapshot.messages[3], isA<UserMessage>());

        // Check assistant message has tool calls
        final assistantMsg = snapshot.messages[1] as AssistantMessage;
        expect(assistantMsg.toolCalls, isNotNull);
        expect(assistantMsg.toolCalls!.length, equals(1));
        expect(assistantMsg.toolCalls![0].function.name, equals('get_weather'));

        // The multimodal user message decodes end-to-end into typed parts.
        final multimodalMsg = snapshot.messages[3] as UserMessage;
        final body = multimodalMsg.messageContent;
        expect(body, isA<MultimodalContent>());
        final parts = (body as MultimodalContent).parts;
        expect(parts.length, equals(2));
        expect(parts[0], isA<TextInputContent>());
        expect((parts[0] as TextInputContent).text, equals('Describe this image'));
        expect(parts[1], isA<ImageInputContent>());
        expect((parts[1] as ImageInputContent).source, isA<UrlSource>());
        // Plain-text projection getter is null for multimodal content.
        expect(multimodalMsg.content, isNull);
      });

      test('processes messages snapshot with activity and reasoning roles', () {
        final events = fixtures['messages_snapshot_activity_reasoning'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final snapshot = decodedEvents.whereType<MessagesSnapshotEvent>().first;
        expect(snapshot.messages.length, equals(4));

        expect(snapshot.messages[0], isA<UserMessage>());
        expect(snapshot.messages[1], isA<ActivityMessage>());
        expect(snapshot.messages[2], isA<ReasoningMessage>());
        expect(snapshot.messages[3], isA<AssistantMessage>());

        final activity = snapshot.messages[1] as ActivityMessage;
        expect(activity.activityType, equals('task.run'));
        expect(activity.activityContent['title'], equals('Indexing files'));
        expect(activity.activityContent['progress'], equals(0.5));

        final reasoning = snapshot.messages[2] as ReasoningMessage;
        expect(reasoning.content, contains('Considering'));
        expect(
            reasoning.encryptedValue, equals('ZW5jcnlwdGVkLXJlYXNvbmluZw=='));

        // Cross-SDK parity: AssistantMessage carries encryptedValue from
        // the canonical BaseMessageSchema. Closes the silent-drop bug
        // documented in the #1018 review.
        final assistant = snapshot.messages[3] as AssistantMessage;
        expect(
            assistant.encryptedValue, equals('ZW5jcnlwdGVkLWFzc2lzdGFudA=='));

        // Round-trip the snapshot through the encoder boundary so
        // toJson()/fromJson() symmetry is exercised end-to-end for the
        // new Message subtypes, not just at the factory level.
        final reEncoded = MessagesSnapshotEvent.fromJson(snapshot.toJson());
        expect(reEncoded.messages.length, equals(4));
        expect(reEncoded.messages[1], isA<ActivityMessage>());
        expect(reEncoded.messages[2], isA<ReasoningMessage>());
        expect(
          (reEncoded.messages[1] as ActivityMessage).activityContent['title'],
          equals('Indexing files'),
        );
        expect(
          (reEncoded.messages[2] as ReasoningMessage).encryptedValue,
          equals('ZW5jcnlwdGVkLXJlYXNvbmluZw=='),
        );
        expect(
          (reEncoded.messages[3] as AssistantMessage).encryptedValue,
          equals('ZW5jcnlwdGVkLWFzc2lzdGFudA=='),
        );
      });

      test('processes multiple sequential runs', () {
        final events = fixtures['multiple_runs'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        // Count run lifecycle events
        final runStarts = decodedEvents.whereType<RunStartedEvent>().toList();
        final runEnds = decodedEvents.whereType<RunFinishedEvent>().toList();

        expect(runStarts.length, equals(2));
        expect(runEnds.length, equals(2));

        // Verify different run IDs
        expect(runStarts[0].runId, equals('run_05'));
        expect(runStarts[1].runId, equals('run_06'));

        // Verify same thread ID
        expect(runStarts[0].threadId, equals(runStarts[1].threadId));
      });

      test('processes thinking events', () {
        final events = fixtures['thinking_events'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final thinkingStart =
            decodedEvents.whereType<ThinkingStartEvent>().first;
        expect(thinkingStart.title, equals('Analyzing request'));

        // Decoding still emits the (deprecated) ThinkingContentEvent for
        // backward compatibility until removal. See [ThinkingContentEvent].
        // ignore: deprecated_member_use_from_same_package
        final thinkingEvents = decodedEvents
            // ignore: deprecated_member_use_from_same_package
            .whereType<ThinkingContentEvent>()
            .toList();
        expect(thinkingEvents.length, equals(2));

        // Extract delta from the events
        final fullContent = thinkingEvents.map((e) => e.delta).join();
        expect(fullContent, contains('Let me think about this'));
        expect(fullContent, contains('The user is asking about'));
      });

      test('processes step events', () {
        final events = fixtures['step_events'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final stepStarts = decodedEvents.whereType<StepStartedEvent>().toList();
        expect(stepStarts.length, equals(2));
        expect(stepStarts[0].stepName, equals('Initialize'));
        expect(stepStarts[1].stepName, equals('Process'));

        final stepEnds = decodedEvents.whereType<StepFinishedEvent>().toList();
        expect(stepEnds.length, equals(2));
        expect(stepEnds[0].stepName, equals('Initialize'));
        expect(stepEnds[1].stepName, equals('Process'));
      });

      test('processes error handling events', () {
        final events = fixtures['error_handling'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final errorEvent = decodedEvents.whereType<RunErrorEvent>().first;
        // RunErrorEvent has message and code properties
        expect(errorEvent.message, equals('Connection timeout'));
        expect(errorEvent.code, equals('TIMEOUT'));
      });

      test('processes custom events', () {
        final events = fixtures['custom_events'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final customEvent = decodedEvents.whereType<CustomEvent>().first;
        expect(customEvent.name, equals('user_feedback'));
        expect(customEvent.value['rating'], equals(5));

        final rawEvent = decodedEvents.whereType<RawEvent>().first;
        expect(rawEvent.event['customType'], equals('metrics'));
        expect(rawEvent.event['data']['latency'], equals(123));
      });

      test('processes concurrent messages', () {
        final events = fixtures['concurrent_messages'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        // Track message IDs and their content
        final messageContents = <String, List<String>>{};

        for (final event in decodedEvents) {
          if (event is TextMessageStartEvent) {
            messageContents[event.messageId] = [];
          } else if (event is TextMessageContentEvent) {
            messageContents[event.messageId]?.add(event.delta);
          }
        }

        expect(messageContents['msg_14']?.join(), equals('First message'));
        expect(messageContents['msg_15']?.join(),
            equals('System message continues...'));
      });

      test('processes text message chunk events', () {
        final events = fixtures['text_message_chunk'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final chunkEvent =
            decodedEvents.whereType<TextMessageChunkEvent>().first;
        expect(chunkEvent.messageId, equals('msg_16'));
        expect(chunkEvent.role, equals(TextMessageRole.assistant));
        expect(chunkEvent.delta, equals('Complete message in a single chunk'));
      });

      test('processes activity events', () {
        final events = fixtures['activity_events'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        final snapshot = decodedEvents.whereType<ActivitySnapshotEvent>().first;
        expect(snapshot.messageId, equals('act_01'));
        expect(snapshot.activityType, equals('task.run'));
        expect(snapshot.replace, isTrue);
        expect((snapshot.content as Map)['title'], equals('Indexing files'));

        final deltas = decodedEvents.whereType<ActivityDeltaEvent>().toList();
        expect(deltas.length, equals(2));
        expect(deltas[0].patch.length, equals(2));
        expect(deltas[0].patch[0]['op'], equals('replace'));
        expect(deltas[1].patch[0]['value'], equals(1.0));
      });

      test('processes reasoning events', () {
        final events = fixtures['reasoning_events'] as List;
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        expect(
          decodedEvents.whereType<ReasoningStartEvent>().length,
          equals(1),
        );
        expect(
          decodedEvents.whereType<ReasoningMessageStartEvent>().single.role,
          equals(ReasoningMessageRole.reasoning),
        );

        final content =
            decodedEvents.whereType<ReasoningMessageContentEvent>().single;
        expect(content.delta, contains('Analyzing'));

        final chunk =
            decodedEvents.whereType<ReasoningMessageChunkEvent>().single;
        expect(chunk.delta, contains('considering options'));

        final encrypted =
            decodedEvents.whereType<ReasoningEncryptedValueEvent>().single;
        expect(
          encrypted.subtype,
          equals(ReasoningEncryptedValueSubtype.message),
        );
        expect(encrypted.entityId, equals('rsn_01'));
        expect(encrypted.encryptedValue, isNotEmpty);

        expect(
          decodedEvents.whereType<ReasoningEndEvent>().length,
          equals(1),
        );
      });

      // TODO(1.0.0): Delete this fixture group alongside the
      // THINKING_TEXT_MESSAGE_* deprecation sweep.
      test('processes deprecated thinking_text_message_legacy events', () {
        final events = fixtures['thinking_text_message_legacy'] as List;
        // ignore: deprecated_member_use_from_same_package
        final decodedEvents = events
            .map((e) => decoder.decodeJson(e as Map<String, dynamic>))
            .toList();

        expect(decodedEvents[0], isA<RunStartedEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[1], isA<ThinkingTextMessageStartEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[2], isA<ThinkingTextMessageContentEvent>());
        // ignore: deprecated_member_use_from_same_package
        expect((decodedEvents[2] as ThinkingTextMessageContentEvent).delta,
            equals('Let me think...'));
        // ignore: deprecated_member_use_from_same_package
        expect(decodedEvents[3], isA<ThinkingTextMessageEndEvent>());
        expect(decodedEvents[4], isA<RunFinishedEvent>());
      });
    });

    group('SSE Stream Fixtures', () {
      late String sseFixtures;

      setUpAll(() async {
        final fixtureFile = File('test/fixtures/sse_streams.txt');
        sseFixtures = await fixtureFile.readAsString();
      });

      test('parses simple text message SSE stream', () async {
        final section =
            _extractSection(sseFixtures, 'Simple Text Message Stream');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();

        // Filter out empty messages
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();

        expect(dataMessages.length, equals(6));

        // Decode and verify events
        for (final message in dataMessages) {
          final event = decoder.decode(message.data!);
          expect(event, isA<BaseEvent>());
        }
      });

      test('parses tool call SSE stream', () async {
        final section = _extractSection(sseFixtures, 'Tool Call Stream');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();

        expect(dataMessages.length, equals(6));

        // Verify tool call args are split across messages
        final toolArgsMessages = dataMessages
            .where((m) => m.data!.contains('TOOL_CALL_ARGS'))
            .toList();
        expect(toolArgsMessages.length, equals(2));
      });

      test('handles heartbeat and comments', () async {
        final section = _extractSection(sseFixtures, 'Heartbeat and Comments');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();

        // Comments should be ignored, only data messages processed
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();
        expect(dataMessages.length, equals(5));
      });

      test('parses multi-line data fields', () async {
        final section = _extractSection(sseFixtures, 'Multi-line Data Fields');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();

        // Multi-line data should be concatenated
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();
        expect(dataMessages.length, equals(1));

        final concatenatedData = dataMessages[0].data!;
        expect(concatenatedData, contains('STATE_SNAPSHOT'));
        expect(concatenatedData, contains('"count":42'));
      });

      test('handles event IDs and retry', () async {
        final section =
            _extractSection(sseFixtures, 'With Event IDs and Retry');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();

        expect(dataMessages.length, equals(3));
        expect(dataMessages[0].id, equals('evt_001'));
        expect(dataMessages[0].event, equals('message'));
        expect(dataMessages[0].retry, equals(Duration(milliseconds: 5000)));

        // ID should be preserved across messages
        expect(dataMessages[1].id, equals('evt_002'));
        expect(dataMessages[2].id, equals('evt_003'));
      });

      test('handles malformed SSE gracefully', () async {
        final section = _extractSection(sseFixtures, 'Malformed Examples');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();

        // Some messages will fail to decode but should still be captured
        for (final message in dataMessages) {
          if (message.data == 'not valid json') {
            // This should fail decoding
            expect(
                () => decoder.decode(message.data!), throwsA(isA<Exception>()));
          } else if (message.data == '{"incomplete":') {
            // This is incomplete JSON
            expect(
                () => decoder.decode(message.data!), throwsA(isA<Exception>()));
          } else if (message.data!.isNotEmpty && message.data != '') {
            // Try to decode other messages
            try {
              decoder.decode(message.data!);
            } catch (e) {
              // Expected for malformed data
            }
          }
        }
      });

      test('handles unicode and special characters', () async {
        final section =
            _extractSection(sseFixtures, 'Unicode and Special Characters');
        final lines = section.split('\n');

        final messages =
            await parser.parseLines(Stream.fromIterable(lines)).toList();
        final dataMessages = messages
            .where((m) => m.data != null && m.data!.isNotEmpty)
            .toList();

        expect(dataMessages.length, equals(4));

        // Decode and verify unicode content
        final events =
            dataMessages.map((m) => decoder.decode(m.data!)).toList();

        final contentEvents =
            events.whereType<TextMessageContentEvent>().toList();
        expect(contentEvents[0].delta, contains('你好'));
        expect(contentEvents[0].delta, contains('🌟'));
        expect(contentEvents[0].delta, contains('€'));
        expect(contentEvents[1].delta, contains('"quotes"'));
        expect(contentEvents[1].delta, contains('\\backslash\\'));
      });
    });

    group('Round-trip Encoding/Decoding', () {
      test('events survive encoding and decoding', () {
        final originalEvents = [
          RunStartedEvent(threadId: 'thread_01', runId: 'run_01'),
          TextMessageStartEvent(
              messageId: 'msg_01', role: TextMessageRole.assistant),
          TextMessageContentEvent(messageId: 'msg_01', delta: 'Hello, world!'),
          TextMessageEndEvent(messageId: 'msg_01'),
          ToolCallStartEvent(
            toolCallId: 'tool_01',
            toolCallName: 'search',
            parentMessageId: 'msg_01',
          ),
          ToolCallArgsEvent(toolCallId: 'tool_01', delta: '{"query": "test"}'),
          ToolCallEndEvent(toolCallId: 'tool_01'),
          StateSnapshotEvent(snapshot: {
            'count': 42,
            'items': ['a', 'b', 'c']
          }),
          StateDeltaEvent(delta: [
            {'op': 'replace', 'path': '/count', 'value': 43},
          ]),
          ActivitySnapshotEvent(
            messageId: 'act_01',
            activityType: 'task.run',
            content: {'progress': 0.25},
          ),
          ActivityDeltaEvent(
            messageId: 'act_01',
            activityType: 'task.run',
            patch: [
              {'op': 'replace', 'path': '/progress', 'value': 0.5},
            ],
          ),
          ReasoningStartEvent(messageId: 'rsn_01'),
          ReasoningMessageStartEvent(messageId: 'rsn_01'),
          ReasoningMessageContentEvent(
            messageId: 'rsn_01',
            delta: 'thinking',
          ),
          ReasoningMessageEndEvent(messageId: 'rsn_01'),
          ReasoningMessageChunkEvent(messageId: 'rsn_01', delta: 'chunk'),
          ReasoningEncryptedValueEvent(
            subtype: ReasoningEncryptedValueSubtype.message,
            entityId: 'rsn_01',
            encryptedValue: 'cipher',
          ),
          ReasoningEndEvent(messageId: 'rsn_01'),
          RunFinishedEvent(threadId: 'thread_01', runId: 'run_01'),
        ];

        // Encode to SSE
        final encodedEvents =
            originalEvents.map((e) => encoder.encodeSSE(e)).toList();

        // Decode back
        final decodedEvents = <BaseEvent>[];
        for (final sse in encodedEvents) {
          decodedEvents.add(decoder.decodeSSE(sse));
        }

        // Verify types match
        expect(decodedEvents.length, equals(originalEvents.length));
        for (var i = 0; i < originalEvents.length; i++) {
          expect(decodedEvents[i].runtimeType,
              equals(originalEvents[i].runtimeType));
        }

        // Verify specific field values
        final decodedRun = decodedEvents[0] as RunStartedEvent;
        expect(decodedRun.threadId, equals('thread_01'));
        expect(decodedRun.runId, equals('run_01'));

        final decodedContent = decodedEvents[2] as TextMessageContentEvent;
        expect(decodedContent.delta, equals('Hello, world!'));

        final decodedSnapshot = decodedEvents[7] as StateSnapshotEvent;
        expect(decodedSnapshot.snapshot['count'], equals(42));
        expect(decodedSnapshot.snapshot['items'], equals(['a', 'b', 'c']));

        // Field-value parity for the new activity / reasoning events.
        // `whereType<T>().first` is used instead of positional indices
        // so the assertions stay stable if the fixture order shifts.
        final activitySnapshot =
            decodedEvents.whereType<ActivitySnapshotEvent>().first;
        expect(activitySnapshot.replace, isTrue);
        expect(activitySnapshot.activityType, equals('task.run'));
        expect(
          activitySnapshot.content,
          equals({'progress': 0.25}),
        );

        final reasoningStart =
            decodedEvents.whereType<ReasoningMessageStartEvent>().first;
        expect(reasoningStart.role, equals(ReasoningMessageRole.reasoning));
        expect(reasoningStart.messageId, equals('rsn_01'));

        final encrypted =
            decodedEvents.whereType<ReasoningEncryptedValueEvent>().first;
        expect(
          encrypted.subtype,
          equals(ReasoningEncryptedValueSubtype.message),
        );
        expect(encrypted.entityId, equals('rsn_01'));
        expect(encrypted.encryptedValue, equals('cipher'));
      });

      test('round-trip preserves explicit-null payload', () {
        // Regression guard for the encoder null-strip bug: previously
        // `encodeSSE` ran `json.removeWhere((k, v) => v == null)` which
        // silently dropped fields that intentionally serialize as `null`.
        // The factories below all REQUIRE the key to be present (an absent
        // key raises `AGUIValidationError`), so the round-trip would fail
        // with `DecodingError(field: 'content' | 'event' | 'value')`. The
        // post-fix encoder leaves the toJson output untouched.
        final originals = <BaseEvent>[
          ActivitySnapshotEvent(
            messageId: 'm',
            activityType: 't',
            content: null,
          ),
          RawEvent(event: null),
          CustomEvent(name: 'evt', value: null),
          StateSnapshotEvent(snapshot: null),
        ];

        for (final original in originals) {
          final sse = encoder.encodeSSE(original);
          final decoded = decoder.decodeSSE(sse);
          expect(
            decoded.runtimeType,
            equals(original.runtimeType),
            reason: 'round-trip type mismatch for ${original.runtimeType}',
          );
        }

        final activity = decoder.decodeSSE(encoder.encodeSSE(originals[0]))
            as ActivitySnapshotEvent;
        expect(activity.content, isNull);
        final raw =
            decoder.decodeSSE(encoder.encodeSSE(originals[1])) as RawEvent;
        expect(raw.event, isNull);
        final custom =
            decoder.decodeSSE(encoder.encodeSSE(originals[2])) as CustomEvent;
        expect(custom.value, isNull);
        final snapshot = decoder.decodeSSE(encoder.encodeSSE(originals[3]))
            as StateSnapshotEvent;
        expect(snapshot.snapshot, isNull);
      });

      test('handles protobuf content type negotiation', () {
        // Test with protobuf accept header
        final protoEncoder = EventEncoder(
          accept: 'application/vnd.ag-ui.event+proto, text/event-stream',
        );
        expect(protoEncoder.acceptsProtobuf, isTrue);
        expect(protoEncoder.getContentType(),
            equals('application/vnd.ag-ui.event+proto'));

        // Test without protobuf
        final sseEncoder = EventEncoder(accept: 'text/event-stream');
        expect(sseEncoder.acceptsProtobuf, isFalse);
        expect(sseEncoder.getContentType(), equals('text/event-stream'));
      });
    });
  });
}

// Helper to extract sections from fixture file
String _extractSection(String content, String sectionName) {
  final lines = content.split('\n');
  final startIndex =
      lines.indexWhere((line) => line.startsWith('## $sectionName'));
  if (startIndex == -1) return '';

  var endIndex = lines.length;
  for (var i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('##')) {
      endIndex = i;
      break;
    }
  }

  return lines.sublist(startIndex + 1, endIndex).join('\n');
}
