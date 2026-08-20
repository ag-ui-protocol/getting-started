# @ag-ui/vercel-ai-sdk

AG-UI integration for the Vercel AI SDK. Lets you build agents with `streamText` and expose them via the AG-UI protocol.

## Installation

Install the `@ag-ui/vercel-ai-sdk` package:

```bash
# npm
npm install @ag-ui/vercel-ai-sdk
# pnpm
pnpm add @ag-ui/vercel-ai-sdk
# yarn
yarn add @ag-ui/vercel-ai-sdk
```

Install the required peer dependencies along with at least one AI SDK provider:

```bash
npm install @ag-ui/client rxjs ai @ai-sdk/openai
```

The package targets `ai@^7.0.0` and requires `@ag-ui/client >=0.0.49` (for the reasoning events and multimodal content types it emits) and `rxjs`. Any AI SDK v7 provider package works (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, etc.) — pick whichever one matches the model you want to use.

## Quick Start

```ts
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";

const agent = new VercelAISDKAgent({
  model: openai("gpt-4o-mini"),
  initialMessages: [
    {
      id: "1",
      role: "user",
      content: "Say hello in three different languages.",
    },
  ],
});

await agent.runAgent();
```

The run emits, in order:

```
RUN_STARTED
STEP_STARTED         stepName=step-1
TEXT_MESSAGE_START   messageId=msg-1, role=assistant
TEXT_MESSAGE_CONTENT delta="Hello"
TEXT_MESSAGE_CONTENT delta=" / Bonjour"
TEXT_MESSAGE_CONTENT delta=" / 你好"
TEXT_MESSAGE_END     messageId=msg-1
STEP_FINISHED        stepName=step-1
MESSAGES_SNAPSHOT    messages=[...]
RUN_FINISHED
```

Subscribe with an `AgentSubscriber` (or pipe the underlying `Observable`) to consume events as they arrive.

## With Tools

Tools attached to a run are forwarded to the model as JSON Schema. Tool calls come back as AG-UI events for the **client** to execute — the agent itself does not run any tool code server-side. The client returns each result as a `tool` message on the next `runAgent` call.

```ts
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";

const agent = new VercelAISDKAgent({
  model: openai("gpt-4o-mini"),
  initialMessages: [
    {
      id: "1",
      role: "user",
      content: "What's the weather in Tokyo?",
    },
  ],
});

await agent.runAgent({
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name" },
        },
        required: ["city"],
      },
    },
  ],
});
```

The integration uses AI SDK's `jsonSchema()` helper, so the full JSON Schema vocabulary (`oneOf`, `anyOf`, `enum`, `pattern`, nested objects, arrays, optional fields, etc.) is supported as-is.

## Streaming Tool Arguments

The model streams tool arguments as JSON fragments. Each chunk produces a `TOOL_CALL_ARGS` event so clients can pre-fill UI as the arguments arrive instead of waiting for the full call.

For a single `get_weather` call against `{ "city": "Tokyo" }`, the stream looks like:

```
TOOL_CALL_START   toolCallId=tc-1, toolCallName=get_weather
TOOL_CALL_ARGS    delta='{"city":'
TOOL_CALL_ARGS    delta='"Tokyo"'
TOOL_CALL_ARGS    delta='}'
TOOL_CALL_END     toolCallId=tc-1
```

If a provider returns the tool input in one shot (no per-token streaming), the integration synthesises an equivalent `START` / single-chunk `ARGS` / `END` sequence so clients can stay on a single code path.

## Multi-step Agentic Loops

Set `maxSteps` to let the model call tools, observe the results, and decide whether to call again — all inside a single `runAgent` invocation:

```ts
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";

const agent = new VercelAISDKAgent({
  model: openai("gpt-4o-mini"),
  maxSteps: 5,
});
```

Under the hood this is wired up to AI SDK v7's stop-condition API:

```ts
import { stepCountIs } from "ai";
// streamText({ ..., stopWhen: stepCountIs(maxSteps) })
```

Each step gets its own `STEP_STARTED` and `STEP_FINISHED` event pair, and each step's assistant message gets its own UUID. Tool calls produced inside a step are linked back to that step's assistant message via `parentMessageId`, so a multi-step transcript reconstructs cleanly on the client.

The default is `maxSteps: 1` (a single LLM call, no automatic continuation).

## Reasoning (Anthropic / OpenAI o1)

When you point the agent at a reasoning model, reasoning blocks are surfaced as their own event sequence, separate from regular assistant text:

```
REASONING_START          / REASONING_MESSAGE_START
REASONING_MESSAGE_CONTENT  (deltas)
REASONING_MESSAGE_END    / REASONING_END
```

For Anthropic models, the encrypted reasoning signature (`providerMetadata.anthropic.signature`) is auto-forwarded as a `REASONING_ENCRYPTED_VALUE` event and stored on the reasoning message; on the next run the message converter folds it back into the assistant turn as a signed reasoning part, so tool-use continuations with extended thinking replay correctly:

```ts
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new VercelAISDKAgent({
  model: anthropic("claude-sonnet-4-5"),
});
```

Reasoning messages enter `MESSAGES_SNAPSHOT` as their own message entries (role `"reasoning"`), not folded into the assistant message.

## Provider Flexibility

The integration consumes AI SDK v7's `fullStream` directly, so any v7-compatible provider package works without further configuration:

```ts
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

new VercelAISDKAgent({ model: openai("gpt-4o-mini") });
new VercelAISDKAgent({ model: anthropic("claude-sonnet-4-5") });
new VercelAISDKAgent({ model: google("gemini-2.5-pro") });
```

## API Reference

### `VercelAISDKAgent`

```ts
new VercelAISDKAgent({
  model,        // LanguageModel — any AI SDK v7 model
  maxSteps,     // number, optional (default 1)
  toolChoice,   // AI SDK ToolChoice, optional (default "auto")
  agentId,      // inherited from AbstractAgent
  description,  // inherited from AbstractAgent
  threadId,     // inherited from AbstractAgent
});
```

Extends `AbstractAgent` from `@ag-ui/client`. Calling `runAgent(input, subscriber?)` returns a `Promise<RunAgentResult>` and emits AG-UI events through the subscriber and the agent's internal `Observable`.

### Converters

```ts
import {
  convertMessagesToVercelAISDKMessages,
  convertToolsToVercelAISDKTools,
} from "@ag-ui/vercel-ai-sdk";
```

- `convertMessagesToVercelAISDKMessages(messages)` — converts AG-UI `Message[]` to AI SDK `ModelMessage[]`. Handles roles, multimodal user content (text / image / audio / video / document), assistant tool calls, and tool messages (with tool-name lookup against the conversation history; `ToolMessage.error` becomes an `error-text` output so providers flag it as a failure). Reasoning messages are folded into the following assistant message as reasoning parts, carrying the Anthropic signature when present.
- `convertToolsToVercelAISDKTools(tools)` — converts AG-UI `Tool[]` to an AI SDK `ToolSet`. Each tool's JSON Schema is wrapped via the SDK's `jsonSchema()` helper. No `execute` function is attached — tool calls are surfaced back to the AG-UI client.

`convertToolToVerlAISDKTools` is exported as a backward-compatible alias for the typo'd name from earlier versions of the package; new code should use `convertToolsToVercelAISDKTools`.

## Limitations & Future Work

- `RunAgentInput.context` is forwarded to the model as a leading system message (`streamText` has no request-context channel). `RunAgentInput.state` and `forwardedProps` are not consumed — the integration is stateless between runs and emits no `STATE_SNAPSHOT`/`STATE_DELTA` events.
- The `source`, `file`, `reasoning-file`, and `raw` AI SDK stream parts are not currently mapped to AG-UI events. They may be exposed as `CUSTOM` events in a future release.
- The tool-approval lifecycle is surfaced as `CUSTOM` events: `tool-approval-request` → `name: "tool_approval_request"`, and `tool-approval-response` → `name: "tool_approval_response"` (carrying the `approved` flag and optional `reason`). Clients are responsible for their own approval UX.
- Provider `custom` stream parts are passed through as `CUSTOM` events whose `name` is the part's namespaced `kind` (e.g. `"acme.telemetry"`), with the provider metadata as the event `value`.
- This package only covers the backend direction (AI SDK `streamText` -> AG-UI events). The reverse direction (AG-UI backend -> AI SDK `useChat` frontend) is intentionally out of scope and would ship as a separate package.
- Targets AI SDK v7 stable.

## License

MIT — see [LICENSE](LICENSE).
