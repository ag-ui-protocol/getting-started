// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the ToolMessage type
final class ToolMessageTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithRequiredFields() {
        let message = ToolMessage(
            id: "tool-msg-1",
            content: "Result: 42",
            toolCallId: "call-123"
        )

        XCTAssertEqual(message.id, "tool-msg-1")
        XCTAssertEqual(message.content, "Result: 42")
        XCTAssertEqual(message.toolCallId, "call-123")
        XCTAssertNil(message.name)
        XCTAssertNil(message.error)
        XCTAssertEqual(message.role, .tool)
    }

    func testInitWithAllFields() {
        let message = ToolMessage(
            id: "tool-msg-2",
            content: "File saved successfully",
            toolCallId: "call-456",
            name: "save_file",
            error: nil
        )

        XCTAssertEqual(message.id, "tool-msg-2")
        XCTAssertEqual(message.content, "File saved successfully")
        XCTAssertEqual(message.toolCallId, "call-456")
        XCTAssertEqual(message.name, "save_file")
        XCTAssertNil(message.error)
        XCTAssertEqual(message.role, .tool)
    }

    func testInitWithError() {
        let message = ToolMessage(
            id: "tool-msg-3",
            content: "Failed to execute",
            toolCallId: "call-789",
            name: "broken_tool",
            error: "File not found"
        )

        XCTAssertEqual(message.id, "tool-msg-3")
        XCTAssertEqual(message.error, "File not found")
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let message: any Message = ToolMessage(
            id: "tool-msg-4",
            content: "Success",
            toolCallId: "call-test"
        )

        XCTAssertEqual(message.id, "tool-msg-4")
        XCTAssertEqual(message.role, .tool)
        XCTAssertEqual((message as? ToolMessage)?.content, "Success")
    }

    func testRoleIsAlwaysTool() {
        let message1 = ToolMessage(id: "1", content: "Result 1", toolCallId: "call-1")
        let message2 = ToolMessage(id: "2", content: "Result 2", toolCallId: "call-2", name: "tool")

        XCTAssertEqual(message1.role, .tool)
        XCTAssertEqual(message2.role, .tool)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: ToolMessage no longer directly supports Codable.
    // Serialization is handled through ToolMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingWithRequiredFields() throws {
        let json = """
        {
            "id": "tool-decode-1",
            "role": "tool",
            "content": "Operation successful",
            "toolCallId": "call-dec-1"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ToolMessage)
        let toolMessage = message as! ToolMessage
        XCTAssertEqual(toolMessage.id, "tool-decode-1")
        XCTAssertEqual(toolMessage.role, .tool)
        XCTAssertEqual(toolMessage.content, "Operation successful")
        XCTAssertEqual(toolMessage.toolCallId, "call-dec-1")
        XCTAssertNil(toolMessage.name)
        XCTAssertNil(toolMessage.error)
    }

    func testDecodingWithAllFields() throws {
        let json = """
        {
            "id": "tool-decode-2",
            "role": "tool",
            "content": "File written",
            "toolCallId": "call-dec-2",
            "name": "write_file",
            "error": null
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ToolMessage)
        let toolMessage = message as! ToolMessage
        XCTAssertEqual(toolMessage.id, "tool-decode-2")
        XCTAssertEqual(toolMessage.content, "File written")
        XCTAssertEqual(toolMessage.toolCallId, "call-dec-2")
        XCTAssertEqual(toolMessage.name, "write_file")
        XCTAssertNil(toolMessage.error)
    }

    func testDecodingWithError() throws {
        let json = """
        {
            "id": "tool-decode-3",
            "role": "tool",
            "content": "Failed",
            "toolCallId": "call-dec-3",
            "error": "Network timeout"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ToolMessage)
        let toolMessage = message as! ToolMessage
        XCTAssertEqual(toolMessage.error, "Network timeout")
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "tool",
            "content": "Test",
            "toolCallId": "call-1"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingWithoutContent() throws {
        // Content is optional for ToolMessage, defaults to empty string when missing
        let json = """
        {
            "id": "tool-1",
            "role": "tool",
            "toolCallId": "call-1"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ToolMessage)
        let toolMessage = message as! ToolMessage
        XCTAssertEqual(toolMessage.id, "tool-1")
        XCTAssertEqual(toolMessage.toolCallId, "call-1")
        // When content is missing, it defaults to empty string
        XCTAssertEqual(toolMessage.content, "")
    }

    func testDecodingFailsWithoutToolCallId() {
        let json = """
        {
            "id": "tool-1",
            "role": "tool",
            "content": "Result"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithWrongRole() {
        let json = """
        {
            "id": "tool-1",
            "role": "user",
            "content": "Test",
            "toolCallId": "call-1"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as UserMessage, not ToolMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is ToolMessage)
        XCTAssertTrue(message is UserMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripWithRequiredFields() throws {
        // Create original message
        let original = ToolMessage(
            id: "tool-roundtrip-1",
            content: "Database query result: 100 rows",
            toolCallId: "call-rt-1"
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content,
            "toolCallId": original.toolCallId
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is ToolMessage)
        let toolMessage = decoded as! ToolMessage
        XCTAssertEqual(toolMessage.id, original.id)
        XCTAssertEqual(toolMessage.role, original.role)
        XCTAssertEqual(toolMessage.content, original.content)
        XCTAssertEqual(toolMessage.toolCallId, original.toolCallId)
    }

    func testRoundTripWithAllFields() throws {
        // Create original message
        let original = ToolMessage(
            id: "tool-roundtrip-2",
            content: "API call failed",
            toolCallId: "call-rt-2",
            name: "api_request",
            error: "HTTP 500 Internal Server Error"
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content,
            "toolCallId": original.toolCallId,
            "name": original.name as Any,
            "error": original.error as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is ToolMessage)
        let toolMessage = decoded as! ToolMessage
        XCTAssertEqual(toolMessage.id, original.id)
        XCTAssertEqual(toolMessage.content, original.content)
        XCTAssertEqual(toolMessage.toolCallId, original.toolCallId)
        XCTAssertEqual(toolMessage.name, original.name)
        XCTAssertEqual(toolMessage.error, original.error)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let message1 = ToolMessage(id: "1", content: "Result", toolCallId: "call-1", name: "tool")
        let message2 = ToolMessage(id: "1", content: "Result", toolCallId: "call-1", name: "tool")
        let message3 = ToolMessage(id: "2", content: "Result", toolCallId: "call-1", name: "tool")
        let message4 = ToolMessage(id: "1", content: "Different", toolCallId: "call-1", name: "tool")
        let message5 = ToolMessage(id: "1", content: "Result", toolCallId: "call-2", name: "tool")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
        XCTAssertNotEqual(message1, message5)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let message1 = ToolMessage(id: "1", content: "Test", toolCallId: "call-1")
        let message2 = ToolMessage(id: "2", content: "Test", toolCallId: "call-2")

        let set: Set<ToolMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let message = ToolMessage(id: "tool-concurrent", content: "Result", toolCallId: "call-123")

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.toolCallId, "call-123")
        }
    }

    // MARK: - Real-world Usage Tests

    func testSuccessfulToolExecution() {
        let result = ToolMessage(
            id: "tool-success-1",
            content: "Successfully saved 5 files to /documents",
            toolCallId: "call-save-files-1",
            name: "save_files"
        )

        XCTAssertEqual(result.role, .tool)
        XCTAssertNil(result.error)
        XCTAssertTrue(result.content.contains("Successfully"))
    }

    func testFailedToolExecution() {
        let result = ToolMessage(
            id: "tool-error-1",
            content: "Operation failed",
            toolCallId: "call-delete-1",
            name: "delete_file",
            error: "Permission denied: Cannot delete system file"
        )

        XCTAssertNotNil(result.error)
        XCTAssertTrue(result.error?.contains("Permission denied") ?? false)
    }

    func testToolCallIdLinkage() {
        // Verify that toolCallId properly links request and response
        let toolCallId = "call-calc-123"

        let toolMessage = ToolMessage(
            id: "tool-response-1",
            content: "Result: 3.14159",
            toolCallId: toolCallId,
            name: "calculate_pi"
        )

        // The toolCallId should match the original tool call request
        XCTAssertEqual(toolMessage.toolCallId, toolCallId)
    }

    func testDatabaseQueryResult() {
        let queryResult = ToolMessage(
            id: "tool-db-1",
            content: """
            Query executed successfully.
            Rows affected: 42
            Execution time: 127ms
            """,
            toolCallId: "call-query-users",
            name: "execute_sql"
        )

        XCTAssertTrue(queryResult.content.contains("42"))
    }
}
