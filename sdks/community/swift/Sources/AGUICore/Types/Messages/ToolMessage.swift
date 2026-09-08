// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A message containing the results of a tool or function execution.
///
/// Tool messages represent results returned after an assistant requests tool execution
/// through a tool call. They link back to the original tool call request via the
/// ``toolCallId`` property, allowing the agent to correlate results with specific
/// invocations.
///
/// ## Use Cases
///
/// Tool messages are used for:
/// - Returning successful tool execution results
/// - Reporting tool execution errors and failures
/// - Providing structured output from function calls
/// - Delivering API responses to the agent
/// - Communicating database query results
///
/// ## Example
///
/// ```swift
/// // Successful tool execution
/// let successMessage = ToolMessage(
///     id: "tool-msg-1",
///     content: "Successfully saved 3 files to /documents",
///     toolCallId: "call-save-123",
///     name: "save_files"
/// )
///
/// // Failed tool execution
/// let errorMessage = ToolMessage(
///     id: "tool-msg-2",
///     content: "Operation failed",
///     toolCallId: "call-delete-456",
///     name: "delete_file",
///     error: "Permission denied: Cannot delete system file"
/// )
/// ```
///
/// ## Tool Call Linkage
///
/// The ``toolCallId`` property is critical for maintaining the request-response flow:
/// 1. Assistant sends a tool call with ID "call-123"
/// 2. Tool executes and returns a ToolMessage with toolCallId = "call-123"
/// 3. Agent correlates the result with the original request
///
/// ## Error Handling
///
/// When tool execution fails, use the ``error`` property to communicate the failure:
/// - Set ``content`` to a user-friendly error description
/// - Set ``error`` to a technical error message for debugging
/// - The agent can then decide how to handle or report the error
///
/// - SeeAlso: ``Message``, ``AssistantMessage``
public struct ToolMessage: Message, Sendable, Hashable, Decodable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.tool`).
    public let role: Role

    /// The tool's output or result text.
    ///
    /// This contains the result of the tool execution, whether successful or failed.
    /// For failed executions, this typically contains a user-friendly error description.
    /// Matches the TypeScript schema `content: z.string()` — required, non-nullable.
    public let content: String

    /// The ID of the tool call this message responds to.
    ///
    /// This field links the tool message to its corresponding request, allowing the
    /// agent to correlate results with specific tool invocations. The toolCallId
    /// must match the ID from the original tool call in the assistant's message.
    public let toolCallId: String

    /// Optional name of the tool that generated this message.
    ///
    /// This can be used to identify which tool produced the result, especially
    /// useful when multiple tools are used in a conversation.
    public let name: String?

    /// Optional error message if tool execution failed.
    ///
    /// When present, indicates that the tool execution encountered an error.
    /// This should contain technical error details for debugging, while ``content``
    /// should contain a user-friendly error description.
    public let error: String?

    /// Optional encrypted value associated with this tool result.
    ///
    /// When present, carries a cryptographic value for verified tool execution
    /// workflows (e.g., from a ``ReasoningEncryptedValueEvent`` with subtype `.toolCall`).
    public let encryptedValue: String?

    /// Creates a new tool message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The tool's output or result text
    ///   - toolCallId: The ID of the tool call this message responds to
    ///   - name: Optional name of the tool that generated this message
    ///   - error: Optional error message if tool execution failed
    ///   - encryptedValue: Optional encrypted value for verified tool execution
    public init(
        id: String,
        content: String,
        toolCallId: String,
        name: String? = nil,
        error: String? = nil,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .tool
        self.content = content
        self.toolCallId = toolCallId
        self.name = name
        self.error = error
        self.encryptedValue = encryptedValue
    }
}

// MARK: - Decodable

extension ToolMessage {
    private enum CodingKeys: String, CodingKey {
        case id, content, toolCallId, name, error, encryptedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = .tool
        // Default to "" when absent — matches TypeScript z.string() (required but may be
        // missing in legacy payloads).
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        toolCallId = try container.decode(String.self, forKey: .toolCallId)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        encryptedValue = try container.decodeIfPresent(String.self, forKey: .encryptedValue)
    }
}
