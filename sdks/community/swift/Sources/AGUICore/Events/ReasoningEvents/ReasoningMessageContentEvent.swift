// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a streaming chunk of reasoning message content.
///
/// This event delivers an incremental piece of reasoning text during a reasoning
/// message's lifecycle. It is the replacement for the deprecated
/// ``ThinkingTextMessageContentEvent``.
///
/// - SeeAlso: ``ReasoningMessageStartEvent``, ``ReasoningMessageEndEvent``
public struct ReasoningMessageContentEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier of the reasoning message this content belongs to.
    public let messageId: String

    /// The incremental reasoning text chunk.
    ///
    /// Must be non-empty.
    public let delta: String

    /// Optional timestamp when this content chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningMessageContent`).
    public var eventType: EventType { .reasoningMessageContent }

    // MARK: - Initialization

    /// Creates a new `ReasoningMessageContentEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier of the reasoning message
    ///   - delta: The incremental reasoning text chunk (non-empty)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        delta: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ReasoningMessageContentEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningMessageContentEvent(messageId: \"\(messageId)\", delta: \"\(delta)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningMessageContentEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningMessageContentEvent {
            messageId: "\(messageId)"
            delta: "\(delta)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
