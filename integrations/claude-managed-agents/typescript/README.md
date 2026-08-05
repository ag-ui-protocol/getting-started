# @ag-ui/claude-managed-agents

Connect an [AG-UI](https://ag-ui.com) frontend to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), Anthropic's hosted agent runtime. Each AG-UI thread maps to one managed session. Each run drives one turn of that session and streams the agent's events back as AG-UI events.

## Installation

```bash
npm install @ag-ui/claude-managed-agents @anthropic-ai/sdk
```

## Usage

Create a managed agent and an environment once (in the Console, or via the SDK), then wrap them:

```typescript
import { ManagedAgentsAgent } from "@ag-ui/claude-managed-agents";

const agent = new ManagedAgentsAgent({
  managedAgentId: "agent_...",
  environmentId: "env_...",
});

agent.run({ threadId, runId, messages, tools, state, context, forwardedProps }).subscribe({
  next: (event) => console.log(event.type),
});
```

The Anthropic client reads `ANTHROPIC_API_KEY` from the environment. Pass `client` to supply your own.

## What it does

| Managed Agents | AG-UI |
| --- | --- |
| `agent.message` (with `event_delta` previews) | `TEXT_MESSAGE_START` / `CONTENT` / `END` |
| `agent.thinking` | `REASONING_START` / `REASONING_MESSAGE_START` / `REASONING_MESSAGE_END` / `REASONING_END` |
| `agent.tool_use`, `agent.mcp_tool_use` + results | `TOOL_CALL_*` + `TOOL_CALL_RESULT` (server-executed, display only) |
| `agent.custom_tool_use` for a frontend tool | `TOOL_CALL_*`, then the run ends so the client can run the tool |
| `agent.custom_tool_use` for a backend tool | `TOOL_CALL_*` + `TOOL_CALL_RESULT`, and the handler's result is posted back |
| `session.error` (terminal) | `RUN_ERROR` with the error type as `code` |
| `session.status_idle` (`end_turn`) | `RUN_FINISHED` |

### Frontend tools (human-in-the-loop)

Tools passed in `RunAgentInput.tools` are registered on the session as custom tools. When the agent calls one, the run emits the tool call and finishes, leaving the session parked. The client executes the tool and starts the next run with a `role: "tool"` message carrying `toolCallId`. The adapter forwards it into the session as the tool result and resumes streaming.

### Backend tools

Tools your server executes go in `backendTools`:

```typescript
new ManagedAgentsAgent({
  managedAgentId,
  environmentId,
  backendTools: [
    {
      name: "get_weather",
      description: "Get the weather for a location.",
      parameters: { type: "object", properties: { location: { type: "string" } } },
      handler: async (input) => JSON.stringify({ temperature: 21 }),
    },
  ],
});
```

The tool call and its result stream to the UI, and the result is returned to the agent.

## Options

| Option | Default | |
| --- | --- | --- |
| `managedAgentId`, `environmentId` | required | The managed agent (`agent_...`) and environment behind each session. |
| `agentVersion` | latest | Pin an agent version. |
| `client` | `new Anthropic()` | Bring your own Anthropic client. |
| `sessionStore` | in-memory | Thread↔session mapping, keyed by `managedAgentId:threadId`. Provide your own to survive restarts. |
| `backendTools` | `[]` | Server-executed custom tools. |
| `sessionTitle` | `AG-UI thread <id>` | Title for created sessions. |
| `vaultIds` | `[]` | Vault IDs (`vlt_...`) for stored credentials the agent may use, e.g. for MCP servers that authenticate. Applied at session creation. |
| `toolConfirmation` | error | `"allow"`/`"deny"` to answer built-in tools whose permission policy asks. |
| `turnTimeoutMs` | 300000 | Interrupt turns that run longer. |
| `streamDeltas` | `true` | Request text/thinking previews for token streaming. |
| `onError` | none | Notified when a best-effort operation fails. May be `async`; its rejection is absorbed, so nothing it does can fail a run. Bounded like any other best-effort call, so a hook that never settles cannot hold a run open. With no hook set, the cause goes to `console.error` instead — never to the client. |

## Security: authenticate and bind threads to callers

AG-UI thread IDs are supplied by the client and this agent keys thread↔session state by `managedAgentId:threadId`, so a thread ID is effectively a bearer identifier: **any caller who presents a thread ID resumes that thread's session.** The AG-UI protocol carries no user identity of its own, so authorization is your host's responsibility:

- Put the endpoint behind your own authentication. Never expose it unauthenticated.
- `RUN_ERROR` never relays the text of a failure this integration did not author. An SDK, session-store or API exception can carry session ids, request paths or credentials, so its message goes to `onError` and the client gets a stable message plus the machine-readable `code`. Two things are deliberately still verbatim, because they are the point of the event: a `session.error` from the API (a structured field with its own `type` code, and the only account of why a session broke) and a backend tool's own exception message (your code, and what the agent needs to recover).
- In multi-tenant deployments, bind threads to the authenticated caller so one caller cannot resume another's session by guessing or replaying a thread ID. Do this with a `sessionStore` whose keys include the caller identity derived from your auth layer (never from the request body):

The key the agent passes in is already scoped to the managed agent; treat it as an opaque string and prefix it with the caller identity rather than parsing it:

```ts
class PerCallerStore implements SessionStore {
  constructor(private ownerId: string, private inner = new Map<string, SessionRecord>()) {}
  private scoped = (key: string) => `${this.ownerId}|${key}`;
  get = (key: string) => this.inner.get(this.scoped(key));
  set = (key: string, record: SessionRecord) => void this.inner.set(this.scoped(key), record);
  delete = (key: string) => void this.inner.delete(this.scoped(key));
}
```

  Reuse ONE store instance per caller — construct it once and cache it:

```ts
const shared = new Map<string, SessionRecord>();
const stores = new Map<string, PerCallerStore>();
const storeFor = (ownerId: string): PerCallerStore => {
  let store = stores.get(ownerId);
  if (!store) stores.set(ownerId, (store = new PerCallerStore(ownerId, shared)));
  return store;
};
```

  Runs are serialized per thread within a store instance, so a fresh wrapper per request would let a double-submitted thread post into the same session twice. Cache the store (as above) and construct the agent with `storeFor(ownerId)`.

## Notes

- The default session store is in-memory: restarting the process starts new sessions. Managed sessions themselves persist server-side.
- Turns are serial per thread. A second run on a busy thread errors with code `run_in_progress`.
- Only the text of a user message is forwarded. A message with image or binary parts and no text errors with code `empty_run` instead of creating a session.
- When the client disconnects mid-turn (or `abortRun()` is called), the adapter posts `user.interrupt` to stop the session. A turn that exceeds `turnTimeoutMs` is interrupted the same way and errors. A backend tool handler still running at that point is abandoned and answered with an error so the session is not left parked.
- Built-in tools (bash, file editing, web) execute inside the managed environment. This adapter surfaces them for display, so enable them on your agent as usual.
- Tool-result `text` blocks reach the UI verbatim: they carry literal output (a file read, a shell transcript), where `&lt;` means those four characters. Only `search_result` blocks, whose bodies are extracted from HTML, have their entities decoded.
- A follow-up message posted immediately after a tool result can race the session's asynchronous un-park and be rejected with a 400. That specific rejection is retried, matched on the message containing `waiting on responses` — wording that has not been confirmed against the live API. If the API rewords it the retry stops firing and the 400 surfaces as a run error; nothing else is affected. See the comment on the matcher.
- The default in-memory store is bounded (`IN_MEMORY_SESSION_STORE_MAX_ENTRIES`, 10 000 mappings): thread ids are client-supplied, so past that the least-recently-used mapping is evicted and that thread starts a fresh session. Pass a smaller cap to `new InMemorySessionStore(n)`, or supply a persistent store.
- A run that is interrupted — a turn timeout, a client disconnect, or a blocked action this integration cannot answer — forgets the frontend tool calls it had recorded as parked. The interrupt cancels whatever the session was waiting on, so answering one of those calls on the next run would be rejected as stale. If the interrupt itself could not be delivered the ids are kept, since the session may still be parked on them.
- A session that registers custom tools holds a full replacement tool list, frozen at the last update, so the agent's own tools are re-read once per run to catch a Console edit to them. A session with no custom tools runs the agent as-is and skips that read entirely.

## Running the examples

```bash
cd integrations/claude-managed-agents/typescript
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN
pnpm setup:examples   # provisions an environment + one agent per Dojo feature (idempotent)
pnpm dev:examples     # http://localhost:8024
```

Setup writes the provisioned IDs to `examples/.managed-agents.json` (gitignored). It reuses existing agents by name and does not modify them: to apply prompt changes from `examples/agents.ts`, archive the agent and re-run setup.
