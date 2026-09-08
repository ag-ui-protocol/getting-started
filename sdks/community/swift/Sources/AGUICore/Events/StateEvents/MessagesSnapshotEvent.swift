// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a complete snapshot of the conversation messages.
///
/// This event provides a full messages snapshot containing the entire conversation
/// history at a point in time. Messages are decoded at receive time into strongly-typed
/// `Message` values, so callers can use them directly without further parsing.
///
/// - SeeAlso: `StateSnapshotEvent`, `StateDeltaEvent`
public struct MessagesSnapshotEvent: AGUIEvent, Sendable {

    // MARK: - Properties

    /// The decoded conversation messages.
    ///
    /// Messages are decoded during event parsing using `MessageDecoder`, providing
    /// type-safe access without requiring callers to parse raw JSON.
    public let messages: [any Message]

    /// Optional timestamp when the messages snapshot was captured.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.messagesSnapshot`).
    public var eventType: EventType { .messagesSnapshot }

    // MARK: - Initialization

    /// Creates a new `MessagesSnapshotEvent`.
    ///
    /// - Parameters:
    ///   - messages: The decoded conversation messages
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messages: [any Message],
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messages = messages
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension MessagesSnapshotEvent: CustomStringConvertible {
    public var description: String {
        "MessagesSnapshotEvent(messages: \(messages.count) messages, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension MessagesSnapshotEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let preview = messages.prefix(3).map { "\($0.role.rawValue):\($0.id)" }.joined(separator: ", ")
        let suffix = messages.count > 3 ? ", …" : ""
        return """
        MessagesSnapshotEvent {
            messages: [\(preview)\(suffix)] (\(messages.count) total)
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
