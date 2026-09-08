// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing the result/output from a tool call execution.
///
/// This event is emitted when a tool call completes and produces a result.
/// It provides the tool call result content and associates it with both the
/// tool call (via `toolCallId`) and the conversation message (via `messageId`).
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallEndEvent`, `ToolCallChunkEvent`
public struct ToolCallResultEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for the conversation message this result belongs to.
    ///
    /// This associates the tool call result with a specific message in the conversation.
    public let messageId: String

    /// The unique identifier for this tool call.
    ///
    /// This ID matches the `toolCallId` from the corresponding `ToolCallStartEvent`
    /// and is used to associate this result with the correct tool call.
    public let toolCallId: String

    /// The actual result/output content from the tool execution.
    ///
    /// This contains the output produced by the tool, which may be text, JSON,
    /// or any other format depending on the tool's implementation.
    public let content: String

    /// Optional role identifier (typically "tool" for tool results).
    public let role: String?

    /// Optional timestamp when the tool call result was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallResult`).
    public var eventType: EventType { .toolCallResult }

    // MARK: - Initialization

    /// Creates a new `ToolCallResultEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier for the conversation message
    ///   - toolCallId: The unique identifier for this tool call (matches ToolCallStartEvent)
    ///   - content: The actual result/output content from the tool execution
    ///   - role: Optional role identifier (typically "tool")
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        toolCallId: String,
        content: String,
        role: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.toolCallId = toolCallId
        self.content = content
        self.role = role
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallResultEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallResultEvent(messageId: \(messageId), toolCallId: \(toolCallId), " +
        "content: \"\(content)\", role: \(role ?? "nil"), " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallResultEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallResultEvent {
            messageId: "\(messageId)"
            toolCallId: "\(toolCallId)"
            content: "\(content)"
            role: \(role.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
