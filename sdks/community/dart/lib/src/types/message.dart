/// Message types for AG-UI protocol.
///
/// This library defines the message types used in agent-user conversations,
/// including user, assistant, system, tool, developer, activity, and
/// reasoning messages.
library;

import 'base.dart';
import 'tool.dart';

// `kUnsetSentinel` (from `base.dart`) is the shared sentinel for all
// `copyWith` methods in this file. The pattern lets callers distinguish
// "argument omitted" (preserve current value via `?? this.field`) from
// "argument explicitly null" (clear the field). Compared with `identical(...)`.

/// Role types for messages in the AG-UI protocol.
///
/// Mirrors the canonical TypeScript and Python `Message` discriminated
/// unions (see `sdks/typescript/packages/core/src/types.ts` and
/// `sdks/python/ag_ui/core/types.py`). The `activity` and `reasoning`
/// values exist so `MESSAGES_SNAPSHOT` payloads carrying those message
/// shapes decode in Dart with the same schema as the other SDKs.
enum MessageRole {
  developer('developer'),
  system('system'),
  assistant('assistant'),
  user('user'),
  tool('tool'),

  /// Wire spelling is `'activity'` (lowercase, single word) — canonical
  /// across the AG-UI protocol (TS `Literal["activity"]`, Python
  /// `Literal["activity"]`). The Dart symbol matches; this enum value
  /// pins the wire constant for [MessageRole.fromString] dispatch into
  /// [ActivityMessage]. Mirrors the wire-spelling-pinning style used by
  /// [ReasoningEncryptedValueSubtype.toolCall] (where the spelling
  /// difference is more consequential).
  ///
  /// **Cipher asymmetry:** unlike [reasoning], `activity` messages never
  /// carry cipher data in the structured field — [ActivityMessage.fromJson]
  /// silently strips any wire-level `encryptedValue`. See [ActivityMessage]
  /// class-doc for the rationale.
  activity('activity'),

  /// Wire spelling is `'reasoning'` (lowercase, single word) — canonical
  /// across the AG-UI protocol. The Dart symbol matches; this enum value
  /// pins the wire constant for [MessageRole.fromString] dispatch into
  /// [ReasoningMessage].
  reasoning('reasoning');

  final String value;
  const MessageRole(this.value);

  /// Parses [value] into a [MessageRole].
  ///
  /// Unlike `TextMessageRole.fromString` / `ReasoningMessageRole.fromString`
  /// (which throw `ArgumentError` and are absorbed at the event-factory
  /// level for forward-compat), this enum throws [AGUIValidationError]
  /// directly — the value is the discriminator that selects which
  /// [Message] subtype's `fromJson` to dispatch to, so an unknown role
  /// has no safe default. Mis-tagging a `MESSAGES_SNAPSHOT` payload
  /// would corrupt the snapshot rather than just lose one field.
  ///
  /// Through the public [EventDecoder] pipeline, this surfaces as
  /// `DecodingError(field: 'role')`. Direct callers of `Message.fromJson`
  /// see `AGUIValidationError` directly. See `dart-enum-parsing-safety.md`
  /// for the closed-vs-open enum rationale.
  static final Map<String, MessageRole> _byValue = Map.unmodifiable({
    for (final r in MessageRole.values) r.value: r,
  });

  static MessageRole fromString(String value) {
    return _byValue[value] ??
        (throw AGUIValidationError(
          message: 'Invalid message role: $value',
          field: 'role',
          value: value,
        ));
  }
}

/// Base message class for all message types.
///
/// Messages represent the fundamental units of conversation in the AG-UI protocol.
/// Each message has a role, optional content, and may include additional metadata.
///
/// Use the [Message.fromJson] factory to deserialize messages from JSON.
///
/// Known parity gap with the canonical TS/Python SDKs: the canonical
/// `BaseMessageSchema.id` is `z.string()` (non-nullable). Dart keeps
/// `id` typed `String?` for legacy reasons but every concrete subtype
/// constructor declares it `required`, so a constructed in-memory
/// instance is null-safe by convention. A future major version may
/// tighten the type. See CHANGELOG → "Known parity gaps".
sealed class Message extends AGUIModel with TypeDiscriminator {
  final String? id;
  final MessageRole role;
  final String? content;
  final String? name;

  /// Opaque cipher payload preserved verbatim across proxy hops.
  ///
  /// Mirrors the canonical TS `BaseMessageSchema.encryptedValue:
  /// z.string().optional()` and Python `BaseMessage.encrypted_value:
  /// Optional[str]` — every concrete subtype that extends `BaseMessage`
  /// (Developer/System/Assistant/User/Tool) inherits this field. The
  /// canonical `ActivityMessage` and `ReasoningMessage` are NOT
  /// `BaseMessage` extensions; in this Dart sealed-class hierarchy they
  /// inherit the field too but their `fromJson` / `toJson` ignore it
  /// (`ActivityMessage`) or inherit it through the sealed parent without
  /// re-declaring locally (`ReasoningMessage` passes it via
  /// `super.encryptedValue` — there is no shadowing field on that subtype).
  ///
  /// Wire dual-key: factories read both `encryptedValue` (TS-canonical)
  /// and `encrypted_value` (Python-canonical) via
  /// [JsonDecoder.optionalEitherField]. `toJson` emits the camelCase
  /// spelling.
  final String? encryptedValue;

  const Message({
    this.id,
    required this.role,
    this.content,
    this.name,
    this.encryptedValue,
  });

  @override
  String get type => role.value;

  /// Factory constructor to create specific message types from JSON
  factory Message.fromJson(Map<String, dynamic> json) {
    final roleStr = JsonDecoder.requireField<String>(json, 'role');
    final MessageRole role;
    try {
      role = MessageRole.fromString(roleStr);
    } on AGUIValidationError catch (e) {
      // Drop json: — the message map may carry encryptedValue. Preserve
      // cause: because MessageRole.fromString errors do not embed raw JSON
      // (e.json == null), so the cause chain is safe to forward.
      throw AGUIValidationError(
        message: e.message,
        field: e.field,
        value: e.value,
        cause: e,
      );
    }

    // `MessageRole.fromString` deliberately throws on unknown values rather
    // than falling back to a default — unlike `TextMessageRole.fromString`
    // and `ReasoningMessageRole.fromString`, which absorb `ArgumentError` for
    // forward-compat. The role is the *dispatch discriminator*: an unknown role
    // has no safe default subtype. Changing this to a fallback would silently
    // mis-tag a MESSAGES_SNAPSHOT message, corrupting the list instead of
    // surfacing the wire violation at the decoder boundary.
    switch (role) {
      case MessageRole.developer:
        return DeveloperMessage.fromJson(json);
      case MessageRole.system:
        return SystemMessage.fromJson(json);
      case MessageRole.assistant:
        return AssistantMessage.fromJson(json);
      case MessageRole.user:
        return UserMessage.fromJson(json);
      case MessageRole.tool:
        return ToolMessage.fromJson(json);
      case MessageRole.activity:
        return ActivityMessage.fromJson(json);
      case MessageRole.reasoning:
        return ReasoningMessage.fromJson(json);
      // No `default` clause — exhaustive switch on the [MessageRole] enum
      // (analyzer-enforced). A new MessageRole value will produce a compile
      // error here, which is the desired outcome rather than a runtime
      // fall-through.
    }
  }

  @override
  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'role': role.value,
        if (content != null) 'content': content,
        if (name != null) 'name': name,
        if (encryptedValue != null) 'encryptedValue': encryptedValue,
      };
}

/// Developer message with required content.
///
/// Used for system-level or developer-facing messages in the conversation.
final class DeveloperMessage extends Message {
  @override
  final String content;

  const DeveloperMessage({
    required super.id,
    required this.content,
    super.name,
    super.encryptedValue,
  }) : super(role: MessageRole.developer);

  factory DeveloperMessage.fromJson(Map<String, dynamic> json) {
    return DeveloperMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  // Emit `content` unconditionally — it is constructor-required and non-null
  // on this subtype. The parent's conditional `if (content != null) 'content'`
  // would also work by construction, but emitting it here makes the contract
  // explicit and independent of the parent implementation.
  @override
  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'role': role.value,
        'content': content,
        if (name != null) 'name': name,
        if (encryptedValue != null) 'encryptedValue': encryptedValue,
      };

  // `name` and `encryptedValue` are nullable on the parent — use the
  // sentinel so callers can clear either explicitly. See [kUnsetSentinel].
  @override
  DeveloperMessage copyWith({
    String? id,
    String? content,
    Object? name = kUnsetSentinel,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return DeveloperMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// System message with required content.
///
/// Represents system-level instructions or context provided to the agent.
final class SystemMessage extends Message {
  @override
  final String content;

  const SystemMessage({
    required super.id,
    required this.content,
    super.name,
    super.encryptedValue,
  }) : super(role: MessageRole.system);

  factory SystemMessage.fromJson(Map<String, dynamic> json) {
    return SystemMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'role': role.value,
        'content': content,
        if (name != null) 'name': name,
        if (encryptedValue != null) 'encryptedValue': encryptedValue,
      };

  // `name` and `encryptedValue` are nullable on the parent — sentinel
  // for explicit-clear semantics.
  @override
  SystemMessage copyWith({
    String? id,
    String? content,
    Object? name = kUnsetSentinel,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return SystemMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// Assistant message with optional content and tool calls.
///
/// Represents responses from the AI assistant, which may include
/// text content and/or tool call requests.
final class AssistantMessage extends Message {
  final List<ToolCall>? toolCalls;

  const AssistantMessage({
    required super.id,
    super.content,
    super.name,
    this.toolCalls,
    super.encryptedValue,
  }) : super(role: MessageRole.assistant);

  factory AssistantMessage.fromJson(Map<String, dynamic> json) {
    // KEY-level dual-key resolution with eager element-type validation.
    // Documented precedence rule (see [JsonDecoder.requireEitherField]
    // dartdoc): if camelCase `toolCalls` is present, it wins even when the
    // list is empty; snake_case `tool_calls` is consulted ONLY when
    // camelCase is absent. The pre-fix `??`-on-value chain incorrectly
    // surfaced `tool_calls` whenever camelCase resolved to null OR an
    // empty list — silently dropping snake_case data on payloads that
    // (incorrectly) carry both keys. The regression test
    // `message_test.dart:401-446` ("AssistantMessage.fromJson dual-key
    // precedence") pins this contract.
    //
    // Element-type validation: `optionalEitherListField` reports
    // `field: 'toolCalls[$i]'` on a malformed nested element rather than
    // letting a raw `TypeError` leak from the `as Map<String, dynamic>`
    // cast — same convention as `MessagesSnapshotEvent.fromJson`.
    final rawToolCalls =
        JsonDecoder.optionalEitherListField<Map<String, dynamic>>(
      json,
      'toolCalls',
      'tool_calls',
    );
    return AssistantMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.optionalField<String>(json, 'content'),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      toolCalls: rawToolCalls == null
          ? null
          : () {
              final result = <ToolCall>[];
              for (var i = 0; i < rawToolCalls.length; i++) {
                try {
                  result.add(ToolCall.fromJson(rawToolCalls[i]));
                } catch (e) {
                  if (e is AGUIValidationError) {
                    // Omit `json:` — ToolCall.fromJson can set e.json to a
                    // payload with sensitive `arguments`. Preserve `cause:`
                    // when the inner error already scrubbed its own `json:`
                    // (cipher-aware path) so the stack trace survives.
                    throw AGUIValidationError(
                      message: e.message,
                      field: e.field != null ? 'toolCalls[$i].${e.field}' : 'toolCalls[$i]',
                      value: e.value,
                      cause: e.json == null ? e : null,
                    );
                  }
                  throw AGUIValidationError(
                    message: 'Failed to decode tool call at index $i: $e',
                    field: 'toolCalls[$i]',
                    cause: e,
                  );
                }
              }
              return result;
            }(),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        // Emit `toolCalls` whenever the in-memory field is non-null, even
        // when empty, so the round-trip `fromJson(m.toJson()) == m` is
        // symmetric. The previous `&& toolCalls!.isNotEmpty` guard dropped
        // the key on empty lists, which decoded back to `null` instead of
        // `[]` and made tests that depend on field-by-field equality
        // surprising.
        if (toolCalls != null)
          'toolCalls': toolCalls!.map((tc) => tc.toJson()).toList(),
      };

  // See [kUnsetSentinel] for the sentinel rationale. `content`,
  // `name`, `toolCalls`, and `encryptedValue` are all nullable on
  // `AssistantMessage`, so callers may legitimately want to clear any
  // of them via `copyWith`.
  @override
  AssistantMessage copyWith({
    String? id,
    Object? content = kUnsetSentinel,
    Object? name = kUnsetSentinel,
    Object? toolCalls = kUnsetSentinel,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return AssistantMessage(
      id: id ?? this.id,
      content: identical(content, kUnsetSentinel)
          ? this.content
          : content as String?,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      toolCalls: identical(toolCalls, kUnsetSentinel)
          ? this.toolCalls
          : toolCalls as List<ToolCall>?,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// User message with text or multimodal content.
///
/// Represents input from the user in the conversation. The content is a union
/// of plain text or an ordered list of multimodal parts, modeled by
/// [UserMessageContent]. Use the default constructor for text, or
/// [UserMessage.multimodal] for a list of [InputContent] parts.
class UserMessage extends Message {
  /// The user message content: [TextContent] or [MultimodalContent].
  final UserMessageContent messageContent;

  /// Creates a text user message; [content] is wrapped in [TextContent].
  ///
  /// Not `const` because it wraps [content] at runtime. For a compile-time
  /// constant, use [UserMessage.fromContent] with a `const` [TextContent].
  UserMessage({
    required super.id,
    required String content,
    super.name,
    super.encryptedValue,
  })  : messageContent = TextContent(content),
        super(role: MessageRole.user);

  /// Creates a multimodal user message from an ordered list of [parts].
  UserMessage.multimodal({
    required super.id,
    required List<InputContent> parts,
    super.name,
    super.encryptedValue,
  })  : messageContent = MultimodalContent(parts),
        super(role: MessageRole.user);

  /// Creates a user message from a [UserMessageContent] union value.
  const UserMessage.fromContent({
    required super.id,
    required this.messageContent,
    super.name,
    super.encryptedValue,
  }) : super(role: MessageRole.user);

  factory UserMessage.fromJson(Map<String, dynamic> json) {
    return UserMessage.fromContent(
      id: JsonDecoder.requireField<String>(json, 'id'),
      messageContent: UserMessageContent.fromJson(json['content']),
      name: JsonDecoder.optionalField<String>(json, 'name'),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  /// The text of this message, or `null` when the content is multimodal.
  ///
  /// Projects [messageContent] so existing text-only readers keep working.
  @override
  String? get content => switch (messageContent) {
        TextContent(:final text) => text,
        MultimodalContent() => null,
      };

  @override
  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'role': role.value,
        'content': messageContent.toJson(),
        if (name != null) 'name': name,
        if (encryptedValue != null) 'encryptedValue': encryptedValue,
      };

  // `name` and `encryptedValue` are nullable on the parent — sentinel
  // for explicit-clear semantics.
  @override
  UserMessage copyWith({
    String? id,
    UserMessageContent? messageContent,
    Object? name = kUnsetSentinel,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return UserMessage.fromContent(
      id: id ?? this.id,
      messageContent: messageContent ?? this.messageContent,
      name: identical(name, kUnsetSentinel) ? this.name : name as String?,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// Tool message with tool call result.
///
/// Contains the result of a tool execution, linked to a specific tool call
/// via the [toolCallId] field. The optional [encryptedValue] mirrors the
/// canonical TypeScript `ToolMessageSchema` and Python `ToolMessage` and
/// carries an opaque cipher payload that a Dart proxy must forward
/// verbatim to a downstream agent.
final class ToolMessage extends Message {
  @override
  final String content;
  final String toolCallId;
  final String? error;

  const ToolMessage({
    required super.id,
    required this.content,
    required this.toolCallId,
    this.error,
    super.encryptedValue,
  }) : super(role: MessageRole.tool);

  factory ToolMessage.fromJson(Map<String, dynamic> json) {
    return ToolMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      content: JsonDecoder.requireField<String>(json, 'content'),
      toolCallId: JsonDecoder.requireEitherField<String>(
        json,
        'toolCallId',
        'tool_call_id',
      ),
      error: JsonDecoder.optionalField<String>(json, 'error'),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  // Explicit field-by-field emission rather than ...super.toJson() spread:
  // ToolMessage's constructor does not accept `name`, so the inherited
  // Message.name field is always null here and the explicit form is safe.
  // If Message.toJson() ever gains a new common field, this override must be
  // updated in parallel to avoid silently dropping it.
  @override
  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'role': role.value,
        'content': content,
        if (encryptedValue != null) 'encryptedValue': encryptedValue,
        'toolCallId': toolCallId,
        if (error != null) 'error': error,
      };

  // `error` and `encryptedValue` are nullable — use the sentinel so a
  // caller can explicitly clear either via `copyWith(error: null)` /
  // `copyWith(encryptedValue: null)`. Mirrors the event-class sentinel
  // discipline.
  @override
  ToolMessage copyWith({
    String? id,
    String? content,
    String? toolCallId,
    Object? error = kUnsetSentinel,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return ToolMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      toolCallId: toolCallId ?? this.toolCallId,
      error: identical(error, kUnsetSentinel) ? this.error : error as String?,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// Activity message embedded in a `MESSAGES_SNAPSHOT` payload.
///
/// Mirrors the canonical TypeScript `ActivityMessageSchema`
/// (`sdks/typescript/packages/core/src/types.ts`) and the Python
/// `ActivityMessage` model (`sdks/python/ag_ui/core/types.py`). The wire
/// shape is `{id, role: 'activity', activityType, content}` where
/// `content` is a JSON object (`z.record(z.any())` / `Dict[str, Any]`).
///
/// The Dart in-memory accessor for the wire `content` field is named
/// [activityContent] to avoid shadowing the parent [Message.content]
/// (which is `String?`). The wire key remains `content` in [toJson] /
/// [fromJson] for protocol parity.
///
/// **`encryptedValue` note.** `ActivityMessage` inherits [encryptedValue]
/// from [Message] but intentionally does not expose it in the constructor,
/// [fromJson], or [toJson]. In the canonical protocol `ActivityMessage` is
/// NOT a `BaseMessage` extension (unlike Developer/System/Assistant/User/Tool
/// messages), so cipher-payload forwarding does not apply here. If the wire
/// payload contains `encryptedValue` / `encrypted_value`, [fromJson] strips
/// it silently (matching TS zod-default strip behavior). In-memory instances
/// constructed via [copyWith] on a parent [Message] may inherit the field,
/// but [toJson] never emits it.
final class ActivityMessage extends Message {
  final String activityType;
  final Map<String, dynamic> activityContent;

  const ActivityMessage({
    required super.id,
    required this.activityType,
    required this.activityContent,
  }) : super(role: MessageRole.activity);

  // ActivityMessage never carries cipher data — override the inherited getter
  // to guarantee null. fromJson silently strips any inbound encryptedValue;
  // this override ensures no in-memory path (copyWith, subclassing) can
  // accidentally set it, making the cipher-scrub predicate in
  // MessagesSnapshotEvent.fromJson permanently reliable.
  @override
  String? get encryptedValue => null;

  factory ActivityMessage.fromJson(Map<String, dynamic> json) {
    // `ActivityMessage` is NOT a `BaseMessage` extension in the canonical
    // protocol — cipher-payload forwarding does not apply. Strip any inbound
    // `encryptedValue` / `encrypted_value` silently, matching TS zod-default
    // strip behavior. A hard-fail here would make Dart the only SDK that tears
    // down the stream when a proxy emits the field (TS strips, Python preserves).
    return ActivityMessage(
      id: JsonDecoder.requireField<String>(json, 'id'),
      activityType: JsonDecoder.requireEitherField<String>(
        json,
        'activityType',
        'activity_type',
      ),
      activityContent:
          JsonDecoder.requireField<Map<String, dynamic>>(json, 'content'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        // Explicitly skip super.toJson() — the inherited Message.content field
        // must not appear in the wire output (activityContent is the `content`
        // key here). Using ...super.toJson() would rely on map-spread
        // overwrite order to mask any future super.content emission.
        if (id != null) 'id': id,
        'role': role.value,
        'activityType': activityType,
        'content': activityContent,
      };

  // `id` is nullable on the parent `Message` — use the sentinel so a caller
  // can explicitly clear it via `copyWith(id: null)`. The bare `?? this.id`
  // pattern cannot distinguish "omitted" from "explicitly null".
  @override
  ActivityMessage copyWith({
    Object? id = kUnsetSentinel,
    String? activityType,
    Map<String, dynamic>? activityContent,
  }) {
    return ActivityMessage(
      id: identical(id, kUnsetSentinel) ? this.id : id as String?,
      activityType: activityType ?? this.activityType,
      activityContent: activityContent ?? this.activityContent,
    );
  }
}

/// Reasoning message emitted by models that expose their chain-of-thought.
///
/// Mirrors `ReasoningMessage` in the Python and TypeScript reference SDKs.
/// [content] is the visible reasoning text; [thinking] is an opaque
/// extended-thinking blob; [encryptedValue] carries the encrypted thinking
/// payload when the server uses encrypted extended thinking.
class ReasoningMessage extends Message {
  /// Optional visible reasoning / chain-of-thought text.
  @override
  final String? content;

  /// Optional opaque extended-thinking blob.
  final String? thinking;

  const ReasoningMessage({
    super.id,
    this.content,
    this.thinking,
    super.encryptedValue,
  }) : super(role: MessageRole.reasoning);

  factory ReasoningMessage.fromJson(Map<String, dynamic> json) {
    return ReasoningMessage(
      id: JsonDecoder.optionalField<String>(json, 'id'),
      content: JsonDecoder.optionalField<String>(json, 'content'),
      thinking: JsonDecoder.optionalField<String>(json, 'thinking'),
      encryptedValue: JsonDecoder.optionalEitherField<String>(
        json,
        'encryptedValue',
        'encrypted_value',
      ),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        ...super.toJson(),
        if (thinking != null) 'thinking': thinking,
      };

  // `encryptedValue` is nullable on the parent — sentinel lets callers clear it.
  @override
  ReasoningMessage copyWith({
    String? id,
    String? content,
    String? thinking,
    Object? encryptedValue = kUnsetSentinel,
  }) {
    return ReasoningMessage(
      id: id ?? this.id,
      content: content ?? this.content,
      thinking: thinking ?? this.thinking,
      encryptedValue: identical(encryptedValue, kUnsetSentinel)
          ? this.encryptedValue
          : encryptedValue as String?,
    );
  }
}

/// Reads a MIME type from JSON, accepting both `mimeType` and `mime_type`.
String? _readMimeType(Map<String, dynamic> json) =>
    JsonDecoder.optionalField<String>(json, 'mimeType') ??
    JsonDecoder.optionalField<String>(json, 'mime_type');

/// The source of a multimodal [InputContent] part.
///
/// A discriminated union on `type`: [DataSource] (inline data, e.g. base64)
/// or [UrlSource] (a remote URL). Use [InputContentSource.fromJson] to decode.
sealed class InputContentSource extends AGUIModel {
  const InputContentSource();

  /// The source discriminator: `data` or `url`.
  String get sourceType;

  /// Decodes an [InputContentSource] from JSON, dispatching on `type`.
  factory InputContentSource.fromJson(Map<String, dynamic> json) {
    final type = JsonDecoder.requireField<String>(json, 'type');
    switch (type) {
      case 'data':
        return DataSource.fromJson(json);
      case 'url':
        return UrlSource.fromJson(json);
      default:
        throw AGUIValidationError(
          message: 'Invalid input content source type: $type',
          field: 'type',
          value: type,
          json: json,
        );
    }
  }
}

/// Inline content source carrying a data payload (e.g. base64-encoded bytes).
///
/// [mimeType] is required for data sources.
class DataSource extends InputContentSource {
  /// The inline data payload, typically base64-encoded.
  final String value;

  /// The MIME type of [value]. Required.
  final String mimeType;

  const DataSource({required this.value, required this.mimeType});

  @override
  String get sourceType => 'data';

  factory DataSource.fromJson(Map<String, dynamic> json) {
    final mimeType = _readMimeType(json);
    if (mimeType == null) {
      throw AGUIValidationError(
        message: 'DataSource requires a mimeType',
        field: 'mimeType',
        json: json,
      );
    }
    return DataSource(
      value: JsonDecoder.requireField<String>(json, 'value'),
      mimeType: mimeType,
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        'type': sourceType,
        'value': value,
        'mimeType': mimeType,
      };

  @override
  DataSource copyWith({String? value, String? mimeType}) => DataSource(
        value: value ?? this.value,
        mimeType: mimeType ?? this.mimeType,
      );
}

/// Remote content source referenced by URL.
///
/// [mimeType] is optional for URL sources.
class UrlSource extends InputContentSource {
  /// The URL of the content.
  final String value;

  /// The optional MIME type of the referenced content.
  final String? mimeType;

  const UrlSource({required this.value, this.mimeType});

  @override
  String get sourceType => 'url';

  factory UrlSource.fromJson(Map<String, dynamic> json) => UrlSource(
        value: JsonDecoder.requireField<String>(json, 'value'),
        mimeType: _readMimeType(json),
      );

  @override
  Map<String, dynamic> toJson() => {
        'type': sourceType,
        'value': value,
        if (mimeType != null) 'mimeType': mimeType,
      };

  @override
  UrlSource copyWith({String? value, Object? mimeType = _absent}) => UrlSource(
        value: value ?? this.value,
        mimeType: identical(mimeType, _absent) ? this.mimeType : mimeType as String?,
      );
}

/// Parses the shared `source` (+ optional `metadata`) of a media input part.
({InputContentSource source, Object? metadata}) _parseMediaPart(
  Map<String, dynamic> json,
  String type,
) {
  final rawSource = json['source'];
  if (rawSource is! Map<String, dynamic>) {
    throw AGUIValidationError(
      message: '$type input content requires a source object',
      field: 'source',
      value: rawSource,
      json: json,
    );
  }
  return (
    source: InputContentSource.fromJson(rawSource),
    metadata: json['metadata'] as Object?,
  );
}

/// Serializes the shared shape of a media input part.
Map<String, dynamic> _mediaToJson(
  String type,
  InputContentSource source,
  Object? metadata,
) => {
      'type': type,
      'source': source.toJson(),
      if (metadata != null) 'metadata': metadata,
    };

/// Sentinel value used in [copyWith] methods to distinguish "not provided"
/// from `null`, allowing callers to clear optional fields by passing `null`.
const _absent = Object();

/// A single typed part of a multimodal [UserMessage].
///
/// A discriminated union on `type`: [TextInputContent], [ImageInputContent],
/// [AudioInputContent], [VideoInputContent], [DocumentInputContent], or the
/// legacy [BinaryInputContent]. Use [InputContent.fromJson] to decode.
sealed class InputContent extends AGUIModel with TypeDiscriminator {
  const InputContent();

  /// Decodes an [InputContent] from JSON, dispatching on `type`.
  factory InputContent.fromJson(Map<String, dynamic> json) {
    final type = JsonDecoder.requireField<String>(json, 'type');
    switch (type) {
      case 'text':
        return TextInputContent.fromJson(json);
      case 'image':
        return ImageInputContent.fromJson(json);
      case 'audio':
        return AudioInputContent.fromJson(json);
      case 'video':
        return VideoInputContent.fromJson(json);
      case 'document':
        return DocumentInputContent.fromJson(json);
      case 'binary':
        return BinaryInputContent.fromJson(json);
      default:
        throw AGUIValidationError(
          message: 'Invalid input content type: $type',
          field: 'type',
          value: type,
          json: json,
        );
    }
  }
}

/// Plain text part of a multimodal message.
class TextInputContent extends InputContent {
  /// The text payload.
  final String text;

  const TextInputContent(this.text);

  @override
  String get type => 'text';

  factory TextInputContent.fromJson(Map<String, dynamic> json) =>
      TextInputContent(JsonDecoder.requireField<String>(json, 'text'));

  @override
  Map<String, dynamic> toJson() => {'type': type, 'text': text};

  @override
  TextInputContent copyWith({String? text}) =>
      TextInputContent(text ?? this.text);
}

/// Image part of a multimodal message.
class ImageInputContent extends InputContent {
  /// The image source (data or URL).
  final InputContentSource source;

  /// Free-form, provider-specific metadata. Serialized only when non-null.
  final Object? metadata;

  const ImageInputContent({required this.source, this.metadata});

  @override
  String get type => 'image';

  factory ImageInputContent.fromJson(Map<String, dynamic> json) {
    final parsed = _parseMediaPart(json, 'image');
    return ImageInputContent(source: parsed.source, metadata: parsed.metadata);
  }

  @override
  Map<String, dynamic> toJson() => _mediaToJson(type, source, metadata);

  @override
  ImageInputContent copyWith({
    InputContentSource? source,
    Object? metadata = _absent,
  }) =>
      ImageInputContent(
        source: source ?? this.source,
        metadata: identical(metadata, _absent) ? this.metadata : metadata,
      );
}

/// Audio part of a multimodal message.
class AudioInputContent extends InputContent {
  /// The audio source (data or URL).
  final InputContentSource source;

  /// Free-form, provider-specific metadata. Serialized only when non-null.
  final Object? metadata;

  const AudioInputContent({required this.source, this.metadata});

  @override
  String get type => 'audio';

  factory AudioInputContent.fromJson(Map<String, dynamic> json) {
    final parsed = _parseMediaPart(json, 'audio');
    return AudioInputContent(source: parsed.source, metadata: parsed.metadata);
  }

  @override
  Map<String, dynamic> toJson() => _mediaToJson(type, source, metadata);

  @override
  AudioInputContent copyWith({
    InputContentSource? source,
    Object? metadata = _absent,
  }) =>
      AudioInputContent(
        source: source ?? this.source,
        metadata: identical(metadata, _absent) ? this.metadata : metadata,
      );
}

/// Video part of a multimodal message.
class VideoInputContent extends InputContent {
  /// The video source (data or URL).
  final InputContentSource source;

  /// Free-form, provider-specific metadata. Serialized only when non-null.
  final Object? metadata;

  const VideoInputContent({required this.source, this.metadata});

  @override
  String get type => 'video';

  factory VideoInputContent.fromJson(Map<String, dynamic> json) {
    final parsed = _parseMediaPart(json, 'video');
    return VideoInputContent(source: parsed.source, metadata: parsed.metadata);
  }

  @override
  Map<String, dynamic> toJson() => _mediaToJson(type, source, metadata);

  @override
  VideoInputContent copyWith({
    InputContentSource? source,
    Object? metadata = _absent,
  }) =>
      VideoInputContent(
        source: source ?? this.source,
        metadata: identical(metadata, _absent) ? this.metadata : metadata,
      );
}

/// Document part of a multimodal message.
class DocumentInputContent extends InputContent {
  /// The document source (data or URL).
  final InputContentSource source;

  /// Free-form, provider-specific metadata. Serialized only when non-null.
  final Object? metadata;

  const DocumentInputContent({required this.source, this.metadata});

  @override
  String get type => 'document';

  factory DocumentInputContent.fromJson(Map<String, dynamic> json) {
    final parsed = _parseMediaPart(json, 'document');
    return DocumentInputContent(
      source: parsed.source,
      metadata: parsed.metadata,
    );
  }

  @override
  Map<String, dynamic> toJson() => _mediaToJson(type, source, metadata);

  @override
  DocumentInputContent copyWith({
    InputContentSource? source,
    Object? metadata = _absent,
  }) =>
      DocumentInputContent(
        source: source ?? this.source,
        metadata: identical(metadata, _absent) ? this.metadata : metadata,
      );
}

/// Legacy binary content part.
///
/// Requires a non-empty [mimeType] and at least one of [id], [url], or [data].
class BinaryInputContent extends InputContent {
  /// The MIME type of the binary payload. Required and non-empty.
  final String mimeType;

  /// An opaque identifier for previously-uploaded content.
  final String? id;

  /// A URL referencing the content.
  final String? url;

  /// An inline data payload (e.g. base64-encoded).
  final String? data;

  /// An optional display filename.
  final String? filename;

  const BinaryInputContent({
    required this.mimeType,
    this.id,
    this.url,
    this.data,
    this.filename,
  })  : assert(mimeType != '', 'BinaryInputContent requires a non-empty mimeType'),
        assert(
          id != null || url != null || data != null,
          'BinaryInputContent requires at least one of id, url, or data',
        );

  @override
  String get type => 'binary';

  factory BinaryInputContent.fromJson(Map<String, dynamic> json) {
    final mimeType = _readMimeType(json);
    // Non-empty mimeType matches the Go reader (types.go:423, enforced on
    // unmarshal); intentionally stricter than TS, whose z.string() accepts "".
    if (mimeType == null || mimeType.isEmpty) {
      throw AGUIValidationError(
        message: 'BinaryInputContent requires a non-empty mimeType',
        field: 'mimeType',
        json: json,
      );
    }
    final id = JsonDecoder.optionalField<String>(json, 'id');
    final url = JsonDecoder.optionalField<String>(json, 'url');
    final data = JsonDecoder.optionalField<String>(json, 'data');
    if (id == null && url == null && data == null) {
      throw AGUIValidationError(
        message: 'BinaryInputContent requires at least one of id, url, or data',
        field: 'id',
        json: json,
      );
    }
    return BinaryInputContent(
      mimeType: mimeType,
      id: id,
      url: url,
      data: data,
      filename: JsonDecoder.optionalField<String>(json, 'filename'),
    );
  }

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'mimeType': mimeType,
        if (id != null) 'id': id,
        if (url != null) 'url': url,
        if (data != null) 'data': data,
        if (filename != null) 'filename': filename,
      };

  @override
  BinaryInputContent copyWith({
    String? mimeType,
    Object? id = _absent,
    Object? url = _absent,
    Object? data = _absent,
    Object? filename = _absent,
  }) =>
      BinaryInputContent(
        mimeType: mimeType ?? this.mimeType,
        id: identical(id, _absent) ? this.id : id as String?,
        url: identical(url, _absent) ? this.url : url as String?,
        data: identical(data, _absent) ? this.data : data as String?,
        filename: identical(filename, _absent) ? this.filename : filename as String?,
      );
}

/// The content union for a [UserMessage]: plain text or multimodal parts.
///
/// Mirrors the canonical `string | InputContent[]` shape. [toJson] returns a
/// `String` for [TextContent] or a `List` for [MultimodalContent].
///
/// Unlike the other models this does not extend `AGUIModel`: its [toJson] must
/// return a bare `String` or `List`, not a `Map<String, dynamic>`.
sealed class UserMessageContent {
  const UserMessageContent();

  /// Serializes to a JSON `String` (text) or `List` (multimodal parts).
  Object toJson();

  /// Decodes from a raw `content` value: a `String` or a `List` of parts.
  factory UserMessageContent.fromJson(Object? raw) {
    if (raw is String) {
      return TextContent(raw);
    }
    if (raw is List) {
      final parts = <InputContent>[];
      for (var i = 0; i < raw.length; i++) {
        final item = raw[i];
        if (item is! Map<String, dynamic>) {
          throw AGUIValidationError(
            message: 'UserMessage content part at index $i must be an object',
            field: 'content[$i]',
            value: item,
          );
        }
        try {
          parts.add(InputContent.fromJson(item));
        } on AGUIValidationError catch (e) {
          throw AGUIValidationError(
            message: 'Invalid content part at index $i: ${e.message}',
            field: 'content[$i]',
            value: item,
          );
        }
      }
      // Decode is tolerant: an empty list is a structurally valid
      // MultimodalContent (mirrors canonical TS `z.array`, which accepts []).
      // The non-empty invariant is enforced on the send side by
      // Validators.validateUserMessageContent.
      return MultimodalContent(parts);
    }
    throw AGUIValidationError(
      message: 'UserMessage content must be a String or a List of parts',
      field: 'content',
      value: raw,
    );
  }
}

/// Plain-text user message content. Serializes to a JSON `String`.
class TextContent extends UserMessageContent {
  /// The text payload.
  final String text;

  const TextContent(this.text);

  @override
  String toJson() => text;
}

/// Multimodal user message content. Serializes to a JSON `List`.
class MultimodalContent extends UserMessageContent {
  /// The ordered list of content parts.
  final List<InputContent> parts;

  const MultimodalContent(this.parts);

  @override
  List<Map<String, dynamic>> toJson() =>
      parts.map((part) => part.toJson()).toList();
}
