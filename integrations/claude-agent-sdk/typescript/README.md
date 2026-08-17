# @ag-ui/claude-agent-sdk

Implementation of the AG-UI protocol for the Anthropic Claude Agent SDK (TypeScript).

## Installation

```bash
npm install @ag-ui/claude-agent-sdk @anthropic-ai/claude-agent-sdk zod
```

## Usage

The adapter manages the SDK lifecycle internally — just call `adapter.run(input)`:

```typescript
import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";

const adapter = new ClaudeAgentAdapter({
  agentId: "my_agent",
  model: "claude-haiku-4-5",
  systemPrompt: "You are helpful",
});

const events$ = adapter.run(input);
events$.subscribe({
  next: (event) => sendEvent(event),
  complete: () => res.end(),
});
```

## Features

- **Full lifecycle management** - Handles message extraction, option building, and SDK querying internally
- **Interrupt support** - Call `adapter.interrupt()` to stop a running query
- **Dynamic frontend tools** - Client-provided tools automatically added as MCP server
- **Frontend tool halting** - Streams pause after frontend tool calls for client-side execution (human-in-the-loop)
- **Streaming tool arguments** - Real-time TOOL_CALL_ARGS emission as JSON arguments stream in
- **Bidirectional state sync** - Shared state management via ag_ui_update_state tool
- **Context injection** - Context and state injected into prompts for agent awareness
- **Event cleanup** - Hanging events (tool calls, reasoning blocks) automatically closed on stream end
- **Optional reasoning snapshots** - Opt in to durable `role="reasoning"` messages in `MESSAGES_SNAPSHOT`
- **Observable pattern** - RxJS Observable for event streaming
- **Custom tools via MCP** - Define custom tools using Claude SDK's tool() function
- **Forwarded props** - Per-run option overrides with security whitelist

## Examples

The integration includes 5 example agents:

| Route | Description | Features |
|-------|-------------|----------|
| `/agentic_chat` | Basic conversational assistant | Simple chat |
| `/backend_tool_rendering` | Weather tool (backend MCP) | Backend tool execution, tool rendering |
| `/shared_state` | Recipe collaboration | Bidirectional state sync, ag_ui_update_state |
| `/human_in_the_loop` | Task planning with approval | Frontend tools, step tracking, approval workflow |
| `/tool_based_generative_ui` | Frontend tool rendering | Dynamic frontend tools, generative UI |

## Running the Examples

```bash
# Install dependencies
cd integrations/claude-agent-sdk/typescript
pnpm install

# Start server (port 8889)
ANTHROPIC_API_KEY=sk-ant-xxx npx tsx examples/server.ts

# Start Dojo (in another terminal)
cd apps/dojo
pnpm dev
```

Visit **http://localhost:3000** and select **"Claude Agent SDK (Typescript)"**

To include reasoning messages in snapshots for replay, enable it explicitly:

```typescript
const adapter = new ClaudeAgentAdapter({
  model: "claude-haiku-4-5",
  includeReasoningInMessagesSnapshot: true,
});
```

This option is disabled by default. Reasoning messages are retained for snapshots
only and are not sent back to Claude as provider input.

## Links

- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [AG-UI Documentation](https://docs.ag-ui.com/)
- [AG-UI State Management](https://docs.ag-ui.com/concepts/state)
