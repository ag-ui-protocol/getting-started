import 'package:ag_ui/src/encoder/client_codec.dart' as codec;
import 'package:ag_ui/src/client/client.dart' show SimpleRunAgentInput;
import 'package:ag_ui/src/types/types.dart';
import 'package:test/test.dart';

void main() {
  group('Encoder', () {
    late codec.Encoder encoder;

    setUp(() {
      encoder = codec.Encoder();
    });

    test('const constructor creates instance', () {
      const encoder = codec.Encoder();
      expect(encoder, isNotNull);
    });

    test('encodeRunAgentInput encodes SimpleRunAgentInput correctly', () {
      final input = SimpleRunAgentInput(
        messages: [
          UserMessage(
            id: 'msg-1',
            content: 'Hello',
          ),
        ],
        state: {'counter': 1},
        tools: [
          Tool(
            name: 'search',
            description: 'Search tool',
            parameters: {'type': 'object'},
          ),
        ],
        context: [
          Context(
            description: 'Test context',
            value: 'context value',
          ),
        ],
      );

      final encoded = encoder.encodeRunAgentInput(input);

      expect(encoded, isA<Map<String, dynamic>>());
      expect(encoded['messages'], isList);
      expect(encoded['messages'], hasLength(1));
      expect(encoded['state'], equals({'counter': 1}));
      expect(encoded['tools'], isList);
      expect(encoded['tools'], hasLength(1));
      expect(encoded['context'], isList);
      expect(encoded['context'], hasLength(1));
    });

    test('encodeRunAgentInput handles empty input', () {
      // Required fields (state, messages, tools, context, forwardedProps) are
      // always emitted — falling back to empty containers when null — so strict
      // servers (pydantic BaseModel with required fields) do not reject the
      // payload with 422. Optional fields (threadId, runId, etc.) are omitted
      // when null.
      final input = SimpleRunAgentInput(
        messages: [],
      );

      final encoded = encoder.encodeRunAgentInput(input);

      expect(encoded, isA<Map<String, dynamic>>());
      expect(encoded['messages'], isEmpty); // explicit empty list → emitted
      expect(encoded['state'], isEmpty); // null → emitted as {}
      expect(encoded['tools'], isEmpty); // null → emitted as []
      expect(encoded['context'], isEmpty); // null → emitted as []
      expect(encoded['forwardedProps'], isEmpty); // null → emitted as {}
    });

    test('encodeUserMessage encodes UserMessage correctly', () {
      final message = UserMessage(
        id: 'msg-test',
        content: 'Test message',
      );

      final encoded = encoder.encodeUserMessage(message);

      expect(encoded, isA<Map<String, dynamic>>());
      expect(encoded['role'], equals('user'));
      expect(encoded['content'], equals('Test message'));
      expect(encoded['id'], equals('msg-test'));
    });

    test('encodeUserMessage handles message without metadata', () {
      final message = UserMessage(
        id: 'msg-simple',
        content: 'Simple message',
      );

      final encoded = encoder.encodeUserMessage(message);

      expect(encoded['role'], equals('user'));
      expect(encoded['content'], equals('Simple message'));
      expect(encoded['id'], equals('msg-simple'));
    });

    test('encodeToolResult encodes ClientToolResult with all fields', () {
      final result = codec.ClientToolResult(
        toolCallId: 'call_123',
        result: {'data': 'test result'},
        error: 'Some error occurred',
        metadata: {'executionTime': 100},
      );

      final encoded = encoder.encodeToolResult(result);

      expect(encoded, isA<Map<String, dynamic>>());
      expect(encoded['toolCallId'], equals('call_123'));
      expect(encoded['result'], equals({'data': 'test result'}));
      expect(encoded['error'], equals('Some error occurred'));
      expect(encoded['metadata'], equals({'executionTime': 100}));
    });

    test('encodeToolResult handles result without optional fields', () {
      final result = codec.ClientToolResult(
        toolCallId: 'call_456',
        result: 'Simple result',
      );

      final encoded = encoder.encodeToolResult(result);

      expect(encoded['toolCallId'], equals('call_456'));
      expect(encoded['result'], equals('Simple result'));
      expect(encoded.containsKey('error'), isFalse);
      expect(encoded.containsKey('metadata'), isFalse);
    });

    test('encodeToolResult handles complex result data', () {
      final complexResult = {
        'nested': {
          'array': [1, 2, 3],
          'object': {'key': 'value'},
        },
        'boolean': true,
        'number': 42.5,
      };

      final result = codec.ClientToolResult(
        toolCallId: 'call_789',
        result: complexResult,
      );

      final encoded = encoder.encodeToolResult(result);

      expect(encoded['result'], equals(complexResult));
    });

    test('encodeToolResult handles null result', () {
      final result = codec.ClientToolResult(
        toolCallId: 'call_null',
        result: null,
      );

      final encoded = encoder.encodeToolResult(result);

      expect(encoded['toolCallId'], equals('call_null'));
      expect(encoded['result'], isNull);
    });
  });

  group('Decoder', () {
    late codec.Decoder decoder;

    setUp(() {
      decoder = codec.Decoder();
    });

    test('const constructor creates instance', () {
      const decoder = codec.Decoder();
      expect(decoder, isNotNull);
    });
  });

  group('ClientToolResult', () {
    test('creates with required fields only', () {
      final result = codec.ClientToolResult(
        toolCallId: 'id_123',
        result: 'test',
      );

      expect(result.toolCallId, equals('id_123'));
      expect(result.result, equals('test'));
      expect(result.error, isNull);
      expect(result.metadata, isNull);
    });

    test('creates with all fields', () {
      final result = codec.ClientToolResult(
        toolCallId: 'id_456',
        result: {'key': 'value'},
        error: 'Error message',
        metadata: {'meta': 'data'},
      );

      expect(result.toolCallId, equals('id_456'));
      expect(result.result, equals({'key': 'value'}));
      expect(result.error, equals('Error message'));
      expect(result.metadata, equals({'meta': 'data'}));
    });

    test('const constructor works', () {
      const result = codec.ClientToolResult(
        toolCallId: 'const_id',
        result: 'const_result',
      );

      expect(result.toolCallId, equals('const_id'));
      expect(result.result, equals('const_result'));
    });

    test('handles different result types', () {
      // String result
      var result = codec.ClientToolResult(toolCallId: '1', result: 'string');
      expect(result.result, isA<String>());

      // Number result
      result = codec.ClientToolResult(toolCallId: '2', result: 42);
      expect(result.result, isA<int>());

      // Boolean result
      result = codec.ClientToolResult(toolCallId: '3', result: true);
      expect(result.result, isA<bool>());

      // List result
      result = codec.ClientToolResult(toolCallId: '4', result: [1, 2, 3]);
      expect(result.result, isA<List>());

      // Map result
      result =
          codec.ClientToolResult(toolCallId: '5', result: {'nested': 'object'});
      expect(result.result, isA<Map>());
    });
  });
}
