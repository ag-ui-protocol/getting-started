# AWS Strands Integration for AG-UI (TypeScript)

This package exposes a lightweight wrapper that lets any `@strands-agents/sdk` `Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to Express via `createStrandsApp` (or `addStrandsExpressEndpoint`).

## Prerequisites

- Node.js 20+ if you import this package as ESM. That is
  `@strands-agents/sdk`'s own floor (`engines.node: ">=20.0.0"`). This package
  declares no `engines` of its own, so nothing warns you below it and the failure
  surfaces later, wherever the SDK first needs something the runtime lacks.
- **Node.js 20.19+ or 22.12+ if you `require()` it from CommonJS.**
  `@strands-agents/sdk` is ESM-only (`"type": "module"`, and its `exports` map
  offers no `require` condition), while this package also ships a CommonJS build
  whose entry does a top-level `require` of it. That only works on a runtime with
  `require(esm)`, which arrived in 22.12.0 and was backported to 20.19.0. On 20.0
  through 20.18, or on 21.x, a CommonJS consumer fails at load with
  `ERR_REQUIRE_ESM`. Importing as ESM is unaffected on any Node 20.
- `pnpm` (recommended) or `npm`
- A Strands-compatible model key (e.g., AWS credentials for Bedrock, `OPENAI_API_KEY` for OpenAI)
- Node.js 20.12+ to run the demos under `examples/`. Every demo script there
  passes `--env-file-if-exists`, which is a Node 20.12 flag, and that package
  declares no `engines` either. Its `test` and `typecheck` scripts do not use the
  flag and are unaffected.

## Quick Start

The `examples/` package ships a "dojo" server that mounts every demo on a
single port, plus a standalone server for each of the ten demos that ship a
run script, which you can start on its own.

```bash
# from the repo root
pnpm install
pnpm --filter @ag-ui/aws-strands build

cd integrations/aws-strands/typescript/examples
pnpm dojo                       # all examples at http://localhost:8022
```

Or run any single example on its own port (default `8000`):

```bash
pnpm agentic-chat
pnpm agentic-chat-reasoning
pnpm agentic-chat-multimodal
pnpm backend-tool-rendering
pnpm shared-state
pnpm agentic-generative-ui
pnpm human-in-the-loop
pnpm interrupt
pnpm predictive-state-updates
pnpm tool-based-generative-ui
```

The dojo exposes:

| Route                       | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `/agentic-chat`             | Baseline chat; frontend tools auto-registered from `RunAgentInput.tools` |
| `/agentic-chat-reasoning`   | Reasoning / thinking event streaming                                     |
| `/agentic-chat-citations`   | Answers carrying the sources they came from                              |
| `/agentic-chat-multimodal`  | Multimodal image / document analysis                                     |
| `/backend-tool-rendering`   | Backend-executed tools (`get_weather`, `render_chart`)                   |
| `/shared-state`             | Shared recipe state (`stateFromArgs`)                                    |
| `/agentic-generative-ui`    | Async-generator tool streams `STATE_SNAPSHOT`s + `PredictState`          |
| `/human-in-the-loop`        | Frontend proxy tool with halt-after-call                                 |
| `/interrupt`                | Backend tool pauses itself to ask the user for a meeting time            |
| `/predictive-state-updates` | Frontend write tool whose streaming args paint `state.document`          |
| `/tool-based-generative-ui` | Frontend-rendered tool (`generate_haiku`)                                |
| `/multi-agent`              | Graph orchestrator; the adapter drives `.stream()` rather than cloning   |
| `/a2ui-dynamic-schema`      | A2UI surfaces composed on the fly (auto-injected tool)                   |
| `/a2ui-fixed-schema`        | A2UI from fixed-layout backend tools                                     |
| `/a2ui-recovery`            | A2UI validate-and-retry recovery loop                                    |

Every file under `examples/server/api/*.ts` follows the same pattern: build the thing the demo drives, wrap it in a `StrandsAgent`, and export that as a factory. Usually that is a single Strands `Agent`; `multi-agent.ts` wraps a graph orchestrator instead. Each file is the single definition of its demo, so the dojo server mounts the same agent you get by running the demo on its own. The ten with a `pnpm run <demo>` script also hand the agent to `createStrandsApp` and listen, guarded so importing the file starts no server. The multi-agent and three a2ui files export the factory only. `agentic-chat-citations.ts` sits between the two: it carries the same standalone runner, but no `pnpm` script points at it, so run it with `tsx` directly.

## Architecture Overview

The integration has three main layers:

- **StrandsAgent** – wraps `Agent.stream()` from `@strands-agents/sdk`. It translates Strands streaming events into AG-UI events (text chunks, tool calls, PredictState, snapshots, reasoning/thinking, multi-agent steps, etc.).
- **Configuration** – `StrandsAgentConfig` + `ToolBehavior` + `PredictStateMapping` let you describe tool-specific quirks declaratively (skip message snapshots, emit state, stream args, etc.).
- **Transport helpers** – `createStrandsApp` and `addStrandsExpressEndpoint` expose the agent via SSE. They are thin shells over the shared `@ag-ui/encoder` `EventEncoder`. Imported from `@ag-ui/aws-strands/server` — kept off the main entry so client-side bundlers (Next.js, Vite) don't pull Express into the browser graph.

See [../ARCHITECTURE.md](../ARCHITECTURE.md) for diagrams and a deeper dive.

## Key Files

| File                       | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `src/agent.ts`             | Core wrapper translating Strands streams into AG-UI events                      |
| `src/config.ts`            | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/template-tools.ts`    | Per-request filter over the template agent's tools                              |
| `src/server.ts`            | `createStrandsApp` + Express transport (subpath: `@ag-ui/aws-strands/server`)   |
| `src/endpoint.ts`          | Express endpoint helpers (used by `server.ts`)                                  |
| `src/utils.ts`             | Multimodal content conversion and the `UrlFetchPolicy` that guards it           |
| `src/client-proxy-tool.ts` | Dynamic frontend tool registration/deregistration                               |
| `src/citations.ts`         | Provider citations normalised onto the message they annotate                    |
| `src/a2ui-tool.ts`         | A2UI tool injection and the validate-and-retry recovery loop                    |
| `src/session-reconcile.ts` | Frontend-result reconciliation against a persisted session                      |
| `examples/server/api/*.ts` | One factory per demo; eleven carry a standalone runner, ten of those scripted   |

## Amazon Bedrock AgentCore Considerations

If you are planning to deploy your agent into Amazon Bedrock AgentCore (AC), please note that AC expects the following:

- The server is running on port 8080.
- The path `/invocations - POST` is implemented and can be used for interacting with the agent.
- The path `/ping - GET` is implemented and can be used for verifying that the agent is operational and ready to handle requests.

To implement the paths mentioned above, you can use the helper function `createStrandsApp` and pass the agent interaction path and the ping path as shown below:

```ts
const app = await createStrandsApp(aguiAgent, {
  path: "/invocations",
  pingPath: "/ping",
});
app.listen(8080);
```

You can also use the helper functions `addStrandsExpressEndpoint` and `addPing` for adding the mentioned paths to an Express app that you are creating separately:

```ts
import express from "express";
import { addStrandsExpressEndpoint, addPing } from "@ag-ui/aws-strands/server";

const app = express();
// No CORS middleware, so no page on a different origin can read this
// endpoint's responses. Same-origin pages are unaffected: CORS governs
// cross-origin requests only.
// Add `cors` yourself only if a browser on another origin has to reach it.
addStrandsExpressEndpoint(app, aguiAgent, {
  path: "/invocations",
  bodyParser: express.json({ limit: "50mb" }),
});
addPing(app, "/ping");
app.listen(8080);
```

Requests to the AC endpoint must be authenticated. You can configure your agent runtime to accept JWT bearer tokens (via Amazon Cognito) or use SigV4. See [Set up authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) in the AgentCore documentation.

For details on how AgentCore handles AG-UI requests, event streaming, and error formatting, see the [AG-UI protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html).

To deploy, use the [AgentCore Starter Toolkit](https://github.com/aws/bedrock-agentcore-starter-toolkit).
These are the commands AWS's own AG-UI deployment guide gives for a TypeScript
entrypoint, and `--protocol AGUI` is what tells the runtime to treat port 8080
and `/invocations` as AG-UI rather than plain HTTP:

```bash
pip install bedrock-agentcore-starter-toolkit
agentcore configure -e my-agui-server.ts --protocol AGUI
agentcore deploy
```

The starter toolkit's repository says its CLI is superseded by `@aws/agentcore`,
which carries the same `--protocol AGUI` value under its own command names,
while the AG-UI deployment guide linked above still gives the starter-toolkit
commands. Where the two disagree, that guide is the one to follow: it is AWS's
own instructions for this protocol.

For the complete deployment walkthrough, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html).

## Supported AG-UI Events

The integration supports the following AG-UI event families:

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text streaming**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` (optionally collapsed into `TEXT_MESSAGE_CHUNK` via `StrandsAgentConfig.emitChunkEvents`)
- **Reasoning**: `REASONING_*` events for models with extended thinking (`REASONING_MESSAGE_CHUNK` when `emitChunkEvents` is on)
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` (or `TOOL_CALL_CHUNK` with `emitChunkEvents`)
- **State management**: `STATE_SNAPSHOT`, and `STATE_DELTA` where a
  `customResultHandler` emits one; the adapter produces no delta of its own
- **Multi-agent**: `STEP_STARTED`, `STEP_FINISHED`, and `MultiAgentHandoff` custom events
- **Generative UI**: `PredictState` custom events for optimistic UI updates
- **Message history**: `MESSAGES_SNAPSHOT` after the opening state snapshot and
  after each `TOOL_CALL_END`, `TOOL_CALL_RESULT` and terminal `TEXT_MESSAGE_END`,
  each carrying the complete thread as known so far. On by default; turn it off
  globally with `StrandsAgentConfig.emitMessagesSnapshot`, or per tool with
  `ToolBehavior.skipMessagesSnapshot`. The multi-agent orchestrator path emits
  none whatever those say.
- **Multimodal**: Image, document, and video content in user messages (converted to Strands ContentBlock format)
- **Citations**: source passages attached to the assistant message's `metadata` (see below)
- **Custom**: `PredictState`, `MultiAgentHandoff`, `AgentStopped` (an abnormal
  model stop reason) and `hook_error` (a developer callback that threw), all as
  `CUSTOM` events keyed by `name`
- **Interrupts**: `RUN_FINISHED` carries an interrupt outcome when a backend
  tool or hook paused the run (see below)
- **Raw passthrough**: `RAW` for Strands events this adapter does not map (see
  below)

The adapter advertises an event / feature matrix at GET `/capabilities`
(enabled by default; override via
`createStrandsApp({ capabilitiesPath, capabilities })` or mount manually with
`addCapabilities(app, path, overrides)`, or
`addCapabilities(app, path, { agent, overrides })` to derive the chunk flags from
a live agent's `emitChunkEvents` rather than pinning them).

One flag in that matrix needs reading with care. `events.STATE_DELTA: false` and
`features.stateDelta: false` are not a mistake, and mean what they say about the
adapter, which emits no delta of its own; a `customResultHandler` that emits one
is your own addition. Fold an override in if you serve the matrix to something
that reads it.

## Unmapped Strands events reach the client as `RAW`

A Strands stream event with no AG-UI translation is forwarded rather than
dropped, as `{ type: "RAW", event, source: "strands" }`. Bedrock's per-turn
`metadata` (token usage, latency, trace ids) arrives this way, and so does
anything a future SDK release starts emitting before this adapter learns to map
it.

> **`event` is a framework-shaped payload, not an AG-UI one.** Its contents are
> whatever `@strands-agents/sdk` put on the wire for that event, and the SDK is
> free to change that shape in any release without it being a break in this
> package. Read it defensively, and do not build a required UI path on a field
> you found in it. Anything this adapter promises to keep stable is a mapped
> event with a name, not a `RAW` one.

Forwarding is filtered rather than coerced. Keys belonging to the per-run
invocation state are stripped, since Strands merges them into otherwise public
model events, and a payload that will not survive a strict JSON round trip is
dropped with a warning rather than stringified. Coercing it would ship the
serialized live `Agent`, system prompt and conversation history included, to
every connected client.

## Multi-agent orchestration

Pass a Strands `Graph` or `Swarm` where `StrandsAgentOptions.agent` would
normally take an `Agent`. The adapter detects the orchestrator structurally (it
has no `model`) and drives its `.stream()` directly instead of cloning a
per-thread agent, so per-thread caching, session managers and proxy-tool sync do
not apply: the orchestrator owns its own nodes. Both bridges do this; see
Strands' [Graph](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/)
and [Swarm](https://strandsagents.com/docs/user-guide/concepts/multi-agent/swarm/)
guides for what each pattern is for.

Each node opens a `STEP_STARTED` named `{nodeType}:{nodeId}` and closes it with
`STEP_FINISHED`, a handoff becomes `CUSTOM` `MultiAgentHandoff` carrying
`from_nodes` / `to_nodes` / `message`, and each node's text and tool calls stream
inside its own step. `/multi-agent` in the dojo is a live example.

Two limits are worth knowing before you rely on this path, and both are
described in full in [../ARCHITECTURE.md](../ARCHITECTURE.md):

- **A failed Graph node does not fail the run here.** The TypeScript SDK's
  `Node.stream()` turns a node throw into a FAILED `NodeResult` and returns
  normally, so the adapter never sees it: the run emits its steps and then
  `RUN_FINISHED`. Only orchestration budgets (`maxSteps`, `timeout`,
  `nodeTimeout`) escape as a throw, and those report `STRANDS_ERROR`. The Python
  bridge differs, because a Python `Graph` fails fast and re-raises.
- **A step the SDK abandoned stays open.** Step envelopes are paired from the
  SDK's own node brackets and this adapter closes none of its own.

## One run at a time per thread

A second run starting on a thread that already has one in flight is refused
before the body is entered, with
`RUN_ERROR { code: "THREAD_BUSY" }` and the message `Another run is already in
progress on thread "<id>". Wait for RUN_FINISHED before starting another.` One
Strands `Agent` is cached per thread and cannot be multiplexed, and an
unguarded overlap corrupts the cached history rather than merely racing.

The slot is released in the run generator's `finally`. A caller driving
`agent.run(...)` directly rather than through the transport owes that generator
a `.return()`: breaking out of the loop, or pulling one event and dropping it,
leaves the slot held until the runtime finalizes the abandoned generator, and
the thread refuses runs for as long as that takes. The Express transport closes
it explicitly, including on client disconnect.

The guard is per adapter instance. Two instances sharing one `agentsByThread`
map, which is exactly what request-scoped serverless wrappers do, each start
with an empty busy set and can both accept a run on the same thread. Python has
the same limit.

## Abnormal model stop reasons

A terminal result whose stop reason is a guardrail intervention or a content
filter emits `CUSTOM` `AgentStopped` with `value: { stop_reason: <reason> }`
ahead of an ordinary `RUN_FINISHED`, so a UI can explain a short, empty or
filtered answer instead of reading it as success. A normal end of turn or a tool
use emits nothing.

Mind the two spellings. This SDK canonicalises provider stop reasons to
camelCase, so what arrives here is `guardrailIntervened` or `contentFiltered`,
and `ABNORMAL_STOP_REASONS` accepts both spellings because `StopReason` widens to
`string`. What goes out in `stop_reason` is Python's snake_case,
`guardrail_intervened` or `content_filtered`, from both bridges, so a client
matches one string rather than one per language.

Truncation is the exception: the SDK throws `MaxTokensError` as soon as the
aggregated stop reason is `maxTokens`, so no terminal result is produced and the
run reports `STRANDS_ERROR` with no hint. Python behaves identically.

Whether a hint can arrive at all is the provider's choice, because the hint is
only as good as the provider's own stop-reason mapping, and the TypeScript
providers do not map the way the Python ones do. Bedrock produces both hints;
OpenAI's chat-completions adapter and the Vercel provider produce the filtered
one only; OpenAI's Responses adapter and Gemini produce none. The full
per-provider survey, and where it disagrees with Python, is in
[../ARCHITECTURE.md](../ARCHITECTURE.md).

## Fetching URL content sources

A user message may carry an image, document or video as a URL rather than inline
data. The adapter fetches those server-side, so every fetch runs under a
`UrlFetchPolicy`. `DEFAULT_URL_FETCH_POLICY` is the one in force:
`allowedSchemes` of `http` and `https` only, `allowPrivateNetworks: false` so
any host resolving outside the public internet is refused (loopback, private and
link-local, the cloud metadata endpoints among them), `maxBytes` of 25 MiB,
`timeoutMs` of 30000 and `maxRedirects` of 10. The connection is pinned to the
address the policy validated, so a second DNS answer cannot redirect it; every
redirect hop is re-checked, and one that drops TLS is refused. `nat64Prefixes`
names the deployment-specific NAT64 prefixes to unwrap, over and above the
well-known `64:ff9b::/96` and `64:ff9b:1::/48`. A run whose media all fail
conversion with no text fallback ends with
`RUN_ERROR { code: "MEDIA_RESOLUTION_FAILED" }`.

A deployment whose attachments live on a private CDN or behind split DNS opts
in through `StrandsAgentConfig.urlFetchPolicy`, the counterpart to Python's
`url_fetch_policy`. `UrlFetchPolicy` is an interface rather than a class, so an
override is a spread over the exported default rather than a constructor call:

```ts
import {
  DEFAULT_URL_FETCH_POLICY,
  StrandsAgent,
  type UrlFetchPolicy,
} from "@ag-ui/aws-strands";

const policy: UrlFetchPolicy = {
  ...DEFAULT_URL_FETCH_POLICY,
  allowPrivateNetworks: true,
  maxBytes: 100 * 1024 * 1024,
  // Narrowing is allowed; widening is not (see below).
  allowedSchemes: new Set(["https"]),
};

const agent = new StrandsAgent({
  agent: strandsAgent,
  name: "my-agent",
  config: { urlFetchPolicy: policy },
});
```

Leaving `urlFetchPolicy` unset is the same as `DEFAULT_URL_FETCH_POLICY`, and
the opt-in is always the host's, never anything a client can put in a
`RunAgentInput`. Link-local addresses and the cloud metadata endpoints stay
blocked under `allowPrivateNetworks`, and `allowedSchemes` can only be
narrowed, never widened: an `http`/`https` request goes out over a transport
pinned to the addresses that passed validation, while any other scheme would
resolve the host again at connection time. `DEFAULT_URL_FETCH_POLICY` and
`UrlFetchPolicyError` are exported from the root entry as values, with
`UrlFetchPolicy` and `SchemeAllowlist` as types, so an override can be both
written and typed; `UrlFetchUnavailableError` stays internal, as it does in
Python.

An unusable policy ends the run with
`RUN_ERROR { code: "URL_FETCH_POLICY_INVALID" }` before any attachment is
fetched, rather than reverting to the default. That covers a limit below one, a
fractional redirect cap, a non-boolean `allowPrivateNetworks`, and a scheme
outside `http`/`https`.

The two policies are not the same shape either. Python bounds a whole run as
well as a single attachment, through `max_attachments`, `max_total_bytes` and
`max_total_seconds`; this bridge has no per-run budget, so a message carrying
many URLs is bounded only one attachment at a time.

## Terminal error codes

Every `RUN_ERROR` code either bridge can emit, and the message text that goes
with each one, is enumerated in
[`../error-codes.json`](../error-codes.json). That file is a wire contract
rather than documentation: clients and mock harnesses match both the code and
the message literally, and both test suites drive their bridge to each terminal
path and assert the emitted frame against it, so a reworded message fails a test
instead of reaching a client.

Two codes are TypeScript-only. `SEED_BUILD_ERROR` comes from this bridge's
history-seed preflight, which Python has no equivalent of because it seeds
inside the run. `THREAD_AGENT_CONFIG_ERROR` reports a throwing
`threadAgentConfig` callback, where Python reports the same class of failure as
`THREAD_AGENT_KWARGS_ERROR`, so a client matching on the code sees two values
rather than one. Everything else this bridge emits is shared with Python, and
`error-codes.json` records the reason against every one-sided code and every
one-sided sentence.

## Passing tools to the Agent

The adapter clones the template `Agent`'s resolved `agent.tools` onto every
per-thread clone, and it does that at construction time. Whatever is in that
list is what the model sees.

An `McpClient` handed straight to `tools` is not in that list. The SDK's
`tools` option does accept one (`ToolList` is
`(Tool | McpClient | Agent | ToolList)[]`), but it routes a client to an
internal client list rather than to the tool registry, and only registers its
tools inside `Agent.initialize()`, which runs on the first invocation. Measured
against `@strands-agents/sdk` 1.1.0: `new Agent({ tools: [client] })` leaves
`agent.tools` empty. Connecting the client first does not change that, so the
distinction to keep in mind is resolved-versus-unresolved, not
connected-versus-unconnected.

Resolve the tools yourself and spread them in, which puts real tools in the
registry at construction and so in every per-thread clone:

```ts
import { Agent, McpClient } from "@strands-agents/sdk";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// `transport` is required: `McpClientConfig` has no default for it.
const spellbook = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL("https://mcp.example.com/mcp"),
  ),
});
await spellbook.connect();
const mcpTools = await spellbook.listTools();

const agent = new Agent({
  model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
  tools: [...mcpTools, myLocalTool],
});

const aguiAgent = new StrandsAgent({ agent, name: "MyAgent" });
```

The adapter checks for this at construction time: a template `Agent` still
holding `McpClient` entries gets a warning naming how many, because their tools
cannot reach a per-thread clone. Spreading the resolved tools in silences it,
once the client itself is out of `tools`.

`McpClient` comes from the package root. `@strands-agents/sdk` publishes an
`exports` map with no `./mcp` entry, so a subpath import of it does not
resolve. Any `Transport` from `@modelcontextprotocol/sdk` works in its place;
the streamable-HTTP one above is just the common case. See Strands' own
[MCP tools guide](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)
for the transports and the elicitation callback.

## Per-request tool filtering

`StrandsAgentConfig.templateToolsProvider` decides which of the template
agent's tools one request may see. It is called once per request with that
request's `RunAgentInput`, so the answer can vary turn by turn on a single
thread:

```ts
const READ_ONLY = ["search_docs", "get_order"];

const aguiAgent = new StrandsAgent({
  agent,
  name: "assistant",
  config: {
    templateToolsProvider: (input) =>
      // Derive the role from authenticated request context in production;
      // forwardedProps is client-controlled.
      (input.forwardedProps as { role?: string })?.role === "admin"
        ? null // no filtering: every template tool stays available
        : READ_ONLY,
  },
});
```

Return the tools themselves or their names. `null` or `undefined` declines to
filter; an empty array is a real answer and withholds all of them. A name the
template does not contribute is dropped with a warning, because the hook
narrows the wrapped agent's tools and cannot add one. The provider may be
async.

Two boundary rules follow from that:

- **The return value is checked, not merely iterated.** A string and a mapping
  are both iterable and both mean something other than what iterating them
  produces: a bare name would come apart into characters, and a permission map
  would have its keys read as an allow-list while its values went unread, so a
  name mapped to `false` would still be allowed. Both are refused with
  `TEMPLATE_TOOLS_PROVIDER_ERROR`. Arrays, sets and generators are all
  accepted, and a generator that raises partway through iteration reports the
  same code, because the answer is read inside the same guarded step that calls
  the provider.
- **The filter reaches the registry, not only the advertised tool specs.** A
  model that calls a withheld name anyway, primed by a stale turn or by the
  visible history, is refused by the dispatcher rather than served.

The filter is applied to the tool registry the thread's live Strands `Agent`
already owns, the same way client-declared tools are synchronised, and never by
rebuilding that agent. The per-thread instance holds the thread's
`SessionManager`, its native interrupt checkpoint and its history, so replacing
it to change a tool list would discard a conversation and any approval waiting
inside it.

Three consequences follow from that:

- **A parked call is never orphaned.** A tool in the batch a live interrupt
  checkpoint would resume stays registered whatever the provider returns: the
  human's answer is about to be routed back into that batch, and an absent tool
  turns it into a "tool not found" the model re-fires. Filtering resumes once
  the pause closes. This is the rule `syncProxyTools` already applies to a proxy
  parked in a frontend-tool interrupt.
- **History is never rewritten.** A filtered-out tool's earlier calls and
  results stay in the thread's messages, so the model can still read what it
  did with a tool it can no longer call.
- **A failure is terminal.** If the provider throws, the run yields `RUN_ERROR`
  with code `TEMPLATE_TOOLS_PROVIDER_ERROR` and stops, matching
  `threadAgentConfig`. A filter that failed open would hand the model exactly
  the tools the caller meant to withhold.

The narrowing is also re-applied inside the run, once a tool batch has been
dispatched. The exemption above keeps a denied tool registered so a human's
answer can reach it, and Strands then carries on in the same run: it
re-dispatches the batch and makes its next model call from the same registry,
which would otherwise still be advertising what the request denied. The two
bridges hook different SDK events for this, because the SDKs read the tool
specs at different points relative to the events they dispatch; the effect is
the same on both.

Scope is the template's own tools. Client-declared tools on
`RunAgentInput.tools` are re-synchronised from the request every turn already,
so a caller that wants fewer of those sends fewer. The hook is not applied on
the multi-agent orchestrator path, which has no template registry to filter.

One deployment note. With an `agentsByThread` map, a request-scoped wrapper is
rebuilt per request while the cached thread agent keeps the registry it already
had. If the template's tools are built per request too, the adapter is handed
equivalent but not identical objects, so which registry entry belongs to the
template is decided by name plus "not one of the adapter's other producers"
rather than by object identity alone. Stable tool objects are still the simpler
thing to hand it.

## Human-in-the-loop interrupts

Two complementary patterns are supported:

- **Frontend tools.** The `/human-in-the-loop` example declares
  `generate_task_steps` on the frontend via `useHumanInTheLoop` — the adapter
  auto-registers it as a proxy tool, halts the run after the proxy resolves,
  and hands control back to the UI for approval. That round trip now survives a
  restart; see below.
- **Native Strands interrupts (SDK 1.1.0+).** Backend hooks and tools can call
  `event.interrupt(...)` / `context.interrupt(...)` to raise a
  `stopReason: 'interrupt'`. The adapter forwards the outstanding interrupts
  on `RUN_FINISHED`:

  ```json
  {
    "type": "RUN_FINISHED",
    "outcome": {
      "type": "interrupt",
      "interrupts": [
        { "id": "...", "reason": "...", "metadata": { "reason": {} } }
      ]
    }
  }
  ```

  A generic interrupt keeps the Strands name as its AG-UI `reason` (defaulting
  to `"interrupt"` when the interrupt carries no name) and the free-form Strands reason
  under `metadata.reason`. A tool configured with `interruptOnCall` instead
  publishes a `tool_call` approval, which always carries a `message`, an
  `approved` `responseSchema`, and `tool_name` / `tool_input` / `strandsName` in
  `metadata`. Two keys are conditional: `toolCallId`, which an approval raised
  without a native tool use has none of, and `reason`, which is published only
  when the native reason carried nothing the other keys could hold. Published `tool_input` is a detached copy,
  so inspecting it cannot reach into the SDK's live checkpoint.

  The `ag_ui:tool_call:` name prefix is **reserved** for this adapter's approval
  hook. An interrupt raised anywhere else under that prefix is classified,
  schema-checked and answered as an approval.

### The resume contract

The next `RunAgentInput` carries `resume[]` entries keyed by those `id`s. The
adapter converts each entry into a Strands `InterruptResponseContent` and hands
them straight to `agent.stream(...)`. Unknown `interruptId`s still short-circuit
with `RUN_ERROR { code: "UNKNOWN_INTERRUPT_ID" }` per
[interrupts.mdx rule 2](https://docs.ag-ui.com/concepts/interrupts).

`interrupt()` does **not** return `payload` directly. The adapter always hands
Strands an envelope instead. Two reasons: an answer the SDK reads as absent
re-raises the same interrupt and re-runs the tool body forever, and the Python
adapter supports older Strands releases that read a recorded answer by
truthiness rather than by presence. The envelope is always present and always
truthy, which satisfies both, and it is what makes one tool body portable
across the two bridges:

| `resume[]` entry                    | what the paused `interrupt()` returns                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| `status: "resolved"`, any `payload` | `{ response: payload }`                                            |
| `status: "resolved"`, no `payload`  | `{ response: null }`                                               |
| `status: "cancelled"`               | `{ cancelled: true }`, matching the exported `INTERRUPT_CANCELLED` |

Destructure it with `.response` / `.cancelled`, and do not truthiness-check the
envelope itself, since it is always truthy on resolve. Compare a cancellation by
value rather than by identity: `INTERRUPT_CANCELLED` is exported so you can match
its shape, and every answer is a fresh copy of it rather than the export itself.
Treat what you receive as read-only. It is the same object the framework records
as the answer, so mutating it changes what a later replay is compared against.
This is the same contract the Python package applies, so a tool body ports
between the two unchanged.

Adapter-managed `interruptOnCall` approvals are an exception in both
languages, and on Python a parked frontend tool is a second one that its own
README documents: their `{ approved: boolean }` payload is passed through raw, because
the approval hook reads `approved` off it directly. A cancelled approval is
answered `{ approved: false }` rather than with the sentinel.

Resuming a paused tool re-runs its body from the top, so any code before the
`interrupt()` call executes again. Keep side effects after the pause resolves.

### Frontend tool results survive a restart

A frontend tool call is a round trip: the adapter halts the run, the browser
executes the tool, and the answer arrives on the next request. Nothing
guarantees the next request reaches the same process, and a redeploy between
the two is ordinary. This bridge now recovers that answer from a persisted
session rather than losing it, which is what the Python bridge already did.

Wire it up by giving the adapter somewhere durable to persist to:

```ts
const agent = new StrandsAgent({
  agent: strandsAgent,
  name: "MyAgent",
  config: {
    sessionManagerProvider: async (input) => yourSessionManager(input.threadId),
  },
});
```

With a session manager active, the halted turn leaves a reinvokable assistant
tool use and a proxy placeholder result in the persisted history, and the
adapter records the id of the frontend call it emitted on the agent's own state
store. A later run, on a new process and a new adapter sharing only that
storage, overwrites the placeholder with the client's real answer and continues
from the corrected native history. Without a session manager the round trip
still works in-process, exactly as before, but a restart between the two halves
loses the answer.

> **Compatibility note.** A frontend call now carries Strands' native
> `toolUseId` as its AG-UI `tool_call_id`, where it previously carried a
> freshly minted UUID. That is what makes a persisted placeholder findable by
> the id the client answers under. A client that only echoes the
> `tool_call_id` back is unaffected. One that derived or stored its own meaning
> from the old value will see a different string.
>
> The native id has to be non-blank and unique across the transcript for this
> to work, so a missing, in-turn duplicate or reused id fails the run with
> `FRONTEND_TOOL_IDENTITY_ERROR` rather than putting a wire id on the stream
> that names nothing durable. Providers that do not supply stable ids should be
> upgraded, or kept away from parallel frontend calls.

Python's version of this path additionally reports a duplicate or conflicting
answer under codes of its own, and can park a frontend call in a native Strands
interrupt rather than halting. Neither has a counterpart here; see
[`../error-codes.json`](../error-codes.json) and the Python README.

> **Breaking change for tool bodies.** A resolved generic interrupt used to
> reach the tool as the raw `payload`, and a cancellation as
> `{ status: "cancelled" }`. Any tool reading the raw value must now read it off
> `.response`, and a cancellation off `.cancelled`. A resolved tool approval is
> unaffected, still receiving its payload raw; a cancelled one now receives
> `{ approved: false }` where it previously received `{ status: "cancelled" }`. It follows `@ag-ui/aws-strands` 0.2.3; the release that carries it
> is versioned in a separate bump commit, and this is not patch-compatible.

## Reasoning / extended thinking

`REASONING_*` events arrive only when the underlying Strands model has been
asked for thinking or reasoning content. A model constructed with none returns
plain text and the adapter has nothing to stream.

The `/agentic-chat-reasoning` demo asks for it explicitly rather than relying on
a default, through the shared factory:

```ts
model: await createModel({ openaiApi: "responses", reasoning: true });
```

`model-factory.ts` turns that into whatever the selected `MODEL_PROVIDER` needs:
reasoning summaries on OpenAI's Responses API, extended thinking on Anthropic,
the same thinking block on Bedrock. It wires nothing for Gemini, so that provider
emits no `REASONING_*` events whatever the flag says.

Wiring a model yourself, the Bedrock form is:

```ts
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";

const model = new BedrockModel({
  modelId: "global.anthropic.claude-sonnet-4-6",
  // Anthropic-on-Bedrock requires temperature 1 while thinking is enabled.
  temperature: 1,
  additionalRequestFields: {
    thinking: { type: "enabled", budget_tokens: 5000 },
  },
});
```

## Citations

When you give a model documents and turn citations on, its answer comes back
with the passages it drew from: which document, where in that document, and the
text of the passage itself. That is what lets an interface show "according to
quarterly-report.pdf" next to a claim instead of asking the reader to take the
answer on trust. Bedrock calls these citations. Strands documents them only as
an API reference, at
[`CitationsBlock`](https://strandsagents.com/docs/api/typescript/CitationsBlock/).

The model emits them between the text deltas of the answer, so a citation
arrives in the middle of the message it belongs to. This adapter attaches them
to that message rather than emitting them separately, which is what keeps a
citation joined to the thing it annotates.

### Where they arrive

Under the `citations` key of the assistant message's `metadata`, as a list. The
key and the entry type are exported as `CITATIONS_METADATA_KEY` and
`AguiCitation`:

```ts
import { CITATIONS_METADATA_KEY, type AguiCitation } from "@ag-ui/aws-strands";

const cited = message.metadata?.[CITATIONS_METADATA_KEY] as
  | AguiCitation[]
  | undefined;
```

```json
{
  "citations": [
    {
      "title": "quarterly-report.pdf",
      "sourceContent": [{ "text": "revenue grew 12%" }],
      "location": {
        "type": "documentChar",
        "documentIndex": 0,
        "start": 10,
        "end": 26
      },
      "textOffset": 17
    }
  ]
}
```

| Field           | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `title`         | Title of the cited source, when the provider supplies one               |
| `source`        | Source identifier, typically a URL for web citations                    |
| `sourceContent` | The passage in the source document that supports the answer             |
| `location`      | Where that passage sits in the source, discriminated by `type`          |
| `content`       | The generated text the citation supports, where the provider reports it |
| `textOffset`    | UTF-16 code units of this message's text streamed when it arrived       |

Which of these a response actually carries is the provider's choice. Bedrock
sends `title`, `sourceContent` and `location`; it sends no `source` and no
generated `content`, so both are absent on that path, in this adapter and in the
Python one alike. The SDK's OpenAI Responses adapter sends `source` and
`content` and a web location instead.

`location` is `{ type: "documentChar" | "documentPage" | "documentChunk",
documentIndex, start, end }` for document sources, `{ type: "searchResult",
searchResultIndex, start, end }` for search results, and `{ type: "web", url,
domain? }` for web ones. The union is exported as `AguiCitationLocation`.

A location must arrive in one of two tagged forms: Bedrock's single-key wrapper
(`{ documentChar: { ... } }`) or a discriminated object carrying a string
`type`. Anything else cannot be placed, so the location is omitted and a warning
names what was dropped; the citation itself is kept, since a provider that sent
an unreadable location still named a source.

Bedrock names the search-result kind `searchResultLocation` and this SDK renames
it to `searchResult`; the Python adapter applies the same rename so both bridges
agree on it. A kind neither SDK names yet never arrives here at all: the SDK's
Bedrock mapper logs an unknown location and drops the citation with it, where
the Python adapter passes it through. The asymmetry is upstream.

A field the provider did not supply is absent rather than empty, and a citation
that names no source at all is dropped rather than emitted as a bare
`textOffset`. A generated `content` span does not count as naming one, which
matters here rather than on the Python side, since this is the bridge where
`content` arrives: it is the text being annotated, not the thing annotating it. One that will not survive JSON encoding is dropped too, with a
warning: metadata rides an event that is encoded for the stream, and a value
that fails to encode would end the run early.

The key is a plain metadata key, not AG-UI's reserved `ag-ui` one. Metadata is
open by key and user space is yours, so an application already storing something
under `citations` should rename it.

### Where the two adapters agree, and where they do not

For a Bedrock response this adapter and the Python one emit equal citation
objects. That is what the normalisation is for: this SDK coalesces a
missing `source` or `title` to `""` and those empties are dropped here, Python
receives Bedrock's key-wrapped `location` and unwraps it to the same
discriminated form, and both omit absent fields.

They do not agree for every provider. Strands reports the generated span on the
delta rather than on the citation, and the Python SDK's stream shape has no
equivalent field, so a provider that supplies one (the OpenAI Responses adapter)
reaches a TypeScript client with `content` and `source`. A Python client is
without the `content`, since that SDK's stream shape has no field for the
generated span, but not necessarily without the `source`: `citations.py` reads
`source` whenever the value is there, so what a Python client gets depends on
the provider path rather than on the adapter.

### How precisely they can be placed

**Message level is the ceiling, and it bounds what a frontend can render.** A
citation locates a span in the _source_ document. It carries no offset into the
answer, and AG-UI has no anchor for a span inside a message, so nothing here can
promise "these words came from that passage".

`textOffset` is the adapter's best effort at closing that gap: it records how
much of the message had been streamed when the citation arrived. Bedrock emits a
citation after the text it supports, which makes the offset the end of the
annotated span in practice, but that is the provider's ordering rather than a
guarantee, so treat a marker placed with it as approximate. Where the provider
reports `content`, that is the generated span itself and is exact.

`textOffset` is counted in **UTF-16 code units**, not characters. The number is
an index into the message text a client holds, and the clients that will slice
with it are browsers, where string indices are UTF-16 units. Both adapters count
the same units, so an answer containing an emoji does not shift the marker on
one side and not the other.

### What a client sees while streaming

The list is republished as it grows, so a client holds a whole prefix at every
point rather than a fragment:

1. A citation arrives and is attached to the next `TEXT_MESSAGE_CONTENT`, so it
   is visible while the answer is still being written.
2. Each publish carries every citation seen so far for that message. Metadata
   merging replaces a key's value rather than appending to it, so the complete
   list is the only correct thing to send.
3. `TEXT_MESSAGE_END` carries the final list, which is how a citation with no
   text after it reaches the client at all.
4. The assistant message inside the following `MESSAGES_SNAPSHOT` carries the
   same list. A snapshot replaces the message a client assembled, so without it
   the citations would vanish the moment one arrived. That also applies to the
   snapshot seeded from `RunAgentInput.messages` at the start of a later turn,
   which is why the rebuild preserves a message's existing metadata.

Citations belong to the message that was open when they arrived. A tool call
closes that message and rotates its id, and the next message starts with none. A
citation that arrives when no message is open has nothing to annotate, so it is
dropped with a warning rather than carried onto whatever message comes next.

On the multi-agent orchestrator path there is no `MESSAGES_SNAPSHOT` at all, so
point 4 does not apply there and the node's `TEXT_MESSAGE_END` is the final
carrier. That path keeps one accumulator for the run rather than one per node,
where the Python adapter keys both per node; in practice a node's turn is closed
when it finishes, so its citations still land on its own message, and the
difference shows only for nodes whose output genuinely interleaves.

### Chunk mode

`emitChunkEvents` replaces the message triple with `TEXT_MESSAGE_CHUNK` and has
no equivalent of `TEXT_MESSAGE_END`. That event is where a citation arriving
after the last text delta travels, so its metadata is re-emitted as a final
continuation chunk carrying nothing else. The client transform turns a
metadata-only chunk into a zero-delta content event, which is how the value
still reaches the reducer without re-opening the message.

This matters most where there is no fallback: the multi-agent orchestrator path
emits no `MESSAGES_SNAPSHOT` at all, whatever `emitMessagesSnapshot` says, so
the chunk is the only carrier a trailing citation has there.

`features.citations` is therefore `true` in every configuration.

## Install

```bash
pnpm add @ag-ui/aws-strands @strands-agents/sdk \
  @ag-ui/core @ag-ui/client @ag-ui/encoder @ag-ui/a2ui-toolkit
# All four @ag-ui peers are non-optional: the package root imports `@ag-ui/client`
# for the AWSStrandsAgent shim and `@ag-ui/a2ui-toolkit` for the A2UI tool.
# @strands-agents/sdk carries three non-optional peers of its own,
# @modelcontextprotocol/sdk, @opentelemetry/api and zod, so your package manager
# will ask for those too.
# Server-side helpers (createStrandsApp / addStrandsExpressEndpoint) require express:
pnpm add express
pnpm add -D @types/express
# `cors` is loaded only when `createStrandsApp` installs the middleware, which
# needs a truthy `corsOrigin` that `corsEnabled: false` has not vetoed.
# Skip the next two lines unless you opt into cross-origin access:
pnpm add cors
pnpm add -D @types/cors
# @modelcontextprotocol/sdk is one of the three SDK peers noted above, and is
# reachable from its entry whether or not your agent uses MCP. Listed separately
# only because this package's own manifest marks it optional:
pnpm add @modelcontextprotocol/sdk
```

## Server: Expose a Strands Agent via AG-UI

```ts
import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";

// `model` accepts either a Bedrock model ID string or a constructed
// Model instance (e.g. BedrockModel / AnthropicModel / OpenAIResponsesModel).
// Omitting it uses Strands' current Bedrock default.
const strandsAgent = new Agent({
  systemPrompt: "You are a helpful assistant.",
  tools: [],
});

const aguiAgent = new StrandsAgent({
  agent: strandsAgent,
  name: "MyAgent",
  description: "A Strands agent exposed via AG-UI",
});

const app = await createStrandsApp(aguiAgent, { path: "/invocations" });
app.listen(8000);
```

## Cross-Origin Access

`createStrandsApp` does not allow cross-origin access unless you ask for it.
Omit `corsOrigin` and no CORS middleware is installed: responses carry no
`Access-Control-Allow-Origin` header, so a browser refuses to hand any response
from this app to a page on a different origin. A page served from the same
origin as the app reads it as usual, since CORS governs cross-origin requests
only.

That default matters because the agent route is unauthenticated unless you pass
[`auth`](#authenticating-the-agent-route). An allowed origin can invoke the
agent, trigger whatever side effects its tools have, and read the streamed
response, so cross-origin access is a deliberate choice rather than a starting
position.

```ts
// Default: no cross-origin access.
const app = await createStrandsApp(aguiAgent, { path: "/invocations" });

// Local development: literal `*`, emitted verbatim, never reflected.
const dev = await createStrandsApp(aguiAgent, { corsOrigin: "*" });

// Production: an exact-match allowlist.
const prod = await createStrandsApp(aguiAgent, {
  corsOrigin: ["https://app.example.com", "https://admin.example.com"],
});
```

`corsOrigin` accepts:

| Value                    | Effect                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| omitted                  | No CORS middleware; no CORS header on any response                               |
| `"*"`                    | Literal `Access-Control-Allow-Origin: *`, emitted verbatim, never reflected      |
| `["*"]`                  | Collapsed to the bare `"*"` before `cors` sees it, so allow-all                  |
| `["*", "https://a.tld"]` | Any array containing `"*"` collapses the same way; the named origins are dropped |
| `"https://app.tld"`      | That one origin, emitted verbatim whichever origin asked                         |
| `["https://a.tld"]`      | Exact-match allowlist; a miss withholds `Access-Control-Allow-Origin`            |
| `[]`                     | The allowlist path with nothing on the list, so every origin misses              |
| `true`                   | Reflects the calling origin back per request; see the warning below              |
| `false`                  | No CORS middleware; identical to omitting `corsOrigin`                           |
| `""`                     | Same as `false`                                                                  |

A `"*"` anywhere in an array collapses the whole array to the bare string
`"*"` before `cors` is constructed, so `["*"]` and `["*", "https://a.tld"]` are
both allow-all and are measured byte-identical to passing `"*"` on its own. The
concrete entries alongside a `"*"` are dropped rather than honoured, which is
worth knowing before writing an allowlist that quietly is not one. `cors` itself
only ever sees the collapsed value, so nothing downstream can tell an array was
passed.

An allowlist miss, `[]` included, is not a silent no-op. Measured against
`cors` 2.8.5 on Express 5, a preflight from a disallowed origin comes back
`204` carrying `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`;
the only header withheld is `Access-Control-Allow-Origin`, and that omission is
what makes the browser block the response. A miss against a named allowlist
also carries `Access-Control-Allow-Credentials: true`, since the policy names
specific origins even on the call that matched none of them; `[]` names none at
all and so carries no credentials header on any response. `false` and `""`
behave differently again: the factory reads them as falsy and installs no
middleware, so the preflight falls through to Express's own `OPTIONS` responder
(`200`, `Allow: POST`) and no CORS header is emitted at all. The optional `cors`
dependency is not even loaded for them.

When it installs the middleware, `createStrandsApp` derives `credentials`
rather than passing a fixed value, and `CreateStrandsAppOptions` offers no way
to override the derivation. Two conditions, and both have to hold:

1. **The policy has to name a site.** A non-empty origin string other than
   `"*"` and `"null"`, an array with an entry other than those, or `true`. So
   `"*"`, `"null"`, `[]`, `["*"]`, `["*", "https://a.tld"]` and `["null"]` emit
   no credentials header on any response, whoever calls.
2. **The caller's own `Origin` has to name a site.** Any policy in the first
   group can end up answering a request whose `Origin` is the literal `null`:
   `true` reflects it, an allowlist can list it, and a fixed origin string is
   echoed at it. Such a request never carries the credentials header, whatever
   the policy allows for everyone else.

`cors` is handed those options per request rather than once at construction,
which is what keeps the second condition from costing anyone else their
credentials.

`"null"` is the `Origin` a browser sends from a sandboxed iframe, a `file://`
page and some redirect chains. It belongs to no site, so nothing tells one such
caller from another, and credentials granted against it are granted to whatever
can present it. That is the same objection as for `"*"`, with one difference:
browsers reject a literal wildcard paired with credentials outright, while they
honour the `null` pairing, so this is the one of the two where the grant would
have reached the caller.

Listing `"null"` still admits those callers, and the rest of the list is
untouched: `["null", "https://a.tld"]` is a working allowlist whose named site
keeps its credentials, while a caller outside the list still misses and the
null caller is admitted without credentials.

Both spellings are compared exactly. `cors` matches allowlist entries against
the request's `Origin` with `===`, and a browser compares the
`Access-Control-Allow-Origin` it receives against its own origin serialization
byte for byte, so `"NULL"` or a trailing slash matches nothing on either side
and grants nothing: a mis-spelled entry fails closed rather than slipping past
the check.

> **`corsOrigin: true` is the value to be careful with, not `"*"`.** `true`
> reflects whatever `Origin` the request carried straight back in
> `Access-Control-Allow-Origin`, per request, and because a reflected origin is
> a specific origin the derivation above keeps credentials on, so that origin
> arrives paired with `Access-Control-Allow-Credentials: true`. Browsers honour
> that pair for a credentialed request (`credentials: "include"`), so `true`
> lets a page on any site make a credentialed cross-origin call to the agent
> route and read the streamed response. On a route with no `auth` guard, that is
> every site the browser visits. Prefer an exact-match array. The one caller it
> does not credential is the one whose `Origin` is `null`, which belongs to no
> site.
>
> `"*"` fails in the safer direction, and now does so twice over. The
> derivation withholds the credentials header from a wildcard policy in the
> first place, so it is never sent; and the CORS protocol tells browsers to
> reject a literal wildcard combined with credentials anyway, so a wildcard
> only ever serves requests that send none. Either way the `corsOrigin: "*"`
> suggested above for local development cannot carry cookies. Name the origins
> explicitly when the browser has to send them.

Both adapters refuse the same two origin values credentials. Python's
`create_strands_app` computes
`allow_credentials=bool(origins) and not {"*", "null"}.intersection(cors_origins)`,
where `cors_origins` is `origins or ["*"]`,
which is the first of the two conditions above. It has no equivalent of the
second: Starlette takes one `allow_credentials` for the whole policy, so
`origins=["null", "https://a.tld"]` withholds credentials from the named site
too, where the TypeScript adapter withholds them only from the null caller.
Nothing reflects an arbitrary origin on the Python side, so there is no
`corsOrigin: true` there to credential a null caller through. What else differs
is the
default: Python adds `CORSMiddleware` to every app and falls back to
`allow_origins=["*"]` whenever `origins` is omitted or empty, emitting a
`FutureWarning` for that implicit wildcard rather than refusing it, while
TypeScript installs nothing until you pass `corsOrigin`. So Python is open to
every origin until you name one, and TypeScript grants no cross-origin access
until you ask for it.

> **Compatibility break.** Before this change the factory installed CORS
> middleware unconditionally and defaulted to `corsOrigin: "*"`, so every
> browser origin was allowed. Deployments that relied on that implicit default
> now have to pass `corsOrigin` explicitly. Explicit values are unaffected.
>
> **Compatibility break.** A request whose `Origin` is the literal `null` no
> longer receives `Access-Control-Allow-Credentials: true`, and neither does a
> policy that names nothing but `"null"`. Such requests previously got the
> header, and a browser honoured it, so a sandboxed iframe or `file://` page
> could make a credentialed call: through a list naming `"null"`, through a
> reflection under `corsOrigin: true`, or through a fixed origin string echoed
> at it. Credentials now have to belong to a named site on both sides. Nothing
> else changes: those callers are still admitted exactly as before, and no
> other caller loses anything, including the named entries of an allowlist that
> also lists `"null"`.

Cross-origin policy is only one of two defenses here. Requests without a JSON
`Content-Type` are refused with HTTP 415 before the agent runs, which blocks the
simple, non-preflighted variant of the same attack. Neither one is a substitute
for authentication: pass [`auth`](#authenticating-the-agent-route) if the
endpoint is reachable from an untrusted network.

### Narrowing methods and headers

`allowMethods` and `allowHeaders` are passed straight to `cors` as `methods` and
`allowedHeaders`. Omit them and the `cors` defaults apply, measured against
`cors` 2.8.5 on Express 5:

- `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`.
- `Access-Control-Allow-Headers` reflects the preflight's own
  `Access-Control-Request-Headers` verbatim, and is absent entirely when the
  preflight sends none.

Narrowing either one replaces the corresponding default. Narrowing
`allowHeaders` also pins the list regardless of what the preflight asked for, so
`Access-Control-Allow-Headers: Content-Type` comes back even for a preflight
that sent no `Access-Control-Request-Headers` at all:

```ts
const app = await createStrandsApp(aguiAgent, {
  path: "/invocations",
  corsOrigin: ["https://app.example.com"],
  allowMethods: ["POST"],
  allowHeaders: ["Content-Type"],
});
```

Three details worth knowing:

- Narrowing the method list does not make `cors` reject a preflight for a
  method outside it. A `DELETE` preflight against `allowMethods: ["POST"]`
  still answers `204` carrying `Access-Control-Allow-Methods: POST`, and the
  browser is what enforces the narrowing.
- **A narrowed `allowHeaders` has to include `Content-Type`.** The agent route
  answers `415` to any request without a JSON `Content-Type` (measured: both an
  absent `Content-Type` and `text/plain` come back
  `415 {"error":"Unsupported Media Type: expected application/json"}`), and
  `application/json` is not a CORS-safelisted request header value, so a browser
  only sends it once a preflight has permitted `Content-Type`. Leave it off the
  list and every cross-origin agent call is blocked, while the preflight still
  answers `204` carrying the narrowed list: a healthy-looking response for a
  route nothing can reach. Server-side callers (curl, another service) are
  unaffected, since CORS never applies to them.
- **`[]` is a deny-all, not a request for the default.** An empty array is
  truthy, so it reaches `cors`, which withholds the corresponding header
  entirely rather than sending it empty. Measured: `allowMethods: []` answers a
  preflight `204` with no `Access-Control-Allow-Methods`, `allowHeaders: []`
  with no `Access-Control-Allow-Headers`, and both leave
  `Access-Control-Allow-Origin` intact. That mirrors how `corsOrigin: []` denies
  every origin and is deliberate, but the only symptom is in the caller's
  browser console, so `createStrandsApp` warns at startup when it installs a
  policy carrying either empty list.

Those defaults deliberately do not match the Python side, where
`create_strands_app` passes `allow_methods=["*"]` and `allow_headers=["*"]`.
The `cors` defaults are already narrower, neither option existed in the
TypeScript adapter before, so there is no back-compatibility to preserve, and
widening them to match would be a security regression rather than parity.

Both options only mean something once the middleware is installed. Passing
either with no `corsOrigin` policy throws at construction, naming the options
passed and the fix, rather than silently doing nothing.

#### What ends up in `Vary`

`Vary` on the preflight is assembled from two halves with independent causes,
which is why there is no single default to quote. Measured across every origin
posture and every combination of narrowed, empty and omitted `allowMethods` /
`allowHeaders`:

| Half of `Vary`                   | Present when                                                |
| -------------------------------- | ----------------------------------------------------------- |
| `Origin`                         | The origin policy does not resolve to the bare string `"*"` |
| `Access-Control-Request-Headers` | `allowHeaders` is omitted, whatever `allowMethods` says     |

The `Origin` half is the cache-safety one: it is what stops a shared cache
serving one origin's response to another, and it turns on and off with the
origin form rather than with the narrowing options. A `"*"` sends the same
`Access-Control-Allow-Origin` to every caller, so the response does not depend
on who asked and `cors` correctly leaves `Origin` out. That covers the arrays
that collapse to `"*"` too, since the collapse happens before `cors` is
constructed. A single origin string, an array with no `"*"` in it (matching or
not), `[]` and `true` all emit it.

The `Access-Control-Request-Headers` half is not about the caller's origin at
all. It is present only while the answer depends on what the preflight asked
for, which stops being true the moment `allowHeaders` fixes the set. Narrowing
`allowMethods` moves neither half.

The four combinations that follow, on a preflight:

| Origin policy     | `allowHeaders`   | `Vary`                                   |
| ----------------- | ---------------- | ---------------------------------------- |
| resolves to `"*"` | omitted          | `Access-Control-Request-Headers`         |
| resolves to `"*"` | narrowed or `[]` | absent entirely                          |
| anything else     | omitted          | `Origin, Access-Control-Request-Headers` |
| anything else     | narrowed or `[]` | `Origin`                                 |

Non-preflight responses never carry the `Access-Control-Request-Headers` half.
They carry `Vary: Origin` on every posture except the ones resolving to `"*"`,
which carry no `Vary` at all, and neither narrowing option changes that.

### One switch for turning CORS off

`corsEnabled` is a veto over `corsOrigin`, for callers that compute the origin
policy somewhere else (an env var, shared config) and want one independent
switch:

| `corsEnabled`         | `corsOrigin`        | Result                                                                                                      |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `false`               | anything, or absent | No middleware. Also silences `allowMethods` / `allowHeaders` with no complaint; `cors` is never even loaded |
| `undefined` (default) | truthy              | Middleware installed, exactly as without the option                                                         |
| `undefined` (default) | falsy, or absent    | No middleware                                                                                               |
| `true`                | truthy              | Middleware installed; redundant but accepted                                                                |
| `true`                | falsy, or absent    | Throws at construction                                                                                      |

`corsEnabled: false` is byte-identical on the wire to `corsOrigin: false`, so as
a disable switch it is a second spelling. Its value is compositional: one place
to turn cross-origin access off without reaching into wherever `corsOrigin` is
computed.

`corsEnabled: true` with no origin policy throws rather than installing
anything, because the two alternatives are both wrong. Installing `cors()` with
no `origin` would restore the wildcard by the back door, since `cors`'s own
default `origin` is `'*'`. Installing nothing silently would leave a caller who
explicitly asked for CORS to discover from a browser console that it is off.
This option can never widen access on its own.

### Cross-origin policy in the examples

Both of this package's example servers, the dojo and the one standalone demo that opts in, are origin-restricted by default and read the same
`CORS_ALLOW_ORIGINS` variable (comma-separated), parsed once in
`examples/server/cors.ts`:

| `CORS_ALLOW_ORIGINS`     | Policy                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| unset                    | `http://localhost:9999,http://localhost:3000`, the origins a locally run dojo is served from |
| a comma-separated list   | That exact-match allowlist                                                                   |
| contains `*`             | The bare wildcard, which is the development opt-in to any origin                             |
| set but naming no origin | Denies every origin, and says so on startup                                                  |

Two of those rows log a warning rather than applying quietly: `*` alongside
named origins warns that the wildcard wins and the named entries are ignored,
and a set-but-empty value warns that every cross-origin browser request is
denied. A third warning is per entry rather than per row: `cors` compares
allowlist entries to the request's `Origin` verbatim, so an entry that can never
equal one, because it has no `scheme://` prefix, or carries a trailing slash,
path, query or fragment, or uses uppercase letters a browser never sends, is
named along with the reason instead of printing as though it were allowed. Each
server also prints the policy it resolved as it starts listening.

The dojo server (`examples/server/server.ts`) applies it with its own `cors`
middleware; `examples/server/api/tool-based-generative-ui.ts` is the one
standalone example that opts in, passing the parsed value as
`createStrandsApp`'s `corsOrigin`. The other standalone examples pass no
`corsOrigin` and stay closed. None of this is in the path for the dojo itself,
which reaches the examples from its own server-side route handler, or for curl:
it is for pointing a browser page straight at one of these servers.

## Authenticating the Agent Route

The agent route is unauthenticated by default. Pass `auth` to guard it, on
either entry point:

```ts
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import type { StrandsAuthMiddleware } from "@ag-ui/aws-strands/server";

const requireBearer: StrandsAuthMiddleware = (req, res, next) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== process.env.AGENT_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

const app = await createStrandsApp(aguiAgent, {
  path: "/invocations",
  auth: requireBearer,
});
```

```ts
// Same option on the low-level helper, for an app you build yourself.
import express from "express";
import { addStrandsExpressEndpoint } from "@ag-ui/aws-strands/server";

const app = express();
addStrandsExpressEndpoint(app, aguiAgent, {
  path: "/invocations",
  auth: requireBearer,
  bodyParser: express.json({ limit: "50mb" }),
});
```

It is plain Express middleware, `(req, res, next)`, which is what the ecosystem
of guards you would actually reach for already is: `express-jwt`,
`passport.authenticate(...)`, or a hand-written check like the one above. An
existing Express `RequestHandler` assigns to `auth` with no cast. The return
value is ignored, but a returned promise is awaited, so an `async` guard that
rejects fails closed instead of hanging the request.

The request has to be admitted explicitly by calling `next()`. A guard that
returns without touching the response neither admits nor rejects, which is what
lets an ordinary callback-style middleware call `next()` long after it returns.
The 401 body is whatever your middleware writes; the adapter does not invent
one.

What the adapter guarantees around it:

- **The agent never runs for a rejected request.** The guard is route
  middleware registered ahead of the agent handler, so `next()` is the only
  thing that advances to it. A middleware that answers the request and then
  calls `next()` anyway does not advance either, which is what stops a
  streaming agent writing into a response that is already finished.
- **Failures fail closed and quietly.** A thrown error, a rejected promise, or
  `next(error)` answers the error's own `status` or `statusCode` when that is a
  usable HTTP error code, which is how `express-jwt` and `passport` report a
  rejected credential, and `500` otherwise. The body is the generic reason
  phrase for that status and never the error's own message, so no internal
  detail and no stack frame reaches the client, and the error is logged
  server-side through the adapter's logger. If the response head is already on
  the wire there is no status left to set, so the connection is dropped; if the
  response has already finished, it is left alone. `next("route")` and
  `next("router")` are Express control-flow signals rather than failures and are
  forwarded as such.
- **`auth` runs before body parsing and before the request-boundary checks.**
  `createStrandsApp` mounts the guard, `express.json()`, and the agent handler
  in that order within one `POST` route. An unauthenticated request is declined
  before its body is read, and `next("route")` skips the parser and agent
  together. A non-JSON `Content-Type` gets `401` rather than the `415` it would
  get without a guard, and a body the JSON parser would reject gets `401`
  rather than the parser's own `400`. Authenticating before telling an
  anonymous caller anything about the request contract is the intended order;
  `415` and `400` still bite behind a guard that passes.

  With `addStrandsExpressEndpoint`, pass your parser through `bodyParser` as in
  the example above. Do not put an app-wide body parser before the endpoint if
  auth-before-parsing matters: Express always runs earlier app middleware
  first. You can still mount an app-wide parser after the endpoint for other
  routes.

- **`/ping` and `/capabilities` stay open.** Health probes have to keep
  working, and the capabilities document is a static matrix of what this
  adapter supports rather than user data.

### Relationship to the Python adapter

`auth`, `corsEnabled`, `allowMethods` and `allowHeaders` all have Python
counterparts now. `create_strands_app` in
`python/src/ag_ui_strands/utils.py` takes `(agent, path="/", ping_path="/ping",
origins=None, auth=None, allow_methods=None, allow_headers=None,
cors_enabled=None, invocation_state_provider=None)`, so the guard hook, the off
switch and the method and header narrowing exist on both sides and this surface
is level rather than TypeScript-only. That last parameter has no TypeScript
counterpart.

One divergence remains, and it is the default. TypeScript installs no CORS
middleware until you pass `corsOrigin`, while `create_strands_app` adds
`CORSMiddleware` on every app and falls back to `allow_origins=["*"]` whenever
`origins` is omitted or empty, warning about that implicit wildcard with a
`FutureWarning` rather than refusing it. TypeScript could flip the default
outright rather than easing into it because it has a second boundary in front of
the agent: the endpoint answers `415` to any request without a JSON
`Content-Type` before dispatching, which already blocked the simple,
non-preflighted form of the same cross-origin call.

## Configuration

```ts
import {
  StrandsAgent,
  type StrandsAgentConfig,
  type ToolBehavior,
} from "@ag-ui/aws-strands";

const config: StrandsAgentConfig = {
  toolBehaviors: {
    set_recipe: {
      stateFromArgs: async (ctx) => ({ recipe: ctx.toolInput }),
      predictState: [
        { stateKey: "recipe", tool: "set_recipe", toolArgument: "data" },
      ],
    },
    render_chart: {
      stopStreamingAfterResult: true,
    },
  },
  sessionManagerProvider: async (input) => {
    // Optional: vend a SessionManager per-thread from your own state store.
    return undefined;
  },
  stateContextBuilder: (input, prompt) => {
    // Optional: decorate the outgoing prompt with any server-side state.
    return prompt;
  },
  // Optional: any { debug, warn, error } record. Wire in pino / winston /
  // bunyan, or a silent stub. Defaults to an internal console logger.
  logger: console,
  // Optional: collapse the *_START / *_CONTENT / *_END triples into
  // self-expanding *_CHUNK events. Off by default.
  emitChunkEvents: false,
};

const agent = new StrandsAgent({ agent: strandsAgent, name: "x", config });
```

## Low-Level Transport

If you have an existing Express app, mount the endpoint directly instead of
using `createStrandsApp`:

```ts
import express from "express";
import { addStrandsExpressEndpoint, addPing } from "@ag-ui/aws-strands/server";

const app = express();
addStrandsExpressEndpoint(app, aguiAgent, {
  path: "/invocations",
  bodyParser: express.json({ limit: "50mb" }),
});
addPing(app, "/ping");
```

Mounting the endpoint yourself means you own the cross-origin policy too. Add
`cors` middleware only if a browser on another origin has to reach the endpoint,
and give it an explicit allowlist when you do.

`addStrandsExpressEndpoint` takes the same
[`auth`](#authenticating-the-agent-route) option as `createStrandsApp`, so the
guard travels with the route rather than with the app you built around it.
Pass `express.json()` (or another compatible request handler) as `bodyParser`
to place it between that guard and the agent. Both entry points reject unknown
option keys and invalid option value types during setup instead of silently
discarding a misspelled or malformed security option.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
