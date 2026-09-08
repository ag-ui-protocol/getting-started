import 'dart:convert';
import 'dart:typed_data';

import 'package:ag_ui/src/encoder/encoder.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/types/message.dart';
import 'package:test/test.dart';

void main() {
  group('EventEncoder', () {
    late EventEncoder encoder;

    setUp(() {
      encoder = EventEncoder();
    });

    group('constructor', () {
      test('creates encoder without protobuf support by default', () {
        final encoder = EventEncoder();
        expect(encoder.acceptsProtobuf, isFalse);
        expect(encoder.getContentType(), equals('text/event-stream'));
      });

      test(
          'creates encoder with protobuf support when accept header includes it',
          () {
        final encoder = EventEncoder(
          accept: 'application/vnd.ag-ui.event+proto, text/event-stream',
        );
        expect(encoder.acceptsProtobuf, isTrue);
        expect(encoder.getContentType(), equals(aguiMediaType));
      });

      test('creates encoder without protobuf when accept header excludes it',
          () {
        final encoder = EventEncoder(accept: 'text/event-stream');
        expect(encoder.acceptsProtobuf, isFalse);
        expect(encoder.getContentType(), equals('text/event-stream'));
      });
    });

    group('encodeSSE', () {
      test('encodes simple text message start event', () {
        final event = TextMessageStartEvent(
          messageId: 'msg123',
          role: TextMessageRole.assistant,
        );

        final encoded = encoder.encodeSSE(event);

        expect(encoded, startsWith('data: '));
        expect(encoded, endsWith('\n\n'));

        // Extract and parse JSON
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('TEXT_MESSAGE_START'));
        expect(json['messageId'], equals('msg123'));
        expect(json['role'], equals('assistant'));
      });

      test('encodes text message content event with delta', () {
        final event = TextMessageContentEvent(
          messageId: 'msg123',
          delta: 'Hello, world!',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('TEXT_MESSAGE_CONTENT'));
        expect(json['messageId'], equals('msg123'));
        expect(json['delta'], equals('Hello, world!'));
      });

      test('encodes tool call start event', () {
        final event = ToolCallStartEvent(
          toolCallId: 'tool456',
          toolCallName: 'search',
          parentMessageId: 'msg123',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('TOOL_CALL_START'));
        expect(json['toolCallId'], equals('tool456'));
        expect(json['toolCallName'], equals('search'));
        expect(json['parentMessageId'], equals('msg123'));
      });

      test('encodes run started event', () {
        final event = RunStartedEvent(
          threadId: 'thread789',
          runId: 'run012',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('RUN_STARTED'));
        expect(json['threadId'], equals('thread789'));
        expect(json['runId'], equals('run012'));
      });

      test('encodes state snapshot event', () {
        final event = StateSnapshotEvent(
          snapshot: {'counter': 42, 'name': 'test'},
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('STATE_SNAPSHOT'));
        expect(json['snapshot'], equals({'counter': 42, 'name': 'test'}));
      });

      test('encodes messages snapshot event', () {
        final event = MessagesSnapshotEvent(
          messages: [
            UserMessage(
              id: 'msg1',
              content: 'Hello',
            ),
            AssistantMessage(
              id: 'msg2',
              content: 'Hi there!',
            ),
          ],
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('MESSAGES_SNAPSHOT'));
        expect(json['messages'], isA<List>());
        expect(json['messages'].length, equals(2));
      });

      test('excludes null fields from JSON output', () {
        final event = TextMessageChunkEvent(
          messageId: 'msg123',
          // role and delta are null
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['type'], equals('TEXT_MESSAGE_CHUNK'));
        expect(json['messageId'], equals('msg123'));
        expect(json.containsKey('role'), isFalse);
        expect(json.containsKey('delta'), isFalse);
      });

      test('includes timestamp when provided', () {
        final timestamp = DateTime.now().millisecondsSinceEpoch;
        final event = TextMessageEndEvent(
          messageId: 'msg123',
          timestamp: timestamp,
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['timestamp'], equals(timestamp));
      });
    });

    group('encode', () {
      test('delegates to encodeSSE', () {
        final event = TextMessageStartEvent(
          messageId: 'msg123',
        );

        final encoded = encoder.encode(event);
        final encodedSSE = encoder.encodeSSE(event);

        expect(encoded, equals(encodedSSE));
      });
    });

    group('encodeBinary', () {
      test('converts SSE to UTF-8 bytes when protobuf not accepted', () {
        final encoder = EventEncoder();
        final event = TextMessageStartEvent(
          messageId: 'msg123',
        );

        final binary = encoder.encodeBinary(event);
        final decoded = utf8.decode(binary);

        expect(decoded, startsWith('data: '));
        expect(decoded, endsWith('\n\n'));
        expect(decoded, contains('"type":"TEXT_MESSAGE_START"'));
        expect(decoded, contains('"messageId":"msg123"'));
      });

      test('falls back to SSE bytes for protobuf (not yet implemented)', () {
        final encoder = EventEncoder(
          accept: 'application/vnd.ag-ui.event+proto',
        );
        final event = TextMessageStartEvent(
          messageId: 'msg123',
        );

        final binary = encoder.encodeBinary(event);
        final decoded = utf8.decode(binary);

        // Should fall back to SSE until protobuf is implemented
        expect(decoded, startsWith('data: '));
        expect(decoded, contains('"type":"TEXT_MESSAGE_START"'));
      });
    });

    group('round-trip encoding', () {
      test('event can be encoded and decoded back', () {
        final originalEvent = ToolCallResultEvent(
          messageId: 'msg123',
          toolCallId: 'tool456',
          content: 'Search results: ...',
          role: ToolCallResultRole.tool,
        );

        final encoded = encoder.encodeSSE(originalEvent);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;
        final decodedEvent = BaseEvent.fromJson(json);

        expect(decodedEvent, isA<ToolCallResultEvent>());
        final result = decodedEvent as ToolCallResultEvent;
        expect(result.messageId, equals(originalEvent.messageId));
        expect(result.toolCallId, equals(originalEvent.toolCallId));
        expect(result.content, equals(originalEvent.content));
        expect(result.role, equals(originalEvent.role));
      });

      test('complex nested state is preserved', () {
        final originalEvent = StateSnapshotEvent(
          snapshot: {
            'user': {
              'id': 123,
              'name': 'Alice',
              'preferences': {
                'theme': 'dark',
                'notifications': true,
              },
            },
            'session': {
              'startTime': '2024-01-01T00:00:00Z',
              'activities': ['login', 'browse', 'search'],
            },
          },
        );

        final encoded = encoder.encodeSSE(originalEvent);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;
        final decodedEvent = BaseEvent.fromJson(json);

        expect(decodedEvent, isA<StateSnapshotEvent>());
        final result = decodedEvent as StateSnapshotEvent;
        expect(result.snapshot, equals(originalEvent.snapshot));
      });
    });

    group('special characters handling', () {
      test('handles newlines in content', () {
        final event = TextMessageContentEvent(
          messageId: 'msg123',
          delta: 'Line 1\nLine 2\nLine 3',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['delta'], equals('Line 1\nLine 2\nLine 3'));
      });

      test('handles special JSON characters', () {
        final event = TextMessageContentEvent(
          messageId: 'msg123',
          delta: 'Special chars: "quotes", \\backslash\\, \ttab',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['delta'],
            equals('Special chars: "quotes", \\backslash\\, \ttab'));
      });

      test('handles unicode characters', () {
        final event = TextMessageContentEvent(
          messageId: 'msg123',
          delta: 'Unicode: 你好 🌟 €',
        );

        final encoded = encoder.encodeSSE(event);
        final jsonStr = encoded.substring(6, encoded.length - 2);
        final json = jsonDecode(jsonStr) as Map<String, dynamic>;

        expect(json['delta'], equals('Unicode: 你好 🌟 €'));
      });
    });
  });
}
