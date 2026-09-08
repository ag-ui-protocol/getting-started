import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:http/http.dart' as http;

import 'package:ag_ui/src/client/client.dart';
import 'package:ag_ui/src/client/config.dart';
import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/types/types.dart';
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
  group('AgUiClient HTTP Endpoints', () {
    late AgUiClient client;
    late MockStreamingClient mockHttpClient;

    setUp(() {
      mockHttpClient = MockStreamingClient((request) async {
        // Default 404 response
        return http.StreamedResponse(
          Stream.value(utf8.encode('Not Found')),
          404,
        );
      });

      client = AgUiClient(
        config: AgUiClientConfig(
          baseUrl: 'http://localhost:8000',
          requestTimeout: const Duration(seconds: 5),
          maxRetries: 0, // Disable retries for tests
        ),
        httpClient: mockHttpClient,
      );
    });

    tearDown(() async {
      await client.close();
    });

    group('runAgent', () {
      test('sends correct POST request with SimpleRunAgentInput', () async {
        // Arrange
        final input = SimpleRunAgentInput(
          threadId: 'thread_123',
          runId: 'run_456',
          messages: [
            UserMessage(
              id: 'msg_789',
              content: 'Hello, agent!',
            ),
          ],
          config: {'temperature': 0.7},
          metadata: {'source': 'test'},
        );

        String? capturedBody;
        Map<String, String>? capturedHeaders;

        mockHttpClient = MockStreamingClient((request) async {
          if (request is http.Request) {
            capturedBody = request.body;
          }
          capturedHeaders = request.headers;

          // Return SSE stream with a simple event
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_STARTED","thread_id":"thread_123","run_id":"run_456"}\n\n'),
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","thread_id":"thread_123","run_id":"run_456"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        // Act
        final events = await client.runAgent('agentic_chat', input).toList();

        // Assert
        expect(capturedBody, isNotNull);
        expect(capturedHeaders?['Content-Type'], contains('application/json'));
        expect(capturedHeaders?['Accept'], contains('text/event-stream'));

        final bodyJson = json.decode(capturedBody!);
        expect(bodyJson['threadId'], 'thread_123');
        expect(bodyJson['runId'], 'run_456');
        expect(bodyJson['messages'], hasLength(1));
        expect(bodyJson['config']['temperature'], 0.7);
        expect(bodyJson['metadata']['source'], 'test');

        expect(events, hasLength(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test('handles 4xx errors correctly', () async {
        // Arrange
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.value(utf8.encode('{"error": "Invalid input"}')),
            400,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        final input = SimpleRunAgentInput(threadId: 'test');

        // Act & Assert
        expect(
          () => client.runAgent('test_endpoint', input).toList(),
          throwsA(isA<TransportError>()
              .having((e) => e.statusCode, 'statusCode', 400)
              .having((e) => e.message, 'message', contains('failed'))),
        );
      });

      test('handles 5xx errors correctly', () async {
        // Arrange
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.value(utf8.encode('Internal Server Error')),
            500,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        final input = SimpleRunAgentInput(threadId: 'test');

        // Act & Assert
        expect(
          () => client.runAgent('test_endpoint', input).toList(),
          throwsA(isA<TransportError>()
              .having((e) => e.statusCode, 'statusCode', 500)),
        );
      });

      test('handles timeout correctly', () async {
        // Arrange
        mockHttpClient = MockStreamingClient((request) async {
          // Simulate a slow response
          await Future.delayed(const Duration(seconds: 10));
          return http.StreamedResponse(
            Stream.empty(),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            requestTimeout: const Duration(milliseconds: 100),
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        final input = SimpleRunAgentInput(threadId: 'test');

        // Act & Assert
        expect(
          () => client.runAgent('test_endpoint', input).toList(),
          throwsA(isA<AGUITimeoutError>()),
        );
      });

      test('handles cancellation correctly', () async {
        // Arrange
        final completer = Completer<http.StreamedResponse>();

        mockHttpClient = MockStreamingClient((request) async {
          return completer.future;
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        final input = SimpleRunAgentInput(threadId: 'test');
        final cancelToken = CancelToken();

        // Act
        final futureEvents = client
            .runAgent('test_endpoint', input, cancelToken: cancelToken)
            .toList();

        // Cancel the request
        await Future.delayed(const Duration(milliseconds: 10));
        cancelToken.cancel();

        // Complete the request after cancellation
        completer.complete(http.StreamedResponse(
          Stream.empty(),
          200,
        ));

        // Assert
        expect(
          futureEvents,
          throwsA(isA<CancellationError>()
              .having((e) => e.message, 'message', contains('cancelled'))),
        );
      });
    });

    group('specific agent endpoints', () {
      setUp(() {
        mockHttpClient = MockStreamingClient((request) async {
          // Return a minimal SSE response
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_STARTED","thread_id":"t1","run_id":"r1"}\n\n'),
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );
      });

      test('runAgenticChat calls correct endpoint', () async {
        String? capturedUrl;

        mockHttpClient = MockStreamingClient((request) async {
          capturedUrl = request.url.toString();
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        await client.runAgenticChat(SimpleRunAgentInput()).toList();
        expect(capturedUrl, 'http://localhost:8000/agentic_chat');
      });

      test('runHumanInTheLoop calls correct endpoint', () async {
        String? capturedUrl;

        mockHttpClient = MockStreamingClient((request) async {
          capturedUrl = request.url.toString();
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        await client.runHumanInTheLoop(SimpleRunAgentInput()).toList();
        expect(capturedUrl, 'http://localhost:8000/human_in_the_loop');
      });

      test('runToolBasedGenerativeUi calls correct endpoint', () async {
        String? capturedUrl;

        mockHttpClient = MockStreamingClient((request) async {
          capturedUrl = request.url.toString();
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode(
                  'data: {"type":"RUN_FINISHED","thread_id":"t1","run_id":"r1"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        await client.runToolBasedGenerativeUi(SimpleRunAgentInput()).toList();
        expect(capturedUrl, 'http://localhost:8000/tool_based_generative_ui');
      });
    });

    group('error handling and validation', () {
      test('validates base URL', () async {
        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'not-a-valid-url',
            maxRetries: 0,
          ),
        );

        expect(
          () => client.runAgent('test', SimpleRunAgentInput()).toList(),
          throwsA(isA<ValidationError>()),
        );
      });

      test('validates thread ID when present', () async {
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.empty(),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        final input = SimpleRunAgentInput(threadId: ''); // Empty thread ID

        expect(
          () => client.runAgent('test', input).toList(),
          throwsA(isA<ValidationError>()),
        );
      });

      test('handles malformed SSE data gracefully', () async {
        mockHttpClient = MockStreamingClient((request) async {
          return http.StreamedResponse(
            Stream.fromIterable([
              utf8.encode('data: not-valid-json\n\n'),
              utf8.encode('data: {"type":"RUN_FINISHED"}\n\n'),
            ]),
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 0,
          ),
          httpClient: mockHttpClient,
        );

        // When malformed data is encountered, the stream should error
        // This is the expected behavior - fail fast on invalid data
        expect(
          () => client.runAgent('test', SimpleRunAgentInput()).toList(),
          throwsA(isA<DecodingError>()),
        );
      });
    });

    group('request retry logic', () {
      test('retries on 5xx errors with backoff', () async {
        int attemptCount = 0;
        final attemptTimes = <DateTime>[];

        mockHttpClient = MockStreamingClient((request) async {
          attemptCount++;
          attemptTimes.add(DateTime.now());

          if (attemptCount < 3) {
            return http.StreamedResponse(
              Stream.value(utf8.encode('Server Error')),
              500,
            );
          }
          return http.StreamedResponse(
            Stream.value(utf8.encode('{"success": true}')),
            200,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 2,
            backoffStrategy: FixedBackoffStrategy(
              const Duration(milliseconds: 100),
            ),
          ),
          httpClient: mockHttpClient,
        );

        // Use _sendRequest for testing retry logic
        final response = await client.sendRequestForTesting(
          'GET',
          'http://localhost:8000/test',
        );

        expect(response.statusCode, 200);
        expect(attemptCount, 3);

        // Check that delays were applied
        if (attemptTimes.length >= 2) {
          final delay1 = attemptTimes[1].difference(attemptTimes[0]);
          expect(delay1.inMilliseconds, greaterThanOrEqualTo(90));
        }
      });

      test('does not retry on 4xx errors', () async {
        int attemptCount = 0;

        mockHttpClient = MockStreamingClient((request) async {
          attemptCount++;
          return http.StreamedResponse(
            Stream.value(utf8.encode('Bad Request')),
            400,
          );
        });

        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://localhost:8000',
            maxRetries: 2,
          ),
          httpClient: mockHttpClient,
        );

        final response = await client.sendRequestForTesting(
          'GET',
          'http://localhost:8000/test',
        );

        expect(response.statusCode, 400);
        expect(attemptCount, 1); // No retries
      });
    });
  });
}

// Test helper to expose sendRequest for testing
extension TestHelper on AgUiClient {
  Future<http.Response> sendRequestForTesting(
    String method,
    String endpoint, {
    Map<String, dynamic>? body,
  }) {
    // Use the now-public sendRequest method (marked @visibleForTesting)
    return sendRequest(method, endpoint, body: body);
  }
}

// Test backoff strategy
class FixedBackoffStrategy implements BackoffStrategy {
  final Duration delay;

  FixedBackoffStrategy(this.delay);

  @override
  Duration nextDelay(int attempt) => delay;

  @override
  void reset() {}
}
