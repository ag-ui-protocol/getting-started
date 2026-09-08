import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/sse/sse_client.dart';
import 'package:test/test.dart';

void main() {
  group('SseClient Stream Parsing', () {
    test('parseStream parses properly formatted SSE messages', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send properly formatted SSE messages
      // Message 1: Simple data
      controller.add(utf8.encode('data: Hello\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Message 2: Event with data
      controller.add(utf8.encode('event: custom\n'));
      controller.add(utf8.encode('data: World\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Message 3: Message with ID
      controller.add(utf8.encode('id: msg-1\n'));
      controller.add(utf8.encode('data: Test\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      // Close the stream
      await controller.close();

      // Get the messages
      final messages = await messagesFuture;

      expect(messages.length, equals(3));

      // Check Message 1
      expect(messages[0].data, equals('Hello'));
      expect(messages[0].event, isNull);
      expect(messages[0].id, isNull);

      // Check Message 2
      expect(messages[1].data, equals('World'));
      expect(messages[1].event, equals('custom'));

      // Check Message 3
      expect(messages[2].data, equals('Test'));
      expect(messages[2].id, equals('msg-1'));
    });

    test('parseStream handles multi-line data fields', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with multiple data fields
      controller.add(utf8.encode('data: Line 1\n'));
      controller.add(utf8.encode('data: Line 2\n'));
      controller.add(utf8.encode('data: Line 3\n'));
      controller.add(utf8.encode('\n')); // Empty line triggers dispatch

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      // Multiple data fields are joined with newlines
      expect(messages[0].data, equals('Line 1\nLine 2\nLine 3'));
    });

    test('parseStream handles retry field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with retry field
      controller.add(utf8.encode('retry: 5000\n'));
      controller.add(utf8.encode('data: Retry message\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Retry message'));
      expect(messages[0].retry, equals(Duration(milliseconds: 5000)));
    });

    test('parseStream ignores comments', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with comments
      controller.add(utf8.encode(': This is a comment\n'));
      controller.add(utf8.encode('data: Real data\n'));
      controller.add(utf8.encode(': Another comment\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Real data'));
    });

    test('parseStream handles empty data field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message with empty data
      controller.add(utf8.encode('data:\n')); // Empty data field
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('')); // Empty string, not null
    });

    test('parseStream skips messages without data field', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Send message without data field (should be ignored)
      controller.add(utf8.encode('event: ping\n'));
      controller.add(utf8.encode('id: 1\n'));
      controller.add(utf8.encode('\n'));

      // Send valid message
      controller.add(utf8.encode('data: Valid message\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      // Only the message with data field should be dispatched
      expect(messages.length, equals(1));
      expect(messages[0].data, equals('Valid message'));
    });

    test('parseStream handles field without colon', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // Field without colon is treated as field name with empty value
      controller.add(utf8.encode('data\n')); // data field with empty value
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('')); // Empty value
    });

    test('parseStream removes single leading space from field value', () async {
      final client = SseClient();
      final controller = StreamController<List<int>>();

      final stream = client.parseStream(controller.stream);
      final messagesFuture = stream.toList();

      // SSE spec: single leading space after colon is removed
      controller.add(utf8.encode('data: With space\n'));
      controller
          .add(utf8.encode('data:  Two spaces\n')); // Only first space removed
      controller.add(utf8.encode('data:No space\n'));
      controller.add(utf8.encode('\n'));

      await controller.close();

      final messages = await messagesFuture;

      expect(messages.length, equals(1));
      expect(messages[0].data, equals('With space\n Two spaces\nNo space'));
    });
  });
}
