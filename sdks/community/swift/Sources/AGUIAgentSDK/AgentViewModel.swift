// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

// Observation framework is available from iOS 17 / macOS 14.
// The #if canImport guard prevents import failures when compiling against
// an older SDK; the @available annotation on the class enforces runtime safety.
#if canImport(Observation)

import AGUICore
import Foundation
import Observation

/// `@Observable` view model for AG-UI agent conversations (iOS 17+ / macOS 14+).
///
/// `AgentViewModel` uses the Swift `Observation` framework (`@Observable` macro) to
/// provide automatic, fine-grained dependency tracking without `@Published` boilerplate.
/// SwiftUI views that read `messages`, `isRunning`, or `lastError` are re-rendered only
/// when those specific properties change.
///
/// For iOS 16 / macOS 13 support use ``AgentViewModelCompat`` (`ObservableObject`).
///
/// ## Basic SwiftUI usage
///
/// ```swift
/// @State private var vm = AgentViewModel(
///     agent: StatefulAgUiAgent(baseURL: agentURL)
/// )
///
/// var body: some View {
///     VStack {
///         ScrollView {
///             ForEach(vm.messages) { message in
///                 MessageBubble(message: message)
///             }
///         }
///         HStack {
///             TextField("Message", text: $draft)
///             Button("Send") {
///                 Task { await vm.send(draft) }
///             }
///             .disabled(vm.isRunning)
///         }
///         if let error = vm.lastError {
///             Text(error.localizedDescription).foregroundColor(.red)
///         }
///     }
/// }
/// ```
///
/// ## Streaming text
///
/// As the agent streams tokens, each `TextMessageContentEvent` delta is appended
/// to the last assistant `AgentMessage` in place — the message `id` stays the
/// same so SwiftUI animates the existing row rather than replacing it.
///
/// ## Error handling
///
/// - `RunErrorEvent` from the agent sets `lastError` as ``AgentError/runError(message:code:)``
/// - Transport-level failures (network, timeout) set `lastError` as whatever `Error` was thrown
/// - `lastError` is cleared automatically at the start of each new `send()` call
///
/// ## Thread safety
///
/// `AgentViewModel` is isolated to `@MainActor`. Call `send()` and `clear()`
/// from SwiftUI button handlers or `Task { }` blocks — they are already on the main actor.
///
/// - SeeAlso: ``AgentViewModelCompat``, ``ChatAgent``, ``AgentMessage``, ``AgentError``
@available(iOS 17, macOS 14, tvOS 17, watchOS 10, *)
@Observable
@MainActor
public final class AgentViewModel {

    // MARK: - Observable state

    /// The conversation messages in chronological order.
    ///
    /// User messages are appended synchronously at the start of `send()`.
    /// Assistant messages grow token-by-token as the stream delivers content.
    public private(set) var messages: [AgentMessage] = []

    /// `true` while an agent run is in progress.
    ///
    /// Bind this to a loading indicator or use it to disable the send button.
    public private(set) var isRunning: Bool = false

    /// The last error encountered, or `nil` if the most recent run succeeded.
    ///
    /// Set to `nil` automatically at the start of each `send()` call.
    public private(set) var lastError: Error? = nil

    // MARK: - Configuration

    /// The conversation thread identifier passed to the underlying agent.
    public let threadId: String

    // MARK: - Private

    private let agent: any ChatAgent

    // MARK: - Initialization

    /// Creates a view model backed by the given agent.
    ///
    /// - Parameters:
    ///   - agent: Any ``ChatAgent`` implementation (typically ``StatefulAgUiAgent``).
    ///   - threadId: Conversation thread identifier (default: `"default"`).
    public init(agent: any ChatAgent, threadId: String = "default") {
        self.agent = agent
        self.threadId = threadId
    }

    // MARK: - Public API

    /// Sends a user message and streams the agent's response into `messages`.
    ///
    /// If a run is already in progress this call is a no-op (the guard prevents
    /// concurrent runs on the same view model instance).
    ///
    /// - Parameter text: The user's message text.
    public func send(_ text: String) async {
        guard !isRunning else { return }
        isRunning = true
        lastError = nil

        messages.append(AgentMessage(role: .user, content: text))

        // Track assistant messages by their protocol messageId so out-of-order
        // deltas (unlikely but spec-valid) still land in the right message.
        var assistantIndices: [String: Int] = [:]

        do {
            let stream = try await agent.chat(message: text, threadId: threadId)
            for try await event in stream {
                switch event {
                case let e as TextMessageStartEvent:
                    messages.append(AgentMessage(role: .assistant, content: ""))
                    assistantIndices[e.messageId] = messages.count - 1

                case let e as TextMessageContentEvent:
                    guard let idx = assistantIndices[e.messageId] else { break }
                    let current = messages[idx]
                    messages[idx] = AgentMessage(
                        id: current.id,
                        role: .assistant,
                        content: current.content + e.delta
                    )

                case let e as RunErrorEvent:
                    lastError = AgentError.runError(message: e.message, code: e.code)

                default:
                    break
                }
            }
        } catch {
            lastError = error
        }

        isRunning = false
    }

    /// Clears all displayed messages and the agent's internal conversation history.
    public func clear() async {
        messages = []
        await agent.clearHistory(threadId: threadId)
    }
}

#endif
