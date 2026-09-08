// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class TextMessageChunkEventTests: XCTestCase,
                                        AGUIEventDecoderTestHelpers,
                                        EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "delta": "Hello"
        ]
    }

    var eventTypeString: String { "TEXT_MESSAGE_CHUNK" }
    var expectedEventType: EventType { .textMessageChunk }
    var unknownEventTypeString: String { "TEXT_MESSAGE_PAUSED" }

    // MARK: - Feature: Decode TEXT_MESSAGE_CHUNK

    func test_decodeValidTextMessageChunk_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.eventType, .textMessageChunk)
        XCTAssertEqual(chunk.messageId, EventTestData.messageId)
        XCTAssertEqual(chunk.delta, "Hello")
        XCTAssertNil(chunk.role)
        XCTAssertNil(chunk.timestamp)
    }

    func test_decodeTextMessageChunkWithRole_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "delta": "Hello"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.role, "assistant")
        XCTAssertEqual(chunk.delta, "Hello")
    }

    func test_decodeTextMessageChunkWithTimestamp_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello",
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.timestamp, EventTestData.timestamp)
    }

    func test_decodeTextMessageChunkWithoutMessageId_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "delta": "World"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertNil(chunk.messageId)
        XCTAssertEqual(chunk.delta, "World")
    }

    func test_textMessageChunkEvent_eventTypeIsAlwaysTextMessageChunk() {
        // Given
        let event = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )

        // Then
        XCTAssertEqual(event.eventType, .textMessageChunk)
    }

    // MARK: - Equatable Tests

    func test_textMessageChunkEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            delta: "Hello",
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            delta: "Hello",
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId2,
            delta: "Hello"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_differentDeltas_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "World"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_oneNilMessageId_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_bothNilMessageIds_areEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    // MARK: - Feature: name field (protocol spec)

    func test_decodeTextMessageChunk_withName_populatesName() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "name": "Alice",
          "delta": "Hello"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try XCTUnwrap(try decoder.decode(data) as? TextMessageChunkEvent)

        // Then
        XCTAssertEqual(event.name, "Alice")
    }

    func test_decodeTextMessageChunk_withoutName_nameIsNil() throws {
        // Given — JSON with no "name" field
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hi"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? TextMessageChunkEvent)

        // Then
        XCTAssertNil(event.name)
    }

    func test_textMessageChunkEvent_init_acceptsName() {
        // Given
        let event = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            name: "Carol",
            delta: "Hi",
            timestamp: nil,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event.name, "Carol")
    }

    func test_textMessageChunkEvent_equalityDifferentNames_notEqual() {
        let e1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            name: "Alice",
            delta: "Hi"
        )
        let e2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            name: "Bob",
            delta: "Hi"
        )
        XCTAssertNotEqual(e1, e2)
    }
}
