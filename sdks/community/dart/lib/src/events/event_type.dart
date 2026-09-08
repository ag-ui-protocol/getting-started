/// Event type enumeration for AG-UI protocol.
library;

// Hoisted `@Deprecated` messages: each is referenced exactly once below,
// but the long form is repeated again in `events.dart` per event class.
// Centralizing lets the planned-removal version (1.0.0) get edited in one
// place per surface (enum value vs. event class) instead of drifting.
const String _kThinkingTextMessageStartEnumDeprecation =
    'Use reasoningMessageStart (ReasoningMessageStartEvent) instead. '
    'Mirrors the canonical TypeScript SDK deprecation of '
    'THINKING_TEXT_MESSAGE_* in favor of REASONING_*. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingTextMessageContentEnumDeprecation =
    'Use reasoningMessageContent (ReasoningMessageContentEvent) instead. '
    'Mirrors the canonical TypeScript SDK deprecation of '
    'THINKING_TEXT_MESSAGE_* in favor of REASONING_*. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingTextMessageEndEnumDeprecation =
    'Use reasoningMessageEnd (ReasoningMessageEndEvent) instead. '
    'Mirrors the canonical TypeScript SDK deprecation of '
    'THINKING_TEXT_MESSAGE_* in favor of REASONING_*. '
    'Scheduled for removal in 1.0.0.';
const String _kThinkingContentEnumDeprecation =
    'Dart-only legacy: never part of the canonical AG-UI protocol '
    '(TypeScript/Python). '
    'Use reasoningMessageContent (ReasoningMessageContentEvent) instead. '
    'Scheduled for removal in 1.0.0.';

/// Enumeration of all AG-UI event types
enum EventType {
  textMessageStart('TEXT_MESSAGE_START'),
  textMessageContent('TEXT_MESSAGE_CONTENT'),
  textMessageEnd('TEXT_MESSAGE_END'),
  textMessageChunk('TEXT_MESSAGE_CHUNK'),
  @Deprecated(_kThinkingTextMessageStartEnumDeprecation)
  thinkingTextMessageStart('THINKING_TEXT_MESSAGE_START'),
  @Deprecated(_kThinkingTextMessageContentEnumDeprecation)
  thinkingTextMessageContent('THINKING_TEXT_MESSAGE_CONTENT'),
  @Deprecated(_kThinkingTextMessageEndEnumDeprecation)
  thinkingTextMessageEnd('THINKING_TEXT_MESSAGE_END'),
  toolCallStart('TOOL_CALL_START'),
  toolCallArgs('TOOL_CALL_ARGS'),
  toolCallEnd('TOOL_CALL_END'),
  toolCallChunk('TOOL_CALL_CHUNK'),
  toolCallResult('TOOL_CALL_RESULT'),
  thinkingStart('THINKING_START'),
  @Deprecated(_kThinkingContentEnumDeprecation)
  thinkingContent('THINKING_CONTENT'),
  thinkingEnd('THINKING_END'),
  stateSnapshot('STATE_SNAPSHOT'),
  stateDelta('STATE_DELTA'),
  messagesSnapshot('MESSAGES_SNAPSHOT'),
  activitySnapshot('ACTIVITY_SNAPSHOT'),
  activityDelta('ACTIVITY_DELTA'),
  raw('RAW'),
  custom('CUSTOM'),
  runStarted('RUN_STARTED'),
  runFinished('RUN_FINISHED'),
  runError('RUN_ERROR'),
  stepStarted('STEP_STARTED'),
  stepFinished('STEP_FINISHED'),
  reasoningStart('REASONING_START'),
  reasoningMessageStart('REASONING_MESSAGE_START'),
  reasoningMessageContent('REASONING_MESSAGE_CONTENT'),
  reasoningMessageEnd('REASONING_MESSAGE_END'),
  reasoningMessageChunk('REASONING_MESSAGE_CHUNK'),
  reasoningEnd('REASONING_END'),
  reasoningEncryptedValue('REASONING_ENCRYPTED_VALUE');

  final String value;
  const EventType(this.value);

  // Intentionally lazy-init (static final, not const) so it is built once
  // on first use rather than at program start, keeping start-up cost O(1).
  static final Map<String, EventType> _byValue = Map.unmodifiable({
    for (final t in EventType.values) t.value: t,
  });

  /// Parses [value] into an [EventType].
  ///
  /// **Contract:** throws [ArgumentError] for unknown values. Do NOT change
  /// this to throw any other exception type — `BaseEvent.fromJson` uses a
  /// narrow `on ArgumentError` catch to distinguish unknown event types
  /// (recoverable: wrap as `AGUIValidationError`) from genuine bugs in the
  /// factory body (rethrow). Breaking this contract will silently swallow
  /// factory errors or surface them as unknown-type errors. Wire decoding via
  /// `BaseEvent.fromJson` ultimately surfaces `AGUIValidationError` as
  /// `DecodingError`. Direct callers must catch [ArgumentError] if they want
  /// to handle unknown event types gracefully — see
  /// `dart-enum-parsing-safety.md` for the throw-vs-fallback rationale.
  static EventType fromString(String value) {
    return _byValue[value] ??
        (throw ArgumentError('Invalid event type: $value'));
  }
}
