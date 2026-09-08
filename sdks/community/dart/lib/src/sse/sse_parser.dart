import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import '../internal/sse_constants.dart';
import 'sse_message.dart';

/// Parses Server-Sent Events according to the WHATWG specification.
///
/// `SseParser` instances are intended to be **per-connection**. The
/// `_eventBuffer`, `_dataBuffer`, `_retry`, and `_hasDataField` fields
/// are reset between events via [_resetBuffers], but `_lastEventId` is
/// intentionally sticky across messages on the same connection (per the
/// SSE spec: the last `id:` field is preserved so a reconnecting client
/// can supply it via the `Last-Event-ID` request header).
///
/// If you reuse a single `SseParser` instance across multiple
/// independent streams (e.g. in tests), `_lastEventId` carries across —
/// which is consistent with the spec's reconnection semantics but can
/// be surprising in test harnesses. Construct a fresh parser per stream
/// when you want clean isolation, or call [reset] to clear all parser
/// state including `_lastEventId`. The streaming-side counterpart in
/// `EventStreamAdapter.fromRawSseStream` keeps its parsing state in
/// per-invocation locals and does not have this concern.
class SseParser {
  /// Maximum number of UTF-16 code units the `_dataBuffer` may accumulate
  /// before a message is dispatched. Prevents a malicious or misbehaving SSE
  /// producer from growing the buffer without bound across `data:` lines,
  /// causing an OOM before the terminating blank line arrives.
  ///
  /// **Note:** The cap is measured in UTF-16 code units (Dart's internal string
  /// unit), not UTF-8 bytes. ASCII content has a 1:1 ratio; BMP characters
  /// outside ASCII still count as one code unit; supplementary characters
  /// (emoji, etc.) count as two. For most JSON payloads the difference is
  /// negligible, but the name reflects what is actually measured.
  ///
  /// Default: 8 MiB (8 × 1024 × 1024 code units). Adjust via the
  /// [SseParser.new] constructor when your use-case legitimately requires
  /// larger payloads.
  final int maxDataCodeUnits;

  /// Maximum number of UTF-16 code units the `id:` field value may contain.
  /// Caps the sticky `_lastEventId` value to prevent a malicious server from
  /// growing the stored id across reconnects via an oversized `id:` line.
  static const int maxIdCodeUnits = 1024;

  // `_eventBuffer` stores the SSE `event:` field for the current message.
  // Unlike `_dataBuffer`, it is REPLACED (not appended) on each `event:` line
  // per the WHATWG SSE spec, so its maximum size is bounded by the line
  // splitter upstream rather than accumulating across lines. Only `_dataBuffer`
  // needs an explicit `maxDataCodeUnits` cap because it accumulates across multiple
  // `data:` lines within a single message.
  final _eventBuffer = StringBuffer();
  final _dataBuffer = StringBuffer();
  String? _lastEventId;
  Duration? _retry;
  bool _hasDataField = false;

  SseParser({this.maxDataCodeUnits = kSseDefaultMaxDataCodeUnits});

  /// Clears all parser state, including the otherwise-sticky
  /// `_lastEventId`. Use when reusing a parser instance across
  /// independent streams that should not share reconnection state.
  void reset() {
    _resetBuffers();
    _lastEventId = null;
  }

  /// Parses SSE data and yields messages.
  ///
  /// The input should be a stream of text lines from an SSE endpoint.
  /// Empty lines trigger message dispatch.
  Stream<SseMessage> parseLines(Stream<String> lines) async* {
    await for (final line in lines) {
      final message = _processLine(line);
      if (message != null) {
        yield message;
      }
    }

    // Dispatch any remaining buffered message
    final finalMessage = _dispatchEvent();
    if (finalMessage != null) {
      yield finalMessage;
    }
  }

  /// Parses raw bytes from an SSE stream.
  ///
  /// Routes through [parseLines] so the end-of-stream flush in
  /// [parseLines] also fires here — a byte source that closes without
  /// a trailing blank line still emits its final buffered event.
  Stream<SseMessage> parseBytes(Stream<List<int>> bytes) {
    // Per WHATWG SSE spec the BOM is stripped once at the very start of the
    // stream, not from every line. A mid-stream U+FEFF that happens to be the
    // first character of a data line would otherwise be silently consumed.
    var firstLine = true;
    final lines = utf8.decoder
        .bind(bytes)
        .transform(const LineSplitter())
        .transform(StreamTransformer<String, String>.fromHandlers(
      handleData: (String line, EventSink<String> sink) {
        if (firstLine) {
          firstLine = false;
          if (line.isNotEmpty && line.codeUnitAt(0) == 0xFEFF) {
            line = line.substring(1);
          }
        }
        sink.add(line);
      },
    ));
    return parseLines(lines);
  }

  /// Process a single line according to SSE spec.
  SseMessage? _processLine(String line) {
    // Empty line dispatches the event
    if (line.isEmpty) {
      return _dispatchEvent();
    }

    // Comment line (starts with ':')
    if (line.startsWith(':')) {
      // Ignore comments
      return null;
    }

    // Field line
    final colonIndex = line.indexOf(':');
    if (colonIndex == -1) {
      // Line is a field name with no value
      _processField(line, '');
    } else {
      final field = line.substring(0, colonIndex);
      var value = line.substring(colonIndex + 1);
      // Remove single leading space if present (per spec)
      if (value.isNotEmpty && value[0] == ' ') {
        value = value.substring(1);
      }
      _processField(field, value);
    }

    return null;
  }

  /// Process a field according to SSE spec.
  void _processField(String field, String value) {
    switch (field) {
      case 'event':
        // Per WHATWG: "If the field name is 'event', set the event type
        // buffer to field value." The buffer is REPLACED on each `event:`
        // line, not appended to. The previous `_eventBuffer.write(value)`
        // concatenated repeated `event:` lines within a single dispatch
        // block — spec-non-compliant and divergent from the canonical
        // SDKs.
        // Defense-in-depth cap: a single oversized `event:` line cannot
        // allocate unbounded memory before the dispatch blank line arrives.
        // The cap mirrors the `data:` path in the same method.
        if (value.length > maxDataCodeUnits) {
          _resetBuffers();
          throw FormatException(
            'SSE event field exceeds $maxDataCodeUnits-code-unit limit '
            '(${value.length} code units)',
          );
        }
        _eventBuffer
          ..clear()
          ..write(value);
        break;
      case 'data':
        // Per WHATWG: every `data:` field appends `\n` BEFORE its value
        // (the trailing `\n` is then stripped at dispatch). The previous
        // `_dataBuffer.isNotEmpty` heuristic skipped the leading `\n`
        // when the first `data:` line was empty, collapsing
        // `data:\ndata: x` to `"x"` instead of the spec-correct `"\nx"`.
        // Use `_hasDataField` to track "have we already received a
        // `data:` field in this block?" — which is the actual
        // spec-mandated condition. Mirrors the `inDataBlock` flag pattern
        // in `EventStreamAdapter.appendDataLine`.
        // Guard against unbounded growth from a malicious/misbehaving
        // producer. Reject the entire message if the accumulated data
        // would exceed [maxDataCodeUnits], reset buffers, and throw so the
        // caller's stream adapter can surface a structured error instead
        // of quietly OOM-ing.
        final newlineBytes =
            _hasDataField ? 1 : 0; // \n separator between lines
        if (_dataBuffer.length + newlineBytes + value.length >
            maxDataCodeUnits) {
          _resetBuffers();
          throw FormatException(
            'SSE data field exceeds $maxDataCodeUnits-code-unit limit '
            '(current ${_dataBuffer.length} + incoming '
            '${newlineBytes + value.length} code units)',
          );
        }
        if (_hasDataField) {
          _dataBuffer.write('\n'); // explicit \n, not platform line terminator
        }
        _hasDataField = true;
        _dataBuffer.write(value);
        break;
      case 'id':
        // Per WHATWG SSE spec: id values must not contain \n, \r, or \x00
        // (NUL). NUL-bearing ids are silently ignored and the prior
        // `_lastEventId` survives unchanged. Cap at ≤1024 UTF-16 code units
        // (~1–4 KB on the wire depending on encoding) to prevent a malicious
        // server from growing the stored value across reconnects via an
        // oversized `id:` line (the value persists for the lifetime of the
        // connection and propagates via `Last-Event-ID` headers).
        if (value.contains('\n') ||
            value.contains('\r') ||
            value.contains('\x00')) {
          // Spec-mandated silent drop — no log needed.
          break;
        }
        if (value.length > maxIdCodeUnits) {
          // Defense-in-depth cap (non-spec). Log so operators can detect
          // misbehaving SSE producers. `_lastEventId` is NOT updated; the
          // prior value is preserved (used as Last-Event-ID on reconnect).
          developer.log(
            'SSE id field dropped: length ${value.length} exceeds '
            'maxIdCodeUnits ($maxIdCodeUnits). _lastEventId not updated.',
            name: 'ag_ui.sse_parser',
          );
          break;
        }
        _lastEventId = value;
        break;
      case 'retry':
        final milliseconds = int.tryParse(value);
        if (milliseconds != null && milliseconds >= 0) {
          _retry = Duration(milliseconds: milliseconds);
        }
        break;
      default:
        // Unknown field, ignore per spec
        break;
    }
  }

  /// Dispatches the current buffered event.
  SseMessage? _dispatchEvent() {
    // According to WHATWG spec, we need to have received at least one 'data' field
    // to dispatch an event. An empty data buffer means no 'data' field was received.
    // However, 'data' field with empty value should still dispatch (with empty string).
    // We track this by checking if the data buffer has been written to at all.

    // For simplicity, we'll dispatch if we have any event-related fields set
    // but only if at least one data field was received (even if empty)
    if (!_hasDataField) {
      _resetBuffers();
      return null;
    }

    final message = SseMessage(
      event: _eventBuffer.isNotEmpty ? _eventBuffer.toString() : null,
      id: _lastEventId,
      data: _dataBuffer.toString(),
      retry: _retry,
    );

    _resetBuffers();
    return message;
  }

  /// Resets the buffers for the next event.
  void _resetBuffers() {
    _eventBuffer.clear();
    _dataBuffer.clear();
    _retry = null;
    _hasDataField = false;
    // Note: _lastEventId is NOT reset between messages
  }

  /// Gets the last event ID (for reconnection).
  String? get lastEventId => _lastEventId;
}
