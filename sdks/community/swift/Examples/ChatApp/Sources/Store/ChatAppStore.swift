// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIAgentSDK
import AGUICore
import Foundation

// MARK: - ChatAppStore

/// Central store that drives the entire chat UI.
///
/// All `@Published` mutations run on the main actor. The streaming
/// `Task` suspends the main actor only during network waits, so UI
/// updates remain snappy.
///
/// Event processing logic lives in `ChatAppStore+EventProcessing.swift`.
@MainActor
final class ChatAppStore: ObservableObject {

    // MARK: - Published state

    @Published var state: ChatUIState = .init()
    @Published private(set) var agents: [AgentConfig] = []
    @Published var formMode: AgentFormMode?
    @Published var draft: AgentDraft = .init()
    @Published var repositoryError: String?

    // MARK: - Private state

    private var agent: StatefulAgUiAgent?
    private var streamingTask: Task<Void, Never>?
    /// messageId → index in `state.messages` for O(1) delta updates.
    var streamingMessageIndices: [String: Int] = [:]
    /// Per-slot dismiss tasks; keyed so TOOL_CALL and STEP cancel independently.
    var ephemeralDismissTasks: [EphemeralSlot: Task<Void, Never>] = [:]
    /// Override dismiss delays for testing (avoids real 1-second waits in tests).
    ///
    /// Set entries before processing events in tests. Production code never mutates this.
    var ephemeralDismissDelayOverrides: [EphemeralSlot: Duration] = [:]
    /// The `id` of the optimistic user message currently awaiting agent confirmation.
    var pendingUserMessageId: String?
    /// Buffered tool-call arguments keyed by toolCallId.
    ///
    /// Populated on `ToolCallStartEvent`, appended on `ToolCallArgsEvent`,
    /// removed on `ToolCallEndEvent`. Marked `internal` for test inspection.
    var toolCallArgBuffer: [String: String] = [:]
    /// Phase 4: Manages raw JSON state for each A2UI surface.
    let surfaceManager = A2UISurfaceStateManager()
    /// Phase 5: Drives the ClawgUI enterprise pairing state machine.
    let pairingManager: ClawgUIPairingManager
    /// Phase 5: Config awaiting agent build after successful ClawgUI pairing.
    private var pendingAgentConfig: AgentConfig?

    // MARK: - Persistence

    private let defaults: UserDefaults
    private static let agentsKey = "chatapp.agents"
    private static let activeAgentIdKey = "chatapp.activeAgentId"

    var selectedAgentId: String? { state.activeAgent?.id }

    // MARK: - Init

    init(defaults: UserDefaults = .standard, pairingManager: ClawgUIPairingManager? = nil) {
        self.defaults = defaults
        // Default-parameter expressions cannot call @MainActor inits in Swift 6;
        // create the manager in the body where main-actor isolation is guaranteed.
        self.pairingManager = pairingManager ?? ClawgUIPairingManager()
        agents = Self.loadAgents(from: defaults)
        setupPairingCallbacks()
        if let id = defaults.string(forKey: Self.activeAgentIdKey),
           let config = agents.first(where: { $0.id == id }) {
            startAgentOrPairing(config: config)
        }
    }

    // MARK: - Chat actions

    func sendMessage(_ text: String) {
        guard let agent else { return }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Cancel any in-flight stream and clean up ephemeral state.
        cancelStreaming()
        streamingMessageIndices.removeAll()

        // Phase 1C: Optimistic user message — shown immediately before agent ack.
        let messageId = UUID().uuidString
        let userMsg = DisplayMessage(
            id: messageId,
            role: .user,
            content: trimmed,
            timestamp: .now,
            isSending: true
        )
        state.messages.append(userMsg)
        pendingUserMessageId = messageId
        state.isLoading = true

        streamingTask = Task { [weak self] in
            guard let self else { return }
            defer {
                self.state.isLoading = false
                // Clear all ephemeral banners and their scheduled dismissals.
                self.state.ephemeralSlots.removeAll()
                for task in self.ephemeralDismissTasks.values { task.cancel() }
                self.ephemeralDismissTasks.removeAll()
                self.finishStreamingMessages()
            }
            do {
                let stream = try await agent.chat(message: trimmed)
                for try await event in stream {
                    self.processEvent(event)
                }
            } catch is CancellationError {
                // User cancelled — remove the optimistic message and show no error.
                if let pendingId = self.pendingUserMessageId {
                    self.state.messages.removeAll { $0.id == pendingId }
                    self.pendingUserMessageId = nil
                }
            } catch {
                // On error: keep the optimistic message but mark it as no longer sending.
                if let pendingId = self.pendingUserMessageId,
                   let idx = self.state.messages.firstIndex(where: { $0.id == pendingId }) {
                    self.state.messages[idx].isSending = false
                    self.pendingUserMessageId = nil
                }
                self.state.error = error.localizedDescription
            }
        }
    }

    func cancelStreaming() {
        streamingTask?.cancel()
        streamingTask = nil
        // Cancel any pending ephemeral dismissal timers.
        for task in ephemeralDismissTasks.values { task.cancel() }
        ephemeralDismissTasks.removeAll()
        state.ephemeralSlots.removeAll()
        toolCallArgBuffer.removeAll()
        // Clear the optimistic pending message.
        if let pendingId = pendingUserMessageId {
            state.messages.removeAll { $0.id == pendingId }
            pendingUserMessageId = nil
        }
    }

    func dismissError() {
        state.error = nil
    }

    // MARK: - Agent management

    func setActiveAgent(id: String?) {
        guard id != state.activeAgent?.id else { return }
        cancelStreaming()
        streamingMessageIndices.removeAll()
        toolCallArgBuffer.removeAll()
        surfaceManager.reset()
        // Phase 5: Cancel any in-flight pairing when switching agents.
        pairingManager.reset()
        pendingAgentConfig = nil

        if let id, let config = agents.first(where: { $0.id == id }) {
            startAgentOrPairing(config: config)
        } else {
            agent = nil
            state = ChatUIState()
        }
        saveActiveAgentId(id)
    }

    func presentCreateAgent() {
        draft = AgentDraft()
        formMode = .create
    }

    func presentEditAgent(_ config: AgentConfig) {
        draft = AgentDraft(from: config)
        formMode = .edit(config)
    }

    func dismissAgentForm() {
        formMode = nil
    }

    func saveAgent() {
        guard let mode = formMode, draft.isValid else { return }

        switch mode {
        case .create:
            let config = draft.toAgentConfig()
            agents.append(config)
            persistAgents()
            formMode = nil
            setActiveAgent(id: config.id)

        case .edit(let existing):
            let config = draft.toAgentConfig(existingId: existing.id)
            if let idx = agents.firstIndex(where: { $0.id == existing.id }) {
                agents[idx] = config
                persistAgents()
            }
            formMode = nil
            if config.id == state.activeAgent?.id {
                buildAgent(from: config)
            }
        }
    }

    func deleteAgent(id: String) {
        agents.removeAll { $0.id == id }
        persistAgents()

        if state.activeAgent?.id == id {
            cancelStreaming()
            pairingManager.reset()
            pendingAgentConfig = nil
            if let next = agents.first {
                buildAgent(from: next)
                saveActiveAgentId(next.id)
            } else {
                agent = nil
                state = ChatUIState()
                saveActiveAgentId(nil)
            }
        }
    }

    // MARK: - ClawgUI pairing (Phase 5)

    /// Called when the user taps "I've Authorized" in the pairing sheet.
    func confirmPairing() {
        pairingManager.confirmApproval()
    }

    /// Called when the user taps "Retry" in the pairing sheet.
    func retryPairing() {
        Task { await pairingManager.retryConnection() }
    }

    /// Called when the user cancels the pairing sheet.
    func resetPairing() {
        pairingManager.reset()
        pendingAgentConfig = nil
    }

    // MARK: - Testing support

    /// Resets state and configures an active agent for unit tests.
    func setupForTesting(agent config: AgentConfig) {
        state = ChatUIState(isConnected: true, activeAgent: config)
        streamingMessageIndices = [:]
        ephemeralDismissTasks.removeAll()
        toolCallArgBuffer.removeAll()
        pendingUserMessageId = nil
        surfaceManager.reset()
        pairingManager.reset()
        pendingAgentConfig = nil
    }

    /// Injects an optimistic user message for unit tests without going through `sendMessage`.
    func injectPendingMessageForTesting(content: String) {
        let id = UUID().uuidString
        let msg = DisplayMessage(id: id, role: .user, content: content, isSending: true)
        state.messages.append(msg)
        pendingUserMessageId = id
    }

    // MARK: - Private helpers

    /// Routes to the ClawgUI pairing flow or directly builds the agent, depending on the URL.
    private func startAgentOrPairing(config: AgentConfig) {
        if ClawgUIDetector.isClawgUIEndpoint(config.url) {
            pendingAgentConfig = config
            Task { [weak self] in
                guard let self, let url = URL(string: config.url) else { return }
                await self.pairingManager.initiatePairing(agentURL: url)
            }
        } else {
            buildAgent(from: config)
        }
    }

    /// Wires up `pairingManager` callbacks so state changes are mirrored into `ChatUIState`
    /// and a successful pairing triggers agent construction.
    private func setupPairingCallbacks() {
        pairingManager.onStateChange = { [weak self] pairingState in
            self?.state.clawgUIPairingState = pairingState
        }
        pairingManager.onPairingSuccess = { [weak self] in
            guard let self, let config = self.pendingAgentConfig else { return }
            self.pendingAgentConfig = nil
            self.buildAgent(from: config)
        }
    }

    private func buildAgent(from config: AgentConfig) {
        do {
            let baseConfig = try config.toStatefulAgentConfig()
            // Create the agent immediately (no tool registry yet) so the UI is usable right away.
            agent = StatefulAgUiAgent(configuration: baseConfig)
            state = ChatUIState(isConnected: true, activeAgent: config)
            // Phase 1B: Record the connection as an in-chat supplemental message.
            appendSupplemental(SupplementalMessage(
                id: UUID().uuidString,
                kind: .connection(agentName: config.name),
                timestamp: .now
            ))

            // Phase 2B: Asynchronously enhance the agent with client-side tool executors.
            // The agent remains functional during setup; tools are added once ready.
            Task { [weak self] in
                guard let self else { return }
                do {
                    let registry = try await ChatAppToolRegistry.makeRegistry { [weak self] hex in
                        await MainActor.run { self?.state.backgroundHex = hex }  // nil = reset to default
                    }
                    var configWithTools = baseConfig
                    configWithTools.toolRegistry = registry
                    self.agent = StatefulAgUiAgent(configuration: configWithTools)
                } catch {
                    // Tool registry setup failed — agent continues without client-side tools.
                }
            }
        } catch {
            state.error = error.localizedDescription
        }
    }

    func finishStreamingMessages() {
        for idx in state.messages.indices where state.messages[idx].isStreaming {
            state.messages[idx].isStreaming = false
        }
        streamingMessageIndices.removeAll()
        toolCallArgBuffer.removeAll()
    }

    // MARK: - Persistence helpers

    private static func loadAgents(from defaults: UserDefaults) -> [AgentConfig] {
        guard
            let data = defaults.data(forKey: agentsKey),
            let decoded = try? JSONDecoder().decode([AgentConfig].self, from: data)
        else { return [] }
        return decoded
    }

    private func persistAgents() {
        if let encoded = try? JSONEncoder().encode(agents) {
            defaults.set(encoded, forKey: Self.agentsKey)
        }
    }

    private func saveActiveAgentId(_ id: String?) {
        defaults.set(id, forKey: Self.activeAgentIdKey)
    }
}
