// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A message containing the agent's internal chain-of-thought reasoning.
///
/// `ReasoningMessage` represents the reasoning steps an AI agent produces during
/// a reasoning phase. It is built up incrementally by streaming reasoning events
/// (`ReasoningMessageStart`, `ReasoningMessageContent`, `ReasoningMessageEnd`).
///
/// ## Content
///
/// The `content` field contains the agent's reasoning text, which may be empty
/// at the start of streaming and populated as content events arrive.
///
/// ## Encrypted Value
///
/// The optional `encryptedValue` field carries a cryptographic value produced
/// by the agent's reasoning process, delivered via ``ReasoningEncryptedValueEvent``.
/// It can be used in verified reasoning workflows to authenticate the reasoning output.
///
/// ## Example
///
/// ```swift
/// let reasoning = ReasoningMessage(
///     id: "reasoning-1",
///     content: "Let me think step by step about this problem..."
/// )
///
/// // With an encrypted value for verified reasoning
/// let verifiedReasoning = ReasoningMessage(
///     id: "reasoning-2",
///     content: "First, I need to analyse the inputs...",
///     encryptedValue: "<encrypted-token>"
/// )
/// ```
///
/// - SeeAlso: ``Message``, ``Role``, ``ReasoningStartEvent``, ``ReasoningEncryptedValueEvent``
public struct ReasoningMessage: Message, Sendable, Hashable {
    /// The unique identifier for this message.
    public let id: String

    /// The message role (always `.reasoning`).
    public let role: Role

    /// The agent's reasoning text content.
    ///
    /// This is the chain-of-thought or internal reasoning the agent produced.
    /// Returned as `String?` to satisfy the `Message` protocol; in practice
    /// this value is always present.
    public let content: String?

    /// Sender name (always `nil` for reasoning messages).
    ///
    /// The AG-UI protocol does not define a `name` field for reasoning messages.
    public let name: String? = nil

    /// Optional encrypted value for this reasoning message.
    ///
    /// When present, carries a cryptographic value delivered via
    /// ``ReasoningEncryptedValueEvent`` for verified reasoning workflows.
    public let encryptedValue: String?

    /// Creates a new reasoning message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - content: The agent's reasoning text (non-nil)
    ///   - encryptedValue: Optional encrypted reasoning value
    public init(
        id: String,
        content: String,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .reasoning
        self.content = content
        self.encryptedValue = encryptedValue
    }
}
