/// AG-UI Dart SDK - Standardizing agent-user interactions
///
/// This library provides strongly-typed Dart models for the AG-UI protocol,
/// enabling agent-user interaction through a standardized event-based system.
///
/// ## Features
///
/// - **Core Protocol Support**: Full implementation of AG-UI event types
/// - **HTTP Client**: Production-ready client with SSE streaming support
/// - **Event Streaming**: Real-time event processing with backpressure handling
/// - **Tool Interactions**: Support for tool calls with generative UI
/// - **State Management**: Handle snapshots and deltas (JSON Patch RFC 6902)
/// - **Type Safety**: Strongly-typed models for all protocol entities
///
/// ## Getting Started
///
/// ```dart
/// import 'package:ag_ui/ag_ui.dart';
///
/// final client = AgUiClient(
///   config: AgUiClientConfig(
///     baseUrl: 'http://localhost:8000',
///   ),
/// );
///
/// final input = SimpleRunAgentInput(
///   messages: [
///     UserMessage(
///       id: 'msg_1',
///       content: 'Hello, world!',
///     ),
///   ],
/// );
///
/// await for (final event in client.runAgent('agent', input)) {
///   print('Event: ${event.type}');
/// }
/// ```
library ag_ui;

// Core types
export 'src/types/types.dart';

// Event types
export 'src/events/events.dart';

// Encoder/Decoder
export 'src/encoder/encoder.dart';
export 'src/encoder/decoder.dart';
export 'src/encoder/stream_adapter.dart';
// Hide ValidationError from encoder/errors.dart since we're using the one from client/errors.dart
export 'src/encoder/errors.dart' hide ValidationError;

// SSE client
export 'src/sse/sse_client.dart';
export 'src/sse/sse_message.dart';
export 'src/sse/backoff_strategy.dart';

// Client API
export 'src/client/client.dart';
export 'src/client/config.dart';
export 'src/client/errors.dart';
export 'src/client/validators.dart';

// Client codec — ClientToolResult is an outbound-only model used by
// Encoder.encodeToolResult; it must remain visible so callers can construct
// values to pass to that method.
export 'src/encoder/client_codec.dart';

// Core exports will be added in subsequent tasks
// export 'src/agent.dart';
// export 'src/transport.dart';

/// SDK version
const String agUiVersion = '0.3.0';

/// Initialize the AG-UI SDK
void initAgUI() {
  // Initialization logic will be implemented in subsequent tasks
}
