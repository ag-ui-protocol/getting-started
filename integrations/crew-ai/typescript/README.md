# @ag-ui/crewai

Implementation of the AG-UI protocol for CrewAI.

Connects CrewAI Flows and Crews to frontend applications via the AG-UI protocol. Supports both TypeScript HTTP clients and Python FastAPI server integration with streaming crew execution.

## Installation

```bash
npm install @ag-ui/crewai
pnpm add @ag-ui/crewai
yarn add @ag-ui/crewai
```

## Usage

```ts
import { CrewAIAgent } from "@ag-ui/crewai";

// Create an AG-UI compatible agent
const agent = new CrewAIAgent({
  url: "http://localhost:8000/crew-endpoint",
  headers: { "Content-Type": "application/json" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Execute the research crew" }],
});
```

## Features

- **HTTP connectivity** – Connect to CrewAI FastAPI servers
- **Flow & Crew support** – Works with both CrewAI Flows and traditional Crews
- **Step tracking** – Real-time crew execution progress
- **Python integration** – Full FastAPI server implementation included

## To run the example server in the dojo

The dojo server is development-only and is not shipped in the published
`ag-ui-crewai` package, so run it from a checkout of this repository.

```bash
cd integrations/crew-ai/python
uv sync && uv run python -m ag_ui_crewai
```
