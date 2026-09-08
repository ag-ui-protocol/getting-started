// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A message containing system-level instructions and configuration.
///
/// Developer messages provide system-level instructions, configuration, and
/// administrative communication that differs from regular system prompts. They
/// typically contain meta-instructions about how the agent should behave or
/// technical configuration details.
///
/// ## Use Cases
///
/// Developer messages are used for:
/// - System configuration and initialization
/// - Meta-instructions about agent behavior
/// - Technical constraints and requirements
/// - Administrative control messages
/// - Debug and logging configuration
///
/// ## Example
///
/// ```swift
/// let configMessage = DeveloperMessage(
///     id: "dev-config-1",
///     content: """
///     System configuration:
///     - Enable debug logging
///     - Set max response length to 2000 tokens
///     - Use conservative safety settings
///     """,
///     name: "SystemConfigurator"
/// )
/// ```
///
/// ## Differences from SystemMessage
///
/// While both developer and system messages guide agent behavior:
/// - **DeveloperMessage**: System-level technical configuration and meta-instructions
/// - **SystemMessage**: High-level behavioral guidelines and personality instructions
///
/// Developer messages typically contain more technical, configuration-oriented
/// content, while system messages focus on behavioral patterns and response style.
///
/// - SeeAlso: ``Message``, ``SystemMessage``
public struct DeveloperMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.developer`).
    public let role: Role

    /// The developer's message content.
    ///
    /// This typically contains system-level instructions, configuration details,
    /// or meta-instructions about agent behavior.
    ///
    /// While the protocol allows optional content, developer messages in practice
    /// always contain content, so the initializer requires a non-nil value.
    public let content: String?

    /// Optional identifier for the developer or system.
    ///
    /// This can be used to identify which developer, system component, or
    /// configuration module generated the message.
    public let name: String?

    /// Optional encrypted value associated with this message.
    ///
    /// When present, carries a cryptographic value produced by the agent's
    /// reasoning process.
    public let encryptedValue: String?

    /// Creates a new developer message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The developer's message content
    ///   - name: Optional identifier for the developer or system
    ///   - encryptedValue: Optional encrypted reasoning value
    public init(
        id: String,
        content: String,
        name: String? = nil,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .developer
        self.content = content
        self.name = name
        self.encryptedValue = encryptedValue
    }
}

// MARK: - Decodable

extension DeveloperMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id
        case content
        case name
        case encryptedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = .developer
        content = try container.decode(String.self, forKey: .content)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        encryptedValue = try container.decodeIfPresent(String.self, forKey: .encryptedValue)
    }
}
