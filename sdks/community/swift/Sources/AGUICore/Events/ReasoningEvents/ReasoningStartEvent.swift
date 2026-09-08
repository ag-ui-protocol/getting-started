// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event marking the start of a reasoning phase.
///
/// This event signals that the agent has begun its internal reasoning process
/// for the message identified by `messageId`. It is the replacement for the
/// deprecated ``ThinkingStartEvent``.
///
/// - SeeAlso: ``ReasoningEndEvent``, ``ReasoningMessageStartEvent``
public struct ReasoningStartEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier of the message this reasoning phase is associated with.
    public let messageId: String

    /// Optional timestamp when the reasoning started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningStart`).
    public var eventType: EventType { .reasoningStart }

    // MARK: - Initialization

    /// Creates a new `ReasoningStartEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The identifier of the message this reasoning is associated with
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
extension ReasoningStartEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningStartEvent(messageId: \"\(messageId)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningStartEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningStartEvent {
            messageId: "\(messageId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
