# AWS Strands Integration for AG-UI (TypeScript)

This package exposes a lightweight wrapper that lets any `@strands-agents/sdk` `Agent` speak the AG-UI protocol. It mirrors the developer experience of the other integrations: give us a Strands agent instance, plug it into `StrandsAgent`, and wire it to Express via `createStrandsApp` (or `addStrandsExpressEndpoint`).

## Prerequisites

- Node.js 18+
- `pnpm` (recommended) or `npm`
- A Strands-compatible model key (e.g., AWS credentials for Bedrock, `OPENAI_API_KEY` for OpenAI)

## Quick Start

The `examples/` package ships a "dojo" server that mounts every demo on a
single port, plus ten standalone servers, one per feature, that you can run
independently.

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
| `/agentic-chat-multimodal`  | Multimodal image / document analysis                                     |
| `/backend-tool-rendering`   | Backend-executed tools (`get_weather`, `render_chart`)                   |
| `/shared-state`             | Shared recipe state (`stateFromArgs`)                                    |
| `/agentic-generative-ui`    | Async-generator tool streams `STATE_SNAPSHOT`s + `PredictState`          |
| `/human-in-the-loop`        | Frontend proxy tool with halt-after-call                                 |
| `/interrupt`                | Backend tool pauses itself to ask the user for a meeting time            |
| `/predictive-state-updates` | Frontend write tool whose streaming args paint `state.document`          |
| `/tool-based-generative-ui` | Frontend-rendered tool (`generate_haiku`)                                |
| `/a2ui-dynamic-schema`      | A2UI surfaces composed on the fly (auto-injected tool)                   |
| `/a2ui-fixed-schema`        | A2UI from fixed-layout backend tools                                     |
| `/a2ui-recovery`            | A2UI validate-and-retry recovery loop                                    |

Most files under `examples/server/api/*.ts` follow the same pattern: build a Strands `Agent`, wrap it in a `StrandsAgent`, hand it to `createStrandsApp`, listen. The three a2ui files export a factory instead and are mounted only by `server.ts`, so they have no standalone script.

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
| `src/server.ts`            | `createStrandsApp` + Express transport (subpath: `@ag-ui/aws-strands/server`)   |
| `src/endpoint.ts`          | Express endpoint helpers (used by `server.ts`)                                  |
| `src/utils.ts`             | Multimodal content conversion                                                   |
| `src/client-proxy-tool.ts` | Dynamic frontend tool registration/deregistration                               |
| `examples/server/api/*.ts` | Ready-to-run demo apps                                                          |

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

To deploy, use the [AgentCore Starter Toolkit](https://github.com/awslabs/bedrock-agentcore-starter-toolkit):

```bash
pip install bedrock-agentcore-starter-toolkit
agentcore configure -e my_agui_server.ts --protocol AGUI
agentcore deploy
```

For the complete deployment walkthrough, see [Deploy AG-UI servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html).

## Supported AG-UI Events

The integration supports the following AG-UI event families:

- **Lifecycle**: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- **Text streaming**: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` (optionally collapsed into `TEXT_MESSAGE_CHUNK` via `StrandsAgentConfig.emitChunkEvents`)
- **Reasoning**: `REASONING_*` events for models with extended thinking (`REASONING_MESSAGE_CHUNK` when `emitChunkEvents` is on)
- **Tool calls**: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT` (or `TOOL_CALL_CHUNK` with `emitChunkEvents`)
- **State management**: `STATE_SNAPSHOT`
- **Multi-agent**: `STEP_STARTED`, `STEP_FINISHED`, and `MultiAgentHandoff` custom events
- **Generative UI**: `PredictState` custom events for optimistic UI updates
- **Multimodal**: Image, document, and video content in user messages (converted to Strands ContentBlock format)

The adapter advertises its full event / feature matrix at GET
`/capabilities` (enabled by default; override via `createStrandsApp({ capabilitiesPath, capabilities })` or mount manually with `addCapabilities(app, path, overrides)`).

## Passing tools to the Agent

The adapter clones the template `Agent`'s `tools` array onto every per-thread
clone. That means whatever the Strands SDK has resolved into `agent.tools` at
construction time is what the model sees — including for `McpClient`
instances. If you pass an **unconnected** `McpClient` directly, its tools
won't be in the resolved list and the model can't call them.

Connect MCP clients first and spread the resolved tools into `tools`:

```ts
import { Agent } from "@strands-agents/sdk";
import { McpClient } from "@strands-agents/sdk/mcp";

const spellbook = new McpClient({
  /* transport config */
});
await spellbook.connect();
const mcpTools = await spellbook.listTools();

const agent = new Agent({
  model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
  tools: [...mcpTools, myLocalTool],
});

const aguiAgent = new StrandsAgent({ agent });
```

The adapter logs a warning at construction time if it spots an entry in
`tools` that looks like an unconnected client (has a `.connect()` method but
no `.name`).

## Human-in-the-loop interrupts

Two complementary patterns are supported:

- **Frontend tools.** The `/human-in-the-loop` example declares
  `generate_task_steps` on the frontend via `useHumanInTheLoop` — the adapter
  auto-registers it as a proxy tool, halts the run after the proxy resolves,
  and hands control back to the UI for approval.
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
        { "id": "...", "reason": "...", "metadata": { "strandsName": "..." } }
      ]
    }
  }
  ```

  The next `RunAgentInput` carries `resume[]` entries keyed by those `id`s.
  The adapter converts each entry into a Strands `InterruptResponseContent`
  (forwarding `payload` for `resolved` and `{ status: "cancelled" }` for
  `cancelled`) and hands them straight to `agent.stream(...)`. Unknown
  `interruptId`s still short-circuit with
  `RUN_ERROR { code: "UNKNOWN_INTERRUPT" }` per
  [interrupts.mdx rule 4](https://docs.ag-ui.com/concepts/interrupts).

## Reasoning / extended thinking

The `/agentic-chat-reasoning` demo only emits `REASONING_*` events when the
underlying Strands model is configured with thinking / reasoning params. The
default `BedrockModel(...)` without `additional_request_fields` returns plain
text; for Claude extended thinking, configure the model like so:

```ts
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";

const model = new BedrockModel({
  modelId: "global.anthropic.claude-sonnet-4-6",
  additionalRequestFields: {
    thinking: { type: "enabled", budget_tokens: 5000 },
  },
});
```

## Install

```bash
pnpm add @ag-ui/aws-strands @strands-agents/sdk @ag-ui/core @ag-ui/encoder
# Server-side helpers (createStrandsApp / addStrandsExpressEndpoint) require express:
pnpm add express
pnpm add -D @types/express
# `cors` is loaded only when `createStrandsApp` installs the middleware, which
# needs a truthy `corsOrigin` that `corsEnabled: false` has not vetoed.
# Skip the next two lines unless you opt into cross-origin access:
pnpm add cors
pnpm add -D @types/cors
# @modelcontextprotocol/sdk is loaded unconditionally by @strands-agents/sdk
# — required at runtime even for agents that don't use MCP:
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

When it installs the middleware, `createStrandsApp` derives `credentials` from
the origin policy it resolved rather than passing a fixed value, and
`CreateStrandsAppOptions` offers no way to override the derivation. Credentials
are enabled only for a policy that names at least one specific origin: a
non-empty origin string other than `"*"`, an array with no `"*"` in it, or
`true`. So `"https://app.tld"`, `["https://a.tld"]` and `true` emit
`Access-Control-Allow-Credentials: true` on every response the middleware acts
on, allowlist misses included, while `"*"`, `[]`, `["*"]` and
`["*", "https://a.tld"]` emit no credentials header at all.

> **`corsOrigin: true` is the value to be careful with, not `"*"`.** `true`
> reflects whatever `Origin` the request carried straight back in
> `Access-Control-Allow-Origin`, per request, and because a reflected origin is
> a specific origin the derivation above keeps credentials on, so that origin
> arrives paired with `Access-Control-Allow-Credentials: true`. Browsers honour
> that pair for a credentialed request (`credentials: "include"`), so `true`
> lets a page on any origin make a credentialed cross-origin call to the agent
> route and read the streamed response. On a route with no `auth` guard, that is
> every site the browser visits. Prefer an exact-match array.
>
> `"*"` fails in the safer direction, and now does so twice over. The
> derivation withholds the credentials header from a wildcard policy in the
> first place, so it is never sent; and the CORS protocol tells browsers to
> reject a literal wildcard combined with credentials anyway, so a wildcard
> only ever serves requests that send none. Either way the `corsOrigin: "*"`
> suggested above for local development cannot carry cookies. Name the origins
> explicitly when the browser has to send them.

Both adapters now guard the credentials pairing the same way. Python's
`create_strands_app` computes
`allow_credentials=bool(origins) and not is_wildcard`, and the derivation above
is the TypeScript spelling of that same rule. What still differs is the
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

Both example servers are origin-restricted by default and read the same
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
cors_enabled=None)`, so the guard hook, the off switch and the method and header
narrowing exist on both sides and this surface is level rather than
TypeScript-only.

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
