// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class MessagesSnapshotEventTests: XCTestCase,
                                         AGUIEventDecoderTestHelpers,
                                         EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messages": [
                ["id": "msg-1", "role": "user", "content": "Hello"],
                ["id": "msg-2", "role": "assistant", "content": "Hi there!"]
            ]
        ]
    }

    var eventTypeString: String { "MESSAGES_SNAPSHOT" }
    var expectedEventType: EventType { .messagesSnapshot }
    var unknownEventTypeString: String { "UNKNOWN_MESSAGES_EVENT" }

    // MARK: - Feature: Decode MESSAGES_SNAPSHOT

    func test_decodeValidMessagesSnapshot_withArrayOfMessages_returnsMessagesSnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "role": "user",
              "content": "Hello, how are you?"
            },
            {
              "id": "msg-2",
              "role": "assistant",
              "content": "I'm doing well, thank you!"
            }
          ]
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let messagesSnapshot = event as? MessagesSnapshotEvent else {
            return XCTFail("Expected MessagesSnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(messagesSnapshot.eventType, .messagesSnapshot)
        XCTAssertNil(messagesSnapshot.timestamp)
        XCTAssertEqual(messagesSnapshot.messages.count, 2)
        XCTAssertEqual(messagesSnapshot.messages[0].id, "msg-1")
        XCTAssertEqual(messagesSnapshot.messages[0].role, .user)
        XCTAssertEqual(messagesSnapshot.messages[1].id, "msg-2")
        XCTAssertEqual(messagesSnapshot.messages[1].role, .assistant)
    }

    func test_decodeMessagesSnapshot_withEmptyArray_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": []
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.messages.count, 0)
    }

    func test_decodeMessagesSnapshot_withUnicodeContent_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "role": "user",
              "content": "Hello, 🌍! 你好"
            }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.messages.count, 1)
        let userMsg = try XCTUnwrap(messagesSnapshot.messages[0] as? UserMessage)
        XCTAssertEqual(userMsg.content, "Hello, 🌍! 你好")
    }

    func test_decodeMessagesSnapshot_withNullMessages_throwsDecodingError() {
        // Given — null is not a valid message array
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": null
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data))
    }

    func test_decodeMessagesSnapshot_withObjectInsteadOfArray_throwsDecodingError() {
        // Given — object is not a valid message array
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": {
            "conversation": [{"id": "msg-1", "content": "test"}],
            "total": 1
          }
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data))
    }

    func test_decodeMessagesSnapshot_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {"id": "msg-1", "role": "user", "content": "test"}
          ],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.timestamp, EventTestData.timestamp)
    }

    func test_decodeMessagesSnapshot_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1", "role": "user", "content": "test"}],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.rawEvent, data)
    }

    func test_decodeMessagesSnapshot_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1", "role": "user", "content": "test"}],
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.messages.count, 1)
        XCTAssertEqual(messagesSnapshot.messages[0].id, "msg-1")
    }

    func test_decodeMessagesSnapshot_unrecognizedMessageRole_skipsEntry() throws {
        // Given — messages with unrecognized roles are silently skipped (compactMap)
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {"id": "msg-1", "role": "user", "content": "Hello"},
            {"id": "msg-bad", "role": "unknown_role"}
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        // Unrecognized roles are skipped via compactMap; only the valid message survives
        XCTAssertEqual(messagesSnapshot.messages.count, 1)
        XCTAssertEqual(messagesSnapshot.messages[0].id, "msg-1")
    }

    // MARK: - Feature: Error handling

    func test_decodeMessagesSnapshot_missingMessages_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messages") || message.contains("Missing key"))
        }
    }

    func test_decodeMessagesSnapshot_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1", "role": "user", "content": "test"}],
          "timestamp": "not-a-number"
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

    func test_messagesSnapshotEvent_eventTypeIsAlwaysMessagesSnapshot() {
        // Given
        let event = MessagesSnapshotEvent(messages: [], timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .messagesSnapshot)
    }

    func test_messagesSnapshotEvent_messagesAreTyped() throws {
        // Given
        let userMsg = UserMessage(id: "msg-1", content: "Hello")
        let assistantMsg = AssistantMessage(id: "msg-2", content: "Hi!")
        let event = MessagesSnapshotEvent(messages: [userMsg, assistantMsg])

        // Then
        XCTAssertEqual(event.messages.count, 2)
        XCTAssertTrue(event.messages[0] is UserMessage)
        XCTAssertTrue(event.messages[1] is AssistantMessage)
    }

    func test_messagesSnapshotEvent_description_containsKeyInformation() {
        // Given
        let event = MessagesSnapshotEvent(
            messages: [UserMessage(id: "msg-1", content: "Hello")],
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("MessagesSnapshotEvent"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_messagesSnapshotEvent_debugDescription_containsDetailedInformation() {
        // Given
        let event = MessagesSnapshotEvent(
            messages: [UserMessage(id: "msg-1", content: "Hello")],
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("MessagesSnapshotEvent"))
        XCTAssertTrue(debugDescription.contains("messages"))
    }
}
