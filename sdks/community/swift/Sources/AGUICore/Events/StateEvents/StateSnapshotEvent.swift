// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a complete snapshot of the application state.
///
/// This event provides a full state snapshot that can be used to initialize
/// or reset the application state. The snapshot is stored as raw JSON data
/// to preserve its exact structure and allow for flexible state schemas.
///
/// - SeeAlso: `StateDeltaEvent`, `MessagesSnapshotEvent`
public struct StateSnapshotEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The complete state snapshot as raw JSON data.
    ///
    /// This contains the full state object serialized as JSON. The structure
    /// of the state is application-specific and can be any valid JSON value
    /// (object, array, primitive, etc.).
    ///
    /// To access the parsed state, use `parsedSnapshot()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let snapshot: Data

    /// Optional timestamp when the state snapshot was captured.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.stateSnapshot`).
    public var eventType: EventType { .stateSnapshot }

    // MARK: - Initialization

    /// Creates a new `StateSnapshotEvent`.
    ///
    /// - Parameters:
    ///   - snapshot: The complete state snapshot as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        snapshot: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.snapshot = snapshot
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the snapshot JSON data into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the snapshot structure is
    /// application-specific and unknown at compile time. It can return any
    /// valid JSON value (dictionary, array, primitive, or null).
    ///
    /// For type-safe parsing when you know the snapshot structure, use
    /// `parsedSnapshot(as:)` instead.
    ///
    /// - Returns: The parsed JSON object (can be a dictionary, array, or primitive value)
    /// - Throws: An error if the snapshot data is not valid JSON
    public func parsedSnapshot() throws -> Any {
        try JSONSerialization.jsonObject(with: snapshot, options: .allowFragments)
    }

    /// Parses the snapshot JSON data into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the snapshot. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The type to decode the snapshot as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the snapshot cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct AppState: Decodable {
    ///     let users: [String]
    ///     let count: Int
    /// }
    ///
    /// let state = try event.parsedSnapshot(as: AppState.self)
    /// print(state.users)
    /// ```
    public func parsedSnapshot<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: snapshot)
    }
}

// MARK: - CustomStringConvertible
extension StateSnapshotEvent: CustomStringConvertible {
    public var description: String {
        let snapshotSize = snapshot.count
        return "StateSnapshotEvent(snapshot: \(snapshotSize) bytes, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension StateSnapshotEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let snapshotPreview: String
        if let jsonString = String(data: snapshot, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            snapshotPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            snapshotPreview = "\(snapshot.count) bytes (invalid UTF-8)"
        }

        return """
        StateSnapshotEvent {
            snapshot: \(snapshotPreview)
            snapshotSize: \(snapshot.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
