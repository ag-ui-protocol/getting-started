// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Snapshot of the chat UI that `ChatAppStore` publishes to SwiftUI views.
struct ChatUIState: Sendable {
    var messages: [DisplayMessage]
    /// Active ephemeral banners, keyed by slot type.
    ///
    /// Multiple slots can coexist. `.step` dismisses immediately on `StepFinishedEvent`;
    /// `.toolCall` dismisses 1 second after `ToolCallEndEvent`.
    var ephemeralSlots: [EphemeralSlot: DisplayMessage]
    /// System-level messages (connection status, inline errors) injected alongside chat messages.
    var supplementalMessages: [SupplementalMessage]
    var isLoading: Bool
    /// `true` when an active agent is configured and ready to receive messages.
    var isConnected: Bool
    var error: String?
    /// Hex color string for the chat background (e.g. `"FF5733"` or `"FF5733CC"`).
    var backgroundHex: String?
    var activeAgent: AgentConfig?
    /// Phase 4: Raw JSON data for each A2UI surface, keyed by `messageId`.
    ///
    /// Populated by `ActivitySnapshotEvent` and updated on each `ActivityDeltaEvent`.
    /// Surfaces are cleared when the active agent changes.
    var a2uiSurfaces: [String: Data]
    /// Phase 5: Current position in the ClawgUI enterprise pairing state machine.
    ///
    /// Non-idle values cause `RootView` to present the pairing sheet.
    /// Reset to `.idle` when the active agent changes or the user cancels.
    var clawgUIPairingState: ClawgUIPairingState

    init(
        messages: [DisplayMessage] = [],
        ephemeralSlots: [EphemeralSlot: DisplayMessage] = [:],
        supplementalMessages: [SupplementalMessage] = [],
        isLoading: Bool = false,
        isConnected: Bool = false,
        error: String? = nil,
        backgroundHex: String? = nil,
        activeAgent: AgentConfig? = nil,
        a2uiSurfaces: [String: Data] = [:],
        clawgUIPairingState: ClawgUIPairingState = .idle
    ) {
        self.messages = messages
        self.ephemeralSlots = ephemeralSlots
        self.supplementalMessages = supplementalMessages
        self.isLoading = isLoading
        self.isConnected = isConnected
        self.error = error
        self.backgroundHex = backgroundHex
        self.activeAgent = activeAgent
        self.a2uiSurfaces = a2uiSurfaces
        self.clawgUIPairingState = clawgUIPairingState
    }

    /// Unified list of all rows shown in the chat message list.
    ///
    /// Merges agent `messages` and `supplementalMessages`, sorted by timestamp
    /// so supplemental events (connection confirmation, inline errors) appear
    /// at the correct point in the conversation timeline.
    var chatRows: [ChatRow] {
        let agentRows = messages.map { ChatRow.agent($0) }
        let suppRows = supplementalMessages.map { ChatRow.supplemental($0) }
        return (agentRows + suppRows).sorted { $0.timestamp < $1.timestamp }
    }
}
