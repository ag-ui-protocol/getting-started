// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class StepFinishedEventTests: XCTestCase,
                                     AGUIEventDecoderTestHelpers,
                                     EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        ["stepName": "reasoning"]
    }

    var eventTypeString: String { "STEP_FINISHED" }
    var expectedEventType: EventType { .stepFinished }
    var unknownEventTypeString: String { "STEP_CANCELLED" }

    // MARK: - Feature: Decode STEP_FINISHED

    func test_decodeValidStepFinished_returnsStepFinishedEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
          "stepName": "reasoning"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let stepFinished = event as? StepFinishedEvent else {
            return XCTFail("Expected StepFinishedEvent, got \(type(of: event))")
        }
        XCTAssertEqual(stepFinished.eventType, .stepFinished)
        XCTAssertEqual(stepFinished.stepName, "reasoning")
        XCTAssertNil(stepFinished.timestamp)
    }

    func test_decodeStepFinished_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
          "stepName": "reasoning",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepFinished = try XCTUnwrap(event as? StepFinishedEvent)
        XCTAssertEqual(stepFinished.timestamp, EventTestData.timestamp)
    }

    func test_decodeStepFinished_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
          "stepName": "reasoning",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepFinished = try XCTUnwrap(event as? StepFinishedEvent)
        XCTAssertEqual(stepFinished.rawEvent, data)
    }

    func test_decodeStepFinished_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
          "stepName": "reasoning",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepFinished = try XCTUnwrap(event as? StepFinishedEvent)
        XCTAssertEqual(stepFinished.stepName, "reasoning")
    }

    func test_decodeStepFinished_withUnicodeStepName_handlesUnicode() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
          "stepName": "推理-🚀-测试"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stepFinished = try XCTUnwrap(event as? StepFinishedEvent)
        XCTAssertEqual(stepFinished.stepName, "推理-🚀-测试")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeStepFinished_missingStepName_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED"
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

    func test_decodeStepFinished_stepNameWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
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

    func test_decodeStepFinished_timestampWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STEP_FINISHED",
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

    func test_stepFinishedEvent_eventTypeIsAlwaysStepFinished() {
        // Given
        let event = StepFinishedEvent(stepName: "reasoning", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .stepFinished)
    }

    func test_stepFinishedEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = StepFinishedEvent(stepName: "reasoning", timestamp: 1, rawEvent: nil)
        let event2 = StepFinishedEvent(stepName: "reasoning", timestamp: 1, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_stepFinishedEvent_withEmptyStepName_isValid() {
        // Given
        let event = StepFinishedEvent(stepName: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.stepName, "")
        XCTAssertEqual(event.eventType, .stepFinished)
    }
}
