/// Event encoder for AG-UI protocol.
///
/// Encodes Dart models to wire format (SSE or binary).
library;

import 'dart:convert';
import 'dart:typed_data';

import '../events/events.dart';
import 'errors.dart';

/// The AG-UI protobuf media type constant.
const String aguiMediaType = 'application/vnd.ag-ui.event+proto';

/// Encoder for AG-UI events.
///
/// Supports encoding events to SSE (Server-Sent Events) format
/// and binary format (protobuf or SSE as bytes).
class EventEncoder {
  /// Whether this encoder accepts protobuf format.
  ///
  /// **Important:** Setting this to `true` (via an `Accept:
  /// application/vnd.ag-ui.event+proto` header) makes [encodeBinary] fall
  /// back to SSE-as-bytes, not real protobuf. [EventDecoder.decodeBinary]
  /// similarly has NO protobuf support — a server emitting real protobuf bytes
  /// will fail with a misleading "Invalid UTF-8 data" error. Do not negotiate
  /// `acceptsProtobuf=true` until protobuf support is implemented end-to-end.
  final bool acceptsProtobuf;

  /// Creates an encoder with optional format preferences.
  ///
  /// [accept] - Optional Accept header value to determine format preferences.
  EventEncoder({String? accept})
      : acceptsProtobuf = accept != null && _isProtobufAccepted(accept);

  /// Gets the content type for this encoder.
  String getContentType() {
    if (acceptsProtobuf) {
      return aguiMediaType;
    } else {
      return 'text/event-stream';
    }
  }

  /// Encodes an event to string format (SSE).
  String encode(BaseEvent event) {
    return encodeSSE(event);
  }

  /// Encodes an event to SSE format.
  ///
  /// The SSE format is:
  /// ```
  /// data: {"type":"...", ...}
  ///
  /// ```
  String encodeSSE(BaseEvent event) {
    final json = event.toJson();
    // Do NOT strip null values: each `toJson()` already uses
    // `if (field != null) 'field': field` for fields that should be omitted
    // when null. Stripping here would silently drop fields that intentionally
    // serialize as `null` (e.g. `ActivitySnapshotEvent.content`,
    // `RawEvent.event`, `CustomEvent.value`, `StateSnapshotEvent.snapshot`)
    // — their factories require the key to be present and reject
    // missing-key with `AGUIValidationError`, so a null-strip pass would
    // break the encode→decode round-trip. See
    // `fixtures_integration_test.dart` "round-trip preserves explicit-null
    // payload" for the regression guard.
    final String jsonString;
    try {
      jsonString = jsonEncode(json);
    } on JsonUnsupportedObjectError catch (e) {
      throw EncodeError(
        message: 'Event payload is not JSON-encodable: '
            '${event.runtimeType} contains a non-serializable value '
            '(${e.unsupportedObject.runtimeType})',
        source: event,
        cause: e,
      );
    }
    return 'data: $jsonString\n\n';
  }

  /// Encodes an event to binary format.
  ///
  /// If protobuf is accepted, uses protobuf encoding (not yet implemented).
  /// Otherwise, converts SSE string to bytes.
  Uint8List encodeBinary(BaseEvent event) {
    if (acceptsProtobuf) {
      // TODO: Implement protobuf encoding when proto definitions are available
      // For now, fall back to SSE as bytes
      return _encodeSSEAsBytes(event);
    } else {
      return _encodeSSEAsBytes(event);
    }
  }

  /// Encodes an SSE event as bytes.
  Uint8List _encodeSSEAsBytes(BaseEvent event) {
    final sseString = encodeSSE(event);
    return Uint8List.fromList(utf8.encode(sseString));
  }

  /// Checks if protobuf format is accepted based on Accept header.
  ///
  /// Evaluates each comma-separated token independently to avoid false
  /// positives from substring matches and to honor `q=0` (explicit deny).
  /// Examples:
  ///   `"application/vnd.ag-ui.event+proto"`              → true
  ///   `"application/vnd.ag-ui.event+proto; q=0.8"`       → true
  ///   `"application/vnd.ag-ui.event+proto; q=0"`         → false
  ///   `"*/*; q=0.5, application/vnd.ag-ui.event+proto; q=0"` → false
  static bool _isProtobufAccepted(String acceptHeader) {
    for (final token in acceptHeader.split(',')) {
      final parts = token.trim().split(';');
      final mediaType = parts.first.trim().toLowerCase();
      if (mediaType != aguiMediaType.toLowerCase()) continue;
      // Found the media type — accept unless a q=0 parameter denies it.
      var denied = false;
      for (var i = 1; i < parts.length; i++) {
        final kv = parts[i].trim().split('=');
        if (kv.length == 2 &&
            kv[0].trim().toLowerCase() == 'q' &&
            double.tryParse(kv[1].trim()) == 0.0) {
          denied = true;
          break;
        }
      }
      if (!denied) return true;
    }
    return false;
  }
}
