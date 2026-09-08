// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Chunk event for streaming text message content.
///
/// This event represents a single chunk of streaming text message content.
/// Unlike `TextMessageContentEvent` which requires an active text message sequence,
/// `TextMessageChunkEvent` can automatically start and end text message sequences
/// when no text message is currently active.
///
/// - SeeAlso: `TextMessageStartEvent`, `TextMessageContentEvent`, `TextMessageEndEvent`
public struct TextMessageChunkEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the message (required for the first chunk).
    ///
    /// This ID is used to associate chunks with a specific message instance.
    /// It may be `nil` for subsequent chunks if the message ID was already established.
    public let messageId: String?

    /// The role of the message sender (optional, typically "assistant").
    ///
    /// This field is typically only present in the first chunk of a message.
    public let role: String?

    /// Optional display name for the message sender.
    ///
    /// Corresponds to the `name` field in the AG-UI TypeScript spec (events.ts:94).
    public let name: String?

    /// The text content delta for this chunk.
    ///
    /// This contains the new text to append to the message. May be `nil` if
    /// this chunk only provides metadata (messageId, role) without content.
    public let delta: String?

    /// Optional timestamp when the chunk was generated.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.textMessageChunk`).
    public var eventType: EventType { .textMessageChunk }

    // MARK: - Initialization

    /// Creates a new `TextMessageChunkEvent`.
    ///
    /// - Parameters:
    ///   - messageId: Optional identifier for the message (required for the first chunk)
    ///   - role: Optional role of the message sender (typically "assistant")
    ///   - name: Optional display name for the message sender
    ///   - delta: Optional text content delta for this chunk
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String? = nil,
        role: String? = nil,
        name: String? = nil,
        delta: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.role = role
        self.name = name
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension TextMessageChunkEvent: CustomStringConvertible {
    public var description: String {
        var parts: [String] = []
        if let messageId = messageId {
            parts.append("messageId: \(messageId)")
        }
        if let role = role {
            parts.append("role: \(role)")
        }
        if let name = name {
            parts.append("name: \(name)")
        }
        if let delta = delta {
            let deltaPreview = delta.count > 50 ? String(delta.prefix(50)) + "..." : delta
            parts.append("delta: \"\(deltaPreview)\"")
        }
        if let timestamp = timestamp {
            parts.append("timestamp: \(timestamp)")
        }
        return "TextMessageChunkEvent(\(parts.joined(separator: ", ")))"
    }
}

// MARK: - CustomDebugStringConvertible
extension TextMessageChunkEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        TextMessageChunkEvent {
            messageId: \(messageId.map { "\"\($0)\"" } ?? "nil")
            role: \(role.map { "\"\($0)\"" } ?? "nil")
            name: \(name.map { "\"\($0)\"" } ?? "nil")
            delta: \(delta.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
