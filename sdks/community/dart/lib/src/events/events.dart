/// All event types for AG-UI protocol.
///
/// This library defines all event types used in the AG-UI protocol for
/// streaming agent responses and state updates.
///
/// Note: All event classes are in a single file because Dart's sealed classes
/// can only be extended within the same library.
library;

import 'dart:developer' as developer;

import '../types/base.dart';
import '../types/message.dart';
import '../types/context.dart';
import 'event_type.dart';

export 'event_type.dart';

// `kUnsetSentinel` (from `base.dart`) is the shared sentinel for all
// `copyWith` methods in this file. With the default `?? this.field` pattern,
// a caller cannot distinguish "argument omitted" from "argument explicitly set
// to `null`". Comparing against `kUnsetSentinel` with `identical(...)` makes
// that distinction explicit.
//
// **`rawEvent` is intentionally sticky** — all `copyWith` methods use
// `rawEvent ?? this.rawEvent` rather than the sentinel pattern. Passing
// `null` for `rawEvent` keeps the existing value; to clear it, construct
// the event directly with `rawEvent: null`. This is a deliberate design:
// `ReasoningEncryptedValueEvent.fromJson` explicitly sets `rawEvent: null`
// to scrub cipher data, and the sentinel approach would inadvertently
// re-expose a prior non-null value when the caller omits the argument.
// See `BaseEvent.rawEvent` dartdoc for the full consumer note.
//
// Applied to every nullable payload field on the events whose `copyWith`
// callers may legitimately want to clear:
// `ActivitySnapshotEvent.content`, `RawEvent.event`, `CustomEvent.value`,
// `RunFinishedEvent.result`, `RunStartedEvent.parentRunId` /
// `RunStartedEvent.input`, the `name` field of `TextMessageStartEvent`,
// the optional fields of `TextMessageChunkEvent`,
// `ToolCallStartEvent.parentMessageId`, the optional fields of
// `ToolCallChunkEvent`, the optional fields of `ReasoningMessageChunkEvent`,
// `ThinkingStartEvent.title`, `ToolCallResultEvent.role`,
// `StateSnapshotEvent.snapshot`, and `RunErrorEvent.code`.

/// Reads the `rawEvent` field from a wire payload, accepting both
/// `rawEvent` (TypeScript-canonical) and `raw_event` (Python-canonical).
/// `containsKey` precedence — a present `rawEvent` key wins even when its
/// value is explicitly `null`, matching the documented `requireEitherField`
/// rule for camelCase-vs-snake_case dual reads. Used by every event
/// factory in this library so a Python-emitted `raw_event` survives the
/// proxy round-trip.
dynamic _readRawEvent(Map<String, dynamic> json) =>
    json.containsKey('rawEvent') ? json['rawEvent'] : json['raw_event'];

// Hoisted `@Deprecated` messages: each is repeated on the class
// declaration AND the constructor of the corresponding event type, so a
// constant lets the planned-removal version (1.0.0) and migration target
// get edited in one place per event class. Sibling enum-side messages
// live in `event_type.dart`; the surfaces are intentionally different
// (enum names vs. event class names).
// IMPORTANT: Do NOT add `// ignore_for_file: deprecated_member_use_from_same_package`
// to this file. The per-line `// ignore:` comments below are load-bearing:
// they enumerate every deprecated event type use so the 1.0.0 removal sweep
// knows exactly which lines to delete. A file-level suppression would silence
// the deprecation alarm and make the sweep invisible to the analyzer.
const String _kThinkingTextMessageStartEventDeprecation =
    'Use ReasoningMessageStartEvent instead. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingTextMessageContentEventDeprecation =
    'Use ReasoningMessageContentEvent instead. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingTextMessageEndEventDeprecation =
    'Use ReasoningMessageEndEvent instead. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingContentEventDeprecation =
    'Dart-only legacy: never part of the canonical AG-UI protocol '
    '(TypeScript/Python). '
    'Use ReasoningMessageContentEvent instead. '
    'Scheduled for removal in 1.0.0.';

/// Base event for all AG-UI protocol events.
///
/// All protocol events extend this class and are identified by their
/// [eventType]. Use the [BaseEvent.fromJson] factory to deserialize
/// events from JSON.
sealed class BaseEvent extends AGUIModel with TypeDiscriminator {
  final EventType eventType;
  final int? timestamp;

  /// The original wire-format payload, preserved verbatim for proxy
  /// scenarios. Typed `dynamic` because the protocol does not constrain
  /// the shape (TS: `z.unknown()`, Python: `Any`). No validation is
  /// performed; the raw value flows through unchanged via every factory
  /// (which reads both `rawEvent` and `raw_event` via the private
  /// `_readRawEvent` helper, with camelCase precedence) and is
  /// re-emitted as-is from `toJson` when non-null.
  ///
  /// **Consumer note: round-trip emission.** Anything assigned to this
  /// field WILL be serialized on the next `encode`. If you don't want
  /// the upstream payload echoed downstream, set `rawEvent: null` on
  /// the in-flight event before re-encoding by constructing a new event
  /// directly with `rawEvent: null`. Wire output uses the camelCase key
  /// `rawEvent` regardless of which spelling came in.
  ///
  /// **Cipher-safety hazard.** Event types that nest [Message] objects with
  /// `encryptedValue` payloads (currently [MessagesSnapshotEvent] and
  /// [RunStartedEvent]) force `rawEvent` to `null` in their `fromJson` and
  /// `copyWith` implementations, because the verbatim wire map would expose
  /// the cipher payload that the inner message factories intentionally
  /// omitted. Callers building these events in memory (without going through
  /// `fromJson`) are responsible for setting `rawEvent: null` when the
  /// structured payload contains `encryptedValue` data.
  final dynamic rawEvent;

  const BaseEvent({
    required this.eventType,
    this.timestamp,
    this.rawEvent,
  });

  @override
  String get type => eventType.value;

  /// Factory constructor to create specific event types from JSON.
  ///
  /// When you add a case here, also update `EventDecoder.validate` in
  /// `lib/src/encoder/decoder.dart` so the analyzer-enforced exhaustive
  /// switch on the sealed `BaseEvent` hierarchy continues to compile.
  ///
  /// **Error surface.** Throws [AGUIValidationError] for:
  /// - Missing or wrong-typed `type` field.
  /// - Unknown event type string (wrapped from `ArgumentError`).
  /// - Any per-event-factory field validation failure (missing required field,
  ///   wrong type, enum parse error, etc.) — these are thrown directly by the
  ///   delegate factory and propagate unchanged.
  ///
  /// Through the [EventDecoder] pipeline all of the above surface as
  /// [DecodingError]. Direct callers that bypass [EventDecoder] should catch
  /// [AGUIValidationError]. Direct callers should also run
  /// `EventDecoder.validate(event)` after this factory if they want
  /// non-empty-field enforcement (e.g. non-null `messageId`) — this factory
  /// only enforces field presence and type, not semantic constraints.
  ///
  /// Note on equality: event subtypes are `final class` and do NOT
  /// override `==`/`hashCode`. Use field-by-field assertions in tests
  /// rather than `expect(a, equals(b))` on whole events.
  factory BaseEvent.fromJson(Map<String, dynamic> json) {
    final typeStr = JsonDecoder.requireField<String>(json, 'type');
    final EventType eventType;
    try {
      eventType = EventType.fromString(typeStr);
    } on ArgumentError {
      throw AGUIValidationError(
        message: 'Unknown event type: $typeStr',
        field: 'type',
        value: typeStr,
        json: json,
      );
    }

    switch (eventType) {
      case EventType.textMessageStart:
        return TextMessageStartEvent.fromJson(json);
      case EventType.textMessageContent:
        return TextMessageContentEvent.fromJson(json);
      case EventType.textMessageEnd:
        return TextMessageEndEvent.fromJson(json);
      case EventType.textMessageChunk:
        return TextMessageChunkEvent.fromJson(json);
      // TODO(1.0.0): Remove the following deprecated cases + their event classes:
      //   ThinkingTextMessageStartEvent, ThinkingTextMessageContentEvent,
      //   ThinkingTextMessageEndEvent, ThinkingContentEvent.
      //   Also remove EventType.thinkingTextMessage* / thinkingContent enum
      //   values, the _kThinkingTextMessage*Deprecation / _kThinkingContent*
      //   Deprecation constants, and the deprecated TimeoutError typedef in
      //   client/errors.dart.
      // ignore: deprecated_member_use_from_same_package
      case EventType.thinkingTextMessageStart:
        // ignore: deprecated_member_use_from_same_package
        return ThinkingTextMessageStartEvent.fromJson(json);
      // ignore: deprecated_member_use_from_same_package
      case EventType.thinkingTextMessageContent:
        // ignore: deprecated_member_use_from_same_package
        return ThinkingTextMessageContentEvent.fromJson(json);
      // ignore: deprecated_member_use_from_same_package
      case EventType.thinkingTextMessageEnd:
        // ignore: deprecated_member_use_from_same_package
        return ThinkingTextMessageEndEvent.fromJson(json);
      case EventType.toolCallStart:
        return ToolCallStartEvent.fromJson(json);
      case EventType.toolCallArgs:
        return ToolCallArgsEvent.fromJson(json);
      case EventType.toolCallEnd:
        return ToolCallEndEvent.fromJson(json);
      case EventType.toolCallChunk:
        return ToolCallChunkEvent.fromJson(json);
      case EventType.toolCallResult:
        return ToolCallResultEvent.fromJson(json);
      case EventType.thinkingStart:
        return ThinkingStartEvent.fromJson(json);
      // ignore: deprecated_member_use_from_same_package
      case EventType.thinkingContent:
        // ignore: deprecated_member_use_from_same_package
        return ThinkingContentEvent.fromJson(json);
      case EventType.thinkingEnd:
        return ThinkingEndEvent.fromJson(json);
      case EventType.stateSnapshot:
        return StateSnapshotEvent.fromJson(json);
      case EventType.stateDelta:
        return StateDeltaEvent.fromJson(json);
      case EventType.messagesSnapshot:
        return MessagesSnapshotEvent.fromJson(json);
      case EventType.activitySnapshot:
        return ActivitySnapshotEvent.fromJson(json);
      case EventType.activityDelta:
        return ActivityDeltaEvent.fromJson(json);
      case EventType.raw:
        return RawEvent.fromJson(json);
      case EventType.custom:
        return CustomEvent.fromJson(json);
      case EventType.runStarted:
        return RunStartedEvent.fromJson(json);
      case EventType.runFinished:
        return RunFinishedEvent.fromJson(json);
      case EventType.runError:
        return RunErrorEvent.fromJson(json);
      case EventType.stepStarted:
        return StepStartedEvent.fromJson(json);
      case EventType.stepFinished:
        return StepFinishedEvent.fromJson(json);
      case EventType.reasoningStart:
        return ReasoningStartEvent.fromJson(json);
      case EventType.reasoningMessageStart:
        return ReasoningMessageStartEvent.fromJson(json);
      case EventType.reasoningMessageContent:
        return ReasoningMessageContentEvent.fromJson(json);
      case EventType.reasoningMessageEnd:
        return ReasoningMessageEndEvent.fromJson(json);
      case EventType.reasoningMessageChunk:
        return ReasoningMessageChunkEvent.fromJson(json);
      case EventType.reasoningEnd:
        return ReasoningEndEvent.fromJson(json);
      case EventType.reasoningEncryptedValue:
        return ReasoningEncryptedValueEvent.fromJson(json);
      // No `default` clause — exhaustive switch on the [EventType] enum
      // (analyzer-enforced). A new EventType value will produce a compile
      // error here AND in `EventDecoder.validate`, which is the desired
      // outcome rather than a runtime fall-through.
    }
  }

  @override
  Map<String, dynamic> toJson() => {
        'type': eventType.value,
        if (timestamp != null) 'timestamp': timestamp,
        if (rawEvent != null) 'rawEvent': rawEvent,
      };
}

/// Text message roles that can be used in text message events.
///
/// **Role-fallback convention.** Wire-decoding factories that reference this
/// enum follow a consistent pattern: the enum's `fromString` throws
/// [ArgumentError] for unknown values, and the factory that calls it catches
/// the error and falls back to the canonical role for that event type (e.g.
/// `assistant` for [TextMessageStartEvent], `tool` for
/// [ToolCallResultEvent], `reasoning` for [ReasoningMessageStartEvent]).
/// The one exception is [TextMessageChunkEvent], where `role` is nullable —
/// it falls back to `null` because "present but unrecognized" is distinct
/// from "absent". If you add a new role value here or a new event type that
/// references this enum, update the corresponding factory fall-back as well.
enum TextMessageRole {
  developer('developer'),
  system('system'),
  assistant('assistant'),
  user('user');

  final String value;
  const TextMessageRole(this.value);

  /// Parses [value] into a [TextMessageRole].
  ///
  /// Throws [ArgumentError] for unknown values. Callers decoding from the
  /// wire should use `TextMessageStartEvent.fromJson`, which absorbs the
  /// throw and falls back to [TextMessageRole.assistant] so a future
  /// server-side role does not tear down the SSE stream. This is the
  /// same "throw at the enum, absorb at the factory" pattern used by
  /// [ReasoningMessageRole] — see `dart-enum-parsing-safety.md` for the
  /// consistency rationale.
  static final Map<String, TextMessageRole> _byValue = Map.unmodifiable({
    for (final r in TextMessageRole.values) r.value: r,
  });

  static TextMessageRole fromString(String value) {
    return _byValue[value] ??
        (throw ArgumentError('Invalid text message role: $value'));
  }
}

// ============================================================================
// Text Message Events
// ============================================================================

/// Event indicating the start of a text message
final class TextMessageStartEvent extends BaseEvent {
  final String messageId;
  final TextMessageRole role;
  final String? name;

  const TextMessageStartEvent({
    required this.messageId,
    this.role = TextMessageRole.assistant,
    this.name,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageStart);

  factory TextMessageStartEvent.fromJson(Map<String, dynamic> json) {
    final messageId = JsonDecoder.requireEitherField<String>(
      json,
      'messageId',
      'message_id',
    );
    final roleStr = JsonDecoder.optionalField<String>(json, 'role');
    var role = TextMessageRole.assistant;
    if (roleStr != null) {
      try {
        role = TextMessageRole.fromString(roleStr);
      } on ArgumentError {
        // Forward-compat: an unknown wire role falls back to
        // `assistant` to keep the stream alive.
        //
        // We intentionally do NOT broaden to `catch (e)` or
        // `on Exception`: a wrong-typed `role` raises
        // `AGUIValidationError` from `optionalField<String>` above, and
        // a missing `messageId` raises `AGUIValidationError` from
        // `requireEitherField` — those MUST propagate to the decoder
        // boundary as protocol violations. Widening the catch would
        // silently absorb them. Mirrors
        // `ReasoningMessageStartEvent.fromJson`.
        role = TextMessageRole.assistant;
      }
    }
    return TextMessageStartEvent(
      messageId: messageId,
      role: role,
      name: JsonDecoder.optionalField<String>(json, 'name'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'role': role.value,
        if (name != null) 'name': name,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  TextMessageStartEvent copyWith({
    String? messageId,
    TextMessageRole? role,
    Object? name = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageStartEvent(
      messageId: messageId ?? this.messageId,
      role: role ?? this.role,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing text message content
final class TextMessageContentEvent extends BaseEvent {
  final String messageId;
  final String delta;

  const TextMessageContentEvent({
    required this.messageId,
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageContent);

  factory TextMessageContentEvent.fromJson(Map<String, dynamic> json) {
    // Validate the cheap required identifier FIRST so a missing-id error
    // surfaces before any payload-validation work — same convention as
    // `ReasoningMessageStartEvent.fromJson`.
    final messageId = JsonDecoder.requireEitherField<String>(
      json,
      'messageId',
      'message_id',
    );
    // Empty `delta` is accepted to match canonical TS/Python schemas
    // (`TextMessageContentEventSchema.delta: z.string()` /
    // pydantic `delta: str`). Servers may legitimately emit empty
    // chunks (e.g. a noop content refresh).
    final delta = JsonDecoder.requireField<String>(json, 'delta');

    return TextMessageContentEvent(
      messageId: messageId,
      delta: delta,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'delta': delta,
      };

  @override
  TextMessageContentEvent copyWith({
    String? messageId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageContentEvent(
      messageId: messageId ?? this.messageId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a text message
final class TextMessageEndEvent extends BaseEvent {
  final String messageId;

  const TextMessageEndEvent({
    required this.messageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageEnd);

  factory TextMessageEndEvent.fromJson(Map<String, dynamic> json) {
    return TextMessageEndEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
      };

  @override
  TextMessageEndEvent copyWith({
    String? messageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageEndEvent(
      messageId: messageId ?? this.messageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a chunk of text message content
final class TextMessageChunkEvent extends BaseEvent {
  final String? messageId;
  final TextMessageRole? role;
  final String? delta;
  final String? name;

  const TextMessageChunkEvent({
    this.messageId,
    this.role,
    this.delta,
    this.name,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.textMessageChunk);

  factory TextMessageChunkEvent.fromJson(Map<String, dynamic> json) {
    final roleStr = JsonDecoder.optionalField<String>(json, 'role');
    TextMessageRole? role;
    if (roleStr != null) {
      try {
        role = TextMessageRole.fromString(roleStr);
      } on ArgumentError {
        // Forward-compat: unknown wire role falls back to null.
        // Unlike TextMessageStartEvent (required role → assistant default),
        // role here is nullable/optional — null is the correct sentinel for
        // "value was present on the wire but unrecognized."
        role = null;
      }
    }
    return TextMessageChunkEvent(
      messageId: JsonDecoder.optionalEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      role: role,
      delta: JsonDecoder.optionalField<String>(json, 'delta'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        if (messageId != null) 'messageId': messageId,
        if (role != null) 'role': role!.value,
        if (delta != null) 'delta': delta,
        if (name != null) 'name': name,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  TextMessageChunkEvent copyWith({
    Object? messageId = kUnsetSentinel,
    Object? role = kUnsetSentinel,
    Object? delta = kUnsetSentinel,
    Object? name = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return TextMessageChunkEvent(
      messageId: identical(messageId, kUnsetSentinel)
          ? this.messageId
          : messageId as String?,
      role: identical(role, kUnsetSentinel)
          ? this.role
          : role as TextMessageRole?,
      delta: identical(delta, kUnsetSentinel) ? this.delta : delta as String?,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Thinking Events
// ============================================================================

/// Event indicating the start of a thinking section
final class ThinkingStartEvent extends BaseEvent {
  final String? title;

  const ThinkingStartEvent({
    this.title,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingStart);

  factory ThinkingStartEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingStartEvent(
      title: JsonDecoder.optionalField<String>(json, 'title'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        if (title != null) 'title': title,
      };

  @override
  ThinkingStartEvent copyWith({
    Object? title = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingStartEvent(
      title: identical(title, kUnsetSentinel) ? this.title : title as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing thinking content.
///
/// Dart-only legacy: never part of the canonical AG-UI protocol
/// (TypeScript/Python). Included only for backward compatibility with
/// pre-0.2.0 Dart consumers. Use [ThinkingTextMessageContentEvent] instead.
@Deprecated(_kThinkingContentEventDeprecation)
final class ThinkingContentEvent extends BaseEvent {
  final String delta;

  @Deprecated(_kThinkingContentEventDeprecation)
  const ThinkingContentEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingContent);

  factory ThinkingContentEvent.fromJson(Map<String, dynamic> json) {
    // Empty `delta` is accepted to match the relaxed canonical contract
    // (`z.string()` / `delta: str`). Migrate to [ReasoningMessageContentEvent].
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    return ThinkingContentEvent(
      delta: delta,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'delta': delta,
      };

  @override
  ThinkingContentEvent copyWith({
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingContentEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a thinking section
final class ThinkingEndEvent extends BaseEvent {
  const ThinkingEndEvent({
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.thinkingEnd);

  factory ThinkingEndEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingEndEvent(
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  ThinkingEndEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingEndEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the start of a thinking text message.
///
/// Deprecated in favor of [ReasoningMessageStartEvent], mirroring the
/// canonical TypeScript SDK deprecation of `THINKING_TEXT_MESSAGE_*` in
/// favor of `REASONING_*`. Decoding remains supported for backward
/// compatibility; scheduled for removal in 1.0.0.
@Deprecated(_kThinkingTextMessageStartEventDeprecation)
final class ThinkingTextMessageStartEvent extends BaseEvent {
  @Deprecated(_kThinkingTextMessageStartEventDeprecation)
  const ThinkingTextMessageStartEvent({
    super.timestamp,
    super.rawEvent,
    // ignore: deprecated_member_use_from_same_package
  }) : super(eventType: EventType.thinkingTextMessageStart);

  factory ThinkingTextMessageStartEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingTextMessageStartEvent(
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  ThinkingTextMessageStartEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageStartEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing thinking text message content.
///
/// Deprecated in favor of [ReasoningMessageContentEvent], mirroring the
/// canonical TypeScript SDK deprecation of `THINKING_TEXT_MESSAGE_*` in
/// favor of `REASONING_*`. Decoding remains supported for backward
/// compatibility; scheduled for removal in 1.0.0.
@Deprecated(_kThinkingTextMessageContentEventDeprecation)
final class ThinkingTextMessageContentEvent extends BaseEvent {
  final String delta;

  @Deprecated(_kThinkingTextMessageContentEventDeprecation)
  const ThinkingTextMessageContentEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
    // ignore: deprecated_member_use_from_same_package
  }) : super(eventType: EventType.thinkingTextMessageContent);

  factory ThinkingTextMessageContentEvent.fromJson(Map<String, dynamic> json) {
    // No identifier on this event. Empty `delta` is accepted to match the
    // relaxed canonical contract (`z.string()` / `delta: str`).
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    return ThinkingTextMessageContentEvent(
      delta: delta,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'delta': delta,
      };

  @override
  ThinkingTextMessageContentEvent copyWith({
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageContentEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a thinking text message.
///
/// Deprecated in favor of [ReasoningMessageEndEvent], mirroring the
/// canonical TypeScript SDK deprecation of `THINKING_TEXT_MESSAGE_*` in
/// favor of `REASONING_*`. Decoding remains supported for backward
/// compatibility; scheduled for removal in 1.0.0.
@Deprecated(_kThinkingTextMessageEndEventDeprecation)
final class ThinkingTextMessageEndEvent extends BaseEvent {
  @Deprecated(_kThinkingTextMessageEndEventDeprecation)
  const ThinkingTextMessageEndEvent({
    super.timestamp,
    super.rawEvent,
    // ignore: deprecated_member_use_from_same_package
  }) : super(eventType: EventType.thinkingTextMessageEnd);

  factory ThinkingTextMessageEndEvent.fromJson(Map<String, dynamic> json) {
    return ThinkingTextMessageEndEvent(
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  ThinkingTextMessageEndEvent copyWith({
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ThinkingTextMessageEndEvent(
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Tool Call Events
// ============================================================================

/// Event indicating the start of a tool call
final class ToolCallStartEvent extends BaseEvent {
  final String toolCallId;
  final String toolCallName;
  final String? parentMessageId;

  const ToolCallStartEvent({
    required this.toolCallId,
    required this.toolCallName,
    this.parentMessageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallStart);

  factory ToolCallStartEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallStartEvent(
      toolCallId: JsonDecoder.requireEitherField<String>(
        json,
        'toolCallId',
        'tool_call_id',
      ),
      toolCallName: JsonDecoder.requireEitherField<String>(
        json,
        'toolCallName',
        'tool_call_name',
      ),
      parentMessageId: JsonDecoder.optionalEitherField<String>(
        json,
        'parentMessageId',
        'parent_message_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'toolCallId': toolCallId,
        'toolCallName': toolCallName,
        if (parentMessageId != null) 'parentMessageId': parentMessageId,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  ToolCallStartEvent copyWith({
    String? toolCallId,
    String? toolCallName,
    Object? parentMessageId = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallStartEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      toolCallName: toolCallName ?? this.toolCallName,
      parentMessageId: identical(parentMessageId, kUnsetSentinel)
          ? this.parentMessageId
          : parentMessageId as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing tool call arguments
final class ToolCallArgsEvent extends BaseEvent {
  final String toolCallId;
  final String delta;

  const ToolCallArgsEvent({
    required this.toolCallId,
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallArgs);

  factory ToolCallArgsEvent.fromJson(Map<String, dynamic> json) {
    final toolCallId = JsonDecoder.requireEitherField<String>(
      json,
      'toolCallId',
      'tool_call_id',
    );
    // Empty `delta` is accepted to match canonical TS/Python schemas
    // (`ToolCallArgsEventSchema.delta: z.string()` / pydantic `delta: str`).
    final delta = JsonDecoder.requireField<String>(json, 'delta');
    return ToolCallArgsEvent(
      toolCallId: toolCallId,
      delta: delta,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'toolCallId': toolCallId,
        'delta': delta,
      };

  @override
  ToolCallArgsEvent copyWith({
    String? toolCallId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallArgsEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a tool call
final class ToolCallEndEvent extends BaseEvent {
  final String toolCallId;

  const ToolCallEndEvent({
    required this.toolCallId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallEnd);

  factory ToolCallEndEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallEndEvent(
      toolCallId: JsonDecoder.requireEitherField<String>(
        json,
        'toolCallId',
        'tool_call_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'toolCallId': toolCallId,
      };

  @override
  ToolCallEndEvent copyWith({
    String? toolCallId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallEndEvent(
      toolCallId: toolCallId ?? this.toolCallId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a chunk of tool call content
final class ToolCallChunkEvent extends BaseEvent {
  final String? toolCallId;
  final String? toolCallName;
  final String? parentMessageId;
  final String? delta;

  const ToolCallChunkEvent({
    this.toolCallId,
    this.toolCallName,
    this.parentMessageId,
    this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallChunk);

  factory ToolCallChunkEvent.fromJson(Map<String, dynamic> json) {
    return ToolCallChunkEvent(
      toolCallId: JsonDecoder.optionalEitherField<String>(
        json,
        'toolCallId',
        'tool_call_id',
      ),
      toolCallName: JsonDecoder.optionalEitherField<String>(
        json,
        'toolCallName',
        'tool_call_name',
      ),
      parentMessageId: JsonDecoder.optionalEitherField<String>(
        json,
        'parentMessageId',
        'parent_message_id',
      ),
      delta: JsonDecoder.optionalField<String>(json, 'delta'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        if (toolCallId != null) 'toolCallId': toolCallId,
        if (toolCallName != null) 'toolCallName': toolCallName,
        if (parentMessageId != null) 'parentMessageId': parentMessageId,
        if (delta != null) 'delta': delta,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  ToolCallChunkEvent copyWith({
    Object? toolCallId = kUnsetSentinel,
    Object? toolCallName = kUnsetSentinel,
    Object? parentMessageId = kUnsetSentinel,
    Object? delta = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallChunkEvent(
      toolCallId: identical(toolCallId, kUnsetSentinel)
          ? this.toolCallId
          : toolCallId as String?,
      toolCallName: identical(toolCallName, kUnsetSentinel)
          ? this.toolCallName
          : toolCallName as String?,
      parentMessageId: identical(parentMessageId, kUnsetSentinel)
          ? this.parentMessageId
          : parentMessageId as String?,
      delta: identical(delta, kUnsetSentinel) ? this.delta : delta as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Role for tool-call result messages (aligned with the AG-UI protocol).
///
/// Currently a single-variant enum mirroring the canonical
/// `Literal["tool"]` (Python) / `z.literal("tool")` (TypeScript). Modeled
/// as an enum so a future role addition can land without churning every
/// call site, and so producers cannot accidentally emit a free-form
/// string like `'developer'` on a `TOOL_CALL_RESULT` event.
enum ToolCallResultRole {
  tool('tool');

  final String value;
  const ToolCallResultRole(this.value);

  /// Parses [value] into a [ToolCallResultRole].
  ///
  /// Throws [ArgumentError] for unknown values. Callers decoding from the
  /// wire should use `ToolCallResultEvent.fromJson`, which absorbs the
  /// throw and falls back to [ToolCallResultRole.tool] so a future
  /// server-side role does not tear down the SSE stream. Mirrors
  /// `ReasoningMessageRole.fromString` and `TextMessageRole.fromString`.
  static final Map<String, ToolCallResultRole> _byValue = Map.unmodifiable({
    for (final r in ToolCallResultRole.values) r.value: r,
  });

  static ToolCallResultRole fromString(String value) {
    return _byValue[value] ??
        (throw ArgumentError('Invalid tool call result role: $value'));
  }
}

/// Event containing the result of a tool call
final class ToolCallResultEvent extends BaseEvent {
  final String messageId;
  final String toolCallId;
  final String content;

  /// Optional role discriminator for the tool-call result.
  ///
  /// `copyWith(role: null)` clears this field via the [kUnsetSentinel]
  /// pattern — same as every other nullable field on this event.
  final ToolCallResultRole? role;

  const ToolCallResultEvent({
    required this.messageId,
    required this.toolCallId,
    required this.content,
    this.role,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.toolCallResult);

  factory ToolCallResultEvent.fromJson(Map<String, dynamic> json) {
    final roleStr = JsonDecoder.optionalField<String>(json, 'role');
    ToolCallResultRole? role;
    if (roleStr != null) {
      try {
        role = ToolCallResultRole.fromString(roleStr);
      } on ArgumentError {
        // Forward-compat: an unknown wire role falls back to `tool` so a
        // future server-side role does not tear down the SSE stream.
        // Mirrors `TextMessageStartEvent.fromJson` /
        // `ReasoningMessageStartEvent.fromJson`. Narrow `on ArgumentError`
        // (not `catch (e)`) preserves propagation of `AGUIValidationError`
        // raised by `optionalField<String>` for a wrong-typed `role`.
        role = ToolCallResultRole.tool;
      }
    }
    return ToolCallResultEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      toolCallId: JsonDecoder.requireEitherField<String>(
        json,
        'toolCallId',
        'tool_call_id',
      ),
      content: JsonDecoder.requireField<String>(json, 'content'),
      role: role,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'toolCallId': toolCallId,
        'content': content,
        if (role != null) 'role': role!.value,
      };

  @override
  ToolCallResultEvent copyWith({
    String? messageId,
    String? toolCallId,
    String? content,
    Object? role = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ToolCallResultEvent(
      messageId: messageId ?? this.messageId,
      toolCallId: toolCallId ?? this.toolCallId,
      content: content ?? this.content,
      role: identical(role, kUnsetSentinel)
          ? this.role
          : role as ToolCallResultRole?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// State Events
// ============================================================================

/// Event containing a snapshot of the state
final class StateSnapshotEvent extends BaseEvent {
  /// The state snapshot. Type [State] permits any JSON shape including
  /// `null` (an empty / cleared state is a valid wire payload — see the
  /// matching note on [StateSnapshotEvent.fromJson]).
  final State snapshot;

  const StateSnapshotEvent({
    required this.snapshot,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stateSnapshot);

  factory StateSnapshotEvent.fromJson(Map<String, dynamic> json) {
    // `snapshot` may be any JSON shape (including `null` for an empty
    // state), so we cannot use `requireField<T>` (which rejects null
    // values). The field MUST be present though — its absence is a
    // protocol violation, not "the snapshot is empty". Distinguishing
    // missing-key from explicit-null is the whole point of this check.
    if (!json.containsKey('snapshot')) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: 'snapshot',
        json: json,
      );
    }
    return StateSnapshotEvent(
      snapshot: json['snapshot'],
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'snapshot': snapshot,
      };

  @override
  StateSnapshotEvent copyWith({
    Object? snapshot = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StateSnapshotEvent(
      snapshot: identical(snapshot, kUnsetSentinel) ? this.snapshot : snapshot,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a delta of the state (JSON Patch RFC 6902)
final class StateDeltaEvent extends BaseEvent {
  // RFC 6902 patch operations are always JSON objects ({op, path, …}).
  // Using List<Map<String, dynamic>> (via requireListField) surfaces
  // non-object elements as AGUIValidationError at the decoder boundary
  // instead of leaking a downstream TypeError at the first op['op'] access.
  final List<Map<String, dynamic>> delta;

  const StateDeltaEvent({
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stateDelta);

  factory StateDeltaEvent.fromJson(Map<String, dynamic> json) {
    return StateDeltaEvent(
      delta: JsonDecoder.requireListField<Map<String, dynamic>>(json, 'delta'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'delta': delta,
      };

  @override
  StateDeltaEvent copyWith({
    List<Map<String, dynamic>>? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StateDeltaEvent(
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a snapshot of messages
///
/// **Sensitive-data warning.** [rawEvent] is automatically cleared (set to
/// `null`) when ANY inner message carries cipher data. This includes every
/// [BaseMessage] subtype ([ReasoningMessage], [AssistantMessage],
/// [ToolMessage], [SystemMessage], [DeveloperMessage], [UserMessage]) with a
/// non-null [encryptedValue], AND any `role: 'activity'` entry whose wire form
/// carries an `encryptedValue` / `encrypted_value` key (which
/// [ActivityMessage.fromJson] silently strips from the structured field).
/// This prevents the verbatim wire map — which may include cipher data — from
/// leaking through [BaseEvent.rawEvent] to log sinks or reflection-based
/// serializers. Proxy operators that need the verbatim wire form should keep
/// their own copy of the raw JSON before calling [fromJson].
/// See [ReasoningEncryptedValueEvent.fromJson] for the same pattern on
/// individual cipher events.
final class MessagesSnapshotEvent extends BaseEvent {
  final List<Message> messages;

  MessagesSnapshotEvent({
    required this.messages,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.messagesSnapshot) {
    // Direct-construction caveat: this guard only inspects the structured
    // Message.encryptedValue field. A caller that already has a wire-form
    // rawEvent map whose payload contains an encryptedValue key on an
    // activity-role entry can still violate the cipher-scrub invariant —
    // ActivityMessage.encryptedValue is always null by construction, so it
    // cannot be detected here. Pass rawEvent: null or pre-scrub the map before
    // invoking this constructor for activity-role cipher data. fromJson enforces
    // both code paths; this constructor enforces only the structured-field one.
    if (rawEvent != null && messages.any((m) => m.encryptedValue != null)) {
      throw AGUIValidationError(
        message: 'Direct construction with rawEvent + cipher-bearing messages '
            'violates the scrub invariant. Pass rawEvent: null or pre-scrub.',
        field: 'rawEvent',
      );
    }
  }

  factory MessagesSnapshotEvent.fromJson(Map<String, dynamic> json) {
    final rawMessages = JsonDecoder.requireListField<Map<String, dynamic>>(
      json,
      'messages',
    );
    final messages = <Message>[];
    for (var i = 0; i < rawMessages.length; i++) {
      try {
        messages.add(Message.fromJson(rawMessages[i]));
      } catch (e) {
        if (e is AGUIValidationError) {
          // Always drop json: — the inner Message map can carry encryptedValue
          // for Tool/Reasoning subtypes. Preserve cause: only when the inner
          // error already cleared its own json: field (e.json == null), which
          // indicates the inner factory was cipher-aware and the cause chain
          // does not expose raw wire data. Non-cipher messages (Developer,
          // System, User) typically produce errors with e.json == null, so
          // their cause is preserved for ergonomic debugging.
          throw AGUIValidationError(
            message: e.message,
            field: e.field != null ? 'messages[$i].${e.field}' : 'messages[$i]',
            value: e.value,
            cause: e.json == null ? e : null,
          );
        }
        throw AGUIValidationError(
          message: 'Failed to decode message at index $i: $e',
          field: 'messages[$i]',
          cause: e,
        );
      }
    }
    // Auto-scrub rawEvent when any inner message carries cipher data. Storing
    // the verbatim wire map in rawEvent would undo the cipher scrubbing that
    // the ReasoningMessage factory already applied to the structured field.
    // Proxies that need the verbatim wire form should keep their own copy of
    // the raw JSON before calling fromJson.
    //
    // ActivityMessage.fromJson silently strips wire-level encryptedValue from
    // the structured field (the constructor does not accept it), so the
    // structured-field predicate alone would miss a cipher on an
    // ActivityMessage. We check rawMessages directly for role == 'activity'
    // entries that still carry a cipher key on the wire.
    //
    // SCRUB CONTRACT: this check assumes encryptedValue / encrypted_value is
    // the only cipher-named key on any Message subtype. If a future subtype
    // adds a different sensitive payload key, this hasCipher predicate MUST be
    // extended in parallel.
    final hasCipher = messages.any((m) => m.encryptedValue != null) ||
        rawMessages.any((m) =>
            m['role'] == 'activity' &&
            (m.containsKey('encryptedValue') ||
                m.containsKey('encrypted_value')));
    return MessagesSnapshotEvent(
      messages: messages,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: hasCipher ? null : _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messages': messages.map((m) => m.toJson()).toList(),
      };

  /// Creates a copy of this event with the given fields replaced.
  ///
  /// **Cipher-safety note.** When the resolved messages list does NOT carry
  /// cipher data (`encryptedValue == null` for every message), [rawEvent] is
  /// applied normally — kept, cleared, or replaced per the standard sentinel
  /// semantics. When ANY resolved message carries cipher data
  /// (`encryptedValue != null`), [rawEvent] is silently forced to `null`
  /// regardless of the supplied value. This mirrors the `fromJson` invariant
  /// that prevents the raw wire map (which contains the cipher payload) from
  /// leaking through `rawEvent`. Callers that have already scrubbed
  /// `encryptedValue` and need to retain a sanitized `rawEvent` map should
  /// construct a new [MessagesSnapshotEvent] directly with
  /// `rawEvent: scrubbedMap` rather than using `copyWith`.
  @override
  MessagesSnapshotEvent copyWith({
    List<Message>? messages,
    int? timestamp,
    Object? rawEvent = kUnsetSentinel,
  }) {
    final newMessages = messages ?? this.messages;
    // Re-apply the fromJson cipher-scrub invariant: if any message in the
    // (possibly updated) list carries cipher data, force rawEvent to null so
    // the wire map cannot be reattached and expose encrypted content.
    // ActivityMessage always returns null for encryptedValue by construction;
    // see SCRUB CONTRACT comment in fromJson.
    final hasCipher = newMessages.any((m) => m.encryptedValue != null);
    // Log in all builds (including release) when a caller passes a non-null
    // rawEvent that will be silently scrubbed. The force-to-null below is
    // the authoritative safety measure; the log helps callers diagnose
    // unexpected scrub in production without crashing.
    if (hasCipher &&
        !identical(rawEvent, kUnsetSentinel) &&
        rawEvent != null) {
      developer.log(
        'MessagesSnapshotEvent.copyWith: rawEvent is silently forced to null '
        'when any message carries encryptedValue. Construct directly if you '
        'need to retain a sanitized rawEvent.',
        name: 'ag_ui.cipher_scrub',
        level: 900, // WARNING
      );
    }
    final dynamic resolvedRaw;
    if (hasCipher) {
      resolvedRaw = null;
    } else if (identical(rawEvent, kUnsetSentinel)) {
      resolvedRaw = this.rawEvent;
    } else {
      resolvedRaw = rawEvent;
    }
    return MessagesSnapshotEvent(
      messages: newMessages,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: resolvedRaw,
    );
  }
}

// ============================================================================
// Activity Events
// ============================================================================

/// Event containing a snapshot of an activity message.
///
/// Note: [content] is typed `Object?` rather than `Map<String, dynamic>`.
/// The canonical TypeScript schema requires a non-null record
/// (`z.record(z.any())`); the Dart SDK is intentionally more permissive on
/// the *value* (allows primitives and `null`) to stay forward-compatible
/// with the Python reference server's `content: Any`. The *key itself*
/// is still required — see the matching note on `StateSnapshotEvent.fromJson`
/// for why we check key-presence rather than `requireField<T>`. Treat any
/// non-record value you encounter as a wire-protocol surprise rather than
/// a contract.
final class ActivitySnapshotEvent extends BaseEvent {
  final String messageId;
  final String activityType;
  final Object? content;

  /// `true` (the default) means this snapshot replaces any prior content
  /// for the same [messageId]; `false` means it merges/extends.
  ///
  /// Optional on the wire (`replace: z.boolean().optional().default(true)`
  /// in TS, `replace: bool = True` in Python). [toJson] omits the field
  /// when it equals the default `true`, matching canonical TypeScript and
  /// Python wire output. `fromJson` restores the default when the field is
  /// absent, so round-trip semantics are preserved.
  final bool replace;

  const ActivitySnapshotEvent({
    required this.messageId,
    required this.activityType,
    required this.content,
    this.replace = true,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.activitySnapshot);

  factory ActivitySnapshotEvent.fromJson(Map<String, dynamic> json) {
    // `content` may be any JSON shape (including `null`) but MUST be
    // present — see the matching note on `StateSnapshotEvent.fromJson`
    // for why we check key-presence rather than `requireField<T>`.
    if (!json.containsKey('content')) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: 'content',
        json: json,
      );
    }
    return ActivitySnapshotEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      activityType: JsonDecoder.requireEitherField<String>(
        json,
        'activityType',
        'activity_type',
      ),
      content: json['content'],
      replace: JsonDecoder.optionalField<bool>(json, 'replace') ?? true,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'activityType': activityType,
        'content': content,
        // Omit `replace` when it equals the default `true`, matching canonical
        // TS/Python wire output. `fromJson` defaults to `true` when absent, so
        // round-trip semantics are preserved.
        if (!replace) 'replace': replace,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  ActivitySnapshotEvent copyWith({
    String? messageId,
    String? activityType,
    Object? content = kUnsetSentinel,
    bool? replace,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ActivitySnapshotEvent(
      messageId: messageId ?? this.messageId,
      activityType: activityType ?? this.activityType,
      content: identical(content, kUnsetSentinel) ? this.content : content,
      replace: replace ?? this.replace,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a JSON Patch (RFC 6902) delta for an activity message
final class ActivityDeltaEvent extends BaseEvent {
  final String messageId;
  final String activityType;
  // RFC 6902 patch operations are always JSON objects ({op, path, …}).
  // Using List<Map<String, dynamic>> (via requireListField) surfaces
  // non-object elements as AGUIValidationError at the decoder boundary.
  final List<Map<String, dynamic>> patch;

  const ActivityDeltaEvent({
    required this.messageId,
    required this.activityType,
    required this.patch,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.activityDelta);

  factory ActivityDeltaEvent.fromJson(Map<String, dynamic> json) {
    return ActivityDeltaEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      activityType: JsonDecoder.requireEitherField<String>(
        json,
        'activityType',
        'activity_type',
      ),
      patch: JsonDecoder.requireListField<Map<String, dynamic>>(json, 'patch'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'activityType': activityType,
        'patch': patch,
      };

  @override
  ActivityDeltaEvent copyWith({
    String? messageId,
    String? activityType,
    List<Map<String, dynamic>>? patch,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ActivityDeltaEvent(
      messageId: messageId ?? this.messageId,
      activityType: activityType ?? this.activityType,
      patch: patch ?? this.patch,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event wrapping a raw, uninterpreted upstream event payload.
///
/// Three related but distinct concepts coexist on this class:
/// - [eventType]: always `EventType.raw` — the discriminator that routes wire
///   payloads here via `BaseEvent.fromJson`.
/// - [event]: the raw upstream event payload as decoded from the wire JSON
///   `event` field. May be any JSON shape, including `null`.
/// - [rawEvent]: inherited from [BaseEvent] — the verbatim wire JSON of the
///   *enclosing* SSE message (the whole `{type, event, ...}` map). Populated
///   by `_readRawEvent` when the producer includes a `rawEvent` /
///   `raw_event` key. Unrelated to the [event] field above.
final class RawEvent extends BaseEvent {
  final dynamic event;
  final String? source;

  const RawEvent({
    required this.event,
    this.source,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.raw);

  /// Decodes a [RawEvent] from a JSON map.
  ///
  /// **Cross-SDK note.** The `event` key MUST be present on the wire — this
  /// Dart SDK aligns with the Python `event: Any` (required) schema rather
  /// than the TypeScript `z.any()` schema which permits `undefined` (i.e.
  /// an absent key). A TypeScript server that omits the `event` key entirely
  /// will be rejected with `AGUIValidationError(field: 'event')`.
  factory RawEvent.fromJson(Map<String, dynamic> json) {
    // `event` may be any JSON shape but MUST be present — see the
    // matching note on `StateSnapshotEvent.fromJson` for why we check
    // key-presence rather than `requireField<T>`.
    if (!json.containsKey('event')) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: 'event',
        json: json,
      );
    }
    return RawEvent(
      event: json['event'],
      source: JsonDecoder.optionalField<String>(json, 'source'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'event': event,
        if (source != null) 'source': source,
      };

  // See `_Unset` (top of file) for the sentinel rationale. Both `event`
  // and `source` are nullable on the wire, so callers need explicit-clear
  // semantics to drop a stale upstream payload.
  @override
  RawEvent copyWith({
    Object? event = kUnsetSentinel,
    Object? source = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RawEvent(
      event: identical(event, kUnsetSentinel) ? this.event : event,
      source:
          identical(source, kUnsetSentinel) ? this.source : source as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a custom event
final class CustomEvent extends BaseEvent {
  final String name;
  final dynamic value;

  const CustomEvent({
    required this.name,
    required this.value,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.custom);

  factory CustomEvent.fromJson(Map<String, dynamic> json) {
    // `value` may be any JSON shape but MUST be present — see the
    // matching note on `StateSnapshotEvent.fromJson` for why we check
    // key-presence rather than `requireField<T>`.
    if (!json.containsKey('value')) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: 'value',
        json: json,
      );
    }
    return CustomEvent(
      name: JsonDecoder.requireField<String>(json, 'name'),
      value: json['value'],
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'name': name,
        'value': value,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  CustomEvent copyWith({
    String? name,
    Object? value = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return CustomEvent(
      name: name ?? this.name,
      value: identical(value, kUnsetSentinel) ? this.value : value,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Lifecycle Events
// ============================================================================

/// Event indicating that a run has started
final class RunStartedEvent extends BaseEvent {
  final String threadId;
  final String runId;
  final String? parentRunId;

  /// Optional `RUN_STARTED` input snapshot. On the wire the `input` key
  /// must hold a JSON object — `optionalField<Map<String, dynamic>>` in
  /// [RunStartedEvent.fromJson] rejects a wrong-typed value (string, list,
  /// number, etc.) with `AGUIValidationError(field: 'input')`. An absent
  /// or explicit-null `input` decodes as `null`.
  final RunAgentInput? input;

  RunStartedEvent({
    required this.threadId,
    required this.runId,
    this.parentRunId,
    this.input,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runStarted) {
    if (rawEvent != null &&
        input != null &&
        input!.messages.any((m) => m.encryptedValue != null)) {
      throw AGUIValidationError(
        message:
            'Direct construction with rawEvent + cipher-bearing input.messages '
            'violates the scrub invariant. Pass rawEvent: null or pre-scrub.',
        field: 'rawEvent',
      );
    }
  }

  factory RunStartedEvent.fromJson(Map<String, dynamic> json) {
    final inputJson = JsonDecoder.optionalField<Map<String, dynamic>>(
      json,
      'input',
    );
    RunAgentInput? input;
    if (inputJson != null) {
      try {
        input = RunAgentInput.fromJson(inputJson);
      } on AGUIValidationError catch (e) {
        // Omit json: — e.json (the inner RunAgentInput payload) can carry
        // encryptedValue via input.messages[*]. Omit cause: for the same
        // reason: the cause chain exposes e.json to reflection-based log
        // shippers. Surface only the field path and the non-cipher value.
        throw AGUIValidationError(
          message: e.message,
          field: e.field != null ? 'input.${e.field}' : 'input',
          value: e.value,
        );
      }
    }
    // Auto-scrub rawEvent when any input message carries cipher data, mirroring
    // the MessagesSnapshotEvent.fromJson invariant.
    //
    // ActivityMessage.fromJson silently strips wire-level encryptedValue from
    // the structured field, so the structured-field predicate alone would miss
    // a cipher on an ActivityMessage. We check the raw wire messages list
    // directly for role == 'activity' entries that still carry a cipher key.
    //
    // Scope note: this predicate only sweeps input.messages (the structured
    // RunAgentInput). If a malformed payload omits `input` entirely but carries
    // encrypted material under a top-level key, that material is not caught
    // here. The attack surface is narrow (requires a malformed payload AND an
    // absent `input` key) and asymmetric with MessagesSnapshotEvent by design:
    // RunStartedEvent only encrypts the input.messages path.
    //
    // SCRUB CONTRACT: this check assumes encryptedValue / encrypted_value is
    // the only cipher-named key on any Message subtype. If a future subtype
    // adds a different sensitive payload key, this hasCipher predicate MUST be
    // extended in parallel.
    final rawInputMessages = inputJson != null
        ? (inputJson['messages'] is List<dynamic>
            ? inputJson['messages'] as List<dynamic>
            : const <dynamic>[])
        : const <dynamic>[];
    final hasCipher = input != null &&
        (input.messages.any((m) => m.encryptedValue != null) ||
            rawInputMessages.any((m) =>
                m is Map<String, dynamic> &&
                m['role'] == 'activity' &&
                (m.containsKey('encryptedValue') ||
                    m.containsKey('encrypted_value'))));
    return RunStartedEvent(
      threadId: JsonDecoder.requireEitherField<String>(
        json,
        'threadId',
        'thread_id',
      ),
      runId: JsonDecoder.requireEitherField<String>(
        json,
        'runId',
        'run_id',
      ),
      parentRunId: JsonDecoder.optionalEitherField<String>(
        json,
        'parentRunId',
        'parent_run_id',
      ),
      input: input,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: hasCipher ? null : _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'threadId': threadId,
        'runId': runId,
        if (parentRunId != null) 'parentRunId': parentRunId,
        if (input != null) 'input': input!.toJson(),
      };

  /// Creates a copy of this event with the given fields replaced.
  ///
  /// **Cipher-safety note.** If any message in the resolved `input.messages`
  /// list carries cipher data (`encryptedValue != null`), the `rawEvent`
  /// parameter is silently forced to `null` regardless of the value the caller
  /// supplies. This mirrors the `fromJson` invariant that prevents the raw wire
  /// map from leaking cipher payloads through `rawEvent`. Callers that have
  /// already scrubbed a sanitized `rawEvent` map should construct a new
  /// [RunStartedEvent] directly with `rawEvent: scrubbedMap` rather than
  /// calling `copyWith`.
  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  RunStartedEvent copyWith({
    String? threadId,
    String? runId,
    Object? parentRunId = kUnsetSentinel,
    Object? input = kUnsetSentinel,
    int? timestamp,
    Object? rawEvent = kUnsetSentinel,
  }) {
    // The sentinel check MUST come before the type check — if input IS the
    // sentinel, `input is! RunAgentInput?` evaluates true (Object is not
    // RunAgentInput?) and would incorrectly throw. Swapping the two conditions
    // breaks all no-arg copyWith() calls.
    if (!identical(input, kUnsetSentinel) && input is! RunAgentInput?) {
      throw ArgumentError.value(
        input,
        'input',
        'must be RunAgentInput?, null, or kUnsetSentinel',
      );
    }
    final newInput = identical(input, kUnsetSentinel)
        ? this.input
        : input as RunAgentInput?;
    // Re-apply the fromJson cipher-scrub invariant on the resolved input.
    final hasCipher =
        newInput != null && newInput.messages.any((m) => m.encryptedValue != null);
    // Log in all builds (including release) when a caller passes a non-null
    // rawEvent that will be silently scrubbed. The force-to-null below is
    // the authoritative safety measure; the log helps callers diagnose
    // unexpected scrub in production without crashing.
    if (hasCipher &&
        !identical(rawEvent, kUnsetSentinel) &&
        rawEvent != null) {
      developer.log(
        'RunStartedEvent.copyWith: rawEvent is silently forced to null '
        'when any input message carries encryptedValue. Construct directly if '
        'you need to retain a sanitized rawEvent.',
        name: 'ag_ui.cipher_scrub',
        level: 900, // WARNING
      );
    }
    final dynamic resolvedRaw;
    if (hasCipher) {
      resolvedRaw = null;
    } else if (identical(rawEvent, kUnsetSentinel)) {
      resolvedRaw = this.rawEvent;
    } else {
      resolvedRaw = rawEvent;
    }
    return RunStartedEvent(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      parentRunId: identical(parentRunId, kUnsetSentinel)
          ? this.parentRunId
          : parentRunId as String?,
      input: newInput,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: resolvedRaw,
    );
  }
}

/// Event indicating that a run has finished
final class RunFinishedEvent extends BaseEvent {
  final String threadId;
  final String runId;

  /// Optional run-completion payload (`z.any().optional()` /
  /// `Optional[Any] = None` in TS/Python). On the wire, an explicit
  /// `'result': null` and an absent `result` key are equivalent — both
  /// produce a [RunFinishedEvent] with `result == null`, and [toJson]
  /// drops the key when `result` is null.
  ///
  /// The [kUnsetSentinel] on [copyWith] (`Object? result = kUnsetSentinel`)
  /// is for in-memory disambiguation only — it lets callers explicitly clear
  /// a previously-set result without constructing a new event. It is NOT a
  /// wire-protocol distinction: both `null` and absent produce identical
  /// `toJson` output (key omitted). Do not mirror the
  /// `ActivitySnapshotEvent.content` always-emit pattern here; the protocol
  /// does not require [RunFinishedEvent.result] on the wire. If you need the
  /// distinction visible in the wire output, construct a new [RunFinishedEvent]
  /// directly with the field always emitted.
  final dynamic result;

  const RunFinishedEvent({
    required this.threadId,
    required this.runId,
    this.result,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runFinished);

  factory RunFinishedEvent.fromJson(Map<String, dynamic> json) {
    // Unlike StateSnapshotEvent / RawEvent / CustomEvent / ActivitySnapshotEvent
    // which use containsKey to enforce key presence, `result` is truly optional
    // (canonical `z.any().optional()` / `Optional[Any] = None`). An absent key
    // and an explicit `'result': null` are equivalent — both produce `result == null`.
    return RunFinishedEvent(
      threadId: JsonDecoder.requireEitherField<String>(
        json,
        'threadId',
        'thread_id',
      ),
      runId: JsonDecoder.requireEitherField<String>(
        json,
        'runId',
        'run_id',
      ),
      result: json['result'],
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'threadId': threadId,
        'runId': runId,
        if (result != null) 'result': result,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  RunFinishedEvent copyWith({
    String? threadId,
    String? runId,
    Object? result = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RunFinishedEvent(
      threadId: threadId ?? this.threadId,
      runId: runId ?? this.runId,
      result: identical(result, kUnsetSentinel) ? this.result : result,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a run has encountered an error
final class RunErrorEvent extends BaseEvent {
  final String message;

  /// Optional machine-readable error code.
  final String? code;

  const RunErrorEvent({
    required this.message,
    this.code,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.runError);

  factory RunErrorEvent.fromJson(Map<String, dynamic> json) {
    return RunErrorEvent(
      message: JsonDecoder.requireField<String>(json, 'message'),
      code: JsonDecoder.optionalField<String>(json, 'code'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'message': message,
        if (code != null) 'code': code,
      };

  @override
  RunErrorEvent copyWith({
    String? message,
    Object? code = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return RunErrorEvent(
      message: message ?? this.message,
      code: identical(code, kUnsetSentinel) ? this.code : code as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a step has started
final class StepStartedEvent extends BaseEvent {
  final String stepName;

  const StepStartedEvent({
    required this.stepName,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stepStarted);

  factory StepStartedEvent.fromJson(Map<String, dynamic> json) {
    return StepStartedEvent(
      stepName: JsonDecoder.requireEitherField<String>(
        json,
        'stepName',
        'step_name',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'stepName': stepName,
      };

  @override
  StepStartedEvent copyWith({
    String? stepName,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StepStartedEvent(
      stepName: stepName ?? this.stepName,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating that a step has finished
final class StepFinishedEvent extends BaseEvent {
  final String stepName;

  const StepFinishedEvent({
    required this.stepName,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.stepFinished);

  factory StepFinishedEvent.fromJson(Map<String, dynamic> json) {
    return StepFinishedEvent(
      stepName: JsonDecoder.requireEitherField<String>(
        json,
        'stepName',
        'step_name',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'stepName': stepName,
      };

  @override
  StepFinishedEvent copyWith({
    String? stepName,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return StepFinishedEvent(
      stepName: stepName ?? this.stepName,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ============================================================================
// Reasoning Events
// ============================================================================

/// Role for reasoning messages (aligned with the AG-UI protocol).
///
/// Currently a single-variant enum mirroring the canonical
/// `Literal["reasoning"]` (Python) / `z.literal("reasoning")` (TypeScript).
/// Modeled as an enum so a future role addition can land without churning
/// every call site.
enum ReasoningMessageRole {
  reasoning('reasoning');

  final String value;
  const ReasoningMessageRole(this.value);

  /// Parses [value] into a [ReasoningMessageRole].
  ///
  /// Throws [ArgumentError] for unknown values. Callers decoding from the
  /// wire should use `ReasoningMessageStartEvent.fromJson`, which absorbs
  /// the throw and falls back to [ReasoningMessageRole.reasoning] so a
  /// future server-side role does not tear down the SSE stream.
  static final Map<String, ReasoningMessageRole> _byValue = Map.unmodifiable({
    for (final r in ReasoningMessageRole.values) r.value: r,
  });

  static ReasoningMessageRole fromString(String value) {
    return _byValue[value] ??
        (throw ArgumentError('Invalid reasoning message role: $value'));
  }
}

/// Subtype for [ReasoningEncryptedValueEvent].
enum ReasoningEncryptedValueSubtype {
  /// Wire spelling is `'tool-call'` with a hyphen — canonical across the
  /// AG-UI protocol (Python `Literal["tool-call"]`, TypeScript
  /// `z.literal("tool-call")`). The Dart symbol is `toolCall`; the dash is
  /// intentional, not a typo.
  toolCall('tool-call'),
  message('message');

  final String value;
  const ReasoningEncryptedValueSubtype(this.value);

  /// Parses [value] into a [ReasoningEncryptedValueSubtype].
  ///
  /// Throws [ArgumentError] for unknown values. The subtype is part of the
  /// protocol contract — there is no graceful fallback at the event level
  /// because choosing a default would silently mis-tag encrypted payloads.
  /// Wire failures bubble up as [DecodingError] under the standard decoder
  /// pipeline; consumers that want per-event recovery should set
  /// `skipInvalidEvents: true` on `EventStreamAdapter`.
  static final Map<String, ReasoningEncryptedValueSubtype> _byValue =
      Map.unmodifiable({
    for (final s in ReasoningEncryptedValueSubtype.values) s.value: s,
  });

  /// Throws [AGUIValidationError] (not [ArgumentError]) on unknown values —
  /// unlike [EventType.fromString] which throws [ArgumentError] so that
  /// `BaseEvent.fromJson`'s narrow `on ArgumentError` catch can distinguish
  /// unknown event types from factory bugs. Subtype is a cipher-data
  /// discriminator with no safe fallback; throwing [AGUIValidationError]
  /// directly surfaces it uniformly as [DecodingError] through the decoder
  /// pipeline without a wrapping layer.
  static ReasoningEncryptedValueSubtype fromString(String value) {
    return _byValue[value] ??
        (throw AGUIValidationError(
          message: 'Invalid reasoning encrypted value subtype: $value',
          field: 'subtype',
          value: value,
          // Intentionally omit json: — this helper is called from cipher-data path.
        ));
  }
}

/// Event indicating the start of a reasoning phase.
final class ReasoningStartEvent extends BaseEvent {
  final String messageId;

  const ReasoningStartEvent({
    required this.messageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningStart);

  factory ReasoningStartEvent.fromJson(Map<String, dynamic> json) {
    return ReasoningStartEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
      };

  @override
  ReasoningStartEvent copyWith({
    String? messageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningStartEvent(
      messageId: messageId ?? this.messageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the start of a reasoning message.
final class ReasoningMessageStartEvent extends BaseEvent {
  final String messageId;
  final ReasoningMessageRole role;

  const ReasoningMessageStartEvent({
    required this.messageId,
    this.role = ReasoningMessageRole.reasoning,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningMessageStart);

  factory ReasoningMessageStartEvent.fromJson(Map<String, dynamic> json) {
    // Validate the cheap required field FIRST so a missing-id error
    // surfaces before any role-parsing work.
    final messageId = JsonDecoder.requireEitherField<String>(
      json,
      'messageId',
      'message_id',
    );
    // `role` is required by the canonical TypeScript and Python schemas
    // (see sdks/typescript/packages/core/src/events.ts and
    // sdks/python/ag_ui/core/events.py). A missing `role` is a protocol
    // violation and must fail decoding so it surfaces at the boundary
    // instead of silently coercing downstream.
    final roleStr = JsonDecoder.requireField<String>(json, 'role');
    ReasoningMessageRole role;
    try {
      role = ReasoningMessageRole.fromString(roleStr);
    } on ArgumentError {
      // Forward-compat: a future server may introduce a new role *value*
      // (e.g. an as-yet-unspecified reasoning sub-role). The field is
      // present and string-typed, so this is a recoverable enum-mapping
      // failure — keep the stream alive by defaulting to `reasoning`.
      //
      // We intentionally do NOT broaden to `catch (e)` or `on Exception`:
      // a missing-key or wrong-typed `role` raises `AGUIValidationError`
      // from `requireField<String>` above, which MUST propagate to the
      // decoder boundary as a protocol violation. Widening the catch
      // would silently absorb those — the test at
      // `event_test.dart` ("rejects missing role (parity with TS/Python)")
      // is the regression guard for that contract.
      role = ReasoningMessageRole.reasoning;
    }
    return ReasoningMessageStartEvent(
      messageId: messageId,
      role: role,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'role': role.value,
      };

  @override
  ReasoningMessageStartEvent copyWith({
    String? messageId,
    ReasoningMessageRole? role,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningMessageStartEvent(
      messageId: messageId ?? this.messageId,
      role: role ?? this.role,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a piece of reasoning message content.
final class ReasoningMessageContentEvent extends BaseEvent {
  final String messageId;
  final String delta;

  const ReasoningMessageContentEvent({
    required this.messageId,
    required this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningMessageContent);

  factory ReasoningMessageContentEvent.fromJson(Map<String, dynamic> json) {
    // Validate the cheap required identifier FIRST so a missing-id error
    // surfaces before any payload-validation work — same convention as
    // `ReasoningMessageStartEvent.fromJson`.
    final messageId = JsonDecoder.requireEitherField<String>(
      json,
      'messageId',
      'message_id',
    );
    // Empty `delta` is accepted to match canonical TS/Python schemas
    // (`ReasoningMessageContentEventSchema.delta: z.string()` /
    // pydantic `delta: str`).
    final delta = JsonDecoder.requireField<String>(json, 'delta');

    return ReasoningMessageContentEvent(
      messageId: messageId,
      delta: delta,
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
        'delta': delta,
      };

  @override
  ReasoningMessageContentEvent copyWith({
    String? messageId,
    String? delta,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningMessageContentEvent(
      messageId: messageId ?? this.messageId,
      delta: delta ?? this.delta,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a reasoning message.
final class ReasoningMessageEndEvent extends BaseEvent {
  final String messageId;

  const ReasoningMessageEndEvent({
    required this.messageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningMessageEnd);

  factory ReasoningMessageEndEvent.fromJson(Map<String, dynamic> json) {
    return ReasoningMessageEndEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
      };

  @override
  ReasoningMessageEndEvent copyWith({
    String? messageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningMessageEndEvent(
      messageId: messageId ?? this.messageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event containing a chunk of reasoning message content.
final class ReasoningMessageChunkEvent extends BaseEvent {
  final String? messageId;
  final String? delta;

  const ReasoningMessageChunkEvent({
    this.messageId,
    this.delta,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningMessageChunk);

  factory ReasoningMessageChunkEvent.fromJson(Map<String, dynamic> json) {
    return ReasoningMessageChunkEvent(
      messageId: JsonDecoder.optionalEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      delta: JsonDecoder.optionalField<String>(json, 'delta'),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        if (messageId != null) 'messageId': messageId,
        if (delta != null) 'delta': delta,
      };

  // See `_Unset` (top of file) for the sentinel rationale.
  @override
  ReasoningMessageChunkEvent copyWith({
    Object? messageId = kUnsetSentinel,
    Object? delta = kUnsetSentinel,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningMessageChunkEvent(
      messageId: identical(messageId, kUnsetSentinel)
          ? this.messageId
          : messageId as String?,
      delta: identical(delta, kUnsetSentinel) ? this.delta : delta as String?,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

/// Event indicating the end of a reasoning phase.
final class ReasoningEndEvent extends BaseEvent {
  final String messageId;

  const ReasoningEndEvent({
    required this.messageId,
    super.timestamp,
    super.rawEvent,
  }) : super(eventType: EventType.reasoningEnd);

  factory ReasoningEndEvent.fromJson(Map<String, dynamic> json) {
    return ReasoningEndEvent(
      messageId: JsonDecoder.requireEitherField<String>(
        json,
        'messageId',
        'message_id',
      ),
      timestamp: JsonDecoder.optionalIntField(json, 'timestamp'),
      rawEvent: _readRawEvent(json),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'messageId': messageId,
      };

  @override
  ReasoningEndEvent copyWith({
    String? messageId,
    int? timestamp,
    dynamic rawEvent,
  }) {
    return ReasoningEndEvent(
      messageId: messageId ?? this.messageId,
      timestamp: timestamp ?? this.timestamp,
      rawEvent: rawEvent ?? this.rawEvent,
    );
  }
}

// ---------------------------------------------------------------------------
// Cipher-safe field extraction helper
// ---------------------------------------------------------------------------

/// Extracts a required [String] field without including [json] in any thrown
/// [AGUIValidationError] — use only for cipher-data payloads where forwarding
/// the raw map through log-shippers or reflection-based serializers would leak
/// sensitive data.
///
/// [camelKey] is tried first (camelCase-wins precedence matching
/// [JsonDecoder.requireEitherField]). [snakeKey], if given, is the fallback.
String _requireCipherSafeString(
  Map<String, dynamic> json,
  String camelKey, [
  String? snakeKey,
]) {
  final bool present = json.containsKey(camelKey) ||
      (snakeKey != null && json.containsKey(snakeKey));
  final rawValue = json.containsKey(camelKey) ? json[camelKey] : json[snakeKey];

  if (!present) {
    throw AGUIValidationError(
      message: snakeKey != null
          ? 'Missing required field "$camelKey" (or "$snakeKey")'
          : 'Missing required field "$camelKey"',
      field: camelKey,
      // Intentionally omit json: — payload contains cipher data.
    );
  }
  if (rawValue == null) {
    throw AGUIValidationError(
      message: 'Field "$camelKey" must not be null',
      field: camelKey,
      // Intentionally omit json: — payload contains cipher data.
    );
  }
  if (rawValue is! String) {
    throw AGUIValidationError(
      message:
          'Field "$camelKey" has incorrect type. Expected String, got ${rawValue.runtimeType}',
      field: camelKey,
      // Record only the runtime type, not the raw value — payload contains
      // cipher data; even a wrong-typed value could be sensitive material.
      value: rawValue.runtimeType.toString(),
      // Intentionally omit json: — payload contains cipher data.
    );
  }
  return rawValue;
}

/// Event containing an encrypted value for a message or tool call.
///
/// **Cipher-safety guarantees.** All three wire fields ([subtype], [entityId],
/// [encryptedValue]) are parsed via the internal `_requireCipherSafeString`
/// helper, which omits `json:` from every thrown [AGUIValidationError] so
/// cipher payloads cannot leak through reflection-based error serializers or
/// log shippers. [BaseEvent.rawEvent] is unconditionally set to `null` in
/// `fromJson` — the verbatim wire map carries `encryptedValue` and must not
/// be re-exposed downstream. The `copyWith` method intentionally omits a
/// `rawEvent` parameter for the same reason; if you need a scrubbed
/// `rawEvent`, construct a new [ReasoningEncryptedValueEvent] directly.
///
/// **Forward-compat note.** A future server-side [subtype] value will cause
/// [ReasoningEncryptedValueSubtype.fromString] to throw, which propagates
/// out of `fromJson` as an [AGUIValidationError] (wrapped in a
/// [DecodingError] when reached through [EventDecoder]). To keep streams
/// alive across an unknown subtype, opt in to per-event recovery via
/// `EventStreamAdapter(skipInvalidEvents: true)` — the rest of the SDK's
/// enums absorb unknown values at the event-decoding boundary, but the
/// encrypted-payload subtype has no sensible default to fall back to.
final class ReasoningEncryptedValueEvent extends BaseEvent {
  final ReasoningEncryptedValueSubtype subtype;
  final String entityId;
  final String encryptedValue;

  // SECURITY: `rawEvent` is intentionally absent from this constructor.
  // Pinning it to null in the super-initializer prevents callers from
  // re-attaching a wire map (which carries `encryptedValue`) and bypassing
  // the cipher-scrub invariant enforced in `fromJson` and `copyWith`.
  const ReasoningEncryptedValueEvent({
    required this.subtype,
    required this.entityId,
    required this.encryptedValue,
    super.timestamp,
  }) : super(
          eventType: EventType.reasoningEncryptedValue,
          rawEvent: null,
        );

  factory ReasoningEncryptedValueEvent.fromJson(Map<String, dynamic> json) {
    // All three required fields use [_requireCipherSafeString] rather than
    // `requireField`/`requireEitherField` so that every error path omits
    // `json:` — the payload contains cipher data and forwarding the full wire
    // map to `AGUIValidationError.json` would leak it through reflection-based
    // error serializers and log shippers. See [_requireCipherSafeString].
    final subtypeRaw = _requireCipherSafeString(json, 'subtype');
    // fromString now throws AGUIValidationError directly on unknown values,
    // so no try/catch wrapper is needed — the error propagates correctly
    // through the decoder pipeline to DecodingError.
    final subtype = ReasoningEncryptedValueSubtype.fromString(subtypeRaw);

    // entityId and encryptedValue are accepted as plain strings (including
    // empty) to match canonical schemas: TS `z.string()` and Python `str`
    // (no `min_length`). The strict subtype discriminator above stays —
    // unknown subtypes still throw.
    final entityId = _requireCipherSafeString(json, 'entityId', 'entity_id');
    final encryptedValue =
        _requireCipherSafeString(json, 'encryptedValue', 'encrypted_value');

    // rawEvent is explicitly set to null — unlike every other factory in this
    // file, forwarding _readRawEvent(json) would store the full cipher payload
    // in BaseEvent.rawEvent, undoing all the cipher-data scrubbing above.
    // Proxies that need the raw wire form should maintain their own copy before
    // calling fromJson.
    return ReasoningEncryptedValueEvent(
      subtype: subtype,
      entityId: entityId,
      encryptedValue: encryptedValue,
      timestamp: JsonDecoder.optionalCipherSafeIntField(json, 'timestamp'),
      // rawEvent: omitted — constructor pins rawEvent: null in its super-initializer.
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        'subtype': subtype.value,
        'entityId': entityId,
        'encryptedValue': encryptedValue,
      };

  // SECURITY: `rawEvent` is intentionally omitted from `copyWith`.
  // `fromJson` always pins `rawEvent: null` to prevent the cipher payload
  // in `encryptedValue` from leaking through the raw wire map. Accepting
  // a `rawEvent` parameter here would let callers re-attach that map and
  // undo the scrub — `MessagesSnapshotEvent.copyWith` applies the same
  // restriction for the same reason. Callers that genuinely need a non-null
  // `rawEvent` (e.g. a proxy that has already stripped `encryptedValue`)
  // must construct a new `ReasoningEncryptedValueEvent` directly.
  @override
  ReasoningEncryptedValueEvent copyWith({
    ReasoningEncryptedValueSubtype? subtype,
    String? entityId,
    String? encryptedValue,
    int? timestamp,
  }) {
    // The three `?? this.field` reads are safe — unlike nullable fields that use
    // the kUnsetSentinel discipline elsewhere, these are required non-nullable
    // constructor parameters, so `this.subtype`, `this.entityId`, and
    // `this.encryptedValue` are always non-null. Passing null for any of them
    // silently preserves the existing value; it cannot clear a required field.
    return ReasoningEncryptedValueEvent(
      subtype: subtype ?? this.subtype,
      entityId: entityId ?? this.entityId,
      encryptedValue: encryptedValue ?? this.encryptedValue,
      timestamp: timestamp ?? this.timestamp,
      // rawEvent: always null — enforced by the constructor's super-initializer.
    );
  }
}
