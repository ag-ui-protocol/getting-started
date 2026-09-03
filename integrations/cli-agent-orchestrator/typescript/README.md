# @ag-ui/cli-agent-orchestrator

AG-UI TypeScript client for [CLI Agent Orchestrator (CAO)](https://github.com/awslabs/cli-agent-orchestrator) backed agents.

## Installation

```bash
npm install @ag-ui/cli-agent-orchestrator @ag-ui/client @ag-ui/core rxjs
```

## Usage

```typescript
import { CliAgentOrchestratorAgent } from "@ag-ui/cli-agent-orchestrator";

const agent = new CliAgentOrchestratorAgent({
  url: "http://localhost:8027/agentic-chat",
});

// Use the agent with the AG-UI protocol
const run$ = agent.runAgent({
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
});

run$.subscribe({
  next: (event) => console.log(event),
  complete: () => console.log("Done"),
});
```

## Overview

`CliAgentOrchestratorAgent` extends `HttpAgent` from `@ag-ui/client`. Since CAO already exposes a fully AG-UI-compliant streaming endpoint, this client requires no additional logic beyond what `HttpAgent` provides. It serves as a named, semantically meaningful entry point for consumers connecting to CAO backends.

## License

MIT
