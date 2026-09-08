// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Represents a snapshot of changes to agent state after processing an event.
///
/// Each emission from `applyEvents()` carries only the fields that changed.
/// Fields not changed in this emission are `nil`.
///
/// This design mirrors Kotlin's AgentState: callers accumulate values from
/// successive emissions rather than replacing the entire state on each event.
public struct AgentState: Sendable {
    /// Updated message list, or `nil` if messages did not change.
    public var messages: [any Message]?
    /// Updated JSON state, or `nil` if state did not change.
    public var state: State?
    /// Updated raw events list, or `nil` if raw events did not change.
    public var rawEvents: [RawEvent]?
    /// Updated custom events list, or `nil` if custom events did not change.
    public var customEvents: [CustomEvent]?

    public init(
        messages: [any Message]? = nil,
        state: State? = nil,
        rawEvents: [RawEvent]? = nil,
        customEvents: [CustomEvent]? = nil
    ) {
        self.messages = messages
        self.state = state
        self.rawEvents = rawEvents
        self.customEvents = customEvents
    }
}
