// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Context provided to tool executors during execution.
///
/// `ToolExecutionContext` provides all the necessary information for a tool to execute,
/// including the tool call being executed, optional thread and run identifiers for tracking,
/// and metadata for additional execution context.
///
/// ## Usage
///
/// ```swift
/// // Minimal context
/// let context = ToolExecutionContext(toolCall: toolCall)
///
/// // Full context with tracking and metadata
/// let context = ToolExecutionContext(
///     toolCall: toolCall,
///     threadId: "thread_abc123",
///     runId: "run_xyz789",
///     metadata: [
///         "userId": "user_123",
///         "sessionId": "session_456",
///         "timestamp": "2025-01-01T12:00:00Z"
///     ]
/// )
/// ```
///
/// ## Thread and Run IDs
///
/// - **threadId**: Identifies the conversation thread this tool execution belongs to
/// - **runId**: Identifies the specific agent run within the thread
///
/// These identifiers enable:
/// - Tracking tool executions across conversations
/// - Correlating tool calls with agent runs
/// - Debugging and observability
///
/// ## Metadata
///
/// The metadata dictionary allows passing additional context-specific information
/// such as user IDs, session data, timestamps, or configuration values.
///
/// ## Design Notes
///
/// - Conforms to `Sendable` for safe concurrent access
/// - All fields are immutable for thread safety
/// - Optional thread/run IDs support both tracked and standalone tool executions
///
/// - SeeAlso: ``ToolExecutor``, ``ToolExecutionResult``
public struct ToolExecutionContext: Sendable {
    /// The tool call being executed.
    ///
    /// Contains the tool name, function details, and JSON-encoded arguments
    /// that the tool executor will process.
    public let toolCall: ToolCall

    /// The thread ID (if available).
    ///
    /// Identifies the conversation thread this tool execution belongs to.
    /// May be nil for standalone tool executions outside of a thread context.
    public let threadId: String?

    /// The run ID (if available).
    ///
    /// Identifies the specific agent run within the thread.
    /// May be nil for tool executions not associated with an agent run.
    public let runId: String?

    /// Additional execution metadata.
    ///
    /// Can contain any context-specific information such as:
    /// - User identification
    /// - Session data
    /// - Timestamps
    /// - Configuration values
    /// - Custom execution parameters
    public let metadata: [String: String]

    /// Creates a new tool execution context.
    ///
    /// - Parameters:
    ///   - toolCall: The tool call being executed
    ///   - threadId: Optional thread identifier
    ///   - runId: Optional run identifier
    ///   - metadata: Additional execution metadata (defaults to empty)
    public init(
        toolCall: ToolCall,
        threadId: String? = nil,
        runId: String? = nil,
        metadata: [String: String] = [:]
    ) {
        self.toolCall = toolCall
        self.threadId = threadId
        self.runId = runId
        self.metadata = metadata
    }
}
