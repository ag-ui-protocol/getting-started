// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Protocol providing shared decoder creation helpers for event tests.
///
/// Conforming test classes automatically gain access to standardized
/// decoder factory methods, ensuring consistency across all event tests.
///
/// ## Usage
///
/// Add this protocol to your test class:
/// ```swift
/// final class MyEventTests: XCTestCase, AGUIEventDecoderTestHelpers {
///     func test_decodeEvent() {
///         let decoder = makeStrictDecoder()
///         let data = jsonData("""{"type": "MY_EVENT"}""")
///         // ...
///     }
/// }
/// ```
///
/// ## Benefits
///
/// - **Single Source of Truth**: All decoder configuration in one place
/// - **Consistent Behavior**: All tests use identical decoder setup
/// - **Easy Maintenance**: Update once, applies to all conforming tests
/// - **No Duplication**: Eliminates 39+ duplicated helper methods
protocol AGUIEventDecoderTestHelpers: XCTestCase {
    // Protocol requires no implementation - all methods have default implementations
}

extension AGUIEventDecoderTestHelpers {

    /// Creates a decoder in strict mode (throws errors for unknown events).
    ///
    /// Strict mode is appropriate for tests that expect specific event types
    /// and should fail on unexpected or unknown events.
    ///
    /// - Parameter registry: Optional custom registry. Defaults to full default registry.
    ///                      Pass an empty registry `[:]` to test missing handler scenarios.
    /// - Returns: AGUIEventDecoder configured for strict mode
    ///
    /// ## Example
    /// ```swift
    /// // Standard usage
    /// let decoder = makeStrictDecoder()
    ///
    /// // Test missing handler
    /// let emptyDecoder = makeStrictDecoder(registry: [:])
    /// ```
    func makeStrictDecoder(
        registry: [EventType: AGUIEventDecoder.DecodeHandler]? = nil
    ) -> AGUIEventDecoder {
        var config = AGUIEventDecoder.Configuration()
        config.unknownEventStrategy = .throwError
        return AGUIEventDecoder(
            config: config,
            makeDecoder: { JSONDecoder() },
            registry: registry ?? AGUIEventDecoder.defaultRegistry()
        )
    }

    /// Creates a decoder in tolerant mode (returns UnknownEvent for unknown types).
    ///
    /// Tolerant mode is appropriate for tests that need to handle unknown or
    /// future event types gracefully without throwing errors.
    ///
    /// - Parameter registry: Optional custom registry. Defaults to full default registry.
    ///                      Pass an empty registry `[:]` to test unknown event handling.
    /// - Returns: AGUIEventDecoder configured for tolerant mode
    ///
    /// ## Example
    /// ```swift
    /// let decoder = makeTolerantDecoder()
    /// let event = try decoder.decode(unknownEventData)
    /// XCTAssertTrue(event is UnknownEvent)
    /// ```
    func makeTolerantDecoder(
        registry: [EventType: AGUIEventDecoder.DecodeHandler]? = nil
    ) -> AGUIEventDecoder {
        var config = AGUIEventDecoder.Configuration()
        config.unknownEventStrategy = .returnUnknown
        return AGUIEventDecoder(
            config: config,
            makeDecoder: { JSONDecoder() },
            registry: registry ?? AGUIEventDecoder.defaultRegistry()
        )
    }

    /// Converts a JSON string to Data for testing.
    ///
    /// This is a convenience method to reduce boilerplate in test methods.
    /// The JSON string is converted using UTF-8 encoding.
    ///
    /// - Parameter json: JSON string to convert
    /// - Returns: Data representation of the JSON string
    ///
    /// ## Example
    /// ```swift
    /// let data = jsonData("""
    /// {
    ///   "type": "RUN_STARTED",
    ///   "threadId": "thread-123"
    /// }
    /// """)
    /// ```
    func jsonData(_ json: String) -> Data {
        Data(json.utf8)
    }
}
