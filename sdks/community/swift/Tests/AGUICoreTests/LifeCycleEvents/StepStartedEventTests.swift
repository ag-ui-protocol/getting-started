// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class StepStartedEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        ["stepName": "reasoning"]
    }

    var eventTypeString: String { "STEP_STARTED" }
    var expectedEventType: EventType { .stepStarted }
    var unknownEventTypeString: String { "STEP_PAUSED" }

    // MARK: - Feature: Decode STEP_STARTED

    func test_decodeValidStepStarted_returnsStepStartedEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "reasoning"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let stepStarted = event as? StepStartedEvent else {
            return XCTFail("Expected StepStartedEvent, got \(type(of: event))")
        }
        XCTAssertEqual(stepStarted.eventType, .stepStarted)
        XCTAssertEqual(stepStarted.stepName, "reasoning")
        XCTAssertNil(stepStarted.timestamp)
    }

    func test_decodeStepStarted_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "reasoning",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepStarted = try XCTUnwrap(event as? StepStartedEvent)
        XCTAssertEqual(stepStarted.timestamp, EventTestData.timestamp)
    }

    func test_decodeStepStarted_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "reasoning",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepStarted = try XCTUnwrap(event as? StepStartedEvent)
        XCTAssertEqual(stepStarted.rawEvent, data)
    }

    func test_decodeStepStarted_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "reasoning",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepStarted = try XCTUnwrap(event as? StepStartedEvent)
        XCTAssertEqual(stepStarted.stepName, "reasoning")
    }

    func test_decodeStepStarted_withUnicodeStepName_handlesUnicode() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "推理-🚀-测试"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepStarted = try XCTUnwrap(event as? StepStartedEvent)
        XCTAssertEqual(stepStarted.stepName, "推理-🚀-测试")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeStepStarted_missingStepName_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("stepName"), "Expected message to mention 'stepName'. Got: \(message)")
        }
    }

    func test_decodeStepStarted_stepNameWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.lowercased().contains("type mismatch") || message.contains("Type mismatch"),
                          "Expected a type mismatch message. Got: \(message)")
        }
    }

    func test_decodeStepStarted_timestampWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_STARTED",
          "stepName": "reasoning",
          "timestamp": "invalid"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.lowercased().contains("type mismatch") || message.contains("Type mismatch"),
                          "Expected a type mismatch message. Got: \(message)")
        }
    }

    // MARK: - Feature: Model behaviors

    func test_stepStartedEvent_eventTypeIsAlwaysStepStarted() {
        // Given
        let event = StepStartedEvent(stepName: "reasoning", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .stepStarted)
    }

    func test_stepStartedEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = StepStartedEvent(stepName: "reasoning", timestamp: 1, rawEvent: nil)
        let event2 = StepStartedEvent(stepName: "reasoning", timestamp: 1, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_stepStartedEvent_withEmptyStepName_isValid() {
        // Given
        let event = StepStartedEvent(stepName: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.stepName, "")
        XCTAssertEqual(event.eventType, .stepStarted)
    }
}
