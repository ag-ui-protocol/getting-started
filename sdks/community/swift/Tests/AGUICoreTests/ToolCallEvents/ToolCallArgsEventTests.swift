// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ToolCallArgsEventTests: XCTestCase,
                                     AGUIEventDecoderTestHelpers,
                                     EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "toolCallId": EventTestData.toolCallId,
            "delta": "{\"location\": \"San Francisco\"}"
        ]
    }

    var eventTypeString: String { "TOOL_CALL_ARGS" }
    var expectedEventType: EventType { .toolCallArgs }
    var unknownEventTypeString: String { "TOOL_CALL_PAUSED" }

    // MARK: - Feature: Decode TOOL_CALL_ARGS

    func test_decodeValidToolCallArgs_returnsToolCallArgsEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"location\\": \\"San Francisco\\"}"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let toolCallArgs = event as? ToolCallArgsEvent else {
            return XCTFail("Expected ToolCallArgsEvent, got \(type(of: event))")
        }
        XCTAssertEqual(toolCallArgs.eventType, .toolCallArgs)
        XCTAssertEqual(toolCallArgs.toolCallId, EventTestData.toolCallId)
        XCTAssertEqual(toolCallArgs.delta, "{\"location\": \"San Francisco\"}")
        XCTAssertNil(toolCallArgs.timestamp)
    }

    func test_decodeToolCallArgs_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"location\\": \\"San Francisco\\"}",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.timestamp, EventTestData.timestamp)
    }

    func test_decodeToolCallArgs_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"location\\": \\"San Francisco\\"}",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.rawEvent, data)
    }

    func test_decodeToolCallArgs_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"location\\": \\"San Francisco\\"}",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.toolCallId, EventTestData.toolCallId)
        XCTAssertEqual(toolCallArgs.delta, "{\"location\": \"San Francisco\"}")
    }

    func test_decodeToolCallArgs_withUnicodeDelta_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"city\\": \\"北京\\"}"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.delta, "{\"city\": \"北京\"}")
    }

    func test_decodeToolCallArgs_withMultilineDelta_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\n  \\"key\\": \\"value\\"\\n}"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.delta, "{\n  \"key\": \"value\"\n}")
    }

    func test_decodeToolCallArgs_withEmptyDelta_allowsEmptyString() throws {
        // Given
        // Note: According to protocol, delta should be non-empty, but we allow it
        // for flexibility. Validation can be done at a higher level if needed.
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": ""
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let toolCallArgs = try XCTUnwrap(event as? ToolCallArgsEvent)
        XCTAssertEqual(toolCallArgs.delta, "")
    }

    // MARK: - Feature: Error handling

    func test_decodeToolCallArgs_missingToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "delta": "{\\"location\\": \\"San Francisco\\"}"
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

    func test_decodeToolCallArgs_missingDelta_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "call-123"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("delta") || message.contains("Missing key"))
        }
    }

    func test_decodeToolCallArgs_wrongTypeForToolCallId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": 123,
          "delta": "{\\"location\\": \\"San Francisco\\"}"
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

    func test_decodeToolCallArgs_wrongTypeForDelta_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("delta") || message.contains("Type mismatch"))
        }
    }

    func test_decodeToolCallArgs_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_ARGS",
          "toolCallId": "\(EventTestData.toolCallId)",
          "delta": "{\\"location\\": \\"San Francisco\\"}",
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

    func test_toolCallArgsEvent_eventTypeIsAlwaysToolCallArgs() {
        // Given
        let event = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .toolCallArgs)
    }

    func test_toolCallArgsEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallArgsEvent_equatable_differentToolCallIds_areNotEqual() {
        // Given
        let event1 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallArgsEvent(toolCallId: "call-456", delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallArgsEvent_equatable_differentDeltas_areNotEqual() {
        // Given
        let event1 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value1\"}", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value2\"}", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallArgsEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "{\"key\": \"value\"}", timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallArgsEvent_withEmptyDelta_isValid() {
        // Given
        // Note: Protocol says delta should be non-empty, but we allow it for flexibility
        let event = ToolCallArgsEvent(toolCallId: EventTestData.toolCallId, delta: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.delta, "")
        XCTAssertEqual(event.eventType, .toolCallArgs)
    }
}
