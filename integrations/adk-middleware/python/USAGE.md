# ADK Middleware Usage Guide

This guide provides detailed usage instructions and configuration options for the ADK Middleware.

## Configuration Options

### App and User Identification

```python
# Static app name and user ID (single-tenant apps)
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app", 
    user_id="static_user"
)

# Dynamic extraction from context (recommended for multi-tenant)
def extract_app(input: RunAgentInput) -> str:
    # Extract from context
    for ctx in input.context:
        if ctx.description == "app":
            return ctx.value
    return "default_app"

def extract_user(input: RunAgentInput) -> str:
    # Extract from context
    for ctx in input.context:
        if ctx.description == "user":
            return ctx.value
    return f"anonymous_{input.thread_id}"

agent = ADKAgent(
    adk_agent=my_agent,
    app_name_extractor=extract_app,
    user_id_extractor=extract_user
)
```

### Session Management

Session management is handled automatically by the singleton `SessionManager`. The middleware uses sensible defaults, but you can configure session behavior if needed by accessing the session manager directly:

```python
from ag_ui_adk.session_manager import SessionManager

# Session management is automatic, but you can access the manager if needed
session_mgr = SessionManager.get_instance()

# Create your ADK agent normally
agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True
)
```

### Thread ID vs Session ID Mapping

The middleware transparently handles the mapping between AG-UI's `thread_id` and ADK's internal `session_id`:

- **AG-UI `thread_id`**: The client-provided identifier (typically a UUID) that uniquely identifies a conversation thread from the frontend perspective
- **ADK `session_id`**: The backend-generated identifier used by ADK session services (e.g., VertexAI generates numeric IDs)

This mapping is completely transparent to frontend implementations:
- All AG-UI events (`RUN_STARTED`, `RUN_FINISHED`, etc.) use `thread_id`
- The middleware internally maintains a mapping from `thread_id` to `session_id`
- Session state includes metadata (`_ag_ui_thread_id`, `_ag_ui_app_name`, `_ag_ui_user_id`) for recovery after middleware restarts

```python
# Frontend sends thread_id - the backend session_id is handled internally
input = RunAgentInput(
    thread_id="my-uuid-thread-id",  # AG-UI thread identifier
    run_id="run_001",
    messages=[UserMessage(id="1", role="user", content="Hello!")],
    # ...
)

# Events returned to frontend always use thread_id
async for event in agent.run(input):
    # event.thread_id == "my-uuid-thread-id" (not the internal session_id)
    print(f"Event for thread: {event.thread_id}")
```

### Service Configuration

```python
# Development (in-memory services) - Default
agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True  # Default behavior
)

# Production with custom services
agent = ADKAgent(
    app_name="my_app", 
    user_id="user123",
    artifact_service=GCSArtifactService(),
    memory_service=VertexAIMemoryService(),  
    credential_service=SecretManagerService(),
    use_in_memory_services=False
)
```

### Using App for Full ADK Features

For access to App-level features like resumability, context caching, and plugins,
use the `from_app()` constructor:

```python
from google.adk.apps import App
from google.adk.agents import Agent
from google.adk.plugins.logging_plugin import LoggingPlugin
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

# Create ADK App with plugins and configs
app = App(
    name="my_assistant",
    root_agent=Agent(
        name="assistant",
        model="gemini-3.5-flash",
        instruction="You are a helpful assistant.",
        tools=[
            AGUIToolset(), # Add the tools provided by the AG-UI client
        ]
    ),
    plugins=[LoggingPlugin()],
    # resumability_config=ResumabilityConfig(is_resumable=True),  # Optional
)

# Create ADKAgent from App
agent = ADKAgent.from_app(
    app,
    user_id="demo_user",
    plugin_close_timeout=10.0,  # Optional, requires ADK 1.19+
)

# Use with FastAPI
from fastapi import FastAPI
fastapi_app = FastAPI()
add_adk_fastapi_endpoint(fastapi_app, agent, path="/chat")
```

The `from_app()` constructor enables:
- **Plugin support**: Use ADK plugins like `LoggingPlugin` for debugging and tracing
- **Resumability**: Configure pause/resume workflows for long-running operations
- **Context caching**: Optimize LLM calls with context caching configuration
- **Events compaction**: Configure how events are compacted in the application

Note: The `plugin_close_timeout` parameter requires ADK 1.19.0 or later. On older
versions, the parameter is silently ignored.

### Automatic Session Memory

When you provide a `memory_service`, the middleware automatically preserves expired sessions in ADK's memory service before deletion. This enables powerful conversation history and context retrieval features.

```python
from google.adk.memory import VertexAIMemoryService

# Enable automatic session memory
agent = ADKAgent(
    app_name="my_app",
    user_id="user123", 
    memory_service=VertexAIMemoryService(),  # Sessions auto-saved here on expiration
    use_in_memory_services=False
)

# Now when sessions expire (default 20 minutes), they're automatically:
# 1. Added to memory via memory_service.add_session_to_memory()
# 2. Then deleted from active session storage
# 3. Available for retrieval and context in future conversations
```

## Memory Tools Integration

To enable memory functionality in your ADK agents, you need to add Google ADK's memory tools to your agents (not to the ADKAgent middleware):

```python
from google.adk.agents import Agent
from google.adk import tools as adk_tools

# Create agent with memory tools - THIS IS CORRECT
my_agent = Agent(
    name="assistant",
    model="gemini-3.5-flash", 
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
        adk_tools.preload_memory_tool.PreloadMemoryTool(), # Add memory tools here
    ]
)

# Create middleware with direct agent embedding
adk_agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    memory_service=shared_memory_service  # Memory service enables automatic session memory
)
```

**⚠️ Important**: The `tools` parameter belongs to the ADK agent (like `Agent` or `LlmAgent`), **not** to the `ADKAgent` middleware. To add agui client tools, use the `AGUIToolset()` as shown above.

**Testing Memory Workflow:**

1. Start a conversation and provide information (e.g., "My name is John")
2. Wait for session timeout + cleanup interval (up to 90 seconds with testing config: 60s timeout + up to 30s for next cleanup cycle)
3. Start a new conversation and ask about the information ("What's my name?").
4. The agent should remember the information from the previous session.

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

### Passing Initial State

Pass frontend state to initialize the ADK session before the agent runs:

```python
input = RunAgentInput(
    thread_id="session_001",
    run_id="run_001",
    state={
        "selected_document": "doc-456",
        "user_preferences": {"language": "en", "theme": "dark"},
        "context": {"project_id": "proj-123"}
    },
    messages=[
        UserMessage(id="1", role="user", content="Summarize the selected document")
    ],
    context=[],
    tools=[],
    forwarded_props={}
)

# The agent can now access state.selected_document, state.user_preferences, etc.
async for event in agent.run(input):
    print(f"Event: {event.type}")
```

The `state` field:
- Initializes ADK session state on first request for a `thread_id`
- Syncs/merges with existing state on subsequent requests
- Is accessible to ADK agent tools via `context.session.state`

### Using Context

The `context` field from `RunAgentInput` is automatically passed through to ADK agents.
Context is useful for providing metadata about the current request (user info, preferences,
environment details) that the agent can use for personalization.

Context is accessible in two ways:

#### 1. In Tools via Session State

```python
from google.adk.tools import ToolContext
from ag_ui_adk import CONTEXT_STATE_KEY

def personalized_tool(tool_context: ToolContext) -> str:
    """Access context in a tool via session state."""
    context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])

    user_role = None
    for item in context_items:
        if item["description"] == "user_role":
            user_role = item["value"]
            break

    if user_role == "admin":
        return "Welcome, administrator! You have full access."
    return "Welcome! You have standard access."

# Create agent with the tool
my_agent = Agent(
    name="assistant",
    tools=[personalized_tool]
)
```

#### 2. In Instruction Providers via Session State

```python
from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui_adk import CONTEXT_STATE_KEY

def context_aware_instructions(ctx: ReadonlyContext) -> str:
    """Dynamic instructions based on context."""
    instructions = "You are a helpful assistant."

    # Access context from session state
    context_items = ctx.state.get(CONTEXT_STATE_KEY, [])

    # Find user's preferred language
    for item in context_items:
        if item["description"] == "preferred_language":
            instructions += f"\nRespond in {item['value']}."
            break

    return instructions

# Create agent with dynamic instructions
my_agent = LlmAgent(
    name="assistant",
    model="gemini-3.5-flash",
    instruction=context_aware_instructions,  # Callable, not string
)
```

#### Example Request with Context

```python
input = RunAgentInput(
    thread_id="session_001",
    run_id="run_001",
    messages=[
        UserMessage(id="1", role="user", content="Hello!")
    ],
    context=[
        Context(description="user_role", value="admin"),
        Context(description="preferred_language", value="Spanish"),
        Context(description="timezone", value="America/New_York"),
    ],
    state={},
    tools=[],
    forwarded_props={}
)

async for event in agent.run(input):
    print(f"Event: {event.type}")
```

#### Alternative: Via RunConfig custom_metadata (ADK 1.22.0+)

For users on ADK 1.22.0 or later, context is also available via `RunConfig.custom_metadata`:

```python
def dynamic_instructions(ctx: ReadonlyContext) -> str:
    instructions = "You are a helpful assistant."

    # Alternative access via custom_metadata (ADK 1.22.0+)
    if ctx.run_config and ctx.run_config.custom_metadata:
        context_items = ctx.run_config.custom_metadata.get('ag_ui_context', [])
        for item in context_items:
            instructions += f"\n- {item['description']}: {item['value']}"

    return instructions
```

**Note:** Session state (`ctx.state.get(CONTEXT_STATE_KEY, [])`) is the recommended approach as it works with all ADK versions and provides a unified access pattern for both tools and instruction providers.

See `examples/other/context_usage.py` for a complete working example.

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

### Endpoint Agent Resolver

Use `agent_resolver` when a single FastAPI endpoint should route each request
to one of several independently configured `ADKAgent` wrappers. The resolver
runs after request state extraction and may return an `ADKAgent` or `None`.
Returning `None` uses the default agent supplied to `add_adk_fastapi_endpoint()`.

```python
from fastapi import FastAPI
from ag_ui_adk import (
    ADKAgent,
    add_adk_fastapi_endpoint,
    resolve_agent_from_message_history,
)

default_agent = ADKAgent(adk_agent=supervisor, app_name="demo", user_id="demo")
support_agent = ADKAgent(adk_agent=support, app_name="demo", user_id="demo")
billing_agent = ADKAgent(adk_agent=billing, app_name="demo", user_id="demo")

AGENT_REGISTRY = {
    "supervisor": default_agent,
    "support": support_agent,
    "billing": billing_agent,
}


async def extract_agent_state(request, input_data):
    agent_key = request.headers.get("x-agent-key")
    return {"to_agent": agent_key} if agent_key else {}


async def agent_resolver(request, input_data):
    history_agent = resolve_agent_from_message_history(
        input_data.messages,
        AGENT_REGISTRY,
    )
    if history_agent is not None:
        return history_agent

    state = input_data.state if isinstance(input_data.state, dict) else {}
    return AGENT_REGISTRY.get(state.get("to_agent"))


app = FastAPI()
add_adk_fastapi_endpoint(
    app,
    default_agent,
    path="/agent",
    extract_state_from_request=extract_agent_state,
    agent_resolver=agent_resolver,
)
```

This is an endpoint routing boundary, not ADK sub-agent delegation. Use it when
each route target has its own `ADKAgent` configuration, capabilities, or service
dependencies. If a conversation can move between routed agents, configure those
agents with compatible session infrastructure: the same session-service backing
layer plus compatible `app_name`, `user_id`, extractor behavior, and
thread/session-id mapping.

The resolver also runs for `/agent/capabilities` and `/agents/state`, but those
surfaces use synthetic `RunAgentInput` objects rather than a normal run body.
Route those requests from the FastAPI `Request` or extractor-populated state,
not from tool history or arbitrary run-body state.

The helper convention requires the registry to include every agent that can
originate an open tool call, and the inbound message history must preserve the
assistant tool-call message with `AssistantMessage.name` set to that registry
key. The ADK middleware preserves concrete ADK event authors this way when
converting session events to AG-UI messages. If the latest message is not a
`ToolMessage`, or the matching assistant message cannot be resolved,
`resolve_agent_from_message_history()` returns `None` so the resolver can apply
its normal request, extractor, or default fallback policy.

### Predictive State Updates

Predictive state updates allow the frontend to receive real-time state changes derived from tool call arguments. This is particularly useful for live previews — for example, showing a document update immediately when a tool call completes.

The `predict_state` configuration watches for a specific tool and argument, emitting `CUSTOM` events with `STATE_DELTA` patches that let the frontend render content as soon as the tool call arrives.

#### Basic Setup

```python
from ag_ui_adk import ADKAgent, PredictStateMapping, AGUIToolset
from google.adk.agents import LlmAgent

agent = LlmAgent(
    name="writer",
    model="gemini-3.5-flash",
    instruction="Use write_document to write documents.",
    tools=[write_document, AGUIToolset()],
)

adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="my_app",
    user_id="user123",
    predict_state=[
        PredictStateMapping(
            state_key="document",          # Frontend state key to update
            tool="write_document",         # Tool name to watch
            tool_argument="document",      # Argument to extract
        )
    ],
)
```

See `examples/server/api/predictive_state_updates.py` for a complete working example.

## Event Translation

The middleware translates between AG-UI and ADK event formats:

| AG-UI Event | ADK Event | Description |
|-------------|-----------|-------------|
| TEXT_MESSAGE_* | Event with content.parts[].text | Text messages |
| RUN_STARTED/FINISHED | Runner lifecycle | Execution flow |

## Message History Features

### MESSAGES_SNAPSHOT Emission

You can configure the middleware to emit a `MESSAGES_SNAPSHOT` event at the end of each run, containing the full conversation history:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    emit_messages_snapshot=True  # Emit full message history at run end
)
```

When enabled, the middleware will:
1. Extract all events from the ADK session at the end of each run
2. Convert them to AG-UI message format
3. Emit a `MESSAGES_SNAPSHOT` event with the complete conversation history

This is useful for clients that need to persist conversation history or for AG-UI protocol compliance.

### Converting ADK Events to Messages

The `adk_events_to_messages()` function is available for direct use if you need to convert ADK session events to AG-UI messages:

```python
from ag_ui_adk import adk_events_to_messages

# Get events from an ADK session
session = await session_service.get_session(session_id, app_name, user_id)
messages = adk_events_to_messages(session.events)

# messages is a list of AG-UI Message objects (UserMessage, AssistantMessage, ToolMessage)
```

### Experimental: /agents/state Endpoint

**WARNING: This endpoint is experimental and subject to change in future versions.**

When using `add_adk_fastapi_endpoint()`, an additional `POST /agents/state` endpoint is automatically added. This endpoint allows front-end frameworks to retrieve thread state and message history on-demand, without initiating a new agent run.

**Request:**
```json
{
  "threadId": "thread_123",
  "appName": "my_app",
  "userId": "user_123",
  "name": "optional_agent_name",
  "properties": {}
}
```

The `appName` and `userId` parameters are optional if the `ADKAgent` was configured with static values. When an extractor or resolver is configured, request/extractor-derived identity takes precedence; body `appName` and `userId` are fallback inputs for deployments that configure neither static identity nor extractor-supplied identity.

**Response:**
```json
{
  "threadId": "thread_123",
  "threadExists": true,
  "state": "{\"key\": \"value\"}",
  "messages": "[{\"id\": \"1\", \"role\": \"user\", \"content\": \"Hello\"}]"
}
```

Note: The `state` and `messages` fields are JSON-stringified for compatibility with front-end frameworks that expect this format.

**Example usage:**
```python
import httpx

async def get_thread_history(thread_id: str, app_name: str, user_id: str):
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "http://localhost:8000/agents/state",
            json={
                "threadId": thread_id,
                "appName": app_name,
                "userId": user_id
            }
        )
        data = response.json()
        if data["threadExists"]:
            import json
            messages = json.loads(data["messages"])
            state = json.loads(data["state"])
            return messages, state
        return [], {}
```

## Migrating to Resumable HITL

> **Deprecated:** The non-resumable (fire-and-forget) HITL flow triggered by `ADKAgent(adk_agent=...)` with client-side tools is deprecated and will be removed in a future version. Migrate to `ADKAgent.from_app()` with `ResumabilityConfig` for human-in-the-loop workflows.

### Why migrate?

The old-style HITL flow has limitations:
- **No SequentialAgent position restore** — sub-agent position is lost on resume
- **Manual FunctionCall persistence** — the middleware must manually persist partial events
- **Manual pending tool call tracking** — state management is handled by the middleware instead of ADK

With `ResumabilityConfig`, ADK handles all of this natively.

### Before (deprecated for HITL)

```python
from ag_ui_adk import ADKAgent

agent = ADKAgent(
    adk_agent=my_agent,  # Works fine for non-HITL agents
    app_name="my_app",
    user_id="user123",
)
```

> **Note:** `ADKAgent(adk_agent=...)` is still the recommended constructor for agents **without** client-side tools (chat-only, backend-tool-only). Only the HITL path is deprecated.

### After (recommended for HITL)

```python
from google.adk.apps import App, ResumabilityConfig
from ag_ui_adk import ADKAgent

app = App(
    name="my_app",
    root_agent=my_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)

agent = ADKAgent.from_app(
    app,
    user_id="user123",
)
```

### What triggers the deprecation warning?

A `DeprecationWarning` is emitted at runtime when:
1. The agent encounters a long-running (client-side) tool call, **and**
2. The agent was created with the direct constructor (`ADKAgent(adk_agent=...)`) rather than `ADKAgent.from_app()`

The warning does not fire for agents without client-side tools.

## Additional Resources

- For configuration options, see [CONFIGURATION.md](./CONFIGURATION.md)
- For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md)
- For development setup, see the main [README.md](./README.md)
- For API documentation, refer to the source code docstrings
