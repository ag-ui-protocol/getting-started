// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ToolCallResultEventTests: XCTestCase,
                                      AGUIEventDecoderTestHelpers,
                                      EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "toolCallId": "call-456",
            "content": "Temperature: 72°F"
        ]
    }

    var eventTypeString: String { "TOOL_CALL_RESULT" }
    var expectedEventType: EventType { .toolCallResult }
    var unknownEventTypeString: String { "TOOL_CALL_PAUSED" }

    // MARK: - Feature: Decode TOOL_CALL_RESULT

    func test_decodeValidToolCallResult_returnsToolCallResultEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let toolCallResult = event as? ToolCallResultEvent else {
            return XCTFail("Expected ToolCallResultEvent, got \(type(of: event))")
        }
        XCTAssertEqual(toolCallResult.eventType, .toolCallResult)
        XCTAssertEqual(toolCallResult.messageId, EventTestData.messageId)
        XCTAssertEqual(toolCallResult.toolCallId, "call-456")
        XCTAssertEqual(toolCallResult.content, "Temperature: 72°F")
        XCTAssertNil(toolCallResult.role)
        XCTAssertNil(toolCallResult.timestamp)
    }

    func test_decodeToolCallResult_withRole_populatesRole() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "role": "tool"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.role, "tool")
    }

    func test_decodeToolCallResult_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.timestamp, EventTestData.timestamp)
    }

    func test_decodeToolCallResult_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.rawEvent, data)
    }

    func test_decodeToolCallResult_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.messageId, EventTestData.messageId)
        XCTAssertEqual(toolCallResult.toolCallId, "call-456")
        XCTAssertEqual(toolCallResult.content, "Temperature: 72°F")
    }

    func test_decodeToolCallResult_withUnicodeContent_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "温度: 22°C 🌡️"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.content, "温度: 22°C 🌡️")
    }

    func test_decodeToolCallResult_withMultilineContent_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Line 1\\nLine 2\\nLine 3"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.content, "Line 1\nLine 2\nLine 3")
    }

    func test_decodeToolCallResult_withEmptyContent_allowsEmptyString() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": ""
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallResult = try XCTUnwrap(event as? ToolCallResultEvent)
        XCTAssertEqual(toolCallResult.content, "")
    }

    // MARK: - Feature: Error handling

    func test_decodeToolCallResult_missingMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messageId") || message.contains("Missing key"))
        }
    }

    func test_decodeToolCallResult_missingToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "content": "Temperature: 72°F"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("toolCallId") || message.contains("Missing key"))
        }
    }

    func test_decodeToolCallResult_missingContent_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("content") || message.contains("Missing key"))
        }
    }

    func test_decodeToolCallResult_wrongTypeForMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": 123,
          "toolCallId": "call-456",
          "content": "Temperature: 72°F"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messageId") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallResult_wrongTypeForToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": 456,
          "content": "Temperature: 72°F"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("toolCallId") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallResult_wrongTypeForContent_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("content") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallResult_wrongTypeForRole_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "role": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("role") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallResult_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_RESULT",
          "messageId": "\(EventTestData.messageId)",
          "toolCallId": "call-456",
          "content": "Temperature: 72°F",
          "timestamp": "invalid"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("timestamp") || message.contains("Type mismatch"))
        }
    }

    // MARK: - Feature: Model behaviors

    func test_toolCallResultEvent_eventTypeIsAlwaysToolCallResult() {
        // Given
        let event = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .toolCallResult)
    }

    func test_toolCallResultEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: "tool", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: "tool", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: "msg-789", toolCallId: "call-456", content: "Result", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_differentToolCallIds_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-789", content: "Result", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_differentContent_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result1", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result2", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_differentRoles_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: "tool", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_oneNilRole_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: "tool", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_bothNilRoles_areEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: nil, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", role: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallResultEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "Result", timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallResultEvent_withEmptyContent_isValid() {
        // Given
        let event = ToolCallResultEvent(messageId: EventTestData.messageId, toolCallId: "call-456", content: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.content, "")
        XCTAssertEqual(event.eventType, .toolCallResult)
    }
}
