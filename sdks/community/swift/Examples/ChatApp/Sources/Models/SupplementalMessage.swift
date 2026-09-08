// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A non-agent system message injected into the chat list for lifecycle events.
///
/// Examples: agent connection confirmation, inline error notifications.
/// Rendered as distinct, non-interactive rows by `SupplementalMessageBubbleView`.
struct SupplementalMessage: Identifiable, Sendable {
    let id: String
    let kind: Kind
    let timestamp: Date

    // MARK: - Kind

    enum Kind: Sendable {
        /// Shown when an agent connection is established successfully.
        case connection(agentName: String)
        /// Shown inline when a run fails (in addition to the error alert).
        case error(message: String)
    }
}
