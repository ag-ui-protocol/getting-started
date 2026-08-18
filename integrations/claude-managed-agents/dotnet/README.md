# AGUI.ClaudeManagedAgents

Connect an [AG-UI](https://ag-ui.com) frontend to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), Anthropic's hosted agent runtime, from .NET. Each AG-UI thread maps to one managed session. Each run drives one turn of that session and streams the agent's events back as AG-UI events.

## Installation

The library targets `net10.0`, `net9.0`, and `net8.0`, and depends on the [`Anthropic`](https://www.nuget.org/packages/Anthropic) NuGet package (12.34.0 or later, which carries the Managed Agents surface), `AGUI.Abstractions`, and `AGUI.Formatting`.

```bash
dotnet add package AGUI.ClaudeManagedAgents
```

> **Not on NuGet yet.** The package is enrolled in this repository's release
> pipeline (release scope `integration-claude-managed-agents-dotnet`), so the
> command above works from the first release onwards. Until then, reference the
> project directly:

```xml
<ProjectReference Include="path/to/integrations/claude-managed-agents/dotnet/src/AGUI.ClaudeManagedAgents/AGUI.ClaudeManagedAgents.csproj" />
```

## Usage

Create a managed agent and an environment once (in the Console, or via the SDK), then map a route onto them in your ASP.NET Core app:

```csharp
using AGUI.ClaudeManagedAgents;

var app = WebApplication.CreateBuilder(args).Build();

var agent = new ManagedAgentsAgent(new ManagedAgentsAgentOptions
{
    ManagedAgentId = "agent_...",
    EnvironmentId = "env_...",
});

app.MapManagedAgentsAgent("/chat", agent);   // POST /chat streams AG-UI events over SSE
app.Run();
```

`MapManagedAgentsAgent` deserializes the posted AG-UI `RunAgentInput`, runs one turn, and writes the events as Server-Sent Events.

To drive a run yourself, call `agent.RunAsync(runAgentInput, cancellationToken)`. It returns an `IAsyncEnumerable<BaseEvent>` of AG-UI events you can format however your host needs. The package references the ASP.NET Core shared framework (`Microsoft.AspNetCore.App`) for the endpoint helper, so it targets ASP.NET Core apps.

The Anthropic client reads `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) from the environment. Set `AnthropicClient` to supply your own, or `Client` to swap the whole API surface.

## What it does

| Managed Agents | AG-UI |
| --- | --- |
| `agent.message` (with `event_delta` previews) | `TEXT_MESSAGE_START` / `CONTENT` / `END` |
| `agent.thinking` (with `event_start` previews) | `REASONING_START` / `REASONING_MESSAGE_START` / `REASONING_MESSAGE_END` / `REASONING_END` |
| `agent.thinking` (unpreviewed) | `REASONING_START` / `REASONING_END` |
| `agent.tool_use`, `agent.mcp_tool_use` + results | `TOOL_CALL_*` + `TOOL_CALL_RESULT` (server-executed, display only) |
| `agent.custom_tool_use` for a frontend tool | `TOOL_CALL_*`, then the run ends so the client can run the tool |
| `agent.custom_tool_use` for a backend tool | `TOOL_CALL_*` + `TOOL_CALL_RESULT`, and the handler's result is posted back |
| `session.error` (terminal) | `RUN_ERROR` with the error type as `code` |
| `session.status_idle` (`end_turn`) | `RUN_FINISHED` |

### Frontend tools (human-in-the-loop)

Tools passed in `RunAgentInput.Tools` are registered on the session as custom tools. When the agent calls one, the run emits the tool call and finishes, leaving the session parked. The client executes the tool and starts the next run with a `role: "tool"` message carrying `toolCallId`. The adapter forwards it into the session as the tool result and resumes streaming.

### Backend tools

Tools your server executes go in `BackendTools`:

```csharp
var options = new ManagedAgentsAgentOptions
{
    ManagedAgentId = agentId,
    EnvironmentId = environmentId,
    BackendTools =
    {
        new ManagedAgentsBackendTool
        {
            Name = "get_weather",
            Description = "Get the weather for a location.",
            Parameters = JsonSerializer.SerializeToElement(new
            {
                type = "object",
                properties = new { location = new { type = "string" } },
            }),
            Handler = input => Task.FromResult("{\"temperature\":21}"),
        },
    },
};
```

The tool call and its result stream to the UI, and the result is returned to the agent.

## Options

| Option | Default | |
| --- | --- | --- |
| `ManagedAgentId`, `EnvironmentId` | required | The managed agent and environment behind each session. |
| `AgentVersion` | latest | Pin an agent version. |
| `AnthropicClient` | `new AnthropicClient()` | Bring your own Anthropic SDK client. |
| `Client` | `AnthropicManagedAgentsClient` | Replace the Managed Agents API surface, for example in tests. |
| `SessionStore` | in-memory | Thread↔session mapping, keyed by `managedAgentId:threadId`. Provide your own to survive restarts. |
| `BackendTools` | `[]` | Server-executed custom tools. |
| `SessionTitle` | `AG-UI thread <id>` | Title for created sessions. |
| `VaultIds` | `[]` | Vault IDs (`vlt_...`) for stored credentials the agent may use, e.g. for MCP servers that authenticate. Applied at session creation. |
| `ToolConfirmation` | error | `ToolConfirmationPolicy.Allow`/`Deny` to answer built-in tools whose permission policy asks. |
| `TurnTimeout` | 5 minutes | Interrupt turns that run longer. |
| `StreamDeltas` | `true` | Request text and thinking previews for token streaming. |
| `OnError` | none | Notified when a best-effort operation fails. Returns a `Task` so an async handler is awaited rather than `async void`; its failure is absorbed. Bounded like any other best-effort call, so a handler that never completes cannot hold a run open. With no handler set, the cause goes to `Console.Error` instead — never to the client. |

## Security: authenticate and bind threads to callers

AG-UI thread IDs are supplied by the client and this agent keys thread↔session state by `managedAgentId:threadId`, so a thread ID is effectively a bearer identifier: **any caller who presents a thread ID resumes that thread's session.** The AG-UI protocol carries no user identity of its own, so authorization is your host's responsibility:

- Put the endpoint behind your own authentication. Never expose it unauthenticated.
- `RUN_ERROR` never relays the text of a failure this integration did not author. An SDK, session-store or API exception can carry session ids, request paths or credentials, so its message goes to `OnError` and the client gets a stable message plus the machine-readable `code`. Two things are deliberately still verbatim, because they are the point of the event: a `session.error` from the API (a structured field with its own `type` code, and the only account of why a session broke) and a backend tool's own exception message (your code, and what the agent needs to recover).
- In multi-tenant deployments, bind threads to the authenticated caller so one caller cannot resume another's session by guessing or replaying a thread ID. Do this with an `ISessionStore` whose keys include the caller identity derived from your auth layer (never from the request body):

The `threadKey` the agent passes in is already scoped to the managed agent; treat it as an opaque string and prefix it with the caller identity rather than parsing it:

```csharp
sealed class PerCallerStore(string ownerId, ConcurrentDictionary<string, ManagedAgentsSessionRecord> inner) : ISessionStore
{
    string Scoped(string threadKey) => $"{ownerId}|{threadKey}";
    public ValueTask<ManagedAgentsSessionRecord?> GetAsync(string threadKey, CancellationToken ct)
        => new(inner.TryGetValue(Scoped(threadKey), out var record) ? record : null);
    public ValueTask SetAsync(string threadKey, ManagedAgentsSessionRecord record, CancellationToken ct)
    { inner[Scoped(threadKey)] = record; return ValueTask.CompletedTask; }
    public ValueTask DeleteAsync(string threadKey, CancellationToken ct)
    { inner.TryRemove(Scoped(threadKey), out _); return ValueTask.CompletedTask; }
}
```

  Reuse ONE store instance per caller — construct it once and cache it:

```csharp
var shared = new ConcurrentDictionary<string, ManagedAgentsSessionRecord>();
var stores = new ConcurrentDictionary<string, PerCallerStore>();
PerCallerStore StoreFor(string ownerId) => stores.GetOrAdd(ownerId, id => new PerCallerStore(id, shared));
```

  Runs are serialized per thread within a store instance, so a fresh wrapper per request would let a double-submitted thread post into the same session twice. Cache the store (as above) and construct the agent with `StoreFor(ownerId)`.

## Notes

- The default session store is in-memory: restarting the process starts new sessions. Managed sessions themselves persist server-side.
- Turns are serial per thread. A second run on a busy thread errors.
- Built-in tools (bash, file editing, web) execute inside the managed environment. This adapter shows them for display, so enable them on your agent as usual.
- Tool-result `text` blocks reach the UI verbatim: they carry literal output (a file read, a shell transcript), where `&lt;` means those four characters. Only `search_result` blocks, whose bodies are extracted from HTML, have their entities decoded.
- A follow-up message posted immediately after a tool result can race the session's asynchronous un-park and be rejected with a 400. That specific rejection is retried, matched on the message containing `waiting on responses` — wording that has not been confirmed against the live API. If the API rewords it the retry stops firing and the 400 surfaces as a run error; nothing else is affected. See the comment on the matcher.
- The default in-memory store is bounded (10 000 mappings): thread ids are client-supplied, so past that the least-recently-used mapping is evicted and that thread starts a fresh session. Pass a smaller cap to `new InMemorySessionStore(maxEntries: n)`, or supply a persistent store.
- A run that is interrupted — a turn timeout, a client disconnect, or a blocked action this integration cannot answer — forgets the frontend tool calls it had recorded as parked. The interrupt cancels whatever the session was waiting on, so answering one of those calls on the next run would be rejected as stale. If the interrupt itself could not be delivered the ids are kept, since the session may still be parked on them.
- A session that registers custom tools holds a full replacement tool list, frozen at the last update, so the agent's own tools are re-read once per run to catch a Console edit to them. A session with no custom tools runs the agent as-is and skips that read entirely.

## Running the example server

```bash
cd integrations/claude-managed-agents/dotnet/examples/AGUIDojoServer
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN
dotnet run -- setup   # provisions an environment plus one agent per route (idempotent)
dotnet run            # http://localhost:8026
PORT=9000 dotnet run  # http://localhost:9000
```

Setup writes the provisioned IDs to `.managed-agents.json` next to the built assembly (gitignored). It reuses existing agents by name and does not modify them: to apply prompt changes from `AgentSpecs.cs`, archive the agent and re-run setup.

## Development

```bash
cd integrations/claude-managed-agents/dotnet
dotnet build
dotnet test
```

The solution file is `AGUI.ClaudeManagedAgents.slnx`. The library and example reference the ag-ui .NET SDK by project reference (`sdks/dotnet/src`) until those packages are published.
