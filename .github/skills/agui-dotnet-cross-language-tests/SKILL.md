---
name: agui-dotnet-cross-language-tests
description: >
  Author cross-language interop tests that verify the AG-UI .NET SDK is
  wire-compatible with the TypeScript SDK — a Vitest TS client driving a C#
  CrossLanguage.TestServer over HTTP, both directions, including protobuf
  byte-parity against @ag-ui/proto. USE FOR: adding or modifying cross-language
  interop coverage, CrossLanguage.TestServer routes, the CrossLanguage.Vitest
  suite, protobuf wire parity tests, TS-client-to-C#-server or
  C#-client-to-TS-server scenarios. DO NOT USE FOR: .NET-only unit tests (use
  agui-dotnet-unit-tests), ASP.NET Core hosting integration tests (use
  agui-dotnet-integration-tests).
---

# AG-UI .NET Cross-Language Interop Tests

How to add tests proving the .NET AG-UI SDK interoperates with the TypeScript
SDK on the wire. The harness lives under `sdks/dotnet/tests/`. Read
`sdks/dotnet/docs/cross-language-testing.md` (design plus the "Harness reference"
section) for full background.

## Interop philosophy

- **The TypeScript SDK is the reference (oracle).** A round-trip through the TS
  codec — `proto.decode(proto.encode(event))` — is the canonical normalised form
  both SDKs must agree on. Assert .NET output against *that*, not against the raw
  fixture object.
- **Round-trip semantic equivalence is the real guarantee**, in both directions
  (TS→.NET and .NET→TS). Byte-for-byte parity is a stronger claim asserted only
  where deterministic.
- Tests exercise *our* code via project references (`AGUI.Abstractions`,
  `AGUI.Server`, `AGUI.Protobuf`), never the published NuGet packages.

## Harness architecture

Two directions, two server processes (see the "Harness reference" section of
`sdks/dotnet/docs/cross-language-testing.md`):

| Direction | Driver | Target server | Runner |
|---|---|---|---|
| TS → .NET (Phase 1) | TS `HttpAgent` (`@ag-ui/client`) | C# `CrossLanguage.TestServer` on :8091 | Vitest |
| .NET → TS (Phase 2) | C# `AGUIChatClient` | TS fake-agent server (`server/main.ts`) on :8092 | xUnit |

Phase 1 mechanism: Vitest `globalSetup`
(`CrossLanguage.Vitest/helpers/global-setup.ts`) starts LLMock
(`@copilotkit/aimock`, deterministic LLM responses), then
`helpers/dotnet-server.ts` runs `dotnet build` and spawns the produced
`CrossLanguage.TestServer.exe` (not `dotnet run` — single PID for clean Windows
teardown) with `OPENAI_BASE_URL` pointed at LLMock. It waits for the HTTP
listener, then test files `fetch` the routes. Both server and LLMock stay alive
across the whole run; `vitest.config.ts` sets `fileParallelism: false` so
concurrent SDK builds don't contend for artifact locks.

Phase 2 mechanism: `TsServerFixture` (`IAsyncLifetime`, shared via
`[Collection(nameof(TsServerCollection))]`) shells out `pnpm run server`
(`tsx server/main.ts`) which emits canned AG-UI events via `@ag-ui/encoder`;
`AGUIChatClient` consumes them.

## Adding a TS → .NET scenario (Phase 1)

1. **Add a server-side route** under `CrossLanguage.TestServer/` following the
   endpoint pattern (`MapPost` → `input.ToChatRequestContext(...)` →
   `GetStreamingResponseAsync` → `.AsAGUIEventStreamAsync(ctx)` →
   `TypedResults.ServerSentEvents(AgenticChatRoute.WrapAsSseItems(...))`). See
   `ParallelToolCallsRoute.cs`. For a route that must **negotiate the transport**
   (SSE *or* protobuf from the `Accept` header), end with
   `AGUIResults.Events(events, httpContext, cancellationToken)` instead and make
   sure `Program.cs` registers `ProtobufEventStreamFormatter` as an `IAGUIEventStreamFormatter` — see `AgenticChatRoute.cs`.
2. **Register it in `Program.cs`** (e.g. `app.MapParallelToolCalls("/parallel_tool_calls")`).
3. **Register any new payload types in `CrossLanguageJsonSerializerContext.cs`**
   (`[JsonSerializable(typeof(YourReport))]`). This context is snake_case to
   match the TS wire shape.
4. **Add an aimock fixture** in `fixtures/*.json` keyed by `userMessage` /
   `toolCallId` so LLM responses are deterministic (see
   `fixtures/parallel-tool-calls.json`).
5. **Add a `tests/<scenario>.test.ts`** that drives the route with `HttpAgent`
   and asserts on the collected event stream (see `parallel-tool-calls.test.ts`).

## Adding a .NET → TS scenario (Phase 2)

1. Add a fake agent (`(RunAgentInput) => BaseEvent[]`) in `server/fakeAgents.ts`.
2. Mount its route in `server/main.ts`.
3. Add a `*.cs` test in `AGUI.CrossLanguage.IntegrationTests/`, decorated
   `[Collection(nameof(TsServerCollection))]`, driving it with `AGUIChatClient`
   (see `AgenticChatTests.cs`).

## Protobuf wire-parity pattern

`ProtobufParityRoute.cs` exposes three codec routes backed by `AGUIProtobuf`:

| Route | In | Out | Backed by |
|---|---|---|---|
| `POST /protobuf/encode` | event JSON | raw proto bytes | `AGUIProtobuf.Encode` |
| `POST /protobuf/decode` | raw proto bytes | event JSON | `AGUIProtobuf.Decode` |
| `POST /protobuf/decode-framed` | 4-byte BE length-prefixed frames | event JSON array | `AGUIProtobuf.ReadFramedAsync` |

`tests/protobuf-parity.test.ts` proves parity against `@ag-ui/proto`
(`sdks/typescript/packages/proto/src/proto.ts`) and `@ag-ui/encoder` framing
(`sdks/typescript/packages/encoder/src/encoder.ts`). For each fixture
(`fixtures/protobuf-events.ts`):

- `tsBytes = proto.encode(event)`; `reference = proto.decode(tsBytes)`.
- **TS encode → .NET decode**: `expect(netDecode(tsBytes)).toEqual(reference)`.
- **.NET encode → TS decode**: `expect(proto.decode(netEncode(event))).toEqual(reference)`.
- **Byte parity** depends on the fixture's `byteParity` flag:
  - `"strict"` — scalar-only events (only string/number fields, serialised in
    field-number order): assert the TS and .NET bytes are byte-for-byte equal.
  - `"roundtrip"` — payloads mapping to `google.protobuf.Struct`
    (`map<string, Value>`): map-entry ordering is **not** canonical across
    encoders, so do NOT assert byte equality. Assert both byte streams decode
    (via the TS codec) to the same event instead.

A framing test concatenates `encoder.encodeProtobuf(event)` frames (4-byte BE
prefix) and posts them to `/protobuf/decode-framed` to exercise `ReadFramedAsync`.
When adding a new protobuf event, add a fixture with the correct `byteParity`
flag — scalar-only ⇒ `strict`, any object/array payload ⇒ `roundtrip`.

## Transport parity (parameterize scenarios over SSE + protobuf)

The codec-parity pattern above isolates the **codecs** — it never goes through the
TS `HttpAgent` or `Accept`-header negotiation. To prove the full **transport** path
(TS client negotiates a protocol → .NET server encodes it → TS client decodes it),
parameterize a scenario suite over both transports — the cross-language analogue of
the .NET integration tests' `TransportFormat {Json, Protobuf}` `[Theory]`.

`helpers/transport.ts` is the shared mechanism: `TRANSPORTS = ["sse", "protobuf"]`,
`TRANSPORT_MEDIA_TYPE`, and `createTransportAgent(config, transport)` which returns
an `HttpAgent` that requests the transport (it opts into protobuf via the public
`fetch` hook — the default agent hardcodes `Accept: text/event-stream` *after*
spreading `headers`, so a `headers` option can't override it) and captures the
response `Content-Type`. Drive the suite with `describe.each(TRANSPORTS)` and assert
`lastResponseContentType() === TRANSPORT_MEDIA_TYPE[transport]` plus the usual
decoded-event assertions — see `tests/agentic-chat.test.ts`.

```ts
describe.each(TRANSPORTS)("… [%s]", (transport) => {
  it("…", async () => {
    const { agent, lastResponseContentType } = createTransportAgent(
      { url: `${baseUrl()}/agentic_chat`, threadId: `t-${transport}` }, transport);
    agent.messages = [{ id: "u", role: "user", content: "Hi, I am duaa" }];
    const events: BaseEvent[] = [];
    await agent.runAgent({}, { onEvent: ({ event }) => events.push(event) });
    expect(lastResponseContentType()).toBe(TRANSPORT_MEDIA_TYPE[transport]);
    // …assert decoded events (identical regardless of transport)…
  });
});
```

The route under test must negotiate (`AGUIResults.Events`, with
`ProtobufEventStreamFormatter` registered as an `IAGUIEventStreamFormatter` in
`Program.cs`). `tests/agentic-chat.test.ts` and
`tests/state-events.test.ts` are parameterized this way today.

**Only parameterize protobuf-safe scenarios.** `ToolCallResult`, `Reasoning*`, and
`Activity*` events have **no message/oneof entry in the shared `events.proto`** (the
one schema referenced by *both* `@ag-ui/proto` and .NET `AGUI.Protobuf`), so *neither*
SDK can protobuf-encode them — the codec throwing `NotSupportedException` mirrors
the schema, it is not a .NET gap. A suite that emits any of those must stay SSE-only.
Adding protobuf support for them is an **upstream schema change** (extend the canonical
TS `events.proto`, regenerate both SDKs, add mappers) — see `agui-cross-sdk-parity`.

`AGUI_MEDIA_TYPE` (`@ag-ui/proto`) and `ProtobufEventStreamFormatter.ProtobufMediaType` are the identical
exact string, and `AGUIEventStreamResult` sets `Content-Type` to it with no charset
— the client's exact `===` content-type match depends on that.

## Running the suites

```sh
# TS → .NET + protobuf parity (builds + spawns the C# server automatically)
cd sdks/dotnet/tests/CrossLanguage.Vitest
pnpm test
pnpm exec vitest run tests/protobuf-parity.test.ts   # just the parity suite

# .NET → TS (shells out `pnpm run server`)
cd sdks/dotnet/tests/AGUI.CrossLanguage.IntegrationTests
dotnet test
```

`pnpm install` from the repo root once first. Requires .NET 10 SDK, Node at the
version in the repository's root `.node-version`, pnpm 10+.

## ❌ Critical anti-patterns

1. **Don't assert byte-equality for object/Struct payloads.** `google.protobuf.Struct`
   map ordering is non-canonical; byte parity is only valid for scalar-only
   (`"strict"`) fixtures. For object payloads, assert round-trip equivalence.
2. **Don't make the .NET fixture the oracle.** The TS codec is the reference —
   compare against `proto.decode(proto.encode(event))`, not the raw event object.
3. **Don't add a route without registering it in BOTH `Program.cs` AND
   `CrossLanguageJsonSerializerContext.cs`** (when it introduces new payload
   types) — the server won't map the route or will fail AOT-safe serialization.
4. **Don't depend on real LLM calls.** Phase 1 LLM responses come from aimock
   fixtures keyed by `userMessage`/`toolCallId`; add a fixture for every new
   prompt. Use fixed/deterministic tool outputs (see `ParallelToolCallsRoute`'s
   frozen clock).
5. **Don't use `dotnet run` to start the server in helpers, and don't assume
   parallel test files.** The harness spawns the built `.exe` for a single
   killable PID and runs files sequentially (`fileParallelism: false`) to avoid
   build-lock contention and Windows port orphans.
