# @ag-ui/adk

AG-UI integration for [Google ADK](https://google.github.io/adk-docs/) (Agent Development Kit). This package ships a thin TypeScript client, `ADKAgent`, that connects an AG-UI front end to an ADK-backed agent endpoint served by the companion Python middleware (`ag_ui_adk`).

`ADKAgent` extends `HttpAgent` from `@ag-ui/client`, so it speaks the full AG-UI protocol over HTTP/SSE out of the box. On top of that it adds a `getCapabilities()` method that fetches and validates the agent's advertised capabilities.

## Installation

```bash
npm install @ag-ui/adk
# or
pnpm add @ag-ui/adk
```

### Peer Dependencies

- `@ag-ui/client` (>=0.0.55)
- `@ag-ui/core` (>=0.0.55)
- `rxjs` (7.8.1)

## TypeScript Client Usage

### Connect to an ADK-backed agent

```typescript
import { ADKAgent } from "@ag-ui/adk";

// `threadId` and `initialMessages` are constructor options (AgentConfig),
// not run-time parameters.
const agent = new ADKAgent({
  url: "http://localhost:8000/chat",
  threadId: "thread-123",
  initialMessages: [{ id: "1", role: "user", content: "Hello!" }],
});

// `run(input)` returns an RxJS Observable of AG-UI events. It takes a full
// `RunAgentInput`, so reuse the agent's `threadId`/`messages`/`state` and
// supply the remaining required fields.
agent
  .run({
    threadId: agent.threadId,
    runId: "run-456",
    messages: agent.messages,
    state: agent.state,
    tools: [],
    context: [],
    forwardedProps: {},
  })
  .subscribe({
    next: (event) => {
      switch (event.type) {
        case "TEXT_MESSAGE_CONTENT":
          process.stdout.write(event.delta);
          break;
        case "TOOL_CALL_START":
          console.log("Calling tool:", event.toolCallName);
          break;
      }
    },
    error: (err) => console.error("Run failed:", err),
    complete: () => console.log("Done"),
  });
```

`ADKAgent` accepts the same configuration as `HttpAgent` (`url`, `headers`, `agentId`, `threadId`, `initialMessages`, etc.). Only `run(input)` is the Observable API — it takes a full `RunAgentInput` and returns an `Observable<BaseEvent>`. The Promise-based `runAgent(parameters?, subscriber?)` is the alternative: it manages `threadId`/`messages`/`state` for you, accepts only `runId`/`tools`/`context`/`forwardedProps`/`resume`, and resolves to a `RunAgentResult` (it is not subscribable).

### Discover agent capabilities

`getCapabilities()` issues a `GET` against the agent's `/capabilities` endpoint (derived from the configured `url`), parses the JSON response, and validates it against the AG-UI `AgentCapabilitiesSchema`. It rejects on HTTP errors, unparseable bodies, or schema-invalid responses.

```typescript
import { ADKAgent } from "@ag-ui/adk";

const agent = new ADKAgent({ url: "http://localhost:8000/chat" });

const capabilities = await agent.getCapabilities();
console.log(capabilities);
```

To customize how capabilities are fetched (auth, headers, credentials, or the URL itself), subclass `ADKAgent` and override the protected `capabilitiesUrl()` and/or `capabilitiesRequestInit()` methods.

---

The remainder of this document covers the companion **Python middleware** (`ag_ui_adk`) that serves the ADK agent endpoint the TypeScript client above connects to.

## Python Middleware

This Python middleware enables [Google ADK](https://google.github.io/adk-docs/) agents to be used with the AG-UI Protocol, providing a bridge between the two frameworks.

## Prerequisites

The examples use ADK Agents using various Gemini models along with the AG-UI Dojo.

- A [Gemini API Key](https://makersuite.google.com/app/apikey). The examples assume that this is exported via the GOOGLE_API_KEY environment variable.

## Quick Start

To use this integration you need to:

1. Clone the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

    ```bash
    git clone https://github.com/ag-ui-protocol/ag-ui.git
    ```

2. Change to the `integrations/adk-middleware/python` directory.

    ```bash
    cd integrations/adk-middleware/python
    ```

3. Install the `ag_ui_adk` package from the local directory.  For example,

    ```bash
    pip install .
    ```

    or

    ```bash
    uv pip install .
    ```

    This installs the package from the current directory which contains:
    - `src/ag_ui_adk/` - The middleware source code
    - `examples/` - Example servers and agents
    - `tests/` - Test suite

4. Run the example FastAPI server. The example project pulls in its own
   dependencies (including the local middleware) via `uv sync`.

    ```bash
    export GOOGLE_API_KEY=<My API Key>
    cd examples
    uv sync
    uv run dev
    ```

5. Open another terminal in the root directory of the ag-ui repository clone.

6. Start the integration ag-ui dojo:

    ```bash
    pnpm install && pnpm run dev
    ```

7. Visit [http://localhost:3000/adk-middleware](http://localhost:3000/adk-middleware).

8. Select View `ADK Middleware` from the sidebar.

### Development Setup

If you want to contribute to ADK Middleware development, install the package in
editable mode with its dev dependencies:

```bash
# From the integrations/adk-middleware/python directory

# Install this package in editable mode
pip install -e .

# For development (includes testing and linting tools)
pip install -e ".[dev]"
```

This installs the ADK middleware in editable mode for development.

## Testing

```bash
# Run the test suite
pytest

# With coverage
pytest --cov=src/ag_ui_adk

# Specific test file
pytest tests/test_adk_agent.py
```
## Usage options

### Option 1: Direct Usage
```python
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent

# 1. Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
)

# 2. Create the middleware with direct agent embedding
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123"
)

# 3. Use directly with AG-UI RunAgentInput
async for event in agent.run(input_data):
    print(f"Event: {event.type}")
```

### Option 2: FastAPI Server

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from google.adk.agents import Agent

# 1. Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
)

# 2. Create the middleware with direct agent embedding
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123"
)

# 3. Create FastAPI app
app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")

# Run with: uvicorn your_module:app --host 0.0.0.0 --port 8000
```

For detailed configuration options, see [CONFIGURATION.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/CONFIGURATION.md).


## Running the ADK Backend Server for Dojo App

To run the ADK backend server that works with the Dojo app, run the example
server from the `integrations/adk-middleware/python/examples` directory:

```bash
cd examples
uv sync
uv run dev
```

This starts a FastAPI server (the `server:main` entrypoint) that connects your ADK middleware to the Dojo application.

## Examples

### Simple Conversation

```python
import asyncio
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    my_agent = Agent(name="assistant", instruction="You are a helpful assistant.")

    agent = ADKAgent(
        adk_agent=my_agent,
        app_name="demo_app",
        user_id="demo"
    )

    # Create input
    input = RunAgentInput(
        thread_id="thread_001",
        run_id="run_001",
        messages=[
            UserMessage(id="1", role="user", content="Hello!")
        ],
        context=[],
        state={},
        tools=[],
        forwarded_props={}
    )

    # Run and handle events
    async for event in agent.run(input):
        print(f"Event: {event.type}")
        if hasattr(event, 'delta'):
            print(f"Content: {event.delta}")

asyncio.run(main())
```

### Multi-Agent Setup

```python
# Create multiple agent instances with different ADK agents
general_agent_wrapper = ADKAgent(
    adk_agent=general_agent,
    app_name="demo_app",
    user_id="demo"
)

technical_agent_wrapper = ADKAgent(
    adk_agent=technical_agent,
    app_name="demo_app",
    user_id="demo"
)

creative_agent_wrapper = ADKAgent(
    adk_agent=creative_agent,
    app_name="demo_app",
    user_id="demo"
)

# Use different endpoints for each agent
from fastapi import FastAPI
from ag_ui_adk import add_adk_fastapi_endpoint

app = FastAPI()
add_adk_fastapi_endpoint(app, general_agent_wrapper, path="/agents/general")
add_adk_fastapi_endpoint(app, technical_agent_wrapper, path="/agents/technical")
add_adk_fastapi_endpoint(app, creative_agent_wrapper, path="/agents/creative")
```

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents. All tools supplied by the client are currently implemented as long-running tools that emit events to the client for execution and can be combined with backend tools provided by the agent to create a hybrid combined toolset.

For detailed information about tool support, see [TOOLS.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/TOOLS.md).

## Additional Documentation

These guides live in the companion Python middleware directory:

- **[CONFIGURATION.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/CONFIGURATION.md)** - Complete configuration guide
- **[TOOLS.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/TOOLS.md)** - Tool support documentation
- **[USAGE.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/USAGE.md)** - Usage examples and patterns
- **[ARCHITECTURE.md](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/python/ARCHITECTURE.md)** - Technical architecture and design details
