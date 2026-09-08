// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
import AGUICore
@testable import AGUITools

final class ToolExecutionContextTests: XCTestCase {

    // MARK: - Initialization Tests

    func testContextWithToolCallOnly() {
        // Given: A tool call
        let toolCall = ToolCall(
            id: "call_123",
            function: FunctionCall(
                name: "get_weather",
                arguments: #"{"location": "SF"}"#
            )
        )

        // When: Creating a context with just the tool call
        let context = ToolExecutionContext(toolCall: toolCall)

        // Then: Context should have the tool call and nil optional fields
        XCTAssertEqual(context.toolCall.id, "call_123")
        XCTAssertEqual(context.toolCall.function.name, "get_weather")
        XCTAssertNil(context.threadId)
        XCTAssertNil(context.runId)
        XCTAssertTrue(context.metadata.isEmpty)
    }

    func testContextWithThreadId() {
        // Given: A tool call and thread ID
        let toolCall = ToolCall(
            id: "call_456",
            function: FunctionCall(
                name: "send_email",
                arguments: "{}"
            )
        )
        let threadId = "thread_abc"

        // When: Creating a context with thread ID
        let context = ToolExecutionContext(
            toolCall: toolCall,
            threadId: threadId
        )

        // Then: Context should have the thread ID
        XCTAssertEqual(context.threadId, threadId)
        XCTAssertNil(context.runId)
        XCTAssertTrue(context.metadata.isEmpty)
    }

    func testContextWithRunId() {
        // Given: A tool call and run ID
        let toolCall = ToolCall(
            id: "call_789",
            function: FunctionCall(
                name: "calculate",
                arguments: #"{"value": 42}"#
            )
        )
        let runId = "run_xyz"

        // When: Creating a context with run ID
        let context = ToolExecutionContext(
            toolCall: toolCall,
            runId: runId
        )

        // Then: Context should have the run ID
        XCTAssertNil(context.threadId)
        XCTAssertEqual(context.runId, runId)
        XCTAssertTrue(context.metadata.isEmpty)
    }

    func testContextWithMetadata() {
        // Given: A tool call and metadata
        let toolCall = ToolCall(
            id: "call_meta",
            function: FunctionCall(
                name: "process",
                arguments: "{}"
            )
        )
        let metadata = [
            "userId": "user_123",
            "sessionId": "session_456",
            "timestamp": "2025-01-01T12:00:00Z"
        ]

        // When: Creating a context with metadata
        let context = ToolExecutionContext(
            toolCall: toolCall,
            metadata: metadata
        )

        // Then: Context should have the metadata
        XCTAssertEqual(context.metadata, metadata)
        XCTAssertEqual(context.metadata["userId"], "user_123")
        XCTAssertEqual(context.metadata["sessionId"], "session_456")
    }

    func testContextWithAllFields() {
        // Given: All context fields
        let toolCall = ToolCall(
            id: "call_full",
            function: FunctionCall(
                name: "full_context_test",
                arguments: #"{"param": "value"}"#
            )
        )
        let threadId = "thread_full"
        let runId = "run_full"
        let metadata = ["key": "value", "another": "data"]

        // When: Creating a context with all fields
        let context = ToolExecutionContext(
            toolCall: toolCall,
            threadId: threadId,
            runId: runId,
            metadata: metadata
        )

        // Then: All fields should be set
        XCTAssertEqual(context.toolCall.id, "call_full")
        XCTAssertEqual(context.threadId, threadId)
        XCTAssertEqual(context.runId, runId)
        XCTAssertEqual(context.metadata, metadata)
    }

    // MARK: - Sendable Conformance

    func testSendableAcrossActors() async {
        // Given: A context
        let toolCall = ToolCall(
            id: "call_sendable",
            function: FunctionCall(name: "test", arguments: "{}")
        )
        let context = ToolExecutionContext(
            toolCall: toolCall,
            threadId: "thread_1",
            runId: "run_1",
            metadata: ["test": "value"]
        )

        // When: Passing it to an actor
        actor ContextHolder {
            var context: ToolExecutionContext?

            func store(_ context: ToolExecutionContext) {
                self.context = context
            }
        }

        let holder = ContextHolder()
        await holder.store(context)

        // Then: No compiler errors (Sendable conformance)
        // This test verifies that ToolExecutionContext is Sendable
    }

    // MARK: - Edge Cases

    func testEmptyMetadata() {
        // Given: A tool call with explicitly empty metadata
        let toolCall = ToolCall(
            id: "call_empty",
            function: FunctionCall(name: "test", arguments: "{}")
        )

        // When: Creating context with empty metadata
        let context = ToolExecutionContext(
            toolCall: toolCall,
            metadata: [:]
        )

        // Then: Metadata should be empty
        XCTAssertTrue(context.metadata.isEmpty)
    }

    func testLargeMetadata() {
        // Given: A tool call with large metadata
        let toolCall = ToolCall(
            id: "call_large_meta",
            function: FunctionCall(name: "test", arguments: "{}")
        )
        var metadata: [String: String] = [:]
        for i in 0 ..< 100 {
            metadata["key\(i)"] = "value\(i)"
        }

        // When: Creating context with large metadata
        let context = ToolExecutionContext(
            toolCall: toolCall,
            metadata: metadata
        )

        // Then: All metadata should be stored
        XCTAssertEqual(context.metadata.count, 100)
        XCTAssertEqual(context.metadata["key50"], "value50")
    }

    func testComplexToolCallInContext() {
        // Given: A complex tool call with nested JSON arguments
        let complexArgs = """
        {
            "config": {
                "nested": {
                    "value": 123,
                    "array": [1, 2, 3]
                }
            },
            "options": ["a", "b", "c"]
        }
        """
        let toolCall = ToolCall(
            id: "call_complex",
            function: FunctionCall(name: "complex_tool", arguments: complexArgs)
        )

        // When: Creating context with complex tool call
        let context = ToolExecutionContext(
            toolCall: toolCall,
            threadId: "thread_complex"
        )

        // Then: Tool call should be preserved correctly
        XCTAssertEqual(context.toolCall.function.arguments, complexArgs)
    }
}
