// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
import AGUICore
@testable import AGUITools

// MARK: - Mock Tool Executor

actor TestToolExecutor: ToolExecutor {
    let tool: Tool
    var executeCallCount: Int = 0
    var resultToReturn: ToolExecutionResult?
    var errorToThrow: Error?
    var executionDelay: Duration?

    init(tool: Tool) {
        self.tool = tool
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        executeCallCount += 1

        if let delay = executionDelay {
            try await Task.sleep(for: delay)
        }

        if let error = errorToThrow {
            throw error
        }

        return resultToReturn ?? ToolExecutionResult.success(message: "Test execution")
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        .valid
    }

    nonisolated func maximumExecutionTime() -> Duration? {
        nil
    }

    func reset() {
        executeCallCount = 0
        resultToReturn = nil
        errorToThrow = nil
        executionDelay = nil
    }

    func getCallCount() -> Int {
        executeCallCount
    }

    func setResult(_ result: ToolExecutionResult?) {
        self.resultToReturn = result
    }

    func setError(_ error: Error?) {
        self.errorToThrow = error
    }

    func setDelay(_ delay: Duration?) {
        self.executionDelay = delay
    }
}

// MARK: - Tests

final class ToolRegistryTests: XCTestCase {

    // MARK: - Registration Tests

    func testRegisterTool() async throws {
        // Given: A registry and a tool executor
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "test_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)

        // When: Registering the tool
        try await registry.register(executor: executor)

        // Then: Tool should be registered
        let retrieved = await registry.executor(for: "test_tool")
        XCTAssertNotNil(retrieved)
        let retrievedTool = await retrieved?.tool
        XCTAssertEqual(retrievedTool?.name, "test_tool")
    }

    func testRegisterMultipleTools() async throws {
        // Given: A registry and multiple tool executors
        let registry = DefaultToolRegistry()
        let tool1 = Tool(name: "tool_1", description: "Tool 1", parameters: Data("{}".utf8))
        let tool2 = Tool(name: "tool_2", description: "Tool 2", parameters: Data("{}".utf8))
        let executor1 = TestToolExecutor(tool: tool1)
        let executor2 = TestToolExecutor(tool: tool2)

        // When: Registering multiple tools
        try await registry.register(executor: executor1)
        try await registry.register(executor: executor2)

        // Then: All tools should be registered
        let allTools = await registry.allTools()
        XCTAssertEqual(allTools.count, 2)
        XCTAssertTrue(allTools.contains { $0.name == "tool_1" })
        XCTAssertTrue(allTools.contains { $0.name == "tool_2" })
    }

    func testRegisterDuplicateToolThrowsError() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "duplicate", description: "Test", parameters: Data("{}".utf8))
        let executor1 = TestToolExecutor(tool: tool)
        let executor2 = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor1)

        // When/Then: Registering a duplicate should throw
        do {
            try await registry.register(executor: executor2)
            XCTFail("Expected error for duplicate tool registration")
        } catch let error as ToolRegistryError {
            switch error {
            case .alreadyRegistered(let toolName):
                XCTAssertEqual(toolName, "duplicate")
            default:
                XCTFail("Wrong error type")
            }
        }
    }

    func testRegisterToolWithEmptyNameThrowsError() async throws {
        // Given: A tool with empty name
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)

        // When/Then: Registering should throw
        do {
            try await registry.register(executor: executor)
            XCTFail("Expected error for empty tool name")
        } catch let error as ToolRegistryError {
            switch error {
            case .emptyToolName:
                break // Expected
            default:
                XCTFail("Wrong error type")
            }
        }
    }

    // MARK: - Unregistration Tests

    func testUnregisterTool() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "removable", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        // When: Unregistering the tool
        let wasRemoved = await registry.unregister(toolName: "removable")

        // Then: Tool should be removed
        XCTAssertTrue(wasRemoved)
        let retrieved = await registry.executor(for: "removable")
        XCTAssertNil(retrieved)
    }

    func testUnregisterNonExistentTool() async {
        // Given: An empty registry
        let registry = DefaultToolRegistry()

        // When: Unregistering a non-existent tool
        let wasRemoved = await registry.unregister(toolName: "nonexistent")

        // Then: Should return false
        XCTAssertFalse(wasRemoved)
    }

    // MARK: - Lookup Tests

    func testGetExecutorForRegisteredTool() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "lookup_test", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        // When: Looking up the executor
        let retrieved = await registry.executor(for: "lookup_test")

        // Then: Should return the executor
        XCTAssertNotNil(retrieved)
    }

    func testGetExecutorForNonExistentTool() async {
        // Given: An empty registry
        let registry = DefaultToolRegistry()

        // When: Looking up a non-existent tool
        let retrieved = await registry.executor(for: "missing")

        // Then: Should return nil
        XCTAssertNil(retrieved)
    }

    func testIsToolRegistered() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "check_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        // When/Then: Checking registration status
        let isRegistered = await registry.isToolRegistered(toolName: "check_tool")
        let isNotRegistered = await registry.isToolRegistered(toolName: "other_tool")
        XCTAssertTrue(isRegistered)
        XCTAssertFalse(isNotRegistered)
    }

    func testGetAllTools() async throws {
        // Given: A registry with multiple tools
        let registry = DefaultToolRegistry()
        let tools = [
            Tool(name: "tool_a", description: "A", parameters: Data("{}".utf8)),
            Tool(name: "tool_b", description: "B", parameters: Data("{}".utf8)),
            Tool(name: "tool_c", description: "C", parameters: Data("{}".utf8))
        ]

        for tool in tools {
            try await registry.register(executor: TestToolExecutor(tool: tool))
        }

        // When: Getting all tools
        let allTools = await registry.allTools()

        // Then: Should return all registered tools
        XCTAssertEqual(allTools.count, 3)
        let toolNames = Set(allTools.map { $0.name })
        XCTAssertEqual(toolNames, Set(["tool_a", "tool_b", "tool_c"]))
    }

    // MARK: - Execution Tests

    func testExecuteToolSuccessfully() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "exec_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        let expectedResult = ToolExecutionResult.success(message: "Success!")
        await executor.setResult(expectedResult)
        try await registry.register(executor: executor)

        // When: Executing the tool
        let toolCall = ToolCall(
            id: "call_1",
            function: FunctionCall(name: "exec_tool", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        let result = try await registry.execute(context: context)

        // Then: Should return the expected result
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.message, "Success!")
    }

    func testExecuteNonExistentToolThrowsError() async throws {
        // Given: An empty registry
        let registry = DefaultToolRegistry()

        // When/Then: Executing a non-existent tool should throw
        let toolCall = ToolCall(
            id: "call_missing",
            function: FunctionCall(name: "missing_tool", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)

        do {
            _ = try await registry.execute(context: context)
            XCTFail("Expected toolNotFound error")
        } catch let error as ToolRegistryError {
            switch error {
            case .toolNotFound(let toolName):
                XCTAssertEqual(toolName, "missing_tool")
            default:
                XCTFail("Wrong error type")
            }
        }
    }

    func testExecuteToolWithError() async throws {
        // Given: A registry with a tool that throws an error
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "failing_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        let expectedError = ToolExecutionError.validationFailed(message: "Invalid input")
        await executor.setError(expectedError)
        try await registry.register(executor: executor)

        // When/Then: Executing should propagate the error
        let toolCall = ToolCall(
            id: "call_fail",
            function: FunctionCall(name: "failing_tool", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)

        do {
            _ = try await registry.execute(context: context)
            XCTFail("Expected error to be thrown")
        } catch let error as ToolExecutionError {
            switch error {
            case .validationFailed(let message):
                XCTAssertEqual(message, "Invalid input")
            default:
                XCTFail("Wrong error type")
            }
        }
    }

    // MARK: - Statistics Tests

    func testStatsInitiallyEmpty() async throws {
        // Given: A registry with a newly registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "stats_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        // When: Getting stats
        let stats = await registry.stats(for: "stats_tool")

        // Then: Stats should be initialized with zeros
        XCTAssertNotNil(stats)
        XCTAssertEqual(stats?.executionCount, 0)
        XCTAssertEqual(stats?.successCount, 0)
        XCTAssertEqual(stats?.failureCount, 0)
    }

    func testStatsAfterSuccessfulExecution() async throws {
        // Given: A registry with a tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "success_stats", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        // When: Executing the tool successfully
        let toolCall = ToolCall(
            id: "call_stats",
            function: FunctionCall(name: "success_stats", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        _ = try await registry.execute(context: context)

        // Then: Stats should reflect the successful execution
        let stats = await registry.stats(for: "success_stats")
        XCTAssertEqual(stats?.executionCount, 1)
        XCTAssertEqual(stats?.successCount, 1)
        XCTAssertEqual(stats?.failureCount, 0)
        XCTAssertEqual(stats?.successRate, 1.0)
    }

    func testStatsAfterFailedExecution() async throws {
        // Given: A registry with a tool that fails
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "fail_stats", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        await executor.setError(ToolExecutionError.validationFailed(message: "Fail"))
        try await registry.register(executor: executor)

        // When: Executing the tool (fails)
        let toolCall = ToolCall(
            id: "call_fail_stats",
            function: FunctionCall(name: "fail_stats", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        _ = try? await registry.execute(context: context)

        // Then: Stats should reflect the failure
        let stats = await registry.stats(for: "fail_stats")
        XCTAssertEqual(stats?.executionCount, 1)
        XCTAssertEqual(stats?.successCount, 0)
        XCTAssertEqual(stats?.failureCount, 1)
        XCTAssertEqual(stats?.successRate, 0.0)
    }

    func testStatsAverageExecutionTime() async throws {
        // Given: A registry with a tool
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "timing_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        await executor.setDelay(.milliseconds(10))
        try await registry.register(executor: executor)

        // When: Executing the tool multiple times
        for i in 1...3 {
            let toolCall = ToolCall(
                id: "call_\(i)",
                function: FunctionCall(name: "timing_tool", arguments: "{}")
            )
            let context = ToolExecutionContext(toolCall: toolCall)
            _ = try await registry.execute(context: context)
        }

        // Then: Stats should track average execution time
        let stats = await registry.stats(for: "timing_tool")
        XCTAssertEqual(stats?.executionCount, 3)
        XCTAssertGreaterThan(stats?.averageExecutionTime ?? .zero, .zero)
    }

    func testClearStats() async throws {
        // Given: A registry with execution history
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "clear_stats", description: "Test", parameters: Data("{}".utf8))
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        let toolCall = ToolCall(
            id: "call_clear",
            function: FunctionCall(name: "clear_stats", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        _ = try await registry.execute(context: context)

        // When: Clearing stats
        await registry.clearStats()

        // Then: Stats should be reset
        let stats = await registry.stats(for: "clear_stats")
        XCTAssertEqual(stats?.executionCount, 0)
        XCTAssertEqual(stats?.successCount, 0)
    }

    func testGetStatsForNonExistentTool() async {
        // Given: An empty registry
        let registry = DefaultToolRegistry()

        // When: Getting stats for non-existent tool
        let stats = await registry.stats(for: "nonexistent")

        // Then: Should return nil
        XCTAssertNil(stats)
    }

    func testGetAllStats() async throws {
        // Given: A registry with multiple tools
        let registry = DefaultToolRegistry()
        let tools = [
            Tool(name: "tool_stats_1", description: "1", parameters: Data("{}".utf8)),
            Tool(name: "tool_stats_2", description: "2", parameters: Data("{}".utf8))
        ]

        for tool in tools {
            try await registry.register(executor: TestToolExecutor(tool: tool))
        }

        // Execute one tool
        let toolCall = ToolCall(
            id: "call_all_stats",
            function: FunctionCall(name: "tool_stats_1", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        _ = try await registry.execute(context: context)

        // When: Getting all stats
        let allStats = await registry.getAllStats()

        // Then: Should return stats for all registered tools
        XCTAssertEqual(allStats.count, 2)
        XCTAssertNotNil(allStats["tool_stats_1"])
        XCTAssertNotNil(allStats["tool_stats_2"])
        XCTAssertEqual(allStats["tool_stats_1"]?.executionCount, 1)
        XCTAssertEqual(allStats["tool_stats_2"]?.executionCount, 0)
    }

    // MARK: - validate() pipeline tests

    func test_registry_execute_callsValidateBeforeExecute() async throws {
        // validate(toolCall:) must be called and must precede execute(context:).
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "ordered_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = OrderTrackingExecutor(tool: tool, validationResult: .valid)
        try await registry.register(executor: executor)

        let toolCall = ToolCall(id: "c1", function: FunctionCall(name: "ordered_tool", arguments: "{}"))
        _ = try await registry.execute(context: ToolExecutionContext(toolCall: toolCall))

        let order = executor.callOrder
        XCTAssertEqual(order, ["validate", "execute"], "validate must be called before execute")
    }

    func test_registry_execute_validationFailure_preventsExecution() async throws {
        // When validate() returns .invalid, execute() must not be called and the registry
        // must throw ToolExecutionError.validationFailed.
        let registry = DefaultToolRegistry()
        let tool = Tool(name: "strict_tool", description: "Test", parameters: Data("{}".utf8))
        let executor = OrderTrackingExecutor(
            tool: tool,
            validationResult: .invalid(errors: ["bad arg"])
        )
        try await registry.register(executor: executor)

        let toolCall = ToolCall(id: "c2", function: FunctionCall(name: "strict_tool", arguments: "{}"))
        do {
            _ = try await registry.execute(context: ToolExecutionContext(toolCall: toolCall))
            XCTFail("Expected validationFailed to be thrown")
        } catch let error as ToolExecutionError {
            guard case .validationFailed(let message) = error else {
                return XCTFail("Expected .validationFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("bad arg"))
        }

        let order = executor.callOrder
        XCTAssertEqual(order, ["validate"], "execute must not be called when validation fails")
    }
}

/// Executor that records whether validate and execute were called and in what order.
///
/// Uses a class-based recorder with a lock so that `nonisolated func validate()`
/// can write to shared state without crossing an actor boundary asynchronously.
final class OrderTrackingExecutor: ToolExecutor, Sendable {
    let tool: Tool

    /// Thread-safe recorder. `nonisolated` validate() and actor-like execute() both
    /// write to this synchronously, so the order is deterministic.
    private let recorder = CallOrderRecorder()
    private let validationResult: ToolValidationResult

    var callOrder: [String] { recorder.callOrder }

    init(tool: Tool, validationResult: ToolValidationResult) {
        self.tool = tool
        self.validationResult = validationResult
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        recorder.record("validate")
        return validationResult
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        recorder.record("execute")
        return .success()
    }

    nonisolated func maximumExecutionTime() -> Duration? { nil }
}

/// Lock-protected call-order log used by OrderTrackingExecutor.
final class CallOrderRecorder: @unchecked Sendable {
    private var _callOrder: [String] = []
    private let lock = NSLock()

    func record(_ step: String) {
        lock.withLock { _callOrder.append(step) }
    }

    var callOrder: [String] {
        lock.withLock { _callOrder }
    }
}

// MARK: - Helper Extensions
// TestToolExecutor methods are defined in the actor above
