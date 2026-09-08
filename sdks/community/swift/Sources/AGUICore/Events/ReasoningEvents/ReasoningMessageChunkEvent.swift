// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A convenience event that streams a chunk of reasoning message data.
///
/// `ReasoningMessageChunkEvent` is a combined event that can carry both a `messageId`
/// and a `delta`, enabling servers to stream reasoning content without emitting separate
/// start/content/end events. Both fields are optional; at least one should be non-nil
/// for the event to be meaningful.
///
/// - SeeAlso: ``ReasoningMessageStartEvent``, ``ReasoningMessageContentEvent``, ``ReasoningMessageEndEvent``
public struct ReasoningMessageChunkEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The optional identifier of the reasoning message this chunk belongs to.
    public let messageId: String?

    /// The optional incremental reasoning text chunk.
    public let delta: String?

    /// Optional timestamp when this chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningMessageChunk`).
    public var eventType: EventType { .reasoningMessageChunk }

    // MARK: - Initialization

    /// Creates a new `ReasoningMessageChunkEvent`.
    ///
    /// - Parameters:
    ///   - messageId: Optional identifier of the reasoning message
    ///   - delta: Optional incremental reasoning text chunk
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String? = nil,
        delta: String? = nil,
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
extension ReasoningMessageChunkEvent: CustomStringConvertible {
    public var description: String {
        let msgId = messageId.map { "\"\($0)\"" } ?? "nil"
        let d = delta.map { "\"\($0)\"" } ?? "nil"
        return "ReasoningMessageChunkEvent(messageId: \(msgId), delta: \(d), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningMessageChunkEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningMessageChunkEvent {
            messageId: \(messageId.map { "\"\($0)\"" } ?? "nil")
            delta: \(delta.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
