// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ToolCallEndEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        ["toolCallId": EventTestData.toolCallId]
    }

    var eventTypeString: String { "TOOL_CALL_END" }
    var expectedEventType: EventType { .toolCallEnd }
    var unknownEventTypeString: String { "TOOL_CALL_PAUSED" }

    // MARK: - Feature: Decode TOOL_CALL_END

    func test_decodeValidToolCallEnd_returnsToolCallEndEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "\(EventTestData.toolCallId)"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let toolCallEnd = event as? ToolCallEndEvent else {
            return XCTFail("Expected ToolCallEndEvent, got \(type(of: event))")
        }
        XCTAssertEqual(toolCallEnd.eventType, .toolCallEnd)
        XCTAssertEqual(toolCallEnd.toolCallId, EventTestData.toolCallId)
        XCTAssertNil(toolCallEnd.timestamp)
    }

    func test_decodeToolCallEnd_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "\(EventTestData.toolCallId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallEnd = try XCTUnwrap(event as? ToolCallEndEvent)
        XCTAssertEqual(toolCallEnd.timestamp, EventTestData.timestamp)
    }

    func test_decodeToolCallEnd_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "\(EventTestData.toolCallId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallEnd = try XCTUnwrap(event as? ToolCallEndEvent)
        XCTAssertEqual(toolCallEnd.rawEvent, data)
    }

    func test_decodeToolCallEnd_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "\(EventTestData.toolCallId)",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallEnd = try XCTUnwrap(event as? ToolCallEndEvent)
        XCTAssertEqual(toolCallEnd.toolCallId, EventTestData.toolCallId)
    }

    func test_decodeToolCallEnd_withUnicodeToolCallId_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "call-🚀-123"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallEnd = try XCTUnwrap(event as? ToolCallEndEvent)
        XCTAssertEqual(toolCallEnd.toolCallId, "call-🚀-123")
    }

    // MARK: - Feature: Error handling

    func test_decodeToolCallEnd_missingToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END"
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

    func test_decodeToolCallEnd_wrongTypeForToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": 123
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

    func test_decodeToolCallEnd_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_END",
          "toolCallId": "\(EventTestData.toolCallId)",
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

    func test_toolCallEndEvent_eventTypeIsAlwaysToolCallEnd() {
        // Given
        let event = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .toolCallEnd)
    }

    func test_toolCallEndEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallEndEvent_equatable_differentToolCallIds_areNotEqual() {
        // Given
        let event1 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallEndEvent(toolCallId: "call-456", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallEndEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallEndEvent_equatable_oneNilTimestamp_areNotEqual() {
        // Given
        let event1 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallEndEvent_equatable_bothNilTimestamps_areEqual() {
        // Given
        let event1 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: nil, rawEvent: nil)
        let event2 = ToolCallEndEvent(toolCallId: EventTestData.toolCallId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallEndEvent_withEmptyToolCallId_isValid() {
        // Given
        let event = ToolCallEndEvent(toolCallId: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.toolCallId, "")
        XCTAssertEqual(event.eventType, .toolCallEnd)
    }
}
