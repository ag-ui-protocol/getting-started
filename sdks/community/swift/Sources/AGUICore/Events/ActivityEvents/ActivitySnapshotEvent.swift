// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a snapshot of an activity message.
///
/// Activity events are used for streaming structured content that doesn't fit
/// the standard text/tool paradigm, such as A2UI surfaces. The content field
/// contains activity-type-specific data.
///
/// - SeeAlso: `ActivityDeltaEvent`
public struct ActivitySnapshotEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The identifier for this activity message.
    ///
    /// This ID is used to associate delta updates with this specific activity instance.
    public let messageId: String

    /// The type of activity (e.g., "a2ui-surface").
    ///
    /// This identifies the specific activity type and determines how the content
    /// should be interpreted and rendered.
    public let activityType: String

    /// The activity-specific content as raw JSON data.
    ///
    /// This contains the activity content serialized as JSON. The structure
    /// of the content is activity-type-specific and can be any valid JSON value.
    ///
    /// To access the parsed content, use `parsedContent()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let content: Data

    /// Whether this snapshot should replace existing content (default: `true`).
    ///
    /// When `true`, this snapshot replaces any previous content for this activity.
    /// When `false`, this snapshot is merged with or appended to existing content.
    public let replace: Bool

    /// Optional timestamp when the snapshot was created.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.activitySnapshot`).
    public var eventType: EventType { .activitySnapshot }

    // MARK: - Initialization

    /// Creates a new `ActivitySnapshotEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The identifier for this activity message
    ///   - activityType: The type of activity (e.g., "a2ui-surface")
    ///   - content: The activity-specific content as raw JSON data
    ///   - replace: Whether this snapshot should replace existing content (default: `true`)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        activityType: String,
        content: Data,
        replace: Bool = true,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.activityType = activityType
        self.content = content
        self.replace = replace
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the content JSON data into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the content structure is
    /// activity-type-specific and unknown at compile time. It can return any
    /// valid JSON value (dictionary, array, primitive, or null).
    ///
    /// For type-safe parsing when you know the content structure, use
    /// `parsedContent(as:)` instead.
    ///
    /// - Returns: The parsed JSON object (can be a dictionary, array, or primitive value)
    /// - Throws: An error if the content data is not valid JSON
    public func parsedContent() throws -> Any {
        try JSONSerialization.jsonObject(with: content, options: .allowFragments)
    }

    /// Parses the content JSON data into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the content. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The type to decode the content as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the content cannot be decoded as the specified type
    public func parsedContent<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: content)
    }
}

// MARK: - CustomStringConvertible
extension ActivitySnapshotEvent: CustomStringConvertible {
    public var description: String {
        let contentSize = content.count
        return "ActivitySnapshotEvent(messageId: \(messageId), activityType: \(activityType), " +
               "content: \(contentSize) bytes, replace: \(replace), " +
               "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ActivitySnapshotEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let contentPreview: String
        if let jsonString = String(data: content, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            contentPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            contentPreview = "\(content.count) bytes (invalid UTF-8)"
        }

        return """
        ActivitySnapshotEvent {
            messageId: "\(messageId)"
            activityType: "\(activityType)"
            content: \(contentPreview)
            contentSize: \(content.count) bytes
            replace: \(replace)
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
