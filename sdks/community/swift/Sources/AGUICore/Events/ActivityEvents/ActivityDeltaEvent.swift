// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a JSON Patch delta for an activity message.
///
/// This event provides incremental updates to activity content using
/// RFC 6902 JSON Patch format. It allows efficient updates to structured
/// activity content without sending the full content each time.
///
/// - SeeAlso: `ActivitySnapshotEvent`, `StateDeltaEvent`
/// - SeeAlso: [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
public struct ActivityDeltaEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The identifier for the activity message to update.
    ///
    /// This ID associates this delta with a specific activity instance that
    /// was previously created via `ActivitySnapshotEvent`.
    public let messageId: String

    /// The type of activity (e.g., "a2ui-surface").
    ///
    /// This must match the activity type of the original snapshot.
    public let activityType: String

    /// The JSON Patch operations as raw JSON data.
    ///
    /// This contains an array of JSON Patch operations serialized as JSON.
    /// Each operation follows the RFC 6902 format with fields like `op`, `path`,
    /// `value`, `from`, etc.
    ///
    /// To access the parsed operations, use `parsedPatch()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let patch: Data

    /// Optional timestamp when the delta was created.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.activityDelta`).
    public var eventType: EventType { .activityDelta }

    // MARK: - Initialization

    /// Creates a new `ActivityDeltaEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The identifier for the activity message to update
    ///   - activityType: The type of activity (e.g., "a2ui-surface")
    ///   - patch: The JSON Patch operations as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        activityType: String,
        patch: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.activityType = activityType
        self.patch = patch
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the patch JSON data into a Swift array of patch operations.
    ///
    /// This method uses `JSONSerialization` to parse the patch as an array of
    /// JSON Patch operations. Each operation is typically a dictionary with fields
    /// like `op`, `path`, `value`, `from`, etc.
    ///
    /// For type-safe parsing when you know the structure, use `parsedPatch(as:)` instead.
    ///
    /// - Returns: An array of patch operations (typically `[[String: Any]]`)
    /// - Throws: An error if the patch data is not valid JSON or not an array
    public func parsedPatch() throws -> [Any] {
        let parsed = try JSONSerialization.jsonObject(with: patch, options: [])
        guard let array = parsed as? [Any] else {
            throw DecodingError.typeMismatch(
                [Any].self,
                DecodingError.Context(codingPath: [], debugDescription: "Patch must be a JSON array")
            )
        }
        return array
    }

    /// Parses the patch JSON data into a strongly-typed Swift array.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// structure of the JSON Patch operations. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The element type to decode the patch array as (must conform to `Decodable`)
    /// - Returns: An array of decoded instances of the specified type
    /// - Throws: A `DecodingError` if the patch cannot be decoded as the specified type
    public func parsedPatch<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> [T] {
        try decoder.decode([T].self, from: patch)
    }
}

// MARK: - CustomStringConvertible
extension ActivityDeltaEvent: CustomStringConvertible {
    public var description: String {
        let patchSize = patch.count
        return "ActivityDeltaEvent(messageId: \(messageId), activityType: \(activityType), " +
               "patch: \(patchSize) bytes, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ActivityDeltaEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let patchPreview: String
        if let jsonString = String(data: patch, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            patchPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            patchPreview = "\(patch.count) bytes (invalid UTF-8)"
        }

        return """
        ActivityDeltaEvent {
            messageId: "\(messageId)"
            activityType: "\(activityType)"
            patch: \(patchPreview)
            patchSize: \(patch.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
