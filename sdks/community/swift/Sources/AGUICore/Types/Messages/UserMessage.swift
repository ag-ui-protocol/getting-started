// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents a message from a user in the conversation.
///
/// `UserMessage` supports both simple text messages and multimodal messages
/// containing text, images, audio, documents, and other binary data.
///
/// ## Text-only Messages
///
/// For simple text input, use the standard initializer:
///
/// ```swift
/// let message = UserMessage(
///     id: "user-1",
///     content: "What is the weather like today?"
/// )
/// ```
///
/// ## Multimodal Messages
///
/// For rich input combining text and binary data, use the multimodal factory:
///
/// ```swift
/// let parts: [any InputContent] = [
///     TextInputContent(text: "What's in this image?"),
///     BinaryInputContent(
///         mimeType: "image/jpeg",
///         url: "https://example.com/photo.jpg"
///     )
/// ]
///
/// let message = UserMessage.multimodal(
///     id: "user-2",
///     parts: parts
/// )
/// ```
///
/// ## Serialization
///
/// UserMessage uses custom Codable serialization:
/// - **Text-only**: `content` field is a JSON string
/// - **Multimodal**: `content` field is a JSON array of InputContent objects
///
/// The serialization is transparent and handled automatically during encoding/decoding.
///
/// - SeeAlso: ``Message``, ``InputContent``, ``TextInputContent``, ``BinaryInputContent``
public struct UserMessage: Message, Sendable, Hashable {
    /// The unique identifier for this message.
    public let id: String

    /// The message role (always `.user`).
    public let role: Role

    /// The text content of the message.
    ///
    /// For text-only messages, this contains the user's input.
    /// For multimodal messages, this is empty and content is in `contentParts`.
    public let content: String?

    /// Optional name of the user sending the message.
    public let name: String?

    /// The multimodal content parts.
    ///
    /// This is `nil` for text-only messages and contains the array of
    /// InputContent for multimodal messages.
    public let contentParts: [any InputContent]?

    /// Optional encrypted value associated with this message.
    ///
    /// When present, carries a cryptographic value produced by the agent's
    /// reasoning process.
    public let encryptedValue: String?

    /// Whether this message contains multimodal content.
    ///
    /// Returns `true` if the message has `contentParts`, `false` for text-only.
    public var isMultimodal: Bool {
        contentParts != nil
    }

    /// Creates a text-only user message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - content: The text content
    ///   - name: Optional name of the user
    ///   - encryptedValue: Optional encrypted reasoning value
    public init(
        id: String,
        content: String,
        name: String? = nil,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = .user
        self.content = content
        self.name = name
        self.contentParts = nil
        self.encryptedValue = encryptedValue
    }

    /// Creates a multimodal user message with mixed text and binary content.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - parts: Array of InputContent (text and/or binary)
    ///   - name: Optional name of the user
    ///   - encryptedValue: Optional encrypted reasoning value
    /// - Returns: A multimodal UserMessage
    public static func multimodal(
        id: String,
        parts: [any InputContent],
        name: String? = nil,
        encryptedValue: String? = nil
    ) -> UserMessage {
        UserMessage(
            id: id,
            role: .user,
            content: "",
            name: name,
            contentParts: parts,
            encryptedValue: encryptedValue
        )
    }

    /// Internal initializer for creating multimodal messages.
    private init(
        id: String,
        role: Role,
        content: String,
        name: String?,
        contentParts: [any InputContent]?,
        encryptedValue: String? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.name = name
        self.contentParts = contentParts
        self.encryptedValue = encryptedValue
    }

    // MARK: - Hashable

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(role)
        hasher.combine(content)
        hasher.combine(name)
        contentParts?.forEach { hasher.combine($0.anyHashable) }
    }

    public static func == (lhs: UserMessage, rhs: UserMessage) -> Bool {
        guard lhs.id == rhs.id,
              lhs.role == rhs.role,
              lhs.content == rhs.content,
              lhs.name == rhs.name else { return false }
        switch (lhs.contentParts, rhs.contentParts) {
        case (nil, nil):
            return true
        case (let lParts?, let rParts?) where lParts.count == rParts.count:
            return zip(lParts, rParts).allSatisfy { $0.isEqual(to: $1) }
        default:
            return false
        }
    }
}
