/// Client-specific encoding and decoding extensions for AG-UI protocol.
library;

import 'dart:convert';
import '../client/client.dart' show SimpleRunAgentInput;
import '../types/types.dart';

/// Encoder extensions for client operations
class Encoder {
  const Encoder();

  /// Encode RunAgentInput to JSON
  Map<String, dynamic> encodeRunAgentInput(SimpleRunAgentInput input) {
    return input.toJson();
  }

  /// Encode UserMessage to JSON
  Map<String, dynamic> encodeUserMessage(UserMessage message) {
    return message.toJson();
  }

  /// Encode ClientToolResult to JSON
  Map<String, dynamic> encodeToolResult(ClientToolResult result) {
    return {
      'toolCallId': result.toolCallId,
      'result': result.result,
      if (result.error != null) 'error': result.error,
      if (result.metadata != null) 'metadata': result.metadata,
    };
  }
}

/// Decoder extensions for client operations
class Decoder {
  const Decoder();
}

/// ToolResult model for submitting tool execution results to the server.
///
/// Named [ClientToolResult] to distinguish it from [types/tool.dart:ToolResult],
/// which models results received FROM the server (`content: String`). This
/// class is for the outbound direction (`result: dynamic`, `metadata`).
class ClientToolResult {
  final String toolCallId;
  final dynamic result;
  final String? error;
  final Map<String, dynamic>? metadata;

  const ClientToolResult({
    required this.toolCallId,
    required this.result,
    this.error,
    this.metadata,
  });
}
