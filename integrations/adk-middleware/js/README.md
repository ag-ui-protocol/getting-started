# @ag-ui/adk-js

`@ag-ui/adk-js` runs a Google ADK JavaScript `Runner` inside a Node.js AG-UI
runtime. It translates raw ADK events into AG-UI messages, tools, state,
interrupts, usage, errors, and lifecycle events.

This package is separate from `@ag-ui/adk`. The older package remains the
browser-safe HTTP client for the Python `ag_ui_adk` middleware; it is not a
JavaScript ADK runtime.

## Quickstart

### 1. Create a starter application

```bash
npx create-ag-ui-app --adk-js
```

The command downloads the runnable Next.js starter from [`starter/`](./starter)
without changing the existing Python `--adk` scaffold.

To add the integration to an existing application, continue with the manual
steps below.

### 2. Install the server dependencies

```bash
pnpm add @ag-ui/adk-js @google/adk @copilotkit/runtime hono
```

`@ag-ui/adk-js` requires `@google/adk` 2.x, `@ag-ui/client` and `@ag-ui/core`
0.0.59 or newer (the versions CopilotKit 1.70+ pins), and Node.js 20.9 or
newer. This integration is server-only. Do not import it from browser
components.

### 3. Configure Gemini

Create a Gemini API key in Google AI Studio, then expose it to the server:

```bash
export GOOGLE_GENAI_API_KEY="your-api-key"
export GOOGLE_GENAI_USE_VERTEXAI=0
```

### 4. Register the ADK agent with your runtime

The following Next.js route creates a native ADK JavaScript agent and exposes
it through CopilotKit's AG-UI endpoint:

`app/api/copilotkit/route.ts`

```typescript
import { Agent, InMemorySessionService } from "@google/adk";
import { ADKJSAgent } from "@ag-ui/adk-js";
import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";

const rootAgent = new Agent({
  name: "assistant",
  model: "gemini-2.5-flash",
  instruction: "Be helpful.",
});

const agent = new ADKJSAgent({
  appName: "assistant_app",
  sessionService: new InMemorySessionService(),
  agent: rootAgent,
  // ADK sessions are scoped per user: resolve this from your server-side auth.
  userId: "user-123",
});

const runtime = new CopilotRuntime({
  agents: { assistant: agent },
  runner: new InMemoryAgentRunner(),
});

const app = createCopilotEndpointSingleRoute({
  runtime,
  basePath: "/api/copilotkit",
});

export const POST = handle(app);
```

Point an AG-UI client at `/api/copilotkit` and select the `assistant` agent.
For a working UI and examples of tools, shared state, and interrupts, open the
[Google ADK JavaScript Dojo](https://dojo.ag-ui.com/adk-js/feature/agentic_chat?openCopilot=true)
or browse [`examples/`](./examples).

The full setup and architecture guide is available in the
[AG-UI documentation](../../../docs/integrations/google-adk-js.mdx).

`ADKJSAgent` is an AG-UI `AbstractAgent`, so it can be registered directly with a
server-side CopilotKit runtime. It emits one `RUN_STARTED`, initial and final
state snapshots, translated streaming events, and exactly one terminal
`RUN_FINISHED` or `RUN_ERROR`.

### Frontend tools

Tools the AG-UI frontend declares reach ADK automatically: on the first run
that carries them, the bridge appends an `AGUIClientToolset` to the root
agent's `tools` array (with `runner:` that change stays on your instance). Its
proxy tools preserve arbitrary JSON Schema and pause ADK long enough for the
browser to execute the tool and return its result. To route frontend tools to
a specific sub-agent instead, place `new AGUIClientToolset()` in that agent's
`tools`; if you also pass `clientToolsets`, every entry must be placed in some
agent's `tools` or the run fails with `CLIENT_TOOLSET_NOT_PLACED`. A `Workflow`
root has no tools list, so it needs that explicit placement.

### Runs, sessions, and concurrency

Runs on different threads execute concurrently on one shared `agent`; a
second run on the same user and thread is refused with `THREAD_BUSY` until the
first finishes. ADK closes every toolset at the end of each run, so a toolset
shared by concurrent threads (an MCP toolset, for instance) is closed under the
other thread; give such roots per-run instances with a factory
(`agent: () => new Workflow(...)`), which is also what roots with per-run state
need. Pass `runner: myRunner` to bring a fully configured Runner (plugins,
services) instead. Failures that happen after the client has disconnected go to
`logger` (default `console`). `emitRawEvents` attaches the redacted ADK event
as `rawEvent` to mapped events and emits `RAW` events; it is off by default
because large tool results would otherwise be sent twice.

The bridge records its own bookkeeping in the ADK session as user-authored
events: `ag-ui-history-<runId>` for AG-UI history it replays into ADK,
`ag-ui-resume-reply-<runId>` for a resumed input answer, and one
`ag-ui-run-<runId>` marker per run (streamed message ids, suspended sub-agents,
and a replay of a completed resume). A tool can read the AG-UI context and
forwarded props from session state under `AG_UI_CONTEXT_KEY` and
`AG_UI_FORWARDED_PROPS_KEY`.

### Sub-agents

ADK multi-agent trees (`subAgents` with `transfer_to_agent`, `AgentTool`,
`ParallelAgent`, and 2.x `Workflow` nodes) are reported according to the
`subagents` mode:

```ts
new ADKJSAgent({ ..., subagents: "attributed" });
```

- `off` (default): one stream, nothing attributed — what every client consumes.
- `steps`: `STEP_STARTED` / `STEP_FINISHED` named `agent:<name>` around each
  sub-agent invocation, plus a `CUSTOM` `MultiAgentHandoff { from_nodes,
  to_nodes }` on each handoff. These predate subagent support, so they are
  safe for clients on `@ag-ui/client` 0.0.57 or older; the Dojo pipeline page
  is driven by them.
- `attributed`: everything in `steps` plus the AG-UI subagent protocol —
  `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` per invocation,
  and `subagentRunId` on every event, snapshot message, and interrupt a
  sub-agent produces. Clients on `@ag-ui/client` 0.0.57 or older reject these
  event types at the wire, so keep `off` or `steps` for them.

A transfer links the new invocation to the `transfer_to_agent` call through
`parentToolCallId` / `parentMessageId`. An interrupt raised inside a sub-agent
closes that invocation as `suspended`, the interrupt carries its
`subagentRunId`, and the same id is announced again when the interrupt is
resumed. `AgentTool` runs its agent in a separate ADK session, so it is
announced on the tool call and finished on the response. A `Workflow` node
failure is reported as `SUBAGENT_ERROR` before the run's `RUN_ERROR`.

### State, history, and interrupts

- AG-UI object state becomes ADK session state. ADK state deltas are emitted as
  RFC 6902 patches. Because ADK has no delete delta, the bridge tracks the keys
  owned by the latest AG-UI snapshot and writes `null` tombstones for removed
  keys: the key stays in the ADK session with a `null` value, and the emitted
  AG-UI snapshot omits it. The client's snapshot is authoritative; a client
  that arrives without state does not get the session's state restored.
  Existing ADK sessions without the private ownership manifest keep their
  backend-created keys; the bridge never guesses that an unseen key belongs to
  the UI.
- Full AG-UI history is deduplicated using message IDs persisted in ADK event
  metadata. Assistant agent names are preserved and validated against the ADK
  agent tree when history is restored.
- Dynamic AG-UI `system` and `developer` messages are rejected because ADK
  instructions belong on the ADK `Agent`. UI `activity` messages are ignored,
  and malformed JSON tool-call arguments fail explicitly.
- ADK input, credential, and confirmation requests become AG-UI interrupt
  outcomes. A later AG-UI `resume` entry is converted into the matching ADK
  function response. Every pending interrupt must be answered together; new
  input is blocked while an interrupt is open, and completed resumes are
  recorded in the ADK session so retries of the same interrupt/status/payload do
  not repeat model or tool work. The stored replay includes state, messages,
  result, usage, and interrupt outcome. Response metadata is not part of the
  retry identity. A replay is honoured only while that resume is the newest
  run on the thread; afterwards the retry fails with `STALE_RESUME`.
- ADK 2.x hides the `adk_request_input` exchange from the model, so a resolved
  input interrupt is delivered twice: as the ADK function response that settles
  the pending call, and as a preceding plain user turn carrying the answer (a
  string as-is, anything else as JSON) so the agent can act on it. Confirmation
  and credential answers are never echoed as text.
- ADK 2.x binds a confirmation to the tool call it approves. A tool that raises
  its own confirmation at runtime (`toolContext.requestConfirmation(...)`) must
  also answer `true` from `checkRequireConfirmation`, or declare
  `requireConfirmation` on a `FunctionTool`; otherwise ADK refuses the approval
  and the bridge reports a `RUN_ERROR` with code `INTENT_MISMATCH`.
- OAuth credential replies must carry `oauth2.authResponseUri` or
  `oauth2.authCode`; ADK 2.x drops any other OAuth reply, so the bridge rejects
  it up front (`INVALID_CREDENTIAL_PAYLOAD`) instead of letting the run stall.
- A bare ADK `Workflow` may be passed as the `Runner` root. Its name and
  description are reported as the agent identity; capability and frontend tool
  discovery include its workflow nodes.
- Input requests use AG-UI's `input_required` reason, confirmations use
  `confirmation`, and credential requests use the namespaced
  `google-adk:credential_required` reason. Free-standing ADK requests do not
  invent `toolCallId` references.
- Credential interrupt metadata is allow-listed before it reaches the browser.
  Tokens, API keys, passwords, client secrets, private keys, HTTP credentials,
  and PKCE verifier material are never included, including when raw ADK event
  emission is enabled. Credential responses are merged back into the original
  server-side AuthConfig so OAuth exchange retains its secret and state
  material without exposing them to the client.
- Cancelling a confirmation denies it. Cancelling an input request answers
  ADK with `{ cancelled: true }` and tells the model the same, so the agent can
  acknowledge it. A credential request cannot be cancelled (ADK drops any reply
  that is not a credential), so that status fails with
  `UNSUPPORTED_INTERRUPT_CANCELLATION` and the request stays pending until it
  is resolved.
- Interrupt boundaries include final state and message snapshots before
  `RUN_FINISHED`, allowing clients to resume from an explicit checkpoint.
- Context and forwarded props are stored under reserved `_ag_ui_*` session
  keys and are excluded from UI state snapshots.
- Client state may only address ADK session-scoped keys. The bridge rejects
  `app:`, `user:`, and `temp:` keys and never exposes those ADK scopes back to
  the UI, preventing one request from reading or overwriting broader state.

`getCapabilities()` declares only behavior guaranteed by the bridge. Model- or
application-specific behavior such as reasoning, multimodal input, or parallel
tool execution must be declared explicitly with the `capabilities` option.
Token usage defaults to provider `google`; custom `BaseLlm` adapters can set
`usageProvider` to a string or event-based resolver, and usage is grouped by
provider and ADK `modelVersion` without inventing unreported counts.

See `examples/` for the Dojo agents demonstrating chat, backend and frontend
tools, shared state, and native ADK input interruption.
