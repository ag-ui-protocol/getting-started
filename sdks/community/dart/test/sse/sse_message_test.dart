import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:test/test.dart';

void main() {
  group('SseMessage', () {
    test('creates message with all fields', () {
      final message = SseMessage(
        event: 'custom-event',
        id: 'msg-123',
        data: 'Hello, World!',
        retry: Duration(seconds: 5),
      );

      expect(message.event, equals('custom-event'));
      expect(message.id, equals('msg-123'));
      expect(message.data, equals('Hello, World!'));
      expect(message.retry, equals(Duration(seconds: 5)));
    });

    test('creates message with partial fields', () {
      final message = SseMessage(
        data: 'Test data',
      );

      expect(message.event, isNull);
      expect(message.id, isNull);
      expect(message.data, equals('Test data'));
      expect(message.retry, isNull);
    });

    test('creates empty message', () {
      final message = SseMessage();

      expect(message.event, isNull);
      expect(message.id, isNull);
      expect(message.data, isNull);
      expect(message.retry, isNull);
    });

    test('toString returns correct format', () {
      final message = SseMessage(
        event: 'test',
        id: '123',
        data: 'data',
        retry: Duration(milliseconds: 1000),
      );

      final str = message.toString();
      expect(str, contains('SseMessage'));
      expect(str, contains('event: test'));
      expect(str, contains('id: 123'));
      expect(str, contains('data: data'));
      expect(str, contains('retry: 0:00:01.000000'));
    });

    test('toString handles null values', () {
      final message = SseMessage();

      final str = message.toString();
      expect(str,
          equals('SseMessage(event: null, id: null, data: null, retry: null)'));
    });

    test('creates message with only event', () {
      final message = SseMessage(event: 'notification');

      expect(message.event, equals('notification'));
      expect(message.id, isNull);
      expect(message.data, isNull);
      expect(message.retry, isNull);
    });

    test('creates message with only id', () {
      final message = SseMessage(id: 'unique-id');

      expect(message.event, isNull);
      expect(message.id, equals('unique-id'));
      expect(message.data, isNull);
      expect(message.retry, isNull);
    });

    test('creates message with only retry', () {
      final message = SseMessage(retry: Duration(minutes: 1));

      expect(message.event, isNull);
      expect(message.id, isNull);
      expect(message.data, isNull);
      expect(message.retry, equals(Duration(minutes: 1)));
    });

    test('handles multiline data', () {
      final multilineData = 'Line 1\nLine 2\nLine 3';
      final message = SseMessage(data: multilineData);

      expect(message.data, equals(multilineData));
    });

    test('handles empty string data', () {
      final message = SseMessage(data: '');

      expect(message.data, equals(''));
      expect(message.data, isNotNull);
    });

    test('handles special characters in data', () {
      final specialData = 'Special: \u{1F600} & <html> "quotes" \'single\'';
      final message = SseMessage(data: specialData);

      expect(message.data, equals(specialData));
    });

    test('const constructor allows compile-time constants', () {
      const message = SseMessage(
        event: 'const-event',
        id: 'const-id',
        data: 'const-data',
      );

      expect(message.event, equals('const-event'));
      expect(message.id, equals('const-id'));
      expect(message.data, equals('const-data'));
    });
  });
}
