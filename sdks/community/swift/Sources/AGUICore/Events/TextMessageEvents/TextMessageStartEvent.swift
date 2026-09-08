// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that text message generation has started.
///
/// This event is emitted when an agent begins generating a text message response.
/// It provides the message identifier that will be used to associate subsequent
/// content chunks and the end event with this message.
///
/// - SeeAlso: `TextMessageContentEvent`, `TextMessageEndEvent`, `TextMessageChunkEvent`
public struct TextMessageStartEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this message.
    ///
    /// This ID is used to associate content chunks and the end event
    /// with this specific message instance.
    public let messageId: String

    /// The role of the message sender (always "assistant" for agent messages).
    public let role: String

    /// Optional display name for the message sender.
    ///
    /// Corresponds to the `name` field in the AG-UI TypeScript spec (events.ts:75).
    public let name: String?

    /// Optional timestamp when the message generation started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.textMessageStart`).
    public var eventType: EventType { .textMessageStart }

    // MARK: - Initialization

    /// Creates a new `TextMessageStartEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier for this message
    ///   - role: The role of the message sender (typically "assistant")
    ///   - name: Optional display name for the message sender
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        role: String = "assistant",
        name: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - Decodable

extension TextMessageStartEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case messageId
        case role
        case name
        case timestamp
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try container.decode(String.self, forKey: .messageId)
        role = try container.decode(String.self, forKey: .role)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        timestamp = try container.decodeIfPresent(Int64.self, forKey: .timestamp)
        rawEvent = nil
    }

    func withRawEvent(_ data: Data) -> Self {
        TextMessageStartEvent(
            messageId: messageId,
            role: role,
            name: name,
            timestamp: timestamp,
            rawEvent: data
        )
    }
}

// MARK: - CustomStringConvertible
extension TextMessageStartEvent: CustomStringConvertible {
    public var description: String {
        var parts = "TextMessageStartEvent(messageId: \(messageId), role: \(role)"
        if let name = name { parts += ", name: \(name)" }
        parts += ", timestamp: \(timestamp?.description ?? "nil"))"
        return parts
    }
}

// MARK: - CustomDebugStringConvertible
extension TextMessageStartEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        TextMessageStartEvent {
            messageId: "\(messageId)"
            role: "\(role)"
            name: \(name.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
