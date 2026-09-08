// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that a tool call has completed.
///
/// This event is emitted when an agent finishes invoking a tool. It signals the end
/// of the tool call process and is associated with the tool call via the `toolCallId`
/// field, which matches the ID from the corresponding `ToolCallStartEvent`.
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallResultEvent`, `ToolCallChunkEvent`
public struct ToolCallEndEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this tool call.
    ///
    /// This ID matches the `toolCallId` from the corresponding `ToolCallStartEvent`
    /// and is used to associate this end event with the correct tool call.
    public let toolCallId: String

    /// Optional timestamp when the tool call finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallEnd`).
    public var eventType: EventType { .toolCallEnd }

    // MARK: - Initialization

    /// Creates a new `ToolCallEndEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: The unique identifier for this tool call (matches ToolCallStartEvent)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallEndEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallEndEvent(toolCallId: \(toolCallId), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallEndEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallEndEvent {
            toolCallId: "\(toolCallId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
