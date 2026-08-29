# ADK Middleware for AG-UI Protocol

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

3. Install the `adk-middleware` package from the local directory.  For example,

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

4. Install the requirements for the `examples`, for example:

    ```bash
    uv pip install -r requirements.txt
    ```

5. Run the example fast_api server.

    ```bash
    export GOOGLE_API_KEY=<My API Key>
    cd examples
    uv sync
    uv run dev
    ```

6. Open another terminal in the root directory of the ag-ui repository clone.

7. Start the integration ag-ui dojo:

    ```bash
    pnpm install && pnpm run dev
    ```

8. Visit [http://localhost:3000/adk-middleware](http://localhost:3000/adk-middleware).

9. Select View `ADK Middleware` from the sidebar.

### Development Setup

If you want to contribute to ADK Middleware development, you'll need to take some additional steps.  You can either use the following script of the manual development setup.

```bash
# From the adk-middleware directory
chmod +x setup_dev.sh
./setup_dev.sh
```

### Manual Development Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install this package in editable mode
pip install -e .

# For development (includes testing and linting tools)
pip install -e ".[dev]"
# OR
pip install -r requirements-dev.txt
```

This installs the ADK middleware in editable mode for development.

## Testing

```bash
# Run tests (271 comprehensive tests)
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
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
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
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# 2. Create the middleware with direct agent embedding
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123"
)

# 3. Create FastAPI app
app = FastAPI()
add_adk_fastapi_endpoint(
    app, agent, path="/chat",
    extract_headers=["x-user-id", "x-tenant-id"]  # Extract HTTP headers into state.headers
)

# Run with: uvicorn your_module:app --host 0.0.0.0 --port 8000
```

For detailed configuration options, see [CONFIGURATION.md](./CONFIGURATION.md)

### Option 3: Using ADK App with ResumabilityConfig (HITL)

> **Requires `google-adk >= 1.16.0`**

For human-in-the-loop (HITL) workflows where the agent pauses for user approval and resumes afterward, use `ADKAgent.from_app()` with ADK's `ResumabilityConfig`. This enables ADK to persist `FunctionCall` events before pausing, allowing seamless resumption when the user provides tool results.

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, AGUIToolset
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig

# 1. Create your ADK agent with client-side tools
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(),  # Client-side tools for HITL workflows
    ]
)

# 2. Wrap in an ADK App with ResumabilityConfig
adk_app = App(
    name="my_app",
    root_agent=my_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)

# 3. Create the middleware using from_app()
agent = ADKAgent.from_app(
    adk_app,
    user_id="user123",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# 4. Add FastAPI endpoint
app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")
```

**How it works:**

1. The agent calls a client-side tool (e.g., `generate_task_steps`) — ADK persists the `FunctionCall` event and pauses execution
2. The middleware emits `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` events to the frontend
3. The user reviews and responds (approve/reject) — the frontend sends a `ToolMessage` with the result
4. The middleware resumes ADK execution with the stored `invocation_id`, restoring the agent's position
5. The agent continues from where it left off with the user's response

**When to use `from_app()` vs direct `ADKAgent()`:**

| Feature | `ADKAgent(adk_agent=...)` | `ADKAgent.from_app(app)` |
|---|---|---|
| Basic HITL | ~~Yes (fire-and-forget)~~ **Deprecated** | Yes (native resumability) |
| Session persistence across pause/resume | Manual | Automatic |
| SequentialAgent sub-agent position restore | No | Yes |
| Requires `google-adk` | Any version | >= 1.16.0 |

> **Deprecation notice:** The fire-and-forget HITL flow via `ADKAgent(adk_agent=...)` is deprecated and will be removed in a future version. For human-in-the-loop workflows, use `ADKAgent.from_app()` with `ResumabilityConfig(is_resumable=True)`. The direct constructor remains fully supported for agents without client-side tools. See [USAGE.md](./USAGE.md#migrating-to-resumable-hitl) for migration instructions.

See `examples/server/api/human_in_the_loop.py` for a complete working example.

## Running the ADK Backend Server for Dojo App

To run the ADK backend server that works with the Dojo app, use the following command:

```bash
python -m examples.fastapi_server
```

This will start a FastAPI server that connects your ADK middleware to the Dojo application.

## Examples

### Simple Conversation

```python
import asyncio
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    my_agent = Agent(
        name="assistant", 
        instruction="You are a helpful assistant.", 
        tools=[
            AGUIToolset(), # Add the tools provided by the AG-UI client
        ]
    )

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

### Multiple AG-UI Endpoints

```python
# Create multiple ADKAgent instances with different ADK agents
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

### Workflow step events (SequentialAgent / ParallelAgent / LoopAgent)

For workflow and multi-agent runs you can surface each ADK node/sub-agent as an
AG-UI **step**, so the frontend gets observable per-step progress. Set
`emit_workflow_steps=True`:

```python
from google.adk.agents import SequentialAgent, LlmAgent
from ag_ui_adk import ADKAgent

pipeline = SequentialAgent(
    name="research_pipeline",
    sub_agents=[
        LlmAgent(name="planner", model="gemini-2.5-flash", instruction="Plan the work."),
        LlmAgent(name="researcher", model="gemini-2.5-flash", instruction="Do the research."),
        LlmAgent(name="writer", model="gemini-2.5-flash", instruction="Write the answer."),
    ],
)

agent = ADKAgent(adk_agent=pipeline, app_name="demo", user_id="demo", emit_workflow_steps=True)
```

The run now emits, in order:

```
RUN_STARTED
  STEP_STARTED   { stepName: "planner" }
  … planner's TEXT_MESSAGE_* / TOOL_CALL_* …
  STEP_FINISHED  { stepName: "planner" }
  STEP_STARTED   { stepName: "researcher" }
  …
  STEP_FINISHED  { stepName: "writer" }
RUN_FINISHED
```

Each ADK event's `author` (the node/sub-agent name) becomes the AG-UI `stepName`,
following the AG-UI spec's recommendation that *"the stepName could be the name of
a node"*. This mirrors how the LangGraph integration maps graph nodes to steps.

Notes:

- **Opt-in and non-breaking.** Defaults to `False`; existing streams are unchanged.
- **Only for workflows/multi-agent.** A plain single `LlmAgent` (no sub-agents)
  emits no steps even when the flag is `True`. It activates for `SequentialAgent`,
  `ParallelAgent`, `LoopAgent`, the ADK 2.0 `Workflow` graph, and
  coordinator/sub-agent and dynamic-transfer topologies. `LoopAgent` naturally
  re-emits a step pair per iteration; dynamic `transfer_to_agent` shows up as a
  new step when the author changes.
- **`ParallelAgent` is handled precisely.** Steps are keyed by the ADK event
  `branch` (ADK assigns a distinct branch per parallel sub-agent, e.g. `par.p`),
  so concurrent branches each get exactly one step and stay open together —
  `RUN_STARTED … STEP_STARTED p, STEP_STARTED q … STEP_FINISHED q, STEP_FINISHED p …`.
  Overlapping steps with distinct names are valid per the AG-UI verifier (active
  steps are tracked by name). When execution returns to an ancestor branch (the
  next sequential node after a parallel block), the parallel children close first.
- **`AgentTool` is a tool call, not a step.** ADK runs an `AgentTool`'s wrapped
  agent in an isolated inner `Runner` and returns only its final output, so the
  sub-agent's events never reach the outer stream — it surfaces as `TOOL_CALL_*`
  (authored by the parent), not as an author transition, and correctly gets no
  step. Use `sub_agents` / `transfer_to_agent` (not `AgentTool`) when you want a
  sub-agent to appear as its own step.
- **Ordering.** Steps close after their node's content but before the run-level
  `STATE_SNAPSHOT` / `MESSAGES_SNAPSHOT`, and any open step is also closed on an
  LRO/HITL pause, so `RUN_FINISHED` never follows an active step.
- **A `ParallelAgent` inside a `LoopAgent`** yields one step per branch spanning
  the whole loop, not one per iteration: the concurrent branches keep the same
  `branch` across iterations and the flat event stream carries no iteration
  boundary to close/reopen on (a *serial* loop body does re-emit per iteration,
  because its author changes each time). Nested `ParallelAgent`s work as expected
  (every leaf is its own concurrent branch). Both stay well-formed.

## Context Support

The middleware automatically passes `context` from `RunAgentInput` to your ADK agents, following the pattern established by LangGraph. Context is stored in session state under the `_ag_ui_context` key and is accessible in both tools and instruction providers.

### In Tools via Session State

```python
from google.adk.tools import ToolContext
from ag_ui_adk import CONTEXT_STATE_KEY

def my_tool(tool_context: ToolContext) -> str:
    context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])
    for item in context_items:
        print(f"{item['description']}: {item['value']}")
    return "Done"
```

### In Instruction Providers via Session State

```python
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui_adk import CONTEXT_STATE_KEY

def dynamic_instructions(ctx: ReadonlyContext) -> str:
    instructions = "You are a helpful assistant."

    context_items = ctx.state.get(CONTEXT_STATE_KEY, [])
    for item in context_items:
        instructions += f"\n- {item['description']}: {item['value']}"

    return instructions

agent = LlmAgent(
    name="assistant",
    instruction=dynamic_instructions,  # Callable instruction provider
)
```

### Alternative: Via RunConfig custom_metadata (ADK 1.22.0+)

For users on ADK 1.22.0 or later, context is also available via `RunConfig.custom_metadata`:

```python
def dynamic_instructions(ctx: ReadonlyContext) -> str:
    # Alternative access via custom_metadata (ADK 1.22.0+)
    if ctx.run_config and ctx.run_config.custom_metadata:
        context_items = ctx.run_config.custom_metadata.get('ag_ui_context', [])
```

**Note:** Session state is the recommended approach as it works with all ADK versions.

See `examples/other/context_usage.py` for a complete demonstration.

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents. All tools supplied by the client are currently implemented as long-running tools that emit events to the client for execution and can be combined with backend tools provided by the agent to create a hybrid combined toolset.

### Adk Agent Agui Tool Support

Use the AGUIToolset to expose tools from the AG-UI client to the ADK agent. By default all agui client tools are added to the context. You can filter which tools to expose using the `tool_filter` parameter and fix name conflicts with the `tool_name_prefix` parameter. In google adk tools with the same name override previously defined tools of the same name. You can order the tools array to control which tool takes precedence.

```python
from ag_ui_adk import ADKAgent, AGUIToolset
from google.adk.agents import Agent

hello_agent = LlmAgent(
    name='HelloAgent',
    model='gemini-3.5-flash',
    description="An agent that greets users",
    instruction="""
    You are a friendly assistant that greets users.
    Use the sayHello tool to greet the user.
    """,
    tools=[
        AGUIToolset(tool_filter=['sayHello']) # Add only the sayHello tool exposed by the AG-UI client
    ],
)

goodbye_agent = LlmAgent(
    name='GoodbyeAgent',
    model='gemini-3.5-flash',
    description="An agent that says goodbye",
    instruction="""
    You are a friendly assistant that says goodbye to users.
    Use the sayGoodbye tool to say goodbye to the user.
    """,
        tools=[
        AGUIToolset(tool_filter=lambda tool, readonly_context=None: tool.name.endswith('Goodbye') ) # Add tools ending with Goodbye exposed by the AG-UI client
    ],
)

# create an agent
agent = LlmAgent(
    name='QaAgent',
    model='gemini-3.5-flash',
    description="The QaAgent helps users by answering their questions.",
    instruction="""
    You are a helpful assistant. Help users by answering their questions and assisting with their needs.
    """,
    tools=[
        # This agent doesn't see any tools provided by the AG-UI client
    ],
    sub_agents=[
        hello_agent, 
        goodbye_agent,
    ],
)
```


For detailed information about tool support, see [TOOLS.md](./TOOLS.md).

## Additional Documentation

- **[CONFIGURATION.md](./CONFIGURATION.md)** - Complete configuration guide
- **[TOOLS.md](./TOOLS.md)** - Tool support documentation
- **[USAGE.md](./USAGE.md)** - Usage examples and patterns
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Technical architecture and design details

## Migration Guide

### Migrating from v0.4.x 

If you are upgrading from version 0.4.x, please note the following changes:

- Agui tools are no longer automatically included in the root agent's toolset. You must explicitly add the `AGUIToolset` to your agent's tools list to access AG-UI client tools.

- Agui tools with names that conflict with existing agent tools will no longer be automatically removed. Use the `tool_name_prefix` and `tool_filter` parameters of `AGUIToolset` to manage tool name conflicts and filter which tools to include.

- If you want to maintain the previous behavior of only the root agent having access to AG-UI tools, and ensure no name conflicts, you can add the `AGUIToolset` with a custom filter as the first tool in the root agent like this:

    ```python
    tools=[
        AGUIToolset(
            tool_filter=lambda tool, readonly_context=None: tool.name not in [
                "transfer_to_agent", 
                "any other tools provided to this agent that overlap with agui tools...",
            ],
        ),
        ...other tools...
    ]
    ```
