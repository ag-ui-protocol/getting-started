// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Unified list-item type for the chat message list.
///
/// Merges ``DisplayMessage`` (agent-originated content) and
/// ``SupplementalMessage`` (system-originated events) into a single
/// sequence for `ForEach` iteration in `ChatView`.
enum ChatRow: Identifiable, Sendable {
    case agent(DisplayMessage)
    case supplemental(SupplementalMessage)

    // MARK: - Identifiable

    var id: String {
        switch self {
        case .agent(let m): return m.id
        case .supplemental(let s): return s.id
        }
    }

    // MARK: - Sorting

    var timestamp: Date {
        switch self {
        case .agent(let m): return m.timestamp
        case .supplemental(let s): return s.timestamp
        }
    }
}
