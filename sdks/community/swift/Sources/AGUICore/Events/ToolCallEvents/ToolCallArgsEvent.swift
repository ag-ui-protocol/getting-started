// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event containing a chunk of argument data for a tool call.
///
/// This event is emitted multiple times during tool call argument streaming, each time
/// containing a delta (incremental change) of argument data. The delta must be a
/// non-empty string. These events are associated with a tool call via the `toolCallId`
/// field, which matches the ID from the corresponding `ToolCallStartEvent`.
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallEndEvent`, `ToolCallResultEvent`, `ToolCallChunkEvent`
public struct ToolCallArgsEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this tool call.
    ///
    /// This ID matches the `toolCallId` from the corresponding `ToolCallStartEvent`
    /// and is used to associate this argument chunk with the correct tool call.
    public let toolCallId: String

    /// The argument data delta (incremental change).
    ///
    /// This is a non-empty string containing a chunk of the tool call arguments.
    /// Multiple `ToolCallArgsEvent` instances with the same `toolCallId`
    /// represent the complete arguments when concatenated.
    public let delta: String

    /// Optional timestamp when this argument chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallArgs`).
    public var eventType: EventType { .toolCallArgs }

    // MARK: - Initialization

    /// Creates a new `ToolCallArgsEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: The unique identifier for this tool call (matches ToolCallStartEvent)
    ///   - delta: The argument data delta (must be non-empty)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String,
        delta: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - Decodable

extension ToolCallArgsEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case toolCallId
        case delta
        case timestamp
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        toolCallId = try container.decode(String.self, forKey: .toolCallId)
        delta = try container.decode(String.self, forKey: .delta)
        timestamp = try container.decodeIfPresent(Int64.self, forKey: .timestamp)
        rawEvent = nil
    }

    func withRawEvent(_ data: Data) -> Self {
        ToolCallArgsEvent(
            toolCallId: toolCallId,
            delta: delta,
            timestamp: timestamp,
            rawEvent: data
        )
    }
}

// MARK: - CustomStringConvertible
extension ToolCallArgsEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallArgsEvent(toolCallId: \(toolCallId), delta: \"\(delta)\", " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallArgsEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallArgsEvent {
            toolCallId: "\(toolCallId)"
            delta: "\(delta)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
