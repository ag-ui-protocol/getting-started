// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Protocol providing standard error handling tests for all event types.
///
/// Event test classes conforming to this protocol must implement required properties
/// describing their event type, then automatically inherit 6 standard error tests.
///
/// ## Usage
///
/// ```swift
/// final class RunStartedEventTests: XCTestCase,
///                                    AGUIEventDecoderTestHelpers,
///                                    EventDecodingErrorTests {
///
///     var validEventFieldsWithoutType: [String: Any] {
///         ["threadId": EventTestData.threadId, "runId": EventTestData.runId]
///     }
///
///     var eventTypeString: String { "RUN_STARTED" }
///     var expectedEventType: EventType { .runStarted }
///
///     // 6 error tests are automatically inherited!
/// }
/// ```
///
/// ## Benefits
///
/// - **Eliminates Duplication**: Removes 78+ duplicated error tests across 13 files
/// - **Consistency**: All event types test errors the same way
/// - **Maintainability**: Update error test logic once, applies everywhere
/// - **Scalability**: New event types get error tests automatically
protocol EventDecodingErrorTests: AGUIEventDecoderTestHelpers {

    /// Provides valid event fields (excluding the "type" field).
    ///
    /// Used to construct test cases for error scenarios. Should contain
    /// all required fields for this event type with valid values.
    ///
    /// Example:
    /// ```swift
    /// var validEventFieldsWithoutType: [String: Any] {
    ///     [
    ///         "threadId": EventTestData.threadId,
    ///         "runId": EventTestData.runId,
    ///         "messageId": EventTestData.messageId
    ///     ]
    /// }
    /// ```
    var validEventFieldsWithoutType: [String: Any] { get }

    /// The event type string as it appears in JSON (e.g., "RUN_STARTED").
    var eventTypeString: String { get }

    /// The expected EventType enum value (e.g., `.runStarted`).
    var expectedEventType: EventType { get }

    /// An unknown event type string for testing error handling.
    ///
    /// Should be semantically related to your event but not registered.
    /// For example, "RUN_PAUSED" for RUN_STARTED tests, or "TOOL_CALL_CANCELLED" for tool call events.
    ///
    /// Default implementation provides a generic unknown type.
    var unknownEventTypeString: String { get }
}

extension EventDecodingErrorTests {

    // MARK: - Default Implementation

    /// Default implementation provides a generic unknown event type.
    ///
    /// Override this property to provide a more semantically meaningful
    /// unknown type string for your specific event domain.
    var unknownEventTypeString: String {
        "UNKNOWN_EVENT_TYPE"
    }

    // MARK: - Standard Error Tests

    /// Tests that decoding fails with `.missingTypeField` when "type" field is absent.
    ///
    /// This validates that the decoder correctly identifies and reports
    /// when the required "type" field is missing from event JSON.
    func test_decodeMissingType_throwsMissingTypeField() throws {
        // Given
        let json = validEventFieldsWithoutType
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            XCTAssertEqual(error as? EventDecodingError,
                           .missingTypeField,
                           "Expected .missingTypeField error when 'type' field is missing")
        }
    }

    /// Tests that decoding an unknown type in strict mode throws `.unknownEventType`.
    ///
    /// This validates that the decoder in strict mode correctly rejects
    /// event types that are not recognized, throwing a specific error.
    func test_decodeUnknownType_inStrictMode_throwsUnknownEventType() throws {
        // Given
        var json = validEventFieldsWithoutType
        json["type"] = unknownEventTypeString
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .unknownEventType(let type) = error as? EventDecodingError else {
                return XCTFail("Expected .unknownEventType error, got \(error)")
            }
            XCTAssertEqual(type,
                           unknownEventTypeString,
                           "Error should report the unknown type string")
        }
    }

    /// Tests that decoding an unknown type in tolerant mode returns `UnknownEvent`.
    ///
    /// This validates that the decoder in tolerant mode gracefully handles
    /// unknown event types by returning an UnknownEvent instance rather than throwing.
    func test_decodeUnknownType_inTolerantMode_returnsUnknownEvent() throws {
        // Given
        var json = validEventFieldsWithoutType
        json["type"] = unknownEventTypeString
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        let decoder = makeTolerantDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let unknown = try XCTUnwrap(
            event as? UnknownEvent,
            "Tolerant decoder should return UnknownEvent for unknown types"
        )
        XCTAssertEqual(unknown.typeRaw,
                       unknownEventTypeString,
                       "UnknownEvent should preserve the original type string")
        XCTAssertEqual(unknown.rawEvent,
                       data,
                       "UnknownEvent should preserve the raw event data")
    }

    /// Tests that decoding a known type with no handler in strict mode throws `.unsupportedEventType`.
    ///
    /// This validates that the decoder correctly identifies when an event type
    /// is recognized but no handler is registered to decode it.
    func test_decodeKnownTypeButNoHandler_inStrictMode_throwsUnsupportedEventType() throws {
        // Given
        var json = validEventFieldsWithoutType
        json["type"] = eventTypeString
        let data = try JSONSerialization.data(withJSONObject: json, options: [])

        // Registry intentionally empty -> handler missing
        let decoder = makeStrictDecoder(registry: [:])

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            XCTAssertEqual(error as? EventDecodingError,
                           .unsupportedEventType(expectedEventType),
                           "Expected .unsupportedEventType error when handler is missing")
        }
    }

    /// Tests that decoding a known type with no handler in tolerant mode returns `UnknownEvent`.
    ///
    /// This validates that the decoder in tolerant mode gracefully handles
    /// missing handlers by returning an UnknownEvent instance.
    func test_decodeKnownTypeButNoHandler_inTolerantMode_returnsUnknownEvent() throws {
        // Given
        var json = validEventFieldsWithoutType
        json["type"] = eventTypeString
        let data = try JSONSerialization.data(withJSONObject: json, options: [])

        // Registry intentionally empty -> handler missing
        let decoder = makeTolerantDecoder(registry: [:])

        // When
        let event = try decoder.decode(data)

        // Then
        let unknown = try XCTUnwrap(
            event as? UnknownEvent,
            "Tolerant decoder should return UnknownEvent when handler is missing"
        )
        XCTAssertEqual(unknown.typeRaw,
                       eventTypeString,
                       "UnknownEvent should preserve the event type string")
        XCTAssertEqual(unknown.rawEvent,
                       data,
                       "UnknownEvent should preserve the raw event data")
    }

    /// Tests that invalid JSON throws `.invalidJSON`.
    ///
    /// This validates that the decoder correctly identifies and reports
    /// malformed JSON that cannot be parsed.
    func test_decodeInvalidJSON_throwsInvalidJSON() {
        // Given
        let data = Data("invalid json".utf8)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            XCTAssertEqual(error as? EventDecodingError,
                           .invalidJSON,
                           "Expected .invalidJSON error when JSON is malformed")
        }
    }
}
