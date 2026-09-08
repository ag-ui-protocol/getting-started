// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating the end of a streaming reasoning message.
///
/// This event marks the completion of a reasoning message within a reasoning phase.
/// It is the replacement for the deprecated ``ThinkingTextMessageEndEvent``.
///
/// - SeeAlso: ``ReasoningMessageStartEvent``, ``ReasoningMessageContentEvent``
public struct ReasoningMessageEndEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier of the reasoning message that has ended.
    public let messageId: String

    /// Optional timestamp when the reasoning message generation finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningMessageEnd`).
    public var eventType: EventType { .reasoningMessageEnd }

    // MARK: - Initialization

    /// Creates a new `ReasoningMessageEndEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier of the reasoning message that ended
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
extension ReasoningMessageEndEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningMessageEndEvent(messageId: \"\(messageId)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningMessageEndEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningMessageEndEvent {
            messageId: "\(messageId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
