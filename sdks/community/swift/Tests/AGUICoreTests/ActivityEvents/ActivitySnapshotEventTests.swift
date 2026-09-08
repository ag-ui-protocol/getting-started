// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ActivitySnapshotEventTests: XCTestCase,
                                        AGUIEventDecoderTestHelpers,
                                        EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "activityType": "a2ui-surface",
            "content": ["key": "value"]
        ]
    }

    var eventTypeString: String { "ACTIVITY_SNAPSHOT" }
    var expectedEventType: EventType { .activitySnapshot }
    var unknownEventTypeString: String { "ACTIVITY_PAUSED" }

    // MARK: - Feature: Decode ACTIVITY_SNAPSHOT

    func test_decodeValidActivitySnapshot_returnsActivitySnapshotEvent() throws {
        // Given
        let content = ["key": "value"]
        let contentData = try JSONSerialization.data(withJSONObject: content, options: [])
        
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"}
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.eventType, .activitySnapshot)
        XCTAssertEqual(snapshot.messageId, EventTestData.messageId)
        XCTAssertEqual(snapshot.activityType, "a2ui-surface")
        XCTAssertEqual(snapshot.content, contentData)
        XCTAssertEqual(snapshot.replace, true) // Default value
        XCTAssertNil(snapshot.timestamp)
    }

    func test_decodeActivitySnapshotWithReplaceFalse_returnsActivitySnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"},
          "replace": false
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.replace, false)
    }

    func test_decodeActivitySnapshotWithTimestamp_returnsActivitySnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"},
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.timestamp, EventTestData.timestamp)
    }

    func test_activitySnapshotEvent_eventTypeIsAlwaysActivitySnapshot() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )

        // Then
        XCTAssertEqual(event.eventType, .activitySnapshot)
    }

    func test_activitySnapshotEvent_parsedContent_returnsParsedJSON() throws {
        // Given
        let content: [String: Any] = ["key": "value", "number": 42]
        let contentData = try JSONSerialization.data(withJSONObject: content, options: [])
        let event = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: contentData
        )

        // When
        let parsed = try event.parsedContent() as? [String: Any]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["key"] as? String, "value")
        XCTAssertEqual(parsed?["number"] as? Int, 42)
    }

    // MARK: - Equatable Tests

    func test_activitySnapshotEvent_equatable_sameFields_areEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentMessageIds_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId2,
            activityType: "a2ui-surface",
            content: content
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentActivityTypes_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "other-type",
            content: content
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentReplaceValues_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: false
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }
}
