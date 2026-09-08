// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import Foundation

/// HTTP implementation of `ToolResponseHandler`.
///
/// Sends tool results back to the agent by initiating a new run containing
/// only the tool result message. This mirrors the Kotlin `ClientToolResponseHandler`.
///
/// ## How it works
///
/// When a tool call completes, the result must be delivered back to the agent
/// so it can continue the conversation. `ClientToolResponseHandler` does this
/// by constructing a minimal `RunAgentInput` containing the `ToolMessage` and
/// executing a new run through the same `HttpAgent`. The resulting events are
/// consumed and discarded — callers receive the results through the ongoing
/// conversation stream, not here.
///
/// ## Example
///
/// ```swift
/// let httpAgent = HttpAgent(baseURL: agentURL)
/// let handler = ClientToolResponseHandler(httpAgent: httpAgent)
/// let manager = ToolExecutionManager(
///     toolRegistry: registry,
///     responseHandler: handler
/// )
/// ```
public final class ClientToolResponseHandler: ToolResponseHandler, Sendable {

    private let httpAgent: HttpAgent
    private let endpoint: String?

    /// Creates a handler that routes tool responses through the given agent.
    ///
    /// - Parameters:
    ///   - httpAgent: The HTTP agent used to deliver tool results
    ///   - endpoint: The endpoint path to POST tool results to (e.g. `"/agentic_chat"`).
    ///     Defaults to the agent's own default when `nil`.
    public init(httpAgent: HttpAgent, endpoint: String? = nil) {
        self.httpAgent = httpAgent
        self.endpoint = endpoint
    }

    public func sendToolResponse(
        _ message: ToolMessage,
        threadId: String?,
        runId: String?
    ) async throws {
        let input = RunAgentInput(
            threadId: threadId ?? "tool_\(UUID().uuidString)",
            runId: runId ?? "run_\(UUID().uuidString)",
            messages: [message]
        )
        // Drive the full pipeline; surface any server-side errors.
        for try await event in try await httpAgent.run(input, endpoint: endpoint) {
            if let errorEvent = event as? RunErrorEvent {
                throw ClientError.streamError(errorEvent.message)
            }
        }
    }
}
