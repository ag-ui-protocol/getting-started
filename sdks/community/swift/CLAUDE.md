# AGUISwift

## Project Context

The AG-UI Swift SDK is an open-source Swift framework for building AI agent user interfaces that implement the Agent User Interaction Protocol (AG-UI). It provides real-time streaming communication between Swift applications and AI agents.

### Architecture
```
AGUICore (Foundation layer - Protocol types • Event models • Message definitions)
    ↓
AGUIClient (Low-level client infrastructure and transport implementations - HttpAgent • AbstractAgent • SseParser • EventStreamManager )
    ↓
    ├─→ AGUITools (Tool execution framework for extending agent capabilities - ToolExecutor • ToolRegistry  • ToolExecutionManager)
    └─→ AGUIAgentSDK (High-level APIs for common agent interaction patterns - AgUiAgent  • StatefulAgUiAgent  • Builders)
         ↓
      Application

```

### Key Directories
- `Sources/AGUIAgentSDK/` - High-level APIs for common agent interaction patterns.
- `Sources/AGUIClient/` - Low-level client infrastructure and transport implementations.
- `Sources/AGUICore/` - Core framework source, Protocol types, events, and message definitions.
- `Sources/AGUITools/` - Tool execution framework for extending agent capabilities.
- `Tests/` - Test suites with mock protocols

## Development Standards

### Swift 6.2 Requirements
- **Minimum**: iOS 15+, macOS 13+, Swift 5.9
- **Concurrency**: Use `async/await`, actors, and `@MainActor` isolation by default
- **Data Safety**: All public types must be `Sendable`; use `@concurrent` for explicit parallel execution
- **Value Types**: Prefer `struct` over `class`; use actors for shared mutable state

### API Design Principles
- Protocol-first: Define behavior contracts before implementations
- Composition over inheritance: Use protocol composition (`Runnable & Observable`)
- Fluent interfaces: Enable chaining with `@discardableResult` where appropriate
- Progressive disclosure: Simple defaults, advanced configuration via builders

### Naming Conventions
- Types/Protocols: `UpperCamelCase` (e.g., `AgentProtocol`, `MemoryStore`)
- Methods: Verb phrases for mutations (`execute`, `store`), noun phrases for accessors (`configuration`)
- Boolean properties: Use `is`, `has`, `should` prefixes
- Generics: Descriptive names (`Element`, `Input`, `Output`) over single letters when unclear

## Workflow

### Verification Commands
```bash
swift build                           # Build framework
swift test                            # Run test suite
swift test --filter AgentTests        # Run specific tests
swift package plugin --allow-writing-to-package-directory swiftformat  # Format code
```

### Before Committing
1. Run `swift build` - ensure no compilation errors
2. Run `swift test` - all tests must pass
3. Run SwiftFormat - code must be formatted (`swift package plugin --allow-writing-to-package-directory swiftformat`)
4. Run SwiftLint - code must pass linting checks (`swiftlint lint` - install via Homebrew if needed)
5. Verify `Sendable` conformance on public types
6. Ensure documentation comments on public APIs

### Branch Naming
- `feature/agent-memory-system`
- `fix/orchestration-race-condition`
- `refactor/protocol-conformance`

## Technical Guidelines

### Protocols
- Use `associatedtype` for type-safe generic protocols
- Provide protocol extensions with sensible defaults
- Mark class-only protocols with `AnyObject` constraint
- See `Sources/SwiftAgents/Core/Protocols/` for patterns

### Concurrency
- Use structured concurrency (`TaskGroup`, `async let`) over unstructured
- Annotate with `@MainActor` for UI-bound code
- Use `actor` for shared state requiring synchronization
- Apply `nonisolated` explicitly when needed for cross-isolation calls

### Memory Systems
- `ConversationMemory`: Short-term, token-limited context
- `VectorMemory`: Long-term semantic retrieval (requires embedding provider)
- `SummaryMemory`: Compressed conversation history

### Logging
- Use `swift-log` for cross-platform compatibility (Apple platforms + Linux servers)
- Call `Log.bootstrap()` once at application startup to configure logging
- Never use `print()` statements in production code
- Use category-specific loggers:
  - `Log.agents`: Agent lifecycle and execution
  - `Log.memory`: Memory system operations
  - `Log.tracing`: Observability and tracing events
  - `Log.metrics`: Performance and usage metrics
  - `Log.orchestration`: Multi-agent coordination
- Choose appropriate log levels: `.trace`, `.debug`, `.info`, `.notice`, `.warning`, `.error`, `.critical`
- **Privacy Note**: Unlike `os.Logger`, swift-log does not support `privacy:` parameter annotations
  - Do not log sensitive user data, credentials, or PII in production
  - Configure log handlers to redact sensitive information at runtime
  - Default behavior logs all interpolated values as-is
- Example: `Log.memory.error("Failed to save: \(error.localizedDescription)")`
- For Apple-only code, `OSLogTracer` is available with privacy annotations wrapped in `#if canImport(os)`

### Testing Strategy (TDD Required)
- **Test-Driven Development is mandatory** for all new features and bug fixes
- All protocols have corresponding `Mock*` implementations in test targets
- Test async code with `XCTestExpectation` or async test methods

### TDD Workflow
Follow Red-Green-Refactor cycle for all development:

1. **Red**: Write failing tests first
   - Define expected behavior through test cases
   - Use `test-specialist` agent to design comprehensive test coverage
   - Tests must fail initially (verifies test is meaningful)

2. **Green**: Write minimal implementation
   - Only write enough code to make tests pass
   - No premature optimization or extra features
   - Focus on satisfying test assertions

3. **Refactor**: Improve code quality
   - Clean up implementation while keeping tests green
   - Apply Swift patterns and conventions
   - Use `code-reviewer` agent to verify refactoring

**TDD Guidelines**:
- Never write implementation before tests
- One test case per behavior/feature
- Test edge cases and error conditions
- Mock external dependencies (LLM providers, network)
- Run `swift test` frequently during development


## Sub-Agents

Use specialized agents for focused expertise. Delegate proactively:

| Agent | When to Use |
|-------|-------------|
| `context-builder` | **Long-running tasks**, gathering requirements, researching before implementation |
| `api-designer` | Designing public APIs, naming decisions, fluent interfaces |
| `protocol-architect` | Type hierarchies, protocol composition, POP patterns |
| `concurrency-expert` | Async code, actors, Sendable conformance, data-race safety |
| `macro-engineer` | Implementing or modifying Swift macros |
| `code-reviewer` | After code changes, before commits |
| `test-specialist` | Writing tests, creating mocks, test coverage |
| `framework-architect` | Multi-agent orchestration patterns, coordination design |

### Context Management (Long-Running Tasks)
**Always use `context-builder` agent** at the start of complex or long-running tasks to:
- Gather comprehensive requirements before implementation
- Research existing codebase patterns and conventions
- Identify dependencies and integration points
- Create a clear roadmap before delegating to specialist agents

**Context Preservation Workflow**:
1. **Start**: Use `context-builder` to research and gather context
2. **Plan**: Document findings and create implementation plan
3. **Execute**: Delegate to specialist agents with clear context handoffs
4. **Checkpoint**: Re-invoke `context-builder` for multi-phase tasks
5. **Update**: Keep plan documents and memory updated throughout

**When to use `context-builder`**:
- Tasks spanning multiple files or components
- Features requiring understanding of existing architecture
- Bug fixes requiring root cause investigation
- Any task expected to take more than a few interactions

### Delegation Guidelines
- **Before implementing**: Use `context-builder` to research, then `api-designer` and `protocol-architect`
- **During implementation**: Use `concurrency-expert` for async code, `macro-engineer` for macros
- **After changes**: Always run `code-reviewer` before committing
- **For tests**: Delegate to `test-specialist` for mock patterns and coverage (TDD: tests first!)

**TDD + Sub-Agent Workflow** (for complex features):
1. `context-builder` → research existing patterns and requirements
2. `test-specialist` → write failing tests first (Red phase) and keep async/time-sensitive tests deterministic (no flakiness)
3. `protocol-architect` → design abstractions to satisfy tests
4. `api-designer` → refine public interface
5. `concurrency-expert` → verify thread safety
6. `code-reviewer` → final review (ensure tests pass)

## Quick References
- API patterns: See `https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/kotlin`
- Protocol design: See `https://github.com/ag-ui-protocol/ag-ui`
- Understanding how AG-UI complements and works with MCP and A2A: See `https://docs.ag-ui.com/llms-full.txt`

## Git Commit Guidelines

When creating commits:
- Follow conventional commit format
- Keep the first line under 50 characters
- Do not include AI attribution in commit messages
