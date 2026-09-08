/// Event decoder for AG-UI protocol.
///
/// Decodes wire format (SSE or binary) to Dart models.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../client/errors.dart';
import '../client/validators.dart';
import '../events/events.dart';
import '../types/base.dart';
// `encoder/errors.dart` defines its own `ValidationError`, distinct from
// the `client/errors.dart` one. Hide it on import so the `on ValidationError`
// clauses below unambiguously resolve to the client-side class that
// `Validators.requireNonEmpty` actually throws — see lib/ag_ui.dart:52
// for the parallel public-export disambiguation.
import 'errors.dart' hide ValidationError;

/// Decoder for AG-UI events.
///
/// Supports decoding events from SSE (Server-Sent Events) format
/// and binary format (protobuf or SSE as bytes).
class EventDecoder {
  /// Creates a decoder instance.
  const EventDecoder();

  /// Decodes an event from a string (assumed to be JSON).
  ///
  /// This method expects a JSON string without the SSE "data: " prefix.
  ///
  /// **Catch-chain ordering** (do not reorder — each clause depends on prior
  /// clauses not having matched):
  ///   1. `on FormatException` — raw JSON parse failure before any typed
  ///      object exists; must come before the typed catch clauses.
  ///   2. `on ValidationError` — `client/errors.dart`'s `AgUiError`-extending
  ///      subtype; must come before `on AgUiError` to avoid the rethrow below
  ///      bypassing the `_wrapValidation` call.
  ///   3. `on AGUIValidationError` — factory-side validation (only
  ///      `implements Exception`, not `AgUiError`); does not match `on AgUiError`.
  ///   4. `on AgUiError` — all other SDK errors; rethrown unchanged.
  ///   5. `on EncoderError` — encoder-side family extends `AGUIError` but NOT
  ///      `AgUiError`; without this clause it falls to the catch-all.
  ///   6. catch-all — foreign exceptions wrapped as `DecodingError`.
  BaseEvent decode(String data) {
    try {
      final decoded = jsonDecode(data);
      // Validate the top-level shape explicitly so a list/primitive
      // payload (`[1,2,3]`, `"hello"`, `42`) produces a structured
      // [DecodingError] instead of a `TypeError` swallowed by the
      // catch-all below — which was being wrapped as a generic "Failed
      // to decode event" with no hint about the actual mismatch.
      if (decoded is! Map<String, dynamic>) {
        throw DecodingError(
          'Expected JSON object at top level',
          field: 'data',
          expectedType: 'Map<String, dynamic>',
          // Surface the runtime type (e.g. `List<dynamic>`, `String`,
          // `int`) rather than the raw value so debug logs read
          // "actual: List<dynamic>" instead of dumping the whole
          // payload — much more useful when the payload is large.
          actualValue: decoded.runtimeType.toString(),
        );
      }
      return decodeJson(decoded);
    } on FormatException catch (e) {
      throw DecodingError(
        'Invalid JSON format',
        field: 'data',
        expectedType: 'JSON',
        // Avoid forwarding the raw payload — may contain encryptedValue.
        actualValue: '<${data.length} chars>',
        cause: e,
      );
    } on ValidationError catch (e, stack) {
      // Mirror `decodeJson`'s clauses so a factory-side validation error
      // raised before `decodeJson` ever runs (e.g. via a future inline
      // pre-check) still surfaces as a structured `DecodingError` with
      // the originating field preserved, instead of falling to the
      // catch-all and getting flattened to `field: 'event'`.
      // `Error.throwWithStackTrace` preserves the original stack so the
      // debug trace points at the failing field, not the wrapper.
      return _wrapValidation(e, e.field, {'data': data}, stack);
    } on AGUIValidationError catch (e, stack) {
      return _wrapValidation(e, e.field, {'data': data}, stack);
    } on AgUiError {
      rethrow;
    } on EncoderError {
      // Encoder-side family (`EncoderError`, `DecodeError`, `EncodeError`,
      // and `encoder/errors.dart`'s `ValidationError`) extends `AGUIError`
      // but NOT `AgUiError`, so without this clause it would fall through
      // to the catch-all and get re-wrapped as a generic decode failure.
      // Rethrow so callers can pattern-match on the original encoder type.
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to decode event',
        field: 'event',
        expectedType: 'BaseEvent',
        // Avoid forwarding the raw payload — may contain encryptedValue.
        actualValue: '<${data.length} chars>',
        cause: e,
      );
    }
  }

  /// Decodes an event from a JSON map.
  ///
  /// **Catch-chain ordering**: same required sequence as [decode] —
  /// `on ValidationError` → `on AGUIValidationError` → `on AgUiError` →
  /// `on EncoderError` → catch-all. Do not reorder.
  BaseEvent decodeJson(Map<String, dynamic> json) {
    try {
      // `BaseEvent.fromJson` already enforces presence and string-type
      // for the `type` discriminator via `JsonDecoder.requireField<String>`,
      // and `validate()` below enforces non-empty on identifier strings.
      // No standalone pre-check needed — keeping one collapsed the
      // `type: 123` (wrong-typed) path into a single `AGUIValidationError`
      // wrapped uniformly into [DecodingError] by the handlers below.
      final event = BaseEvent.fromJson(json);

      // Validate the created event
      validate(event);

      return event;
    } on ValidationError catch (e, stack) {
      // Wire-boundary contract documented on `AGUIValidationError`
      // (lib/src/types/base.dart): both `AGUIValidationError` (from
      // `fromJson` factories) and `ValidationError` (from `validate()`
      // via `Validators.requireNonEmpty`) surface to consumers as
      // `DecodingError` so callers only need to catch one error type at
      // the decode boundary. This `on` clause covers the
      // `AgUiError`-extending sibling so it does not bypass the wrapping
      // via the `on AgUiError` rethrow.
      // `Error.throwWithStackTrace` preserves the original stack so the
      // debug trace points at the failing field, not the wrapper.
      return _wrapValidation(e, e.field, json, stack);
    } on AGUIValidationError catch (e, stack) {
      // Companion clause for the factory-side error. Without this branch,
      // `AGUIValidationError` (which only `implements Exception`, not
      // `AgUiError`) falls through to the catch-all below and the
      // original failing field — `role`, `messageId`, `subtype`, etc. —
      // is flattened to `field: 'json'`, breaking the public decoder
      // error surface.
      return _wrapValidation(e, e.field, json, stack);
    } on AgUiError {
      rethrow;
    } on EncoderError {
      // See the matching clause in `decode()` above — encoder-side
      // errors extend `AGUIError` (not `AgUiError`), so we rethrow them
      // unchanged rather than re-wrapping as a generic decode failure.
      rethrow;
    } catch (e) {
      throw DecodingError(
        'Failed to create event from JSON',
        field: 'json',
        expectedType: 'BaseEvent',
        actualValue: json,
        cause: e,
      );
    }
  }

  /// Decodes a complete SSE message string.
  ///
  /// Expects a complete SSE frame (one logical message, from the first line
  /// through the terminating blank line) with a `data:` prefix. Uses
  /// [LineSplitter] so `\n`, `\r`, and `\r\n` terminators are all handled per
  /// the WHATWG SSE spec — a trailing `\r` from a CRLF-encoded payload no
  /// longer leaks into the joined `data` value.
  ///
  /// **Semantic divergence from `EventStreamAdapter.fromRawSseStream`:**
  /// - This method receives a COMPLETE frame and throws [DecodingError] for
  ///   keep-alive frames (comment-only lines or `data: :`) and for frames
  ///   with no `data:` lines at all (see "No data found").
  /// - `fromRawSseStream` buffers streaming chunks, accumulates `data:` lines
  ///   across chunk boundaries, and silently discards keep-alives (it never
  ///   calls `decodeSSE` — it invokes `decode` directly after accumulation).
  /// Use this method when you have a pre-assembled SSE frame; use
  /// `fromRawSseStream` for raw streaming bytes.
  BaseEvent decodeSSE(String sseMessage) {
    // Reject keep-alive / comment-only frames before any `data:` collection.
    // A frame that is entirely `:`-prefixed comment lines (with optional
    // blank lines) carries no payload and must surface as a structured
    // keep-alive error rather than the misleading "No data found" path
    // that the previous `dataLines.isEmpty`-first ordering produced.
    final lines = const LineSplitter().convert(sseMessage);
    final hasOnlyComments = lines.every(
      (line) => line.isEmpty || line.startsWith(':'),
    );
    if (hasOnlyComments && lines.any((line) => line.startsWith(':'))) {
      throw DecodingError(
        'SSE keep-alive comment, not an event',
        field: 'data',
        expectedType: 'JSON event data',
        actualValue: sseMessage,
      );
    }

    final dataLines = <String>[];
    for (final line in lines) {
      if (line.startsWith('data: ')) {
        dataLines.add(line.substring(6)); // Remove "data: " prefix
      } else if (line.startsWith('data:')) {
        dataLines.add(line.substring(5)); // Remove "data:" prefix
      }
    }

    // A frame whose lines are ALL empty (no comment, no data prefix) falls
    // here. This can happen with a bare double-newline `\n\n` that acts as an
    // SSE message boundary with no payload — the WHATWG spec says to dispatch
    // the event but if there's nothing to decode, "No data found" is the
    // correct outcome. Treat as a non-event rather than a keep-alive because
    // there is no `:` comment marker to distinguish it; callers that care
    // about empty-frame detection should observe the DecodingError.
    if (dataLines.isEmpty) {
      throw DecodingError(
        'No data found in SSE message',
        field: 'sseMessage',
        expectedType: 'SSE with data field',
        actualValue: sseMessage,
      );
    }

    // Join all data lines (for multi-line data) with `\n`, per spec.
    final data = dataLines.join('\n');

    // A `data: ` line (field present but value is the empty string) contributes
    // an empty string to dataLines, so `data` can be empty after the join.
    // Passing "" to `decode` raises "Unexpected end of input" which surfaces as
    // the misleading "Invalid JSON format" DecodingError. Surface a clearer
    // error instead.
    if (data.isEmpty) {
      throw DecodingError(
        'SSE data field is empty',
        field: 'data',
        expectedType: 'non-empty JSON event data',
        actualValue: sseMessage,
      );
    }

    // Legacy compatibility: a single `data: :` line (with the field value
    // being the bare colon character) is treated as a keep-alive
    // sentinel by some servers. Surface it as a structured keep-alive
    // error rather than letting `jsonDecode(':')` raise a generic
    // FormatException. Spec-compliant keep-alives are top-level `:`-only
    // lines, which are caught earlier in [hasOnlyComments].
    if (data.trim() == ':') {
      throw DecodingError(
        'SSE keep-alive comment, not an event',
        field: 'data',
        expectedType: 'JSON event data',
        actualValue: data,
      );
    }

    return decode(data);
  }

  /// Decodes an event from binary data.
  ///
  /// Currently assumes the binary data is UTF-8 encoded SSE/JSON.
  /// Protobuf is NOT yet supported — a server emitting actual protobuf bytes
  /// will raise [DecodingError] with message "Invalid UTF-8 data" rather than
  /// a descriptive "protobuf not implemented" error. Negotiate
  /// `acceptsProtobuf=false` (i.e. use SSE transport) until protobuf support
  /// lands end-to-end in both encoder and decoder.
  ///
  /// TODO: Add protobuf support when proto definitions are available.
  BaseEvent decodeBinary(Uint8List data) {
    try {
      final string = utf8.decode(data);

      // Detect SSE format by any recognised field prefix, including keep-alive
      // comment lines (`:`). Without the `:` check, a keep-alive frame decoded
      // from binary bytes would fall through to `decode(string)`, which tries
      // jsonDecode(':') and raises a misleading "Invalid JSON format" error
      // instead of the structured `DecodingError('SSE keep-alive comment…')`.
      final looksLikeSse = string.startsWith('data:') ||
          string.startsWith(':') ||
          string.startsWith('event:') ||
          string.startsWith('id:') ||
          string.startsWith('retry:');
      if (looksLikeSse) {
        return decodeSSE(string);
      } else {
        // Assume it's raw JSON
        return decode(string);
      }
    } on FormatException catch (e) {
      // A FormatException here almost always means the bytes are not valid
      // UTF-8, which in turn usually means the server sent actual protobuf.
      // Protobuf decoding is not yet implemented end-to-end; negotiate
      // text/event-stream (acceptsProtobuf: false) until it lands.
      throw DecodingError(
        'Binary data is not valid UTF-8. If the server negotiated '
        'application/vnd.ag-ui.event+proto, note that protobuf decoding '
        'is not yet implemented — use SSE transport instead.',
        field: 'binary',
        expectedType: 'UTF-8 SSE/JSON',
        actualValue: 'Uint8List(${data.length})',
        cause: e,
      );
    }
  }

  /// Validates that an event has all required fields.
  ///
  /// Defensive re-check on top of `fromJson`: catches empty-string values
  /// (which `JsonDecoder.requireField<String>` permits), and any event
  /// constructed outside `fromJson` (e.g. via a `copyWith` that violates
  /// the non-empty contract). The asymmetry is intentional — `fromJson`
  /// only enforces presence and type; `validate()` is the single source of
  /// truth for non-empty constraints on string identifiers.
  ///
  /// **Error class note.** `validate()` raises [ValidationError]
  /// (`lib/src/client/errors.dart`, extends `AgUiError`). The eager
  /// `fromJson`-side rejections (e.g. unknown role, unknown subtype)
  /// raise [AGUIValidationError] (`lib/src/types/base.dart`, extends
  /// `AGUIError` directly). Through the public [decode] / [decodeJson]
  /// boundary both surface uniformly as [DecodingError], so the
  /// asymmetry is only visible to direct callers of [validate] vs.
  /// direct callers of `fromJson`. A consumer that wants to catch both
  /// without distinguishing class can `on AGUIError catch (e)` —
  /// `ValidationError` and `AGUIValidationError` both extend it.
  ///
  /// Returns true if valid, throws [ValidationError] if not.
  bool validate(BaseEvent event) {
    // Basic validation - ensure type is set
    Validators.validateEventType(event.type);

    // Type-specific validation. Listing every sealed subtype explicitly
    // (no `default`) makes the analyzer flag any new event type that is
    // added without a corresponding decision here. The `exhaustive_cases`
    // lint in `analysis_options.yaml` enforces this at analysis time —
    // without it a new sealed subtype would silently pass `validate`.
    // When you add a case here, also update `BaseEvent.fromJson` in
    // `lib/src/events/events.dart` so the discriminator-dispatch switch
    // and this validator remain in sync.
    switch (event) {
      case TextMessageStartEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case TextMessageContentEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      // `delta` may be empty per canonical TS/Python schemas
      // (`TextMessageContentEventSchema.delta: z.string()` /
      // pydantic `delta: str`). Do not enforce non-empty here.
      case TextMessageEndEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case TextMessageChunkEvent():
        break; // All fields optional — nothing to validate
      // TODO(1.0.0): Remove the following deprecated cases + their event classes:
      //   ThinkingTextMessageStartEvent, ThinkingTextMessageContentEvent,
      //   ThinkingTextMessageEndEvent, ThinkingContentEvent.
      //   Also remove EventType.thinkingTextMessage* / thinkingContent enum
      //   values, the _kThinkingTextMessage*Deprecation / _kThinkingContent*
      //   Deprecation constants, and the deprecated TimeoutError typedef in
      //   client/errors.dart.
      // ignore: deprecated_member_use_from_same_package
      case ThinkingTextMessageStartEvent():
        // Deprecated; no `messageId` on the wire by design — matches the
        // canonical TS `THINKING_TEXT_MESSAGE_START` shape this event
        // mirrors. The migration target [ReasoningMessageStartEvent]
        // adds `messageId` per canonical `REASONING_MESSAGE_START`. Do
        // NOT add validation here at 1.0.0 removal — that would tighten
        // the deprecated contract retroactively and break consumers
        // still on the old wire shape.
        break;
      // ignore: deprecated_member_use_from_same_package
      case ThinkingTextMessageContentEvent():
        // Empty `delta` is accepted — relaxed to match the canonical
        // `z.string()` / `delta: str` contract (parity with
        // `TextMessageContentEvent`, `ReasoningMessageContentEvent`, etc.).
        break;
      // ignore: deprecated_member_use_from_same_package
      case ThinkingTextMessageEndEvent():
        // Same rationale as `ThinkingTextMessageStartEvent` above: no
        // `messageId` on the wire by design; the migration target
        // [ReasoningMessageEndEvent] adds it.
        break;
      case ToolCallStartEvent():
        Validators.requireNonEmpty(event.toolCallId, 'toolCallId');
        Validators.requireNonEmpty(event.toolCallName, 'toolCallName');
      case ToolCallArgsEvent():
        Validators.requireNonEmpty(event.toolCallId, 'toolCallId');
      // `delta` may be empty per canonical TS/Python schemas
      // (`ToolCallArgsEventSchema.delta: z.string()` / pydantic
      // `delta: str`). Do not enforce non-empty here.
      case ToolCallEndEvent():
        Validators.requireNonEmpty(event.toolCallId, 'toolCallId');
      case ToolCallChunkEvent():
        break; // All fields optional — nothing to validate
      case ToolCallResultEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
        Validators.requireNonEmpty(event.toolCallId, 'toolCallId');
      // `content` may be empty per canonical TS/Python schemas
      // (`ToolCallResultEventSchema.content: z.string()` / pydantic
      // `content: str`). Do not enforce non-empty here.
      case ThinkingStartEvent():
        break;
      // ignore: deprecated_member_use_from_same_package
      case ThinkingContentEvent():
        // Empty `delta` is accepted — relaxed to match canonical contract.
        break;
      case ThinkingEndEvent():
        break;
      case StateSnapshotEvent():
        // `snapshot` is an opaque JSON value — presence is enforced in
        // `StateSnapshotEvent.fromJson`; there is no non-empty constraint
        // we can express on `dynamic` content here.
        break;
      case StateDeltaEvent():
        // `delta` is allowed to be empty per canonical TS/Python — mirrors
        // `ActivityDeltaEvent` which has the same schema floor of 0. Do not
        // add a non-empty check here without a corresponding schema change.
        break;
      case MessagesSnapshotEvent():
        break;
      case ActivitySnapshotEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
        Validators.requireNonEmpty(event.activityType, 'activityType');
      case ActivityDeltaEvent():
        // `patch` is allowed to be empty per canonical TS/Python
        // (`z.array(JsonPatchOperationSchema).min(0)` / list with no
        // length floor). This matches `StateDeltaEvent` which similarly
        // does not enforce non-empty on its patch list. Do not add
        // `requireNonEmpty(...patch...)` here without a corresponding
        // schema change in the canonical SDKs.
        Validators.requireNonEmpty(event.messageId, 'messageId');
        Validators.requireNonEmpty(event.activityType, 'activityType');
      case RawEvent():
        // `event` payload presence is enforced in `RawEvent.fromJson`.
        break;
      case CustomEvent():
        Validators.requireNonEmpty(event.name, 'name');
      case RunStartedEvent():
        Validators.validateThreadId(event.threadId);
        Validators.validateRunId(event.runId);
      case RunFinishedEvent():
        Validators.validateThreadId(event.threadId);
        Validators.validateRunId(event.runId);
      case RunErrorEvent():
        Validators.requireNonEmpty(event.message, 'message');
      case StepStartedEvent():
        Validators.requireNonEmpty(event.stepName, 'stepName');
      case StepFinishedEvent():
        Validators.requireNonEmpty(event.stepName, 'stepName');
      case ReasoningStartEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case ReasoningMessageStartEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case ReasoningMessageContentEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      // `delta` may be empty per canonical TS/Python schemas
      // (`ReasoningMessageContentEventSchema.delta: z.string()` /
      // pydantic `delta: str`). Do not enforce non-empty here.
      case ReasoningMessageEndEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case ReasoningMessageChunkEvent():
        break; // All fields optional — nothing to validate
      case ReasoningEndEvent():
        Validators.requireNonEmpty(event.messageId, 'messageId');
      case ReasoningEncryptedValueEvent():
        // `subtype` is enum-typed and constructor-required, so it cannot
        // be null/invalid here. If the enum ever gains an `unknown`
        // member (currently `fromString` throws — see the dartdoc on
        // `ReasoningEncryptedValueSubtype.fromString`), this case is the
        // place to reject it.
        // TODO: revisit if `ReasoningEncryptedValueSubtype` gains an
        //   `unknown` member — at that point the comment above goes
        //   stale and this case must explicitly reject the unknown
        //   subtype to preserve the "no graceful default for cipher
        //   payloads" contract.
        //
        // `entityId` and `encryptedValue` are accepted as plain strings
        // (including empty) to match canonical TS `z.string()` and
        // Python `str` schemas — neither imposes a minimum length.
        //
        // **Operational risk of empty `entityId`.** An empty `entityId`
        // will pass validation here but the referenced entity cannot be
        // located by consumers. This matches the canonical SDK behavior
        // (no min-length constraint). If your deployment routes these
        // events to a decryption service that fails on empty entityId,
        // add a length check at the consumer or via a proxy validator.
        break;
    }

    return true;
  }

  /// Wraps a factory-side or validate-side validation failure into the
  /// public [DecodingError] envelope, preserving the original failing
  /// field name so consumers can react to specific field violations
  /// instead of getting a flattened `field: 'json'` everywhere.
  ///
  /// Returns [Never] so the analyzer verifies that all call sites are
  /// unconditionally throwing — callers pass `stack` instead of wrapping
  /// in `Error.throwWithStackTrace(...)` themselves, which keeps the
  /// original stack trace intact.
  Never _wrapValidation(
    Object cause,
    String? field,
    Map<String, dynamic> json,
    StackTrace stack,
  ) {
    // Do not forward the raw json map when the inner factory already scrubbed
    // it (indicated by cause.json == null on an AGUIValidationError). Doing so
    // would re-expose a cipher payload that the factory deliberately omitted.
    final innerScrubbed = cause is AGUIValidationError && cause.json == null;
    Error.throwWithStackTrace(
      DecodingError(
        'Failed to create event from JSON',
        field: field ?? 'json',
        // When the inner factory scrubbed its json map (cipher-bearing event),
        // mark expectedType so operators can tell that the absent actualValue
        // is intentional rather than a logging bug.
        expectedType: innerScrubbed
            ? 'BaseEvent (cipher-bearing — actualValue suppressed)'
            : 'BaseEvent',
        actualValue: innerScrubbed ? null : json,
        cause: cause,
      ),
      stack,
    );
  }
}
