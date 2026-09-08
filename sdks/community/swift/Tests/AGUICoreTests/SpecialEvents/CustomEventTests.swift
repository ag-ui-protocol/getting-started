// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class CustomEventTests: XCTestCase,
                                AGUIEventDecoderTestHelpers,
                                EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    // AG-UI wire format: "name" (event type) and "value" (payload)
    var validEventFieldsWithoutType: [String: Any] {
        [
            "name": "my.custom.event",
            "value": ["field1": "value1", "field2": 123]
        ]
    }

    var eventTypeString: String { "CUSTOM" }
    var expectedEventType: EventType { .custom }
    var unknownEventTypeString: String { "UNKNOWN_CUSTOM_EVENT" }

    // MARK: - Feature: Decode CUSTOM

    func test_decodeValidCustom_withObjectData_returnsCustomEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "com.example.userAction",
          "value": {
            "action": "buttonClick",
            "buttonId": "submit",
            "metadata": {
              "screen": "login"
            }
          }
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let customEvent = event as? CustomEvent else {
            return XCTFail("Expected CustomEvent, got \(type(of: event))")
        }
        XCTAssertEqual(customEvent.eventType, .custom)
        XCTAssertEqual(customEvent.name, "com.example.userAction")
        XCTAssertNil(customEvent.timestamp)

        // Verify data can be parsed
        let parsed = try customEvent.parsedData() as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["action"] as? String, "buttonClick")
        XCTAssertEqual(parsed?["buttonId"] as? String, "submit")
    }

    func test_decodeCustom_withArrayData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "events.batch",
          "value": [
            {"id": 1, "val": "a"},
            {"id": 2, "val": "b"}
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.name, "events.batch")
        let parsed = try customEvent.parsedData() as? [[String: Any]]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 2)
    }

    func test_decodeCustom_withPrimitiveData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "simple.message",
          "value": "Hello, World!"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.name,"simple.message")
        let parsed = try customEvent.parsedData() as? String
        XCTAssertEqual(parsed, "Hello, World!")
    }

    func test_decodeCustom_withNullData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "void.event",
          "value": null
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.name,"void.event")
        let parsed = try customEvent.parsedData()
        XCTAssertTrue(parsed is NSNull)
    }

    func test_decodeCustom_withDotNotationCustomType_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "com.myapp.analytics.pageView",
          "value": {"page": "/home"}
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.name,"com.myapp.analytics.pageView")
    }

    func test_decodeCustom_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "test.event",
          "value": { "count": 123 },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.timestamp, EventTestData.timestamp)
    }

    func test_decodeCustom_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "test.event",
          "value": { "key": "val" },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.rawEvent, data)
    }

    func test_decodeCustom_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "test.event",
          "value": { "key": "val" },
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        let parsed = try customEvent.parsedData() as? [String: Any]
        XCTAssertEqual(parsed?["key"] as? String, "val")
    }

    // MARK: - Feature: Error handling

    func test_decodeCustom_missingName_throwsDecodingFailed() {
        // Given — "name" is required; "value" is optional
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "value": { "key": "val" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("name") || message.contains("Missing key"))
        }
    }

    func test_decodeCustom_missingValue_returnsEventWithEmptyData() throws {
        // Given — "value" is optional per spec; absent value decodes to empty object
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "test.event",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let customEvent = try XCTUnwrap(event as? CustomEvent)
        XCTAssertEqual(customEvent.name,"test.event")
        let parsed = try customEvent.parsedData() as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertTrue(parsed?.isEmpty == true)
    }

    func test_decodeCustom_wrongTypeForName_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": 123,
          "value": { "key": "val" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("name") || message.contains("String"))
        }
    }

    func test_decodeCustom_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "CUSTOM",
          "name": "test.event",
          "value": { "key": "val" },
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

    func test_customEvent_eventTypeIsAlwaysCustom() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = CustomEvent(name: "test.event", value: eventData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .custom)
    }

    func test_customEvent_equatable_sameCustomTypeAndData_areEqual() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_customEvent_equatable_differentCustomTypes_areNotEqual() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = CustomEvent(name: "test.event1", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = CustomEvent(name: "test.event2", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_customEvent_equatable_differentData_areNotEqual() throws {
        // Given
        let eventData1 = try JSONSerialization.data(withJSONObject: ["key": "value1"], options: [])
        let eventData2 = try JSONSerialization.data(withJSONObject: ["key": "value2"], options: [])
        let event1 = CustomEvent(name: "test.event", value: eventData1, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = CustomEvent(name: "test.event", value: eventData2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_customEvent_equatable_differentTimestamps_areNotEqual() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_customEvent_parsedData_returnsCorrectValue() throws {
        // Given
        let originalObject: [String: Any] = ["action": "test", "count": 5]
        let eventData = try JSONSerialization.data(withJSONObject: originalObject, options: [])
        let event = CustomEvent(name: "test.event", value: eventData, timestamp: nil, rawEvent: nil)

        // When
        let parsed = try event.parsedData() as? [String: Any]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["action"] as? String, "test")
        XCTAssertEqual(parsed?["count"] as? Int, 5)
    }

    func test_customEvent_parsedData_withInvalidData_throws() throws {
        // Given
        let invalidData = Data("not json".utf8)
        let event = CustomEvent(name: "test.event", value: invalidData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedData())
    }

    func test_customEvent_parsedDataAs_withCodableType_decodesCorrectly() throws {
        // Given
        struct CustomPayload: Codable, Equatable {
            let action: String
            let userId: Int
        }

        let originalPayload = CustomPayload(action: "login", userId: 12345)
        let eventData = try JSONEncoder().encode(originalPayload)
        let event = CustomEvent(name: "user.action", value: eventData, timestamp: nil, rawEvent: nil)

        // When
        let decoded = try event.parsedData(as: CustomPayload.self)

        // Then
        XCTAssertEqual(decoded.action, "login")
        XCTAssertEqual(decoded.userId, 12345)
    }

    func test_customEvent_description_containsKeyInformation() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("CustomEvent"))
        XCTAssertTrue(description.contains("test.event"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_customEvent_debugDescription_containsDetailedInformation() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = CustomEvent(name: "test.event", value: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("CustomEvent"))
        XCTAssertTrue(debugDescription.contains("test.event"))
        XCTAssertTrue(debugDescription.contains("value"))
    }
}
