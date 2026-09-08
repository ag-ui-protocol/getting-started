// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the AssistantMessage type
final class AssistantMessageTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithContentOnly() {
        let message = AssistantMessage(
            id: "asst-1",
            content: "Hello! How can I help you?"
        )

        XCTAssertEqual(message.id, "asst-1")
        XCTAssertEqual(message.content, "Hello! How can I help you?")
        XCTAssertNil(message.name)
        XCTAssertNil(message.toolCalls)
        XCTAssertEqual(message.role, .assistant)
    }

    func testInitWithToolCallsOnly() {
        let toolCall = ToolCall(
            id: "call_123",
            function: FunctionCall(name: "get_weather", arguments: "{}")
        )

        let message = AssistantMessage(
            id: "asst-2",
            content: nil,
            toolCalls: [toolCall]
        )

        XCTAssertEqual(message.id, "asst-2")
        XCTAssertNil(message.content)
        XCTAssertEqual(message.toolCalls?.count, 1)
        XCTAssertEqual(message.toolCalls?.first?.id, "call_123")
    }

    func testInitWithContentAndToolCalls() {
        let toolCall = ToolCall(
            id: "call_456",
            function: FunctionCall(name: "search", arguments: "{\"query\":\"test\"}")
        )

        let message = AssistantMessage(
            id: "asst-3",
            content: "Let me search for that information.",
            toolCalls: [toolCall]
        )

        XCTAssertEqual(message.id, "asst-3")
        XCTAssertEqual(message.content, "Let me search for that information.")
        XCTAssertEqual(message.toolCalls?.count, 1)
    }

    func testInitWithAllFields() {
        let toolCalls = [
            ToolCall(id: "call_1", function: FunctionCall(name: "func1", arguments: "{}")),
            ToolCall(id: "call_2", function: FunctionCall(name: "func2", arguments: "{}"))
        ]

        let message = AssistantMessage(
            id: "asst-4",
            content: "Processing your request",
            name: "HelperBot",
            toolCalls: toolCalls
        )

        XCTAssertEqual(message.id, "asst-4")
        XCTAssertEqual(message.content, "Processing your request")
        XCTAssertEqual(message.name, "HelperBot")
        XCTAssertEqual(message.toolCalls?.count, 2)
        XCTAssertEqual(message.role, .assistant)
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let message: any Message = AssistantMessage(
            id: "asst-5",
            content: "Test"
        )

        XCTAssertEqual(message.id, "asst-5")
        XCTAssertEqual(message.role, .assistant)
        XCTAssertEqual((message as? AssistantMessage)?.content, "Test")
    }

    func testRoleIsAlwaysAssistant() {
        let message1 = AssistantMessage(id: "1", content: "Message 1")
        let message2 = AssistantMessage(id: "2", content: nil, toolCalls: [])

        XCTAssertEqual(message1.role, .assistant)
        XCTAssertEqual(message2.role, .assistant)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: AssistantMessage no longer directly supports Codable.
    // Serialization is handled through AssistantMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingWithContentOnly() throws {
        let json = """
        {
            "id": "asst-decode-1",
            "role": "assistant",
            "content": "Hello there!"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is AssistantMessage)
        let asstMessage = message as! AssistantMessage
        XCTAssertEqual(asstMessage.id, "asst-decode-1")
        XCTAssertEqual(asstMessage.role, .assistant)
        XCTAssertEqual(asstMessage.content, "Hello there!")
        XCTAssertNil(asstMessage.toolCalls)
    }

    func testDecodingWithToolCalls() throws {
        let json = """
        {
            "id": "asst-decode-2",
            "role": "assistant",
            "content": "Let me check that",
            "toolCalls": [
                {
                    "id": "call_abc",
                    "type": "function",
                    "function": {
                        "name": "get_data",
                        "arguments": "{\\"key\\":\\"value\\"}"
                    }
                }
            ]
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is AssistantMessage)
        let asstMessage = message as! AssistantMessage
        XCTAssertEqual(asstMessage.id, "asst-decode-2")
        XCTAssertEqual(asstMessage.content, "Let me check that")
        XCTAssertEqual(asstMessage.toolCalls?.count, 1)
        XCTAssertEqual(asstMessage.toolCalls?.first?.id, "call_abc")
        XCTAssertEqual(asstMessage.toolCalls?.first?.function.name, "get_data")
    }

    func testDecodingWithNilContent() throws {
        let json = """
        {
            "id": "asst-decode-3",
            "role": "assistant"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is AssistantMessage)
        let asstMessage = message as! AssistantMessage
        XCTAssertEqual(asstMessage.id, "asst-decode-3")
        XCTAssertNil(asstMessage.content)
    }

    func testDecodingWithMultipleToolCalls() throws {
        let json = """
        {
            "id": "asst-decode-4",
            "role": "assistant",
            "toolCalls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "func1", "arguments": "{}"}
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "func2", "arguments": "{}"}
                }
            ]
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is AssistantMessage)
        let asstMessage = message as! AssistantMessage
        XCTAssertEqual(asstMessage.toolCalls?.count, 2)
        XCTAssertEqual(asstMessage.toolCalls?[0].id, "call_1")
        XCTAssertEqual(asstMessage.toolCalls?[1].id, "call_2")
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "assistant",
            "content": "Test"
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
            "id": "asst-1",
            "role": "user",
            "content": "Test"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as UserMessage, not AssistantMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is AssistantMessage)
        XCTAssertTrue(message is UserMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripWithContent() throws {
        // Create original message
        let original = AssistantMessage(
            id: "asst-roundtrip-1",
            content: "This is a test response",
            name: "Assistant"
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content as Any,
            "name": original.name as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is AssistantMessage)
        let asstMessage = decoded as! AssistantMessage
        XCTAssertEqual(asstMessage.id, original.id)
        XCTAssertEqual(asstMessage.content, original.content)
        XCTAssertEqual(asstMessage.name, original.name)
    }

    func testRoundTripWithToolCalls() throws {
        // Create original message
        let toolCalls = [
            ToolCall(id: "call_rt1", function: FunctionCall(name: "func1", arguments: "{\"a\":1}")),
            ToolCall(id: "call_rt2", function: FunctionCall(name: "func2", arguments: "{\"b\":2}"))
        ]

        let original = AssistantMessage(
            id: "asst-roundtrip-2",
            content: "Executing functions",
            toolCalls: toolCalls
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let toolCallsArray = original.toolCalls?.map { toolCall in
            [
                "id": toolCall.id,
                "type": "function",
                "function": [
                    "name": toolCall.function.name,
                    "arguments": toolCall.function.arguments
                ]
            ] as [String: Any]
        }

        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content as Any,
            "toolCalls": toolCallsArray as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is AssistantMessage)
        let asstMessage = decoded as! AssistantMessage
        XCTAssertEqual(asstMessage.id, original.id)
        XCTAssertEqual(asstMessage.toolCalls?.count, original.toolCalls?.count)
        XCTAssertEqual(asstMessage.toolCalls?[0].id, original.toolCalls?[0].id)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let toolCall = ToolCall(id: "call_1", function: FunctionCall(name: "test", arguments: "{}"))

        let message1 = AssistantMessage(id: "1", content: "Test", toolCalls: [toolCall])
        let message2 = AssistantMessage(id: "1", content: "Test", toolCalls: [toolCall])
        let message3 = AssistantMessage(id: "2", content: "Test", toolCalls: [toolCall])
        let message4 = AssistantMessage(id: "1", content: "Different")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let message1 = AssistantMessage(id: "1", content: "Test")
        let message2 = AssistantMessage(id: "2", content: "Test")

        let set: Set<AssistantMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let message = AssistantMessage(id: "asst-concurrent", content: "Test")

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, "asst-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testTextOnlyResponse() {
        let response = AssistantMessage(
            id: "asst-text-1",
            content: "I understand your question. Let me explain..."
        )

        XCTAssertEqual(response.role, .assistant)
        XCTAssertNotNil(response.content)
        XCTAssertNil(response.toolCalls)
    }

    func testToolCallWithExplanation() {
        let weatherCall = ToolCall(
            id: "call_weather",
            function: FunctionCall(
                name: "get_weather",
                arguments: "{\"location\":\"San Francisco\"}"
            )
        )

        let response = AssistantMessage(
            id: "asst-tool-1",
            content: "Let me check the weather for you.",
            toolCalls: [weatherCall]
        )

        XCTAssertNotNil(response.content)
        XCTAssertEqual(response.toolCalls?.count, 1)
        XCTAssertTrue(response.content?.contains("weather") ?? false)
    }

    func testMultipleToolCallsAtOnce() {
        let toolCalls = [
            ToolCall(id: "call_1", function: FunctionCall(name: "get_user", arguments: "{\"id\":\"123\"}")),
            ToolCall(id: "call_2", function: FunctionCall(name: "get_orders", arguments: "{\"userId\":\"123\"}")),
            ToolCall(id: "call_3", function: FunctionCall(name: "get_preferences", arguments: "{\"userId\":\"123\"}"))
        ]

        let response = AssistantMessage(
            id: "asst-multi-1",
            content: "Gathering information from multiple sources...",
            toolCalls: toolCalls
        )

        XCTAssertEqual(response.toolCalls?.count, 3)
    }

    func testToolCallOnlyNoText() {
        let toolCall = ToolCall(
            id: "call_silent",
            function: FunctionCall(name: "background_task", arguments: "{}")
        )

        let response = AssistantMessage(
            id: "asst-silent-1",
            content: nil,
            toolCalls: [toolCall]
        )

        XCTAssertNil(response.content)
        XCTAssertNotNil(response.toolCalls)
    }
}
