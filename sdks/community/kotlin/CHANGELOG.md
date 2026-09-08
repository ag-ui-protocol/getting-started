# Changelog

All notable changes to ag-ui-4k will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-06-02

### Added
- **Interrupts** ([AG-UI spec](https://docs.ag-ui.com/concepts/interrupts)). The Kotlin SDK now models the interrupt protocol that the TypeScript and Python SDKs already ship. Without this change a Kotlin client connected to an interrupt-aware server would either fail polymorphic deserialization of `outcome` or silently drop the interrupt payload on a `RUN_FINISHED` event.
  - New types in `com.agui.core.types`:
    - `Interrupt(id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata?)`
    - `ResumeStatus` enum (`RESOLVED` → `"resolved"`, `CANCELLED` → `"cancelled"`)
    - `ResumeEntry(interruptId, status, payload?)`
    - Sealed `RunFinishedOutcome` with `@JsonClassDiscriminator("type")`:
      - `RunFinishedSuccessOutcome` (`{"type":"success"}`)
      - `RunFinishedInterruptOutcome(interrupts)` (`{"type":"interrupt","interrupts":[…]}`) — `interrupts` is validated non-empty at construction.
  - `RunAgentInput` gains an optional `resume: List<ResumeEntry>?` field for resuming a previously interrupted run on the same `threadId`.
  - `RunFinishedEvent` gains optional `result: JsonElement?` and `outcome: RunFinishedOutcome?` fields. Both default to `null`; legacy producers that omit them continue to decode unchanged, and Python `exclude_none=False` callers that emit explicit JSON `null` also decode to `null`.
  - `AgUiSerializersModule` registers the two `RunFinishedOutcome` subclasses for polymorphic serialization.
  - 13 new tests in `InterruptSerializationTest` covering minimal/full `Interrupt` round-trips, `ResumeEntry` status enum mapping and rejection of unknown statuses, object payloads, `RunAgentInput.resume` omit/round-trip, `RunFinishedInterruptOutcome` non-empty validation, and `RunFinishedEvent` round-trips for the legacy shape, the success outcome, the interrupt outcome (including a server-produced JSON shape), and explicit `null` outcome/result.

### Examples
- Chatapp surfaces `REASONING_*` events as a transient "💭 Reasoning…" bubble (new `MessageRole.REASONING` + `EphemeralType.REASONING`), mirroring the existing tool-call / step ephemeral pattern. Clears on `RUN_FINISHED`, run cancel, or run error. Handles `REASONING_START` / `REASONING_END`, `REASONING_MESSAGE_START` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END`, and `REASONING_MESSAGE_CHUNK`.
- Bump all Kotlin sample apps (chatapp, chatapp-java, chatapp-wearos, chatapp-swiftui, tools) from `agui-core 0.3.0` to `0.4.1` and consume the published artefacts from Maven by removing the `includeBuild("../../library")` + dependencySubstitution blocks from the four chatapp variants' settings files.
- Bump chatapp Kotlin `2.1.20 → 2.2.20` so the iOS targets can consume `com.mikepenz:multiplatform-markdown-renderer-m3:0.37.0` klibs (require ABI 2.2.0+).

## [0.4.0] - 2026-05-12

### Added
- **Reasoning events** ([#1650](https://github.com/ag-ui-protocol/ag-ui/issues/1650)). The Kotlin SDK now supports the seven `REASONING_*` events that have replaced `THINKING_*` in the TypeScript and Python SDKs. Without this change a Kotlin client connected to a server emitting `REASONING_*` events would fail polymorphic deserialization because the discriminator `type` did not match any `BaseEvent` subclass.
  - New `EventType` enum entries and `BaseEvent` subclasses in `com.agui.core.types`:
    - `REASONING_START` / `ReasoningStartEvent(messageId)`
    - `REASONING_MESSAGE_START` / `ReasoningMessageStartEvent(messageId, role = "reasoning")` — `role` is validated at construction to match the TS `z.literal("reasoning")` and Python `Literal["reasoning"]` schema.
    - `REASONING_MESSAGE_CONTENT` / `ReasoningMessageContentEvent(messageId, delta)` — non-empty `delta` required.
    - `REASONING_MESSAGE_END` / `ReasoningMessageEndEvent(messageId)`
    - `REASONING_MESSAGE_CHUNK` / `ReasoningMessageChunkEvent(messageId?, delta?)` — both optional to support chunk-style streaming where only the first chunk carries the `messageId`.
    - `REASONING_END` / `ReasoningEndEvent(messageId)`
    - `REASONING_ENCRYPTED_VALUE` / `ReasoningEncryptedValueEvent(subtype, entityId, encryptedValue)` — `subtype` validated to be `"tool-call"` or `"message"` (parity with TS/Python).
- **Reasoning telemetry on `AgentState`.** New `AgentState.reasoning: ReasoningTelemetryState?` field tracks one or more reasoning streams keyed by `messageId`. Each `ReasoningStreamState` carries the stream's accumulated `text`, an `isActive` flag, and any attached `ReasoningEncryptedValue` payloads. `AbstractAgent` exposes a corresponding `reasoning` snapshot property.
- **`DefaultApplyEvents` wires up `REASONING_*` events.** Maintains a per-`messageId` stream map so concurrent reasoning streams are tracked independently (something the previous `ThinkingTelemetryState` could not represent). `REASONING_MESSAGE_CHUNK` auto-creates streams and re-uses the last active `messageId` when the chunk omits it; `REASONING_ENCRYPTED_VALUE` attaches to the most recently active stream. The reasoning map and last-active id are cleared on `RUN_STARTED`.
- **Tests.**
  - 13 new serialization tests in `EventSerializationTest` covering round-trip, role/subtype validation, empty-delta rejection, nullable chunk fields, raw-event passthrough, and discriminator routing for all seven new events.
  - 4 new apply-handler tests in `DefaultApplyEventsTest` covering a single-stream lifecycle, two interleaved concurrent streams, encrypted-value attachment, and chunk-style auto-population.

### Deprecated
- All five `THINKING_*` events and the matching `EventType` enum entries are marked `@Deprecated(WARNING)` with `ReplaceWith` hints pointing at the corresponding `REASONING_*` types. They remain on the wire and continue to flow through `DefaultApplyEvents` and `EventVerifier` unchanged. Slated for removal in 1.0.0.
  - `ThinkingStartEvent` → `ReasoningStartEvent`
  - `ThinkingEndEvent` → `ReasoningEndEvent`
  - `ThinkingTextMessageStartEvent` → `ReasoningMessageStartEvent`
  - `ThinkingTextMessageContentEvent` → `ReasoningMessageContentEvent`
  - `ThinkingTextMessageEndEvent` → `ReasoningMessageEndEvent`
- `ThinkingTelemetryState` and `AgentState.thinking` / `AbstractAgent.thinking` are deprecated in favour of `ReasoningTelemetryState` and `reasoning`. The old fields are still populated by the existing `THINKING_*` apply handlers so downstream consumers continue to work unchanged.

### Notes for integrators
- **Wire compatibility is unchanged.** Servers emitting `THINKING_*` continue to round-trip exactly as before; servers emitting `REASONING_*` are now decodable.
- **No `EventVerifier` changes.** The verifier passes `REASONING_*` events through unchanged, matching the TypeScript SDK. Existing `THINKING_*` lifecycle validation is unchanged.
- **`Role` enum is unchanged.** `ReasoningMessageStartEvent.role` is modeled as a constrained `String` rather than a new `Role.REASONING` value, to avoid introducing a ghost role with no matching `Message` subclass (and to match the TS/Python literal-string schemas exactly).

## [0.3.0] - 2026-05-09

### Added
- `StatefulAgUiAgent` records `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` and `TOOL_CALL_RESULT` events into per-thread conversation history. The next run's `RunAgentInput.messages` now carries assistant tool calls and matching tool results, which servers (e.g. `ag_ui_adk`) need to pair pending-tool-call bookkeeping across turns.

### Changed
- Upgrade Ktor from 3.1.3 to 3.2.4 (latest compatible with Kotlin 2.1.x)
- `ToolExecutionManager` silently skips tools that are not in the local registry instead of emitting an `Error: Tool 'X' is not available` `ToolMessage`. Lets server- or middleware-injected tool specs (e.g. the `@ag-ui/a2ui-middleware` `render_a2ui` tool, when not registered locally) flow through without poisoning history.

### Fixed
- Repair chatapp-swiftui XCFramework build: remove stale composite-build substitution for deleted kotlin-a2ui module, add missing a2ui-4k catalog entry, and align kotlinx-datetime on the 0.7.1-0.6.x-compat artifact for iOS compatibility

### Examples
- Update a2ui-4k dependency from 0.8.0 to 0.8.1 in chatapp examples
- Remove unnecessary core library desugaring from chatapp-shared (minSdk is 26)
- Migrate chatapp to `a2ui-4k 0.9.3` to render A2UI v0.9 surfaces.
- `ChatController` handles two new `ActivitySnapshotEvent` content shapes alongside the existing v0.8 wrap: (a) a single v0.9 envelope (`content.version == "v0.9"`), and (b) an `a2ui_operations` array emitted by the `@ag-ui/a2ui-middleware` Node bridge.
- Register `render_a2ui` as a client-side tool via the new `RenderA2UiToolExecutor` adapter wrapping `com.contextable.a2ui4k.agent.A2UiRenderTool`. The executor drives the local `SurfaceStateManager` directly and closes the AG-UI tool-call round-trip locally, so the middleware no longer has to synthesise a `TOOL_CALL_RESULT`.
- Send A2UI action results inline in the next user message (filtered from the chat transcript) for parity with stacks that do not honour `forwardedProps`.

## [0.2.6] - 2026-01-14

### Changed
- Lower minimum Android SDK from 26 to 24
- Lower Kotlin version from 2.2.20 to 2.1.20
- Update Android Gradle Plugin from 8.10.1 to 8.12.0
- Fix artifact group ID references from `com.agui:` to `com.ag-ui.community:`

## [0.2.5] - 2025-12-29

### Added
- Agent subscriber system for opt-in lifecycle and event interception.
- Text message role fidelity in chunk transformation and state application.

### Changed
- Default apply pipeline now routes every event through subscribers before mutating state.
- State application respects developer/system/user roles when constructing streaming messages.

### Tests
- Expanded chunk transformation and state application coverage for role propagation and subscriber behavior.

### Performance Improvements
- Up to 2x faster compilation with K2 compiler
- Reduced memory usage in streaming scenarios
- Smaller binary sizes due to better optimization
- Improved coroutine performance with latest kotlinx.coroutines

## [0.1.0] - 2025-06-14

### Added
- Initial release of ag-ui-4k client library
- Core AG-UI protocol implementation for Kotlin Multiplatform
- HttpAgent client with SSE support for connecting to AG-UI agents
- Event-driven streaming architecture using Kotlin Flows
- Full type safety with sealed classes for events and messages
- Support for Android, iOS, and JVM platforms
- Comprehensive event types (lifecycle, messages, tools, state)
- State management with snapshots and deltas
- Tool integration for human-in-the-loop workflows
- Cancellation support through coroutines
- Built with Kotlin 2.1.21 and K2 compiler
- Powered by Ktor 3.1.3 for networking
- Uses kotlinx.serialization 1.8.1 for JSON handling
- Comprehensive documentation and examples
- GitHub Actions CI/CD workflow
- Detekt static code analysis