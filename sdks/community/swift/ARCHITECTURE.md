# AGUISwift Architecture

AGUISwift follows a clean, modular architecture with strict Domain-Driven Design (DDD) layering principles:

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Application                           │
│              (iOS, macOS, tvOS, watchOS)                      │
├─────────────────────────────────────────────────────────────┤
│                  AGUIAgentSDK                                │
│  ┌─────────────┐  ┌───────────────────┐  ┌──────────────┐  │
│  │ AgUiAgent  │  │StatefulAgUiAgent  │  │   Builders   │  │
│  │            │  │                   │  │              │  │
│  └─────────────┘  └───────────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────────┤
│        AGUIClient              │      AGUITools              │
│  ┌────────────┐  ┌─────────────┐ │ ┌──────────────────────┐ │
│  │ HttpAgent  │  │AbstractAgent│ │ │    ToolRegistry      │ │
│  ├────────────┤  ├─────────────┤ │ ├──────────────────────┤ │
│  │EventStream │  │EventDecoder │ │ │   ToolExecutor      │ │
│  │ SseParser  │  │   Manager   │ │ │ToolExecutionManager │ │
│  └────────────┘  └─────────────┘ │ └──────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    AGUICore                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Infrastructure Layer                     │  │
│  │  ┌──────────────────┐  ┌─────────────────────────┐  │  │
│  │  │  Serialization   │  │      Adapters           │  │  │
│  │  │ ┌──────────────┐ │  │ ┌─────────────────────┐ │  │  │
│  │  │ │Serializable  │ │  │ │ValueObjectAdapter   │ │  │  │
│  │  │ │ThreadId      │ │  │ │                     │ │  │  │
│  │  │ │Serializable  │ │  │ │                     │ │  │  │
│  │  │ │RunId         │ │  │ │                     │ │  │  │
│  │  │ │Serializable  │ │  │ │                     │ │  │  │
│  │  │ │EventTimestamp│ │  │ │                     │ │  │  │
│  │  │ └──────────────┘ │  │ └─────────────────────┘ │  │  │
│  │  └──────────────────┘  └─────────────────────────┘  │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │              Protocol Layer                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │  │
│  │  │ AGUIEvent    │  │ EventType    │  │EventDecoder│  │  │
│  │  │             │  │              │  │           │  │  │
│  │  │RunStarted   │  │              │  │           │  │  │
│  │  │RunFinished  │  │              │  │           │  │  │
│  │  └──────────────┘  └──────────────┘  └───────────┘  │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │              Domain Layer                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │  │
│  │  │ ValueObjects │  │    Events     │  │  Errors   │  │  │
│  │  │             │  │              │  │           │  │  │
│  │  │ ThreadId    │  │ RunStarted   │  │DomainError │  │  │
│  │  │ RunId       │  │ RunFinished  │  │           │  │  │
│  │  │EventTimestamp│ │              │  │           │  │  │
│  │  └──────────────┘  └──────────────┘  └───────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Module Overview

### AGUICore
Protocol types, events, and message definitions with strict DDD layering.

**Domain Layer** (Pure domain logic, no infrastructure dependencies):
- **ValueObjects**: `ThreadId`, `RunId`, `EventTimestamp` - Type-safe domain value objects
- **Events**: Domain event definitions (to be implemented)
- **Errors**: `DomainError` - Domain validation errors

**Protocol Layer** (Protocol-specific types):
- **AGUIEvent**: Base protocol for all AG-UI protocol events
- **EventType**: Enumeration of all AG-UI protocol event types
- **EventDecoder**: Polymorphic event decoder helper
- **Concrete Events**: `RunStartedEvent`, `RunFinishedEvent` (and more to come)

**Infrastructure Layer** (Serialization and adapters):
- **Serialization**: `SerializableThreadId`, `SerializableRunId`, `SerializableEventTimestamp` - Infrastructure wrappers for JSON serialization
- **Adapters**: `ValueObjectAdapter` - Converts between domain and infrastructure layers

### AGUIAgentSDK
High-level APIs for common agent interaction patterns.
- **AgUiAgent**: Stateless client for cases where no ongoing context is needed
- **StatefulAgUiAgent**: Stateful client that maintains conversation history
- **Builders**: Convenient builder patterns for agent configuration

### AGUIClient
Low-level client infrastructure and transport implementations.
- **HttpAgent**: Low-level HTTP transport implementation
- **AbstractAgent**: Base class for custom agent implementations
- **SseParser**: Server-Sent Events parser for streaming responses
- **EventStreamManager**: Event stream management and processing

### AGUITools
Tool execution framework for extending agent capabilities.
- **ToolExecutor**: Protocol for implementing custom tools
- **ToolRegistry**: Tool registration and management
- **ToolExecutionManager**: Tool execution with circuit breaker patterns

## Design Principles

### Domain-Driven Design (DDD)
- **Domain Layer**: Pure business logic with no infrastructure dependencies
- **Infrastructure Layer**: Handles serialization, networking, and external concerns
- **Clear Boundaries**: Strict separation between domain and infrastructure
- **Value Objects**: Type-safe domain concepts (ThreadId, RunId, EventTimestamp)

### Layered Architecture
- **Application Layer**: High-level APIs (AGUIAgentSDK)
- **Client Layer**: Low-level transport and infrastructure (AGUIClient)
- **Domain Layer**: Core business logic and domain models (AGUICore)
- **Infrastructure Layer**: Technical implementation details (AGUICore)

### Modularity
- **AGUICore**: Foundation layer with protocol definitions
- **AGUIClient**: Low-level client infrastructure and transport
- **AGUIAgentSDK**: High-level agent APIs and builders
- **AGUITools**: Tool execution framework
- Each module can be used independently or together

## Current Implementation Status

### ✅ Completed
- Domain value objects (ThreadId, RunId, EventTimestamp)
- Infrastructure serialization wrappers
- Domain/Infrastructure adapters
- AGUIEvent protocol and EventType enum
- RunStartedEvent and RunFinishedEvent implementations
- Comprehensive unit tests for events
- DDD layering structure

### 🚧 In Progress
- Additional event types (TextMessage, ToolCall, StateManagement events)
- Client agent implementations
- Tool execution framework

### 📋 Planned
- HTTP transport layer
- SSE (Server-Sent Events) parser
- State management
- Authentication support
- Error handling and recovery

