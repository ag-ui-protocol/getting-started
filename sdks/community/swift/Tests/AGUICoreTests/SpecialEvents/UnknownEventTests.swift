// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class UnknownEventTests: XCTestCase, AGUIEventDecoderTestHelpers {

    // MARK: - Feature: EventType.unknown sentinel

    func test_unknownEventType_rawValueIsSentinel() {
        // The sentinel raw value must never appear on the AG-UI wire
        XCTAssertEqual(EventType.unknown.rawValue, "__UNKNOWN__")
    }

    func test_unknownEventType_isNotEqualToRaw() {
        XCTAssertNotEqual(EventType.unknown, EventType.raw)
    }

    func test_unknownEventType_doesNotEqualAnyKnownWireValue() {
        // "__UNKNOWN__" must not collide with any real protocol event type string
        let knownRawValues = EventType.allCases
            .filter { $0 != .unknown }
            .map { $0.rawValue }
        XCTAssertFalse(knownRawValues.contains("__UNKNOWN__"))
    }

    func test_unknownEventType_isInAllCases() {
        XCTAssertTrue(EventType.allCases.contains(.unknown))
    }

    // MARK: - Feature: UnknownEvent.eventType returns .unknown

    func test_unknownEvent_eventTypeIsUnknown() {
        // Given
        let rawData = Data("{\"type\":\"SOME_FUTURE_TYPE\"}".utf8)
        let event = UnknownEvent(typeRaw: "SOME_FUTURE_TYPE", rawEvent: rawData)

        // Then — must return .unknown, NOT .raw
        XCTAssertEqual(event.eventType, .unknown)
    }

    func test_unknownEvent_eventTypeIsNotRaw() {
        // Explicit guard: consumers switching on .raw must not receive UnknownEvent
        let rawData = Data("{\"type\":\"SOME_FUTURE_TYPE\"}".utf8)
        let event = UnknownEvent(typeRaw: "SOME_FUTURE_TYPE", rawEvent: rawData)
        XCTAssertNotEqual(event.eventType, .raw)
    }

    // MARK: - Feature: Decoder distinguishes genuine RAW events from unknown events

    func test_unknownEvent_distinguishableFromRawEvent() throws {
        // Given: a truly unknown event type
        let data = jsonData("""
        {
          "type": "SOME_FUTURE_PROTOCOL_TYPE",
          "someField": "value"
        }
        """)
        let decoder = makeTolerantDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: must be UnknownEvent with .unknown, not confused with .raw
        guard let unknownEvent = event as? UnknownEvent else {
            return XCTFail("Expected UnknownEvent, got \(type(of: event))")
        }
        XCTAssertEqual(unknownEvent.eventType, .unknown)
        XCTAssertNotEqual(unknownEvent.eventType, .raw)
        XCTAssertEqual(unknownEvent.typeRaw, "SOME_FUTURE_PROTOCOL_TYPE")
    }

    // MARK: - Regression: Genuine RAW events must still decode as .raw

    func test_rawEvent_eventTypeIsRaw() throws {
        // Given: a legitimate RAW wire event
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: must still be a RawEvent with .raw eventType
        XCTAssertEqual(event.eventType, .raw)
        XCTAssertTrue(event is RawEvent)
    }

    func test_rawEvent_eventTypeIsNotUnknown() throws {
        // Explicit regression guard
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" }
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        XCTAssertNotEqual(event.eventType, .unknown)
    }
}
