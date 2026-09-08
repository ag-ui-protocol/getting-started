// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// The entity type that an encrypted reasoning value is attached to.
///
/// - `toolCall`: The encrypted value is attached to a tool call.
/// - `message`: The encrypted value is attached to a message.
public enum ReasoningEncryptedValueSubtype: String, Codable, CaseIterable, Sendable {
    /// The encrypted value is associated with a tool call entity.
    case toolCall = "tool-call"
    /// The encrypted value is associated with a message entity.
    case message
}

/// Event that attaches an encrypted reasoning value to a message or tool call.
///
/// `ReasoningEncryptedValueEvent` carries a cryptographic value produced by the
/// agent's reasoning process. The `subtype` indicates whether the value is bound
/// to a message or a tool call, and `entityId` identifies the specific entity.
///
/// - SeeAlso: ``ReasoningStartEvent``, ``ReasoningEndEvent``
public struct ReasoningEncryptedValueEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// Whether this encrypted value is associated with a tool call or a message.
    public let subtype: ReasoningEncryptedValueSubtype

    /// The identifier of the entity (message or tool call) this value is attached to.
    public let entityId: String

    /// The encrypted reasoning value.
    public let encryptedValue: String

    /// Optional timestamp when this event was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.reasoningEncryptedValue`).
    public var eventType: EventType { .reasoningEncryptedValue }

    // MARK: - Initialization

    /// Creates a new `ReasoningEncryptedValueEvent`.
    ///
    /// - Parameters:
    ///   - subtype: Whether the encrypted value is for a tool call or a message
    ///   - entityId: The identifier of the target entity
    ///   - encryptedValue: The encrypted reasoning value string
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        subtype: ReasoningEncryptedValueSubtype,
        entityId: String,
        encryptedValue: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.subtype = subtype
        self.entityId = entityId
        self.encryptedValue = encryptedValue
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ReasoningEncryptedValueEvent: CustomStringConvertible {
    public var description: String {
        "ReasoningEncryptedValueEvent(subtype: \(subtype.rawValue), entityId: \"\(entityId)\", timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ReasoningEncryptedValueEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ReasoningEncryptedValueEvent {
            subtype: \(subtype.rawValue)
            entityId: "\(entityId)"
            encryptedValue: <redacted>
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
