// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import Foundation

// MARK: - A2UIError

/// Errors produced by `A2UISurfaceStateManager`.
enum A2UIError: Error, Sendable {
    /// A delta arrived for a surface that has no snapshot yet.
    case surfaceNotFound(messageId: String)
}

// MARK: - A2UISurfaceStateManager

/// Manages the raw JSON state for each A2UI surface by `messageId`.
///
/// `applySnapshot` seeds the surface state from an `ActivitySnapshotEvent`.
/// `applyDelta` applies an RFC 6902 JSON Patch from an `ActivityDeltaEvent`.
///
/// Designed as a `@MainActor` class rather than an actor so it shares
/// the store's isolation domain without actor-hopping overhead.
@MainActor
final class A2UISurfaceStateManager {

    // MARK: - Private state

    private var surfaces: [String: Data] = [:]

    // MARK: - API

    /// Replaces (or seeds) the surface state for `event.messageId`.
    func applySnapshot(_ event: ActivitySnapshotEvent) {
        surfaces[event.messageId] = event.content
    }

    /// Applies the RFC 6902 patch from `event` to the stored surface state.
    ///
    /// - Returns: The updated surface data.
    /// - Throws: `A2UIError.surfaceNotFound` if no snapshot exists for this `messageId`,
    ///           or a `PatchError` if the patch is malformed or a path is missing.
    func applyDelta(_ event: ActivityDeltaEvent) throws -> Data {
        guard let current = surfaces[event.messageId] else {
            throw A2UIError.surfaceNotFound(messageId: event.messageId)
        }
        let updated = try PatchApplicator().apply(patch: event.patch, to: current)
        surfaces[event.messageId] = updated
        return updated
    }

    /// Returns the current raw JSON data for a surface, or `nil` if not yet seeded.
    func surfaceData(for messageId: String) -> Data? {
        surfaces[messageId]
    }

    /// Removes all surface state. Call when switching agents.
    func reset() {
        surfaces.removeAll()
    }
}
