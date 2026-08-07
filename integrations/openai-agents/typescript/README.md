# @ag-ui/openai-agents

TypeScript client for connecting an AG-UI front end to a server built with
the companion Python integration
([`ag-ui-openai-agents`](../python/README.md)), which bridges the
[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) and the
AG-UI protocol.

## Status

`OpenAIAgentsHttpAgent` is currently an empty subclass of `HttpAgent` — it
adds no behavior beyond what `@ag-ui/client`'s `HttpAgent` already provides,
since the Python side exposes no extra endpoints (e.g. no capability
discovery) for a client to call. It is marked `"private": true` and is not
published to npm.

## Usage

```typescript
import { OpenAIAgentsHttpAgent } from "@ag-ui/openai-agents";

const agent = new OpenAIAgentsHttpAgent({
  url: "http://localhost:8027/agentic_chat/",
});

// Use the agent with AG-UI clients
```

## Requirements

- An `ag-ui-openai-agents` Python server running (see `../python/README.md`)
- AG-UI compatible client
