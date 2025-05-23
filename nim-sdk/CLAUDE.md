# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

### Building
- `nimble build` - Compiles the project to `build/ag_ui_nim`
- `nimble clean` - Removes build artifacts

### Testing
- `nimble test` - Runs all active test suites
- Individual test commands:
  - `nimble testTypes` - Core type system tests
  - `nimble testEvents` - Event handling tests
  - `nimble testEncoder` - Encoder tests
  - `nimble testAgent` - Agent implementation tests
  - `nimble testHttpAgent` - HTTP agent tests
  - `nimble testComplexValidation` - Complex validation scenarios
  - `nimble testStream` - Stream processing tests
  - `nimble testVerify` - Event verification tests
  - `nimble testProto` - Protocol Buffer tests

### Other Commands
- `nimble docs` - Generates HTML documentation
- `nimble coverage` - Generates code coverage reports
- `nimble lint` - Runs style checks

## Architecture Overview

This is an AG-UI (Agent-UI) SDK implementation in Nim that follows an event-driven architecture with Observable/reactive patterns.

### Module Structure

1. **Core Module** (`src/ag_ui_nim/core/`)
   - `types.nim`: Core data structures (Message, Thread, State, Tool definitions)
   - `events.nim`: Event system with 16 standard AG-UI event types
   - `stream.nim`: Event stream utilities and operators
   - `observable.nim`: RxJS-inspired Observable implementation for async event streams
   - `validation.nim`: Runtime type validation for JSON data

2. **Client Module** (`src/ag_ui_nim/client/`)
   - `agent.nim`: Abstract agent base class that all agents must inherit from
   - `http_agent.nim`: HTTP-based agent implementation
   - `verify.nim`: Event verification logic
   - `apply.nim`: Event application to agent state
   - `transform/`: SSE and chunk event transformations
   - `run/`: HTTP request handling for agent execution

3. **Encoder Module** (`src/ag_ui_nim/encoder/`)
   - `encoder.nim`: Base encoder abstraction
   - `media_type.nim`: Content type handling
   - `proto.nim`: Protocol Buffer encoding support

### Key Patterns

- **Event Pipeline**: All agent interactions are modeled as events flowing through a pipeline
- **Abstract Agent**: Agents extend `AbstractAgent` and implement the `run` method returning an event stream
- **State Management**: Agents maintain conversation state with messages and thread context
- **Dual Encoding**: Supports both JSON/SSE and Protocol Buffer formats
- **Async-First**: All I/O operations use Nim's `Future[T]` and async/await

### Development Notes

- When adding new event types, update both `events.nim` and corresponding validation logic
- Test files mirror source structure - add tests for any new functionality
- Use `Option[T]` for nullable fields in type definitions
- Event streams should handle errors gracefully and propagate them as error events
- HTTP agents should respect content negotiation headers for format selection