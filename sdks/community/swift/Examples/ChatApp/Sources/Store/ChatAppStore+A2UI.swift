// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - ChatAppStore + A2UI

extension ChatAppStore {

    // MARK: - Event processing

    /// Seeds a new A2UI surface from an activity snapshot and inserts a
    /// corresponding display message so the surface appears in the chat list.
    func processA2UISnapshot(_ event: ActivitySnapshotEvent) {
        surfaceManager.applySnapshot(event)
        state.a2uiSurfaces[event.messageId] = event.content
        upsertA2UIMessage(messageId: event.messageId)
    }

    /// Applies a JSON Patch delta to an existing A2UI surface.
    ///
    /// Silently ignores patches that arrive before their snapshot — the surface
    /// manager will throw, and the store swallows the error without crashing.
    func processA2UIDelta(_ event: ActivityDeltaEvent) {
        guard let updated = try? surfaceManager.applyDelta(event) else { return }
        state.a2uiSurfaces[event.messageId] = updated
    }

    // MARK: - Action routing

    /// Wire format for an A2UI action sent from client to agent.
    private struct A2UIActionEnvelope: Encodable {
        let type = "a2ui_action"
        let messageId: String
        let action: String
        let payload: [String: String]
    }

    /// Handles a user-initiated A2UI action.
    ///
    /// "cancel" stops the in-flight stream locally without contacting the server.
    /// All other actions are serialized as a typed `A2UIActionEnvelope` JSON
    /// message and forwarded to the agent via `sendMessage`.
    func handleA2UIAction(messageId: String, actionId: String, payload: [String: String]) {
        if actionId == "cancel" {
            cancelStreaming()
            return
        }

        let envelope = A2UIActionEnvelope(messageId: messageId, action: actionId, payload: payload)
        guard
            let data = try? JSONEncoder().encode(envelope),
            let json = String(data: data, encoding: .utf8)
        else { return }
        sendMessage(json)
    }

    // MARK: - Private helpers

    /// Inserts a `.a2uiSurface` display message if one for this `messageId` does not yet exist.
    private func upsertA2UIMessage(messageId: String) {
        let compositeId = "a2ui-\(messageId)"
        guard !state.messages.contains(where: { $0.id == compositeId }) else { return }
        let msg = DisplayMessage(
            id: compositeId,
            role: .a2uiSurface(messageId: messageId),
            content: "",
            timestamp: .now
        )
        state.messages.append(msg)
    }
}
