# AG-UI Nim SDK

A Nim implementation of the AG-UI (Agent-User Interaction Protocol) SDK, providing a lightweight, event-based protocol for standardizing how AI agents connect to front-end applications.

## Features

- **Event-based Protocol**: Support for all standard AG-UI event types including chunks
- **Message Types**: Full implementation of all AG-UI message types (Developer, System, Assistant, User, Tool)
- **Tool Support**: Complete tool call lifecycle with start, args, and end events
- **State Management**: Snapshot and delta events for state synchronization
- **HTTP Agent**: Built-in HTTP agent with SSE (Server-Sent Events) support
- **Event Verification**: Protocol compliance verification to ensure valid event sequences
- **Event Application**: Transform events into application state with full JSON patch support
- **Chunk Transformations**: Convert chunk-based streaming to standard events
- **Observable Pattern**: RxJS-like observables for event streaming and transformation
- **Protocol Buffer Support**: Binary protocol encoding and decoding for efficient transport
- **Legacy Format Support**: Backward compatibility with CopilotKit and older formats
- **Media Type Negotiation**: Content type processing with quality factor support
- **Schema Validation**: Runtime type validation for all protocol types
- **Type Safety**: Strong typing with Nim's type system
- **Extensible**: Easy to implement custom agents and event handlers

## Installation

```bash
nimble install ag_ui_nim_sdk
```

## Quick Start

### Creating Messages

```nim
import ag_ui_nim

# Create different message types
let userMsg = newUserMessage("msg1", "Hello, AI!")
let assistantMsg = newAssistantMessage("msg2", some("Hello! How can I help you today?"))
let systemMsg = newSystemMessage("msg3", "You are a helpful assistant")

# Create a tool call
let functionCall = newFunctionCall("search", """{"query": "nim programming"}""")
let toolCall = newToolCall("tc1", "function", functionCall)
let assistantWithTool = newAssistantMessage("msg4", none(string), some(@[toolCall]))
```

### Working with Events

```nim
import ag_ui_nim

# Create text message events
let startEvent = newTextMessageStartEvent("msg1", "assistant")
let contentEvent = newTextMessageContentEvent("msg1", "Hello, ")
let endEvent = newTextMessageEndEvent("msg1")

# Create tool call events
let toolStartEvent = newToolCallStartEvent("tc1", "search")
let toolArgsEvent = newToolCallArgsEvent("tc1", """{"query": "nim"}""")
let toolEndEvent = newToolCallEndEvent("tc1")

# Create state events
let state = %*{"counter": 0, "active": true}
let stateSnapshot = newStateSnapshotEvent(state)
```

### Using the Event Encoder

```nim
import ag_ui_nim

let encoder = newEventEncoder()
let event = newTextMessageStartEvent("msg1", "assistant")

# Encode to SSE format
let encoded = encoder.encode(event)
echo encoded
# Output: data: {"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}\n\n
```

### Verifying Events

```nim
import ag_ui_nim

# Create a sequence of events
let events = @[
  newRunStartedEvent("run1"),
  newTextMessageStartEvent("msg1", "assistant"),
  newTextMessageContentEvent("msg1", "Hello, world!"),
  newTextMessageEndEvent("msg1"),
  newRunFinishedEvent("run1")
]

# Verify events follow the protocol
let verifiedEvents = verifyEvents(events)
```

### Transforming Event State

```nim
import ag_ui_nim
import json

# Create input state
let input = RunAgentInput(
  threadId: "thread1",
  runId: "run1",
  messages: @[],
  state: %*{},
  tools: @[],
  context: @[]
)

# Create events
let events = @[
  newTextMessageStartEvent("msg1", "assistant"),
  newTextMessageContentEvent("msg1", "Hello"),
  newStateSnapshotEvent(%*{"counter": 42})
]

# Apply events to get updated state
let results = defaultApplyEvents(input, events)

# Get final state
let finalState = results[^1]
echo finalState.messages[0].content.get()  # Output: Hello
echo finalState.state["counter"].getInt()  # Output: 42
```

### Handling Chunk Events

```nim
import ag_ui_nim

# Create chunk events
let events = @[
  newTextMessageChunkEvent("msg1", "assistant", "Hello"),
  newTextMessageChunkEvent("msg1", "assistant", ", world!"),
  newToolCallChunkEvent("tc1", "search", "msg1", """{"q": "n}"""),
  newToolCallChunkEvent("tc1", "search", "msg1", """im"}""")
]

# Transform chunks into standard events
let standardEvents = transformChunks(events)
```

### Using Observables

```nim
import ag_ui_nim

# Create an observable from a sequence
let source = fromSequence(@[1, 2, 3, 4, 5])

# Transform values using map and filter
let result = source
  .map(proc(x: int): int = x * 2)
  .filter(proc(x: int): bool = x > 5)

# Subscribe to the observable
proc onNext(value: int) =
  echo "Received: ", value

proc onComplete() =
  echo "Completed!"

let observer = Observer[int](
  next: onNext,
  complete: some(onComplete)
)

let subscription = result.subscribe(observer)
# Output:
# Received: 6
# Received: 8
# Received: 10
# Completed!
```

### Working with Protocol Buffers

```nim
import ag_ui_nim

# Encode an event to protobuf format
let event = newTextMessageStartEvent("msg1", "assistant")
let encoded = encodeEvent(event)

# Create a length-prefixed message
let length = encoded.len
var message: seq[byte] = @[
  byte((length shr 24) and 0xFF),
  byte((length shr 16) and 0xFF),
  byte((length shr 8) and 0xFF),
  byte(length and 0xFF)
]
message.add(encoded)

# Parse protobuf messages
var parser = newProtoParser()
let events = parseProtoChunk(message, parser)
```

### Legacy Format Conversion

```nim
import ag_ui_nim

# Convert a standard event to legacy format
let event = newTextMessageStartEvent("msg1", "assistant") 
let legacyEvent = convertToLegacyEvent(event, "thread1", "run1")

# Convert the legacy event back to standard format
let standardEvent = convertToStandardEvent(legacyEvent.get())

# Use with observables
let standardEvents = fromSequence(@[
  newTextMessageStartEvent("msg1", "assistant"),
  newTextMessageContentEvent("msg1", "Hello"),
  newTextMessageEndEvent("msg1")
])

let legacyEvents = convertToLegacyEvents(standardEvents, "thread1", "run1")
```

### Creating an HTTP Agent

```nim
import ag_ui_nim, asyncdispatch, httpclient, json

# Create an HTTP agent
let agent = newHttpAgent(
  url = "https://api.example.com/agents/myagent",
  headers = newHttpHeaders({"Authorization": "Bearer your-token"})
)

# Prepare parameters
let params = %*{
  "tools": [
    {
      "name": "search",
      "description": "Search the web",
      "parameters": {"type": "object"}
    }
  ],
  "context": [
    {"description": "user_id", "value": "12345"}
  ]
}

# Run the agent
let pipeline = waitFor agent.runAgent(params)

# Process events
for event in pipeline.events:
  echo "Event type: ", event.kind
```

## API Reference

### Core Types

- `FunctionCall`: Represents a function call with name and arguments
- `ToolCall`: Wraps a function call with ID and type
- `Role`: Enum for message roles (developer, system, assistant, user, tool)
- `Message`: Discriminated union for all message types
- `Context`: Key-value context information
- `Tool`: Tool definition with name, description, and parameters
- `RunAgentInput`: Input structure for agent execution

### Events

All 16 standard AG-UI events are supported:

- Text message events: `TextMessageStart`, `TextMessageContent`, `TextMessageEnd`
- Tool call events: `ToolCallStart`, `ToolCallArgs`, `ToolCallEnd`
- State events: `StateSnapshot`, `StateDelta`
- Run lifecycle: `RunStarted`, `RunFinished`, `RunError`
- Step events: `StepStarted`, `StepFinished`
- Special events: `MessagesSnapshot`, `Raw`, `Custom`

### Agents

- `AbstractAgent`: Base class for all agents
- `HttpAgent`: HTTP implementation with SSE support

## Building and Testing

```bash
# Build the project
nimble build

# Run all tests
nimble test

# Run specific test suites
nimble testTypes
nimble testEvents
nimble testEncoder

# Generate documentation
nimble docs
```

## Core Modules

- `types`: Core data types (Messages, Tools, Context, etc.)
- `events`: Event types for the AG-UI protocol
- `stream`: Stream utilities for event handling and state management
- `validation`: Schema validation for runtime type checking
- `encoder`: Event encoding for SSE and future protobuf support
- `client`: Agent implementations and utilities
  - `agent`: Abstract agent interface
  - `http_agent`: HTTP-based agent implementation
  - `verify`: Event verification and protocol compliance
  - `apply`: Event application and state transformation
  - `transform`: Event transformations (chunks, SSE parsing)
  - `run`: HTTP request pipeline and streaming

## Architecture

The AG-UI protocol uses:

- 16 standard event types for agent-backend communication
- Server-Sent Events (SSE) as the primary transport
- JSON encoding for messages and events
- Event-based streaming for real-time communication

## Compatibility

This SDK is compatible with the official TypeScript and Python SDKs for AG-UI in the https://github.com/ag-ui-protocol/ag-ui.git

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

See LICENSE file in the repository.

## Acknowledgments

This SDK implements the AG-UI protocol specification and is compatible with the reference implementations.
