# @ag-ui/adk-js

`@ag-ui/adk-js` runs a Google ADK JavaScript `Runner` inside a Node.js AG-UI
runtime. It translates raw ADK events into AG-UI messages, tools, state,
interrupts, usage, errors, and lifecycle events.

This package is separate from `@ag-ui/adk`. The older package remains the
browser-safe HTTP client for the Python `ag_ui_adk` middleware; it is not a
JavaScript ADK runtime.

## Installation

```bash
pnpm add @ag-ui/adk-js @google/adk
```

This integration is server-only. Do not import it from browser components.

## Usage

```typescript
import { Agent, InMemorySessionService, Runner } from "@google/adk";
import { ADKAgent, AGUIClientToolset } from "@ag-ui/adk-js";

const clientTools = new AGUIClientToolset();
const rootAgent = new Agent({
  name: "assistant",
  model: "gemini-2.5-flash",
  instruction: "Be helpful.",
  tools: [clientTools],
});

const runner = new Runner({
  appName: "assistant_app",
  agent: rootAgent,
  sessionService: new InMemorySessionService(),
});

const agent = new ADKAgent({
  runner,
  userId: "user-123",
  // Declare only capabilities supported by this particular model/application.
  capabilities: { multimodal: { input: { image: true } } },
});
```

`ADKAgent` is an AG-UI `AbstractAgent`, so it can be registered directly with a
server-side CopilotKit runtime. It emits one `RUN_STARTED`, initial and final
state snapshots, translated streaming events, and exactly one terminal
`RUN_FINISHED` or `RUN_ERROR`.

### Frontend tools

Place an `AGUIClientToolset` only on ADK agents that should receive tools
declared by the AG-UI frontend. Its proxy tools preserve arbitrary JSON Schema
and pause ADK long enough for the browser to execute the tool and return its
result.

### Runner lifetime and concurrency

A shared `runner` is globally serialized because its agent and toolset tree is
mutable. For parallel work on different threads, use `runnerFactory` and reuse
the intended session service:

```typescript
const sessionService = new InMemorySessionService();

const agent = new ADKAgent({
  userId: "user-123",
  runnerFactory: () => {
    const clientTools = new AGUIClientToolset();
    return new Runner({
      appName: "assistant_app",
      sessionService,
      agent: new Agent({
        name: "assistant",
        model: "gemini-2.5-flash",
        instruction: "Be helpful.",
        tools: [clientTools],
      }),
    });
  },
});
```

Only one run may be active for a `(userId, threadId)` pair. A concurrent run on
that thread fails immediately with `RUN_ERROR.code = "THREAD_BUSY"`; it is not
silently queued. Factory-created runners can execute different threads
concurrently.

### State, history, and interrupts

- AG-UI object state becomes ADK session state. ADK state deltas are emitted as
  RFC 6902 patches. Because ADK has no delete delta, the bridge tracks the keys
  owned by the latest AG-UI snapshot and writes `null` tombstones for removed
  keys; stale values therefore cannot survive in the ADK session, while the
  emitted AG-UI snapshot still omits the removed key.
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
  not repeat model or tool work. The stored replay includes state, result,
  usage, and interrupt outcome. It stores a message checkpoint only when the
  resumed run produces another interrupt, where that checkpoint is required for
  the next resume. Response metadata is not part of the retry identity.
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
- Confirmation cancellation is represented as a denial. ADK does not define a
  safe cancellation response for input or credential requests, so those statuses
  fail explicitly and leave the request pending for an explicit resolution.
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
