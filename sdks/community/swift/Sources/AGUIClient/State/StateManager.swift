// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Manages application state with snapshot and delta synchronization.
///
/// `StateManager` provides thread-safe state management with support for:
/// - Full state snapshots (`STATE_SNAPSHOT` events)
/// - Incremental updates using JSON Patch (`STATE_DELTA` events)
/// - State retrieval and reset
///
/// ## Usage
///
/// ```swift
/// let manager = StateManager()
///
/// // Handle snapshot event
/// await manager.handleSnapshot(snapshotEvent)
///
/// // Handle delta event
/// try await manager.handleDelta(deltaEvent)
///
/// // Get current state
/// let state = await manager.getState()
/// ```
///
/// ## Thread Safety
///
/// `StateManager` is an actor, providing automatic thread safety for all
/// state operations. All methods can be safely called from multiple
/// concurrent tasks.
///
/// ## State Lifecycle
///
/// 1. Initialize with empty state `{}`
/// 2. Receive `STATE_SNAPSHOT` → full state replacement
/// 3. Receive `STATE_DELTA` → apply JSON Patch operations
/// 4. Query current state with `getState()`
/// 5. Reset to empty state with `reset()`
///
/// - SeeAlso: `PatchApplicator`, `StateSnapshotEvent`, `StateDeltaEvent`
public actor StateManager {
    /// Current application state as raw JSON data.
    private var currentState: Data

    /// Patch applicator for applying delta updates.
    private let patchApplicator: PatchApplicator

    /// Creates a new state manager with empty initial state.
    ///
    /// The initial state is an empty JSON object `{}`.
    public init() {
        self.currentState = Data("{}".utf8)
        self.patchApplicator = PatchApplicator()
    }

    /// Handles a state snapshot event by replacing the current state.
    ///
    /// This method replaces the entire current state with the snapshot
    /// provided in the event. Use this for initial state or full resets.
    ///
    /// - Parameter event: The state snapshot event
    ///
    /// ## Example
    ///
    /// ```swift
    /// let snapshot = StateSnapshotEvent(
    ///     snapshot: Data("{\"users\":[],\"count\":0}".utf8)
    /// )
    /// await manager.handleSnapshot(snapshot)
    /// ```
    public func handleSnapshot(_ event: StateSnapshotEvent) {
        currentState = event.snapshot
    }

    /// Handles a state delta event by applying JSON Patch operations.
    ///
    /// This method applies the JSON Patch operations from the delta event
    /// to the current state, producing an updated state. If the patch
    /// cannot be applied (invalid operation, path not found, etc.), an
    /// error is thrown and the state remains unchanged.
    ///
    /// - Parameter event: The state delta event containing JSON Patch operations
    /// - Throws: `PatchApplicator.PatchError` if the patch cannot be applied
    ///
    /// ## Example
    ///
    /// ```swift
    /// let delta = StateDeltaEvent(
    ///     delta: Data("[{\"op\":\"add\",\"path\":\"/name\",\"value\":\"alice\"}]".utf8)
    /// )
    /// try await manager.handleDelta(delta)
    /// ```
    ///
    /// ## Error Handling
    ///
    /// If the patch fails to apply, the state is not modified and the error
    /// is propagated to the caller. Common errors include:
    /// - Invalid JSON in patch operations
    /// - Operations referencing non-existent paths
    /// - Type mismatches (e.g., removing from a non-object)
    /// - Test operations that fail
    public func handleDelta(_ event: StateDeltaEvent) throws {
        currentState = try patchApplicator.apply(patch: event.delta, to: currentState)
    }

    /// Returns the current application state.
    ///
    /// The state is returned as raw JSON data. You can parse it using
    /// `JSONSerialization` or decode it into a specific type using
    /// `JSONDecoder`.
    ///
    /// - Returns: The current state as JSON data
    ///
    /// ## Example
    ///
    /// ```swift
    /// let state = await manager.getState()
    ///
    /// // Parse as generic JSON
    /// let json = try JSONSerialization.jsonObject(with: state) as! [String: Any]
    ///
    /// // Or decode as specific type
    /// struct AppState: Decodable { /* ... */ }
    /// let appState = try JSONDecoder().decode(AppState.self, from: state)
    /// ```
    public func getState() -> Data {
        currentState
    }

    /// Resets the state to an empty JSON object.
    ///
    /// This method clears the current state and resets it to `{}`.
    /// Use this when starting a new session or clearing application data.
    ///
    /// ## Example
    ///
    /// ```swift
    /// await manager.reset()
    /// let state = await manager.getState()  // Returns Data("{}".utf8)
    /// ```
    public func reset() {
        currentState = Data("{}".utf8)
    }
}
