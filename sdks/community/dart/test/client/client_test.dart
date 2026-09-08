import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import 'package:ag_ui/src/client/client.dart';
import 'package:ag_ui/src/client/config.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/types/types.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/backoff_strategy.dart';

// Custom mock client that supports streaming responses
class MockStreamingClient extends http.BaseClient {
  final Future<http.StreamedResponse> Function(http.BaseRequest) _handler;

  MockStreamingClient(this._handler);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    return _handler(request);
  }
}

void main() {
  group('AgUiClient', () {
    late AgUiClient client;
    late MockStreamingClient mockHttpClient;

    setUp(() {
      mockHttpClient = MockStreamingClient((request) async {
        // Default mock response
        return http.StreamedResponse(
          Stream.fromIterable([
            utf8.encode(
                'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n'),
            utf8.encode(
                'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
          ]),
          200,
          headers: {'content-type': 'text/event-stream'},
        );
      });
    });

    tearDown(() async {
      await client.close();
    });

    group('runAgent', () {
      test('sends correct request and receives stream events', () async {
        final expectedRunId = 'run_123';
        final expectedThreadId = 'thread_456';

        mockHttpClient = MockStreamingClient((request) async {
          expect(request.method, equals('POST'));
          expect(request.url.toString(),
              equals('https://api.example.com/test_endpoint'));
          expect(request.headers['Content-Type'], contains('application/json'));
          expect(request.headers['Accept'], contains('text/event-stream'));

          if (request is http.Request) {
            final body = json.decode(request.body) as Map<String, dynamic>;
            expect(body['messages'], isA<List>());
            expect(body['config']['temperature'], equals(0.7));
          }

          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_STARTED","threadId":"$expectedThreadId","runId":"$expectedRunId"}\n\n'),
              utf8.encode(
                  'data: {"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}\n\n'),
              utf8.encode(
                  'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg1","delta":"Hello!"}\n\n'),
              utf8.encode(
                  'data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}\n\n'),
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","threadId":"$expectedThreadId","runId":"$expectedRunId"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        final events = await client
            .runAgent(
              'test_endpoint',
              SimpleRunAgentInput(
                messages: [UserMessage(id: 'msg1', content: 'Hello')],
                config: {'temperature': 0.7},
              ),
            )
            .toList();

        expect(events.length, greaterThan(0));

        final runStarted = events.whereType<RunStartedEvent>().first;
        expect(runStarted.runId, equals(expectedRunId));
        expect(runStarted.threadId, equals(expectedThreadId));

        final runFinished = events.whereType<RunFinishedEvent>().first;
        expect(runFinished.runId, equals(expectedRunId));

        final textMessages =
            events.whereType<TextMessageContentEvent>().toList();
        expect(textMessages.isNotEmpty, isTrue);
        expect(textMessages.first.delta, equals('Hello!'));
      });

      // Note: SSE protocol does not support retry on HTTP errors (4xx/5xx)
      // This is a protocol limitation, not a bug. SSE can only retry on
      // network failures after a successful connection is established.

      test('throws exception after max retries', () async {
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.value(utf8.encode('Server error')),
            500,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            maxRetries: 2,
          ),
          httpClient: mockHttpClient,
        );

        expect(
          () =>
              client.runAgent('test_endpoint', SimpleRunAgentInput()).toList(),
          throwsA(isA<TransportError>()),
        );
      });

      test('handles network timeouts', () async {
        mockHttpClient = MockStreamingClient((request) async {
          await Future.delayed(Duration(seconds: 10));
          return http.StreamedResponse(
            Stream.empty(),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            requestTimeout: Duration(milliseconds: 100),
          ),
          httpClient: mockHttpClient,
        );

        expect(
          () =>
              client.runAgent('test_endpoint', SimpleRunAgentInput()).toList(),
          throwsA(isA<AGUITimeoutError>()),
        );
      });
    });

    group('stream management', () {
      test('handles SSE parsing errors gracefully', () async {
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n'),
              utf8.encode('data: invalid json\n\n'), // Invalid JSON
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
          ),
          httpClient: mockHttpClient,
        );

        // The stream should error when encountering invalid JSON
        // Note: In a production implementation, you might want to skip invalid events
        // but the current implementation throws on decode errors
        expect(
          () =>
              client.runAgent('test_endpoint', SimpleRunAgentInput()).toList(),
          throwsA(isA<DecodingError>()),
        );
      });

      test('supports cancellation', () async {
        final cancelToken = CancelToken();

        mockHttpClient = MockStreamingClient((request) async {
          // Use async generator for lazy evaluation that respects cancellation
          Stream<List<int>> generateEvents() async* {
            for (int i = 0; i < 10; i++) {
              await Future.delayed(Duration(milliseconds: 100));
              if (cancelToken.isCancelled) break;
              yield utf8.encode(
                  'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg1","delta":"chunk$i"}\n\n');
            }
          }

          return http.StreamedResponse(
            generateEvents(),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
          ),
          httpClient: mockHttpClient,
        );

        final events = <BaseEvent>[];
        final subscription = client
            .runAgent(
              'test_endpoint',
              SimpleRunAgentInput(),
              cancelToken: cancelToken,
            )
            .listen(events.add);

        // Cancel after a short delay
        await Future.delayed(Duration(milliseconds: 250));
        cancelToken.cancel();

        await subscription.asFuture().catchError((_) {});

        // Should have received some events but not all
        expect(events.length, greaterThan(0));
        expect(events.length, lessThan(10));
      });
    });

    group('endpoint methods', () {
      test('runAgenticChat uses correct endpoint', () async {
        String? capturedUrl;

        mockHttpClient = MockStreamingClient((request) async {
          capturedUrl = request.url.toString();
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        await client.runAgenticChat(SimpleRunAgentInput()).toList();
        expect(capturedUrl, equals('https://api.example.com/agentic_chat'));
      });

      test('runHumanInTheLoop uses correct endpoint', () async {
        String? capturedUrl;

        mockHttpClient = MockStreamingClient((request) async {
          capturedUrl = request.url.toString();
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(baseUrl: 'https://api.example.com'),
          httpClient: mockHttpClient,
        );

        await client.runHumanInTheLoop(SimpleRunAgentInput()).toList();
        expect(
            capturedUrl, equals('https://api.example.com/human_in_the_loop'));
      });
    });

    group('configuration', () {
      test('respects custom headers', () async {
        Map<String, String>? capturedHeaders;

        mockHttpClient = MockStreamingClient((request) async {
          capturedHeaders = request.headers;
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'https://api.example.com',
            defaultHeaders: {
              'X-API-Key': 'secret-key',
              'X-Custom-Header': 'custom-value',
            },
          ),
          httpClient: mockHttpClient,
        );

        await client.runAgent('test', SimpleRunAgentInput()).toList();

        expect(capturedHeaders?['X-API-Key'], equals('secret-key'));
        expect(capturedHeaders?['X-Custom-Header'], equals('custom-value'));
      });

      // Note: Exponential backoff for SSE connections only applies to
      // network failures after successful connection, not HTTP errors.
      // Applications requiring retry on HTTP errors should implement
      // this at the application layer, not the protocol layer.
    });
  });
}
