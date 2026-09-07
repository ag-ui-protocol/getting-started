# @ag-ui/adk

AG-UI integration for [Google ADK](https://google.github.io/adk-docs/) (Agent Development Kit). This package ships a thin TypeScript client, `ADKAgent`, that connects an AG-UI front end to an ADK-backed agent endpoint served by the companion [Java middleware](../README.md).

`ADKAgent` extends `HttpAgent` from `@ag-ui/client`, so it speaks the full AG-UI protocol over HTTP/SSE out of the box. It also adds a `getCapabilities()` method that fetches and validates the agent's advertised capabilities.

## Installation

```bash
npm install @ag-ui/adk
# or
pnpm add @ag-ui/adk
```

### Peer dependencies

- `@ag-ui/client` (>=0.0.55)
- `@ag-ui/core` (>=0.0.55)
- `rxjs` (7.8.1)

## Usage

### Connect to the Java ADK middleware

Configure the Java hosting application to expose its AG-UI endpoint, then point `ADKAgent` at that URL:

```typescript
import { ADKAgent } from "@ag-ui/adk";

const agent = new ADKAgent({
  url: "http://localhost:8080/agent",
  threadId: "thread-123",
  initialMessages: [{ id: "1", role: "user", content: "Hello!" }],
});

agent
  .run({
    threadId: agent.threadId,
    runId: "run-456",
    messages: agent.messages,
    state: agent.state,
    tools: [],
    context: [],
    forwardedProps: {},
  })
  .subscribe({
    next: (event) => {
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        process.stdout.write(event.delta);
      }
    },
    error: (error) => console.error("Run failed:", error),
    complete: () => console.log("Done"),
  });
```

`ADKAgent` accepts the same configuration as `HttpAgent`, including `url`, `headers`, `agentId`, `threadId`, and `initialMessages`. `run(input)` takes a complete `RunAgentInput` and returns an RxJS `Observable` of AG-UI events.

The Java module supplies the middleware implementation but deliberately does not prescribe a web framework. The hosting application is responsible for routing, authentication, authorization, CORS, limits, and TLS. See the [Java middleware README](../README.md) and [usage guide](../USAGE.md) for server setup.

### Discover agent capabilities

`getCapabilities()` sends a `GET` request to the configured agent URL with `/capabilities` appended, parses the JSON response, and validates it with `AgentCapabilitiesSchema`.

```typescript
import { ADKAgent } from "@ag-ui/adk";

const agent = new ADKAgent({ url: "http://localhost:8080/agent" });
const capabilities = await agent.getCapabilities();

console.log(capabilities);
```

To customize authentication, headers, credentials, or URL construction for capability discovery, subclass `ADKAgent` and override the protected `capabilitiesRequestInit()` and/or `capabilitiesUrl()` methods.

## Development

From this directory:

```bash
npm install
npm test
```

The Vitest suite covers capability URL construction, header forwarding, HTTP failures, and schema validation.

## Java middleware documentation

- [README](../README.md)
- [Usage and executable server example](../USAGE.md)
- [Configuration reference](../CONFIGURATION.md)
- [Tool, HITL, auth, and A2UI behavior](../TOOLS.md)
- [Architecture and lifecycle](../ARCHITECTURE.md)
- [Logging](../LOGGING.md)
