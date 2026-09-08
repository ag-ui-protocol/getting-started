// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Identifies a named slot in the ephemeral banner strip.
///
/// Each slot is independent — multiple slots can be visible simultaneously.
/// Slots differ in their display priority and dismissal behaviour, mirroring
/// the Kotlin Compose `chatapp` implementation.
enum EphemeralSlot: Hashable, CaseIterable, Comparable, Sendable {
    /// Shown while a tool call is in flight.
    /// Dismissed 1 second after `ToolCallEndEvent` arrives.
    case toolCall
    /// Shown while a reasoning step is active.
    /// Dismissed immediately (synchronously) when `StepFinishedEvent` arrives.
    case step

    /// Lower value renders closer to the top of the banner strip.
    var displayPriority: Int {
        switch self {
        case .step: return 0
        case .toolCall: return 1
        }
    }

    /// The delay to wait before clearing this slot from the banner strip.
    ///
    /// `nil` means dismiss immediately — no `Task.sleep` is scheduled.
    var dismissDelay: Duration? {
        switch self {
        case .toolCall: return .seconds(1)
        case .step: return nil
        }
    }

    static func < (lhs: EphemeralSlot, rhs: EphemeralSlot) -> Bool {
        lhs.displayPriority < rhs.displayPriority
    }
}
