// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
import AGUICore
@testable import AGUITools

// MARK: - Mock types

/// Always throws on sendToolResponse — used to test Issue 26 delivery-failure path.
private actor FailingResponseHandler: ToolResponseHandler {
    struct DeliveryError: Error {}
    func sendToolResponse(_ message: ToolMessage, threadId: String?, runId: String?) async throws {
        throw DeliveryError()
    }
}

/// Records execute calls and returns a configurable result or error.
private actor CapturingToolExecutor: ToolExecutor {
    let tool: Tool
    private(set) var executionCount = 0
    var resultToReturn: ToolExecutionResult?
    var errorToThrow: Error?

    init(name: String) {
        tool = Tool(name: name, description: "Test tool", parameters: Data("{}".utf8))
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        executionCount += 1
        if let error = errorToThrow { throw error }
        return resultToReturn ?? .success()
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult { .valid }
    nonisolated func maximumExecutionTime() -> Duration? { nil }

    func setResult(_ result: ToolExecutionResult) { resultToReturn = result }
    func setError(_ error: Error?) { errorToThrow = error }
}

/// Captures every tool response message sent by the manager.
private actor CapturingResponseHandler: ToolResponseHandler {
    private(set) var sentMessages: [ToolMessage] = []
    private(set) var sentThreadIds: [String?] = []
    private(set) var sentRunIds: [String?] = []

    func sendToolResponse(_ message: ToolMessage, threadId: String?, runId: String?) async throws {
        sentMessages.append(message)
        sentThreadIds.append(threadId)
        sentRunIds.append(runId)
    }
}

// MARK: - ToolExecutionManagerTests

final class ToolExecutionManagerTests: XCTestCase {

    // MARK: - Helpers

    /// Builds a manager with 0 max-retry attempts so tests never wait on back-off delays.
    private func makeManager(
        registry: any ToolRegistry = DefaultToolRegistry(),
        responseHandler: any ToolResponseHandler = NullToolResponseHandler()
    ) -> ToolExecutionManager {
        ToolExecutionManager(
            toolRegistry: registry,
            responseHandler: responseHandler,
            errorHandlerConfig: ToolErrorConfig(maxRetryAttempts: 0)
        )
    }

    private func makeStream(_ events: [any AGUIEvent]) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }

    /// Produces the canonical three-event sequence for a single tool call.
    private func toolCallEvents(id: String, name: String, args: String = "{}") -> [any AGUIEvent] {
        [
            ToolCallStartEvent(toolCallId: id, toolCallName: name),
            ToolCallArgsEvent(toolCallId: id, delta: args),
            ToolCallEndEvent(toolCallId: id),
        ]
    }

    @discardableResult
    private func drain(
        _ stream: AsyncThrowingStream<any AGUIEvent, Error>
    ) async throws -> [any AGUIEvent] {
        var collected: [any AGUIEvent] = []
        for try await event in stream { collected.append(event) }
        return collected
    }

    // MARK: - Feature: Initialization

    func test_init_activeExecutionCount_isZero() async {
        // Given / When
        let manager = makeManager()

        // Then
        let count = await manager.activeExecutionCount()
        XCTAssertEqual(count, 0)
    }

    func test_init_isExecuting_unknownId_returnsFalse() async {
        // Given / When
        let manager = makeManager()

        // Then
        let result = await manager.isExecuting(toolCallId: "anything")
        XCTAssertFalse(result)
    }

    // MARK: - Feature: Event passthrough

    func test_processEventStream_nonToolCallEvents_areForwardedUnchanged() async throws {
        // Given
        let manager = makeManager()
        let input: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ]

        // When
        let events = try await drain(
            await manager.processEventStream(makeStream(input), threadId: nil, runId: nil)
        )

        // Then
        XCTAssertEqual(events.count, 2)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is RunFinishedEvent)
    }

    func test_processEventStream_toolCallEvents_areForwardedToConsumer() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "echo")
        try await registry.register(executor: executor)
        let manager = makeManager(registry: registry)

        // When
        let events = try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "echo")),
                threadId: nil, runId: nil
            )
        )

        // Then: all 3 events forwarded in order
        XCTAssertEqual(events.count, 3)
        XCTAssertTrue(events[0] is ToolCallStartEvent)
        XCTAssertTrue(events[1] is ToolCallArgsEvent)
        XCTAssertTrue(events[2] is ToolCallEndEvent)
    }

    func test_processEventStream_mixedEvents_allForwardedInOrder() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        try await registry.register(executor: executor)
        let manager = makeManager(registry: registry)

        let input: [any AGUIEvent] = [RunStartedEvent(threadId: "t", runId: "r")]
            + toolCallEvents(id: "c1", name: "tool")
            + [RunFinishedEvent(threadId: "t", runId: "r")]

        // When
        let events = try await drain(
            await manager.processEventStream(makeStream(input), threadId: nil, runId: nil)
        )

        // Then
        XCTAssertEqual(events.count, 5)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[4] is RunFinishedEvent)
    }

    func test_processEventStream_emptyStream_completesNormally() async throws {
        // Given
        let manager = makeManager()

        // When / Then: no throw, empty result
        let events = try await drain(
            await manager.processEventStream(makeStream([]), threadId: nil, runId: nil)
        )
        XCTAssertTrue(events.isEmpty)
    }

    // MARK: - Feature: Tool execution

    func test_processEventStream_toolCall_executesRegisteredToolOnce() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "calc")
        try await registry.register(executor: executor)
        let manager = makeManager(registry: registry)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "calc")),
                threadId: nil, runId: nil
            )
        )

        // Then
        let count = await executor.executionCount
        XCTAssertEqual(count, 1)
    }

    func test_processEventStream_multipleToolCalls_eachToolExecutedOnce() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let execA = CapturingToolExecutor(name: "tool_a")
        let execB = CapturingToolExecutor(name: "tool_b")
        try await registry.register(executor: execA)
        try await registry.register(executor: execB)
        let manager = makeManager(registry: registry)

        let events: [any AGUIEvent] = toolCallEvents(id: "c1", name: "tool_a")
            + toolCallEvents(id: "c2", name: "tool_b")

        // When
        try await drain(
            await manager.processEventStream(makeStream(events), threadId: nil, runId: nil)
        )

        // Then: each executor called exactly once
        let countA = await execA.executionCount
        let countB = await execB.executionCount
        XCTAssertEqual(countA, 1)
        XCTAssertEqual(countB, 1)
    }

    func test_processEventStream_argDeltas_areConcatenatedBeforeExecution() async throws {
        // Given: executor that captures the raw arguments string
        actor ArgCapturingExecutor: ToolExecutor {
            let tool = Tool(name: "args_tool", description: "", parameters: Data("{}".utf8))
            private(set) var capturedArguments = ""

            func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
                capturedArguments = context.toolCall.function.arguments
                return .success()
            }

            nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult { .valid }
            nonisolated func maximumExecutionTime() -> Duration? { nil }
        }

        let registry = DefaultToolRegistry()
        let executor = ArgCapturingExecutor()
        try await registry.register(executor: executor)
        let manager = makeManager(registry: registry)

        let events: [any AGUIEvent] = [
            ToolCallStartEvent(toolCallId: "c1", toolCallName: "args_tool"),
            ToolCallArgsEvent(toolCallId: "c1", delta: "{\"key\":"),
            ToolCallArgsEvent(toolCallId: "c1", delta: "\"value\"}"),
            ToolCallEndEvent(toolCallId: "c1"),
        ]

        // When
        try await drain(
            await manager.processEventStream(makeStream(events), threadId: nil, runId: nil)
        )

        // Then: two deltas are concatenated into the full argument string
        let args = await executor.capturedArguments
        XCTAssertEqual(args, "{\"key\":\"value\"}")
    }

    // MARK: - Feature: Response handler

    func test_processEventStream_successResult_withJsonData_sendsDataAsContent() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "weather")
        await executor.setResult(.success(result: Data("{\"temp\":72}".utf8)))
        try await registry.register(executor: executor)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "weather")),
                threadId: nil, runId: nil
            )
        )

        // Then: JSON bytes are decoded to a string and sent as the message content
        let messages = await handler.sentMessages
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].toolCallId, "c1")
        XCTAssertEqual(messages[0].content, "{\"temp\":72}")
    }

    func test_processEventStream_successResult_withMessageOnly_usesMessage() async throws {
        // Given: result has a message but no raw data
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        await executor.setResult(.success(message: "done"))
        try await registry.register(executor: executor)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        // Then
        let content = await handler.sentMessages.first?.content
        XCTAssertEqual(content, "done")
    }

    func test_processEventStream_successResult_withNeitherDataNorMessage_sendsTrueFallback() async throws {
        // Given: result has neither data nor message
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        await executor.setResult(.success())
        try await registry.register(executor: executor)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        // Then: falls back to "true" (success flag as string)
        let content = await handler.sentMessages.first?.content
        XCTAssertEqual(content, "true")
    }

    func test_processEventStream_passesThreadIdAndRunIdToResponseHandler() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        try await registry.register(executor: executor)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: "my-thread", runId: "my-run"
            )
        )

        // Then
        let threadIds = await handler.sentThreadIds
        let runIds = await handler.sentRunIds
        XCTAssertEqual(threadIds.first, Optional("my-thread"))
        XCTAssertEqual(runIds.first, Optional("my-run"))
    }

    func test_processEventStream_multipleToolCalls_responsesRoutedByToolCallId() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let execA = CapturingToolExecutor(name: "tool_a")
        await execA.setResult(.success(message: "result-a"))
        let execB = CapturingToolExecutor(name: "tool_b")
        await execB.setResult(.success(message: "result-b"))
        try await registry.register(executor: execA)
        try await registry.register(executor: execB)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        let events: [any AGUIEvent] = toolCallEvents(id: "c1", name: "tool_a")
            + toolCallEvents(id: "c2", name: "tool_b")

        // When
        try await drain(
            await manager.processEventStream(makeStream(events), threadId: nil, runId: nil)
        )

        // Then: one response per tool call, each linked by toolCallId
        let messages = await handler.sentMessages
        XCTAssertEqual(messages.count, 2)
        let ids = Set(messages.map(\.toolCallId))
        XCTAssertTrue(ids.contains("c1"))
        XCTAssertTrue(ids.contains("c2"))
    }

    // MARK: - Feature: Failure path

    func test_processEventStream_toolNotFound_sendsErrorResponse() async throws {
        // Given: no tools registered
        let registry = DefaultToolRegistry()
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "missing")),
                threadId: nil, runId: nil
            )
        )

        // Then: one error response sent for the missing tool
        let messages = await handler.sentMessages
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].toolCallId, "c1")
        XCTAssertTrue(
            messages[0].content.hasPrefix("Error:"),
            "Expected error message, got: \(messages[0].content)"
        )
    }

    func test_processEventStream_toolNotFound_streamCompletesNormally() async throws {
        // Given: no tools registered
        let registry = DefaultToolRegistry()
        let manager = makeManager(registry: registry)

        // When / Then: missing tool is an execution error, not a stream error
        let events = try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "missing")),
                threadId: nil, runId: nil
            )
        )
        XCTAssertEqual(events.count, 3) // all upstream events still forwarded
    }

    func test_processEventStream_nonRetryableExecutionError_sendsErrorResponse() async throws {
        // Given: executor throws a validation error (not retryable)
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "broken")
        await executor.setError(ToolExecutionError.validationFailed(message: "bad args"))
        try await registry.register(executor: executor)
        let handler = CapturingResponseHandler()
        let manager = makeManager(registry: registry, responseHandler: handler)

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "broken")),
                threadId: nil, runId: nil
            )
        )

        // Then
        let messages = await handler.sentMessages
        XCTAssertEqual(messages.count, 1)
        XCTAssertTrue(
            messages[0].content.hasPrefix("Error:"),
            "Expected error message, got: \(messages[0].content)"
        )
    }

    // MARK: - Feature: Execution events stream

    /// A single successful tool call should emit .started → .executing → .succeeded in order.
    func test_executionEvents_successfulTool_emitsStartedExecutingSucceeded() async throws {
        // Given
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        try await registry.register(executor: executor)
        let manager = makeManager(registry: registry)

        // Collect exactly 3 execution events in a background task
        let execEventsStream = await manager.executionEvents
        let eventsTask = Task<[ToolExecutionEvent], Never> {
            var collected: [ToolExecutionEvent] = []
            for await event in execEventsStream {
                collected.append(event)
                if collected.count == 3 { break }
            }
            return collected
        }

        // When: drain the process stream (awaits all executions internally)
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        // Then: background task collects all 3 events from the buffered stream
        let received = await eventsTask.value
        XCTAssertEqual(received.count, 3)

        if case .started(let id, _) = received[0] {
            XCTAssertEqual(id, "c1")
        } else {
            XCTFail("Expected .started at index 0, got \(received[0])")
        }

        if case .executing(let id, _) = received[1] {
            XCTAssertEqual(id, "c1")
        } else {
            XCTFail("Expected .executing at index 1, got \(received[1])")
        }

        if case .succeeded(let id, _, _) = received[2] {
            XCTAssertEqual(id, "c1")
        } else {
            XCTFail("Expected .succeeded at index 2, got \(received[2])")
        }
    }

    /// A failed tool call (tool not found = immediate fail) emits .started → .executing → .failed.
    func test_executionEvents_failedTool_emitsStartedExecutingFailed() async throws {
        // Given: no tools registered → ToolRegistryError.toolNotFound → immediate fail (not retryable)
        let registry = DefaultToolRegistry()
        let manager = makeManager(registry: registry)

        let execEventsStream = await manager.executionEvents
        let eventsTask = Task<[ToolExecutionEvent], Never> {
            var collected: [ToolExecutionEvent] = []
            for await event in execEventsStream {
                collected.append(event)
                if collected.count == 3 { break }
            }
            return collected
        }

        // When
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "missing")),
                threadId: nil, runId: nil
            )
        )

        // Then
        let received = await eventsTask.value
        XCTAssertEqual(received.count, 3)

        if case .started = received[0] {} else {
            XCTFail("Expected .started at index 0, got \(received[0])")
        }
        if case .executing = received[1] {} else {
            XCTFail("Expected .executing at index 1, got \(received[1])")
        }
        if case .failed(let id, _, _) = received[2] {
            XCTAssertEqual(id, "c1")
        } else {
            XCTFail("Expected .failed at index 2, got \(received[2])")
        }
    }

    // MARK: - Feature: cancelAllExecutions

    func test_cancelAllExecutions_onEmptyState_doesNotCrash() async {
        // Given
        let manager = makeManager()

        // When / Then: no crash, count remains zero
        await manager.cancelAllExecutions()
        let count = await manager.activeExecutionCount()
        XCTAssertEqual(count, 0)
    }

    // MARK: - Feature: Error propagation from upstream

    func test_processEventStream_upstreamThrows_propagatesError() async {
        // Given
        let manager = makeManager()

        struct UpstreamError: Error {}

        let throwingStream = AsyncThrowingStream<any AGUIEvent, Error> { continuation in
            continuation.finish(throwing: UpstreamError())
        }

        // When / Then
        do {
            try await drain(await manager.processEventStream(throwingStream, threadId: nil, runId: nil))
            XCTFail("Expected error to be thrown")
        } catch {
            XCTAssertTrue(error is UpstreamError, "Expected UpstreamError, got \(type(of: error))")
        }
    }

    // MARK: - Feature: Edge cases

    /// A ToolCallEndEvent with no matching buffer entry should be silently ignored
    /// but the event itself still passes through to consumers.
    func test_processEventStream_toolCallEndWithoutMatchingStart_isDroppedGracefully() async throws {
        // Given: orphan ToolCallEnd with no prior ToolCallStart
        let manager = makeManager()
        let events: [any AGUIEvent] = [ToolCallEndEvent(toolCallId: "orphan")]

        // When
        let result = try await drain(
            await manager.processEventStream(makeStream(events), threadId: nil, runId: nil)
        )

        // Then: event forwarded, no execution launched, no crash
        XCTAssertEqual(result.count, 1)
        XCTAssertTrue(result[0] is ToolCallEndEvent)
    }

    // MARK: - Feature: Delivery-failure propagation (Issue 26)

    /// On the `.fail` path (tool execution failed, non-retryable), when `sendToolResponse`
    /// also throws, the `.failed` event error string must include a delivery-failure note —
    /// not just the original tool error. This distinguishes "agent was notified" from
    /// "agent was NOT notified and may stall".
    func test_failPath_responseDeliveryFailure_errorReflectsDeliveryFailure() async throws {
        // Given: tool throws a non-retryable error AND delivery always fails
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "broken")
        await executor.setError(ToolExecutionError.validationFailed(message: "bad args"))
        try await registry.register(executor: executor)
        let manager = ToolExecutionManager(
            toolRegistry: registry,
            responseHandler: FailingResponseHandler(),
            errorHandlerConfig: ToolErrorConfig(maxRetryAttempts: 0)
        )

        let execEventsStream = await manager.executionEvents
        let eventsTask = Task<[ToolExecutionEvent], Never> {
            var collected: [ToolExecutionEvent] = []
            for await event in execEventsStream {
                collected.append(event)
                if collected.count == 3 { break }
            }
            return collected
        }

        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "broken")),
                threadId: nil, runId: nil
            )
        )

        let received = await eventsTask.value
        XCTAssertEqual(received.count, 3)

        // The .failed error must mention delivery failure — not just the original tool error.
        // Before fix: error = "bad args" only (delivery failure silently dropped via try?).
        // After fix:  error = "bad args; response delivery failed: ..."
        if case .failed(_, _, let errorStr) = received[2] {
            XCTAssertTrue(
                errorStr.contains("response delivery failed"),
                "Expected delivery failure in .failed error, got: '\(errorStr)'"
            )
        } else {
            XCTFail("Expected .failed at index 2, got \(received[2])")
        }
    }

    /// On the `.circuitOpen` path, when `sendToolResponse` also throws, the `.failed`
    /// event error string must include a delivery-failure note — not just "Circuit breaker open".
    func test_circuitOpenPath_responseDeliveryFailure_errorReflectsDeliveryFailure() async throws {
        // Given: tool fails enough to open circuit AND delivery always fails
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        await executor.setError(NSError(domain: "TestError", code: 1, userInfo: nil))
        try await registry.register(executor: executor)

        // Circuit opens after 1 failure; no recovery window
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 1, recoveryTimeoutSeconds: 3600)
        )
        let manager = ToolExecutionManager(
            toolRegistry: registry,
            responseHandler: FailingResponseHandler(),
            errorHandlerConfig: config
        )

        // Collect all 6 events (3 per run) in a single background pass over the shared stream
        let execEventsStream = await manager.executionEvents
        let eventsTask = Task<[ToolExecutionEvent], Never> {
            var collected: [ToolExecutionEvent] = []
            for await event in execEventsStream {
                collected.append(event)
                if collected.count == 6 { break }
            }
            return collected
        }

        // Run 1: tool fails → .fail decision → circuit opens (threshold=1)
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        // Run 2: circuit already open → .circuitOpen decision → delivery also fails
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c2", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        let received = await eventsTask.value
        XCTAssertEqual(received.count, 6)

        // Events [3..5] are from run 2; [5] is the final .failed for the circuit-open case
        if case .failed(let id, _, let errorStr) = received[5] {
            XCTAssertEqual(id, "c2")
            XCTAssertTrue(
                errorStr.contains("response delivery failed"),
                "Expected delivery failure in circuit-open .failed error, got: '\(errorStr)'"
            )
        } else {
            XCTFail("Expected .failed at index 5 (run-2 terminal event), got \(received[5])")
        }
    }

    /// When `sendToolResponse` throws, the execution lifecycle must still emit `.failed`
    /// rather than silently swallowing the error and emitting `.succeeded`.
    func test_processEventStream_responseDeliveryFailure_yieldsFailedEvent() async throws {
        // Given: tool executes successfully but response delivery always fails
        let registry = DefaultToolRegistry()
        let executor = CapturingToolExecutor(name: "tool")
        try await registry.register(executor: executor)
        let manager = ToolExecutionManager(
            toolRegistry: registry,
            responseHandler: FailingResponseHandler(),
            errorHandlerConfig: ToolErrorConfig(maxRetryAttempts: 0)
        )

        let execEventsStream = await manager.executionEvents
        let eventsTask = Task<[ToolExecutionEvent], Never> {
            var collected: [ToolExecutionEvent] = []
            for await event in execEventsStream {
                collected.append(event)
                if collected.count == 3 { break }
            }
            return collected
        }

        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "tool")),
                threadId: nil, runId: nil
            )
        )

        let received = await eventsTask.value
        XCTAssertEqual(received.count, 3)

        // Must be .failed — not .succeeded — when response delivery throws
        if case .failed(let id, _, _) = received[2] {
            XCTAssertEqual(id, "c1")
        } else {
            XCTFail("Expected .failed when response delivery fails, got \(received[2])")
        }
    }

    // MARK: - Feature: Per-tool circuit breaker isolation (Issue 27)

    /// Circuit breakers must be scoped per-tool: one tool's failures must not block other tools.
    func test_perToolCircuitBreaker_oneToolFailingDoesNotBlockOtherTools() async throws {
        // Given: two tools; 'fragile' consistently errors, 'healthy' always succeeds
        let registry = DefaultToolRegistry()

        let fragileExec = CapturingToolExecutor(name: "fragile")
        await fragileExec.setError(NSError(domain: "TestError", code: 1, userInfo: nil))

        let healthyExec = CapturingToolExecutor(name: "healthy")
        await healthyExec.setResult(.success(message: "ok"))

        try await registry.register(executor: fragileExec)
        try await registry.register(executor: healthyExec)

        let handler = CapturingResponseHandler()
        // Circuit opens after 1 failure; recovery window is impossibly long during the test
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 1, recoveryTimeoutSeconds: 3600)
        )
        let manager = ToolExecutionManager(
            toolRegistry: registry,
            responseHandler: handler,
            errorHandlerConfig: config
        )

        // First run: fail 'fragile' once — this opens its per-tool circuit breaker
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c1", name: "fragile")),
                threadId: nil, runId: nil
            )
        )

        // Second run: 'healthy' must succeed — its circuit breaker is independent
        try await drain(
            await manager.processEventStream(
                makeStream(toolCallEvents(id: "c2", name: "healthy")),
                threadId: nil, runId: nil
            )
        )

        let messages = await handler.sentMessages
        XCTAssertEqual(messages.count, 2)

        let healthyMsg = messages.first(where: { $0.toolCallId == "c2" })
        XCTAssertEqual(healthyMsg?.content, "ok",
                       "Healthy tool was blocked by fragile tool's circuit breaker (shared state)")
    }
}
