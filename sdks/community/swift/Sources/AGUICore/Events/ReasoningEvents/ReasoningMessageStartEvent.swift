// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating the start of a streaming reasoning message.
///
/// This event marks the beginning of a reasoning message within a reasoning phase.
/// The `role` field will always be `"reasoning"`. It is the replacement for the
/// deprecated ``ThinkingTextMessageStartEvent``.
///
/// - SeeAlso: ``ReasoningMessageContentEvent``, ``ReasoningMessageEndEvent``
public struct ReasoningMessageStartEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier of the reasoning message.
    public let messageId: String

    /// The role of this message. Always `"reasoning"`.
    public let role: String

    /// Optional timestamp when the reasoning message generation started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningMessageStart`).
    public var eventType: EventType { .reasoningMessageStart }

    // MARK: - Initialization

    /// Creates a new `ReasoningMessageStartEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier of the reasoning message
    ///   - role: The message role (always `"reasoning"`)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        role: String = "reasoning",
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.role = role
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ReasoningMessageStartEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningMessageStartEvent(messageId: \"\(messageId)\", role: \"\(role)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningMessageStartEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningMessageStartEvent {
            messageId: "\(messageId)"
            role: "\(role)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
