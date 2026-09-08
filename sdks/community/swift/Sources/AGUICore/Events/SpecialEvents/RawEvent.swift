// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing raw, unprocessed event data.
///
/// This event type serves as a container for raw event data that doesn't fit into
/// any of the standard event types. The data is stored as-is without interpretation,
/// allowing applications to handle custom or unknown event structures.
///
/// Use this event type when:
/// - Receiving events that don't match any standard event types
/// - Implementing custom event handling logic
/// - Preserving raw event data for debugging or logging purposes
///
/// - SeeAlso: `CustomEvent`, `UnknownEvent`
public struct RawEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The raw event data as received.
    ///
    /// This contains the unprocessed event data in its original form as JSON.
    /// The structure can be any valid JSON value (object, array, primitive, or null).
    /// Corresponds to the `event` field in the AG-UI protocol wire format.
    ///
    /// To access the parsed data, use `parsedData()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let data: Data

    /// Optional source identifier for the raw event.
    ///
    /// Corresponds to the `source` field in the AG-UI protocol.
    public let source: String?

    /// Optional timestamp when the event was created.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.raw`).
    public var eventType: EventType { .raw }

    // MARK: - Initialization

    /// Creates a new `RawEvent`.
    ///
    /// - Parameters:
    ///   - data: The raw event data as JSON bytes (wire field: `event`)
    ///   - source: Optional source identifier (wire field: `source`)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        data: Data,
        source: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.data = data
        self.source = source
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the raw data JSON into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the data structure is
    /// unknown at compile time. It can return any valid JSON value (object,
    /// array, primitive, or null).
    ///
    /// For type-safe parsing when you know the data structure, use
    /// `parsedData(as:)` instead.
    ///
    /// - Returns: The parsed JSON object
    /// - Throws: An error if the data is not valid JSON
    public func parsedData() throws -> Any {
        try JSONSerialization.jsonObject(with: data, options: .allowFragments)
    }

    /// Parses the raw data JSON into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the data. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The type to decode the data as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the data cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct CustomData: Decodable {
    ///     let field1: String
    ///     let field2: Int
    /// }
    ///
    /// let data = try event.parsedData(as: CustomData.self)
    /// print("Field1: \(data.field1), Field2: \(data.field2)")
    /// ```
    public func parsedData<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: data)
    }
}

// MARK: - CustomStringConvertible
extension RawEvent: CustomStringConvertible {
    public var description: String {
        let dataSize = data.count
        return "RawEvent(data: \(dataSize) bytes, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension RawEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let dataPreview: String
        if let jsonString = String(data: data, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            dataPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            dataPreview = "\(data.count) bytes (invalid UTF-8)"
        }

        return """
        RawEvent {
            data: \(dataPreview)
            dataSize: \(data.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
