// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// AGUIClient provides HTTP transport and streaming capabilities for AG-UI agents.
///
/// This module contains the low-level client infrastructure including:
/// - HTTP transport with URLSession
/// - Server-Sent Events (SSE) parsing
/// - Event stream management
/// - State synchronization
///
/// ## Usage
///
/// ```swift
/// import AGUIClient
///
/// let agent = HttpAgent(baseURL: agentURL)
/// for try await event in try await agent.run(input) {
///     // Process events
/// }
/// ```
public struct AGUIClient {
    /// The version of the AGUIClient module.
    public static let version = "0.1.0"

    private init() {}
}
