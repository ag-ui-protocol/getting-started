// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents agent state as JSON data.
///
/// State is a type alias for `Data` that represents arbitrary JSON-formatted state
/// information passed to and from agents during execution. The state can contain
/// any JSON-serializable data structure including objects, arrays, primitives, and null.
///
/// ## Usage
///
/// State is primarily used in ``RunAgentInput`` to provide contextual information
/// to agents. Applications can encode their state models as JSON and pass them
/// to agent endpoints.
///
/// ```swift
/// // Create state from a Codable model
/// struct AppState: Codable {
///     let sessionId: String
///     let preferences: [String: String]
/// }
///
/// let appState = AppState(
///     sessionId: "session-123",
///     preferences: ["theme": "dark"]
/// )
/// let state: State = try JSONEncoder().encode(appState)
///
/// // Or create state from raw JSON
/// let jsonState: State = Data("""
/// {
///     "counter": 42,
///     "items": ["a", "b", "c"]
/// }
/// """.utf8)
/// ```
///
/// ## Default State
///
/// An empty JSON object `{}` is typically used as the default state:
///
/// ```swift
/// let emptyState: State = Data("{}".utf8)
/// ```
///
/// ## Type Design
///
/// This is intentionally a simple type alias rather than a custom type to maintain
/// flexibility. Applications can:
/// - Encode any Codable type into State
/// - Decode State into any expected Codable type
/// - Manipulate State as raw Data when needed
/// - Pass State across actor boundaries (Data is Sendable)
///
/// Future versions may introduce a more structured `JSONValue` enum if type safety
/// benefits outweigh flexibility concerns.
///
/// - Note: State must contain valid JSON data. Invalid JSON will cause decoding
///   errors when processed by agents or client code.
///
/// - SeeAlso: ``RunAgentInput``
public typealias State = Data
