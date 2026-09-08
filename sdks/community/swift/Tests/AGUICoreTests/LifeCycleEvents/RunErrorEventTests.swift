// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class RunErrorEventTests: XCTestCase,
                                 AGUIEventDecoderTestHelpers,
                                 EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    // Per AG-UI protocol, RUN_ERROR only requires `message`. No threadId/runId.
    var validEventFieldsWithoutType: [String: Any] {
        ["message": "An error occurred"]
    }

    var eventTypeString: String { "RUN_ERROR" }
    var expectedEventType: EventType { .runError }
    var unknownEventTypeString: String { "RUN_CANCELLED" }

    // MARK: - Feature: Decode RUN_ERROR

    func test_decodeValidRunError_returnsRunErrorEvent() throws {
        // Given — protocol-conformant flat structure
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "message": "An error occurred",
          "code": "ERROR_CODE"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let runError = event as? RunErrorEvent else {
            return XCTFail("Expected RunErrorEvent, got \(type(of: event))")
        }
        XCTAssertEqual(runError.eventType, .runError)
        XCTAssertEqual(runError.message, "An error occurred")
        XCTAssertEqual(runError.code, "ERROR_CODE")
        XCTAssertNil(runError.timestamp)
    }

    func test_decodeRunError_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "message": "An error occurred",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.timestamp, EventTestData.timestamp)
    }

    func test_decodeRunError_withoutCode_codeIsNil() throws {
        // Given — code is optional per protocol
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "message": "Something went wrong"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.message, "Something went wrong")
        XCTAssertNil(runError.code)
    }

    func test_decodeRunError_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "message": "An error occurred",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.rawEvent, data)
    }

    func test_decodeRunError_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "message": "An error occurred",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.message, "An error occurred")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeRunError_missingMessage_throwsDecodingFailed() {
        // Given — message is required per protocol
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "code": "ERROR_CODE"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("message"), "Expected error to mention 'message'. Got: \(message)")
        }
    }

    // MARK: - Feature: Model behaviors

    func test_runErrorEvent_eventTypeIsAlwaysRunError() {
        let event = RunErrorEvent(message: "Something failed", code: "CODE")
        XCTAssertEqual(event.eventType, .runError)
    }

    func test_runErrorEvent_equatable_sameFields_areEqual() {
        let event1 = RunErrorEvent(message: "Error", code: "CODE", timestamp: 1)
        let event2 = RunErrorEvent(message: "Error", code: "CODE", timestamp: 1)
        XCTAssertEqual(event1, event2)
    }

    func test_runErrorEvent_equatable_differentMessage_areNotEqual() {
        let event1 = RunErrorEvent(message: "Error A", code: "CODE")
        let event2 = RunErrorEvent(message: "Error B", code: "CODE")
        XCTAssertNotEqual(event1, event2)
    }
}
