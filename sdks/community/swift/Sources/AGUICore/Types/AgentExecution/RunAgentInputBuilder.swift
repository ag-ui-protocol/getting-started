// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Builder for constructing `RunAgentInput` instances with a fluent interface.
///
/// `RunAgentInputBuilder` provides an ergonomic way to construct complex `RunAgentInput`
/// instances through method chaining, making the code more readable and reducing
/// errors when working with multiple optional parameters.
///
/// ## Basic Usage
///
/// ```swift
/// let input = RunAgentInput.builder()
///     .threadId("thread-123")
///     .runId("run-456")
///     .build()
/// ```
///
/// ## Building Complex Inputs
///
/// ```swift
/// let input = RunAgentInput.builder()
///     .threadId("chat-session-1")
///     .runId("run-1")
///     .message(DeveloperMessage(id: "dev-1", content: "You are helpful"))
///     .message(UserMessage(id: "user-1", content: "Hello!"))
///     .tool(weatherTool)
///     .contextItem(Context(description: "location", value: "SF"))
///     .build()
/// ```
///
/// ## Incremental Building
///
/// ```swift
/// var builder = RunAgentInput.builder()
///     .threadId("thread-1")
///     .runId("run-1")
///
/// // Add messages conditionally
/// if includeSystemPrompt {
///     builder = builder.message(SystemMessage(id: "sys-1", content: "Be concise"))
/// }
///
/// let input = builder.build()
/// ```
///
/// ## Thread Safety
///
/// The builder uses value semantics (struct) and is naturally thread-safe. Each
/// builder method returns a new builder instance, making it safe to use across
/// isolation boundaries and in concurrent contexts.
///
/// ## Concurrency
///
/// The builder uses value semantics and is intended for use on a single task or actor.
/// It does not conform to `Sendable` in Swift 6 because it contains mutable stored properties.
/// Prefer building inputs on one actor/task and then pass the resulting `RunAgentInput` across boundaries.
///
/// - SeeAlso: `RunAgentInput`
public struct RunAgentInputBuilder {

    private var _threadId: String?
    private var _runId: String?
    private var _parentRunId: String?
    private var _state = Data("{}".utf8)
    private var _messages: [any Message] = []
    private var _tools: [Tool] = []
    private var _context: [Context] = []
    private var _forwardedProps = Data("{}".utf8)
    private var _resume: [ResumeEntry]?

    /// Creates a new builder instance.
    public init() {}

    // MARK: - Required Fields

    /// Sets the conversation thread identifier.
    ///
    /// - Parameter threadId: The thread identifier
    /// - Returns: A new builder instance with the thread ID set
    public func threadId(_ threadId: String) -> Self {
        var builder = self
        builder._threadId = threadId
        return builder
    }

    /// Sets the unique identifier for this run.
    ///
    /// - Parameter runId: The run identifier
    /// - Returns: A new builder instance with the run ID set
    public func runId(_ runId: String) -> Self {
        var builder = self
        builder._runId = runId
        return builder
    }

    // MARK: - Optional Fields

    /// Sets the parent run identifier for nested agent calls.
    ///
    /// - Parameter parentRunId: The parent run identifier
    /// - Returns: A new builder instance with the parent run ID set
    public func parentRunId(_ parentRunId: String) -> Self {
        var builder = self
        builder._parentRunId = parentRunId
        return builder
    }

    /// Sets the state data as JSON.
    ///
    /// - Parameter state: The state data
    /// - Returns: A new builder instance with the state set
    public func state(_ state: Data) -> Self {
        var builder = self
        builder._state = state
        return builder
    }

    /// Sets the forwarded properties as JSON.
    ///
    /// - Parameter forwardedProps: The forwarded properties data
    /// - Returns: A new builder instance with the forwarded properties set
    public func forwardedProps(_ forwardedProps: Data) -> Self {
        var builder = self
        builder._forwardedProps = forwardedProps
        return builder
    }

    // MARK: - Messages

    /// Adds a single message to the conversation history.
    ///
    /// Can be called multiple times to add messages incrementally.
    ///
    /// - Parameter message: The message to add
    /// - Returns: A new builder instance with the message added
    public func message(_ message: any Message) -> Self {
        var builder = self
        builder._messages.append(message)
        return builder
    }

    /// Sets the complete message array, replacing any previously added messages.
    ///
    /// - Parameter messages: The array of messages
    /// - Returns: A new builder instance with the messages set
    public func messages(_ messages: [any Message]) -> Self {
        var builder = self
        builder._messages = messages
        return builder
    }

    // MARK: - Tools

    /// Adds a single tool to the available tools.
    ///
    /// Can be called multiple times to add tools incrementally.
    ///
    /// - Parameter tool: The tool to add
    /// - Returns: A new builder instance with the tool added
    public func tool(_ tool: Tool) -> Self {
        var builder = self
        builder._tools.append(tool)
        return builder
    }

    /// Sets the complete tools array, replacing any previously added tools.
    ///
    /// - Parameter tools: The array of tools
    /// - Returns: A new builder instance with the tools set
    public func tools(_ tools: [Tool]) -> Self {
        var builder = self
        builder._tools = tools
        return builder
    }

    // MARK: - Context

    /// Adds a single context item to the contextual information.
    ///
    /// Can be called multiple times to add context items incrementally.
    ///
    /// - Parameter item: The context item to add
    /// - Returns: A new builder instance with the context item added
    public func contextItem(_ item: Context) -> Self {
        var builder = self
        builder._context.append(item)
        return builder
    }

    /// Sets the complete context array, replacing any previously added context items.
    ///
    /// - Parameter context: The array of context items
    /// - Returns: A new builder instance with the context set
    public func context(_ context: [Context]) -> Self {
        var builder = self
        builder._context = context
        return builder
    }

    // MARK: - Resume

    /// Sets the interrupt resume entries for continuing a human-in-the-loop flow.
    ///
    /// Call this when the previous run finished with `RunFinishedOutcome.interrupt`.
    /// Each `ResumeEntry` references one `Interrupt` by its `id` and carries the
    /// caller's resolution status and optional response payload.
    ///
    /// - Parameter entries: The resume entries to include
    /// - Returns: A new builder instance with resume entries set
    public func resume(_ entries: [ResumeEntry]) -> Self {
        var builder = self
        builder._resume = entries
        return builder
    }

    // MARK: - Build

    /// Builds and returns a `RunAgentInput` instance.
    ///
    /// - Returns: A configured `RunAgentInput` instance
    /// - Throws: `BuilderError` if required fields are missing
    ///
    /// Example:
    /// ```swift
    /// do {
    ///     let input = try RunAgentInput.builder()
    ///         .threadId("thread-1")
    ///         .runId("run-1")
    ///         .build()
    /// } catch {
    ///     print("Failed to build input: \(error)")
    /// }
    /// ```
    public func build() throws -> RunAgentInput {
        guard let threadId = _threadId else {
            throw BuilderError.missingThreadId
        }
        guard let runId = _runId else {
            throw BuilderError.missingRunId
        }

        return RunAgentInput(
            threadId: threadId,
            runId: runId,
            parentRunId: _parentRunId,
            state: _state,
            messages: _messages,
            tools: _tools,
            context: _context,
            forwardedProps: _forwardedProps,
            resume: _resume
        )
    }
}

// MARK: - Builder Error

/// Errors that can occur when building a `RunAgentInput`.
public enum BuilderError: Error {
    /// The thread ID is required but was not set.
    case missingThreadId

    /// The run ID is required but was not set.
    case missingRunId
}

extension BuilderError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .missingThreadId:
            return "Thread ID is required. Call .threadId(_:) before building."
        case .missingRunId:
            return "Run ID is required. Call .runId(_:) before building."
        }
    }
}

// MARK: - RunAgentInput Extension

extension RunAgentInput {
    /// Creates a new builder for constructing `RunAgentInput` instances.
    ///
    /// Provides a fluent interface for building complex inputs with method chaining.
    ///
    /// - Returns: A new `RunAgentInputBuilder` instance
    ///
    /// Example:
    /// ```swift
    /// let input = RunAgentInput.builder()
    ///     .threadId("thread-123")
    ///     .runId("run-456")
    ///     .message(UserMessage(id: "msg-1", content: "Hello"))
    ///     .build()
    /// ```
    public static func builder() -> RunAgentInputBuilder {
        RunAgentInputBuilder()
    }
}
