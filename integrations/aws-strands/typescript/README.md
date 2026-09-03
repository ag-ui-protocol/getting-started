# AWS Strands Integration for AG-UI (TypeScript)

This package exposes a lightweight wrapper that lets any `@strands-agents/sdk` `Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to Express via `createStrandsApp` (or `addStrandsExpressEndpoint`).

## Features

- **Full event coverage** – text, reasoning, tool calls, state, message history and multimodal content, translated straight off `Agent.stream()`
- **Human-in-the-loop** – frontend proxy tools and native Strands interrupts, on a resume contract shared with the Python bridge
- **Generative UI** – `PredictState` custom events, plus A2UI surfaces and the validate-and-retry recovery loop
- **Multi-agent** – pass a Strands `Graph` or `Swarm` where an `Agent` would go, and each node streams inside its own step
- **Express transport** – `createStrandsApp` / `addStrandsExpressEndpoint` over SSE from the `@ag-ui/aws-strands/server` subpath, kept off the main entry so client bundlers do not pull in Express
- **Citations** – provider source passages attached to the assistant message they annotate

## Prerequisites

- Node.js 20+, which is `@strands-agents/sdk`'s own floor; 20.19+ or 22.12+ to
  `require()` this package from CommonJS, since the SDK is ESM-only; 20.12+ for
  the demos under `examples/`.
- `pnpm` (recommended) or `npm`, and a Strands-compatible model key: AWS
  credentials for Bedrock, `OPENAI_API_KEY` for OpenAI.

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

Or run one example on its own port (default `8000`) with `pnpm <demo>`, where
`<demo>` is the route name below: `pnpm shared-state`, `pnpm interrupt`, and so
on for each demo that ships a script.

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

## Key Files

| File                       | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `src/agent.ts`             | Core wrapper translating Strands streams into AG-UI events                      |
| `src/config.ts`            | Config primitives (`StrandsAgentConfig`, `ToolBehavior`, `PredictStateMapping`) |
| `src/server.ts`            | `createStrandsApp` + Express transport (subpath: `@ag-ui/aws-strands/server`)   |
| `src/endpoint.ts`          | Express endpoint helpers (used by `server.ts`)                                  |
| `src/utils.ts`             | Multimodal content conversion and the `UrlFetchPolicy` that guards it           |
| `src/client-proxy-tool.ts` | Dynamic frontend tool registration/deregistration                               |
| `src/citations.ts`         | Provider citations normalised onto the message they annotate                    |
| `src/a2ui-tool.ts`         | A2UI tool injection and the validate-and-retry recovery loop                    |
| `src/session-reconcile.ts` | Frontend-result reconciliation against a persisted session                      |
| `examples/server/api/*.ts` | One factory per demo; eleven carry a standalone runner, ten of those scripted   |

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

## Configuration

```ts
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";

const config: StrandsAgentConfig = {
  toolBehaviors: {
    set_recipe: {
      stateFromArgs: async (ctx) => ({ recipe: ctx.toolInput }),
      predictState: [
        { stateKey: "recipe", tool: "set_recipe", toolArgument: "data" },
      ],
    },
    render_chart: { stopStreamingAfterResult: true },
    confirm_delete: { interruptOnCall: true },
  },
  sessionManagerProvider: async (input) => yourSessionManager(input.threadId),
  stateContextBuilder: (input, prompt) => prompt,
  logger: console, // any { debug, warn, error } record
  emitChunkEvents: false,
};

const agent = new StrandsAgent({ agent: strandsAgent, name: "x", config });
```

## Supported AG-UI Events

| Family      | Events                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| Lifecycle   | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`                                                   |
| Text        | `TEXT_MESSAGE_START` / `_CONTENT` / `_END`, or `TEXT_MESSAGE_CHUNK` under `emitChunkEvents`  |
| Reasoning   | `REASONING_*`, for a model that was asked for thinking content                               |
| Tools       | `TOOL_CALL_START` / `_ARGS` / `_END` / `_RESULT`, or `TOOL_CALL_CHUNK`                       |
| State       | `STATE_SNAPSHOT`; `STATE_DELTA` only where a `customResultHandler` emits one                 |
| History     | `MESSAGES_SNAPSHOT`, on by default; off via `emitMessagesSnapshot` or `skipMessagesSnapshot` |
| Multi-agent | `STEP_STARTED`, `STEP_FINISHED`, `CUSTOM` `MultiAgentHandoff`                                |
| Custom      | `PredictState`, `AgentStopped`, `hook_error`                                                 |
| Passthrough | `RAW`, for Strands events this adapter does not map                                          |

The live matrix is served at GET `/capabilities`, on by default, and is
overridable through `createStrandsApp` or `addCapabilities`.

## Human-in-the-loop interrupts

A frontend tool declared in `RunAgentInput.tools` is auto-registered as a proxy
tool, and the adapter halts the run once the proxy resolves (`/human-in-the-loop`
in the dojo). A backend hook or tool can pause itself with `event.interrupt(...)`
/ `context.interrupt(...)`, and the adapter forwards the outstanding interrupts
under `RUN_FINISHED`'s `outcome.interrupts` (`/interrupt` in the dojo).

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
hook. An interrupt raised anywhere else under it is answered as an approval.

### The resume contract

The next `RunAgentInput` carries `resume[]` entries keyed by those `id`s, which
become Strands `InterruptResponseContent`. An unknown `interruptId`
short-circuits with `RUN_ERROR { code: "UNKNOWN_INTERRUPT_ID" }` per
[interrupts.mdx rule 2](https://docs.ag-ui.com/concepts/interrupts). `interrupt()`
does **not** return `payload` directly; the adapter hands Strands an envelope,
which is what makes one tool body portable across bridges:

| `resume[]` entry                    | what the paused `interrupt()` returns                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| `status: "resolved"`, any `payload` | `{ response: payload }`                                            |
| `status: "resolved"`, no `payload`  | `{ response: null }`                                               |
| `status: "cancelled"`               | `{ cancelled: true }`, matching the exported `INTERRUPT_CANCELLED` |

Destructure it with `.response` / `.cancelled`, and do not truthiness-check the
envelope itself. Compare a cancellation by value rather than identity: every
answer is a fresh copy of the exported `INTERRUPT_CANCELLED`. Treat it as
read-only, and keep side effects after the pause resolves, since resuming re-runs
the tool body from the top. Adapter-managed `interruptOnCall` approvals are the
exception in both languages: their `{ approved: boolean }` payload is passed
through raw, and a cancelled approval is answered `{ approved: false }`. Give the
adapter a `config.sessionManagerProvider` and a frontend round trip survives a
process restart; without one it works in-process only.

## Terminal error codes

Every `RUN_ERROR` code either bridge can emit, and the message text that goes
with it, is enumerated in [`../error-codes.json`](../error-codes.json). That
file is a wire contract rather than documentation: clients and mock harnesses
match both the code and the message literally, and both test suites assert
their bridge's emitted frame against it.

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

## Cross-Origin Access

`createStrandsApp` allows no cross-origin access unless you ask for it. Omit
`corsOrigin` and no CORS middleware is installed, so a browser refuses to hand
any response to a page on a different origin; a same-origin page reads it as
usual. That default matters because the route is unauthenticated without `auth`.

```ts
// An exact-match allowlist. `"*"` is accepted too, for local development.
const app = await createStrandsApp(aguiAgent, {
  path: "/invocations",
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

`allowMethods` and `allowHeaders` narrow the `cors` defaults and throw at
construction without an origin policy; a narrowed `allowHeaders` has to include
`Content-Type`, or the route's `415` on non-JSON requests blocks every
cross-origin call. `corsEnabled: false` vetoes whatever `corsOrigin` resolved to.

> **`corsOrigin: true` is the value to be careful with, not `"*"`.** It
> reflects whatever `Origin` the request carried, and a reflected origin is a
> specific origin, so it arrives paired with
> `Access-Control-Allow-Credentials: true`. On a route with no `auth` guard
> that is every site the browser visits. Prefer an exact-match array; a
> wildcard policy is never sent the credentials header at all.

Pass `auth`, plain Express middleware `(req, res, next)`, to guard the route on
either entry point. It is mounted ahead of body parsing, and the agent never runs
for a request the guard did not admit with `next()`. A throw, a rejection or
`next(error)` fails closed on the error's own status where that is a usable HTTP
code and `500` otherwise. `/ping` and `/capabilities` stay open.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
