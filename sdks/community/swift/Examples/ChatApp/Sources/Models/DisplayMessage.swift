// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - DisplayMessage

/// A UI-only model that represents a single row in the chat message list.
///
/// Built from AG-UI protocol events in `ChatAppStore`; not persisted.
struct DisplayMessage: Identifiable, Sendable {
    let id: String
    let role: DisplayMessageRole
    var content: String
    let timestamp: Date
    /// `true` while `TextMessageContent` events are still arriving.
    var isStreaming: Bool
    /// `true` while the user message is waiting for agent confirmation.
    ///
    /// Set on the optimistic message created by `sendMessage`; cleared once the
    /// agent echoes the message back in a `MessagesSnapshotEvent`, or on
    /// cancellation / error.
    var isSending: Bool

    init(
        id: String = UUID().uuidString,
        role: DisplayMessageRole,
        content: String,
        timestamp: Date = .now,
        isStreaming: Bool = false,
        isSending: Bool = false
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.isSending = isSending
    }

    // MARK: - Phase 3: Animation state helpers

    /// `true` when the agent has started responding but no tokens have arrived yet.
    ///
    /// Drives the animated typing indicator in `MessageBubbleView`.
    var showsTypingIndicator: Bool { isStreaming && content.isEmpty }

    /// `true` when tokens are actively streaming in and there is content to show.
    ///
    /// Drives the blinking cursor appended to streaming text in `MessageBubbleView`.
    var showsStreamingCursor: Bool { isStreaming && !content.isEmpty }
}

// MARK: - DisplayMessageRole

enum DisplayMessageRole: Sendable, Hashable {
    case user
    case assistant
    case system
    case error
    case toolCall(name: String)
    case stepInfo(name: String)
    /// An A2UI generative-UI surface. The associated `messageId` keys into
    /// `ChatUIState.a2uiSurfaces` for the raw JSON data.
    case a2uiSurface(messageId: String)
}
