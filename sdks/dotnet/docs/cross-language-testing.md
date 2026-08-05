# Cross-Language E2E Testing: .NET ↔ TypeScript Interop

## Goal

Verify that the C# server and C# client are **fully interoperable** with the TypeScript ecosystem in end-to-end scenarios — not just wire-format conformance, but the complete story: a user sends a message, the server talks to an LLM, transforms the response into AG-UI events, and the client produces the correct end result.

Concretely:
1. **C# server + TS client**: The existing dojo e2e tests (Playwright) that currently run against TS server backends should also run against the C# ASP.NET Core server — proving the C# server produces events that the TS client (CopilotKit React) can render correctly.
2. **TS server + C# client**: The same scenarios running against TS servers should be consumable by the C# `AGUIChatClient` — proving the C# client handles real-world TS server output correctly and produces the same end results.

The C# server's responses may differ slightly from TS server responses (different chunking, field ordering, optional fields), but must produce the **same end results** from the client's perspective.

## How the Existing E2E Tests Work

### The Stack

```
┌──────────────────────────────────────────────────────────────────┐
│  Playwright (browser)                                             │
│  └── CopilotKit React UI (TS client consuming AG-UI events)      │
│      └── HttpAgent → POST /agui → SSE events                     │
├──────────────────────────────────────────────────────────────────┤
│  AG-UI Server (e.g., server-starter, langgraph-typescript, etc.)  │
│  └── Calls upstream LLM API (OpenAI chat/completions)             │
├──────────────────────────────────────────────────────────────────┤
│  @copilotkit/aimock (LLMock on port 5555)                         │
│  └── Mocks OpenAI API with fixture-based responses                │
│      (e.g., "I am duaa" → "Hello duaa!")                          │
└──────────────────────────────────────────────────────────────────┘
```

### Key Components

- **LLMock** (`@copilotkit/aimock`): Runs on port 5555, intercepts calls to `OPENAI_BASE_URL`. Returns canned completions/tool-calls based on message content matching.
- **Fixtures** (`apps/dojo/e2e/fixtures/openai/*.json`): Define LLM responses per user message (e.g., "I am duaa" → text response, "background color to blue" → tool call).
- **Dojo app** (`apps/dojo/`): React app with CopilotKit that renders chat UI against multiple server backends.
- **Playwright specs** (`apps/dojo/e2e/tests/`): Assert UI behavior — messages appear, tools execute, state updates render.

### Existing .NET Coverage

There's already a `microsoftAgentFrameworkDotnetTests/` folder with a basic test:
```typescript
test("[MS Agent Framework .NET] Agentic Chat sends and receives a message", async ({ page }) => {
  await page.goto("/microsoft-agent-framework-dotnet/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi, I am duaa");
  await chat.assertAgentReplyVisible(/Hello/i);
});
```

This proves the pattern already works. We need to **expand it** to cover all the scenarios that other servers test.

## Recording Fixtures Against a Real LLM

The cross-language Vitest fixtures (`tests/CrossLanguage.Vitest/fixtures/*.json`) are
deterministic, but they can be **recorded from a real LLM** so we know the C# server is
compliant with actual model output — the same principle as the .NET integration tests.

### Topology

AIMock is the LLM stand-in; it sits between the C# server and the real model, not between
the client and the server:

```
Record:   TS Client ──AG-UI──► C# Server ──OpenAI──► AIMock (proxy + save) ──► real LLM
Replay:   TS Client ──AG-UI──► C# Server ──OpenAI──► AIMock (match fixture, no network)
```

The fixture captures the **LLM's OpenAI chat-completion response**, not the C# server's
AG-UI output. The client↔server AG-UI exchange is re-derived live and deterministically on
every replay run, so replay still exercises the real C# mapping each time — only the LLM is
frozen.

### How it works

`helpers/llmock.ts` exposes a `record` option that calls AIMock's `enableRecording`. When a
request has no matching fixture, AIMock proxies it to the configured upstream, saves the
collapsed response under `fixtures/recorded/` (gitignored), and relays it back. Because the
C# server speaks plain OpenAI to AIMock (`POST /v1/chat/completions`), AIMock joins the
upstream base with the path — so pointing the upstream at Azure's OpenAI **v1** surface
(`https://<resource>.cognitiveservices.azure.com/openai`) yields
`.../openai/v1/chat/completions`. Auth is forwarded verbatim: the C# server presents the
`OPENAI_API_KEY` as a bearer token, so an Entra ID (AAD) token works against Azure.

`helpers/record-config.ts` resolves recording from the environment (see below) and mints an
AAD token via `az account get-access-token` when `OPENAI_API_KEY` isn't supplied.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AIMOCK_RECORD=true` | Enable recording (proxy unmatched calls). |
| `AZURE_OPENAI_ENDPOINT` | Azure resource endpoint; upstream becomes `<endpoint>/openai`. |
| `AIMOCK_RECORD_UPSTREAM` | Explicit upstream base (overrides the Azure derivation). |
| `OPENAI_CHAT_MODEL_ID` | Model / Azure deployment (default `gpt-5-mini` in record mode). |
| `OPENAI_API_KEY` | Explicit key/token; otherwise an AAD token is minted via `az`. |

### Workflow (PowerShell)

```powershell
cd sdks/dotnet/tests/CrossLanguage.Vitest
$env:AIMOCK_RECORD = "true"
$env:AZURE_OPENAI_ENDPOINT = "https://<resource>.cognitiveservices.azure.com"
$env:OPENAI_CHAT_MODEL_ID = "gpt-5-mini"
# az login first; an AAD token is minted automatically.
npx vitest run tests/<scenario>.test.ts
```

Recording **fills gaps**: committed fixtures are still loaded first, so delete a committed
fixture (or omit it) to force its scenario to re-record. Captured files land in
`fixtures/recorded/` for you to curate into the named `fixtures/*.json`.

### Multi-turn scenarios: match the tool-result turn, not the user message

After a tool call the client replays the **same conversation** with the tool result
appended — the last *user* message is unchanged. So a turn-2 fixture matched on
`userMessage` would re-match the turn-1 fixture and loop. The fix is to match the
**tool-result turn**:

- Programmatically: `predicate: (req) => req.messages.at(-1)?.role === "tool"`.
- In JSON fixtures (our case, since `predicate` is a function), any of:
  - **`toolCallId`** — exact match on `tool_call_id` of the request's **last message**,
    which must itself be `role: "tool"`. A tool result buried earlier in the
    conversation does *not* qualify: aimock 1.16.4 tightened this from "the most
    recent `role: "tool"` message anywhere in history", because the loose form let a
    `toolCallId` fixture shadow `userMessage` matchers on fresh user turns.
  - **`hasToolResult: true | false`** — the simplest two-leg discriminator, scoped to
    the *current* turn (the messages after the last `user` message) since 1.37.3. Prefer
    this over `toolCallId` when you only need "has a tool result come back yet?", because
    it does not hard-code a recorded id that changes when you re-record.
  - **`toolResultContains: "<substring>"`** — for legs that share a `tool_call_id` and
    differ only in the tool-result payload.

List the specific tool-result fixture **first** so it wins on turn 2; turn 1 (no tool
message) falls through to the `userMessage` fixture. This is turn-count-independent — no
`sequenceIndex` needed. The committed `mixed-tool-invocation.json` uses exactly this shape:

```jsonc
{
  "fixtures": [
    // Turn 2: the continuation's last tool result is get_weather's (resolved server-side
    // via FICC), so match its call id and return the final text.
    { "match": { "toolCallId": "call_XHrYFpdLMi6841ix1cwXZyy6" },
      "response": { "content": "Your current city is Tokyo, Japan. ... Berlin ..." } },
    // Turn 1: first request, no tool result yet — surface both tool calls.
    { "match": { "userMessage": "What is my current city and the forecast for Berlin?" },
      "response": { "toolCalls": [ /* get_user_location, get_weather */ ] } }
  ]
}
```

#### Capturing both turns from the LLM

**One record pass captures every turn.** `buildFixtureMatch` stamps `userMessage`,
`model`, `turnIndex` (count of `assistant` messages) and `hasToolResult` onto each
capture, and registers it in the live fixture pool. Turn 2 therefore does not match
turn 1's capture — they differ on `hasToolResult`, which is a hard reject gate — so the
request misses, proxies upstream, and is recorded. Both turns land in `fixtures/recorded/`.

The two-pass `sequenceIndex` dance this section used to describe was only necessary
before aimock 1.19.3, when a capture was keyed on `userMessage` alone and turn 1 shadowed
turn 2.

**When curating a capture into a committed fixture, decide about the extra match keys
rather than pasting them verbatim:**

- **Strip `model`** unless you mean it. Recording defaults to `gpt-5-mini`
  (`helpers/record-config.ts`) while replay defaults to `gpt-4o`
  (`helpers/dotnet-server.ts`), so a captured `"model": "gpt-5-mini"` will never match on
  replay — the fixture silently misses and you get a 404 with no obvious cause.
- **Strip `turnIndex`** unless you want depth-based selection. Every fixture in this repo
  currently omits it, and `selectByTurnIndex` only reorders candidates when at least one
  carries it — so the "first registered match wins" ordering that several fixture files
  depend on holds *because* nothing sets it. Introducing one changes that.
- **Keep `hasToolResult`** if the scenario has a tool-result leg; it is more durable than
  pinning a recorded `toolCallId`.

After curating, clear `OPENAI_API_KEY`/`AIMOCK_RECORD` and re-run to confirm the scenario
replays offline and green.

> **Recording against a reasoning model:** `RecordConfig` defaults both
> `upstreamTimeoutMs` and `bodyTimeoutMs` to 30s. Token-emission gaps during a reasoning
> model's thinking phase can exceed that. When it fires the capture is **dropped
> entirely** — no fixture is written — and aimock logs `Proxy request failed: Upstream
> response timed out after 30s` at error level, with the client seeing a 502 or a
> destroyed stream. Lift `bodyTimeoutMs` if you hit it.

## Approach

### Scenario A: Expand Dojo E2E Tests for C# Server

The C# server (`AGUIDojoServer` or a new variant) backs the same dojo routes that the `server-starter-all-features` tests exercise. We reuse the **same Playwright specs** with the C# backend.

**What we need:**
1. A C# server that handles the same features as `server-starter-all-features`:
   - Agentic chat (text streaming)
   - Backend tool calls
   - Frontend/client tool calls (human-in-the-loop)
   - Shared state (state snapshot + delta)
   - Custom events
   - Reasoning/thinking events

2. The C# server uses `Microsoft.Extensions.AI` `IChatClient` to call the LLM — pointed at LLMock (`http://localhost:5555/v1`) instead of real OpenAI.

3. The C# server is already registered as a dojo route (`/microsoft-agent-framework-dotnet/feature/{feature}`) — Playwright navigates to it directly.

4. Expand the Playwright specs for the `.NET` backend to cover all the same scenarios as `serverStarterAllFeaturesTests`.

**Implementation path:**
- The existing `samples/AGUIClientServer/AGUIDojoServer/` already has tool calls, state management, etc.
- It's already wired into the dojo app and started via `run-dojo-everything.js` on port 8016
- Ensure `OPENAI_BASE_URL=http://localhost:5555/v1` is set so LLMock handles the AI responses
- Expand the `microsoftAgentFrameworkDotnetTests` specs to match `serverStarterAllFeaturesTests` coverage

### Scenario B: C# Client Against TS Servers

Same approach as above but reversed. We run the TS `server-starter` as a real process backed by LLMock (exactly as the dojo e2e tests do), and connect with the C# `AGUIChatClient`.

The C# test project:
1. Starts LLMock (port 5555) — same as dojo's `aimock-setup.ts`
2. Starts the TS server-starter (port 5100) — pointed at LLMock via `OPENAI_BASE_URL`
3. Connects with `AGUIChatClient` to `http://localhost:5100/agui`
4. Sends the same messages the Playwright tests send
5. Asserts the `AGUIChatClient` receives correct `ChatResponseUpdate` output (same messages, same tool calls, same content)

```
┌──────────────────────────────────────────────────────────────────┐
│  C# Integration Test (xUnit)                                      │
│  └── AGUIChatClient → POST http://localhost:5100/agui → SSE      │
├──────────────────────────────────────────────────────────────────┤
│  TS AG-UI Server (server-starter, real process on port 5100)      │
│  └── Calls http://localhost:5555/v1/chat/completions (LLMock)    │
├──────────────────────────────────────────────────────────────────┤
│  @copilotkit/aimock (LLMock, real process on port 5555)           │
│  └── Returns canned responses from fixtures/openai/*.json         │
└──────────────────────────────────────────────────────────────────┘
```

## Detailed Design

### Directory Structure

```
sdks/dotnet/tests/
├── AGUI.CrossLanguage.IntegrationTests/    # C# client → TS server tests
│   ├── AGUI.CrossLanguage.IntegrationTests.csproj
│   ├── TsServerFixture.cs                  # Manages LLMock + TS server processes
│   ├── AgenticChatTests.cs                 # Chat scenarios
│   ├── ToolCallScenarioTests.cs            # Backend/frontend tool scenarios
│   ├── BackendToolRenderingTests.cs        # Backend tool rendering
│   ├── HumanInTheLoopTests.cs              # Approval / resume scenarios
│   ├── StateEventsTests.cs                 # Shared state scenarios
│   ├── ActivitySnapshotTests.cs            # Activity events
│   ├── PassthroughEventTests.cs            # Custom/raw event passthrough
│   └── ReasoningTests.cs                   # Reasoning/thinking scenarios
└── CrossLanguage.Vitest/                   # Vitest: TS client → C# server tests
    ├── package.json
    ├── vitest.config.ts
    ├── helpers/
    │   ├── dotnet-server.ts                # Start/stop C# server process
    │   ├── step-server.ts                  # Start/stop a GettingStarted step server
    │   ├── global-setup.ts                 # Vitest global setup
    │   ├── record-config.ts                # Resolve record mode from the environment
    │   ├── transport.ts                    # SSE/protobuf transport parameterization
    │   └── llmock.ts                       # Start/stop LLMock with fixtures
    ├── server/
    │   ├── main.ts                         # Test server entry point
    │   └── fakeAgents.ts                   # Deterministic fake agents
    └── tests/
        ├── agentic-chat.test.ts            # TS HttpAgent → C# server (per SSE + protobuf)
        ├── backend-tool.test.ts
        ├── frontend-tools.test.ts
        ├── human-in-the-loop.test.ts
        ├── mixed-tool-invocation.test.ts
        ├── parallel-tool-calls.test.ts
        ├── protobuf-parity.test.ts
        └── state-events.test.ts            # per SSE + protobuf
```

### Part 1: TS Client → C# Server (Vitest)

These tests use the TS `HttpAgent` (from `@ag-ui/client`) against the real C# server, with LLMock providing the upstream LLM responses.

```typescript
// tests/agentic-chat.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, BaseEvent, RunAgentInput } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";
import { startDotnetServer, stopDotnetServer } from "../helpers/dotnet-server";
import { startLLMock, stopLLMock } from "../helpers/llmock";

describe("TS HttpAgent → C# server (with LLMock)", () => {
  let serverPort: number;

  beforeAll(async () => {
    await startLLMock();      // Port 5555, loads agentic-chat.json fixtures
    serverPort = await startDotnetServer(); // Points OPENAI_BASE_URL at LLMock
  }, 60_000);

  afterAll(async () => {
    await stopDotnetServer();
    await stopLLMock();
  });

  it("receives text response for simple chat", async () => {
    const agent = new HttpAgent({ url: `http://localhost:${serverPort}/agui` });
    const input: RunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "Hi, I am duaa" }],
      tools: [],
      context: [],
    };

    const events = await firstValueFrom(agent.run(input).pipe(toArray()));
    
    // Verify the lifecycle events are present
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    
    // Verify text content includes expected response
    const textEvents = events.filter(e => e.type === EventType.TEXT_MESSAGE_CONTENT);
    const fullText = textEvents.map(e => (e as any).delta).join("");
    expect(fullText).toMatch(/Hello.*duaa/i);
  });

  it("executes backend tool call", async () => {
    const agent = new HttpAgent({ url: `http://localhost:${serverPort}/agui` });
    const input: RunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "stock price of AAPL" }],
      tools: [],
      context: [],
    };

    const events = await firstValueFrom(agent.run(input).pipe(toArray()));
    
    const textEvents = events.filter(e => e.type === EventType.TEXT_MESSAGE_CONTENT);
    const fullText = textEvents.map(e => (e as any).delta).join("");
    expect(fullText).toContain("150.25");
  });
});
```

### Part 2: C# Client → TS Server (xUnit)

These tests use the real TS `server-starter` and LLMock as external processes (same as how dojo e2e works), and `AGUIChatClient` as the consumer.

```csharp
// AgenticChatTest.cs
public class AgenticChatTest : IClassFixture<TsServerFixture>
{
    private readonly TsServerFixture _fixture;

    public AgenticChatTest(TsServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ReceivesTextResponse_ForSimpleChat()
    {
        var client = new AGUIChatClient(new(_fixture.HttpClient, _fixture.AguiUrl));

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "Hi, I am duaa"),
        };

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(messages)
            .ConfigureAwait(false))
        {
            updates.Add(update);
        }

        var fullText = string.Join("", updates
            .Where(u => u.Text != null)
            .Select(u => u.Text));
        
        Assert.Matches("Hello.*duaa", fullText);
    }

    [Fact]
    public async Task ReceivesToolCall_ForBackendTool()
    {
        var client = new AGUIChatClient(new(_fixture.HttpClient, _fixture.AguiUrl));

        var messages = new List<ChatMessage>
        {
            new(ChatRole.User, "stock price of AAPL"),
        };

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in client.GetStreamingResponseAsync(messages)
            .ConfigureAwait(false))
        {
            updates.Add(update);
        }

        var fullText = string.Join("", updates
            .Where(u => u.Text != null)
            .Select(u => u.Text));
        
        Assert.Contains("150.25", fullText);
    }
}
```

```csharp
// TsServerFixture.cs — manages LLMock + TS server as real processes
public class TsServerFixture : IAsyncLifetime
{
    private Process? _llmockProcess;
    private Process? _tsServerProcess;
    public HttpClient HttpClient { get; private set; } = null!;
    public string AguiUrl => "http://localhost:5100/agui";

    public async Task InitializeAsync()
    {
        // Start LLMock on port 5555 (same as dojo e2e aimock-setup.ts)
        _llmockProcess = Process.Start(new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "llmock-server.mjs",
            WorkingDirectory = GetScriptsPath(),
            Environment = { ["PORT"] = "5555" },
        });
        await WaitForHealthy("http://localhost:5555/v1/models");

        // Start TS server-starter on port 5100 (pointed at LLMock)
        _tsServerProcess = Process.Start(new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "ts-server.mjs",
            WorkingDirectory = GetScriptsPath(),
            Environment =
            {
                ["PORT"] = "5100",
                ["OPENAI_BASE_URL"] = "http://localhost:5555/v1",
                ["OPENAI_API_KEY"] = "mock-key",
            },
        });
        await WaitForHealthy("http://localhost:5100/health");

        HttpClient = new HttpClient();
    }

    public Task DisposeAsync()
    {
        _tsServerProcess?.Kill();
        _llmockProcess?.Kill();
        HttpClient?.Dispose();
        return Task.CompletedTask;
    }

    private static async Task WaitForHealthy(string url, int timeoutSeconds = 30)
    {
        using var http = new HttpClient();
        for (int i = 0; i < timeoutSeconds; i++)
        {
            try
            {
                var response = await http.GetAsync(url).ConfigureAwait(false);
                if (response.IsSuccessStatusCode) return;
            }
            catch { }
            await Task.Delay(1000).ConfigureAwait(false);
        }
        throw new TimeoutException($"Server at {url} did not become healthy");
    }
}
```

### Part 3: C# Server in the Dojo Framework

The C# server (`AGUIDojoServer`) is **already integrated** into the dojo framework:
- `apps/dojo/scripts/run-dojo-everything.js` starts it: `dotnet run --project AGUIDojoServer.csproj --urls "http://localhost:8016"`
- `apps/dojo/src/agents.ts` maps routes: `agentic_chat`, `shared_state`, `human_in_the_loop`, `backend_tool_rendering`, `predictive_state_updates`, `subgraphs`, etc.
- Route prefix: `/microsoft-agent-framework-dotnet/feature/{feature}`

What needs to happen:
1. **Ensure `OPENAI_BASE_URL`** is set to `http://localhost:5555/v1` when running under dojo-everything (LLMock)
2. **Verify the C# server uses `OpenAIChatClient`** from `Microsoft.Extensions.AI.OpenAI` (which respects the base URL override)
3. **Reuse existing aimock fixtures** (`agentic-chat.json`, `shared-state.json`, `human-in-the-loop.json`) — the C# server calls the same OpenAI API shape
4. **Expand Playwright specs** in `microsoftAgentFrameworkDotnetTests/` to cover all scenarios

## Test Scenarios

| Scenario | TS Client → C# Server | C# Client → TS Server |
|---|---|---|
| Simple text chat ("Hi, I am duaa") | ✅ Verify text events stream correctly | ✅ Verify `ChatResponseUpdate.Text` |
| Multi-turn conversation | ✅ Context preserved across turns | ✅ Messages array forwarded |
| Backend tool call (stock price) | ✅ Tool call + result events emitted | ✅ Tool results in response |
| Frontend tool call (change_background) | ✅ Client-side tool invoked | ✅ Tool call detected, result sent back |
| Shared state (recipe) | ✅ STATE_SNAPSHOT + STATE_DELTA events | ✅ State updates received |
| Human-in-the-loop (approval) | ✅ Interrupt event → approval → resume | ✅ Interrupt handled programmatically |
| Reasoning/thinking | ✅ Reasoning events before text | ✅ Reasoning content received |
| Custom events | ✅ Passed through to client | ✅ Custom event deserialized |

## What This Validates (E2E, not just wire format)

- The C# server **transforms LLM completions into AG-UI events** identically enough that the TS client renders the same UI
- The C# client **interprets AG-UI events from TS servers** correctly and surfaces the same information
- **LLM tool-calling round trips** work across language boundaries (client registers tools → server invokes them → results flow back)
- **State management** (snapshot + JSON Patch deltas) is compatible across implementations
- **Interrupt/resume flows** work when server and client are different languages
- **Chunked streaming** doesn't break across implementations (different buffering behavior is OK as long as the final result is the same)

## Implementation Plan

### Phase 1: TS Client → C# Server (Vitest, headless)

This is the simpler direction — no browser needed, just `HttpAgent` + raw event assertions.

1. Create `sdks/dotnet/tests/CrossLanguage.Vitest/` Node project
2. Add `@ag-ui/client`, `@ag-ui/core`, `@copilotkit/aimock` as dependencies
3. Write `helpers/dotnet-server.ts` (start C# server as child process with `OPENAI_BASE_URL=http://localhost:5555/v1`)
4. Write `helpers/llmock.ts` (start LLMock with existing fixtures from `apps/dojo/e2e/fixtures/openai/`)
5. Write Vitest tests that use `HttpAgent` against the C# server
6. Verify events match expectations (types, content, tool calls)

### Phase 2: C# Client → TS Server (xUnit)

1. Create `sdks/dotnet/tests/AGUI.CrossLanguage.IntegrationTests/` project
2. Write `TsServerFixture.cs` (manages LLMock + TS server child processes)
3. Write test classes per scenario using `AGUIChatClient`
4. Build a small Node script that bundles LLMock + server-starter into a single launchable process
5. Verify `ChatResponseUpdate` output matches expectations

### Phase 3: Expand Dojo E2E (Playwright, browser)

The C# server is **already registered** in the dojo framework (`run-dojo-everything.js` starts it on port 8016, `agents.ts` maps all routes). What's needed:

1. Ensure the C# server uses `OPENAI_BASE_URL=http://localhost:5555/v1` so LLMock handles its AI calls
2. Expand `microsoftAgentFrameworkDotnetTests/` Playwright specs to cover all features (`shared_state`, `human_in_the_loop`, `backend_tool_rendering`, `predictive_state_updates`, etc.)
3. The specs should be identical to `serverStarterAllFeaturesTests/` — same user interactions, same expected UI results
4. If the C# server produces the same UI rendering as the TS server-starter, interop is proven end-to-end

### Phase 4: CI

1. Add GitHub Actions job for Phase 1 (Vitest, needs .NET SDK + Node)
2. Add GitHub Actions job for Phase 2 (xUnit, needs .NET SDK + Node)
3. Phase 3 runs as part of existing dojo e2e CI (just adds another backend)

## Key Decisions

| Decision | Rationale |
|---|---|
| Use `@copilotkit/aimock` (LLMock) | Same mock infrastructure as all other dojo tests; tests real LLM→AG-UI transformation, not just wire format |
| Reuse existing fixtures (`apps/dojo/e2e/fixtures/openai/`) | Same prompts/responses as existing tests; if TS server passes, C# server should produce same end result |
| Phase 1 (Vitest) before Phase 3 (Playwright) | Headless HTTP-level tests are faster to write and debug; Playwright adds browser/React complexity |
| All servers run as real processes | Real TCP, real serialization, real SSE framing — same as how dojo runs all backends; no in-process test hosts |
| `AGUIChatClient` as the C# client abstraction | This is the `IChatClient` implementation that maps AG-UI events to `ChatResponseUpdate` — the idiomatic .NET consumer |
| All new code in `sdks/dotnet/tests/` | .NET team owns the cross-language validation; no changes needed to `sdks/typescript/` or `apps/dojo/` for Phases 1-2 |

## Dependencies

- `@ag-ui/client` and `@ag-ui/core` — consumed as npm packages (workspace link or published version)
- `@copilotkit/aimock` — LLMock server
- `dotnet` CLI — to build and run C# server/client
- The C# server must support `OPENAI_BASE_URL` environment variable to point at LLMock
- Node.js 20+ for running LLMock and TS server

## Success Criteria

1. TS `HttpAgent` can consume all scenarios from the C# server and receives correct events
2. C# `AGUIChatClient` can consume all scenarios from the TS server and produces correct `ChatResponseUpdate` output
3. Both directions pass with the **same LLMock fixtures** — proving the servers are functionally equivalent from the client's perspective
4. Tests run in CI on every PR that touches `sdks/dotnet/`
5. Any behavioral regression (not just wire format) is caught before merge

---

## Harness reference (as implemented)

This section describes the harness as it exists today under `sdks/dotnet/tests/` and how to run and extend it.

### Layout

| Path | What it is |
|---|---|
| `tests/CrossLanguage.TestServer/` | Minimal C# AG-UI server that consumes `OPENAI_BASE_URL`. Built on the local `AGUI.Abstractions` + `AGUI.Server` + `AGUI.Protobuf` + `AGUI.Samples.Shared` project references — exercises *our* code, not the published NuGet packages. Hosts `/agentic_chat` and `/backend_tool_rendering`. |
| `tests/CrossLanguage.Vitest/` | Phase 1: TypeScript `HttpAgent` (from `@ag-ui/client`) drives the C# server above. LLMock (`@copilotkit/aimock`) supplies the upstream LLM responses. The `server/` subdirectory also contains a fake-agent TS HTTP server used by Phase 2. |
| `tests/AGUI.CrossLanguage.IntegrationTests/` | Phase 2: C# `AGUIChatClient` drives the fake-agent TS server (`CrossLanguage.Vitest/server/main.ts`). The TS server emits canned AG-UI events via `@ag-ui/encoder`, mirroring the in-memory `class FooAgent extends AbstractAgent` pattern the TS SDK's own tests use. |

### Why two TS servers (LLMock-backed vs fake-agent)

The TS SDK ships no reference HTTP server — the only runnable AG-UI servers in the repo are integration packages (aws-strands, claude-agent-sdk, etc.). Rather than depend on an integration, the cross-language tests use two purpose-built servers:

- **Phase 1's "real" server is the C# one** (`CrossLanguage.TestServer`) — it makes actual OpenAI-shaped calls which LLMock answers from JSON fixtures. This verifies the C# server's LLM → AG-UI translation pipeline against the real TS client.
- **Phase 2's "real" server is the TS fake-agent** (`CrossLanguage.Vitest/server/main.ts`) — it skips the LLM entirely and emits canned AG-UI events directly via `@ag-ui/encoder`, just like every TS SDK test does with `class TestAgent extends AbstractAgent { run() { return of(...events); } }`. This verifies the C# client correctly consumes real TS-encoded AG-UI events.

### Prerequisites

- .NET 10 SDK
- Node.js 20+ and pnpm 10+ (the repository's `packageManager`)
- `pnpm install` from the repository root (one-off)

### Running

#### Phase 1 (TS client → C# server) — Vitest

```sh
cd sdks/dotnet/tests/CrossLanguage.Vitest
pnpm test
```

`helpers/global-setup.ts` starts LLMock on :5556, builds and spawns `CrossLanguage.TestServer.exe` on :8091 with `OPENAI_BASE_URL=http://localhost:5556/v1`, waits for the HTTP listener, then runs the test files.

#### Phase 1b (protobuf wire compatibility) — Vitest

`tests/protobuf-parity.test.ts` proves the .NET `AGUIProtobuf` codec and the TypeScript `@ag-ui/proto` package are wire-compatible in BOTH directions, for a representative instance of each of the 16 supported events (`fixtures/protobuf-events.ts`). It reuses the same `CrossLanguage.TestServer` on :8091, which exposes three codec routes (`ProtobufParityRoute.cs`):

| Route | Body in | Body out | Backed by |
|---|---|---|---|
| `POST /protobuf/encode` | AG-UI event JSON | raw proto message bytes (`application/octet-stream`) | `AGUIProtobuf.Encode` |
| `POST /protobuf/decode` | raw proto message bytes | AG-UI event JSON | `AGUIProtobuf.Decode` |
| `POST /protobuf/decode-framed` | 4-byte BE length-prefixed frames | AG-UI event JSON array | `AGUIProtobuf.ReadFramedAsync` |

For each event the test asserts round-trip semantic equivalence — `proto.encode` (TS) → `/protobuf/decode` (.NET) and `/protobuf/encode` (.NET) → `proto.decode` (TS) both yield the TS canonical event. Strict byte parity is asserted only for scalar-field events; events with `google.protobuf.Struct` (object) payloads only require round-trip equivalence because protobuf `map<string, Value>` entry ordering is not canonical across encoders (the test logs whether the bytes matched). A framing test drives `@ag-ui/encoder`'s `encodeProtobuf` (4-byte BE prefix) through `/protobuf/decode-framed` to exercise `ReadFramedAsync`.

Run just this suite:

```sh
cd sdks/dotnet/tests/CrossLanguage.Vitest
pnpm exec vitest run tests/protobuf-parity.test.ts
```

The parity suite isolates the codecs (it never uses the `HttpAgent` or `Accept`
negotiation). `tests/agentic-chat.test.ts` and `tests/state-events.test.ts` complement
it by proving the full **transport** path: each is parameterized over both protocols via
`describe.each(TRANSPORTS)` (`helpers/transport.ts`) — `createTransportAgent` requests
SSE or protobuf (the server registers `ProtobufEventStreamFormatter` and serves it
via the negotiating `AGUIResults.Events` route), and each run asserts the response
media type
matches the requested transport and the decoded AG-UI events are identical. Only
protobuf-safe scenarios are parameterized over protobuf: `ToolCallResult`, `Reasoning*`,
and `Activity*` have no entry in the shared `events.proto`, so neither SDK can
protobuf-encode them (adding it is an upstream schema change).

#### Phase 2 (C# client → TS server) — xUnit

```sh
cd sdks/dotnet/tests/AGUI.CrossLanguage.IntegrationTests
dotnet test
```

`TsServerFixture` shells out `pnpm run server` (which runs `tsx server/main.ts` in the Vitest project) to start the fake-agent server on :8092, then drives it with `AGUIChatClient`.

#### Manually starting the TS fake-agent server

For ad-hoc debugging:

```sh
cd sdks/dotnet/tests/CrossLanguage.Vitest
pnpm run server          # listens on :8092
curl -X POST http://localhost:8092/agentic_chat \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"t","runId":"r","messages":[{"id":"u","role":"user","content":"Hi"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}'
```

### Adding a scenario

**Phase 1** (more code per scenario, but full LLM pipeline):
1. Add a fixture in `CrossLanguage.Vitest/fixtures/` matched by `userMessage` / `toolName` / `predicate` (`@copilotkit/aimock` syntax).
2. If the scenario needs a new route or new server-side tool, add it to `CrossLanguage.TestServer/` and `Program.cs`.
3. Add a `*.test.ts` under `CrossLanguage.Vitest/tests/`.

**Phase 2** (no LLM, faster, deterministic):
1. Add a fake agent in `CrossLanguage.Vitest/server/fakeAgents.ts` (a function `(RunAgentInput) => BaseEvent[]`).
2. Mount the route in `CrossLanguage.Vitest/server/main.ts`.
3. Add a `*.cs` test file in `AGUI.CrossLanguage.IntegrationTests/`, decorated `[Collection(nameof(TsServerCollection))]`.

### Windows process cleanup

Both directions use a port-based fallback (`netstat -ano | taskkill /F /PID`) to clean up server processes that Node's `child.kill()` or .NET's `Process.Kill(entireProcessTree)` couldn't reach. Without this, an orphan server keeps the parent shell's stdout pipe alive and makes `dotnet test` / `pnpm test` appear to hang indefinitely after the tests have already passed.
