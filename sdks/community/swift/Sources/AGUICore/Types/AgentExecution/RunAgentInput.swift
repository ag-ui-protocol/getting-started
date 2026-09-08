// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Input parameters for connecting to and executing an agent.
///
/// `RunAgentInput` represents the complete request body sent to an agent's
/// HTTP endpoint when initiating or continuing a conversation. It contains
/// all necessary information for the agent to process the request.
///
/// ## Core Identifiers
///
/// - **threadId**: Identifies the conversation thread
/// - **runId**: Unique identifier for this specific run/execution
/// - **parentRunId**: Optional parent run for nested agent calls
///
/// ## Execution Context
///
/// - **state**: Current state data passed to the agent
/// - **messages**: Conversation history
/// - **tools**: Available tools the agent can invoke
/// - **context**: Additional contextual information
/// - **forwardedProps**: Custom properties to forward to the agent
///
/// ## Usage Examples
///
/// ```swift
/// // Simple agent execution
/// let input = RunAgentInput(
///     threadId: "thread-123",
///     runId: "run-456"
/// )
///
/// // With conversation history
/// let messages: [any Message] = [
///     DeveloperMessage(id: "dev-1", content: "You are helpful"),
///     UserMessage(id: "user-1", content: "Hello!")
/// ]
///
/// let input = RunAgentInput(
///     threadId: "thread-123",
///     runId: "run-456",
///     messages: messages
/// )
///
/// // With tools and context
/// let tools = [
///     Tool(name: "get_weather", description: "Get weather", parameters: ...)
/// ]
///
/// let contexts = [
///     Context(description: "user_location", value: "San Francisco")
/// ]
///
/// let input = RunAgentInput(
///     threadId: "thread-123",
///     runId: "run-456",
///     messages: messages,
///     tools: tools,
///     context: contexts
/// )
/// ```
///
/// ## HTTP POST Request
///
/// This type is typically serialized to JSON and sent as the body of
/// a POST request to an agent's endpoint.
///
/// - SeeAlso: ``Message``, ``Tool``, ``Context``
public struct RunAgentInput: Sendable, Codable, Hashable {
    /// The conversation thread identifier.
    public let threadId: String

    /// The unique identifier for this run.
    public let runId: String

    /// Optional parent run identifier for nested agent calls.
    public let parentRunId: String?

    /// Current state data as JSON.
    ///
    /// Defaults to an empty JSON object.
    public let state: Data

    /// Conversation message history.
    ///
    /// Defaults to an empty array.
    public let messages: [any Message]

    /// Available tools the agent can invoke.
    ///
    /// Defaults to an empty array.
    public let tools: [Tool]

    /// Additional contextual information.
    ///
    /// Defaults to an empty array.
    public let context: [Context]

    /// Custom properties forwarded to the agent as JSON.
    ///
    /// Defaults to an empty JSON object.
    public let forwardedProps: Data

    /// Responses to human-in-the-loop interrupts from the previous run.
    ///
    /// Populate this when resuming a run that finished with
    /// `RunFinishedOutcome.interrupt`. Each entry references one `Interrupt` by
    /// its `id` and carries the caller's resolution status and optional payload.
    ///
    /// Defaults to `nil` (omitted from the wire payload).
    public let resume: [ResumeEntry]?

    /// Creates a new agent input.
    ///
    /// - Parameters:
    ///   - threadId: Conversation thread identifier
    ///   - runId: Unique run identifier
    ///   - parentRunId: Optional parent run identifier
    ///   - state: State data as JSON (defaults to empty object)
    ///   - messages: Message history (defaults to empty)
    ///   - tools: Available tools (defaults to empty)
    ///   - context: Context items (defaults to empty)
    ///   - forwardedProps: Custom properties as JSON (defaults to empty object)
    ///   - resume: Interrupt resume entries (defaults to nil)
    public init(
        threadId: String,
        runId: String,
        parentRunId: String? = nil,
        state: Data = Data("{}".utf8),
        messages: [any Message] = [],
        tools: [Tool] = [],
        context: [Context] = [],
        forwardedProps: Data = Data("{}".utf8),
        resume: [ResumeEntry]? = nil
    ) {
        self.threadId = threadId
        self.runId = runId
        self.parentRunId = parentRunId
        self.state = state
        self.messages = messages
        self.tools = tools
        self.context = context
        self.forwardedProps = forwardedProps
        self.resume = resume
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case threadId
        case runId
        case parentRunId
        case state
        case messages
        case tools
        case context
        case forwardedProps
        case resume
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // Decode simple string fields
        threadId = try container.decode(String.self, forKey: .threadId)
        runId = try container.decode(String.self, forKey: .runId)
        parentRunId = try container.decodeIfPresent(String.self, forKey: .parentRunId)

        // Decode state as arbitrary JSON object and convert to Data.
        // The encoder writes `null` when state is an empty `{}` object, so treat
        // an explicit null here as equivalent to "no state" (empty object).
        if container.contains(.state), !(try container.decodeNil(forKey: .state)) {
            let stateContainer = try container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: .state)
            let stateObject = try stateContainer.decodeJSONObject()
            state = try JSONSerialization.data(withJSONObject: stateObject)
        } else {
            state = Data("{}".utf8)
        }

        // Decode messages array using MessageDecoder for polymorphic deserialization
        if container.contains(.messages) {
            var messagesContainer = try container.nestedUnkeyedContainer(forKey: .messages)
            let messagesArray = try messagesContainer.decodeJSONArray()

            let messageDecoder = MessageDecoder()
            messages = try messagesArray.map { messageObj in
                let messageData = try JSONSerialization.data(withJSONObject: messageObj)
                return try messageDecoder.decode(messageData)
            }
        } else {
            messages = []
        }

        // Decode tools and context arrays (these already conform to Codable)
        tools = try container.decodeIfPresent([Tool].self, forKey: .tools) ?? []
        context = try container.decodeIfPresent([Context].self, forKey: .context) ?? []

        // Decode resume entries (optional — absent when not resuming an interrupt)
        resume = try container.decodeIfPresent([ResumeEntry].self, forKey: .resume)

        // Decode forwardedProps as arbitrary JSON object and convert to Data
        if container.contains(.forwardedProps) {
            let propsContainer = try container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: .forwardedProps)
            let propsObject = try propsContainer.decodeJSONObject()
            forwardedProps = try JSONSerialization.data(withJSONObject: propsObject)
        } else {
            forwardedProps = Data("{}".utf8)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        // Encode simple string fields
        try container.encode(threadId, forKey: .threadId)
        try container.encode(runId, forKey: .runId)
        try container.encodeIfPresent(parentRunId, forKey: .parentRunId)

        // Encode state: send null when empty so backends treat it as "no state".
        // An empty {} object causes some adapters (e.g. claude-agent-sdk) to
        // spin up unnecessary state-management infrastructure. null is the
        // correct sentinel for "caller has no state to manage."
        let stateObject = try JSONSerialization.jsonObject(with: state)
        if let stateDict = stateObject as? [String: Any], stateDict.isEmpty {
            try container.encodeNil(forKey: .state)
        } else {
            var stateContainer = container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: .state)
            try stateContainer.encodeJSONObject(stateObject)
        }

        // Encode messages as polymorphic array using MessageEncoder
        let messageEncoder = MessageEncoder()
        var messagesArray: [Any] = []
        for message in messages {
            let messageData = try messageEncoder.encode(message)
            let messageDict = try JSONSerialization.jsonObject(with: messageData)
            messagesArray.append(messageDict)
        }
        var messagesContainer = container.nestedUnkeyedContainer(forKey: .messages)
        try messagesContainer.encodeJSONArray(messagesArray)

        // Encode tools and context arrays (these already conform to Codable)
        try container.encode(tools, forKey: .tools)
        try container.encode(context, forKey: .context)

        // Encode resume entries — omit the key entirely when nil (not null)
        try container.encodeIfPresent(resume, forKey: .resume)

        // Encode forwardedProps as arbitrary JSON object
        let propsObject = try JSONSerialization.jsonObject(with: forwardedProps)
        var propsContainer = container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: .forwardedProps)
        try propsContainer.encodeJSONObject(propsObject)
    }

    // MARK: - Hashable

    public func hash(into hasher: inout Hasher) {
        hasher.combine(threadId)
        hasher.combine(runId)
        hasher.combine(parentRunId)
        hasher.combine(state)
        hasher.combine(tools)
        hasher.combine(context)
        hasher.combine(forwardedProps)
        hasher.combine(resume)

        // Hash each message's identifying properties
        for message in messages {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.name)
        }
    }

    public static func == (lhs: RunAgentInput, rhs: RunAgentInput) -> Bool {
        // Fast path: check simple properties first
        guard lhs.threadId == rhs.threadId &&
              lhs.runId == rhs.runId &&
              lhs.parentRunId == rhs.parentRunId &&
              lhs.state == rhs.state &&
              lhs.tools == rhs.tools &&
              lhs.context == rhs.context &&
              lhs.forwardedProps == rhs.forwardedProps &&
              lhs.resume == rhs.resume &&
              lhs.messages.count == rhs.messages.count else {
            return false
        }

        // Compare each message's identifying properties
        return zip(lhs.messages, rhs.messages).allSatisfy { lhsMsg, rhsMsg in
            lhsMsg.id == rhsMsg.id &&
            lhsMsg.role == rhsMsg.role &&
            lhsMsg.name == rhsMsg.name
        }
    }
}
