// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUITools
import Foundation

// MARK: - ChatAppToolRegistry

/// Factory for the ChatApp tool registry.
///
/// Creates and configures a `DefaultToolRegistry` with all client-side tool
/// executors registered. Callers provide callbacks for side effects (e.g.
/// background colour updates) to keep executors decoupled from the store.
enum ChatAppToolRegistry {

    /// Builds and returns a fully configured tool registry.
    ///
    /// - Parameter onBackground: Async closure invoked when the agent calls
    ///   `change_background`. Receives the color string, or `nil` when resetting
    ///   to the default background.
    /// - Returns: A `ToolRegistry` with `change_background` registered.
    /// - Throws: `ToolRegistryError` if registration fails.
    static func makeRegistry(
        onBackground: @escaping @Sendable (String?) async -> Void
    ) async throws -> any ToolRegistry {
        let registry = DefaultToolRegistry()
        let executor = ChangeBackgroundToolExecutor(onBackground: onBackground)
        try await registry.register(executor: executor)
        return registry
    }
}
