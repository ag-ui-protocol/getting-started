import 'dart:developer' as developer;

import '../types/message.dart';
import 'errors.dart';

/// Validation utilities for AG-UI SDK
class Validators {
  // Hoisted to avoid recompiling on every validateUrl call (hot path).
  // The explicit \u escapes make the matched code points visible in source:
  //   \x00-\x1f  C0 control codes (including \t, \n, \r)
  //   \x7f       DEL
  //   \u0085     NEL (U+0085, C1 Next-Line \u2014 accepted verbatim by Uri.parse)
  //   \u2028     Line Separator (Unicode LS)
  //   \u2029     Paragraph Separator (Unicode PS)
  static final RegExp _kUrlControlChars =
      RegExp('[\x00-\x1f\x7f\u0085\u2028\u2029]');

  /// Validates that a string is not empty
  static void requireNonEmpty(String? value, String fieldName) {
    if (value == null || value.isEmpty) {
      throw ValidationError(
        'Field "$fieldName" cannot be empty',
        field: fieldName,
        constraint: 'non-empty',
        value: value,
      );
    }
  }

  /// Validates that a value is not null
  static T requireNonNull<T>(T? value, String fieldName) {
    if (value == null) {
      throw ValidationError(
        'Field "$fieldName" cannot be null',
        field: fieldName,
        constraint: 'non-null',
        value: value,
      );
    }
    return value;
  }

  /// Validates a URL format.
  ///
  /// Rejects null/empty URLs, URLs with embedded control characters or DEL
  /// (C0 + Unicode line-terminators), non-http/https schemes, and
  /// credential-bearing URLs (`http://user:pass@host/`).
  ///
  /// **Defense-in-depth note.** The credentials block
  /// (`uri.userInfo.isNotEmpty`) ALSO defends against percent-encoded
  /// control-char injection (e.g. `http://%0a:@host/` → newline in
  /// `userInfo` after `Uri.parse` decodes it). If the no-credentials rule
  /// is ever relaxed, ALSO run `_kUrlControlChars` against
  /// `uri.userInfo`, `uri.path`, `uri.query`, and `uri.fragment` — those
  /// fields are percent-decoded at access time, so the top-of-function
  /// string check on the raw URL string is not sufficient on its own.
  static void validateUrl(String? url, String fieldName) {
    requireNonEmpty(url, fieldName);

    // Reject embedded control characters and DEL before delegating to
    // `Uri.parse`. `Uri.parse('http://example.com/\nfoo')` returns a
    // valid Uri with `\n` in the path, which then flows into HTTP
    // request lines as a header-injection vector. The check covers:
    //   • C0 controls (`\x00`–`\x1f`) and DEL (`\x7f`) — including `\t`,
    //     `\n`, `\r`.
    //   • U+0085 (NEL), U+2028 (LS), U+2029 (PS) — Unicode logical-line
    //     terminators that Dart's `Uri.parse` accepts verbatim and a naive
    //     custom transport re-emitting the URL into an HTTP header line
    //     would interpret as a line break.
    if (_kUrlControlChars.hasMatch(url!)) {
      throw ValidationError(
        'URL contains control characters for "$fieldName"',
        field: fieldName,
        constraint: 'no-control-chars',
        value: url,
      );
    }

    try {
      final uri = Uri.parse(url);
      // `uri.hasAuthority` is true for `http://` (authority = empty string,
      // host = ""). Add the explicit `uri.host.isEmpty` guard so bare-scheme
      // URLs like `http://` are rejected as invalid rather than passing
      // through to the scheme / credentials checks.
      if (!uri.hasScheme || !uri.hasAuthority || uri.host.isEmpty) {
        throw ValidationError(
          'Invalid URL format or empty host for "$fieldName"',
          field: fieldName,
          constraint: 'valid-url',
          value: url,
        );
      }
      if (uri.scheme != 'http' && uri.scheme != 'https') {
        throw ValidationError(
          'URL scheme must be http or https for "$fieldName"',
          field: fieldName,
          constraint: 'http-or-https',
          value: url,
        );
      }
      // Reject credential-bearing URLs (`http://user:pass@host/`) to
      // prevent credentials from leaking into logs, error messages, or
      // HTTP Referer headers on redirects.
      if (uri.userInfo.isNotEmpty) {
        throw ValidationError(
          'URL must not contain user credentials for "$fieldName"',
          field: fieldName,
          constraint: 'no-user-credentials',
          value: url,
        );
      }
      // Defense-in-depth: also check percent-DECODED host / path / query /
      // fragment. `Uri.parse` decodes percent-escapes at access time, so a
      // raw URL like `http://host/%0a/foo` passes the top-of-function string
      // check but `uri.path` returns a newline — a header-injection vector
      // for any consumer that reflects these fields into HTTP request lines.
      // `uri.host` is included because Dart allows percent-encoded IDNA host
      // labels, and the decoded host can carry control characters that a
      // custom transport places into `Host:` headers.
      for (final part in [uri.host, uri.path, uri.query, uri.fragment]) {
        if (_kUrlControlChars.hasMatch(part)) {
          throw ValidationError(
            'URL contains percent-encoded control characters in '
            'path/query/fragment for "$fieldName"',
            field: fieldName,
            constraint: 'no-control-chars',
            value: url,
          );
        }
      }
    } catch (e) {
      if (e is ValidationError) rethrow;
      throw ValidationError(
        'Invalid URL format for "$fieldName"',
        field: fieldName,
        constraint: 'valid-url',
        value: url,
        cause: e,
      );
    }
  }

  /// Validates an agent ID format
  static void validateAgentId(String? agentId) {
    requireNonEmpty(agentId, 'agentId');

    // Agent IDs should be alphanumeric with optional hyphens and underscores
    final pattern = RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$');
    if (!pattern.hasMatch(agentId!)) {
      throw ValidationError(
        'Invalid agent ID format',
        field: 'agentId',
        constraint: 'alphanumeric-with-hyphens-underscores',
        value: agentId,
      );
    }

    if (agentId.length > 100) {
      throw ValidationError(
        'Agent ID too long (max 100 characters)',
        field: 'agentId',
        constraint: 'max-length-100',
        value: agentId,
      );
    }
  }

  /// Validates a run ID format.
  ///
  /// The 100-unit cap is measured in UTF-16 code units (Dart's [String.length]),
  /// not Unicode code points or user-perceived grapheme clusters. Identifiers
  /// containing characters outside the Basic Multilingual Plane (e.g. emoji)
  /// consume two code units per character and reach the cap sooner than
  /// ASCII-only identifiers of the same visible length.
  static void validateRunId(String? runId) {
    _validateBoundedId(runId, 'runId');
  }

  /// Validates a thread ID format.
  ///
  /// The 100-unit cap is measured in UTF-16 code units (Dart's [String.length]).
  /// See [validateRunId] for the full rationale.
  static void validateThreadId(String? threadId) {
    _validateBoundedId(threadId, 'threadId');
  }

  /// Maximum length (in UTF-16 code units) for [runId], [threadId], and
  /// [agentId] values. See [validateRunId] for the UTF-16 rationale.
  /// Consumers that derive identifiers from these values and want to enforce
  /// the same cap can reference this constant rather than copying the literal.
  static const int maxIdCodeUnits = 100;

  static void _validateBoundedId(String? id, String fieldName) {
    requireNonEmpty(id, fieldName);
    if (id!.length > maxIdCodeUnits) {
      throw ValidationError(
        '${fieldName[0].toUpperCase()}${fieldName.substring(1)} too long '
        '(max $maxIdCodeUnits UTF-16 code units)',
        field: fieldName,
        constraint: 'max-length-100',
        value: id,
      );
    }
  }

  /// Validates message content shape.
  ///
  /// Canonical contract: TS `BaseMessageSchema.content: z.string().optional()`
  /// and Python `BaseMessage.content: Optional[str]`. The multimodal
  /// `UserMessage.content: Union[str, List[InputContent]]` variant is not
  /// yet supported in this Dart SDK (see CHANGELOG → "Known parity
  /// gaps"). Until it is, this validator only accepts `String` — the
  /// pre-0.2.0 permissive Map/List branches were dead code (no caller in
  /// the SDK passes those types) and would have silently accepted a
  /// malformed payload if anyone ever adopted them.
  ///
  /// **Defense-in-depth note.** The null rejection here is a last line of
  /// defense for raw-input callers. Every protocol-correct call site in the
  /// SDK already guards null before reaching this method (the canonical
  /// `content` field is `Optional[str]` and is only forwarded to callers
  /// that need a non-null value). If null is somehow passed, this surfaces
  /// the bug early rather than producing a silent empty-string or NPE.
  static void validateMessageContent(String? content) {
    if (content == null) {
      throw ValidationError(
        'Message content cannot be null',
        field: 'content',
        constraint: 'non-null',
        value: content,
      );
    }
  }

  /// Validates user message content (text or multimodal parts).
  ///
  /// Multimodal content must have a non-empty list of parts, and each part must
  /// satisfy its protocol invariants (re-checked here because the constructor
  /// `assert`s are stripped in release builds).
  static void validateUserMessageContent(UserMessageContent content) {
    switch (content) {
      case TextContent():
        return;
      case MultimodalContent(:final parts):
        if (parts.isEmpty) {
          throw ValidationError(
            'User message content must have at least one part',
            field: 'content',
            constraint: 'non-empty',
            value: parts,
          );
        }
        for (var i = 0; i < parts.length; i++) {
          _validateInputContentPart(parts[i], i);
        }
    }
  }

  // Release-mode defense-in-depth: BinaryInputContent.fromJson and the
  // constructor asserts already enforce these rules on every normal path, but
  // asserts are stripped in release builds where a caller could construct an
  // invalid part directly.
  static void _validateInputContentPart(InputContent part, int index) {
    if (part is! BinaryInputContent) {
      return;
    }
    if (part.mimeType.isEmpty) {
      throw ValidationError(
        'Binary content part at index $index requires a non-empty mimeType',
        field: 'content[$index].mimeType',
        constraint: 'non-empty',
        value: part.mimeType,
      );
    }
    if (part.id == null && part.url == null && part.data == null) {
      throw ValidationError(
        'Binary content part at index $index requires at least one of '
        'id, url, or data',
        field: 'content[$index]',
        constraint: 'requires-payload',
        value: part,
      );
    }
  }

  /// Maximum allowed value for any [Duration] passed through
  /// [validateTimeout]. Conservative for an agent SDK where long-running
  /// tool sequences and human-in-the-loop steps can sometimes legitimately
  /// approach this cap; bumping is a behavior change deferred to a future
  /// release. Exposed so callers can inspect the limit (e.g. to warn the
  /// user before submitting a request that will be rejected).
  static const Duration maxTimeout = Duration(minutes: 10);

  /// Validates timeout duration
  static void validateTimeout(Duration? timeout) {
    if (timeout == null) return;

    if (timeout.isNegative) {
      throw ValidationError(
        'Timeout cannot be negative',
        field: 'timeout',
        constraint: 'non-negative',
        value: timeout.toString(),
      );
    }

    if (timeout > maxTimeout) {
      throw ValidationError(
        'Timeout exceeds maximum of ${maxTimeout.inMinutes} minutes',
        field: 'timeout',
        constraint: 'max-${maxTimeout.inMinutes}-minutes',
        value: timeout.toString(),
      );
    }
  }

  /// Validates a map contains required fields
  static void requireFields(
      Map<String, dynamic> map, List<String> requiredFields) {
    for (final field in requiredFields) {
      if (!map.containsKey(field)) {
        throw ValidationError(
          'Missing required field "$field"',
          field: field,
          constraint: 'required',
          value: map,
        );
      }
    }
  }

  /// Validates JSON data structure
  static Map<String, dynamic> validateJson(dynamic json, String context) {
    if (json == null) {
      throw DecodingError(
        'JSON cannot be null in $context',
        field: context,
        expectedType: 'Map<String, dynamic>',
        actualValue: json,
      );
    }

    if (json is! Map<String, dynamic>) {
      throw DecodingError(
        'Expected JSON object in $context',
        field: context,
        expectedType: 'Map<String, dynamic>',
        actualValue: json,
      );
    }

    return json;
  }

  /// Validates that an event type string matches UPPER_SNAKE_CASE format.
  ///
  /// This is a format-only check. Format conformance does not imply that the
  /// SDK can dispatch the type — [EventType.fromString] and the exhaustive
  /// switch in [BaseEvent.fromJson] / [EventDecoder.validate] are the actual
  /// authority for recognized types. Adding a new event type requires a
  /// coordinated enum addition regardless of whether this regex accepts it.
  static void validateEventType(String? eventType) {
    requireNonEmpty(eventType, 'eventType');

    final pattern = RegExp(r'^[A-Z][A-Z0-9_]*$');
    if (!pattern.hasMatch(eventType!)) {
      throw ValidationError(
        'Invalid event type format (should be UPPER_SNAKE_CASE)',
        field: 'eventType',
        constraint: 'upper-snake-case',
        value: eventType,
      );
    }
  }

  /// Validates HTTP status code
  static void validateStatusCode(int? statusCode, String endpoint,
      [String? responseBody]) {
    if (statusCode == null) return;

    if (statusCode < 200 || statusCode >= 300) {
      String message;
      if (statusCode >= 400 && statusCode < 500) {
        message = 'Client error';
      } else if (statusCode >= 500) {
        message = 'Server error';
      } else {
        message = 'Unexpected status';
      }

      throw TransportError(
        '$message at $endpoint',
        statusCode: statusCode,
        endpoint: endpoint,
        responseBody: responseBody,
      );
    }
  }

  /// Validates SSE event data
  static void validateSseEvent(Map<String, String>? event) {
    if (event == null || event.isEmpty) {
      throw DecodingError(
        'SSE event cannot be empty',
        field: 'event',
        expectedType: 'Map<String, String>',
        actualValue: event,
      );
    }

    if (!event.containsKey('data')) {
      throw DecodingError(
        'SSE event missing required "data" field',
        field: 'data',
        expectedType: 'String',
        actualValue: event,
      );
    }
  }

  /// Validates protocol compliance for event sequences.
  ///
  /// **Note:** This method was never wired up in the SDK client path and is
  /// not called from any production code in `lib/`. The SDK does not enforce
  /// sequence rules client-side. This method is retained for consumers who
  /// want to validate sequences in their own code, but may be removed in
  /// a future major version.
  ///
  /// **Coverage gap.** This method only knows the `RUN_*` and `TOOL_CALL_*`
  /// event families. The newer `REASONING_*`, `ACTIVITY_*`, `RAW`, and
  /// `CUSTOM` event types are silently passed through without validation.
  /// Do not rely on this method for sequence validation of any modern event
  /// stream that includes these types.
  // TODO(1.0.0): Remove alongside the THINKING_TEXT_MESSAGE_* deprecation sweep.
  @Deprecated(
    'DO NOT USE — covers only RUN_* and TOOL_CALL_* events; '
    'REASONING_*, ACTIVITY_*, RAW, and CUSTOM are silently passed through '
    'without validation. Will be removed in 1.0.0.',
  )
  static bool _validateEventSequenceWarnedOnce = false;

  static void validateEventSequence(
      String currentEvent, String? previousEvent, String? state) {
    if (!_validateEventSequenceWarnedOnce) {
      _validateEventSequenceWarnedOnce = true;
      developer.log(
        'validateEventSequence is deprecated and covers only RUN_* and '
        'TOOL_CALL_* event families. REASONING_*, ACTIVITY_*, RAW, and CUSTOM '
        'are silently passed through. This method will be removed in 1.0.0.',
        name: 'ag_ui.validators',
        level: 900, // WARNING
      );
    }
    // RUN_STARTED must be first or after RUN_FINISHED
    if (currentEvent == 'RUN_STARTED') {
      if (previousEvent != null && previousEvent != 'RUN_FINISHED') {
        throw ProtocolViolationError(
          'RUN_STARTED can only occur at the beginning or after RUN_FINISHED',
          rule: 'run-lifecycle',
          state: state,
          expected: 'No previous event or RUN_FINISHED',
        );
      }
    }

    // RUN_FINISHED must have a preceding RUN_STARTED
    if (currentEvent == 'RUN_FINISHED' && state != 'running') {
      throw ProtocolViolationError(
        'RUN_FINISHED without preceding RUN_STARTED',
        rule: 'run-lifecycle',
        state: state,
        expected: 'RUN_STARTED before RUN_FINISHED',
      );
    }

    // Tool call events must be within a run
    if (currentEvent.startsWith('TOOL_CALL_') && state != 'running') {
      throw ProtocolViolationError(
        'Tool call events must occur within a run',
        rule: 'tool-call-lifecycle',
        state: state,
        expected: 'State should be "running"',
      );
    }
  }

  /// Validates model output format
  static T validateModel<T>(
    dynamic data,
    String modelName,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    final json = validateJson(data, modelName);

    try {
      return fromJson(json);
    } catch (e) {
      throw DecodingError(
        'Failed to decode $modelName',
        field: modelName,
        expectedType: modelName,
        actualValue: json,
        cause: e,
      );
    }
  }

  /// Validates list of models
  static List<T> validateModelList<T>(
    dynamic data,
    String modelName,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    if (data == null) {
      throw DecodingError(
        'List cannot be null for $modelName',
        field: modelName,
        expectedType: 'List',
        actualValue: data,
      );
    }

    if (data is! List) {
      throw DecodingError(
        'Expected list for $modelName',
        field: modelName,
        expectedType: 'List',
        actualValue: data,
      );
    }

    final results = <T>[];
    for (var i = 0; i < data.length; i++) {
      try {
        final item = validateModel(data[i], '$modelName[$i]', fromJson);
        results.add(item);
      } catch (e) {
        throw DecodingError(
          'Failed to decode item $i in $modelName list',
          field: '$modelName[$i]',
          expectedType: modelName,
          actualValue: data[i],
          cause: e,
        );
      }
    }

    return results;
  }
}
