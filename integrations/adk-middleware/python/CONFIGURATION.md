# ADK Middleware Configuration Guide

This guide covers all configuration options for the ADK Middleware.

## Table of Contents

- [Basic Configuration](#basic-configuration)
- [App and User Identification](#app-and-user-identification)
- [Session Management](#session-management)
- [Service Configuration](#service-configuration)
- [Memory Configuration](#memory-configuration)
- [Timeout Configuration](#timeout-configuration)
- [Concurrent Execution Limits](#concurrent-execution-limits)
- [FastAPI Integration](#fastapi-integration)

## Basic Configuration

The ADKAgent class is the main entry point for configuring the middleware. Here are the key parameters:

```python
from ag_ui_adk import ADKAgent, AGUIToolset
from google.adk.agents import Agent

# Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# Basic middleware configuration
agent = ADKAgent(
    adk_agent=my_agent,              # Required: The ADK agent to embed
    app_name="my_app",               # Required: Application identifier
    user_id="user123",               # Required: User identifier
    session_timeout_seconds=1200,    # Optional: Session timeout (default: 20 minutes)
    cleanup_interval_seconds=300,    # Optional: Cleanup interval (default: 5 minutes)
    max_sessions_per_user=10,        # Optional: Max sessions per user (default: 10)
    use_in_memory_services=True,     # Optional: Use in-memory services (default: True)
    execution_timeout_seconds=600,   # Optional: Execution timeout (default: 10 minutes)
    tool_timeout_seconds=300,        # Optional: Tool timeout (default: 5 minutes)
    max_concurrent_executions=5      # Optional: Max concurrent executions (default: 5)
)
```

## App and User Identification

There are two approaches for identifying applications and users:

### Static Identification

Best for single-tenant applications:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",      # Static app name
    user_id="static_user"   # Static user ID
)
```

### Dynamic Identification

Recommended for multi-tenant applications:

```python
from ag_ui.core import RunAgentInput

def extract_app(input: RunAgentInput) -> str:
    """Extract app name from request context."""
    for ctx in input.context:
        if ctx.description == "app":
            return ctx.value
    return "default_app"

def extract_user(input: RunAgentInput) -> str:
    """Extract user ID from request context."""
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

### Using Extracted Headers

When combined with `extract_headers` (see [Header Extraction](#header-extraction)), extractors can use HTTP headers for identification:

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

agent = ADKAgent(
    adk_agent=my_agent,
    user_id_extractor=lambda input: input.state.get("headers", {}).get("user_id", "anonymous"),
)

app = FastAPI()
add_adk_fastapi_endpoint(
    app, agent, "/chat",
    extract_headers=["x-user-id"]  # x-user-id header becomes state.headers.user_id
)
```

## Session Management

Sessions are managed automatically by the singleton `SessionManager`. Configuration options include:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",

    # Session configuration
    session_timeout_seconds=1200,    # Session expires after 20 minutes of inactivity
    cleanup_interval_seconds=300,    # Cleanup runs every 5 minutes
    max_sessions_per_user=10         # Maximum concurrent sessions per user
)
```

### Session Lifecycle

1. **Creation**: New session created on first request from a user
2. **Maintenance**: Session kept alive with each interaction
3. **Timeout**: Session marked for cleanup after timeout period
4. **Cleanup**: Expired sessions removed during cleanup intervals
5. **Memory**: If memory service configured, expired sessions saved before deletion

### State and Session Mapping

#### Thread ID → Session ID

The `threadId` from `RunAgentInput` maps directly to the ADK `session_id`. Each unique `threadId` corresponds to a unique ADK session, maintaining conversation continuity across multiple runs.

#### Initial State

The `state` field in `RunAgentInput` initializes and synchronizes session state:

- **New Session**: `state` becomes the initial ADK session state
- **Existing Session**: `state` is merged with existing session state on each request

This enables passing frontend context (user preferences, selected items, UI state) to the backend agent before execution begins.

## Service Configuration

The middleware supports both in-memory (development) and persistent (production) services:

### Development Configuration

Uses in-memory implementations for all services:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True  # Default behavior
)
```

### Production Configuration

Use persistent Google Cloud services:

```python
from google.adk.artifacts import GCSArtifactService
from google.adk.memory import VertexAIMemoryService
from google.adk.auth.credential_service import SecretManagerService

agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    artifact_service=GCSArtifactService(),        # Google Cloud Storage
    memory_service=VertexAIMemoryService(),       # Vertex AI Memory
    credential_service=SecretManagerService(),    # Secret Manager
    use_in_memory_services=False                  # Don't use in-memory defaults
)
```

### Custom Service Implementation

You can also provide custom service implementations:

```python
from google.adk.sessions import BaseSessionService
from google.adk.artifacts import BaseArtifactService
from google.adk.memory import BaseMemoryService
from google.adk.auth.credential_service import BaseCredentialService

class CustomSessionService(BaseSessionService):
    # Your implementation
    pass

agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    session_service=CustomSessionService(),
    use_in_memory_services=False
)
```

## Memory Configuration

### Automatic Session Memory

When a memory service is provided, expired sessions are automatically preserved:

```python
from google.adk.memory import VertexAIMemoryService

agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    memory_service=VertexAIMemoryService(),  # Enables automatic session memory
    use_in_memory_services=False
)

# Session preservation flow:
# 1. Session expires after timeout
# 2. Session data added to memory via memory_service.add_session_to_memory()
# 3. Session removed from active storage
# 4. Historical context available for future conversations
```

### Memory Tools Integration

To enable memory functionality in your agents, add ADK's memory tools:

```python
from google.adk.agents import Agent
from google.adk import tools as adk_tools

# Add memory tools to the ADK agent (not ADKAgent)
my_agent = Agent(
    name="assistant",
    model="gemini-3.5-flash",
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
        adk_tools.preload_memory_tool.PreloadMemoryTool(), # Memory tools here
    ]
)

# Create middleware with memory service
adk_agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    memory_service=VertexAIMemoryService()  # Memory service for session storage
)
```

**⚠️ Important**: The `tools` parameter belongs to the ADK agent, not the ADKAgent middleware.

### Testing Memory Configuration

For testing memory functionality with shorter timeouts:

```python
# Testing configuration with quick timeouts
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    memory_service=VertexAIMemoryService(),
    session_timeout_seconds=60,      # 1 minute timeout for testing
    cleanup_interval_seconds=30      # 30 second cleanup for testing
)
```

## Timeout Configuration

Configure various timeout settings:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",

    # Timeout settings
    session_timeout_seconds=1200,     # Session inactivity timeout (default: 20 min)
    execution_timeout_seconds=600,    # Max execution time (default: 10 min)
    tool_timeout_seconds=300          # Tool execution timeout (default: 5 min)
)
```

### Timeout Hierarchy

1. **Tool Timeout**: Applied to individual tool executions
2. **Execution Timeout**: Applied to entire agent execution
3. **Session Timeout**: Applied to user session inactivity

## Concurrent Execution Limits

Control resource usage with execution limits:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",

    # Concurrency settings
    max_concurrent_executions=5,     # Max concurrent agent executions (default: 5)
    max_sessions_per_user=10         # Max sessions per user (default: 10)
)
```

### Resource Management

- Prevents resource exhaustion from runaway executions
- Automatic cleanup of stale executions
- Queue management for tool events
- Proper task cancellation on timeout

## Environment Variables

Some configurations can be set via environment variables:

```bash
# Google API credentials
export GOOGLE_API_KEY="your-api-key"

# ADK middleware URL (for Dojo app)
export ADK_MIDDLEWARE_URL="http://localhost:8000"
```

## FastAPI Integration

When using with FastAPI, configure the endpoint:

```python
from fastapi import FastAPI
from ag_ui_adk import add_adk_fastapi_endpoint

app = FastAPI()

# Add endpoint with custom path
add_adk_fastapi_endpoint(
    app,
    agent,
    path="/chat"  # Custom endpoint path
)

# Multiple agents on different endpoints
add_adk_fastapi_endpoint(app, general_agent, path="/agents/general")
add_adk_fastapi_endpoint(app, technical_agent, path="/agents/technical")
```

### Endpoint Agent Resolver

Configure `agent_resolver` when one endpoint needs to dispatch to different
`ADKAgent` instances per request:

```python
from ag_ui_adk import add_adk_fastapi_endpoint


async def extract_tenant_state(request, input_data):
    return {"tenant": request.headers.get("x-tenant")}


async def agent_resolver(request, input_data):
    state = input_data.state if isinstance(input_data.state, dict) else {}
    if state.get("tenant") == "enterprise":
        return enterprise_agent
    return None  # Use the default agent


add_adk_fastapi_endpoint(
    app,
    default_agent,
    path="/chat",
    extract_state_from_request=extract_tenant_state,
    agent_resolver=agent_resolver,
)
```

Resolver behavior:
- Runs after `extract_state_from_request` or legacy `extract_headers` has
  merged request-derived state into `input_data.state`
- Receives the FastAPI `Request` and the post-extraction `RunAgentInput`
- Must return an `ADKAgent` instance or `None`
- Applies to the run endpoint, `/chat/capabilities`, and `/agents/state`
- Falls back to the default agent when it returns `None`

For `/chat/capabilities` and `/agents/state`, the middleware constructs a
synthetic `RunAgentInput` before calling the resolver. Those requests should be
routed from the FastAPI `Request` or extractor-populated state, not from
tool-history messages or arbitrary run-body state.

For trusted tenant, authorization, or data-boundary routing, read from
`request.headers` directly or use a custom `extract_state_from_request` that
writes authoritative top-level routing keys. Do not route from `state.headers`
when using legacy `extract_headers`; client-provided `state.headers` values take
precedence over extracted header values for backwards compatibility.

This is useful for tenant routing, request-header routing, and agent registries
where each target owns a separate middleware configuration. It does not replace
ADK's `sub_agents` delegation model inside a single ADK application.

For tool-result resumption, prefer resolving the latest tool result back to the
agent that emitted the matching tool call before applying normal request-state
routing:

```python
from ag_ui_adk import resolve_agent_from_message_history

AGENT_REGISTRY = {
    "default": default_agent,
    "support": support_agent,
    "billing": billing_agent,
}


async def agent_resolver(request, input_data):
    history_agent = resolve_agent_from_message_history(
        input_data.messages,
        AGENT_REGISTRY,
    )
    if history_agent is not None:
        return history_agent

    state = input_data.state if isinstance(input_data.state, dict) else {}
    return AGENT_REGISTRY.get(state.get("to_agent"))
```

`resolve_agent_from_message_history()` treats `AssistantMessage.name` as the
agent registry key, checks only the latest `ToolMessage`, and matches that
tool result to the prior assistant `tool_calls[].id`. Include every possible
tool-call origin in the registry, and preserve the assistant message and
`name` field in client-supplied histories when resumptions must be pinned to
their originating agent.

### Header Extraction

Extract HTTP headers into `state.headers` for use by extractors and agents:

```python
add_adk_fastapi_endpoint(
    app, agent, "/chat",
    extract_headers=["x-user-id", "x-tenant-id"]
)
```

**Transformation rules:**
- `x-` prefix is stripped: `x-user-id` → `user_id`
- Hyphens converted to underscores: `x-tenant-id` → `tenant_id`
- Missing headers are silently skipped
- Client-provided `state.headers` values take precedence

**Example with user_id extractor:**

```python
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

agent = ADKAgent(
    adk_agent=my_agent,
    user_id_extractor=lambda input: input.state.get("headers", {}).get("user_id", "anonymous"),
)

add_adk_fastapi_endpoint(
    app, agent, "/chat",
    extract_headers=["x-user-id", "x-tenant-id"]
)
```

Client request:
```
POST /chat
x-user-id: user123
x-tenant-id: tenant456

{"state": {"foo": "bar"}, ...}
```

Agent receives:
```python
input.state = {
    "headers": {"user_id": "user123", "tenant_id": "tenant456"},
    "foo": "bar"
}
```

## Logging Configuration

Configure logging for debugging:

```python
import logging

# Configure logging level
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Component-specific loggers
logging.getLogger('adk_agent').setLevel(logging.DEBUG)
logging.getLogger('event_translator').setLevel(logging.INFO)
logging.getLogger('session_manager').setLevel(logging.WARNING)
logging.getLogger('endpoint').setLevel(logging.ERROR)
```

See [LOGGING.md](./LOGGING.md) for detailed logging configuration.

## Best Practices

1. **Development**: Use in-memory services with default timeouts
2. **Testing**: Use shorter timeouts for faster iteration
3. **Production**: Use persistent services with appropriate timeouts
4. **Multi-tenant**: Use dynamic app/user extraction
5. **Resource Management**: Set appropriate concurrent execution limits
6. **Monitoring**: Configure logging appropriately for your environment

## Related Documentation

- [USAGE.md](./USAGE.md) - Usage examples and patterns
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture details
- [README.md](./README.md) - Quick start guide
