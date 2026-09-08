// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A message containing system instructions and behavioral guidelines for the agent.
///
/// System messages provide high-level instructions, personality traits, behavioral
/// guidelines, and context that shape how the agent responds. These messages are
/// typically established at the conversation's start and remain active throughout
/// the interaction.
///
/// ## Use Cases
///
/// System messages are used for:
/// - Defining agent personality and tone
/// - Setting behavioral guidelines and constraints
/// - Providing domain-specific context
/// - Establishing response format preferences
/// - Configuring safety and ethical boundaries
///
/// ## Example
///
/// ```swift
/// let systemPrompt = SystemMessage(
///     id: "sys-1",
///     content: """
///     You are a professional coding assistant with expertise in Swift.
///     Always:
///     - Explain your reasoning
///     - Write clean, well-documented code
///     - Follow Swift best practices
///     - Be concise but thorough
///     """,
///     name: "SwiftExpert"
/// )
/// ```
///
/// ## Differences from DeveloperMessage
///
/// While both guide agent behavior:
/// - **SystemMessage**: High-level behavioral guidelines, personality, and response patterns
/// - **DeveloperMessage**: System-level technical configuration and meta-instructions
///
/// System messages focus on how the agent should communicate and behave, while
/// developer messages focus on technical constraints and system configuration.
///
/// - SeeAlso: ``Message``, ``DeveloperMessage``
public struct SystemMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.system`).
    public let role: Role

    /// The system's instruction content.
    ///
    /// This typically contains behavioral guidelines, personality traits,
    /// response format preferences, or contextual information.
    /// Matches the TypeScript schema `content: z.string()` — required, non-nullable.
    public let content: String

    /// Optional identifier for the system or instruction set.
    ///
    /// This can be used to identify different system personas, instruction
    /// sets, or behavioral modes (e.g., "ProfessionalMode", "CasualAssistant").
    public let name: String?

    /// Optional encrypted value associated with this message.
    ///
    /// When present, carries a cryptographic value produced by the agent's
    /// reasoning process.
    public let encryptedValue: String?

    /// Creates a new system message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The system's instruction content (optional)
    ///   - name: Optional identifier for the system or instruction set
    ///   - encryptedValue: Optional encrypted reasoning value
    public init(
        id: String,
        content: String = "",
        name: String? = nil,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .system
        self.content = content
        self.name = name
        self.encryptedValue = encryptedValue
    }
}

// MARK: - Decodable

extension SystemMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id
        case content
        case name
        case encryptedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        role = .system
        content = try container.decodeIfPresent(String.self, forKey: .content) ?? ""
        name = try container.decodeIfPresent(String.self, forKey: .name)
        encryptedValue = try container.decodeIfPresent(String.self, forKey: .encryptedValue)
    }
}
