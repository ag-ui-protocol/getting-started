# Changelog

All notable changes to the AG-UI Dart SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Breaking Changes (review-fix pass)
- **`StateDeltaEvent.delta` and `ActivityDeltaEvent.patch` are now
  `List<Map<String, dynamic>>` instead of `List<dynamic>`.** RFC 6902 JSON
  Patch operations are always objects. Using `requireListField<Map<String,
  dynamic>>` surfaces non-object elements as `AGUIValidationError` at the
  decoder boundary with a `field: 'delta[$i]'` / `field: 'patch[$i]'` index,
  rather than leaking a downstream `TypeError` at the first `op['op']` access.
  Direct consumers of `event.delta[i]` who are already casting to Map are
  unaffected; consumers storing the list as `List<dynamic>` will need a type
  annotation update.
  **Migration:** change `List<dynamic>` type annotations on `event.delta` /
  `event.patch` to `List<Map<String, dynamic>>`. Code that already accesses
  `op['op']` / `op['path']` without an explicit cast is already correct.
- **`SseParser.maxDataBytes` renamed to `maxDataCodeUnits`.** The field
  already measured UTF-16 code units, not bytes — the rename corrects the
  misleading name. `SseParser(maxDataBytes: ...)` call sites must be updated
  to `SseParser(maxDataCodeUnits: ...)`.

### Fixed (review-fix pass)
- **`ActivityMessage.fromJson` now silently strips `encryptedValue` /
  `encrypted_value` instead of throwing `AGUIValidationError`.** `ActivityMessage`
  is not a `BaseMessage` extension in the canonical protocol, so the field
  does not apply. Dart was the only SDK that tore down the stream on encountering
  the field; TS strips silently (zod default) and Python preserves it. The
  change restores forward compatibility when a proxy emits the field.
- **`ReasoningEncryptedValueEvent.fromJson` no longer stores the cipher
  payload in `BaseEvent.rawEvent`.** Previously `rawEvent: _readRawEvent(json)`
  stored the full wire JSON (including `encryptedValue`) in the inherited
  `rawEvent` field, undoing the cipher-data scrubbing in every error path.
  `rawEvent` is now always `null` for this event type; proxies that need the
  raw wire form should retain it before calling `fromJson`.
- **`RunStartedEvent.fromJson` no longer attaches the offending payload to
`AGUIValidationError.json` on rethrow.** The full outer payload (and the inner
`RunAgentInput`, which can carry `encryptedValue` via `input.messages[*]`)
are both omitted, so cipher data cannot leak through validation errors —
matching the existing scrub in `MessagesSnapshotEvent.fromJson`.
- **`MessagesSnapshotEvent.fromJson` rethrow now drops `json:` entirely.**
  Forwarding `e.json` previously exposed the inner Message map on the outer
  error; for Tool/Reasoning subtypes that map can carry `encryptedValue`. Drops
  `json:` to match `AssistantMessage.fromJson`'s tool-call IIFE, which already
  uses the cautious default.
- **`JsonDecoder.requireEitherField` now distinguishes "key present but null"
  from "key absent".** Previously both cases produced the same
  "Missing required field 'X' (or 'Y')" message, misleading consumers into
  thinking the snake_case alias might work when the camelCase key was
  explicitly null. Now: key-present-but-null produces "Required field 'X' is
  present but null"; both-absent still produces the dual-key error.
- **`copyWith` sentinel sweep completed.** `ThinkingStartEvent.title`,
  `ToolCallResultEvent.role`, `StateSnapshotEvent.snapshot`, and
  `RunErrorEvent.code` now use the `kUnsetSentinel` pattern so callers can
  clear these nullable fields via `copyWith(field: null)`. The "Known parity
  gaps" list is now empty for payload fields.
- **`EventEncoder.acceptsProtobuf` and `EventDecoder.decodeBinary` now carry
  explicit dartdoc warnings** that protobuf is not yet implemented end-to-end.
  A client negotiating `application/vnd.ag-ui.event+proto` would receive a
  misleading "Invalid UTF-8 data" error; the docs now direct consumers to use
  SSE transport until protobuf support lands.
- **`groupRelatedEvents` dartdoc now documents the `ReasoningStart` /
  `ReasoningEnd` asymmetry.** Phase-level reasoning events are emitted as
  standalone singletons; only message-level `REASONING_MESSAGE_*` events are
  grouped. Consumers that need to associate phase-level markers with message
  groups must track phase boundaries in their own state.
- **`processChunk` resets `errorRoutedInChunk` after the for-loop.** The flag
  was previously only set inside the loop; future throw sites after the loop
  body could have silently swallowed unrelated errors.
- **`SseParser` error message corrected.** The OOM-guard error now says
  "code-unit limit" (not "byte limit") to match what the cap actually measures.
- **`SseParser._processField` now uses `write('\\n')` instead of `writeln()`**
  for the inter-`data:` separator. `writeln()` is equivalent on all Dart
  platforms but the explicit form removes any ambiguity about whether a
  platform line terminator is emitted.
- **`EventType.fromString` dartdoc strengthened** with an explicit contract
  note: callers must not change the throw type from `ArgumentError`, because
  `BaseEvent.fromJson` uses a narrow `on ArgumentError` catch to distinguish
  unknown event types from factory bugs.

### Fixed (review pass — protocol parity)
- **`encryptedValue` is now plumbed through every BaseMessage subtype**
  (`DeveloperMessage`, `SystemMessage`, `AssistantMessage`,
  `UserMessage`) on the base `Message` class. Mirrors canonical TS
  `BaseMessageSchema.encryptedValue: z.string().optional()` and Python
  `BaseMessage.encrypted_value: Optional[str]`. Previously the field
  was only present on `ToolMessage` and `ReasoningMessage`, so a Dart
  proxy decoding a `MESSAGES_SNAPSHOT` whose assistant or user message
  carried `encryptedValue` from a TS or Python server silently dropped
  the value at decode and could not re-emit it on the next hop. Decode
  accepts both `encryptedValue` (TS-canonical) and `encrypted_value`
  (Python-canonical); `toJson` emits camelCase; each subtype's
  `copyWith` accepts an explicit-null clear via the sentinel pattern.
  The `ToolMessage` and `ReasoningMessage` field declarations were
  removed in favor of inheriting from the base — the wire shape is
  unchanged.
- **`raw_event` (snake_case) is now preserved on every event factory.**
  All ~30 `BaseEvent` subclasses now read `rawEvent` via a centralized
  `_readRawEvent` helper that uses `containsKey` precedence: the
  camelCase key wins when present (even when explicitly `null`), and
  the snake_case key is consulted only when camelCase is absent.
  Previously every factory read `json['rawEvent']` directly, silently
  dropping Python-style `raw_event` payloads. `toJson` continues to
  emit camelCase only.
- **`REASONING_ENCRYPTED_VALUE` no longer rejects empty
  `entityId` / `encryptedValue` strings.** Canonical TS uses
  `z.string()` and Python uses `str` — neither imposes a minimum
  length. The Dart-only empty-string rejection (in both
  `ReasoningEncryptedValueEvent.fromJson` and `EventDecoder.validate`)
  was over-strict and would reject payloads that the canonical SDKs
  accept. The strict subtype discriminator stays — unknown subtypes
  still throw.
- **`SseParser._processField` now matches the WHATWG SSE spec for
  empty leading `data:` lines and repeated `event:` lines.** The
  `data:` case used `_dataBuffer.isNotEmpty` as a "have we written
  data yet?" heuristic, which collapsed `data:\ndata: x\n\n` to `"x"`
  instead of the spec-correct `"\nx"`. Now uses the `_hasDataField`
  flag (mirroring the `inDataBlock` pattern in
  `EventStreamAdapter.appendDataLine`). The `event:` case appended on
  every `event:` line; per spec it must REPLACE.
- **`EventStreamAdapter.fromRawSseStream` now propagates downstream
  cancellation, pause, and resume to the upstream raw SSE
  subscription.** Previously the upstream `rawStream.listen(...)`
  subscription was fire-and-forget — a consumer that cancelled the
  adapted stream early left the upstream draining indefinitely
  (a real resource leak on long-lived agent streams).
- **`SseParser.parseBytes` now flushes any final unterminated event
  on stream close.** Routed through `parseLines` so the final
  `_dispatchEvent()` flush in `parseLines` fires for byte-stream
  sources too. A byte source that ended without a trailing blank line
  previously lost its last buffered message.
- **`copyWith` sentinel sweep.** `RawEvent.source`,
  `RunAgentInput.state`, `RunAgentInput.forwardedProps`, and
  `Run.result` previously used the standard `?? this.field` pattern,
  so a caller could not clear them via `copyWith(field: null)`. They
  now use the existing sentinel pattern. The "Known parity gaps"
  list below has been updated.
- **`JsonDecoder.optionalEitherField` now resolves on KEY presence,
  not value-non-null.** A payload carrying both `camelKey: null` and
  `snake_key: <value>` previously fell through to the snake_case
  value; the documented contract on `requireEitherField` is that
  camelCase wins when its key is present (even when explicitly
  `null`). The implementation now matches the dartdoc. The inline
  `forwardedProps` decode in `context.dart` was migrated to the same
  `containsKey` rule for consistency.
- **`ToolMessage.fromJson` and `ToolResult.fromJson` now use
  `requireEitherField`** instead of the older
  `optionalEitherField + manual null-check + custom throw` pattern,
  matching the migration already done for `RunAgentInput.fromJson`
  and `Run.fromJson`.
- **`Validators.validateMessageContent` is now `String`-only.** The
  pre-0.2.0 permissive `Map`/`List` branches were dead code (no caller
  in the SDK passed those types) and disagreed with canonical
  `BaseMessage.content: Optional[str]`. Multimodal `UserMessage.content`
  remains a tracked parity gap.
- **`Validators.validateUrl` now rejects URLs containing C0 control
  characters or DEL** (`\x00`–`\x1f`, `\x7f`). `Uri.parse` is
  permissive with embedded `\n` / `\r` / `\t`, which can flow into
  HTTP request lines as a header-injection vector.
- **`JsonDecoder.requireField` and `optionalField` transform-failure
  paths now preserve `cause: e`** when wrapping an inner exception
  in `AGUIValidationError`. The structured cause was previously
  flattened into the message via `'$e'` interpolation only.

### Documented
- `AGUIValidationError.json` dartdoc now carries an explicit
  sensitive-data warning: the field captures the entire wire payload
  including cipher fields. `toString()` does not emit it (safe by
  default), but reflection-based serializers used by some logging
  frameworks will leak. Prefer `.field` and `.value` on log lines
  shipped to external sinks.
- `EventDecoder.validate` dartdoc now documents the dual-source
  error class asymmetry: `validate()` raises
  `client/errors.dart`'s `ValidationError`; `fromJson`-side eager
  rejections raise `types/base.dart`'s `AGUIValidationError`. Both
  surface uniformly as `DecodingError` through the public
  `decode` / `decodeJson` boundary; both extend `AGUIError`.
- `BaseEvent.rawEvent` dartdoc now notes the round-trip emission
  consequence — anything assigned to this field WILL be re-emitted
  on the next `encode`. Set `rawEvent: null` on the in-flight event
  if a proxy doesn't want the upstream payload echoed downstream.
- README adds a "Proxy notes: wire-spelling normalization" paragraph
  documenting that the SDK accepts both camelCase and snake_case on
  `fromJson` but always emits camelCase on `toJson`. The Error
  Handling section is refreshed to use the current error-hierarchy
  class names (`TransportError`, `DecodingError`, `ValidationError`,
  `CancellationError`, all under `AGUIError`).
- `AgUiClient.runAgent` dartdoc `Throws:` list refreshed to match
  the current error hierarchy.
- `EventStreamAdapter.groupRelatedEvents` dartdoc now carries an
  explicit unbounded-state warning — open groups (where `*Start` was
  received but `*End` has not arrived) are held in memory until the
  matching end event or stream completion. Same caveat applies to
  `accumulateTextMessages`.

### Fixed (review pass — behavior)
- **`Tool.copyWith(parameters: null)` now correctly clears `parameters`.**
  The previous `parameters ?? this.parameters` pattern silently kept the
  existing value when `null` was passed; the field now uses the `_unsetTool`
  sentinel pattern, consistent with `ToolCall.encryptedValue` and every
  other nullable field in the SDK. This gap was omitted from the 0.2.0
  "Known parity gaps" list — it has been corrected here.
- **`EventStreamAdapter.fromRawSseStream` now subscribes to the upstream
  lazily** (inside `controller.onListen`) rather than eagerly at call time.
  A caller that obtained the returned stream but never subscribed would
  previously leak the upstream SSE connection until the server closed it.
  The cancellation, pause, and resume propagation added in the prior
  review pass is preserved; subscription lifecycle callbacks now use
  null-safe `?.` calls since the subscription is no longer `late final`.
- **`Message.fromJson` now preserves the wire JSON payload in
  `AGUIValidationError`** when `MessageRole.fromString` fails. Previously
  the error was thrown without `json:` set, making it impossible to
  identify which message in a `MESSAGES_SNAPSHOT` had the unrecognized
  role. The re-thrown error carries the originating `json` map so the
  decoder pipeline can surface it as a `DecodingError` with full context.

### Changed
- `TimeoutError` renamed to `AGUITimeoutError` to avoid shadowing the
  built-in `dart:async.TimeoutError` (raised by `Future.timeout(...)` /
  `Stream.timeout(...)`). The bare name is preserved as a deprecated
  typedef alias for backward compat and will be removed in 1.0.0.
  Internal call sites in `AgUiClient` throw the new name directly. The
  README "Errors" recipe and "Migrating from 0.1.0" section call out
  the rename so consumers using both `package:ag_ui/ag_ui.dart` and
  `dart:async` can avoid the symbol collision.
- Empty `delta` is now accepted on `TEXT_MESSAGE_CONTENT`,
  `TOOL_CALL_ARGS`, and `REASONING_MESSAGE_CONTENT`, and empty
  `content` is accepted on `TOOL_CALL_RESULT`, to match the canonical
  TS/Python schemas (`z.string()` / `str` with no `min(1)` constraint).
  Previously the Dart SDK rejected empty values at both the `fromJson`
  factory and the `EventDecoder.validate` pipeline; a Python or TS
  server that legitimately emitted a deliberate empty chunk (e.g. a
  noop content refresh) would fail decode in Dart but pass in the
  canonical SDKs. Empty cipher payloads on `REASONING_ENCRYPTED_VALUE`
  (`entityId`, `encryptedValue`) continue to be rejected — the "no
  graceful default for cipher payloads" contract stays.

### Fixed
- `ToolCall` now carries the optional `encryptedValue` field for parity
  with canonical TS (`ToolCallSchema.encryptedValue: z.string().optional()`)
  and Python (`ToolCall.encrypted_value: Optional[str]`). Previously a
  message arriving with `toolCalls: [{..., encryptedValue: "..."}]`
  silently dropped the value at decode and could not re-emit it on a
  proxy hop. Decode accepts both `encryptedValue` and `encrypted_value`;
  `toJson` emits the camelCase key when present; `copyWith` uses the
  sentinel pattern so callers can explicitly clear it via
  `copyWith(encryptedValue: null)`.
- `RunAgentInput` now carries the optional `parentRunId` field for
  parity with canonical TS (`RunAgentInputSchema.parentRunId:
  z.string().optional()`) and Python (`RunAgentInput.parent_run_id`).
  Previously a `RUN_STARTED` payload with `input.parentRunId: '...'`
  decoded with the field silently dropped, even though
  `RunStartedEvent.parentRunId` itself was preserved. Decode accepts
  both `parentRunId` and `parent_run_id`; `toJson` emits camelCase when
  present; `copyWith` uses the sentinel pattern.
- `EventStreamAdapter.fromRawSseStream` now handles CRLF (`\r\n`) line
  terminators, not just LF. Previously a CRLF-emitting SSE server
  produced `"\r"` lines that never matched the empty-line event-boundary
  signal, so events buffered until stream close. The line splitter now
  strips a trailing `\r` after splitting on `\n`. The same fix is
  applied to `EventDecoder.decodeSSE`, which now uses `LineSplitter`
  (handling `\n`, `\r`, and `\r\n` per the WHATWG SSE spec).
- `JsonDecoder.optionalListField` and `requireListField` now eagerly
  type-check elements (raising `AGUIValidationError(field: '$field[$i]')`
  on the first wrong-typed element) instead of returning a lazy
  `cast<T>()` view that surfaced as a raw `TypeError` at access time and
  was flattened to `field: 'json'` by the decoder catch-all.
- `AssistantMessage.fromJson` now uses `JsonDecoder.optionalEitherField`
  on the `toolCalls` / `tool_calls` key itself, instead of a `??` chain
  on the post-`.map(...).toList()` value. The previous chain only fired
  on null, so an empty `toolCalls: []` short-circuited the snake_case
  fallback even when `tool_calls: [...]` was populated.
- `AssistantMessage.toJson` now emits `toolCalls` whenever the in-memory
  field is non-null (including empty lists), so the round-trip
  `fromJson(m.toJson()) == m` is symmetric.
- Decoder pipeline now rethrows `EncoderError` / `DecodeError` /
  `EncodeError` unchanged instead of re-wrapping them as a generic
  "Failed to decode event" via the catch-all.
- `EventEncoder.encodeSSE` no longer strips fields whose value is `null`.
  The blanket `json.removeWhere((k, v) => v == null)` was silently
  dropping fields that intentionally serialize as `null`
  (`ActivitySnapshotEvent.content`, `RawEvent.event`, `CustomEvent.value`,
  `StateSnapshotEvent.snapshot`), breaking the encode→decode round-trip
  because the matching factories require the key to be present and reject
  it with `AGUIValidationError`. Each `toJson()` already uses
  `if (field != null) 'field': field` for fields that opt in to omission,
  so the strip pass was redundant in addition to harmful. Pinned by a
  new round-trip test in `fixtures_integration_test.dart`.
- `EventStreamAdapter.fromRawSseStream` now handles WHATWG-spec lone-`\r`
  line terminators in addition to `\n` and `\r\n`. The previous chunk
  scanner only split on `\n`, so a producer using bare `\r` (rare in
  practice but spec-valid) buffered indefinitely. The new multi-terminator
  scanner defers a trailing `\r` at chunk boundaries to disambiguate from
  a chunk-spanning `\r\n` and consumes it on stream close. Steady-state
  emission for CRLF-encoded streams is unchanged.
- `EventStreamAdapter.fromSseStream` and `fromRawSseStream` now preserve
  any `AGUIError` subtype (`AgUiError`, `AGUIValidationError`,
  `EncoderError`) raised by the decoder instead of re-wrapping the
  encoder-family errors as a generic `DecodingError`. Mirrors the
  unified-error-surface contract that `EventDecoder.decode/decodeJson`
  already honor.
- `TestHelpers.findToolCalls` (test-only helper) now uses the typed
  `AssistantMessage.toolCalls` accessor. Previously it round-tripped
  through `toJson` and read the snake_case key `tool_calls`, but
  `AssistantMessage.toJson` emits camelCase `toolCalls` — the helper
  silently always returned an empty list. Currently unreferenced by the
  test suite, so this is a latent-bug fix.

### Added
- `JsonDecoder.optionalEitherListField<T>` helper combining the dual-key
  resolution rule from `optionalEitherField` with the index-aware
  element-type validation from `requireListField` / `optionalListField`.
  `AssistantMessage.fromJson` now uses it so a malformed nested
  `toolCalls[i]` raises `AGUIValidationError(field: 'toolCalls[$i]')`
  instead of leaking a raw `TypeError` from the per-element cast.

### Changed
- `Message` subclass `copyWith` methods (`DeveloperMessage`,
  `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolMessage`,
  `ReasoningMessage`) now use the `_unsetMessage` sentinel pattern for
  nullable fields, matching the event-class discipline. Callers can
  explicitly clear a nullable field via `copyWith(field: null)` —
  previously `?? this.field` could not distinguish "argument omitted"
  from "argument explicitly null".
- `JsonDecoder.optionalIntField` (new helper) accepts `int` or `num`
  and coerces via `.toInt()`. Every event factory now reads
  `timestamp` via this helper, so a TS server emitting a fractional
  number (e.g. `Date.now() / 1000`) no longer fails decode with
  `AGUIValidationError(field: 'timestamp')`.
- Error-hierarchy unification: `AgUiError` now extends `AGUIError`,
  and `AGUIValidationError` now extends `AGUIError` instead of bare
  `implements Exception`. Callers can `on AGUIError catch (e)` to
  cover the entire SDK error surface (including direct-factory
  validation, encoder-side failures, runtime/transport, and decoder
  errors). `on AgUiError` still scopes to runtime/transport/decoding
  as before. Added an "Errors" section to the README documenting the
  recommended catch recipe.
- `AGUIValidationError` gained an optional `cause` parameter so the
  `transform`-rethrow path in `JsonDecoder` can preserve structured
  error info instead of flattening to `'Failed to transform field: $e'`.
- `SseParser` documented its per-connection state semantics (sticky
  `_lastEventId`); a new `reset()` method clears all parser state for
  callers that explicitly want to reuse an instance across independent
  streams.
- `Validators.maxTimeout` exposed as `static const Duration` so callers
  can introspect the limit (10 minutes). The cap value is unchanged;
  raising it is deferred to a future release.
- `RunAgentInput.fromJson` and `Run.fromJson` migrated to
  `JsonDecoder.requireEitherField` for consistency with every other
  factory in the SDK. Behavior preserved; the
  "Missing required field 'X' (or 'Y')" wording shifts slightly to match
  the helper's standard error message.
- Long `@Deprecated` messages on the `THINKING_*` enum values and event
  classes hoisted into top-level `const` strings (`event_type.dart`,
  `events.dart`). Surfaces the planned-removal version in one place per
  context and reduces drift risk if it ever changes. No behavior change.

### Documentation
- `UserMessage` documented as a known parity gap with the canonical
  multimodal schema (TS `Union[string, InputContent[]]`, Python
  `Union[str, List[InputContent]]`); the Dart SDK currently only
  supports the string variant.
- `Message.id` documented as nullable-by-type but required-by-convention
  (every concrete subtype constructor declares it `required`); a future
  major version may tighten the type to non-nullable for parity with
  canonical `BaseMessageSchema.id: z.string()`.
- `EventDecoder.validate`'s `Thinking*` deprecated cases gained
  comments explaining why they don't validate `messageId` (the
  deprecated wire shape has no such field; the migration target
  `REASONING_*` does).
- `EventDecoder.validate`'s `ActivityDeltaEvent` case gained a comment
  noting that an empty `patch` is intentional per the canonical
  TS/Python schemas (`z.array(...).min(0)` / list with no length floor).
- `BaseEvent.rawEvent` field gained a dartdoc note clarifying that the
  field is unvalidated (typed `dynamic` because the protocol does not
  constrain the shape).
- `ToolCallResultEvent.role`, `StateSnapshotEvent.snapshot`, and
  `RunErrorEvent.code` field declarations gained a dartdoc note that
  `copyWith(field: null)` does NOT clear the field (these three are the
  remaining cases listed in "Known parity gaps"). Construct a new
  instance directly to drop.
- `MessageRole.activity` and `MessageRole.reasoning` enum values gained
  wire-spelling-pinning dartdoc, mirroring the
  `ReasoningEncryptedValueSubtype.toolCall` style.
- `EventDecoder.validate`'s `ThinkingTextMessageContentEvent` case gained
  a clarified rationale comment: the deprecated path keeps the pre-0.2.0
  stricter "non-empty `delta`" contract intentionally — sibling content
  events (`TextMessageContentEvent`, `ToolCallArgsEvent`,
  `ToolCallResultEvent`, `ReasoningMessageContentEvent`) were RELAXED
  to accept empty strings in 0.2.0 for canonical TS/Python parity, but
  loosening a deprecated contract retroactively serves no one.
- `ReasoningEncryptedValueEvent.fromJson` empty-string rejection comment
  updated to reflect the post-0.2.0 sibling state — it is intentionally
  stricter than the relaxed sibling content events because cipher
  payloads have no defensible "empty" semantic.
- `BaseEvent.fromJson` and `Message.fromJson` switches gained an explicit
  trailing comment stating the analyzer-enforced exhaustiveness so future
  contributors don't add a `default` clause "to be safe."
- `EventStreamAdapter` adopted an internal `_appendDataLine` /
  `flushDataBlock` decomposition to share the per-line and `onDone`
  flush paths in `fromRawSseStream`. No behavior change.
- README "Migrating from 0.1.0" `TimeoutError` → `AGUITimeoutError`
  section gained a paragraph clarifying the symmetric case: consumers
  who previously meant `dart:async.TimeoutError` and were accidentally
  catching SDK instances will see different runtime behavior after they
  fix the import.

### Known parity gaps
- **`requireNonEmpty` on `messageId`, `threadId`, and `runId` fields is
  stricter than the canonical `z.string()` / `str` schemas** (which allow
  empty strings). `EventDecoder.validate()` rejects empty ID strings;
  a TS or Python server that legitimately emits an empty `messageId` would
  fail decode in Dart. The strict behavior is intentional (empty IDs have
  no valid semantic in the current protocol) and is tracked for review at
  1.0.0 alignment.
- **`BaseEvent.toJson` always emits `rawEvent` in camelCase** even when the
  original wire payload used `raw_event` (snake_case). Proxies that must
  forward the exact wire spelling should read the value before calling
  `fromJson` and re-attach it to the outbound payload manually, or
  preserve the original byte stream instead of round-tripping through the
  Dart event model.
- **`ActivityDeltaEvent.patch` decodes as `List<Map<String, dynamic>>`**
  and rejects non-object patch elements at the decoder boundary. Canonical TS
  (`z.array(z.any())`) and Python (`List[Any]`) accept any element type and
  defer validation to downstream RFC-6902 consumers. Producers emitting
  non-object patch elements (legal per canonical schemas, illegal per RFC 6902)
  will be rejected by the Dart decoder.
- **`AssistantMessage.toJson` emits `toolCalls: []` when the in-memory list
  is non-null but empty.** The canonical TS/Python SDKs omit the key when the
  list is empty. This ensures round-trip symmetry
  (`fromJson(m.toJson()) == m`) but diverges from canonical wire output for
  messages whose `toolCalls` field was decoded from an absent key. Consumers
  producing wire output for external TS/Python clients should treat an empty
  list and an absent key as equivalent.

### Breaking Changes (activity/reasoning events — 2026-04-30)
- `ToolCallResultEvent.role` is now typed `ToolCallResultRole?` instead of
  `String?`. Callers constructing the event directly must use the enum
  (e.g. `ToolCallResultRole.tool`) instead of a raw string. Wire decoding
  is unaffected: an unknown role string on the wire is absorbed via
  `ToolCallResultRole.fromString` and falls back to `ToolCallResultRole.tool`
  (forward-compatible with future canonical roles). The new `role` enum
  exists for parity with the Python `Literal["tool"]` / TypeScript
  `z.literal("tool")` canonical role surface.

### Added
- Activity events for event-type parity with the Python and TypeScript SDKs
  ([#1018](https://github.com/ag-ui-protocol/ag-ui/issues/1018)):
  - `ActivitySnapshotEvent` (`ACTIVITY_SNAPSHOT`)
  - `ActivityDeltaEvent` (`ACTIVITY_DELTA`)
- Reasoning events for event-type parity:
  - `ReasoningStartEvent` (`REASONING_START`)
  - `ReasoningMessageStartEvent` (`REASONING_MESSAGE_START`)
  - `ReasoningMessageContentEvent` (`REASONING_MESSAGE_CONTENT`)
  - `ReasoningMessageEndEvent` (`REASONING_MESSAGE_END`)
  - `ReasoningMessageChunkEvent` (`REASONING_MESSAGE_CHUNK`)
  - `ReasoningEndEvent` (`REASONING_END`)
  - `ReasoningEncryptedValueEvent` (`REASONING_ENCRYPTED_VALUE`)
- Supporting enums: `ReasoningMessageRole`, `ReasoningEncryptedValueSubtype`.
- `ActivityMessage` and `ReasoningMessage` `Message` subtypes (with
  `MessageRole.activity` / `MessageRole.reasoning`) so `MESSAGES_SNAPSHOT`
  payloads carrying those roles decode in Dart with the same schema as the
  canonical TypeScript and Python SDKs. The `activityType` /
  `activity_type` and `encryptedValue` / `encrypted_value` keys both
  decode for camelCase/snake_case parity with the wider protocol.
- Field-level parity for canonical events that previously dropped wire data
  on decode: `TextMessageStartEvent.name`, `TextMessageChunkEvent.name`,
  `RunStartedEvent.parentRunId`, and `RunStartedEvent.input` are now decoded
  and re-emitted by `toJson` so a Dart proxy preserves upstream metadata.
- All event `fromJson` factories now accept both camelCase (TypeScript
  server) and snake_case (Python server) field keys, including the
  pre-existing `TextMessage*` and `ToolCall*` events that were previously
  camelCase-only.
- Decoder-boundary non-empty validation extended to `ToolCallArgsEvent`,
  `ToolCallEndEvent`, `ToolCallResultEvent`, `RunFinishedEvent`,
  `StepStartedEvent`, `StepFinishedEvent`, `StateSnapshotEvent`, `RawEvent`,
  and `CustomEvent` so wire payloads with empty required identifiers or
  missing required content fail at `EventDecoder.decodeJson` instead of
  reaching consumer code as a null/empty value.

### Changed
- `REASONING_MESSAGE_START.role` is now required during decoding to match
  the canonical TypeScript and Python schemas. A payload missing `role`
  now raises `AGUIValidationError` (wrapped as `DecodingError` through
  `EventDecoder`); an unknown role string still falls back to
  `ReasoningMessageRole.reasoning` for forward-compatibility.
- `TextMessageRole.fromString` now throws `ArgumentError` on unknown
  values, mirroring `ReasoningMessageRole.fromString`. Wire decoding is
  unaffected: `TextMessageStartEvent.fromJson` and
  `TextMessageChunkEvent.fromJson` absorb the throw and fall back to
  `TextMessageRole.assistant` for forward compatibility — only direct
  callers of `TextMessageRole.fromString` see the new visible failure
  mode.
- `ReasoningEncryptedValueEvent.fromJson` now wraps an unknown `subtype`
  as `AGUIValidationError` (matching the class-level dartdoc contract),
  instead of leaking the raw `ArgumentError` from
  `ReasoningEncryptedValueSubtype.fromString`. The `EventDecoder`
  pipeline still surfaces it as `DecodingError`.
- `ActivitySnapshotEvent.copyWith` (`content`), `RawEvent.copyWith`
  (`event`), `CustomEvent.copyWith` (`value`), and
  `RunFinishedEvent.copyWith` (`result`) now use an internal sentinel
  parameter so callers can intentionally clear the field to `null`
  (matching each factory contract that already accepted explicit-null
  payloads). Other `copyWith` methods retain the standard
  `?? this.field` pattern (see Known parity gaps).
- `EventDecoder.decodeJson` now wraps `AGUIValidationError` (thrown by
  `fromJson` factories) explicitly so the resulting `DecodingError`
  preserves the original failing field — `role`, `messageId`,
  `subtype`, etc. — instead of flattening to `field: 'json'`. Pre-fix,
  the wrapper relied on the `AgUiError`-based catch path, which
  `AGUIValidationError` (which only `implements Exception`) bypassed.
- `EventDecoder.validate` now rejects an empty `messageId` on
  `TextMessageEndEvent`, restoring symmetry with `TextMessageStartEvent`
  and `TextMessageContentEvent` (and the new reasoning-end events).

### Deprecated
- `EventType.thinkingContent` and `ThinkingContentEvent` — not part of the
  canonical AG-UI protocol. Use `EventType.reasoningMessageContent` /
  `ReasoningMessageContentEvent` instead. Decoding remains supported for
  backward compatibility; scheduled for removal in 1.0.0.
- `EventType.thinkingTextMessageStart` /
  `EventType.thinkingTextMessageContent` /
  `EventType.thinkingTextMessageEnd` (and their event classes:
  `ThinkingTextMessageStartEvent`, `ThinkingTextMessageContentEvent`,
  `ThinkingTextMessageEndEvent`). Mirrors the canonical TypeScript SDK's
  deprecation of `THINKING_TEXT_MESSAGE_*` in favor of `REASONING_*`. Use
  `ReasoningMessageStartEvent` / `ReasoningMessageContentEvent` /
  `ReasoningMessageEndEvent` instead. Decoding remains supported for
  backward compatibility; scheduled for removal in 1.0.0.

### Known parity gaps (follow-up)
- `copyWith` sentinel sweep is now complete for all nullable payload fields.
  The sentinel pattern (`kUnsetSentinel` / `identical` check) is in place for
  `ActivitySnapshotEvent.content`, `RawEvent.event`, `RawEvent.source`,
  `CustomEvent.value`, `RunFinishedEvent.result`, the optional fields of
  `TextMessageStartEvent` / `TextMessageChunkEvent`,
  `ToolCallStartEvent.parentMessageId`, the optional fields of
  `ToolCallChunkEvent` and `ReasoningMessageChunkEvent`,
  `RunStartedEvent.parentRunId` / `RunStartedEvent.input`,
  `RunAgentInput.parentRunId` / `RunAgentInput.state` /
  `RunAgentInput.forwardedProps`, `Run.result`, the message-class nullables
  (`name`, `content`, `toolCalls`, `error`, `encryptedValue`),
  `ThinkingStartEvent.title`, `ToolCallResultEvent.role`,
  `StateSnapshotEvent.snapshot`, and `RunErrorEvent.code`.
- `RunFinishedEvent.result` is dropped from `toJson()` when null: an
  inbound explicit-null `'result': null` does not survive a Dart→Dart
  re-serialization round-trip. This matches the canonical TS/Python schemas
  (`z.any().optional()` / `Optional[Any] = None`), so cross-SDK forwarding
  is unaffected. Consumers relying on byte-for-byte round-trip fidelity
  should read `rawEvent` instead of re-serializing.

## [0.2.0] - 2026-05-28

### Added
- Multimodal `UserMessage` content. `UserMessage.content` now accepts either a
  plain string or an ordered list of typed parts, matching the canonical
  protocol (`string | InputContent[]`).
- New content types: `UserMessageContent` (`TextContent`, `MultimodalContent`),
  `InputContent` (`TextInputContent`, `ImageInputContent`, `AudioInputContent`,
  `VideoInputContent`, `DocumentInputContent`, legacy `BinaryInputContent`), and
  `InputContentSource` (`DataSource`, `UrlSource`).
- `UserMessage.multimodal(...)` and `UserMessage.fromContent(...)` constructors.
- `Validators.validateUserMessageContent(...)`.

### Changed
- **Breaking:** `UserMessage.content` getter is now `String?` (was non-null
  `String`) and returns `null` for multimodal messages. Read
  `UserMessage.messageContent` for the typed union.
- **Breaking:** `UserMessage.copyWith` now takes `messageContent` instead of
  `content`.
- **Breaking:** the default `UserMessage({required id, required content})`
  constructor is no longer `const` (it wraps the string into `TextContent` at
  runtime). Use `UserMessage.fromContent(id:, messageContent: const TextContent(...))`
  for a compile-time constant.

## [0.1.0] - 2025-01-21

### Added
- Initial release of the AG-UI Dart SDK
- Core protocol implementation with full event type support
- HTTP client with Server-Sent Events (SSE) streaming
- Strongly-typed models for all AG-UI protocol entities
- Support for tool interactions and generative UI
- State management with snapshots and JSON Patch deltas (RFC 6902)
- Message history tracking across multiple runs
- Comprehensive error handling with typed exceptions
- Cancel token support for aborting long-running operations
- Environment variable configuration support
- Example CLI application demonstrating key features
- Integration tests validating protocol compliance

### Features
- `AgUiClient` - Main client for AG-UI server interactions
- `SimpleRunAgentInput` - Simplified input structure for common use cases
- Event streaming with backpressure handling
- Tool call processing and result handling
- State synchronization across agent runs
- Message accumulation and conversation context

### Known Limitations
- WebSocket transport not yet implemented
- Binary protocol encoding/decoding not yet supported
- Advanced retry strategies planned for future release
- Event caching and offline support planned for future release

[0.3.0]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/dart-v0.3.0
[0.2.0]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/dart-v0.2.0
[0.1.0]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/dart-v0.1.0
