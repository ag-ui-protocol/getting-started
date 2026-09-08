// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A message containing the AI agent's responses.
///
/// Assistant messages represent the agent's output, which can include:
/// - **Text content**: Responses, explanations, questions to the user
/// - **Tool calls**: Requests to execute external functions
/// - **Mixed content**: Text combined with tool calls for explained actions
///
/// ## Content Types
///
/// Assistant messages can contain:
/// 1. **Text only**: Simple responses without tool invocations
/// 2. **Tool calls only**: Silent function invocations without explanation
/// 3. **Text + tool calls**: Explained actions combining both
///
/// ## Streaming Construction
///
/// Assistant messages may be built incrementally through streaming events:
/// 1. Start with basic structure (id, role)
/// 2. Add text content through TextMessageContent events
/// 3. Add tool calls through ToolCallStart/Args/End events
/// 4. Complete with TextMessageEnd or ToolCallEnd events
///
/// ## Example
///
/// ```swift
/// // Simple text response
/// let textResponse = AssistantMessage(
///     id: "asst-1",
///     content: "I understand your question. Let me explain..."
/// )
///
/// // Tool call with explanation
/// let weatherCall = ToolCall(
///     id: "call_weather",
///     function: FunctionCall(
///         name: "get_current_weather",
///         arguments: "{\"location\":\"San Francisco\"}"
///     )
/// )
///
/// let toolResponse = AssistantMessage(
///     id: "asst-2",
///     content: "Let me check the weather for you.",
///     toolCalls: [weatherCall]
/// )
///
/// // Multiple simultaneous tool calls
/// let multiToolResponse = AssistantMessage(
///     id: "asst-3",
///     content: "Gathering information from multiple sources...",
///     toolCalls: [
///         ToolCall(...),
///         ToolCall(...),
///         ToolCall(...)
///     ]
/// )
/// ```
///
/// ## Tool Call Flow
///
/// When an assistant message includes tool calls:
/// 1. Assistant creates message with toolCalls array
/// 2. Tool system executes each tool call
/// 3. Results returned in ``ToolMessage`` instances with matching toolCallId
/// 4. Assistant processes results and continues conversation
///
/// - SeeAlso: ``Message``, ``ToolCall``, ``ToolMessage``
public struct AssistantMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.assistant`).
    public let role: Role

    /// The agent's text response.
    ///
    /// This content is optional because:
    /// - The message may contain only tool calls without explanatory text
    /// - Streaming messages start with structure before content arrives
    /// - Tool-only operations may not require text explanation
    public let content: String?

    /// Optional identifier for the assistant.
    ///
    /// This can distinguish between different assistant personas, modes,
    /// or variants in multi-agent systems.
    public let name: String?

    /// Optional array of tool calls the assistant is requesting.
    ///
    /// When present, indicates the assistant wants to execute one or more
    /// external functions. Each tool call has a unique ID that will be
    /// referenced in the corresponding ``ToolMessage`` response.
    ///
    /// Tool calls may be executed:
    /// - Sequentially (one after another)
    /// - In parallel (multiple simultaneous calls)
    /// - Conditionally (based on previous results)
    public let toolCalls: [ToolCall]?

    /// Optional encrypted value associated with this message.
    ///
    /// When present, carries a cryptographic value produced by the agent's
    /// reasoning process.
    public let encryptedValue: String?

    /// Creates a new assistant message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The agent's text response (optional)
    ///   - name: Optional identifier for the assistant
    ///   - toolCalls: Optional array of tool calls to execute
    ///   - encryptedValue: Optional encrypted reasoning value
    public init(
        id: String,
        content: String? = nil,
        name: String? = nil,
        toolCalls: [ToolCall]? = nil,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .assistant
        self.content = content
        self.name = name
        self.toolCalls = toolCalls
        self.encryptedValue = encryptedValue
    }
}

// MARK: - Decodable

extension AssistantMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id
        case content
        case name
        case toolCalls
        case encryptedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = .assistant
        content = try container.decodeIfPresent(String.self, forKey: .content)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        toolCalls = try container.decodeIfPresent([ToolCall].self, forKey: .toolCalls)
        encryptedValue = try container.decodeIfPresent(String.self, forKey: .encryptedValue)
    }
}
