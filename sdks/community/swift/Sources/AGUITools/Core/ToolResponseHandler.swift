// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Contract for sending tool execution results back to the agent.
///
/// Conforming types deliver `ToolMessage` responses to whatever transport
/// the agent uses (HTTP, WebSocket, in-process, etc.).
public protocol ToolResponseHandler: Sendable {
    /// Sends a tool response message back to the agent.
    ///
    /// - Parameters:
    ///   - message: The completed tool message to send
    ///   - threadId: The conversation thread ID (may be nil)
    ///   - runId: The run ID this response belongs to (may be nil)
    func sendToolResponse(
        _ message: ToolMessage,
        threadId: String?,
        runId: String?
    ) async throws
}

/// No-op implementation that discards all tool responses.
///
/// Useful for testing or when tool responses are not needed.
public struct NullToolResponseHandler: ToolResponseHandler {
    public init() {}
    public func sendToolResponse(_ message: ToolMessage, threadId: String?, runId: String?) async throws {}
}
