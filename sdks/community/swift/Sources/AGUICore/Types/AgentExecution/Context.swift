// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents a piece of contextual information provided to an agent.
///
/// `Context` enables passing additional metadata, configuration, or environmental
/// information to agents beyond the conversation messages. This helps agents
/// understand the broader context of a conversation.
///
/// ## Use Cases
///
/// Context can be used for:
/// - **User Preferences**: Theme settings, language preferences, accessibility options
/// - **Session Information**: User ID, session tokens, authentication state
/// - **Environmental Data**: Timezone, location, device information
/// - **API Credentials**: Keys, tokens, or configuration for external services
/// - **Application State**: Current view, navigation context, feature flags
///
/// ## Structure
///
/// Each context item consists of:
/// - `description`: Human-readable description of what the context represents
/// - `value`: The actual context value as a string
///
/// ## Usage Examples
///
/// ```swift
/// // User preference context
/// let themeContext = Context(
///     description: "User theme preference",
///     value: "dark"
/// )
///
/// // Location context
/// let locationContext = Context(
///     description: "User location",
///     value: "San Francisco, CA"
/// )
///
/// // Multiple contexts in RunAgentInput
/// let input = RunAgentInput(
///     threadId: "thread-123",
///     runId: "run-456",
///     context: [themeContext, locationContext]
/// )
/// ```
///
/// ## Value Encoding
///
/// The `value` field is a string, but it can contain:
/// - Simple values: `"dark"`, `"en-US"`, `"12345"`
/// - Structured data as JSON strings: `"{\"name\": \"Alice\", \"role\": \"admin\"}"`
/// - Timestamps: `"2024-01-01T12:00:00Z"`
/// - Any other string-encoded data
///
/// - SeeAlso: ``RunAgentInput``
public struct Context: Sendable, Codable, Hashable {
    /// A human-readable description of the context.
    ///
    /// This field describes what the context value represents,
    /// helping agents understand how to interpret the value.
    ///
    /// Examples:
    /// - `"User theme preference"`
    /// - `"API authentication token"`
    /// - `"Current timezone"`
    public let description: String

    /// The context value.
    ///
    /// This can be any string value, including JSON-encoded structured data.
    public let value: String

    /// Creates a new context item.
    ///
    /// - Parameters:
    ///   - description: Human-readable description of the context
    ///   - value: The context value as a string
    public init(description: String, value: String) {
        self.description = description
        self.value = value
    }
}
