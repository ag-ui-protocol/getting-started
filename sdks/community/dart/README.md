# ag-ui-dart

Dart SDK for the **Agent-User Interaction (AG-UI) Protocol**.

`ag-ui-dart` provides Dart developers with strongly-typed client implementations for connecting to AG-UI compatible agent servers. Built with modern Dart patterns for robust validation, reactive programming, and seamless server-sent event streaming.

## Installation

```bash
dart pub add ag_ui
```

Or add to your `pubspec.yaml`:

```yaml
dependencies:
  ag_ui: ^0.3.0
```

## Features

- 🎯 **Dart-native** – Idiomatic Dart APIs with full type safety and null safety
- 🔗 **HTTP connectivity** – `AgUiClient` for direct server connections with SSE streaming
- 📡 **Event streaming** – Event-type parity with the canonical Python and TypeScript SDKs (text messages, tool calls, state, activity, reasoning, lifecycle, and more) for real-time agent communication.
- 🔄 **State management** – Automatic message/state tracking with JSON Patch support
- 🛠️ **Tool interactions** – Full support for tool calls and generative UI
- ⚡ **High performance** – Efficient event decoding with backpressure handling

## Quick example

```dart
import 'package:ag_ui/ag_ui.dart';

// Initialize client
final client = AgUiClient(
  config: AgUiClientConfig(
    baseUrl: 'https://api.example.com',
    defaultHeaders: {'Authorization': 'Bearer token'},
  ),
);

// Create and send message
final input = SimpleRunAgentInput(
  messages: [
    UserMessage(
      id: 'msg_123',
      content: 'Hello from Dart!',
    ),
  ],
);

// Stream response events
await for (final event in client.runAgent('agentic_chat', input)) {
  if (event is TextMessageContentEvent) {
    print('Assistant: ${event.delta}');
  }
}
```

## Packages

- **`ag_ui`** – Core client library for AG-UI protocol
- **`ag_ui.client`** – HTTP client with SSE streaming support
- **`ag_ui.events`** – Event types and event handling
- **`ag_ui.types`** – Message types, tools, and data models
- **`ag_ui.encoder`** – Event encoding/decoding utilities

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/dart`](https://docs.ag-ui.com/sdk/dart/client/overview)

## Core Usage

### Initialize Client

```dart
import 'package:ag_ui/ag_ui.dart';

final client = AgUiClient(
  config: AgUiClientConfig(
    baseUrl: 'https://api.example.com',
    defaultHeaders: {'Authorization': 'Bearer token'},
    requestTimeout: Duration(seconds: 30),
  ),
);
```

### Stream Agent Responses

```dart
final input = SimpleRunAgentInput(
  messages: [
    UserMessage(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      content: 'Explain quantum computing',
    ),
  ],
);

await for (final event in client.runAgent('agentic_chat', input)) {
  switch (event.eventType) {
    case EventType.textMessageContent:
      final text = (event as TextMessageContentEvent).delta;
      print(text); // Stream tokens
      break;
    case EventType.runFinished:
      print('Complete');
      break;
  }
}
```

### Activity & Reasoning Events

```dart
import 'dart:io'; // for `stderr` in the example below

await for (final event in client.runAgent('agentic_chat', input)) {
  if (event is ActivitySnapshotEvent) {
    // `content` is `Object?` — the Python reference server may emit a
    // primitive or `null`. Guard before treating it as a structured record.
    final content = event.content;
    if (content is Map<String, dynamic>) {
      // `event.replace == true`  → discard prior content for this messageId.
      // `event.replace == false` → merge/extend on top of existing content.
      print(
        'Activity (${event.activityType}, replace=${event.replace}): $content',
      );
    } else {
      // Wire-protocol surprise: log and skip rather than crash.
      stderr.writeln(
        'ActivitySnapshotEvent.content is ${content.runtimeType}, '
        'expected Map<String, dynamic>',
      );
    }
  } else if (event is ActivityDeltaEvent) {
    print('Activity patch (${event.activityType}): ${event.patch}');
  } else if (event is ReasoningMessageContentEvent) {
    print('Reasoning: ${event.delta}');
  } else if (event is ReasoningEncryptedValueEvent) {
    // Opaque cipher payload — pass through to the next agent rather than
    // attempting to decode locally.
  }
}
```

### Multimodal Input

A `UserMessage` accepts either plain text or an ordered list of typed parts
(text, image, audio, video, document). Use `UserMessage.multimodal` for parts:

```dart
// A base64-encoded payload for an inline data part.
const base64Pdf = 'JVBERi0xLjQKJ...';

final input = SimpleRunAgentInput(
  messages: [
    UserMessage.multimodal(
      id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
      parts: [
        TextInputContent('What is in this image?'),
        ImageInputContent(
          // UrlSource.mimeType is optional; DataSource requires it.
          source: UrlSource(
            value: 'https://example.com/photo.png',
            mimeType: 'image/png',
          ),
        ),
        DocumentInputContent(
          source: DataSource(value: base64Pdf, mimeType: 'application/pdf'),
        ),
      ],
    ),
  ],
);
```

The `content` getter returns the text for text-only messages and `null` for
multimodal ones; read `messageContent` for the typed union.

The default `UserMessage({content})` constructor is not `const` because it
wraps the string in `TextContent` at runtime. Use `UserMessage.fromContent` to
keep a compile-time constant — this is also the migration path if you
previously used `const UserMessage(content: '...')`:

```dart
// Before (no longer const):
// UserMessage(id: 'u-1', content: 'Hello')

// After — const-friendly:
const msg = UserMessage.fromContent(
  id: 'u-1',
  messageContent: TextContent('Hello'),
);
```

### Tool-Based Interactions

```dart
List<ToolCall> toolCalls = [];

// Collect tool calls from first run
await for (final event in client.runToolBasedGenerativeUi(input)) {
  if (event is MessagesSnapshotEvent) {
    for (final msg in event.messages) {
      if (msg is AssistantMessage && msg.toolCalls != null) {
        toolCalls.addAll(msg.toolCalls!);
      }
    }
  }
}

// Process tool calls and send results
final toolResults = toolCalls.map((call) => ToolMessage(
  id: 'tool_${DateTime.now().millisecondsSinceEpoch}',
  toolCallId: call.id,
  content: processToolCall(call),
)).toList();

final followUp = SimpleRunAgentInput(
  threadId: input.threadId,
  messages: [...input.messages, ...toolResults],
);

// Get final response
await for (final event in client.runToolBasedGenerativeUi(followUp)) {
  // Handle response
}
```

### State Management

```dart
Map<String, dynamic> state = {};
List<Message> messages = [];

await for (final event in client.runSharedState(input)) {
  switch (event.eventType) {
    case EventType.stateSnapshot:
      state = (event as StateSnapshotEvent).snapshot;
      break;
    case EventType.stateDelta:
      // Apply JSON Patch (RFC 6902) operations
      applyJsonPatch(state, (event as StateDeltaEvent).delta);
      break;
    case EventType.messagesSnapshot:
      messages = (event as MessagesSnapshotEvent).messages;
      break;
  }
}
```

### Error Handling

The Dart SDK errors form a single hierarchy under [`AGUIError`](https://pub.dev/documentation/ag_ui/latest/ag_ui/AGUIError-class.html). Catch that base if you want one handler for everything; catch the specific subclasses below for targeted recovery. Through [`EventDecoder`](https://pub.dev/documentation/ag_ui/latest/ag_ui/EventDecoder-class.html) the wire-decode side throws [`DecodingError`]; the client-side request/transport layer throws [`TransportError`] and [`ValidationError`]; cancellation surfaces as [`CancellationError`].

```dart
final cancelToken = CancelToken();

try {
  await for (final event in client.runAgent('agent', input, cancelToken: cancelToken)) {
    // Process events
    if (shouldCancel(event)) {
      cancelToken.cancel();
      break;
    }
  }
} on TransportError catch (e) {
  print('Connection error: ${e.message}');
} on DecodingError catch (e) {
  print('Decode error: ${e.message}');
} on ValidationError catch (e) {
  print('Validation error: ${e.message}');
} on CancellationError {
  print('Request cancelled');
} on AGUIError catch (e) {
  // Catch-all for any AG-UI-originated error (covers
  // AGUIValidationError thrown directly from a `Type.fromJson` call
  // when the event isn't routed through the EventDecoder pipeline).
  print('AG-UI error: $e');
}
```

> **Cancellation note:** `CancelToken.cancel()` stops event delivery to your stream, but does **not** abort the underlying HTTP socket. The connection releases when the server closes it or the OS idle-timeout fires. If you need true connection abort, provide a custom `IOClient` per request.

### Proxy notes: wire-spelling normalization

The Dart SDK accepts both **camelCase** (TypeScript-canonical, e.g. `threadId`,
`runId`, `parentRunId`, `encryptedValue`, `rawEvent`) and **snake_case**
(Python-canonical, e.g. `thread_id`, `run_id`, `parent_run_id`,
`encrypted_value`, `raw_event`) on every `fromJson` factory, but always
emits **camelCase** on `toJson` — there is no opt-in to snake_case wire
output.

If you use the Dart SDK as a proxy between a snake_case-emitting Python
server and a strictly snake_case-only consumer, you must convert keys
back at the boundary. The TypeScript and Python canonical SDKs both
tolerate the camelCase form on input, so this is rarely an issue in
practice — but a strict snake_case consumer is technically protocol-valid
and will see a normalized payload from a Dart middle-tier.

Within a single `BaseEvent.rawEvent` round-trip the spelling is
preserved by the helper that reads both keys (`rawEvent` /
`raw_event`); the camelCase emit on the Dart side is the only
normalization point.

## Complete Example

```dart
import 'dart:io';
import 'package:ag_ui/ag_ui.dart';

void main() async {
  // Initialize client from environment
  final client = AgUiClient(
    config: AgUiClientConfig(
      baseUrl: Platform.environment['AGUI_BASE_URL'] ?? 'http://localhost:8000',
      defaultHeaders: Platform.environment['AGUI_API_KEY'] != null
          ? {'Authorization': 'Bearer ${Platform.environment['AGUI_API_KEY']}'}
          : null,
    ),
  );

  // Interactive chat loop
  stdout.write('You: ');
  final userInput = stdin.readLineSync() ?? '';

  final input = SimpleRunAgentInput(
    messages: [
      UserMessage(
        id: 'msg_${DateTime.now().millisecondsSinceEpoch}',
        content: userInput,
      ),
    ],
  );

  stdout.write('Assistant: ');
  await for (final event in client.runAgent('agentic_chat', input)) {
    if (event is TextMessageContentEvent) {
      stdout.write(event.delta);
    } else if (event is ToolCallStartEvent) {
      print('\nCalling tool: ${event.toolCallName}');
    } else if (event.eventType == EventType.runFinished) {
      print('\nDone!');
      break;
    }
  }

  client.dispose();
}
```

## Migrating from 0.1.0

0.2.0 introduces one source-breaking change for callers that construct
events directly:

- **`ToolCallResultEvent.role` is now `ToolCallResultRole?` instead of
  `String?`.** Update direct constructions:

  ```dart
  // Before (0.1.0)
  ToolCallResultEvent(
    messageId: '...',
    toolCallId: '...',
    content: '...',
    role: 'tool',
  );

  // After (0.2.0)
  ToolCallResultEvent(
    messageId: '...',
    toolCallId: '...',
    content: '...',
    role: ToolCallResultRole.tool,
  );
  ```

  Wire decoding is unaffected: an unknown `role` string on the wire is
  absorbed via `ToolCallResultRole.fromString` and falls back to
  `ToolCallResultRole.tool` for forward compatibility. See
  [`CHANGELOG.md`](CHANGELOG.md) "Breaking Changes" for the full
  rationale.

- **`TimeoutError` was renamed to `AGUITimeoutError`** to avoid
  shadowing `dart:async.TimeoutError` (raised by `Future.timeout(...)` /
  `Stream.timeout(...)`). The bare name is preserved as a deprecated
  typedef alias and will be removed in 1.0.0:

  ```dart
  // Before (0.1.0)
  } on TimeoutError catch (e) { /* ... */ }

  // After (0.2.0)
  } on AGUITimeoutError catch (e) { /* ... */ }
  ```

  If you import both `package:ag_ui/ag_ui.dart` and `dart:async`, prefer
  the new name to avoid a symbol collision and to ensure raw
  `dart:async.TimeoutError` instances (very common from any
  `.timeout(...)` call) are not silently absorbed by an `on TimeoutError`
  arm targeting the SDK type.

  Note for the inverse case: if you previously meant
  `dart:async.TimeoutError` and were accidentally catching SDK instances
  (because `package:ag_ui/ag_ui.dart`'s `TimeoutError` won the unqualified
  name resolution), the rename surfaces the prior collision. After you
  migrate to `AGUITimeoutError`, the bare `TimeoutError` arm now
  unambiguously refers to `dart:async.TimeoutError` — runtime behavior
  changes accordingly.

The `THINKING_TEXT_MESSAGE_*` event types are also deprecated in 0.2.0
in favor of the canonical `REASONING_*` events; decoding remains
supported until 1.0.0. See `CHANGELOG.md` "Deprecated" for the migration
mapping.

## Errors

The SDK exposes a small error hierarchy that is intentionally split by origin:

- `AGUIError` — the SDK-wide root. Catching `on AGUIError` covers every
  error the SDK can raise: runtime, transport, decoding, AND direct-factory
  validation. Use this when you want a single catch-all.
- `AgUiError` — extends `AGUIError`. Covers runtime / transport / decoding:
  `TransportError`, `AGUITimeoutError`, `CancellationError`, `DecodingError`,
  and the client-side `ValidationError`. Catch this when you want to scope
  to "the SDK encountered a runtime problem" but explicitly do NOT want to
  catch direct-factory validation errors. (`TimeoutError` is preserved as
  a deprecated alias for `AGUITimeoutError`; prefer the new name to avoid
  shadowing `dart:async.TimeoutError`.)
- `AGUIValidationError` — extends `AGUIError` (NOT `AgUiError`). Thrown by
  `*.fromJson` factory constructors at the wire-decoding boundary. When
  events flow through `EventDecoder`, this is wrapped as `DecodingError`,
  so consumers using the decoder pipeline never see this directly. Direct
  factory callers (`TextMessageStartEvent.fromJson(...)`) do.
- `EncoderError` and its subtypes (`DecodeError`, `EncodeError`,
  encoder-side `ValidationError`) extend `AGUIError`. The `EventDecoder`
  pipeline rethrows these unchanged so callers can pattern-match by type.

Recommended catch recipe in production code that uses `EventDecoder`:

```dart
try {
  for (final event in stream) { handle(event); }
} on DecodingError catch (e) {
  // Wire-format problem — log e.field, e.expectedType, e.actualValue.
} on TransportError catch (e) {
  // HTTP / SSE transport failure.
} on AgUiError catch (e) {
  // Anything else from the runtime/transport family.
} on AGUIError catch (e) {
  // Catch-all (would also catch direct-factory AGUIValidationError if you
  // ever bypass the decoder).
}
```

## Examples

See the [`example/`](example/) directory for:
- Interactive CLI for testing AG-UI servers
- Tool-based generative UI flows
- Message streaming patterns
- Complete end-to-end demonstrations

## Testing

```bash
# Run unit tests
dart test

# Run integration tests (requires server)
cd test/integration
./helpers/start_server.sh
dart test
./helpers/stop_server.sh
```

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Cipher-data preservation

Some AG-UI events (`ReasoningEncryptedValueEvent`, `ReasoningMessage`, `ToolMessage`) carry
opaque cipher payloads that must be forwarded verbatim between agents. This SDK implements
defense-in-depth around those payloads:

**Success paths** — the `rawEvent` field on every `BaseEvent` is set to the verbatim
wire-format map read from the SSE stream. A proxy that needs to re-emit a
`ReasoningEncryptedValueEvent` should read `rawEvent` (or maintain its own copy of the raw
bytes) and forward it unchanged rather than calling `toJson()`, which emits only the
parsed fields.

**Error paths** — when a factory (`fromJson`) fails to decode an event, the thrown
`AGUIValidationError` intentionally omits the raw JSON map (`json:` field) for any event
that may carry cipher data. This prevents raw cipher bytes from leaking through
reflection-based log shippers or error serializers that walk the exception cause chain.

**`ReasoningEncryptedValueEvent` specifically** sets `rawEvent: null` unconditionally —
unlike every other factory, forwarding `_readRawEvent(json)` would store the full cipher
payload in-memory on `BaseEvent.rawEvent`, undoing the per-field cipher scrubbing above.
Proxy operators that need the verbatim wire form must maintain their own copy before
calling `fromJson`.

**`copyWith` and `rawEvent`** — the `copyWith` methods across all event types treat
`rawEvent` as "sticky": passing `null` keeps the existing value (i.e. `rawEvent ?? this.rawEvent`).
To clear `rawEvent`, construct the event directly with `rawEvent: null`. This prevents an
accidental `copyWith()` call from silently preserving a cipher payload that the caller
intended to drop.

## License

This SDK is part of the AG-UI Protocol project. See the [main repository](https://github.com/ag-ui-protocol/ag-ui) for license information.


