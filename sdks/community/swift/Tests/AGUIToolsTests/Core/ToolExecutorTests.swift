// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
import AGUICore
@testable import AGUITools

// MARK: - Mock Tool Executor

/// Mock tool executor for testing
actor MockToolExecutor: ToolExecutor {
    let tool: Tool
    var executeCallCount: Int = 0
    var resultToReturn: ToolExecutionResult?
    var errorToThrow: Error?

    init(tool: Tool) {
        self.tool = tool
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        executeCallCount += 1
        if let error = errorToThrow {
            throw error
        }
        return resultToReturn ?? ToolExecutionResult.success()
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        .valid
    }

    nonisolated func maximumExecutionTime() -> Duration? {
        nil
    }

    func getExecuteCallCount() -> Int {
        executeCallCount
    }
}

// MARK: - Tests

final class ToolExecutorTests: XCTestCase {

    // MARK: - ToolValidationResult Tests

    func testValidationResultSuccess() {
        // Given/When: A valid result
        let result = ToolValidationResult.valid

        // Then: Result should be valid with no errors
        XCTAssertTrue(result.isValid)
        XCTAssertTrue(result.errors.isEmpty)
    }

    func testValidationResultFailureWithSingleError() {
        // Given: An error message
        let errorMessage = "Missing required parameter: location"

        // When: Creating a failure result
        let result = ToolValidationResult.invalid(errors: [errorMessage])

        // Then: Result should be invalid with the error
        XCTAssertFalse(result.isValid)
        XCTAssertEqual(result.errors.count, 1)
        XCTAssertEqual(result.errors.first, errorMessage)
    }

    func testValidationResultFailureWithMultipleErrors() {
        // Given: Multiple error messages
        let errors = [
            "Missing required parameter: location",
            "Invalid parameter type: temperature should be a number",
            "Unknown parameter: extra_field"
        ]

        // When: Creating a failure result
        let result = ToolValidationResult.invalid(errors: errors)

        // Then: Result should be invalid with all errors
        XCTAssertFalse(result.isValid)
        XCTAssertEqual(result.errors.count, 3)
        XCTAssertEqual(result.errors, errors)
    }

    // MARK: - ToolExecutor Protocol Tests

    func testToolExecutorHasToolProperty() async {
        // Given: A tool definition
        let tool = Tool(
            name: "test_tool",
            description: "A test tool",
            parameters: Data("{}".utf8)
        )

        // When: Creating an executor
        let executor = MockToolExecutor(tool: tool)

        // Then: Executor should have the tool
        let toolName = await executor.tool.name
        XCTAssertEqual(toolName, "test_tool")
    }

    func testToolExecutorExecutesSuccessfully() async throws {
        // Given: An executor that returns success
        let tool = Tool(
            name: "weather_tool",
            description: "Get weather",
            parameters: Data("{}".utf8)
        )
        let executor = MockToolExecutor(tool: tool)
        let successResult = ToolExecutionResult.success(message: "Success")
        await executor.setResult(successResult)

        // When: Executing a tool call
        let toolCall = ToolCall(
            id: "call_1",
            function: FunctionCall(name: "weather_tool", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)
        let result = try await executor.execute(context: context)

        // Then: Result should be successful
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.message, "Success")
        let callCount = await executor.getExecuteCallCount()
        XCTAssertEqual(callCount, 1)
    }

    func testToolExecutorExecutesWithError() async throws {
        // Given: An executor that throws an error
        let tool = Tool(
            name: "failing_tool",
            description: "A tool that fails",
            parameters: Data("{}".utf8)
        )
        let executor = MockToolExecutor(tool: tool)
        let testError = ToolExecutionError.validationFailed(message: "Invalid input")
        await executor.setError(testError)

        // When/Then: Executing should throw the error
        let toolCall = ToolCall(
            id: "call_error",
            function: FunctionCall(name: "failing_tool", arguments: "{}")
        )
        let context = ToolExecutionContext(toolCall: toolCall)

        do {
            _ = try await executor.execute(context: context)
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

    func testToolExecutorValidateDefault() async {
        // Given: An executor with default validation
        let tool = Tool(
            name: "default_validation_tool",
            description: "Tool with default validation",
            parameters: Data("{}".utf8)
        )
        let executor = MockToolExecutor(tool: tool)

        // When: Validating a tool call
        let toolCall = ToolCall(
            id: "call_validate",
            function: FunctionCall(name: "default_validation_tool", arguments: "{}")
        )
        let result = executor.validate(toolCall: toolCall)

        // Then: Default validation should be valid
        XCTAssertTrue(result.isValid)
    }

    func testToolExecutorMaximumExecutionTimeNil() async {
        // Given: An executor with no timeout
        let tool = Tool(
            name: "no_timeout_tool",
            description: "Tool without timeout",
            parameters: Data("{}".utf8)
        )
        let executor = MockToolExecutor(tool: tool)

        // When: Getting maximum execution time
        let maxTime = executor.maximumExecutionTime()

        // Then: Should be nil (no timeout)
        XCTAssertNil(maxTime)
    }

    // MARK: - ToolExecutionError Tests

    func testToolExecutionErrorValidationFailed() {
        // Given: A validation error
        let error = ToolExecutionError.validationFailed(message: "Invalid params")

        // Then: Error should have correct message
        switch error {
        case .validationFailed(let message):
            XCTAssertEqual(message, "Invalid params")
        default:
            XCTFail("Wrong error case")
        }
    }

    func testToolExecutionErrorTimeout() {
        // Given: A timeout error
        let error = ToolExecutionError.timeout(
            toolName: "slow_tool",
            duration: .seconds(30)
        )

        // Then: Error should have correct details
        switch error {
        case .timeout(let toolName, let duration):
            XCTAssertEqual(toolName, "slow_tool")
            XCTAssertEqual(duration, .seconds(30))
        default:
            XCTFail("Wrong error case")
        }
    }

    func testToolExecutionErrorExecutionFailed() {
        // Given: A general execution failure
        struct UnderlyingError: Error {}
        let underlyingError = UnderlyingError()
        let error = ToolExecutionError.executionFailed(
            toolName: "broken_tool",
            underlyingError: underlyingError
        )

        // Then: Error should have correct details
        switch error {
        case .executionFailed(let toolName, let underlying):
            XCTAssertEqual(toolName, "broken_tool")
            XCTAssertNotNil(underlying)
        default:
            XCTFail("Wrong error case")
        }
    }

    func testToolExecutionErrorNotFound() {
        // Given: A tool not found error
        let error = ToolExecutionError.toolNotFound(toolName: "missing_tool")

        // Then: Error should have correct tool name
        switch error {
        case .toolNotFound(let toolName):
            XCTAssertEqual(toolName, "missing_tool")
        default:
            XCTFail("Wrong error case")
        }
    }

    // MARK: - Sendable Conformance

    func test_toolExecutionError_executionFailed_isSendable() async {
        // ToolExecutionError is Sendable. executionFailed's underlyingError must also
        // be Sendable; otherwise passing the error across a Task boundary is a Swift 6
        // compile error. This test verifies the associated value crosses a Task boundary.
        struct SendableFailure: Error, Sendable { let code: Int }
        let error = ToolExecutionError.executionFailed(
            toolName: "my_tool",
            underlyingError: SendableFailure(code: 42)
        )
        let result = await Task.detached { error }.value
        if case .executionFailed(_, let underlying) = result,
           let failure = underlying as? SendableFailure {
            XCTAssertEqual(failure.code, 42)
        } else {
            XCTFail("Expected .executionFailed with SendableFailure")
        }
    }

    func testToolExecutorSendable() async {
        // Given: A tool executor
        let tool = Tool(
            name: "sendable_test",
            description: "Test sendable",
            parameters: Data("{}".utf8)
        )
        let executor = MockToolExecutor(tool: tool)

        // When: Passing to another actor
        actor ExecutorHolder {
            var executor: MockToolExecutor?

            func store(_ executor: MockToolExecutor) {
                self.executor = executor
            }
        }

        let holder = ExecutorHolder()
        await holder.store(executor)

        // Then: No compiler errors (Sendable conformance)
        // This test verifies that tool executors can be sent across actors
    }

    // MARK: - Integration Tests

    func testCompleteExecutionFlow() async throws {
        // Given: A complete tool execution setup
        let tool = Tool(
            name: "complete_tool",
            description: "Complete tool for integration test",
            parameters: Data(#"{"type": "object", "properties": {"value": {"type": "number"}}}"#.utf8)
        )
        let executor = MockToolExecutor(tool: tool)
        let resultData = Data(#"{"result": 42}"#.utf8)
        let successResult = ToolExecutionResult.success(
            result: resultData,
            message: "Calculation complete"
        )
        await executor.setResult(successResult)

        // When: Executing with full context
        let toolCall = ToolCall(
            id: "call_integration",
            function: FunctionCall(
                name: "complete_tool",
                arguments: #"{"value": 21}"#
            )
        )
        let context = ToolExecutionContext(
            toolCall: toolCall,
            threadId: "thread_123",
            runId: "run_456",
            metadata: ["user": "test_user"]
        )
        let result = try await executor.execute(context: context)

        // Then: Everything should work together
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.result, resultData)
        XCTAssertEqual(result.message, "Calculation complete")
        let callCount = await executor.getExecuteCallCount()
        XCTAssertEqual(callCount, 1)
    }

    // MARK: - Default nonisolated implementations (Issue 43)

    func test_defaultValidate_isCallableFromNonisolatedContextOnActorConformer() {
        // Verifies that actor conformers can call the default `validate` and
        // `maximumExecutionTime` without `await`, as required by the `nonisolated`
        // protocol declaration. This is a compile-time contract: without `nonisolated`
        // on the extension defaults, Swift 6 would require `await` here (or error).
        let executor = MinimalActorExecutor()
        let toolCall = ToolCall(id: "x", function: FunctionCall(name: "minimal", arguments: "{}"))
        // These must be callable synchronously from a nonisolated context.
        let validation = executor.validate(toolCall: toolCall)
        let timeout = executor.maximumExecutionTime()
        XCTAssertTrue(validation.isValid)
        XCTAssertNil(timeout)
    }
}

// MARK: - Minimal actor conformer (no override of default implementations)

/// An actor that satisfies `ToolExecutor` with only the required `execute` method.
/// `validate` and `maximumExecutionTime` deliberately rely on extension defaults.
/// If the extension defaults are missing `nonisolated`, this actor cannot satisfy
/// the `nonisolated` protocol requirements in Swift 6.
private actor MinimalActorExecutor: ToolExecutor {
    let tool = Tool(name: "minimal", description: "Minimal", parameters: Data("{}".utf8))

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        .success()
    }

    // No override of validate or maximumExecutionTime — uses extension defaults.
}

// MARK: - Test Helper Extensions

extension MockToolExecutor {
    func setResult(_ result: ToolExecutionResult) {
        self.resultToReturn = result
    }

    func setError(_ error: Error) {
        self.errorToThrow = error
    }
}
