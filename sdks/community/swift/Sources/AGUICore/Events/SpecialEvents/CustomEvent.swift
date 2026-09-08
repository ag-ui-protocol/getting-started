// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event for custom, application-specific event types.
///
/// This event type allows applications to define and use custom event types
/// beyond the standard AG-UI protocol events. Each custom event has a unique
/// type identifier and arbitrary JSON data payload.
///
/// Use this event type when:
/// - Implementing application-specific events not covered by the standard protocol
/// - Extending the protocol with custom behavior
/// - Handling domain-specific events (e.g., "com.example.analytics.pageView")
///
/// Custom event type identifiers typically follow reverse-domain notation
/// (e.g., "com.myapp.analytics.pageView", "org.example.userAction.buttonClick")
/// to ensure uniqueness across applications.
///
/// - SeeAlso: `RawEvent`, `UnknownEvent`
public struct CustomEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The custom event name, matching the AG-UI protocol `name` wire field.
    ///
    /// This string uniquely identifies the type of custom event. It's recommended
    /// to use reverse-domain notation for globally unique identifiers.
    ///
    /// Examples:
    /// - "com.example.userAction"
    /// - "org.myapp.analytics.pageView"
    /// - "simple.message"
    public let name: String

    /// The custom event payload as raw JSON, matching the AG-UI protocol `value` wire field.
    ///
    /// This contains the event-specific payload in JSON format. The structure
    /// is determined by the custom event type and can be any valid JSON value
    /// (object, array, primitive, or null).
    ///
    /// To access the parsed payload, use `parsedData()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let value: Data

    /// Optional timestamp when the event was created.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.custom`).
    public var eventType: EventType { .custom }

    // MARK: - Initialization

    /// Creates a new `CustomEvent`.
    ///
    /// - Parameters:
    ///   - name: The custom event name (e.g., "com.example.userAction"), matching the AG-UI `name` wire field
    ///   - value: The custom event payload as JSON bytes, matching the AG-UI `value` wire field
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        name: String,
        value: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.name = name
        self.value = value
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the custom data JSON into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the data structure is
    /// custom and unknown at compile time. It can return any valid JSON value
    /// (object, array, primitive, or null).
    ///
    /// For type-safe parsing when you know the data structure, use
    /// `parsedData(as:)` instead.
    ///
    /// - Returns: The parsed JSON object
    /// - Throws: An error if the data is not valid JSON
    public func parsedData() throws -> Any {
        try JSONSerialization.jsonObject(with: value, options: .allowFragments)
    }

    /// Parses the custom data JSON into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the custom data. Use this when you have a specific
    /// type that conforms to `Decodable` for your custom event.
    ///
    /// - Parameter type: The type to decode the data as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the data cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct UserActionPayload: Decodable {
    ///     let action: String
    ///     let userId: Int
    /// }
    ///
    /// let payload = try event.parsedData(as: UserActionPayload.self)
    /// print("User \(payload.userId) performed: \(payload.action)")
    /// ```
    public func parsedData<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: value)
    }
}

// MARK: - CustomStringConvertible
extension CustomEvent: CustomStringConvertible {
    public var description: String {
        let valueSize = value.count
        let timestampDesc = timestamp?.description ?? "nil"
        return "CustomEvent(name: \"\(name)\", value: \(valueSize) bytes, timestamp: \(timestampDesc))"
    }
}

// MARK: - CustomDebugStringConvertible
extension CustomEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let valuePreview: String
        if let jsonString = String(data: value, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            valuePreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            valuePreview = "\(value.count) bytes (invalid UTF-8)"
        }

        return """
        CustomEvent {
            name: "\(name)"
            value: \(valuePreview)
            valueSize: \(value.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
