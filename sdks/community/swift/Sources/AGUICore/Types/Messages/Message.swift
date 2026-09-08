// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Base protocol for all message types in the AG-UI protocol.
///
/// Messages represent communication between different entities in an agent conversation:
/// developers, systems, AI assistants, users, tools, and activities. Each message type
/// is identified by its ``Role``, which serves as the discriminator for polymorphic
/// message deserialization.
///
/// ## Common Properties
///
/// All messages share these properties:
/// - ``id``: Unique identifier for the message instance
/// - ``role``: The sender's role (developer, system, assistant, user, tool, activity)
/// - ``name``: Optional identifier for the sender
///
/// ## Message Types
///
/// The protocol is implemented by six concrete message types:
/// - ``DeveloperMessage``: System-level configuration and instructions
/// - ``SystemMessage``: Agent behavioral guidelines and instructions
/// - ``AssistantMessage``: AI agent responses, possibly with tool calls
/// - ``UserMessage``: Human input supporting text and multimodal content
/// - ``ToolMessage``: Results from tool/function executions
/// - ``ActivityMessage``: Streaming structured JSON for custom UI surfaces
///
/// ## Polymorphic Deserialization
///
/// In the AG-UI protocol, messages are serialized with a "role" field that indicates
/// their concrete type. The role field enables protocol implementations to deserialize
/// JSON into the appropriate concrete message type.
///
/// ## Concurrency
///
/// All message types must conform to `Sendable` to safely cross actor isolation
/// boundaries in Swift's structured concurrency model.
///
/// ## Example
///
/// ```swift
/// // Creating different message types
/// let systemMsg = SystemMessage(
///     id: "msg-1",
///     content: "You are a helpful assistant."
/// )
///
/// let userMsg = UserMessage(
///     id: "msg-2",
///     content: "Hello, how can you help me?"
/// )
///
/// // All messages conform to the same protocol
/// let messages: [any Message] = [systemMsg, userMsg]
/// ```
///
/// - SeeAlso: ``Role``
public protocol Message: Sendable {
    /// Unique identifier for this message.
    ///
    /// Message IDs should be unique within a conversation thread to enable
    /// referencing and tracking individual messages.
    var id: String { get }

    /// The role of the message sender.
    ///
    /// This property serves as the discriminator for polymorphic message types,
    /// identifying whether the message comes from a developer, system, assistant,
    /// user, tool, or activity.
    ///
    /// - SeeAlso: ``Role``
    var role: Role { get }

    /// Optional identifier for the message sender.
    ///
    /// This can be used to:
    /// - Identify specific users in multi-user conversations
    /// - Label different AI agents in multi-agent systems
    /// - Tag tool invocations with descriptive names
    var name: String? { get }

    /// Optional encrypted value associated with this message.
    ///
    /// When present, carries a cryptographic value produced by the agent's
    /// reasoning process (e.g., from a ``ReasoningEncryptedValueEvent``).
    var encryptedValue: String? { get }
}
