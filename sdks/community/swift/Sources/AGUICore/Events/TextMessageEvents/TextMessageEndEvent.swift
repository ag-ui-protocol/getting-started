// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that text message generation has completed.
///
/// This event is emitted when an agent finishes generating a text message response.
/// It signals the end of the message generation process and is associated with
/// the message via the `messageId` field, which matches the ID from the
/// corresponding `TextMessageStartEvent`.
///
/// - SeeAlso: `TextMessageStartEvent`, `TextMessageContentEvent`, `TextMessageChunkEvent`
public struct TextMessageEndEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this message.
    ///
    /// This ID matches the `messageId` from the corresponding `TextMessageStartEvent`
    /// and is used to associate this end event with the correct message.
    public let messageId: String

    /// Optional timestamp when the message generation finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.textMessageEnd`).
    public var eventType: EventType { .textMessageEnd }

    // MARK: - Initialization

    /// Creates a new `TextMessageEndEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier for this message (matches TextMessageStartEvent)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension TextMessageEndEvent: CustomStringConvertible {
    public var description: String {
        "TextMessageEndEvent(messageId: \(messageId), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension TextMessageEndEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        TextMessageEndEvent {
            messageId: "\(messageId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
