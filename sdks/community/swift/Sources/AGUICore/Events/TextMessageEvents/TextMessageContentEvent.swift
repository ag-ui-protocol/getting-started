// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a chunk of text content for a message.
///
/// This event is emitted multiple times during message generation, each time
/// containing a delta (incremental change) of text content. The delta must
/// be a non-empty string. These events are associated with a message via the
/// `messageId` field, which matches the ID from the corresponding
/// `TextMessageStartEvent`.
///
/// - SeeAlso: `TextMessageStartEvent`, `TextMessageEndEvent`, `TextMessageChunkEvent`
public struct TextMessageContentEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this message.
    ///
    /// This ID matches the `messageId` from the corresponding `TextMessageStartEvent`
    /// and is used to associate this content chunk with the correct message.
    public let messageId: String

    /// The text content delta (incremental change).
    ///
    /// This is a non-empty string containing a chunk of the message content.
    /// Multiple `TextMessageContentEvent` instances with the same `messageId`
    /// represent the complete message when concatenated.
    public let delta: String

    /// Optional timestamp when this content chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.textMessageContent`).
    public var eventType: EventType { .textMessageContent }

    // MARK: - Initialization

    /// Creates a new `TextMessageContentEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier for this message (matches TextMessageStartEvent)
    ///   - delta: The text content delta (must be non-empty)
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

// MARK: - Decodable

extension TextMessageContentEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case messageId
        case delta
        case timestamp
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        delta = try container.decode(String.self, forKey: .delta)
        timestamp = try container.decodeIfPresent(Int64.self, forKey: .timestamp)
        rawEvent = nil
    }

    func withRawEvent(_ data: Data) -> Self {
        TextMessageContentEvent(
            messageId: messageId,
            delta: delta,
            timestamp: timestamp,
            rawEvent: data
        )
    }
}

// MARK: - CustomStringConvertible
extension TextMessageContentEvent: CustomStringConvertible {
    public var description: String {
        "TextMessageContentEvent(messageId: \(messageId), delta: \"\(delta)\", " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension TextMessageContentEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        TextMessageContentEvent {
            messageId: "\(messageId)"
            delta: "\(delta)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
