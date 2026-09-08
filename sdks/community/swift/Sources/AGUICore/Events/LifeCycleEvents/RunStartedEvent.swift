// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that a new agent run has started.
///
/// This event is emitted when an agent begins processing a new run request.
/// It provides the thread and run identifiers that will be used throughout
/// the execution lifecycle.
/// - SeeAlso: `RunFinishedEvent`, `RunErrorEvent`
public struct RunStartedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the conversation thread.
    ///
    /// Matches the AG-UI protocol field exactly.
    public let threadId: String

    /// The unique identifier for this specific run.
    ///
    /// Matches the AG-UI protocol field exactly.
    public let runId: String

    /// The parent run identifier for nested agent runs, if any.
    ///
    /// Corresponds to `parentRunId` in the AG-UI protocol.
    public let parentRunId: String?

    /// The initial agent input that started this run, as raw JSON.
    ///
    /// Corresponds to `input` (RunAgentInputSchema) in the AG-UI protocol.
    /// Stored as opaque `Data` because the full schema (including messages)
    /// is too complex for automatic synthesis. Use `JSONDecoder` or
    /// `JSONSerialization` to parse the contents when needed.
    public let input: Data?

    /// Optional timestamp when the run started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.runStarted`).
    public var eventType: EventType { .runStarted }

    // MARK: - Initialization

    /// Creates a new `RunStartedEvent`.
    ///
    /// - Parameters:
    ///   - threadId: The conversation thread identifier
    ///   - runId: The unique run identifier
    ///   - parentRunId: Optional parent run identifier for nested runs
    ///   - input: Optional initial run input as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        threadId: String,
        runId: String,
        parentRunId: String? = nil,
        input: Data? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.threadId = threadId
        self.runId = runId
        self.parentRunId = parentRunId
        self.input = input
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension RunStartedEvent: CustomStringConvertible {
    public var description: String {
        "RunStartedEvent(threadId: \(threadId), runId: \(runId), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension RunStartedEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        RunStartedEvent {
            threadId: "\(threadId)"
            runId: "\(runId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
