// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing incremental state updates using JSON Patch format (RFC 6902).
///
/// This event provides bandwidth-efficient state updates by sending only the changes
/// (delta) rather than the complete state. The delta is an array of JSON Patch operations
/// that can be applied to the current state to produce the new state.
///
/// JSON Patch operations include: `add`, `remove`, `replace`, `move`, `copy`, and `test`.
///
/// - SeeAlso: `StateSnapshotEvent`, `MessagesSnapshotEvent`
/// - SeeAlso: [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
public struct StateDeltaEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The JSON Patch operations as raw JSON data.
    ///
    /// This contains an array of JSON Patch operations serialized as JSON. Each operation
    /// follows the RFC 6902 format with fields like `op`, `path`, `value`, `from`, etc.
    ///
    /// To access the parsed operations, use `parsedDelta()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let delta: Data

    /// Optional timestamp when the state delta was captured.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.stateDelta`).
    public var eventType: EventType { .stateDelta }

    // MARK: - Initialization

    /// Creates a new `StateDeltaEvent`.
    ///
    /// - Parameters:
    ///   - delta: The JSON Patch operations as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        delta: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the delta JSON data into a Swift array of patch operations.
    ///
    /// This method uses `JSONSerialization` to parse the delta as an array of
    /// JSON Patch operations. Each operation is typically a dictionary with fields
    /// like `op`, `path`, `value`, `from`, etc.
    ///
    /// For type-safe parsing when you know the structure, use `parsedDelta(as:)` instead.
    ///
    /// - Returns: An array of patch operations (typically `[[String: Any]]`)
    /// - Throws: An error if the delta data is not valid JSON or not an array
    public func parsedDelta() throws -> [Any] {
        let parsed = try JSONSerialization.jsonObject(with: delta, options: [])
        guard let array = parsed as? [Any] else {
            throw DecodingError.typeMismatch(
                [Any].self,
                DecodingError.Context(codingPath: [], debugDescription: "Delta must be a JSON array")
            )
        }
        return array
    }

    /// Parses the delta JSON data into a strongly-typed Swift array.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// structure of the JSON Patch operations. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The element type to decode the delta array as (must conform to `Decodable`)
    /// - Returns: An array of decoded instances of the specified type
    /// - Throws: A `DecodingError` if the delta cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct PatchOperation: Decodable {
    ///     let op: String
    ///     let path: String
    ///     let value: AnyCodable?
    /// }
    ///
    /// let operations = try event.parsedDelta(as: PatchOperation.self)
    /// ```
    public func parsedDelta<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> [T] {
        try decoder.decode([T].self, from: delta)
    }
}

// MARK: - CustomStringConvertible
extension StateDeltaEvent: CustomStringConvertible {
    public var description: String {
        let deltaSize = delta.count
        return "StateDeltaEvent(delta: \(deltaSize) bytes, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension StateDeltaEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let deltaPreview: String
        if let jsonString = String(data: delta, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            deltaPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            deltaPreview = "\(delta.count) bytes (invalid UTF-8)"
        }

        return """
        StateDeltaEvent {
            delta: \(deltaPreview)
            deltaSize: \(delta.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
