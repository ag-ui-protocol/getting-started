// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Intercepts tool call events from an event stream, executes the corresponding tools,
/// and sends results back to the agent via a response handler.
///
/// `ToolExecutionManager` acts as middleware in the event pipeline:
/// - All events from the upstream source are forwarded unchanged.
/// - Tool call events (`ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallEndEvent`) are
///   intercepted and used to drive tool execution.
/// - Tool execution happens concurrently with event forwarding.
/// - Execution lifecycle notifications are published via `executionEvents`.
///
/// ## Usage
///
/// ```swift
/// let manager = ToolExecutionManager(
///     toolRegistry: registry,
///     responseHandler: myHandler
/// )
///
/// let processedStream = manager.processEventStream(
///     rawStream,
///     threadId: "thread_123",
///     runId: "run_456"
/// )
///
/// for try await event in processedStream {
///     // Handle events as usual — tool calls are executed automatically
/// }
/// ```
///
/// - SeeAlso: ``ToolRegistry``, ``ToolResponseHandler``, ``ToolExecutionEvent``
public actor ToolExecutionManager {

    private let toolRegistry: any ToolRegistry
    private let responseHandler: any ToolResponseHandler
    /// Configuration template used to mint one `ToolErrorHandler` per tool name.
    private let errorHandlerConfig: ToolErrorConfig
    /// Per-tool error handlers, keyed by tool name.
    /// Each tool gets its own circuit breaker so one tool's failures don't block others.
    private var errorHandlers: [String: ToolErrorHandler] = [:]
    private var activeExecutions: [String: Task<Void, Never>] = [:]
    private var toolCallBuffer: [String: ToolCallBuilder] = [:]

    // Continuation for the execution events stream
    private var eventsContinuation: AsyncStream<ToolExecutionEvent>.Continuation?

    /// Stream of tool execution lifecycle events.
    ///
    /// Subscribe to this stream to receive notifications when tool calls are
    /// started, executing, completed, or failed.
    public let executionEvents: AsyncStream<ToolExecutionEvent>

    /// Creates a new `ToolExecutionManager`.
    ///
    /// - Parameters:
    ///   - toolRegistry: The registry used to look up and execute tools.
    ///   - responseHandler: The handler used to send tool results back to the agent.
    ///   - errorHandlerConfig: Configuration template used to create one `ToolErrorHandler`
    ///     per tool name, giving each tool an independent retry counter and circuit breaker.
    ///     Defaults to sensible values (3 retries, exponential jitter, circuit opens after
    ///     5 consecutive failures).
    public init(
        toolRegistry: any ToolRegistry,
        responseHandler: any ToolResponseHandler,
        errorHandlerConfig: ToolErrorConfig = ToolErrorConfig()
    ) {
        self.toolRegistry = toolRegistry
        self.responseHandler = responseHandler
        self.errorHandlerConfig = errorHandlerConfig
        var cont: AsyncStream<ToolExecutionEvent>.Continuation!
        self.executionEvents = AsyncStream { cont = $0 }
        self.eventsContinuation = cont
    }

    /// Returns the per-tool error handler for `toolName`, creating one on first access.
    private func errorHandler(for toolName: String) -> ToolErrorHandler {
        if let existing = errorHandlers[toolName] { return existing }
        let handler = ToolErrorHandler(config: errorHandlerConfig)
        errorHandlers[toolName] = handler
        return handler
    }

    deinit {
        eventsContinuation?.finish()
    }

    /// Wraps an event stream, executing any tool calls found within it.
    ///
    /// All events are passed through unchanged. Tool execution happens as a side
    /// effect of consuming the returned stream. The manager awaits any in-flight
    /// tool executions before the stream terminates.
    ///
    /// - Parameters:
    ///   - events: The upstream event sequence to process.
    ///   - threadId: The conversation thread ID to pass to tool executors and the response handler.
    ///   - runId: The run ID to pass to tool executors and the response handler.
    /// - Returns: An `AsyncThrowingStream` that forwards all upstream events unchanged.
    public func processEventStream<S: AsyncSequence>(
        _ events: S,
        threadId: String?,
        runId: String?
    ) -> AsyncThrowingStream<any AGUIEvent, Error> where S.Element == any AGUIEvent {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await event in events {
                        continuation.yield(event)
                        await self.handleEvent(event, threadId: threadId, runId: runId)
                    }
                    await self.awaitAllExecutions()
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Cancels all active tool execution tasks.
    public func cancelAllExecutions() {
        activeExecutions.values.forEach { $0.cancel() }
        activeExecutions.removeAll()
    }

    /// Returns the count of currently executing tool calls.
    public func activeExecutionCount() -> Int {
        activeExecutions.count
    }

    /// Returns true if a specific tool call is still executing.
    public func isExecuting(toolCallId: String) -> Bool {
        activeExecutions[toolCallId] != nil
    }

    // MARK: - Private helpers

    private func handleEvent(_ event: any AGUIEvent, threadId: String?, runId: String?) async {
        switch event {
        case let e as ToolCallStartEvent:
            toolCallBuffer[e.toolCallId] = ToolCallBuilder(id: e.toolCallId, name: e.toolCallName)
            eventsContinuation?.yield(.started(toolCallId: e.toolCallId, toolName: e.toolCallName))

        case let e as ToolCallArgsEvent:
            toolCallBuffer[e.toolCallId]?.appendArguments(e.delta)

        case let e as ToolCallEndEvent:
            guard let builder = toolCallBuffer.removeValue(forKey: e.toolCallId) else { return }
            let toolCall = builder.build()
            let execTask = Task {
                await self.executeToolCall(toolCall, threadId: threadId, runId: runId)
            }
            activeExecutions[e.toolCallId] = execTask

        case is RunFinishedEvent, is RunErrorEvent:
            // Tool execution tasks will be awaited in processEventStream after the loop
            break

        default:
            break
        }
    }

    private func executeToolCall(_ toolCall: ToolCall, threadId: String?, runId: String?) async {
        let toolCallId = toolCall.id
        let toolName = toolCall.function.name

        defer { activeExecutions.removeValue(forKey: toolCallId) }

        eventsContinuation?.yield(.executing(toolCallId: toolCallId, toolName: toolName))

        let handler = errorHandler(for: toolName)
        let context = ToolExecutionContext(toolCall: toolCall, threadId: threadId, runId: runId)
        var attempt = 0

        while true {
            do {
                let result = try await toolRegistry.execute(context: context)
                await handler.recordSuccess()

                let content: String
                if let data = result.result, let decoded = String(data: data, encoding: .utf8), !decoded.isEmpty {
                    content = decoded
                } else if let msg = result.message, !msg.isEmpty {
                    content = msg
                } else {
                    content = result.success ? "true" : "false"
                }

                let toolMessage = ToolMessage(
                    id: "msg_\(UUID().uuidString)",
                    content: content,
                    toolCallId: toolCallId
                )
                // Issue 26: surface delivery failures instead of silently discarding them.
                do {
                    try await responseHandler.sendToolResponse(toolMessage, threadId: threadId, runId: runId)
                    eventsContinuation?.yield(.succeeded(toolCallId: toolCallId, toolName: toolName, result: result))
                } catch {
                    eventsContinuation?.yield(.failed(
                        toolCallId: toolCallId,
                        toolName: toolName,
                        error: "Response delivery failed: \(error.localizedDescription)"
                    ))
                }
                return

            } catch {
                let decision = await handler.handleError(error: error, context: context, attempt: attempt)
                switch decision {
                case .retry(let delayNs):
                    if delayNs > 0 {
                        try? await Task.sleep(nanoseconds: delayNs)
                    }
                    attempt += 1

                case .fail(let message):
                    let errorMessage = ToolMessage(
                        id: "msg_\(UUID().uuidString)",
                        content: "Error: \(message)",
                        toolCallId: toolCallId
                    )
                    do {
                        try await responseHandler.sendToolResponse(errorMessage, threadId: threadId, runId: runId)
                        eventsContinuation?.yield(.failed(toolCallId: toolCallId, toolName: toolName, error: message))
                    } catch {
                        eventsContinuation?.yield(.failed(
                            toolCallId: toolCallId,
                            toolName: toolName,
                            error: "\(message); response delivery failed: \(error.localizedDescription)"
                        ))
                    }
                    return

                case .circuitOpen:
                    let circuitError = "Circuit breaker open"
                    let errorMessage = ToolMessage(
                        id: "msg_\(UUID().uuidString)",
                        content: "Error: Tool '\(toolName)' is temporarily unavailable",
                        toolCallId: toolCallId
                    )
                    do {
                        try await responseHandler.sendToolResponse(errorMessage, threadId: threadId, runId: runId)
                        eventsContinuation?.yield(.failed(toolCallId: toolCallId, toolName: toolName, error: circuitError))
                    } catch {
                        eventsContinuation?.yield(.failed(
                            toolCallId: toolCallId,
                            toolName: toolName,
                            error: "\(circuitError); response delivery failed: \(error.localizedDescription)"
                        ))
                    }
                    return
                }
            }
        }
    }

    private func awaitAllExecutions() async {
        let tasks = Array(activeExecutions.values)
        for task in tasks {
            await task.value
        }
    }
}

// MARK: - ToolCallBuilder

/// Builds a `ToolCall` from streaming events by accumulating argument deltas.
///
/// Value type: all mutation happens inside the `ToolExecutionManager` actor,
private struct ToolCallBuilder {
    let id: String
    let name: String
    private(set) var arguments: String = ""

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    mutating func appendArguments(_ delta: String) {
        arguments += delta
    }

    func build() -> ToolCall {
        ToolCall(id: id, function: FunctionCall(name: name, arguments: arguments))
    }
}
