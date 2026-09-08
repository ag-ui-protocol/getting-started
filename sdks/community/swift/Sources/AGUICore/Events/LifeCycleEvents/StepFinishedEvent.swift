// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that an execution step has completed.
///
/// This event marks the end of a named step in the agent's workflow.
/// It can be used to track progress and measure step execution times.
public struct StepFinishedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The name of the step that has finished.
    public let stepName: String

    /// Optional timestamp when the step finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.stepFinished`).
    public var eventType: EventType { .stepFinished }

    // MARK: - Initialization

    /// Creates a new `StepFinishedEvent`.
    ///
    /// - Parameters:
    ///   - stepName: The name of the step that has finished
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
extension StepFinishedEvent: CustomStringConvertible {
    public var description: String {
        "StepFinishedEvent(stepName: \(stepName), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension StepFinishedEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        StepFinishedEvent {
            stepName: "\(stepName)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
