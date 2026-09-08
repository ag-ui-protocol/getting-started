// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Base protocol for multimodal content in user messages.
///
/// `InputContent` enables users to send rich, multimodal input to agents beyond
/// simple text. The protocol supports polymorphic content types distinguished by
/// a `type` discriminator field.
///
/// ## Content Types
///
/// The AG-UI protocol defines six concrete content types:
/// - ``TextInputContent``: Plain text fragments (`"text"`)
/// - ``BinaryInputContent``: Legacy catch-all binary data with MIME types (`"binary"`)
/// - ``ImageInputContent``: Images with optional detail level (`"image"`)
/// - ``AudioInputContent``: Audio with optional format (`"audio"`)
/// - ``VideoInputContent``: Video data (`"video"`)
/// - ``DocumentInputContent``: Documents with optional MIME type and title (`"document"`)
///
/// ## Polymorphic Serialization
///
/// Content types use the `type` field as a discriminator for JSON serialization:
/// - `"text"`: Deserializes to ``TextInputContent``
/// - `"binary"`: Deserializes to ``BinaryInputContent``
/// - `"image"`: Deserializes to ``ImageInputContent``
/// - `"audio"`: Deserializes to ``AudioInputContent``
/// - `"video"`: Deserializes to ``VideoInputContent``
/// - `"document"`: Deserializes to ``DocumentInputContent``
///
/// ## Usage in UserMessage
///
/// User messages can contain:
/// 1. **Simple text**: Single string content field
/// 2. **Multimodal**: Array of InputContent mixing text and binary data
///
/// ```swift
/// // Multimodal message with text and image
/// let contents: [any InputContent] = [
///     TextInputContent(text: "What's in this image?"),
///     BinaryInputContent(
///         mimeType: "image/png",
///         url: "https://example.com/photo.png"
///     )
/// ]
/// ```
///
/// ## Type Discrimination
///
/// The `type` property identifies the concrete content type during deserialization,
/// enabling the protocol to route JSON to the appropriate Swift type via DTOs.
///
/// ## Serialization
///
/// InputContent types use the DTO pattern for serialization:
/// - Decoding is handled by ``TextInputContentDTO`` and ``BinaryInputContentDTO``
/// - Encoding is handled by ``UserMessageDTO`` when encoding UserMessage
///
/// - SeeAlso: ``TextInputContent``, ``BinaryInputContent``, ``UserMessage``
public protocol InputContent: Sendable, Hashable {
    /// The content type discriminator.
    ///
    /// This field identifies the concrete content type:
    /// - `"text"` for ``TextInputContent``
    /// - `"binary"` for ``BinaryInputContent``
    ///
    /// The type field enables polymorphic deserialization, allowing mixed
    /// content arrays to contain different concrete types.
    var type: String { get }
}

// MARK: - Type-erased equality and hashing for existential arrays

extension InputContent {
    /// Returns `true` if `other` is the same concrete type and compares equal.
    ///
    /// Because `[any InputContent]` cannot use `==` directly on the existential,
    /// this helper downcasts to `Self` before delegating to the type's `Equatable`
    /// conformance. Used by ``UserMessage`` to compare `contentParts`.
    func isEqual(to other: any InputContent) -> Bool {
        guard let other = other as? Self else { return false }
        return self == other
    }

    /// A type-erased wrapper suitable for use with `Hasher`.
    ///
    /// In a protocol extension `self` is the concrete conforming type, so
    /// `AnyHashable(self)` wraps the underlying value without losing type
    /// information. Used by ``UserMessage`` to hash `contentParts`.
    var anyHashable: AnyHashable { AnyHashable(self) }
}
