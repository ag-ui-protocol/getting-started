// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that a new execution step has started.
///
/// Steps represent discrete phases of agent execution, such as reasoning,
/// tool calling, or response generation. This event marks the beginning
/// of a named step in the agent's workflow.
public struct StepStartedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The name of the step that has started.
    public let stepName: String

    /// Optional timestamp when the step started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.stepStarted`).
    public var eventType: EventType { .stepStarted }

    // MARK: - Initialization

    /// Creates a new `StepStartedEvent`.
    ///
    /// - Parameters:
    ///   - stepName: The name of the step that has started
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        stepName: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.stepName = stepName
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension StepStartedEvent: CustomStringConvertible {
    public var description: String {
        "StepStartedEvent(stepName: \(stepName), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension StepStartedEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        StepStartedEvent {
            stepName: "\(stepName)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
