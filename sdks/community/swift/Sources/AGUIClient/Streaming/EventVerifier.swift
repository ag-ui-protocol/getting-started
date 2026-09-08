// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - AGUIProtocolError

/// An error thrown when the AG-UI protocol event sequence is violated.
public struct AGUIProtocolError: Error, Sendable {
    /// A human-readable description of the protocol violation.
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

// MARK: - EventVerifier

/// Internal state machine that validates AG-UI protocol event sequences.
///
/// All access to this class is serialized within a single Task, so no
/// actor isolation is needed.
private final class EventVerifier {
    var firstEventReceived: Bool = false
    var runStarted: Bool = false
    var runFinished: Bool = false
    var runError: Bool = false
    var activeMessages: [String: Bool] = [:]
    var activeToolCalls: [String: Bool] = [:]
    var activeSteps: [String: Bool] = [:]

    let debug: Bool

    init(debug: Bool) {
        self.debug = debug
    }

    func verify(_ event: any AGUIEvent) throws {
        let type = event.eventType.rawValue

        // Handle RUN_STARTED as a special case first — it resets state for multi-run support
        if let _ = event as? RunStartedEvent {
            if runFinished {
                // Multi-run: reset state for new run
                activeMessages.removeAll()
                activeToolCalls.removeAll()
                activeSteps.removeAll()
                runFinished = false
            }
            runStarted = true
            firstEventReceived = true
            return
        }

        // Handle RUN_ERROR as a special case — allowed as first event
        if let _ = event as? RunErrorEvent {
            if runError {
                throw AGUIProtocolError(
                    message: "Cannot send event type '\(type)': The run has already errored"
                )
            }
            runError = true
            firstEventReceived = true
            return
        }

        // First event must be RUN_STARTED or RUN_ERROR
        if !firstEventReceived {
            throw AGUIProtocolError(message: "First event must be 'RUN_STARTED'")
        }

        // After RUN_ERROR, no further events
        if runError {
            throw AGUIProtocolError(
                message: "Cannot send event type '\(type)': The run has already errored"
            )
        }

        // After RUN_FINISHED (and no new RUN_STARTED has arrived), no events
        if runFinished {
            throw AGUIProtocolError(
                message: "Cannot send event type '\(type)': The run has already finished"
            )
        }

        // Validate each event type
        switch event {
        case let e as TextMessageStartEvent:
            let id = e.messageId
            if activeMessages[id] == true {
                throw AGUIProtocolError(
                    message: "A text message with ID '\(id)' is already in progress"
                )
            }
            activeMessages[id] = true

        case let e as TextMessageContentEvent:
            let id = e.messageId
            guard activeMessages[id] == true else {
                throw AGUIProtocolError(
                    message: "No active text message found with ID '\(id)'"
                )
            }

        case let e as TextMessageEndEvent:
            let id = e.messageId
            guard activeMessages[id] == true else {
                throw AGUIProtocolError(
                    message: "No active text message found with ID '\(id)'"
                )
            }
            activeMessages.removeValue(forKey: id)

        case let e as ToolCallStartEvent:
            let id = e.toolCallId
            if activeToolCalls[id] == true {
                throw AGUIProtocolError(
                    message: "A tool call with ID '\(id)' is already in progress"
                )
            }
            activeToolCalls[id] = true

        case let e as ToolCallArgsEvent:
            let id = e.toolCallId
            guard activeToolCalls[id] == true else {
                throw AGUIProtocolError(
                    message: "No active tool call found with ID '\(id)'"
                )
            }

        case let e as ToolCallEndEvent:
            let id = e.toolCallId
            guard activeToolCalls[id] == true else {
                throw AGUIProtocolError(
                    message: "No active tool call found with ID '\(id)'"
                )
            }
            activeToolCalls.removeValue(forKey: id)

        case let e as StepStartedEvent:
            activeSteps[e.stepName] = true

        case let e as StepFinishedEvent:
            let name = e.stepName
            guard activeSteps[name] == true else {
                throw AGUIProtocolError(
                    message: "Cannot send 'STEP_FINISHED' for step '\(name)' that was not started"
                )
            }
            activeSteps.removeValue(forKey: name)

        case is RunFinishedEvent:
            if !activeMessages.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while messages are still active"
                )
            }
            if !activeToolCalls.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while tool calls are still active"
                )
            }
            if !activeSteps.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while steps are still active"
                )
            }
            runFinished = true

        default:
            break
        }

        if debug {
            print("[EventVerifier] Verified: \(type)")
        }
    }
}

// MARK: - AsyncSequence Extension

extension AsyncSequence where Element == any AGUIEvent {
    /// Validates that the event stream conforms to the AG-UI protocol state machine.
    ///
    /// Events are passed through unchanged if they are valid. If a protocol violation
    /// is detected, the stream throws an `AGUIProtocolError` and terminates.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let verified = eventStream.verifyEvents()
    /// for try await event in verified {
    ///     // Only valid events reach here
    /// }
    /// ```
    ///
    /// - Parameter debug: When `true`, logs each verified event to stdout.
    /// - Returns: A throwing stream of verified events.
    public func verifyEvents(debug: Bool = false) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let verifier = EventVerifier(debug: debug)
                do {
                    for try await event in self {
                        try verifier.verify(event)
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
