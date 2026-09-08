// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Events emitted during the tool execution lifecycle.
///
/// Observe these to monitor tool execution progress for logging, metrics,
/// or UI feedback.
public enum ToolExecutionEvent: Sendable {
    /// Tool call received and queued for execution.
    case started(toolCallId: String, toolName: String)
    /// Tool is actively running.
    case executing(toolCallId: String, toolName: String)
    /// Tool completed successfully.
    case succeeded(toolCallId: String, toolName: String, result: ToolExecutionResult)
    /// Tool failed (either not found or threw an error).
    case failed(toolCallId: String, toolName: String, error: String)

    public var toolCallId: String {
        switch self {
        case .started(let id, _), .executing(let id, _), .succeeded(let id, _, _), .failed(let id, _, _):
            return id
        }
    }

    public var toolName: String {
        switch self {
        case .started(_, let n), .executing(_, let n), .succeeded(_, let n, _), .failed(_, let n, _):
            return n
        }
    }
}
