// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class RawEventTests: XCTestCase,
                            AGUIEventDecoderTestHelpers,
                            EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "event": ["arbitrary": "content", "can": "be", "anything": 123]
        ]
    }

    var eventTypeString: String { "RAW" }
    var expectedEventType: EventType { .raw }
    var unknownEventTypeString: String { "UNKNOWN_RAW_EVENT" }

    // MARK: - Feature: Decode RAW

    func test_decodeValidRaw_withObjectData_returnsRawEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": {
            "customField": "value",
            "nested": {
              "prop": 123
            }
          }
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let rawEvent = event as? RawEvent else {
            return XCTFail("Expected RawEvent, got \(type(of: event))")
        }
        XCTAssertEqual(rawEvent.eventType, .raw)
        XCTAssertNil(rawEvent.timestamp)

        // Verify data can be parsed
        let parsed = try rawEvent.parsedData() as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["customField"] as? String, "value")
    }

    func test_decodeRaw_withArrayData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": [1, 2, 3, "four", true]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        let parsed = try rawEvent.parsedData() as? [Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 5)
    }

    func test_decodeRaw_withPrimitiveData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": "simple string"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        let parsed = try rawEvent.parsedData() as? String
        XCTAssertEqual(parsed, "simple string")
    }

    func test_decodeRaw_withNumberData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": 42
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        let parsed = try rawEvent.parsedData() as? Int
        XCTAssertEqual(parsed, 42)
    }

    func test_decodeRaw_withNullData_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": null
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        let parsed = try rawEvent.parsedData()
        XCTAssertTrue(parsed is NSNull)
    }

    func test_decodeRaw_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "value": 123 },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        XCTAssertEqual(rawEvent.timestamp, EventTestData.timestamp)
    }

    func test_decodeRaw_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        XCTAssertEqual(rawEvent.rawEvent, data)
    }

    func test_decodeRaw_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" },
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let rawEvent = try XCTUnwrap(event as? RawEvent)
        let parsed = try rawEvent.parsedData() as? [String: Any]
        XCTAssertEqual(parsed?["key"] as? String, "value")
    }

    // MARK: - Feature: Error handling

    func test_decodeRaw_missingData_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("event") || message.contains("Missing key"))
        }
    }

    func test_decodeRaw_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" },
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

    func test_rawEvent_eventTypeIsAlwaysRaw() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = RawEvent(data: eventData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .raw)
    }

    func test_rawEvent_equatable_sameData_areEqual() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = RawEvent(data: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = RawEvent(data: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_rawEvent_equatable_differentData_areNotEqual() throws {
        // Given
        let eventData1 = try JSONSerialization.data(withJSONObject: ["key": "value1"], options: [])
        let eventData2 = try JSONSerialization.data(withJSONObject: ["key": "value2"], options: [])
        let event1 = RawEvent(data: eventData1, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = RawEvent(data: eventData2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_rawEvent_equatable_differentTimestamps_areNotEqual() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = RawEvent(data: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = RawEvent(data: eventData, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_rawEvent_parsedData_returnsCorrectValue() throws {
        // Given
        let originalObject: [String: Any] = ["key": "value", "number": 42]
        let eventData = try JSONSerialization.data(withJSONObject: originalObject, options: [])
        let event = RawEvent(data: eventData, timestamp: nil, rawEvent: nil)

        // When
        let parsed = try event.parsedData() as? [String: Any]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["key"] as? String, "value")
        XCTAssertEqual(parsed?["number"] as? Int, 42)
    }

    func test_rawEvent_parsedData_withInvalidData_throws() throws {
        // Given
        let invalidData = Data("not json".utf8)
        let event = RawEvent(data: invalidData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedData())
    }

    func test_rawEvent_parsedDataAs_withCodableType_decodesCorrectly() throws {
        // Given
        struct CustomData: Codable, Equatable {
            let field1: String
            let field2: Int
        }

        let originalData = CustomData(field1: "test", field2: 123)
        let eventData = try JSONEncoder().encode(originalData)
        let event = RawEvent(data: eventData, timestamp: nil, rawEvent: nil)

        // When
        let decoded = try event.parsedData(as: CustomData.self)

        // Then
        XCTAssertEqual(decoded.field1, "test")
        XCTAssertEqual(decoded.field2, 123)
    }

    func test_rawEvent_description_containsKeyInformation() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = RawEvent(data: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("RawEvent"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_rawEvent_debugDescription_containsDetailedInformation() throws {
        // Given
        let eventData = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = RawEvent(data: eventData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("RawEvent"))
        XCTAssertTrue(debugDescription.contains("data"))
    }
}
