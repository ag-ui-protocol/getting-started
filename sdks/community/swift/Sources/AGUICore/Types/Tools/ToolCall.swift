// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents a request to execute a tool or function.
///
/// `ToolCall` pairs a unique identifier with a function call, enabling the agent
/// to request tool execution and later correlate the results through the shared ID.
/// This is a critical component of the agent-tool interaction flow in the AG-UI protocol.
///
/// ## Tool Call Flow
///
/// 1. **Request**: Agent creates a ToolCall with a unique ID and function details
/// 2. **Execution**: Tool system executes the requested function
/// 3. **Response**: Results are returned in a ``ToolMessage`` with matching toolCallId
/// 4. **Correlation**: Agent matches response to request using the ID
///
/// ## Type Field
///
/// The `type` field is always `"function"` and is included in JSON serialization
/// to maintain protocol compatibility and avoid conflicts with event discriminators.
///
/// ## Example
///
/// ```swift
/// // Create a tool call
/// let weatherCall = ToolCall(
///     id: "call_weather_123",
///     function: FunctionCall(
///         name: "get_current_weather",
///         arguments: """
///         {
///             "location": "San Francisco",
///             "unit": "celsius"
///         }
///         """
///     )
/// )
///
/// // Later, receive the response
/// let response = ToolMessage(
///     id: "msg_1",
///     content: "Temperature: 18°C, Conditions: Partly cloudy",
///     toolCallId: weatherCall.id  // Links back to the call
/// )
/// ```
///
/// ## Multiple Tool Calls
///
/// Agents can request multiple tool executions simultaneously by creating
/// an array of ToolCalls, each with a unique ID:
///
/// ```swift
/// let toolCalls: [ToolCall] = [
///     ToolCall(id: "call_1", function: FunctionCall(...)),
///     ToolCall(id: "call_2", function: FunctionCall(...)),
///     ToolCall(id: "call_3", function: FunctionCall(...))
/// ]
/// ```
///
/// - SeeAlso: ``FunctionCall``, ``ToolMessage``, ``Tool``
public struct ToolCall: Sendable, Codable, Hashable {
    /// Unique identifier for this tool call.
    ///
    /// This ID is used to correlate the tool call request with the subsequent
    /// ``ToolMessage`` response. IDs must be unique within a conversation context
    /// to ensure proper request-response matching.
    public let id: String

    /// The type of tool call (always "function").
    ///
    /// This field is included in JSON serialization to maintain protocol
    /// compatibility and prevent conflicts with the 'type' discriminator
    /// used in AG-UI events.
    public let type: String

    /// The function call details including name and arguments.
    ///
    /// Contains the function name to invoke and its JSON-encoded arguments.
    /// The actual tool execution system uses this information to dispatch
    /// the call to the appropriate handler.
    public let function: FunctionCall

    /// Optional encrypted value associated with this tool call.
    ///
    /// When present, carries a cryptographic value for verified tool-call
    /// workflows (e.g., from a ``ReasoningEncryptedValueEvent`` with subtype `.toolCall`).
    public let encryptedValue: String?

    /// Creates a new tool call.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this tool call
    ///   - function: The function call details including name and arguments
    ///   - encryptedValue: Optional encrypted value for verified tool execution
    ///
    /// - Note: The `type` field is automatically set to "function" and does not
    ///   need to be specified.
    public init(
        id: String,
        function: FunctionCall,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.type = "function"
        self.function = function
        self.encryptedValue = encryptedValue
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case function
        case encryptedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        function = try container.decode(FunctionCall.self, forKey: .function)
        encryptedValue = try container.decodeIfPresent(String.self, forKey: .encryptedValue)

        // Type should always be "function", decode if present but default to "function"
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "function"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(type, forKey: .type)
        try container.encode(function, forKey: .function)
        try container.encodeIfPresent(encryptedValue, forKey: .encryptedValue)
    }
}
