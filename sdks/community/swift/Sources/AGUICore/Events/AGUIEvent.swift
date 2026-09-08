// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Base protocol for all events in the AG-UI protocol.
///
/// Events represent real-time notifications from agents about their execution state,
/// message generation, tool calls, and state changes. All events follow a common
/// structure with polymorphic serialization based on the "type" field.
///
/// Key Properties:
/// - `eventType`: The specific type of event (used for pattern matching)
/// - `timestamp`: Optional timestamp of when the event occurred
///
/// Event Categories:
/// - Lifecycle Events: Run and step start/finish/error events
/// - Text Message Events: Streaming text message generation
/// - Tool Call Events: Tool invocation and argument streaming
/// - State Management Events: State snapshots and incremental updates
/// - Special Events: Raw and custom event types
///
/// Serialization:
/// Uses polymorphic serialization where the "type" field determines which
/// specific event type to deserialize to.
///
/// - SeeAlso: `EventType`
public protocol AGUIEvent: Sendable {
    /// The type of this event.
    ///
    /// This property is used for pattern matching and event handling logic.
    /// The actual "type" field in JSON is used for polymorphic decoding.
    ///
    /// - SeeAlso: `EventType`
    var eventType: EventType { get }

    /// Optional timestamp indicating when this event occurred.
    ///
    /// The timestamp is represented as milliseconds since epoch (Unix timestamp).
    /// This field may be nil if timing information is not available or relevant.
    ///
    /// Note: The protocol specification varies between implementations regarding
    /// timestamp format, but Int64 (milliseconds) is used here for consistency
    /// with standard timestamp conventions.
    var timestamp: Int64? { get }

    /// Optional raw event data as received from the agent.
    ///
    /// This preserves the original JSON bytes for debugging, logging, and forward
    /// compatibility with protocol extensions. May be nil if the event was created
    /// programmatically rather than decoded from JSON.
    var rawEvent: Data? { get }
}
