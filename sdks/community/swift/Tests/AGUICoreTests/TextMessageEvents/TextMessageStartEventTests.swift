// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class TextMessageStartEventTests: XCTestCase,
                                         AGUIEventDecoderTestHelpers,
                                         EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "role": "assistant"
        ]
    }

    var eventTypeString: String { "TEXT_MESSAGE_START" }
    var expectedEventType: EventType { .textMessageStart }
    var unknownEventTypeString: String { "TEXT_MESSAGE_PAUSED" }

    // MARK: - Feature: Decode TEXT_MESSAGE_START

    func test_decodeValidTextMessageStart_returnsTextMessageStartEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let textMessageStart = event as? TextMessageStartEvent else {
            return XCTFail("Expected TextMessageStartEvent, got \(type(of: event))")
        }
        XCTAssertEqual(textMessageStart.eventType, .textMessageStart)
        XCTAssertEqual(textMessageStart.messageId, EventTestData.messageId)
        XCTAssertEqual(textMessageStart.role, "assistant")
        XCTAssertNil(textMessageStart.timestamp)
    }

    func test_decodeTextMessageStart_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageStart = try XCTUnwrap(event as? TextMessageStartEvent)
        XCTAssertEqual(textMessageStart.timestamp, EventTestData.timestamp)
    }

    func test_decodeTextMessageStart_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageStart = try XCTUnwrap(event as? TextMessageStartEvent)
        XCTAssertEqual(textMessageStart.rawEvent, data)
    }

    func test_decodeTextMessageStart_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageStart = try XCTUnwrap(event as? TextMessageStartEvent)
        XCTAssertEqual(textMessageStart.messageId, EventTestData.messageId)
        XCTAssertEqual(textMessageStart.role, "assistant")
    }

    func test_decodeTextMessageStart_withUnicodeMessageId_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "msg-🚀-123",
          "role": "assistant"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageStart = try XCTUnwrap(event as? TextMessageStartEvent)
        XCTAssertEqual(textMessageStart.messageId, "msg-🚀-123")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeTextMessageStart_missingMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "role": "assistant"
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

    func test_decodeTextMessageStart_missingRole_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "msg-123"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("role") || message.contains("Missing key"))
        }
    }

    func test_decodeTextMessageStart_wrongTypeForMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": 123,
          "role": "assistant"
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

    func test_decodeTextMessageStart_wrongTypeForRole_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "msg-123",
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

    func test_decodeTextMessageStart_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
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

    func test_textMessageStartEvent_eventTypeIsAlwaysTextMessageStart() {
        // Given
        let event = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .textMessageStart)
    }

    func test_textMessageStartEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageStartEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageStartEvent(messageId: EventTestData.messageId2, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageStartEvent_equatable_differentRoles_areNotEqual() {
        // Given
        let event1 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "user", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageStartEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageStartEvent(messageId: EventTestData.messageId, role: "assistant", timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageStartEvent_withEmptyMessageId_isValid() {
        // Given
        let event = TextMessageStartEvent(messageId: "", role: "assistant", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.messageId, "")
        XCTAssertEqual(event.eventType, .textMessageStart)
    }

    // MARK: - Feature: name field (protocol spec)

    func test_decodeTextMessageStart_withName_populatesName() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "name": "Alice"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try XCTUnwrap(try decoder.decode(data) as? TextMessageStartEvent)

        // Then
        XCTAssertEqual(event.name, "Alice")
    }

    func test_decodeTextMessageStart_withoutName_nameIsNil() throws {
        // Given — JSON with no "name" field
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? TextMessageStartEvent)

        // Then
        XCTAssertNil(event.name)
    }

    func test_textMessageStartEvent_init_acceptsName() {
        // Given
        let event = TextMessageStartEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            name: "Bob",
            timestamp: nil,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event.name, "Bob")
    }

    func test_textMessageStartEvent_equalityDifferentNames_notEqual() {
        let e1 = TextMessageStartEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            name: "Alice",
            timestamp: nil,
            rawEvent: nil
        )
        let e2 = TextMessageStartEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            name: "Bob",
            timestamp: nil,
            rawEvent: nil
        )
        XCTAssertNotEqual(e1, e2)
    }
}
