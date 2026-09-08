# MCP Middleware

AG-UI middleware that connects an agent run to one or more [MCP](https://modelcontextprotocol.io)
servers. It lists each server's tools, injects them into the run, executes the
resulting tool calls server-side, and loops the agent until no MCP tool calls
remain — all presented to the consumer as a single, continuous run.

## Usage

```ts
import { MCPMiddleware } from "@ag-ui/mcp-middleware";

agent.use(
  new MCPMiddleware([
    {
      type: "http",
      url: "https://example.com/mcp",
      serverId: "example",
      headers: { Authorization: "Bearer <token>" },
    },
  ]),
);
```

## Behavior

- **Tool injection.** Every tool reported by a server is exposed to the agent
  namespaced as `mcp__{serverId}__{tool}` (sanitized to `[a-zA-Z0-9_-]`,
  truncated to 64 characters, and de-duplicated with a `_N` suffix on
  collision). `serverId` defaults to `server{index}` when omitted. Listing
  happens once per middleware instance and is cached.
- **Execution loop.** When a finished run leaves MCP tool calls open, the
  middleware executes them (in parallel), emits a `TOOL_CALL_RESULT` for each,
  and — if nothing else is open — starts another run with the results appended.
  If non-MCP tool calls remain open (e.g. frontend tools), it stops and hands
  off to the frontend. Tool calls that don't target an injected MCP tool are
  never touched.
- **Single-run presentation.** The whole multi-iteration loop looks like one
  run to the consumer: the first `RUN_STARTED` is forwarded, continuation
  `RUN_STARTED` events are suppressed, and a single terminal `RUN_FINISHED` is
  flushed only when the loop stops.
- **Runaway guard.** `maxIterations` (default `32`) caps the number of
  tool-execution rounds. Values are clamped to a positive integer.

## Configuration

```ts
interface MCPClientConfig {
  type: "http" | "sse";
  url: string;
  serverId?: string;
  headers?: Record<string, string>;
}

interface MCPMiddlewareOptions {
  maxIterations?: number; // default 32
}
```

Per-request auth is supported by constructing the middleware per request with
`headers` set — they're stamped on outbound MCP requests via the transport's
`requestInit`.

> **SSE caveat:** for the `sse` transport, `headers` only apply to the POST
> channel; the SSE event stream uses `eventSourceInit`. Prefer the `http`
> (streamable) transport when headers must cover all traffic.
