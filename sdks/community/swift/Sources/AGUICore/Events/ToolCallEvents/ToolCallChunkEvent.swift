// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Chunk event for streaming tool call arguments.
///
/// This event represents a single chunk of streaming tool call arguments.
/// Unlike `ToolCallArgsEvent` which requires an active tool call sequence,
/// `ToolCallChunkEvent` can automatically start and end tool call sequences
/// when no tool call is currently active.
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallEndEvent`, `ToolCallResultEvent`
public struct ToolCallChunkEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the tool call (required for the first chunk).
    ///
    /// This ID is used to associate chunks with a specific tool call instance.
    /// It may be `nil` for subsequent chunks if the tool call ID was already established.
    public let toolCallId: String?

    /// The name of the tool being called (required for the first chunk).
    ///
    /// This identifies which tool function is being invoked. It is typically
    /// only present in the first chunk of a tool call.
    public let toolCallName: String?

    /// The arguments content delta for this chunk.
    ///
    /// This contains the new arguments content to append. May be `nil` if
    /// this chunk only provides metadata (toolCallId, toolCallName) without content.
    public let delta: String?

    /// Optional identifier for the parent message containing this tool call.
    ///
    /// If provided, this associates the tool call with a specific message
    /// in the conversation.
    public let parentMessageId: String?

    /// Optional timestamp when the chunk was generated.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallChunk`).
    public var eventType: EventType { .toolCallChunk }

    // MARK: - Initialization

    /// Creates a new `ToolCallChunkEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: Optional identifier for the tool call (required for the first chunk)
    ///   - toolCallName: Optional name of the tool being called (required for the first chunk)
    ///   - delta: Optional arguments content delta for this chunk
    ///   - parentMessageId: Optional identifier of the parent message
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String? = nil,
        toolCallName: String? = nil,
        delta: String? = nil,
        parentMessageId: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.toolCallName = toolCallName
        self.delta = delta
        self.parentMessageId = parentMessageId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallChunkEvent: CustomStringConvertible {
    public var description: String {
        var parts: [String] = []
        if let toolCallId = toolCallId {
            parts.append("toolCallId: \(toolCallId)")
        }
        if let toolCallName = toolCallName {
            parts.append("toolCallName: \(toolCallName)")
        }
        if let delta = delta {
            let deltaPreview = delta.count > 50 ? String(delta.prefix(50)) + "..." : delta
            parts.append("delta: \"\(deltaPreview)\"")
        }
        if let parentMessageId = parentMessageId {
            parts.append("parentMessageId: \(parentMessageId)")
        }
        if let timestamp = timestamp {
            parts.append("timestamp: \(timestamp)")
        }
        return "ToolCallChunkEvent(\(parts.joined(separator: ", ")))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallChunkEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallChunkEvent {
            toolCallId: \(toolCallId.map { "\"\($0)\"" } ?? "nil")
            toolCallName: \(toolCallName.map { "\"\($0)\"" } ?? "nil")
            delta: \(delta.map { "\"\($0)\"" } ?? "nil")
            parentMessageId: \(parentMessageId.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
