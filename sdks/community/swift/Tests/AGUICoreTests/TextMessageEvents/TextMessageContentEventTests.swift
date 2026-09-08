// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class TextMessageContentEventTests: XCTestCase,
                                   AGUIEventDecoderTestHelpers,
                                   EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "delta": "Hello, world!"
        ]
    }

    var eventTypeString: String { "TEXT_MESSAGE_CONTENT" }
    var expectedEventType: EventType { .textMessageContent }
    var unknownEventTypeString: String { "TEXT_MESSAGE_PAUSED" }

    // MARK: - Feature: Decode TEXT_MESSAGE_CONTENT

    func test_decodeValidTextMessageContent_returnsTextMessageContentEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, world!"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let textMessageContent = event as? TextMessageContentEvent else {
            return XCTFail("Expected TextMessageContentEvent, got \(type(of: event))")
        }
        XCTAssertEqual(textMessageContent.eventType, .textMessageContent)
        XCTAssertEqual(textMessageContent.messageId, EventTestData.messageId)
        XCTAssertEqual(textMessageContent.delta, "Hello, world!")
        XCTAssertNil(textMessageContent.timestamp)
    }

    func test_decodeTextMessageContent_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, world!",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.timestamp, EventTestData.timestamp)
    }

    func test_decodeTextMessageContent_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, world!",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.rawEvent, data)
    }

    func test_decodeTextMessageContent_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, world!",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.messageId, EventTestData.messageId)
        XCTAssertEqual(textMessageContent.delta, "Hello, world!")
    }

    func test_decodeTextMessageContent_withUnicodeDelta_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, 🌍! 你好"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.delta, "Hello, 🌍! 你好")
    }

    func test_decodeTextMessageContent_withMultilineDelta_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Line 1\\nLine 2\\nLine 3"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.delta, "Line 1\nLine 2\nLine 3")
    }

    func test_decodeTextMessageContent_withEmptyDelta_allowsEmptyString() throws {
        // Given
        // Note: According to protocol, delta should be non-empty, but we allow it
        // for flexibility. Validation can be done at a higher level if needed.
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": ""
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageContent = try XCTUnwrap(event as? TextMessageContentEvent)
        XCTAssertEqual(textMessageContent.delta, "")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeTextMessageContent_missingMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "delta": "Hello, world!"
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

    func test_decodeTextMessageContent_missingDelta_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)"
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

    func test_decodeTextMessageContent_wrongTypeForMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": 123,
          "delta": "Hello, world!"
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

    func test_decodeTextMessageContent_wrongTypeForDelta_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
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

    func test_decodeTextMessageContent_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello, world!",
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

    func test_textMessageContentEvent_eventTypeIsAlwaysTextMessageContent() {
        // Given
        let event = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .textMessageContent)
    }

    func test_textMessageContentEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageContentEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageContentEvent(messageId: EventTestData.messageId2, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageContentEvent_equatable_differentDeltas_areNotEqual() {
        // Given
        let event1 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "World", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageContentEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "Hello", timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageContentEvent_withEmptyDelta_isValid() {
        // Given
        // Note: Protocol says delta should be non-empty, but we allow it for flexibility
        let event = TextMessageContentEvent(messageId: EventTestData.messageId, delta: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.delta, "")
        XCTAssertEqual(event.eventType, .textMessageContent)
    }
}
