import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:math';
import 'package:http/http.dart' as http;
import 'package:meta/meta.dart';

import '../encoder/client_codec.dart' as codec;
import '../encoder/stream_adapter.dart' show EventStreamAdapter;
import '../events/events.dart';
import '../sse/sse_client.dart';
import '../sse/sse_message.dart';
import '../types/types.dart';
import 'config.dart';
import 'errors.dart';
import 'validators.dart';

/// Main client for interacting with AG-UI servers.
///
/// The AgUiClient provides methods to connect to AG-UI compatible servers
/// and stream events in real-time using Server-Sent Events (SSE).
///
/// Example:
/// ```dart
/// final client = AgUiClient(
///   config: AgUiClientConfig(
///     baseUrl: 'http://localhost:8000',
///   ),
/// );
///
/// final input = SimpleRunAgentInput(
///   messages: [UserMessage(id: 'msg_1', content: 'Hello')],
/// );
///
/// await for (final event in client.runAgent('agent', input)) {
///   print('Event: ${event.type}');
/// }
/// ```
class AgUiClient {
  final AgUiClientConfig config;
  final http.Client _httpClient;
  final codec.Encoder _encoder;
  final codec.Decoder _decoder;
  final EventStreamAdapter _streamAdapter;
  final Map<String, SseClient> _activeStreams = {};
  final Map<String, CancelToken> _requestTokens = {};

  AgUiClient({
    required this.config,
    http.Client? httpClient,
    codec.Encoder? encoder,
    codec.Decoder? decoder,
    EventStreamAdapter? streamAdapter,
  })  : _httpClient = httpClient ?? http.Client(),
        _encoder = encoder ?? const codec.Encoder(),
        _decoder = decoder ?? const codec.Decoder(),
        _streamAdapter = streamAdapter ?? EventStreamAdapter();

  /// Run an agent with the given input and stream the response events.
  ///
  /// [endpoint] - The agent endpoint to connect to (e.g., 'agentic_chat')
  /// [input] - The input containing messages and optional state
  /// [cancelToken] - Optional token to cancel the request
  ///
  /// Returns a stream of [BaseEvent] objects representing the agent's response.
  ///
  /// Throws:
  /// - [ValidationError] if the input is invalid (URL, message shape, etc.)
  /// - [TransportError] if the HTTP/SSE connection fails or the server
  ///   returns a non-success status
  /// - [DecodingError] if an SSE payload cannot be decoded into a
  ///   [BaseEvent]
  /// - [CancellationError] if the request is cancelled via [cancelToken]
  ///
  /// All four extend [AGUIError] — catch that base for one-shot
  /// handling.
  Stream<BaseEvent> runAgent(
    String endpoint,
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    // Validate inputs
    Validators.validateUrl(config.baseUrl, 'baseUrl');
    Validators.requireNonEmpty(endpoint, 'endpoint');

    // Tighten the scheme test: `startsWith('http')` would accept httpfoo://
    // and also skips the Validators.validateUrl defense-in-depth applied to
    // config.baseUrl above. Run the same check for caller-supplied full URLs.
    final isAbsolute =
        endpoint.startsWith('http://') || endpoint.startsWith('https://');
    if (isAbsolute) {
      Validators.validateUrl(endpoint, 'endpoint');
    }
    final fullEndpoint = isAbsolute ? endpoint : '${config.baseUrl}/$endpoint';

    return _runAgentInternal(fullEndpoint, input, cancelToken: cancelToken);
  }

  /// Run the agentic chat agent.
  ///
  /// Convenience method for the 'agentic_chat' endpoint.
  Stream<BaseEvent> runAgenticChat(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('agentic_chat', input, cancelToken: cancelToken);
  }

  /// Run the human-in-the-loop agent.
  ///
  /// Convenience method for the 'human_in_the_loop' endpoint.
  Stream<BaseEvent> runHumanInTheLoop(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('human_in_the_loop', input, cancelToken: cancelToken);
  }

  /// Run the agentic generative UI agent.
  ///
  /// Convenience method for the 'agentic_generative_ui' endpoint.
  Stream<BaseEvent> runAgenticGenerativeUi(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('agentic_generative_ui', input, cancelToken: cancelToken);
  }

  /// Run the tool-based generative UI agent.
  ///
  /// Convenience method for the 'tool_based_generative_ui' endpoint.
  Stream<BaseEvent> runToolBasedGenerativeUi(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('tool_based_generative_ui', input,
        cancelToken: cancelToken);
  }

  /// Run the shared state agent.
  ///
  /// Convenience method for the 'shared_state' endpoint.
  Stream<BaseEvent> runSharedState(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('shared_state', input, cancelToken: cancelToken);
  }

  /// Run the predictive state updates agent.
  ///
  /// Convenience method for the 'predictive_state_updates' endpoint.
  Stream<BaseEvent> runPredictiveStateUpdates(
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) {
    return runAgent('predictive_state_updates', input,
        cancelToken: cancelToken);
  }

  /// Internal implementation for running an agent
  Stream<BaseEvent> _runAgentInternal(
    String endpoint,
    SimpleRunAgentInput input, {
    CancelToken? cancelToken,
  }) async* {
    final runId = input.runId ?? _generateRunId();
    cancelToken ??= CancelToken();

    // Validate BEFORE registering in _requestTokens so a caller-supplied
    // bad runId (empty, over-length, control chars) never enters the map.
    _validateRunAgentInput(input);

    // Reject a caller-supplied runId that collides with an in-flight run.
    // `putIfAbsent` collapses the check-then-insert into a single map
    // operation, eliminating the cross-tick race window that would exist
    // between a `containsKey` check and the subsequent `[]=` assignment.
    final existing = _requestTokens.putIfAbsent(runId, () => cancelToken!);
    if (!identical(existing, cancelToken)) {
      throw ValidationError(
        'Duplicate runId "$runId": another run with the same id is in flight',
        field: 'runId',
        constraint: 'unique-in-flight',
        value: runId,
      );
    }

    try {
      // Send POST request with RunAgentInput
      final headers = _buildHeaders();
      headers['Content-Type'] = 'application/json';
      headers.putIfAbsent('Accept', () => 'text/event-stream');

      final uri = Uri.parse(endpoint);
      final request = http.Request('POST', uri)
        ..headers.addAll(headers)
        ..body = json.encode(_encoder.encodeRunAgentInput(input));

      // Send with timeout and cancellation support
      final streamedResponse = await _sendWithCancellation(
        request,
        cancelToken,
        config.requestTimeout,
      );

      // Validate response status
      if (streamedResponse.statusCode >= 400) {
        final body = await streamedResponse.stream.bytesToString();
        throw TransportError(
          'Agent request failed',
          endpoint: endpoint,
          statusCode: streamedResponse.statusCode,
          responseBody: _truncateBody(body),
        );
      }

      // Create SSE client from response stream
      final sseClient = SseClient(
        idleTimeout: config.connectionTimeout,
        backoffStrategy: config.backoffStrategy,
        maxDataCodeUnits: _streamAdapter.maxDataCodeUnits,
      );
      _activeStreams[runId] = sseClient;

      // Parse SSE from response stream
      final sseStream = sseClient.parseStream(
        streamedResponse.stream,
        headers: streamedResponse.headers,
      );

      // Transform to AG-UI events
      yield* _transformSseStream(sseStream, runId);
    } on AgUiError {
      rethrow;
    } on TimeoutException {
      throw AGUITimeoutError(
        'Agent request timed out',
        timeout: config.requestTimeout,
        operation: endpoint,
      );
    } catch (e) {
      if (cancelToken.isCancelled) {
        throw CancellationError('Request was cancelled', operation: endpoint);
      }
      throw TransportError(
        'Failed to run agent',
        endpoint: endpoint,
        cause: e,
      );
    } finally {
      _requestTokens.remove(runId);
      await _closeStream(runId);
    }
  }

  /// Send request with cancellation support.
  ///
  /// **Known limitation**: cancellation only drops the response at the
  /// Dart completer level — the underlying HTTP connection is NOT aborted.
  /// The `http.Client` interface does not expose per-request abort; closing
  /// the shared `_httpClient` would affect all concurrent requests. In
  /// practice the OS/server timeout eventually cleans up the socket. A
  /// future refactor to per-request `IOClient` instances could add true
  /// abort support.
  ///
  /// Late-arriving responses or errors from the HTTP future after
  /// cancellation are silently swallowed by the `onError` handler below
  /// to prevent unhandled-future-error warnings.
  Future<http.StreamedResponse> _sendWithCancellation(
    http.Request request,
    CancelToken cancelToken,
    Duration timeout,
  ) async {
    final completer = Completer<http.StreamedResponse>();

    final future = _httpClient.send(request).timeout(timeout);

    unawaited(cancelToken.onCancel.then((_) {
      if (!completer.isCompleted) {
        completer.completeError(
          CancellationError('Request cancelled',
              operation: request.url.toString()),
        );
      }
    }));

    unawaited(future.then(
      (response) {
        if (!completer.isCompleted) {
          completer.complete(response);
        } else {
          // Late response after cancellation — caller already received
          // CancellationError. Log so silent swallows are observable in
          // dev tools / dart:developer listeners without surfacing to the
          // stream consumer.
          developer.log(
            'Late HTTP response after cancellation; discarding '
            '(status ${response.statusCode})',
            name: 'ag_ui.client',
          );
          // Immediately subscribe-and-cancel to signal the underlying platform
          // to close the socket. Do NOT await drain() — for SSE responses the
          // body stream never ends until the server disconnects, so drain()
          // would hold the socket open indefinitely.
          unawaited(
            response.stream.listen((_) {}).cancel().catchError((_) {}),
          );
        }
      },
      onError: (Object error) {
        if (!completer.isCompleted) {
          completer.completeError(error);
        } else {
          // Late error after cancellation — log for debuggability.
          developer.log(
            'Late HTTP error after cancellation; discarded: $error',
            name: 'ag_ui.client',
          );
        }
      },
    ));

    return completer.future;
  }

  /// Cancel an active agent run
  Future<void> cancelRun(String runId) async {
    // Cancel the request token if it exists
    final token = _requestTokens[runId];
    if (token != null && !token.isCancelled) {
      token.cancel();
    }

    // Close any active stream
    await _closeStream(runId);
  }

  /// Transform SSE messages to typed AG-UI events.
  ///
  /// Lifecycle note: `_runAgentInternal` owns the `runId`/`SseClient` pair
  /// and calls `_closeStream` in its own `finally` block. This method does
  /// NOT clean up — do not add a `finally` here to avoid a redundant second
  /// `_closeStream` call.
  Stream<BaseEvent> _transformSseStream(
    Stream<SseMessage> sseStream,
    String runId,
  ) async* {
    await for (final message in sseStream) {
      if (message.data == null || message.data!.isEmpty) {
        continue;
      }
      // Mirror the keep-alive filter in EventStreamAdapter.fromSseStream:
      // some servers emit `data: :` as a keep-alive sentinel alongside
      // spec-correct comment-only keep-alives. Passing it to json.decode
      // raises FormatException and wraps it as a spurious DecodingError.
      if (message.data!.trim() == ':') {
        continue;
      }

      try {
        // Parse the SSE data as JSON
        final jsonData = json.decode(message.data!);

        // Use the stream adapter to convert to typed events
        final events = _streamAdapter.adaptJsonToEvents(jsonData);

        for (final event in events) {
          yield event;
        }
      } on AGUIError catch (e) {
        // Re-throw any AG-UI error (AGUIValidationError, EncoderError,
        // AgUiError, …) unchanged so field info is preserved. The former
        // `on AgUiError` clause silently wrapped AGUIValidationError (which
        // extends AGUIError but not AgUiError) as a generic DecodingError,
        // discarding the structured field path.
        yield* Stream.error(e);
      } catch (e) {
        // Wrap other errors
        yield* Stream.error(DecodingError(
          'Failed to decode SSE message',
          field: 'message.data',
          expectedType: 'BaseEvent',
          // Avoid forwarding the raw payload — may contain encryptedValue.
          actualValue: '<${message.data?.length ?? 0} chars>',
          cause: e,
        ));
      }
    }
  }

  /// Send an HTTP request with retries
  ///
  /// Exposed for testing HTTP retry logic
  @visibleForTesting
  Future<http.Response> sendRequest(
    String method,
    String endpoint, {
    Map<String, dynamic>? body,
  }) async {
    final headers = _buildHeaders();
    if (body != null) {
      headers['Content-Type'] = 'application/json';
    }

    int attempts = 0;
    Duration? nextDelay;

    while (attempts <= config.maxRetries) {
      try {
        // Add delay for retries
        if (nextDelay != null) {
          await Future.delayed(nextDelay);
        }

        final uri = Uri.parse(endpoint);
        final request = http.Request(method, uri)..headers.addAll(headers);

        if (body != null) {
          request.body = json.encode(body);
        }

        final streamedResponse =
            await _httpClient.send(request).timeout(config.requestTimeout);

        final response = await http.Response.fromStream(streamedResponse);

        // Success or client error (don't retry)
        if (response.statusCode < 500) {
          return response;
        }

        // Server error - retry
        attempts++;
        if (attempts <= config.maxRetries) {
          nextDelay = config.backoffStrategy.nextDelay(attempts);
        } else {
          throw TransportError(
            'Request failed after ${config.maxRetries} retries',
            endpoint: endpoint,
            statusCode: response.statusCode,
            responseBody: _truncateBody(response.body),
          );
        }
      } on TimeoutException {
        attempts++;
        if (attempts > config.maxRetries) {
          throw AGUITimeoutError(
            'Request timed out after ${config.maxRetries} attempts',
            timeout: config.requestTimeout,
            operation: '$method $endpoint',
          );
        }
        nextDelay = config.backoffStrategy.nextDelay(attempts);
      } catch (e) {
        if (e is AgUiError) rethrow;

        attempts++;
        if (attempts > config.maxRetries) {
          throw TransportError(
            'Connection failed after ${config.maxRetries} attempts',
            endpoint: endpoint,
            cause: e,
          );
        }
        nextDelay = config.backoffStrategy.nextDelay(attempts);
      }
    }

    throw TransportError(
      'Unexpected error in request retry logic',
      endpoint: endpoint,
    );
  }

  /// Handle HTTP response and decode
  T _handleResponse<T>(
    http.Response response,
    String endpoint,
    T Function(Map<String, dynamic>) decoder,
  ) {
    // Validate status code
    Validators.validateStatusCode(response.statusCode, endpoint, response.body);

    try {
      final data = Validators.validateJson(
        json.decode(response.body),
        'response',
      );
      return decoder(data);
    } on AgUiError {
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to decode response',
        field: 'response.body',
        expectedType: 'JSON object',
        actualValue: response.body,
        cause: e,
      );
    }
  }

  /// Validate RunAgentInput
  void _validateRunAgentInput(SimpleRunAgentInput input) {
    // Validate thread ID if present — use validateThreadId (100-char cap) for
    // consistency with validateRunId; both flow into the same map-key spaces.
    if (input.threadId != null) {
      Validators.validateThreadId(input.threadId!);
    }

    // Validate caller-supplied runId if present — it flows into _activeStreams
    // and _requestTokens as a map key, so an empty or oversized value must be
    // rejected at the boundary rather than silently stored.
    if (input.runId != null) {
      Validators.validateRunId(input.runId!);
    }

    if (input.parentRunId != null) {
      Validators.requireNonEmpty(input.parentRunId!, 'parentRunId');
    }

    // Validate messages using an exhaustive sealed switch so every concrete
    // subtype is explicitly covered. A partial `is UserMessage` check implied
    // validation coverage that didn't exist — this makes the boundary clear.
    if (input.messages != null) {
      final seenMessageIds = <String>{};
      for (final message in input.messages!) {
        // `Message.id` is declared nullable (to accommodate inbound
        // MESSAGES_SNAPSHOT payloads where the server may omit the field),
        // but outbound messages MUST carry a non-empty id: the server uses
        // it as the stable identity key for conversation history.
        // `requireNonEmpty` rejects both null and empty-string.
        Validators.requireNonEmpty(message.id, 'message.id');
        if (!seenMessageIds.add(message.id!)) {
          throw ValidationError(
            'Duplicate message.id "${message.id}"',
            field: 'message.id',
            constraint: 'unique-id',
            value: message.id,
          );
        }
        switch (message) {
          case UserMessage():
            Validators.validateUserMessageContent(message.messageContent);
          case AssistantMessage(:final content, :final toolCalls):
            // content is String? on AssistantMessage (all other subtypes have
            // non-nullable content) — guard avoids passing null to
            // validateMessageContent on valid assistant messages that omit it.
            if (content != null) Validators.validateMessageContent(content);
            if (toolCalls != null) {
              final seenToolCallIds = <String>{};
              for (final tc in toolCalls) {
                if (!seenToolCallIds.add(tc.id)) {
                  throw ValidationError(
                    'Duplicate toolCall.id "${tc.id}" within AssistantMessage',
                    field: 'toolCall.id',
                    constraint: 'unique-within-message',
                    value: tc.id,
                  );
                }
              }
            }
          case DeveloperMessage(:final content):
            Validators.validateMessageContent(content);
          case SystemMessage(:final content):
            Validators.validateMessageContent(content);
          case ToolMessage(:final content):
            Validators.validateMessageContent(content);
          case ReasoningMessage(:final content):
            // content is String? on ReasoningMessage (optional reasoning text)
            if (content != null) Validators.validateMessageContent(content);
          case ActivityMessage():
            // ActivityMessage carries structured activityContent (Map), not
            // a string content field — nothing to validate here.
            break;
        }
      }
    }
  }

  /// Lazily initialized secure RNG, shared across all `_generateRunId`
  /// calls on this instance. `Random.secure()` seeds from the OS CSPRNG
  /// on first access; creating one per call wastes that OS round-trip.
  static final _secureRandom = Random.secure();

  /// Generate a unique run ID using a timestamp + 8 cryptographically
  /// random bytes. The random suffix prevents collisions for concurrent
  /// calls within the same millisecond, which is important because run IDs
  /// are used as map keys in `_activeStreams` / `_requestTokens` — a
  /// collision would silently overwrite an in-flight stream entry.
  String _generateRunId() {
    final timestamp = DateTime.now().millisecondsSinceEpoch;
    final hex = List.generate(
      8,
      (_) => _secureRandom.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    return 'run_${timestamp}_$hex';
  }

  /// Truncate response body for error messages
  String _truncateBody(String body, {int maxLength = 500}) {
    if (maxLength <= 0) return '...';
    if (body.length <= maxLength) return body;
    var end = maxLength;
    final cu = body.codeUnitAt(end - 1);
    if (cu >= 0xD800 && cu <= 0xDBFF) end--; // avoid splitting surrogate pair
    return '${body.substring(0, end)}...';
  }

  /// Build headers for requests
  Map<String, String> _buildHeaders() {
    return {
      ...config.defaultHeaders,
      'Accept': 'application/json, text/event-stream',
    };
  }

  /// Close a specific stream
  Future<void> _closeStream(String runId) async {
    final client = _activeStreams.remove(runId);
    await client?.close();
  }

  /// Close all resources
  Future<void> close() async {
    // Cancel all active requests
    for (final token in _requestTokens.values) {
      token.cancel();
    }
    _requestTokens.clear();

    // Close all active streams
    final closeOps = _activeStreams.values.map((c) => c.close());
    await Future.wait(closeOps);
    _activeStreams.clear();

    // Close HTTP client
    _httpClient.close();
  }
}

/// Cancel token for request cancellation.
///
/// **One-shot contract**: a [CancelToken] must be used with exactly ONE
/// request. Once [cancel] is called the token is permanently cancelled —
/// passing the same token to a second [AgUiClient.runAgent] call will
/// cause that call to see [isCancelled] as `true` immediately and
/// complete with a [CancellationError] before the HTTP request is sent.
///
/// **Listener accumulation**: [_sendWithCancellation] attaches a single
/// `.then` handler to [onCancel] per request via [unawaited]. Because
/// [CancelToken] is one-shot (one request, one cancel), the handler is
/// never re-attached across multiple calls, so no listener accumulation
/// occurs as long as the one-shot contract is honored.
class CancelToken {
  final _completer = Completer<void>();
  bool _isCancelled = false;

  bool get isCancelled => _isCancelled;
  Future<void> get onCancel => _completer.future;

  void cancel() {
    if (!_isCancelled) {
      _isCancelled = true;
      if (!_completer.isCompleted) {
        _completer.complete();
      }
    }
  }
}

/// Simplified input for running an agent via HTTP endpoint
class SimpleRunAgentInput {
  final String? threadId;
  final String? runId;
  final String? parentRunId;
  final List<Message>? messages;
  final List<Tool>? tools;
  final List<Context>? context;
  final dynamic state;
  final Map<String, dynamic>? config;
  final Map<String, dynamic>? metadata;
  final dynamic forwardedProps;

  const SimpleRunAgentInput({
    this.threadId,
    this.runId,
    this.parentRunId,
    this.messages,
    this.tools,
    this.context,
    this.state,
    this.config,
    this.metadata,
    this.forwardedProps,
  });

  Map<String, dynamic> toJson() {
    // `state`, `messages`, `tools`, `context`, and `forwardedProps` are
    // declared required (non-optional) by the canonical TS RunAgentInputSchema
    // and the Python pydantic model. Always emit them — falling back to empty
    // containers when null — so strict servers (pydantic BaseModel with
    // required fields) do not reject the payload with 422. Optional fields
    // (`threadId`, `runId`, `parentRunId`, `config`, `metadata`) are only
    // emitted when set; the server treats their absence as "not provided".
    assert(
      state == null || state is Map<String, dynamic>,
      'SimpleRunAgentInput.state must be Map<String, dynamic> or null; '
      'got ${state.runtimeType}',
    );
    assert(
      forwardedProps == null || forwardedProps is Map<String, dynamic>,
      'SimpleRunAgentInput.forwardedProps must be Map<String, dynamic> or null; '
      'got ${forwardedProps.runtimeType}',
    );
    return {
      if (threadId != null) 'threadId': threadId,
      if (runId != null) 'runId': runId,
      if (parentRunId != null) 'parentRunId': parentRunId,
      'state': state ?? const <String, dynamic>{},
      'messages': messages?.map((m) => m.toJson()).toList() ?? const <Map<String, dynamic>>[],
      'tools': tools?.map((t) => t.toJson()).toList() ?? const <Map<String, dynamic>>[],
      'context': context?.map((c) => c.toJson()).toList() ?? const <Map<String, dynamic>>[],
      'forwardedProps': forwardedProps ?? const <String, dynamic>{},
      if (config != null) 'config': config,
      if (metadata != null) 'metadata': metadata,
    };
  }
}
