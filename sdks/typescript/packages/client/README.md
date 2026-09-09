# @ag-ui/client

Client SDK for connecting to **Agent-User Interaction (AG-UI) Protocol** servers.

`@ag-ui/client` provides agent implementations that handle the full lifecycle of AG-UI communication: connecting to servers, processing streaming events, managing state mutations, and providing reactive subscriber hooks.

## Installation

```bash
npm install @ag-ui/client
pnpm add @ag-ui/client
yarn add @ag-ui/client
```

## Features

- 🔗 **HTTP connectivity** – `HttpAgent` for direct server connections with SSE/protobuf support
- 🏗️ **Custom agents** – `AbstractAgent` base class for building your own transport layer
- 📡 **Event streaming** – Full AG-UI event processing with validation and transformation
- 🔄 **State management** – Automatic message/state tracking with reactive updates
- 🪝 **Subscriber system** – Middleware-style hooks for logging, persistence, and custom logic
- 🎯 **Middleware support** – Transform and filter events with function or class-based middleware

## Quick example

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://api.example.com/agent",
  headers: { Authorization: "Bearer token" },
});

const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(result.newMessages);
```

## Using Middleware

```ts
import { HttpAgent, FilterToolCallsMiddleware } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://api.example.com/agent",
});

// Add middleware to transform or filter events
agent.use(
  // Function middleware for logging
  (input, next) => {
    console.log("Starting run:", input.runId);
    return next.run(input);
  },

  // Class middleware for filtering tool calls
  new FilterToolCallsMiddleware({
    allowedToolCalls: ["search", "calculate"]
  })
);

await agent.runAgent();
```

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/client`](https://docs.ag-ui.com/sdk/js/client/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors

## HTTP error response limits

For non-success HTTP responses, the client streams at most 64 KiB of body bytes
into a diagnostic preview before UTF-8 decoding. Once the budget is reached it
cancels the reader without waiting for another chunk or EOF; an incomplete UTF-8
character at the boundary is omitted. The payload remains a string with a
` [truncated]` suffix, including when the body is exactly 64 KiB. Complete JSON
bodies below the limit retain their structured `error.payload` behavior. The
HTTP status remains available as `error.status`.

The body detail embedded in `error.message` is independently limited to 4,096
characters plus a truncation marker. Large error responses previously retained
in full are now previews. The byte budget bounds retained content; a single
chunk supplied by the underlying stream can already exceed that budget.
