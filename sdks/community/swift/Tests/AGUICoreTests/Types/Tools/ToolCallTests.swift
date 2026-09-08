// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the ToolCall type
final class ToolCallTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithRequiredFields() {
        let functionCall = FunctionCall(name: "get_weather", arguments: "{\"location\":\"NYC\"}")
        let toolCall = ToolCall(
            id: "call_123",
            function: functionCall
        )

        XCTAssertEqual(toolCall.id, "call_123")
        XCTAssertEqual(toolCall.function.name, "get_weather")
        XCTAssertEqual(toolCall.type, "function")
    }

    func testTypeIsAlwaysFunction() {
        let functionCall1 = FunctionCall(name: "func1", arguments: "{}")
        let functionCall2 = FunctionCall(name: "func2", arguments: "{}")

        let toolCall1 = ToolCall(id: "call_1", function: functionCall1)
        let toolCall2 = ToolCall(id: "call_2", function: functionCall2)

        XCTAssertEqual(toolCall1.type, "function")
        XCTAssertEqual(toolCall2.type, "function")
    }

    // MARK: - Encoding Tests

    func testEncodingBasic() throws {
        let functionCall = FunctionCall(name: "test_func", arguments: "{\"x\":1}")
        let toolCall = ToolCall(id: "call_abc", function: functionCall)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(toolCall)
        let json = String(data: encoded, encoding: .utf8)

        XCTAssertNotNil(json)
        XCTAssertTrue(json?.contains("\"id\"") ?? false)
        XCTAssertTrue(json?.contains("\"type\"") ?? false)
        XCTAssertTrue(json?.contains("\"function\"") ?? false)
        XCTAssertTrue(json?.contains("\"call_abc\"") ?? false)
        XCTAssertTrue(json?.contains("\"function\"") ?? false)
    }

    func testEncodedTypeField() throws {
        let functionCall = FunctionCall(name: "test", arguments: "{}")
        let toolCall = ToolCall(id: "call_1", function: functionCall)

        let encoded = try JSONEncoder().encode(toolCall)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "function")
        XCTAssertEqual(json?["id"] as? String, "call_1")
        XCTAssertNotNil(json?["function"])
    }

    func testEncodedFunctionNested() throws {
        let functionCall = FunctionCall(name: "get_data", arguments: "{\"id\":42}")
        let toolCall = ToolCall(id: "call_nested", function: functionCall)

        let encoded = try JSONEncoder().encode(toolCall)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        let functionJson = json?["function"] as? [String: Any]

        XCTAssertNotNil(functionJson)
        XCTAssertEqual(functionJson?["name"] as? String, "get_data")
        XCTAssertEqual(functionJson?["arguments"] as? String, "{\"id\":42}")
    }

    // MARK: - Decoding Tests

    func testDecodingBasic() throws {
        let json = """
        {
            "id": "call_xyz",
            "type": "function",
            "function": {
                "name": "calculate",
                "arguments": "{\\"x\\":10,\\"y\\":20}"
            }
        }
        """

        let decoder = JSONDecoder()
        let toolCall = try decoder.decode(ToolCall.self, from: Data(json.utf8))

        XCTAssertEqual(toolCall.id, "call_xyz")
        XCTAssertEqual(toolCall.type, "function")
        XCTAssertEqual(toolCall.function.name, "calculate")
        XCTAssertTrue(toolCall.function.arguments.contains("\"x\":10"))
    }

    func testDecodingWithoutTypeField() throws {
        // Type field should default to "function" if not present
        let json = """
        {
            "id": "call_no_type",
            "function": {
                "name": "test",
                "arguments": "{}"
            }
        }
        """

        let decoder = JSONDecoder()
        let toolCall = try decoder.decode(ToolCall.self, from: Data(json.utf8))

        XCTAssertEqual(toolCall.id, "call_no_type")
        XCTAssertEqual(toolCall.type, "function")
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "type": "function",
            "function": {
                "name": "test",
                "arguments": "{}"
            }
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(ToolCall.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutFunction() {
        let json = """
        {
            "id": "call_1",
            "type": "function"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(ToolCall.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - Round-trip Tests

    func testRoundTrip() throws {
        let original = ToolCall(
            id: "call_roundtrip",
            function: FunctionCall(
                name: "send_message",
                arguments: "{\"to\":\"user@example.com\",\"message\":\"Hello\"}"
            )
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(ToolCall.self, from: encoded)

        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.type, original.type)
        XCTAssertEqual(decoded.function.name, original.function.name)
        XCTAssertEqual(decoded.function.arguments, original.function.arguments)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let func1 = FunctionCall(name: "test", arguments: "{}")
        let func2 = FunctionCall(name: "test", arguments: "{}")
        let func3 = FunctionCall(name: "other", arguments: "{}")

        let call1 = ToolCall(id: "call_1", function: func1)
        let call2 = ToolCall(id: "call_1", function: func2)
        let call3 = ToolCall(id: "call_2", function: func1)
        let call4 = ToolCall(id: "call_1", function: func3)

        XCTAssertEqual(call1, call2)
        XCTAssertNotEqual(call1, call3)
        XCTAssertNotEqual(call1, call4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let call1 = ToolCall(id: "call_1", function: FunctionCall(name: "f1", arguments: "{}"))
        let call2 = ToolCall(id: "call_2", function: FunctionCall(name: "f2", arguments: "{}"))

        let set: Set<ToolCall> = [call1, call2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(call1))
        XCTAssertTrue(set.contains(call2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let toolCall = ToolCall(
            id: "call_concurrent",
            function: FunctionCall(name: "test", arguments: "{}")
        )

        Task {
            let capturedCall = toolCall
            XCTAssertEqual(capturedCall.id, "call_concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testWeatherToolCall() {
        let weatherCall = ToolCall(
            id: "call_weather_123",
            function: FunctionCall(
                name: "get_current_weather",
                arguments: """
                {
                    "location": "San Francisco, CA",
                    "unit": "fahrenheit"
                }
                """
            )
        )

        XCTAssertEqual(weatherCall.id, "call_weather_123")
        XCTAssertEqual(weatherCall.function.name, "get_current_weather")
        XCTAssertTrue(weatherCall.function.arguments.contains("San Francisco"))
    }

    func testDatabaseQueryToolCall() {
        let queryCall = ToolCall(
            id: "call_db_query_456",
            function: FunctionCall(
                name: "execute_query",
                arguments: """
                {
                    "sql": "SELECT * FROM users WHERE active = true",
                    "database": "production"
                }
                """
            )
        )

        XCTAssertTrue(queryCall.function.arguments.contains("SELECT"))
    }

    func testMultipleToolCallsInArray() {
        let calls: [ToolCall] = [
            ToolCall(id: "call_1", function: FunctionCall(name: "func1", arguments: "{}")),
            ToolCall(id: "call_2", function: FunctionCall(name: "func2", arguments: "{}")),
            ToolCall(id: "call_3", function: FunctionCall(name: "func3", arguments: "{}"))
        ]

        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[0].id, "call_1")
        XCTAssertEqual(calls[1].id, "call_2")
        XCTAssertEqual(calls[2].id, "call_3")
    }

    func testToolCallLinkageWithToolMessage() {
        // Verify that the tool call ID can be used to link with ToolMessage
        let callId = "call_link_123"

        let toolCall = ToolCall(
            id: callId,
            function: FunctionCall(name: "test", arguments: "{}")
        )

        // This would later be matched with a ToolMessage
        let toolMessage = ToolMessage(
            id: "msg_1",
            content: "Result",
            toolCallId: callId
        )

        // Verify the linkage works
        XCTAssertEqual(toolCall.id, toolMessage.toolCallId)
    }
}
