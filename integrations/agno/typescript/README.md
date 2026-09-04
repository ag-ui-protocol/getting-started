# @ag-ui/agno

Implementation of the AG-UI protocol for Agno.

Connects Agno agents to frontend applications via the AG-UI protocol using HTTP communication.

## Installation

```bash
npm install @ag-ui/agno
pnpm add @ag-ui/agno
yarn add @ag-ui/agno
```

## Usage

```ts
import { AgnoAgent } from "@ag-ui/agno";

// Create an AG-UI compatible agent
const agent = new AgnoAgent({
  url: "https://your-agno-server.com/agent",
  headers: { Authorization: "Bearer your-token" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello from Agno!" }],
});
```

## Dojo

To run the [dojo](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo) against a secured AgentOS (e.g. `OS_SECURITY_KEY`, JWT middleware, or platform access tokens), set `AGNO_AUTH_TOKEN` — every agno request will then carry an `Authorization: Bearer <token>` header:

```bash
AGNO_URL=http://localhost:9001 AGNO_AUTH_TOKEN=<your-key-or-token> pnpm dev
```

## Features

- **HTTP connectivity** – Direct connection to Agno agent servers
- **Multi-agent support** – Works with Agno's multi-agent system architecture
- **Streaming responses** – Real-time communication with full AG-UI event support
