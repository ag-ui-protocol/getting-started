# ADK Middleware Architecture

This document describes the architecture and design of the ADK Middleware that bridges Google ADK agents with the AG-UI Protocol.

## High-Level Architecture

```
AG-UI Protocol          ADK Middleware           Google ADK
     │                        │                       │
RunAgentInput ──────> ADKAgent.run() ──────> Runner.run_async()
     │                        │                       │
     │                 EventTranslator                │
     │                        │                       │
BaseEvent[] <──────── translate events <──────── Event[]
```

## Core Components

### ADKAgent (`adk_agent.py`)
The main orchestrator that:
- Manages agent lifecycle and session state
- Handles the bridge between AG-UI Protocol and ADK
- Coordinates tool execution through proxy tools
- Implements direct agent embedding pattern

### FastAPI Endpoint Layer (`endpoint.py`)
Owns the HTTP service boundary around one default `ADKAgent`:
- Extracts request-derived state before execution
- Applies the optional endpoint-level `AgentResolver`
- Serves the run endpoint, derived `<path>/capabilities` endpoint, and experimental `/agents/state` endpoint
- Keeps transport negotiation, resolver dispatch, and endpoint-scoped error handling outside the ADK runner abstraction

### EventTranslator (`event_translator.py`)
Converts between event formats:
- ADK events → AG-UI protocol events (16 standard event types)
- Maintains proper message boundaries
- Handles streaming text content
- Per-session instances for thread safety

### SessionManager (`session_manager.py`)
Singleton pattern for centralized session control:
- Automatic session cleanup with configurable timeouts
- Session isolation per user
- Memory service integration for session persistence
- Resource management and limits

### ExecutionState (`execution_state.py`)
Tracks background ADK executions:
- Manages asyncio tasks running ADK agents
- Event queue for streaming results
- Execution timing and completion tracking
- Tool call state management

### ClientProxyTool (`client_proxy_tool.py`)
Individual tool proxy implementation:
- Wraps AG-UI tools for ADK compatibility
- Emits tool events to client
- Currently all tools are long-running
- Integrates with ADK's tool system

### ClientProxyToolset (`client_proxy_toolset.py`)
Manages collections of proxy tools:
- Dynamic toolset creation per request
- Fresh tool instances for each execution
- Combines client and backend tools

## Event Flow

1. **Client Request**: AG-UI Protocol `RunAgentInput` received
2. **Endpoint Processing**: Request state is extracted and the optional resolver selects the `ADKAgent`
3. **Session Resolution**: SessionManager finds or creates session for the resolved agent
4. **Agent Execution**: ADK Runner executes agent with context
5. **Tool Handling**: ClientProxyTools emit events for client-side execution
6. **Event Translation**: ADK events converted to AG-UI events
7. **Streaming Response**: Events streamed back via SSE or other transport

## Key Design Patterns

### Direct Agent Embedding
```python
# Agents are directly embedded in ADKAgent instances
agent = ADKAgent(
    adk_agent=my_adk_agent,  # Direct reference
    app_name="my_app",
    user_id="user123"
)
```

### Service Dependency Injection
The middleware uses dependency injection for ADK services:
- Session service (default: InMemorySessionService)
- Memory service (optional, enables session persistence)
- Artifact service (default: InMemoryArtifactService)
- Credential service (default: InMemoryCredentialService)

### Tool Proxy Pattern
All client-supplied tools are wrapped as long-running ADK tools:
- Emit events for client-side execution
- Can be combined with backend tools
- Unified tool handling interface

### Endpoint-Level Agent Resolution
`add_adk_fastapi_endpoint()` accepts an `agent_resolver` hook for deployments
where one FastAPI endpoint must dispatch to independently configured
`ADKAgent` instances. This is an endpoint-layer routing abstraction, not an
ADK `sub_agents` delegation model: the resolver selects which complete
middleware-wrapped agent receives the request, while each resolved agent keeps
its own ADK runner, services, capabilities, and session semantics.

Resolution runs after request state extraction, so resolvers can route from
headers, cookies, query parameters, tenant context, or request body state
through the same `RunAgentInput` contract that the selected agent will receive.
Returning `None` falls back to the default agent passed to
`add_adk_fastapi_endpoint()`.

The same resolver applies to:
- The primary run endpoint
- The derived `<path>/capabilities` endpoint
- The experimental `/agents/state` endpoint

Only the primary run endpoint receives the client's full run body. The
capabilities and state endpoints call the resolver with synthetic
`RunAgentInput` objects, so those surfaces should route from the FastAPI
`Request` or extractor-populated state rather than message history or arbitrary
body state.

Routed agents should share compatible session infrastructure when a conversation
can move between them and continuity matters. That means the same session-service
backing layer plus compatible `app_name`, `user_id`, extractor behavior, and
thread/session-id mapping. The middleware does not enforce cross-agent affinity
for open tool calls; that policy belongs in the resolver so applications can
encode their own tenancy, authorization, and handoff rules.

For human-in-the-loop or long-running tool resumption, the public
`resolve_agent_from_message_history()` helper provides a conservative
application convention. It treats `AssistantMessage.name` as an agent registry
key, only inspects the latest `ToolMessage`, matches its `tool_call_id` to a
prior assistant tool call, and returns the registered originating agent. If the
history lacks the assistant message, lacks the name, or names an unknown agent,
the helper returns `None` so the resolver can fall back to its normal routing
policy.

### Session Lifecycle
1. Session created on first request
2. Maintained across multiple runs
3. Automatic cleanup after timeout
4. Optional persistence to memory service

## Thread Safety

- Per-session EventTranslator instances
- Singleton SessionManager with proper locking
- Isolated execution states per thread
- Thread-safe event queues

## Error Handling

- RunErrorEvent for various failure scenarios
- Proper async exception handling
- Resource cleanup on errors
- Timeout management at multiple levels

## Performance Considerations

- Async/await throughout for non-blocking operations
- Event streaming for real-time responses
- Configurable concurrent execution limits
- Automatic stale execution cleanup
- Efficient event queue management

## Future Enhancements

- Additional tool execution modes
- Enhanced state synchronization
- More sophisticated error recovery
- Performance optimizations
- Extended protocol support