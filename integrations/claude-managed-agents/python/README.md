# ag-ui-claude-managed-agents

Connect an [AG-UI](https://ag-ui.com) frontend to [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), Anthropic's hosted agent runtime. Each AG-UI thread maps to one managed session. Each run drives one turn of that session and streams the agent's events back as AG-UI events.

## Installation

```bash
pip install ag-ui-claude-managed-agents
```

## Usage

Create a managed agent and an environment once (in the Console, or via the SDK), then wrap them:

```python
from fastapi import FastAPI
from ag_ui_claude_managed_agents import ManagedAgentsAgent, add_managed_agents_fastapi_endpoint

app = FastAPI()

agent = ManagedAgentsAgent(managed_agent_id="agent_...", environment_id="env_...")
add_managed_agents_fastapi_endpoint(app=app, agent=agent, path="/agent")
```

`managed_agent_id` is the Anthropic managed agent's id (`agent_...`), named apart from AG-UI's own agent id so the two never collide. The endpoint helper accepts a POST with a `RunAgentInput` body and streams the encoded AG-UI events. Without FastAPI, iterate the events yourself:

```python
async for event in agent.run(run_input):
    print(event.type)
```

The Anthropic client reads `ANTHROPIC_API_KEY` from the environment. Pass `client` to supply your own `AsyncAnthropic`.

## What it does

| Managed Agents | AG-UI |
| --- | --- |
| `agent.message` (with `event_delta` previews) | `TEXT_MESSAGE_START` / `CONTENT` / `END` |
| `agent.thinking` (with `event_start` previews) | `REASONING_START` / `REASONING_MESSAGE_START` / `REASONING_MESSAGE_END` / `REASONING_END` |
| `agent.tool_use`, `agent.mcp_tool_use` + results | `TOOL_CALL_*` + `TOOL_CALL_RESULT` (server-executed, display only) |
| `agent.custom_tool_use` for a frontend tool | `TOOL_CALL_*`, then the run ends so the client can run the tool |
| `agent.custom_tool_use` for a backend tool | `TOOL_CALL_*` + `TOOL_CALL_RESULT`, and the handler's result is posted back |
| `session.error` (terminal) | `RUN_ERROR` with the error type as `code` |
| `session.status_idle` (`end_turn`) | `RUN_FINISHED` |

### Frontend tools (human in the loop)

Tools passed in `RunAgentInput.tools` are registered on the session as custom tools. When the agent calls one, the run emits the tool call and finishes, leaving the session parked. The client executes the tool and starts the next run with a `role: "tool"` message carrying `toolCallId`. The adapter forwards it into the session as the tool result and resumes streaming.

### Backend tools

Tools your server executes go in `backend_tools`:

```python
import json

from ag_ui_claude_managed_agents import BackendTool, ManagedAgentsAgent

agent = ManagedAgentsAgent(
    managed_agent_id=managed_agent_id,
    environment_id=environment_id,
    backend_tools=[
        BackendTool(
            name="get_weather",
            description="Get the weather for a location.",
            parameters={"type": "object", "properties": {"location": {"type": "string"}}},
            handler=lambda tool_input: json.dumps({"temperature": 21}),
        ),
    ],
)
```

The handler may be a plain function or a coroutine. A plain function runs in a worker thread so a blocking handler never stalls the event loop; a coroutine is awaited on the loop. The tool call and its result stream to the UI, and the result is returned to the agent. If the turn times out or the client disconnects mid-tool, an error result is posted for the call so the session is not left parked.

## Options

| Option | Default | |
| --- | --- | --- |
| `managed_agent_id`, `environment_id` | required | The managed agent and environment behind each session. |
| `agent_version` | latest | Pin an agent version. |
| `client` | `AsyncAnthropic()` | Bring your own Anthropic client. |
| `session_store` | in-memory | Thread to session mapping, keyed by `managed_agent_id:thread_id`. Provide your own to survive restarts. |
| `backend_tools` | `[]` | Server-executed custom tools. |
| `session_title` | `AG-UI thread <id>` | Callable returning the title for created sessions. |
| `vault_ids` | `[]` | Vault ids (`vlt_...`) for stored credentials the agent may use, e.g. for MCP servers that authenticate. Applied at session creation. |
| `tool_confirmation` | `None` | `"allow"`/`"deny"` answers built-in tools whose permission policy asks. With no policy, such a call interrupts the run with a `tool_confirmation_required` error. |
| `turn_timeout_s` | 300 | Interrupt turns that run longer. |
| `stream_deltas` | `True` | Request text/thinking previews for token streaming. |
| `on_error` | `None` | Notified when a best-effort operation fails. May be a coroutine function; it is awaited and its failure absorbed, so nothing it does can fail a run. Bounded like any other best-effort call, so a hook that never settles cannot hold a run open. With no hook set, the cause is logged to the `ag_ui_claude_managed_agents` logger instead — never sent to the client. |

## Security: authenticate and bind threads to callers

AG-UI thread ids are supplied by the client and this agent keys thread↔session state by `managed_agent_id:thread_id`, so a thread id is effectively a bearer identifier: **any caller who presents a thread id resumes that thread's session.** The AG-UI protocol carries no user identity of its own, so authorization is your host's responsibility:

- Put the endpoint behind your own authentication. Never expose it unauthenticated.
- `RUN_ERROR` never relays the text of a failure this integration did not author. An SDK, session-store or API exception can carry session ids, request paths or credentials, so its message goes to `on_error` and the client gets a stable message plus the machine-readable `code`. Two things are deliberately still verbatim, because they are the point of the event: a `session.error` from the API (a structured field with its own `type` code, and the only account of why a session broke) and a backend tool's own exception message (your code, and what the agent needs to recover).
- In multi-tenant deployments, bind threads to the authenticated caller so one caller cannot resume another's session by guessing or replaying a thread id. Do this with a `session_store` whose keys include the caller identity derived from your auth layer (never from the request body):

The key the agent passes in is already scoped to the managed agent; treat it as an opaque string and prefix it with the caller identity rather than parsing it:

```python
class PerCallerStore:
    def __init__(self, owner_id: str, inner: dict[str, SessionRecord] | None = None) -> None:
        self._owner_id = owner_id
        self._inner: dict[str, SessionRecord] = inner if inner is not None else {}

    def _scoped(self, key: str) -> str:
        return f"{self._owner_id}|{key}"

    def get(self, key: str) -> SessionRecord | None:
        return self._inner.get(self._scoped(key))

    def set(self, key: str, record: SessionRecord) -> None:
        self._inner[self._scoped(key)] = record

    def delete(self, key: str) -> None:
        self._inner.pop(self._scoped(key), None)
```

  Reuse ONE store instance per caller — construct it once and cache it:

```python
_shared: dict[str, SessionRecord] = {}
_stores: dict[str, PerCallerStore] = {}


def store_for(owner_id: str) -> PerCallerStore:
    if owner_id not in _stores:
        _stores[owner_id] = PerCallerStore(owner_id, _shared)
    return _stores[owner_id]
```

  Runs are serialized per thread within a store instance, so a fresh wrapper per request would let a double-submitted thread post into the same session twice. Cache the store (as above) and construct the agent with `store_for(owner_id)`.

## Notes

- The default session store is in-memory: restarting the process starts new sessions. Managed sessions themselves persist server-side.
- Turns are serial per thread. A second run on a busy thread errors with `run_in_progress`.
- Only text parts of a user message are forwarded. A message carrying only images or documents has nothing to send and errors with `empty_run`.
- A client disconnect or a turn timeout posts `user.interrupt` into the session so the agent stops instead of running unattended.
- Built-in tools (bash, file editing, web) execute inside the managed environment. This adapter surfaces them for display, so enable them on your agent as usual.
- Tool-result `text` blocks reach the UI verbatim: they carry literal output (a file read, a shell transcript), where `&lt;` means those four characters. Only `search_result` blocks, whose bodies are extracted from HTML, have their entities decoded.
- A follow-up message posted immediately after a tool result can race the session's asynchronous un-park and be rejected with a 400. That specific rejection is retried, matched on the message containing `waiting on responses` — wording that has not been confirmed against the live API. If the API rewords it the retry stops firing and the 400 surfaces as a run error; nothing else is affected. See the comment on the matcher.
- The default in-memory store is bounded (`IN_MEMORY_SESSION_STORE_MAX_ENTRIES`, 10 000 mappings): thread ids are client-supplied, so past that the least-recently-used mapping is evicted and that thread starts a fresh session. Pass a smaller cap to `InMemorySessionStore(max_entries=n)`, or supply a persistent store.
- A run that is interrupted — a turn timeout, a client disconnect, or a blocked action this integration cannot answer — forgets the frontend tool calls it had recorded as parked. The interrupt cancels whatever the session was waiting on, so answering one of those calls on the next run would be rejected as stale. If the interrupt itself could not be delivered the ids are kept, since the session may still be parked on them.
- A session that registers custom tools holds a full replacement tool list, frozen at the last update, so the agent's own tools are re-read once per run to catch a Console edit to them. A session with no custom tools runs the agent as-is and skips that read entirely.

## Running the examples

```bash
cd integrations/claude-managed-agents/python/examples
uv sync
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN
uv run python setup.py               # provisions an environment plus one agent per Dojo feature (idempotent)
uv run dev                           # http://localhost:8025
```

Setup writes the provisioned IDs to `examples/.managed-agents.json` (gitignored). It reuses existing agents by name and does not modify them. To apply prompt changes from `examples/agents.py`, archive the agent and re-run setup.
