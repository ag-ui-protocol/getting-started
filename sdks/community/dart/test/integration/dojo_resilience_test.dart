/// Live integration test exercising error, cancellation, and validation paths
/// in the AG-UI Dart SDK client against the running dojo container.
///
/// Assumes the dojo is reachable at `AGUI_DOJO_BASE_URL` (preferred) or
/// `AGUI_BASE_URL`, falling back to `http://127.0.0.1:18000`.
///
/// Set `AGUI_SKIP_DOJO=1` to skip when the dojo is not running.
///
/// Tests #4, #5, #6, #7 do NOT require the dojo and run unconditionally
/// (or use an in-process server for test #7).
library;

import 'dart:async';
import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';

// ---------------------------------------------------------------------------
// Shared helpers (same env-var precedence as dojo_smoke_test.dart)
// ---------------------------------------------------------------------------

String _dojoBaseUrl() {
  return Platform.environment['AGUI_DOJO_BASE_URL'] ??
      Platform.environment['AGUI_BASE_URL'] ??
      'http://127.0.0.1:18000';
}

bool _skipDojo() {
  return Platform.environment['AGUI_SKIP_DOJO'] == '1';
}

/// Lightweight reachability probe so the tests surface a clear skip reason
/// when the container is not running, instead of a generic socket error.
Future<bool> _dojoReachable(String baseUrl) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  try {
    final uri = Uri.parse('$baseUrl/openapi.json');
    final req = await client.getUrl(uri);
    final resp = await req.close().timeout(const Duration(seconds: 3));
    await resp.drain<void>();
    return resp.statusCode == 200;
  } on Object {
    return false;
  } finally {
    client.close(force: true);
  }
}

/// Build a minimal valid input for the agentic_chat endpoint.
SimpleRunAgentInput _chatInput({String? runId, String? threadId}) {
  return SimpleRunAgentInput(
    threadId: threadId ?? 'resilience-thread',
    runId:
        runId ?? 'resilience-run-${DateTime.now().millisecondsSinceEpoch}',
    messages: [UserMessage(id: 'u1', content: 'hello resilience test')],
    tools: const [],
    context: const [],
    state: const <String, dynamic>{},
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('AG-UI Dojo resilience', () {
    final baseUrl = _dojoBaseUrl();
    late bool reachable;

    setUpAll(() async {
      reachable = !_skipDojo() && await _dojoReachable(baseUrl);
      if (!reachable) {
        // ignore: avoid_print
        print('[dojo_resilience_test] Dojo not reachable at $baseUrl — '
            'dojo-dependent tests will be skipped. Start the container with:\n'
            '  docker run --rm -p 18000:8000 ag-ui-protocol/ag-ui-server');
      }
    });

    // -----------------------------------------------------------------------
    // Test #1 — 404 on unknown endpoint (requires dojo)
    // -----------------------------------------------------------------------
    test('404 on unknown endpoint surfaces TransportError(statusCode: 404)',
        () async {
      if (!reachable) {
        markTestSkipped('dojo not reachable');
        return;
      }

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );
      try {
        final stream = client.runAgent(
          'agent/does_not_exist_xyz',
          _chatInput(),
        );

        Object? caught;
        try {
          await for (final _ in stream) {
            // consume any events (should not arrive)
          }
        } on TransportError catch (e) {
          caught = e;
        }

        expect(caught, isA<TransportError>(),
            reason: 'unknown endpoint must surface as TransportError');
        expect(
          (caught! as TransportError).statusCode,
          equals(404),
          reason: 'HTTP 404 must be preserved on the error',
        );
      } finally {
        await client.close();
      }
    });

    // -----------------------------------------------------------------------
    // Test #2 — 422 on malformed payload
    // -----------------------------------------------------------------------
    //
    // TODO: Reaching a server-side 422 through the public typed client API is
    // not currently possible without bypassing the Dart type system.
    //
    //  • The server returns 422 for missing `messages` field — but the Dart
    //    client's `SimpleRunAgentInput.toJson()` always emits `messages: []`
    //    even when `input.messages` is null, so that path is unreachable.
    //  • The server returns 422 for invalid `role` values — but all Dart
    //    `Message` subtypes hardcode their roles via sealed class constructors,
    //    making an invalid wire role impossible to construct through the API.
    //  • Sending `parameters: "not-a-schema"` for a tool returns 200 (the
    //    dojo's Pydantic model treats `parameters` as `Any`).
    //
    // A 422 test would require either a custom `http.Client` mock or direct
    // HTTP access that bypasses `AgUiClient` — both are out of scope for this
    // integration-against-the-real-client test file. This case is intentionally
    // omitted rather than contorted.

    // -----------------------------------------------------------------------
    // Test #3 — Mid-stream cancellation (requires dojo)
    // -----------------------------------------------------------------------
    //
    // Behavioral notes (from reading _runAgentInternal + _sendWithCancellation):
    //
    // Once the HTTP response is received and SSE streaming begins, the
    // `_sendWithCancellation` completer is already resolved. Calling
    // cancelToken.cancel() after that point does NOT abort the already-streaming
    // SSE response — the stream may complete naturally (not with CancellationError).
    // Using client.cancelRun() additionally closes the SseClient, which is more
    // effective at terminating the SSE stream.
    test(
        'mid-stream cancelRun terminates stream; second run with same runId succeeds',
        () async {
      if (!reachable) {
        markTestSkipped('dojo not reachable');
        return;
      }

      final runId =
          'resilience-cancel-${DateTime.now().millisecondsSinceEpoch}';
      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final cancelToken = CancelToken();
        final input = SimpleRunAgentInput(
          threadId: 'resilience-cancel-thread',
          runId: runId,
          messages: [
            UserMessage(id: 'u1', content: 'countdown please'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final stream = client.runAgenticChat(input, cancelToken: cancelToken);

        // Wait for the first event, then cancel.
        bool receivedFirstEvent = false;

        try {
          await for (final _ in stream.timeout(const Duration(seconds: 20))) {
            if (!receivedFirstEvent) {
              receivedFirstEvent = true;
              // Cancel after receiving the first event.
              cancelToken.cancel();
              await client.cancelRun(runId);
              // Break out — after cancelRun the SseClient is closed and the
              // stream will terminate (cleanly or with an error) on its own.
              break;
            }
          }
        } on CancellationError {
          // Expected — cancel may surface as CancellationError.
        } on Object {
          // Other termination (SocketException, etc.) after close is fine.
        }

        expect(receivedFirstEvent, isTrue,
            reason: 'must receive at least one event before cancellation');

        // After cancelRun + the async generator's finally block runs,
        // the _requestTokens entry for this runId is cleaned up. Wait briefly
        // to ensure the finally block has executed.
        await Future<void>.delayed(const Duration(milliseconds: 100));

        // Confirm the token is gone by issuing a second run with the SAME
        // runId on a fresh client. A 'unique-in-flight' ValidationError here
        // would indicate the cleanup did not happen as expected.
        final client2 = AgUiClient(
          config: AgUiClientConfig(baseUrl: baseUrl),
        );
        try {
          final input2 = SimpleRunAgentInput(
            threadId: 'resilience-cancel-thread-2',
            runId: runId,
            messages: [
              UserMessage(id: 'u1', content: 'reuse runId after cancel'),
            ],
            tools: const [],
            context: const [],
            state: const <String, dynamic>{},
          );
          final events2 = <BaseEvent>[];
          await for (final event
              in client2
                  .runAgenticChat(input2)
                  .timeout(const Duration(seconds: 30))) {
            events2.add(event);
          }
          // The run should complete without error.
          expect(events2, isNotEmpty,
              reason: 'second run with reused runId must succeed after cancel');
        } finally {
          await client2.close();
        }
      } finally {
        await client.close();
      }
    });

    // -----------------------------------------------------------------------
    // Test #4 — Duplicate runId rejection (no dojo needed)
    // -----------------------------------------------------------------------
    //
    // Behavioral note: the duplicate-runId check lives inside _runAgentInternal,
    // which is an async* function. The ValidationError surfaces via the stream
    // (not as a synchronous throw from runAgent()), so we must subscribe to the
    // stream to observe the error. The spec calls this "synchronous" because
    // putIfAbsent runs in the first microtask of the generator, but from the
    // caller's perspective it arrives via the stream, not via a thrown exception
    // from the runAgent() call site.
    //
    // Implementation note: we use an in-process HttpServer that accepts but
    // never writes, so stream1 stays genuinely in-flight long enough for
    // stream2's subscription to see the duplicate runId. If we pointed at a
    // port that immediately refuses, stream1 could complete (and deregister)
    // before stream2 even starts — making the duplicate undetectable.
    test(
        'duplicate runId emits ValidationError(constraint: unique-in-flight)',
        () async {
      // Bind a server that accepts but never responds — keeps stream1 in-flight.
      final hangServer = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0,
      );
      final hangPort = hangServer.port;
      // Do not await this subscription — the server intentionally never
      // writes, so the listen callback never completes.
      final hangSub = hangServer.listen((req) async {
        await req.drain<void>();
        // Never write — keeps the connection open indefinitely.
      });

      final client = AgUiClient(
        config: AgUiClientConfig(
          baseUrl: 'http://127.0.0.1:$hangPort',
          // Short timeout so stream1 doesn't keep the test alive too long
          // if cleanup fails; long enough to stay in-flight during the test.
          requestTimeout: const Duration(seconds: 5),
          maxRetries: 0,
        ),
      );

      // sub1 is declared outside the try block so the finally can cancel it.
      StreamSubscription<BaseEvent>? sub1;

      try {
        final sharedRunId =
            'dup-run-${DateTime.now().millisecondsSinceEpoch}';

        final input1 = SimpleRunAgentInput(
          threadId: 'dup-thread-1',
          runId: sharedRunId,
          messages: [UserMessage(id: 'u1', content: 'first')],
        );
        final input2 = SimpleRunAgentInput(
          threadId: 'dup-thread-2',
          runId: sharedRunId,
          messages: [UserMessage(id: 'u1', content: 'second')],
        );

        // Collect the stream2 result via a Completer so we can cancel the
        // hanging server BEFORE awaiting the result (avoiding a 5s timeout
        // from stream1 blocking the test).
        final resultCompleter = Completer<Object?>();

        // Subscribe to stream1 — the generator registers the runId before
        // awaiting the HTTP response (no await before putIfAbsent).
        sub1 = client.runAgent('agentic_chat', input1).listen(
          (_) {},
          onError: (_) {}, // expected: swallow stream1 errors
          cancelOnError: true,
        );

        // Yield 200ms so stream1's async* body runs past _validateRunAgentInput
        // and _requestTokens.putIfAbsent, and the HTTP connection is established,
        // before stream2 subscribes. The hanging server's accept() callback must
        // also have run (via the event loop) to confirm stream1 is truly in-flight.
        await Future<void>.delayed(const Duration(milliseconds: 200));

        // Subscribe to stream2 — the hanging server keeps stream1 in-flight,
        // so its runId is still in _requestTokens. Run stream2 in the
        // background so we can proceed to cleanup.
        client.runAgent('agentic_chat', input2).listen(
          (_) {
            if (!resultCompleter.isCompleted) {
              resultCompleter.complete(null); // no event expected
            }
          },
          onError: (Object e) {
            if (!resultCompleter.isCompleted) {
              resultCompleter.complete(e);
            }
          },
          onDone: () {
            if (!resultCompleter.isCompleted) {
              resultCompleter.complete(null);
            }
          },
          cancelOnError: true,
        );

        // Wait for stream2 to produce its error (ValidationError expected).
        // Stream2 should error immediately — no HTTP is made when duplicate
        // is detected — so this completes in a single microtask.
        final result = await resultCompleter.future
            .timeout(const Duration(seconds: 2));

        expect(result, isA<ValidationError>(),
            reason:
                'second stream with same runId must emit ValidationError');
        final ve = result! as ValidationError;
        expect(ve.constraint, equals('unique-in-flight'),
            reason: 'constraint must be unique-in-flight');
        expect(ve.field, equals('runId'),
            reason: 'field must be runId');
      } finally {
        // Force-close the server FIRST so stream1's pending HTTP connection
        // fails (connection reset), which lets the generator exit its await
        // quickly instead of waiting for the timeout.
        await hangSub.cancel();
        await hangServer.close(force: true);
        // close() cancels all in-flight requests (including stream1). The
        // CancellationError from stream1 is handled by sub1's onError handler
        // (which swallows it), preventing unhandled-exception reports.
        await client.close();
        // Allow the event loop to drain stream1 callbacks before the test
        // exits, so sub1's onError fires before sub1 is considered abandoned.
        await Future<void>.delayed(const Duration(milliseconds: 50));
        // Cancel sub1 only after the delay — by now its onError has handled
        // any CancellationError. Using the variable ensures the linter knows
        // sub1 is used (it also suppresses "cancel_subscriptions" warnings).
        await sub1?.cancel();
      }
    });

    // -----------------------------------------------------------------------
    // Test #5 — Client-side input validation (no dojo needed)
    // -----------------------------------------------------------------------

    group('client-side input validation (no HTTP calls)', () {
      late AgUiClient client;

      setUp(() {
        // Point at a non-existent server so any accidental HTTP attempt is
        // visible as a connection failure (should never reach).
        client = AgUiClient(
          config: AgUiClientConfig(
            baseUrl: 'http://127.0.0.1:19999',
            requestTimeout: const Duration(seconds: 2),
          ),
        );
      });

      tearDown(() async => client.close());

      // Helper: assert that a stream emits exactly one ValidationError with
      // the given field and constraint, then terminates.
      Future<void> expectValidationError(
        Stream<BaseEvent> stream, {
        required String field,
        required String constraint,
      }) async {
        Object? caught;
        try {
          await for (final _ in stream) {
            fail('expected ValidationError, got an event');
          }
        } on ValidationError catch (e) {
          caught = e;
        }
        expect(caught, isA<ValidationError>(),
            reason:
                'expected ValidationError(field: $field, constraint: $constraint)');
        final ve = caught! as ValidationError;
        expect(ve.field, equals(field),
            reason: 'field mismatch: got "${ve.field}", want "$field"');
        expect(ve.constraint, equals(constraint),
            reason:
                'constraint mismatch: got "${ve.constraint}", want "$constraint"');
      }

      test('empty endpoint string throws ValidationError synchronously', () {
        // requireNonEmpty(endpoint) fires synchronously in runAgent() before
        // the async generator starts — so this is a synchronous throw.
        expect(
          () => client.runAgent('', _chatInput()),
          throwsA(
            isA<ValidationError>()
                .having((e) => e.field, 'field', 'endpoint')
                .having((e) => e.constraint, 'constraint', 'non-empty'),
          ),
        );
      });

      test('empty message.id emits ValidationError(field: message.id)',
          () async {
        // Empty id on a UserMessage — the Dart type system requires a String
        // but does not prohibit empty strings; the validator catches it.
        final stream = client.runAgent(
          'agentic_chat',
          SimpleRunAgentInput(
            messages: [UserMessage(id: '', content: 'hi')],
          ),
        );
        await expectValidationError(
          stream,
          field: 'message.id',
          constraint: 'non-empty',
        );
      });

      test(
          'duplicate message.id emits ValidationError'
          '(field: message.id, constraint: unique-id)',
          () async {
        final stream = client.runAgent(
          'agentic_chat',
          SimpleRunAgentInput(
            messages: [
              UserMessage(id: 'same-id', content: 'first'),
              UserMessage(id: 'same-id', content: 'second'),
            ],
          ),
        );
        await expectValidationError(
          stream,
          field: 'message.id',
          constraint: 'unique-id',
        );
      });

      test(
          'duplicate toolCall.id within AssistantMessage emits ValidationError',
          () async {
        final stream = client.runAgent(
          'agentic_chat',
          SimpleRunAgentInput(
            messages: [
              const AssistantMessage(
                id: 'a1',
                content: 'calling tools',
                toolCalls: [
                  ToolCall(
                    id: 'tc-dup',
                    function: FunctionCall(name: 'foo', arguments: '{}'),
                  ),
                  ToolCall(
                    id: 'tc-dup',
                    function: FunctionCall(name: 'bar', arguments: '{}'),
                  ),
                ],
              ),
            ],
          ),
        );
        await expectValidationError(
          stream,
          field: 'toolCall.id',
          constraint: 'unique-within-message',
        );
      });

      test('oversized runId (>100 chars) emits ValidationError', () async {
        final longRunId = 'r' * 101;
        final stream = client.runAgent(
          'agentic_chat',
          SimpleRunAgentInput(
            runId: longRunId,
            messages: [UserMessage(id: 'u1', content: 'hi')],
          ),
        );
        await expectValidationError(
          stream,
          field: 'runId',
          constraint: 'max-length-100',
        );
      });

      test('oversized threadId (>100 chars) emits ValidationError', () async {
        final longThreadId = 't' * 101;
        final stream = client.runAgent(
          'agentic_chat',
          SimpleRunAgentInput(
            threadId: longThreadId,
            messages: [UserMessage(id: 'u1', content: 'hi')],
          ),
        );
        await expectValidationError(
          stream,
          field: 'threadId',
          constraint: 'max-length-100',
        );
      });
    });

    // -----------------------------------------------------------------------
    // Test #6 — client.close() is idempotent (no dojo needed)
    // -----------------------------------------------------------------------
    test('client.close() is idempotent — second call must not throw',
        () async {
      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: 'http://127.0.0.1:19999'),
      );
      await client.close();
      // Second close must not throw. If the underlying http.Client.close()
      // throws on a double-close (e.g. IOClient "HTTP client already closed"),
      // this test surfaces that as a real bug rather than swallowing it.
      await client.close();
    });

    // -----------------------------------------------------------------------
    // Test #7 — Timeout via in-process slow server (no dojo needed)
    // -----------------------------------------------------------------------
    test('requestTimeout fires AGUITimeoutError against a silent server',
        () async {
      // Bind a real TCP server that accepts connections but never writes.
      final server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        0, // OS-assigned port
      );
      final port = server.port;

      // Accept connections but never write a response — simulates a hung
      // server. We subscribe on the side; the subscription is not awaited
      // because the stream never completes until force-closed.
      final serverSub = server.listen((request) async {
        // Drain the request body but do not send any response.
        await request.drain<void>();
        // The connection stays open until the server is force-closed.
      });

      final slowClient = AgUiClient(
        config: AgUiClientConfig(
          baseUrl: 'http://127.0.0.1:$port',
          requestTimeout: const Duration(milliseconds: 200),
          // Disable retries — we want exactly one timeout attempt.
          maxRetries: 0,
        ),
      );

      try {
        Object? caught;
        try {
          await for (final _ in slowClient.runAgenticChat(_chatInput())) {
            // no events expected
          }
        } on AGUITimeoutError catch (e) {
          caught = e;
        }

        expect(caught, isA<AGUITimeoutError>(),
            reason: 'silent server must trigger AGUITimeoutError');

        final te = caught! as AGUITimeoutError;
        expect(
          te.timeout,
          equals(const Duration(milliseconds: 200)),
          reason: 'timeout field must match the configured requestTimeout',
        );
        // operation is the full endpoint URL (set by _runAgentInternal's
        // TimeoutException handler: `operation: endpoint`)
        expect(
          te.operation,
          contains('127.0.0.1:$port'),
          reason: 'operation must contain the server address',
        );
      } finally {
        await serverSub.cancel();
        await server.close(force: true);
        await slowClient.close();
      }
    });
  });
}
