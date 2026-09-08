// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import Foundation

/// Stateful AG-UI agent that automatically manages conversation history.
///
/// `StatefulAgUiAgent` provides a high-level, iOS-friendly API for building
/// conversational AI interfaces. It automatically tracks message history per thread,
/// manages state updates, and provides convenient methods for common patterns.
///
/// ## Basic Usage
///
/// ```swift
/// let agent = StatefulAgUiAgent(baseURL: URL(string: "https://agent.example.com")!)
///
/// let stream = try await agent.chat(message: "Hello!")
/// for try await event in stream {
///     if let content = event as? TextMessageContentEvent {
///         print(content.delta, terminator: "")
///     }
/// }
/// ```
///
/// ## Advanced Configuration
///
/// ```swift
/// var config = StatefulAgUiAgentConfig(baseURL: agentURL)
/// config.systemPrompt = "You are a helpful AI assistant."
/// config.maxHistoryLength = 50
/// config.timeout = .seconds(60)
///
/// let agent = StatefulAgUiAgent(configuration: config)
///
/// // Multi-turn conversation
/// _ = try await agent.chat(message: "What's the weather?")
/// _ = try await agent.chat(message: "And tomorrow?") // Maintains context
/// ```
///
/// ## Thread Management
///
/// Each conversation can have its own thread with independent history:
///
/// ```swift
/// // Conversation 1
/// let stream1 = try await agent.chat(message: "Hello", threadId: "user-123")
///
/// // Conversation 2 (separate history)
/// let stream2 = try await agent.chat(message: "Hi", threadId: "user-456")
/// ```
///
/// ## Features
///
/// - **Automatic History**: User and assistant messages are tracked automatically
/// - **System Prompts**: Configurable system message for agent behavior
/// - **History Trimming**: Keeps conversations within token limits
/// - **State Management**: Tracks and updates agent state from events
/// - **Thread Safety**: Actor-based concurrency for safe multi-threaded use
///
/// - SeeAlso: ``StatefulAgUiAgentConfig``, ``ConversationHistoryManager``
public final class StatefulAgUiAgent: Sendable {
    /// The underlying HTTP agent for communication.
    private let httpAgent: HttpAgent

    /// Injected transport used in place of `httpAgent` when present (test path).
    private let agentTransport: (any AgentTransport)?

    /// Manager for conversation histories across threads.
    private let historyManager: ConversationHistoryManager

    /// Configuration for this agent.
    public let config: StatefulAgUiAgentConfig

    /// Actor for managing current state (thread-safe).
    private let stateManager: StateManager

    /// Optional tool execution manager. Created when `config.toolRegistry` is set.
    private let toolExecutionManager: ToolExecutionManager?

    /// Creates a new stateful agent with a base URL.
    ///
    /// - Parameter baseURL: The base URL of the AG-UI agent server
    ///
    /// ## Example
    ///
    /// ```swift
    /// let agent = StatefulAgUiAgent(baseURL: URL(string: "https://agent.example.com")!)
    /// ```
    public convenience init(baseURL: URL) {
        self.init(configuration: StatefulAgUiAgentConfig(baseURL: baseURL))
    }

    /// Creates a new stateful agent with custom configuration.
    ///
    /// - Parameter configuration: The stateful agent configuration
    ///
    /// ## Example
    ///
    /// ```swift
    /// var config = StatefulAgUiAgentConfig(baseURL: agentURL)
    /// config.systemPrompt = "You are helpful"
    /// config.maxHistoryLength = 100
    ///
    /// let agent = StatefulAgUiAgent(configuration: config)
    /// ```
    public init(configuration: StatefulAgUiAgentConfig) {
        self.config = configuration
        let agent = HttpAgent(configuration: HttpAgentConfiguration(
            baseURL: configuration.baseURL,
            timeout: configuration.timeout,
            headers: configuration.buildHeaders(),
            debug: configuration.debug
        ))
        self.httpAgent = agent
        self.agentTransport = nil
        self.historyManager = ConversationHistoryManager()
        self.stateManager = StateManager(initialState: configuration.initialState)
        if let registry = configuration.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent, endpoint: configuration.endpoint)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    /// Creates a stateful agent backed by a custom transport (test path).
    ///
    /// Use this initializer in tests to inject a mock transport instead of
    /// making real HTTP connections.
    init(transport: any AgentTransport, config: StatefulAgUiAgentConfig) {
        self.config = config
        let url = URL(string: "https://placeholder.local")!
        self.httpAgent = HttpAgent(baseURL: url)
        self.agentTransport = transport
        self.historyManager = ConversationHistoryManager()
        self.stateManager = StateManager(initialState: config.initialState)
        self.toolExecutionManager = nil
    }

    /// Sends a chat message with automatic history management.
    ///
    /// This is a convenience method that delegates to ``sendMessage(message:threadId:state:includeSystemPrompt:)``
    /// with sensible defaults for casual chat interactions.
    ///
    /// - Parameters:
    ///   - message: The user's message text
    ///   - threadId: The conversation thread ID (default: "default")
    /// - Returns: Event stream from the agent
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Example
    ///
    /// ```swift
    /// let stream = try await agent.chat(message: "Hello!")
    /// for try await event in stream {
    ///     // Process events
    /// }
    /// ```
    public func chat(
        message: String,
        threadId: String = "default"
    ) async throws -> AsyncThrowingStream<any AGUIEvent, Error> {
        let currentState = await stateManager.currentState()
        return try await sendMessage(
            message: message,
            threadId: threadId,
            state: currentState,
            includeSystemPrompt: true
        )
    }

    /// Sends a message with full control over state and system prompt.
    ///
    /// This method provides complete control over the message sending process,
    /// including custom state and system prompt inclusion.
    ///
    /// - Parameters:
    ///   - message: The user's message text
    ///   - threadId: The conversation thread ID
    ///   - state: Custom state to send (defaults to current state)
    ///   - includeSystemPrompt: Whether to add system prompt for new threads (default: true)
    /// - Returns: Event stream from the agent
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Example
    ///
    /// ```swift
    /// let customState = Data("{\"mode\":\"creative\"}".utf8)
    /// let stream = try await agent.sendMessage(
    ///     message: "Tell me a story",
    ///     threadId: "story-session",
    ///     state: customState,
    ///     includeSystemPrompt: true
    /// )
    /// ```
    public func sendMessage(
        message: String,
        threadId: String,
        state: State?,
        includeSystemPrompt: Bool
    ) async throws -> AsyncThrowingStream<any AGUIEvent, Error> {
        // Get conversation history for this thread
        var history = await historyManager.history(for: threadId)

        // Add system prompt if it's the first message and includeSystemPrompt is true
        if history.isEmpty && includeSystemPrompt, let systemPrompt = config.systemPrompt {
            let systemMessage = SystemMessage(
                id: "sys_\(UUID().uuidString)",
                content: systemPrompt
            )
            await historyManager.append(message: systemMessage, to: threadId)
            history.append(systemMessage)
        }

        // Create and add the user message
        let userMessage = UserMessage(
            id: "usr_\(UUID().uuidString)",
            content: message
        )
        await historyManager.append(message: userMessage, to: threadId)
        history.append(userMessage)

        // Apply history length limit if configured
        if config.maxHistoryLength > 0 {
            await historyManager.trim(threadId: threadId, maxLength: config.maxHistoryLength)
            history = await historyManager.history(for: threadId)
        }

        // Use the provided state or the current state
        let stateToUse: State
        if let providedState = state {
            stateToUse = providedState
        } else {
            stateToUse = await stateManager.currentState()
        }

        // Build the base run input
        let baseInput = try RunAgentInput.builder()
            .threadId(threadId)
            .runId("run_\(UUID().uuidString)")
            .messages(history)
            .state(stateToUse)
            .build()

        // Include tool definitions if a registry is configured
        let inputWithTools: RunAgentInput
        if let registry = config.toolRegistry {
            let tools = await registry.allTools()
            inputWithTools = RunAgentInput(
                threadId: baseInput.threadId,
                runId: baseInput.runId,
                parentRunId: baseInput.parentRunId,
                state: baseInput.state,
                messages: baseInput.messages,
                tools: tools,
                context: config.context.isEmpty ? baseInput.context : config.context,
                forwardedProps: baseInput.forwardedProps
            )
        } else {
            inputWithTools = RunAgentInput(
                threadId: baseInput.threadId,
                runId: baseInput.runId,
                parentRunId: baseInput.parentRunId,
                state: baseInput.state,
                messages: baseInput.messages,
                tools: baseInput.tools,
                context: config.context.isEmpty ? baseInput.context : config.context,
                forwardedProps: baseInput.forwardedProps
            )
        }

        // Execute the run and obtain an event stream
        let eventStream: AsyncThrowingStream<any AGUIEvent, Error>

        if let transport = agentTransport {
            // Test path: transport yields events directly
            let rawStream = transport.run(input: inputWithTools)
            if let manager = toolExecutionManager {
                eventStream = await manager.processEventStream(
                    rawStream,
                    threadId: inputWithTools.threadId,
                    runId: inputWithTools.runId
                )
            } else {
                eventStream = rawStream
            }
        } else {
            // Production path: httpAgent performs SSE over HTTP
            let rawStream = try await httpAgent.run(inputWithTools, endpoint: config.endpoint)
            if let manager = toolExecutionManager {
                eventStream = await manager.processEventStream(
                    rawStream,
                    threadId: inputWithTools.threadId,
                    runId: inputWithTools.runId
                )
            } else {
                eventStream = AsyncThrowingStream { continuation in
                    let task = Task {
                        do {
                            for try await event in rawStream { continuation.yield(event) }
                            continuation.finish()
                        } catch { continuation.finish(throwing: error) }
                    }
                    continuation.onTermination = { _ in task.cancel() }
                }
            }
        }

        // Wrap the stream to track history and state updates
        return trackHistoryAndState(stream: eventStream, threadId: threadId)
    }

    /// Retrieves the conversation history for a thread.
    ///
    /// - Parameter threadId: The thread ID (default: "default")
    /// - Returns: Array of messages in chronological order
    ///
    /// ## Example
    ///
    /// ```swift
    /// let history = await agent.history(for: "chat-session")
    /// print("Conversation has \(history.count) messages")
    /// ```
    public func history(for threadId: String = "default") async -> [any Message] {
        await historyManager.history(for: threadId)
    }

    /// Clears conversation history for one or all threads.
    ///
    /// - Parameter threadId: The thread ID to clear, or `nil` to clear all threads
    ///
    /// ## Example
    ///
    /// ```swift
    /// // Clear specific thread
    /// await agent.clearHistory(threadId: "chat-1")
    ///
    /// // Clear all threads
    /// await agent.clearHistory()
    /// ```
    public func clearHistory(threadId: String? = nil) async {
        await historyManager.clear(threadId: threadId)
    }

    // MARK: - Private Helpers

    /// Wraps an event stream to track assistant messages, tool calls, and state updates.
    private func trackHistoryAndState<S: AsyncSequence>(
        stream: S,
        threadId: String
    ) -> AsyncThrowingStream<any AGUIEvent, Error> where S.Element == any AGUIEvent {
        AsyncThrowingStream { continuation in
            let task = Task {
                var currentAssistantMessage: AssistantMessage?
                let patchApplicator = PatchApplicator()

                do {
                    for try await event in stream {
                        // Yield the event downstream
                        continuation.yield(event)

                        // Track assistant messages, tool calls, and state
                        switch event {

                        // MARK: Text messages

                        case let start as TextMessageStartEvent:
                            currentAssistantMessage = AssistantMessage(
                                id: start.messageId,
                                content: ""
                            )

                        case let content as TextMessageContentEvent:
                            if let msg = currentAssistantMessage, msg.id == content.messageId {
                                let updatedContent = (msg.content ?? "") + content.delta
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: updatedContent,
                                    name: msg.name,
                                    toolCalls: msg.toolCalls
                                )
                            }

                        case let end as TextMessageEndEvent:
                            if let msg = currentAssistantMessage, msg.id == end.messageId {
                                await self.historyManager.append(message: msg, to: threadId)
                                currentAssistantMessage = nil
                            }

                        // MARK: Tool calls

                        case let start as ToolCallStartEvent:
                            let newCall = ToolCall(
                                id: start.toolCallId,
                                function: FunctionCall(name: start.toolCallName, arguments: "")
                            )
                            if let msg = currentAssistantMessage {
                                var calls = msg.toolCalls ?? []
                                calls.append(newCall)
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: msg.content,
                                    name: msg.name,
                                    toolCalls: calls
                                )
                            } else {
                                currentAssistantMessage = AssistantMessage(
                                    id: "asst_\(UUID().uuidString)",
                                    content: nil,
                                    toolCalls: [newCall]
                                )
                            }

                        case let args as ToolCallArgsEvent:
                            if let msg = currentAssistantMessage,
                               let calls = msg.toolCalls,
                               let idx = calls.firstIndex(where: { $0.id == args.toolCallId }) {
                                let call = calls[idx]
                                let updatedCall = ToolCall(
                                    id: call.id,
                                    function: FunctionCall(
                                        name: call.function.name,
                                        arguments: call.function.arguments + args.delta
                                    )
                                )
                                var updatedCalls = calls
                                updatedCalls[idx] = updatedCall
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: msg.content,
                                    name: msg.name,
                                    toolCalls: updatedCalls
                                )
                            }

                        case is ToolCallEndEvent:
                            // Do NOT append the assistant message here. For multi-tool-call sequences
                            // (ToolCallStart→ToolCallEnd×N), appending at every ToolCallEnd caused N
                            // duplicates in history. The assistant message is flushed at:
                            //   • TextMessageEndEvent (text + optional tool calls)
                            //   • The first ToolCallResultEvent (tool-call-only turns)
                            break

                        case let result as ToolCallResultEvent:
                            // Flush a pending tool-call-only assistant message before recording the
                            // tool result. This handles turns where ToolCallStart/End events fire
                            // without a surrounding TextMessageStart/End envelope.
                            if let msg = currentAssistantMessage {
                                await self.historyManager.append(message: msg, to: threadId)
                                currentAssistantMessage = nil
                            }
                            let toolMessage = ToolMessage(
                                id: result.messageId,
                                content: result.content,
                                toolCallId: result.toolCallId
                            )
                            await self.historyManager.append(message: toolMessage, to: threadId)

                        // MARK: State events

                        case let snapshot as StateSnapshotEvent:
                            await self.stateManager.updateState(snapshot.snapshot)

                        case let delta as StateDeltaEvent:
                            let currentState = await self.stateManager.currentState()
                            if let newState = try? patchApplicator.apply(patch: delta.delta, to: currentState) {
                                await self.stateManager.updateState(newState)
                            }

                        case let msgSnapshot as MessagesSnapshotEvent:
                            // Replace the thread history with the authoritative snapshot.
                            await self.historyManager.clear(threadId: threadId)
                            for msg in msgSnapshot.messages {
                                await self.historyManager.append(message: msg, to: threadId)
                            }

                        default:
                            break
                        }
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

// MARK: - StateManager

/// Thread-safe actor for managing agent state.
private actor StateManager {
    private var currentStateValue: State

    init(initialState: State) {
        self.currentStateValue = initialState
    }

    func currentState() -> State {
        currentStateValue
    }

    func updateState(_ newState: State) {
        currentStateValue = newState
    }
}
