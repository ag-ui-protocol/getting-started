# @ag-ui/swarms

Implementation of the AG-UI protocol for [Swarms](https://github.com/kyegomez/swarms).

Connects a Swarms agent to AG-UI compatible frontends. The Swarms agent is
exposed over HTTP/SSE by the [`ag-ui-swarms`](../python) Python adapter, and this
package provides the matching AG-UI client.

## Installation

```bash
npm install @ag-ui/swarms
pnpm add @ag-ui/swarms
yarn add @ag-ui/swarms
```

## Usage

```ts
import { SwarmsAgent } from "@ag-ui/swarms";

// Create an AG-UI compatible agent
const agent = new SwarmsAgent({
  url: "http://localhost:8000/agentic_chat/agui",
  headers: { "Content-Type": "application/json" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Features

- **HTTP/SSE connectivity** – Connect to a Swarms FastAPI server over the
  standard AG-UI wire format
- **Agentic chat** – Stream a Swarms agent's responses into any AG-UI frontend
- **Full conversation history** – The Python adapter replays the AG-UI message
  history into the agent on every turn
- **Python integration** – Complete FastAPI server implementation included

## To run the example server in the dojo

```bash
cd integrations/community/swarms/python/examples
uv sync && uv run dev
```
