// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event marking the end of a reasoning phase.
///
/// This event signals that the agent has completed its internal reasoning process
/// for the message identified by `messageId`. It is the replacement for the
/// deprecated ``ThinkingEndEvent``.
///
/// - SeeAlso: ``ReasoningStartEvent``, ``ReasoningMessageEndEvent``
public struct ReasoningEndEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier of the message whose reasoning phase has ended.
    public let messageId: String

    /// Optional timestamp when the reasoning ended.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningEnd`).
    public var eventType: EventType { .reasoningEnd }

    // MARK: - Initialization

    /// Creates a new `ReasoningEndEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The identifier of the message whose reasoning phase ended
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
extension ReasoningEndEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningEndEvent(messageId: \"\(messageId)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningEndEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningEndEvent {
            messageId: "\(messageId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
