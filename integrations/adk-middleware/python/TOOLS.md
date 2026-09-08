# ADK Middleware Tool Support Guide

This guide covers the tool support functionality in the ADK Middleware.

## Overview

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents. All tools supplied by the client are currently implemented as long-running tools that emit events to the client for execution and can be combined with backend tools provided by the agent to create a hybrid combined toolset.

### Execution Flow

```
1. Initial AG-UI Run → ADK Agent starts execution
2. ADK Agent requests tool use → Execution pauses
3. Tool events emitted → Client receives tool call information
4. Client executes tools → Results prepared asynchronously
5. Subsequent AG-UI Run with ToolMessage → Tool execution resumes
6. ADK Agent execution resumes → Continues with tool results
7. Final response → Execution completes
```

## Tool Execution Modes

The middleware currently implements all client-supplied tools as long-running:

### Long-Running Tools (Current Implementation)
**Perfect for Human-in-the-Loop (HITL) workflows**

- **Fire-and-forget pattern**: Returns `None` immediately without waiting
- **No timeout applied**: Execution continues until tool result is provided
- **Ideal for**: User approval workflows, document review, manual input collection
- **ADK Pattern**: Established pattern where tools pause execution for human interaction

```python
# Long-running tool example
approval_tool = Tool(
    name="request_approval",
    description="Request human approval for sensitive operations",
    parameters={"type": "object", "properties": {"action": {"type": "string"}}}
)

# Tool execution returns immediately
# Client provides result via ToolMessage in subsequent run
```

## Tool Configuration Examples

### Creating Tools

```python
from ag_ui_adk import ADKAgent, AGUIToolset
from google.adk.agents import LlmAgent
from ag_ui.core import RunAgentInput, UserMessage, Tool

# 1. Create tools for different purposes
# Tool for human approval
task_approval_tool = Tool(
    name="request_approval",
    description="Request human approval for task execution",
    parameters={
        "type": "object",
        "properties": {
            "task": {"type": "string", "description": "Task requiring approval"},
            "risk_level": {"type": "string", "enum": ["low", "medium", "high"]}
        },
        "required": ["task"]
    }
)

# Tool for calculations
calculator_tool = Tool(
    name="calculate",
    description="Perform mathematical calculations",
    parameters={
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": "Mathematical expression"}
        },
        "required": ["expression"]
    }
)

# Tool for API calls
weather_tool = Tool(
    name="get_weather",
    description="Get current weather information",
    parameters={
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "City name"}
        },
        "required": ["location"]
    }
)

# 2. Set up ADK agent with tool support
agent = LlmAgent(
    name="assistant",
    model="gemini-3.5-flash",
    instruction="""You are a helpful assistant that can request approvals and perform calculations.
    Use request_approval for sensitive operations that need human review.
    Use calculate for math operations and get_weather for weather information."""
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# 3. Create middleware
adk_agent = ADKAgent(
    adk_agent=agent,
    user_id="user123",
    tool_timeout_seconds=60,       # Timeout configuration
    execution_timeout_seconds=300  # Overall execution timeout
)

# 4. Include tools in RunAgentInput
user_input = RunAgentInput(
    thread_id="thread_123",
    run_id="run_456",
    messages=[UserMessage(
        id="1",
        role="user",
        content="Calculate 15 * 8 and then request approval for the result"
    )],
    tools=[task_approval_tool, calculator_tool, weather_tool],
    context=[],
    state={},
    forwarded_props={}
)
```

## Tool Execution Flow Example

Example showing how tools are handled across multiple AG-UI runs:

```python
async def demonstrate_tool_execution():
    """Example showing tool execution flow."""

    # Step 1: Initial run - starts execution with tools
    print("🚀 Starting execution with tools...")

    initial_events = []
    async for event in adk_agent.run(user_input):
        initial_events.append(event)

        if event.type == "TOOL_CALL_START":
            print(f"🔧 Tool call: {event.tool_call_name} (ID: {event.tool_call_id})")
        elif event.type == "TEXT_MESSAGE_CONTENT":
            print(f"💬 Assistant: {event.delta}", end="", flush=True)

    print("\n📊 Initial execution completed - tools awaiting results")

    # Step 2: Handle tool results
    tool_results = []

    # Extract tool calls from events
    for event in initial_events:
        if event.type == "TOOL_CALL_START":
            tool_call_id = event.tool_call_id
            tool_name = event.tool_call_name

            if tool_name == "calculate":
                # Execute calculation
                result = {"result": 120, "expression": "15 * 8"}
                tool_results.append((tool_call_id, result))

            elif tool_name == "request_approval":
                # Handle human approval
                result = await handle_human_approval(tool_call_id)
                tool_results.append((tool_call_id, result))

    # Step 3: Submit tool results and resume execution
    if tool_results:
        print(f"\n🔄 Resuming execution with {len(tool_results)} tool results...")

        # Create ToolMessage entries for resumption
        tool_messages = []
        for tool_call_id, result in tool_results:
            tool_messages.append(
                ToolMessage(
                    id=f"tool_{tool_call_id}",
                    role="tool",
                    content=json.dumps(result),
                    tool_call_id=tool_call_id
                )
            )

        # Resume execution with tool results
        resume_input = RunAgentInput(
            thread_id=user_input.thread_id,
            run_id=f"{user_input.run_id}_resume",
            messages=tool_messages,
            tools=[],  # No new tools needed
            context=[],
            state={},
            forwarded_props={}
        )

        # Continue execution with results
        async for event in adk_agent.run(resume_input):
            if event.type == "TEXT_MESSAGE_CONTENT":
                print(f"💬 Assistant: {event.delta}", end="", flush=True)
            elif event.type == "RUN_FINISHED":
                print(f"\n✅ Execution completed successfully!")

async def handle_human_approval(tool_call_id):
    """Simulate human approval workflow for long-running tools."""
    print(f"\n👤 Human approval requested for call {tool_call_id}")
    print("⏳ Waiting for human input...")

    # Simulate user interaction delay
    await asyncio.sleep(2)

    return {
        "approved": True,
        "approver": "user123",
        "timestamp": time.time(),
        "comments": "Approved after review"
    }
```

## Tool Categories

### Human-in-the-Loop Tools
Perfect for workflows requiring human approval, review, or input:

```python
# Tools that pause execution for human interaction
approval_tools = [
    Tool(name="request_approval", description="Request human approval for actions"),
    Tool(name="collect_feedback", description="Collect user feedback on generated content"),
    Tool(name="review_document", description="Submit document for human review")
]
```

### Generative UI Tools
Enable dynamic UI generation based on tool results:

```python
# Tools that generate UI components
ui_generation_tools = [
    Tool(name="generate_form", description="Generate dynamic forms"),
    Tool(name="create_dashboard", description="Create data visualization dashboards"),
    Tool(name="build_workflow", description="Build interactive workflow UIs")
]
```

## Real-World Example: Tool-Based Generative UI

The `examples/tool_based_generative_ui/` directory contains an example that integrates with the existing haiku app in the Dojo:

### Haiku Generator with Image Selection

```python
# Tool for generating haiku with complementary images
haiku_tool = Tool(
    name="generate_haiku",
    description="Generate a traditional Japanese haiku with selected images",
    parameters={
        "type": "object",
        "properties": {
            "japanese_haiku": {
                "type": "string",
                "description": "Traditional 5-7-5 syllable haiku in Japanese"
            },
            "english_translation": {
                "type": "string",
                "description": "Poetic English translation"
            },
            "selected_images": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Exactly 3 image filenames that complement the haiku"
            },
            "theme": {
                "type": "string",
                "description": "Theme or mood of the haiku"
            }
        },
        "required": ["japanese_haiku", "english_translation", "selected_images"]
    }
)
```

### Key Features Demonstrated
- **ADK Agent Integration**: ADK agent creates haiku with structured output
- **Structured Tool Output**: Tool returns JSON with haiku, translation, and image selections
- **Generative UI**: Client can dynamically render UI based on tool results

### Usage Pattern
```python
# 1. User generates request
# 2. ADK agent analyzes request and calls generate_haiku tool
# 3. Tool returns structured data with haiku and image selections
# 4. Client renders UI with haiku text and selected images
# 5. User can request variations or different themes
```

This example showcases applications where:
- **AI agents** generate structured content
- **Dynamic UI** adapts based on tool output
- **Interactive workflows** allow refinement and iteration
- **Rich media** combines text, images, and user interface elements

## Working Examples

See the `examples/` directory for working examples:

- **`tool_based_generative_ui/`**: Generative UI example integrating with Dojo
  - Structured output for UI generation
  - Dynamic UI rendering based on tool results
  - Interactive workflows with user refinement
  - Real-world application patterns

## Tool Events

The middleware emits the following AG-UI events for tools:

| Event Type | Description |
|------------|-------------|
| `TOOL_CALL_START` | Tool execution begins |
| `TOOL_CALL_ARGS` | Tool arguments provided |
| `TOOL_CALL_END` | Tool execution completes |

## Best Practices

1. **Tool Design**: Create tools with clear, single responsibilities
2. **Parameter Validation**: Use JSON schema for robust parameter validation
3. **Error Handling**: Implement proper error handling in tool implementations
4. **Event Monitoring**: Monitor tool events for debugging and observability
5. **Tool Documentation**: Provide clear descriptions for tool discovery

## Related Documentation

- [CONFIGURATION.md](./CONFIGURATION.md) - Tool timeout configuration
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical details on tool proxy implementation
- [USAGE.md](./USAGE.md) - General usage examples
- [README.md](./README.md) - Quick start guide