# @ag-ui/langgraph

Implementation of the AG-UI protocol for LangGraph.

Connects LangGraph graphs to frontend applications via the AG-UI protocol. Supports both local TypeScript graphs and remote LangGraph Cloud deployments with full state management and interrupt handling.

## Installation

```bash
npm install @ag-ui/langgraph
pnpm add @ag-ui/langgraph
yarn add @ag-ui/langgraph
```

## Usage

```ts
import { LangGraphAgent } from "@ag-ui/langgraph";

// Create an AG-UI compatible agent
const agent = new LangGraphAgent({
  graphId: "my-graph",
  deploymentUrl: "https://your-langgraph-deployment.com",
  langsmithApiKey: "your-api-key",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Start the workflow" }],
});
```

## Features

- **Cloud & local support** – Works with LangGraph Cloud and local graph instances
- **State management** – Bidirectional state synchronization with graph nodes
- **Interrupt handling** – Human-in-the-loop workflow support
- **Step tracking** – Real-time node execution progress

## Resuming via AG-UI standard `resume[]`

When a client uses `RunAgentInput.resume = [ResumeEntry, ...]` instead of
the legacy `forwardedProps.command.resume`, the integration converts the
array into a single `Command(resume=...)` value (LangGraph's resume
channel is per-task, not per-interrupt). The shape your graph receives:

- **Single `resolved` entry** → `interrupt()` returns `entry.payload`
  verbatim. Existing graphs that consumed `Command(resume=<payload>)`
  keep working.
- **Single `cancelled` entry** → `interrupt()` returns the sentinel
  `{"__agui_cancelled__": true, "interrupt_id": "..."}`.
  Your graph should branch on this key.
- **Multiple entries** (parallel interrupts) → `interrupt()` returns
  `{"__agui_resume_map__": { interruptId: {status, payload}, ... }}`.

These sentinels live in the AG-UI integration only — they do **not**
leak into transport-level events.

## Migrating to AG-UI standard interrupts

The LangGraph integration now supports the AG-UI standard interrupt protocol. Key changes:

### Detecting a paused run

When the structured outcome is enabled (`emitInterruptOutcome: true`, opt-in — see the callout below), `RunFinishedEvent.outcome.type === "interrupt"` is the canonical signal that a run has paused for human input. The `outcome.interrupts` array contains AG-UI `Interrupt` objects with `id`, `reason`, `message`, `toolCallId`, `responseSchema`, `expiresAt`, and `metadata` fields. LangGraph-specific data (raw interrupt value, `ns`, `resumable`, `when`) is preserved under `metadata.langgraph`.

```ts
// New: read interrupts from outcome
if (event.type === "RUN_FINISHED" && event.outcome?.type === "interrupt") {
  for (const interrupt of event.outcome.interrupts) {
    console.log(interrupt.id, interrupt.reason, interrupt.message);
  }
}
```

> **Opt-in (`emitInterruptOutcome`, default `false`).** The structured
> `outcome` is only emitted when you enable it. Released clients that resume
> through the legacy `forwardedProps.command.resume` channel (e.g. CopilotKit's
> `useLangGraphInterrupt`, as of v1.60.x) **stop sending a resume directive once
> they observe the structured outcome**, which strands the run — so it stays
> opt-in until those clients adopt `RunAgentInput.resume[]`. With the default,
> interrupted runs end with a plain `RUN_FINISHED` plus the legacy
> `on_interrupt` event, exactly as before. Enable the canonical outcome once
> your client reads `RunAgentInput.resume[]`:
>
> ```ts
> const agent = new LangGraphAgent({
>   graphId: "my-graph",
>   deploymentUrl: "https://your-langgraph-deployment.com",
>   emitInterruptOutcome: true,
> });
> ```

### Resuming a run

Send `RunAgentInput.resume` (recommended) instead of `forwardedProps.command.resume`:

```ts
// New (recommended)
const input = {
  threadId: "t1",
  runId: "r2",
  messages: [],
  resume: [
    { interruptId: "int-abc", status: "resolved", payload: { approved: true } },
  ],
};

// Old (still works, but deprecated)
const input = {
  threadId: "t1",
  runId: "r2",
  messages: [],
  forwardedProps: { command: { resume: { approved: true } } },
};
```

If both `input.resume` and `forwardedProps.command.resume` are provided, `input.resume` takes precedence and a warning is logged.

### Legacy `on_interrupt` custom event

By default the integration emits `CustomEvent(name="on_interrupt")` for backward compatibility (and, when `emitInterruptOutcome` is enabled, alongside the new `RunFinishedEvent.outcome`). To suppress the legacy event:

```ts
const agent = new LangGraphAgent({
  graphId: "my-graph",
  deploymentUrl: "https://your-langgraph-deployment.com",
  langsmithApiKey: "your-api-key",
  enableLegacyOnInterruptEvent: false,
});
```

Disabling the legacy event forces `emitInterruptOutcome` on (even if left `false`): with both off, an interrupt would be surfaced by neither channel, so the structured outcome is emitted to avoid silently stranding the run.

Consumers should migrate to reading `outcome` from `RunFinishedEvent` rather than listening for `CustomEvent(name="on_interrupt")`.

### Capabilities

`LangGraphAgent.getCapabilities()` returns `humanInTheLoop: { supported: true, interrupts: true, approveWithEdits: true }`.

### Customising the HITL bridge (subclass hooks)

If your graph uses a middleware whose interrupt value carries structured payloads (e.g. LangChain's `HumanInTheLoopMiddleware` with `action_requests` / `review_configs`), you can override two protected methods instead of monkey-patching the run loop:

```ts
import { LangGraphAgent, langGraphInterruptToAGUI } from "@ag-ui/langgraph";
import type { Interrupt as AGUIInterrupt, ResumeEntry } from "@ag-ui/core";
import type { Interrupt as LangGraphInterrupt } from "@langchain/langgraph-sdk";

class HITLLangGraphAgent extends LangGraphAgent {
  protected interruptsToAGUI(
    list: readonly LangGraphInterrupt[],
  ): AGUIInterrupt[] {
    const out: AGUIInterrupt[] = [];
    for (const lg of list) {
      const value = lg.value;
      if (typeof value === "object" && value !== null && "action_requests" in value) {
        out.push(...myActionRequestsToAGUI(value));
      } else {
        out.push(langGraphInterruptToAGUI(lg));
      }
    }
    return out;
  }

  protected buildCommandResumeFromAgui(
    entries: readonly ResumeEntry[],
    ctx: { openInterrupts: AGUIInterrupt[] },
  ): unknown {
    return myResumeToDecisions(entries, ctx.openInterrupts);
  }
}
```

The base class still handles `STATE_SNAPSHOT` / `MESSAGES_SNAPSHOT` ordering, legacy `CustomEvent(on_interrupt)` emission, the `prepareStream` short-circuit, and `forwardedProps.command.resume` deprecation — your subclass only needs to care about the HITL-specific translation.

## To run the example server in the dojo

```bash
cd integrations/langgraph/typescript/examples
langgraph dev
```
