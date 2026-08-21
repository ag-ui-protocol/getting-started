---
name: agui-cross-sdk-parity
description: >
  Keep the AG-UI .NET SDK at feature and wire-format PARITY with the canonical
  reference SDKs (TypeScript is the source of truth; Python is types/encoder only).
  USE FOR: porting a feature/event/behavior that landed in the TS (or Python) SDK
  into .NET, verifying the .NET wire format (JSON, SSE, protobuf) matches the
  reference, locating where the reference implementation and compatibility fixtures
  live, mapping a TS concept to the .NET event/client/encoder model, resolving an
  upstream protocol fix (e.g. a Microsoft.Extensions.AI / Microsoft Agent Framework
  issue) that needs a .NET counterpart, deciding which .NET package owns a change.
  DO NOT USE FOR: the mechanics of writing a specific test (use agui-dotnet-unit-tests
  for serialization round-trips, agui-dotnet-integration-tests for cross-language /
  E2E harness mechanics, agui-dotnet-wire-types for JSON/proto type rules,
  agui-dotnet-transport for SSE/HTTP transport details). This skill is about the
  PARITY PROCESS and where the reference lives, not test authoring.
---

# AG-UI Cross-SDK Parity

The .NET SDK implements an upstream, multi-language protocol. This skill encodes the
**parity process**: which SDK is authoritative, where its reference and fixtures live,
how to map reference concepts onto the .NET model, and how parity is guarded.

## Parity Principle

- **TypeScript is canonical** for wire format AND client run-loop behavior. When two
  SDKs disagree, match TS.
- **Python is types + encoder only.** It has `core` (types/events) and an `encoder`,
  but **no client run-loop and no protobuf** (`sdks/python/ag_ui/` has `core/` and
  `encoder/` but no `client/` or `proto/`). Use it only as a secondary check on
  type/JSON shape — never for run-loop or proto questions.
- Upstream protocol or SDK fixes (in the TS client run-loop, or in
  Microsoft.Extensions.AI / Microsoft Agent Framework) sometimes need a .NET
  counterpart; treat the TypeScript change as the contract to match.

## Where the Reference Lives

| Concern | TypeScript reference (source of truth) | .NET package it maps to |
|---|---|---|
| Event & type definitions | `sdks/typescript/packages/core/src/events.ts`, `types.ts`, `event-factories.ts` | `sdks/dotnet/src/AGUI.Abstractions/Events/`, `Messages/` |
| Client run-loop / transport | `sdks/typescript/packages/client/src/run/`, `apply/`, `agent/`, `transform/` | `sdks/dotnet/src/AGUI.Client/` (`AGUIChatClient.cs`, `AGUIHttpTransport.cs`, `EventStreamConverter.cs`, `ToolCallBuilder.cs`) |
| SSE / JSON wire framing | `sdks/typescript/packages/encoder/src/encoder.ts` | `sdks/dotnet/src/AGUI.Formatting/`, `AGUI.Abstractions/Serialization/` |
| Protobuf wire format | `sdks/typescript/packages/proto/src/proto/events.proto`, `types.proto`, `patch.proto` | `sdks/dotnet/src/AGUI.Protobuf/` (`ProtoEventMapper.cs`, `ProtoMessageMapper.cs`) |

The `src/` packages are **AGUI.Abstractions, AGUI.Formatting, AGUI.Protobuf, AGUI.Client,
AGUI.Server**; `sdks/dotnet/AGENTS.md` and `docs/architecture.md` are the canonical
description of the layout and conventions.

## Porting Workflow

1. **Locate the feature in TS.** Find the change in `packages/core` (a new event/type),
   `packages/client` (run-loop / event-application behavior), or
   `packages/proto`+`encoder` (wire framing). Read the TS implementation and its tests
   to capture the exact contract — field names, ordering, optionality, coalescing rules.
2. **Identify the wire contract.** Determine the JSON shape, the proto schema impact
   (if any), and whether client run-loop state changes. Cross-check the JSON property
   names against `packages/core/src/events.ts`.
3. **Map to the .NET model and the right package** (table above). Events/types →
   `AGUI.Abstractions`; run-loop → `AGUI.Client`; SSE/JSON framing → `AGUI.Formatting`;
   protobuf → `AGUI.Protobuf`. Follow the .NET conventions in `AGENTS.md` (one class
   per file, `sealed`, source-generated JSON context, `PublicAPI.Unshipped.txt`).
4. **Implement** the .NET change. For a new event, follow the "Adding a new event type"
   checklist in `AGENTS.md` (class in `Events/`, `AGUIEventTypes` constant,
   `[JsonSerializable]`, `BaseEventJsonConverter` case, PublicAPI entry).
5. **Add parity assets** (see next section): a TS-produced JSON fixture under
   `tests/AGUI.Abstractions.UnitTests/Compatibility/` and/or a cross-language test in
   `tests/CrossLanguage.Vitest/tests/`.
6. **Verify byte/semantic parity** — run the compatibility and cross-language tests.
7. **Update docs.** Refresh `sdks/dotnet/AGENTS.md`, `docs/architecture.md`, and
   `docs/cross-language-testing.md` if the change alters the model, package layout, or the
   set of wire-supported events.

## How Parity Is Guarded

Four independent layers catch drift; add to whichever layer the change touches.

- **Compatibility fixtures (catch JSON drift).**
  `tests/AGUI.Abstractions.UnitTests/Compatibility/` holds TS-produced JSON fixtures
  (`*-events.json`) loaded via `FixtureLoader` and deserialized into .NET types
  (`{Category}CompatibilityTest.cs`, e.g. `RunEventsCompatibilityTest`,
  `ToolCallEventsCompatibilityTest`). A new/changed event shape needs a fixture entry.
- **Cross-language tests (catch end-to-end drift).** The harness in
  `tests/CrossLanguage.TestServer/` (C# server) and `tests/CrossLanguage.Vitest/`
  (TS client driving it) proves real interop — see `sdks/dotnet/docs/cross-language-testing.md`.
  Scenario specs live in `tests/CrossLanguage.Vitest/tests/` (e.g.
  `parallel-tool-calls.test.ts`, `state-events.test.ts`, `protobuf-parity.test.ts`).
- **Protobuf byte-parity tests.** `protobuf-parity.test.ts` plus
  `tests/AGUI.Protobuf.UnitTests/` verify the binary encoding matches the TS proto output.
- **Shared cross-language fixtures (catch three-way drift).** `sdks/fixtures/` holds
  language-neutral JSON that more than one SDK is held to, so an expectation is written down
  once instead of three times. `null-omission.json` is the first: TypeScript, Python and .NET
  each deserialize its `input` events, re-serialize through their own producer path, and
  assert the result equals `expected`. A wire rule that all three must agree on belongs here
  rather than in one SDK's test tree — see `sdks/fixtures/README.md`.

## Known Parity Boundary: Proto Is a Subset

The protobuf schema covers a **subset** of events by design. `.NET`-only events
(`Reasoning*`, `Activity*`, `ToolCallResult`) are not in the proto wire format and
**throw `NotSupportedException`** when mapped — see `ProtoEventMapper.cs` (the `default`
case lists the 16 supported events: RUN_STARTED/FINISHED/ERROR, STEP_STARTED/FINISHED,
TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, STATE_SNAPSHOT/DELTA,
MESSAGES_SNAPSHOT, RAW, CUSTOM) and `ProtoMessageMapper.cs`. This is a **deliberate,
documented boundary** — do not "fix" it by inventing proto messages that don't exist in
`events.proto`. JSON/SSE remains the full-fidelity wire; protobuf is the constrained one.

## Critical Anti-patterns

1. **Never treat .NET as the source of truth.** If the .NET behavior differs from TS,
   the .NET side is the candidate for change — confirm against `packages/core` /
   `packages/client` first.
2. **Never consult Python for run-loop or proto parity.** Python has neither. Use it
   only as a type/JSON cross-check.
3. **Never add a proto mapping for a `.NET`-only event** (`Reasoning*`, `Activity*`,
   `ToolCallResult`). The `NotSupportedException` is intentional.
4. **Never land a wire change without a parity asset.** A JSON-shape change needs a
   Compatibility fixture; an interop/behavioral change needs a cross-language test.

## Routing to Sibling Skills

This skill governs *what* to port and *where the reference is* — delegate test
mechanics:

- **agui-dotnet-unit-tests** — serialization round-trips and Compatibility fixture tests.
- **agui-dotnet-integration-tests** — cross-language / E2E harness (TestServer + Vitest).
- **agui-dotnet-wire-types** — JSON/proto type and serialization-context rules.
- **agui-dotnet-transport** — SSE / HTTP transport details.
