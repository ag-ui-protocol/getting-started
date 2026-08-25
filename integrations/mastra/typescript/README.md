# @ag-ui/mastra

Implementation of the AG-UI protocol for Mastra.

Connects Mastra agents (local and remote) to frontend applications via the AG-UI protocol. Supports streaming responses, memory management, and tool execution.

## Installation

Install the `@ag-ui/mastra` package:

```bash
# npm
npm install @ag-ui/mastra
# pnpm
pnpm add @ag-ui/mastra
# yarn
yarn add @ag-ui/mastra
```

Install the required peer dependencies:

```bash
npm install @mastra/client-js @mastra/core @ag-ui/core @ag-ui/client @copilotkit/runtime
```

## Usage

```ts
import { MastraAgent } from "@ag-ui/mastra";
import { mastra } from "./mastra"; // Your Mastra instance

// Create an AG-UI compatible agent
const agent = new MastraAgent({
  agent: mastra.getAgent("weather-agent"),
  resourceId: "user-123",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "What's the weather like?" }],
});
```

## Features

- **Local & remote agents** – Works with in-process and network Mastra agents
- **Memory integration** – Automatic thread and working memory management
- **Tool streaming** – Real-time tool call execution and results
- **State management** – Bidirectional state synchronization
- **Human-in-the-loop** – Mastra tool suspend/resume bridged to AG-UI interrupts

## Interrupts (tool suspend/resume)

When a Mastra tool suspends, the bridge surfaces it to the frontend. Two
channels exist:

- **Legacy** `CustomEvent(name="on_interrupt")` — always emitted (backward
  compatibility). Its `value` is a JSON string carrying `type:"mastra_suspend"`,
  `toolCallId`, `toolName`, `suspendPayload`, `args`, `resumeSchema`, and the
  snapshot-keying `runId`.
- **Standard** `RunFinishedEvent.outcome = { type: "interrupt", interrupts }` —
  the canonical AG-UI signal. Each suspend maps to an `Interrupt` (`reason`,
  `toolCallId`, `responseSchema` — parsed from `resumeSchema`); the remaining
  round-trip data lives under `metadata.mastra`. Its `id` is
  `` `${runId}::${toolCallId}` `` — the snapshot-keying `runId` is encoded into
  the id because a standard-path client only round-trips `interruptId` (not
  `metadata`) on resume; the bridge decodes it back out.

Resume is consumed from **both** channels regardless of the flag: the legacy
`forwardedProps.command.resume` and the standard `RunAgentInput.resume` array.

> **Opt-out (`emitInterruptOutcome`, default `true`).** The structured outcome
> is the canonical AG-UI interrupt path, emitted by default alongside the legacy
> event. **It requires a CopilotKit client `>= 1.61.2`** — the release that
> reads `outcome:"interrupt"` and resumes via `RunAgentInput.resume`. On older
> clients (`<= 1.61.1`, incl. 1.60.1/1.61.0) the client records the structured
> interrupt but never addresses it on resume, stranding the run with
> `Thread has N pending interrupt(s) not addressed by resume`. **If you target a
> client below 1.61.2, set `emitInterruptOutcome: false`** to fall back to the
> legacy `on_interrupt`-only path. When on, BOTH channels are emitted; when off,
> only the legacy event plus a plain `RUN_FINISHED`.

```ts
const agent = new MastraAgent({
  agent: mastra.getAgent("interrupt-agent"),
  resourceId: "user-123",
  // Default true. Set false if your CopilotKit client is < 1.61.2.
  emitInterruptOutcome: false,
});
```

## To run the example server in the dojo

```bash
cd integrations/mastra/typescript/examples
pnpm install
pnpm run dev
```
