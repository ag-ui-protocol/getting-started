// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that an agent run has encountered an error.
///
/// This event is emitted when an agent run fails due to an unrecoverable error.
/// It provides error details and optional error codes for debugging and handling.
///
/// - SeeAlso: `RunStartedEvent`, `RunFinishedEvent`
public struct RunErrorEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// Human-readable error message.
    ///
    /// Matches the `message` field in the AG-UI protocol.
    public let message: String

    /// Optional error code (e.g., "TIMEOUT", "TOOL_EXECUTION_FAILED").
    ///
    /// Matches the `code` field in the AG-UI protocol.
    public let code: String?

    /// Optional timestamp when the error occurred.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.runError`).
    public var eventType: EventType { .runError }

    // MARK: - Initialization

    /// Creates a new `RunErrorEvent`.
    ///
    /// - Parameters:
    ///   - message: Human-readable error description
    ///   - code: Optional error code
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        message: String,
        code: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.message = message
        self.code = code
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible

extension RunErrorEvent: CustomStringConvertible {
    public var description: String {
        "RunErrorEvent(message: \"\(message)\", code: \(code ?? "nil"), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension RunErrorEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        RunErrorEvent {
            message: "\(message)"
            code: \(code ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
