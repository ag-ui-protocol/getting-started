// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that an agent run has finished.
///
/// This event is emitted when an agent has finished processing a run request.
/// Inspect `outcome` to distinguish between a normal completion and a
/// human-in-the-loop interrupt.
///
/// - SeeAlso: `RunStartedEvent`, `RunErrorEvent`, `RunFinishedOutcome`
public struct RunFinishedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the conversation thread.
    public let threadId: String

    /// The unique identifier for the completed run.
    public let runId: String

    /// Why the run finished.
    ///
    /// `nil` when the `"outcome"` field was absent or `null` on the wire —
    /// treat this the same as `.success` (legacy producer behaviour).
    public let outcome: RunFinishedOutcome?

    /// Optional run result as raw JSON.
    ///
    /// Corresponds to `result: z.any().optional()` in the AG-UI protocol.
    /// Stored as opaque `Data` because the result schema is arbitrary JSON.
    public let result: Data?

    /// Optional timestamp when the run finished.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.runFinished`).
    public var eventType: EventType { .runFinished }

    // MARK: - Initialization

    /// Creates a new `RunFinishedEvent`.
    ///
    /// - Parameters:
    ///   - threadId: The conversation thread identifier
    ///   - runId: The unique run identifier
    ///   - outcome: Why the run finished (`nil` = absent/unknown, treat as success)
    ///   - result: Optional run result as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        threadId: String,
        runId: String,
        outcome: RunFinishedOutcome? = nil,
        result: Data? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.threadId = threadId
        self.runId = runId
        self.outcome = outcome
        self.result = result
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible

extension RunFinishedEvent: CustomStringConvertible {

    public var description: String {
        let outcomeDescription: String
        switch outcome {
        case .success:
            outcomeDescription = "success"
        case .interrupt(let interrupts):
            outcomeDescription = "interrupt(\(interrupts.count) interrupt(s))"
        case nil:
            outcomeDescription = "nil"
        }
        return "RunFinishedEvent(threadId: \(threadId), runId: \(runId), outcome: \(outcomeDescription), timestamp: \(timestamp?.description ?? "nil"))"
    }
}
