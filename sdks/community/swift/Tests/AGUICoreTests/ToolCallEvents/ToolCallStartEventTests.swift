// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ToolCallStartEventTests: XCTestCase,
                                     AGUIEventDecoderTestHelpers,
                                     EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "toolCallId": EventTestData.toolCallId,
            "toolCallName": "get_weather"
        ]
    }

    var eventTypeString: String { "TOOL_CALL_START" }
    var expectedEventType: EventType { .toolCallStart }
    var unknownEventTypeString: String { "TOOL_CALL_PAUSED" }

    // MARK: - Feature: Decode TOOL_CALL_START

    func test_decodeValidToolCallStart_returnsToolCallStartEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let toolCallStart = event as? ToolCallStartEvent else {
            return XCTFail("Expected ToolCallStartEvent, got \(type(of: event))")
        }
        XCTAssertEqual(toolCallStart.eventType, .toolCallStart)
        XCTAssertEqual(toolCallStart.toolCallId, EventTestData.toolCallId)
        XCTAssertEqual(toolCallStart.toolCallName, "get_weather")
        XCTAssertNil(toolCallStart.parentMessageId)
        XCTAssertNil(toolCallStart.timestamp)
    }

    func test_decodeToolCallStart_withParentMessageId_populatesParentMessageId() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
          "parentMessageId": "\(EventTestData.messageId2)"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.parentMessageId, EventTestData.messageId2)
    }

    func test_decodeToolCallStart_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.timestamp, EventTestData.timestamp)
    }

    func test_decodeToolCallStart_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.rawEvent, data)
    }

    func test_decodeToolCallStart_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.toolCallId, EventTestData.toolCallId)
        XCTAssertEqual(toolCallStart.toolCallName, "get_weather")
    }

    func test_decodeToolCallStart_withUnicodeToolCallId_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "call-🚀-123",
          "toolCallName": "get_weather"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.toolCallId, "call-🚀-123")
    }

    func test_decodeToolCallStart_withUnicodeToolCallName_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_天气"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallStart = try XCTUnwrap(event as? ToolCallStartEvent)
        XCTAssertEqual(toolCallStart.toolCallName, "get_天气")
    }

    // MARK: - Feature: Error handling

    func test_decodeToolCallStart_missingToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallName": "get_weather"
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

    func test_decodeToolCallStart_missingToolCallName_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("toolCallName") || message.contains("Missing key"))
        }
    }

    func test_decodeToolCallStart_wrongTypeForToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": 123,
          "toolCallName": "get_weather"
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

    func test_decodeToolCallStart_wrongTypeForToolCallName_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("toolCallName") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallStart_wrongTypeForParentMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
          "parentMessageId": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("parentMessageId") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallStart_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_START",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "get_weather",
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

    func test_toolCallStartEvent_eventTypeIsAlwaysToolCallStart() {
        // Given
        let event = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .toolCallStart)
    }

    func test_toolCallStartEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: EventTestData.messageId2, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: EventTestData.messageId2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_differentToolCallIds_areNotEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: "call-456", toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_differentToolCallNames_areNotEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_time", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_differentParentMessageIds_areNotEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: EventTestData.messageId2, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: "msg-789", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_oneNilParentMessageId_areNotEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: EventTestData.messageId2, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_bothNilParentMessageIds_areEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallStartEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "get_weather", parentMessageId: nil, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallStartEvent_withEmptyToolCallId_isValid() {
        // Given
        let event = ToolCallStartEvent(toolCallId: "", toolCallName: "get_weather", parentMessageId: nil, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.toolCallId, "")
        XCTAssertEqual(event.eventType, .toolCallStart)
    }

    func test_toolCallStartEvent_withEmptyToolCallName_isValid() {
        // Given
        let event = ToolCallStartEvent(toolCallId: EventTestData.toolCallId, toolCallName: "", parentMessageId: nil, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.toolCallName, "")
        XCTAssertEqual(event.eventType, .toolCallStart)
    }
}
