// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents binary data (images, audio, documents) in multimodal user input.
///
/// `BinaryInputContent` enables users to include rich media in their messages,
/// supporting images, audio, video, documents, and other binary formats. Binary
/// content can be provided via URL, identifier, or embedded base64-encoded data.
///
/// ## Source Options
///
/// Binary content must specify at least one source:
/// - **URL**: Link to externally hosted content
/// - **ID**: Identifier for content stored in a content management system
/// - **Data**: Base64-encoded binary data embedded directly in the message
///
/// ## MIME Types
///
/// The `mimeType` field identifies the content format:
/// - Images: `"image/jpeg"`, `"image/png"`, `"image/gif"`, `"image/webp"`
/// - Documents: `"application/pdf"`, `"application/msword"`
/// - Audio: `"audio/mpeg"`, `"audio/wav"`, `"audio/ogg"`
/// - Video: `"video/mp4"`, `"video/webm"`
///
/// ## Usage Examples
///
/// ```swift
/// // Image from URL
/// let imageContent = BinaryInputContent(
///     mimeType: "image/jpeg",
///     url: "https://example.com/photo.jpg",
///     filename: "vacation.jpg"
/// )
///
/// // Embedded base64 image
/// let embeddedImage = BinaryInputContent(
///     mimeType: "image/png",
///     data: "iVBORw0KGgoAAAANSUhEUg...",
///     filename: "screenshot.png"
/// )
///
/// // Document by ID
/// let document = BinaryInputContent(
///     mimeType: "application/pdf",
///     id: "doc-annual-report-2024"
/// )
///
/// // Multimodal message
/// let contents: [any InputContent] = [
///     TextInputContent(text: "Analyze this image and document:"),
///     imageContent,
///     document
/// ]
/// ```
///
/// ## Content Source Selection
///
/// When multiple sources are provided, the consuming system typically prioritizes:
/// 1. **Data** (embedded): Fastest, no external fetch required
/// 2. **URL**: Enables streaming large files
/// 3. **ID**: Requires content management system integration
///
/// - SeeAlso: ``InputContent``, ``TextInputContent``, ``UserMessage``
public struct BinaryInputContent: InputContent {
    /// Validation errors for BinaryInputContent
    public enum ValidationError: Error, LocalizedError {
        case noSourceProvided

        public var errorDescription: String? {
            switch self {
            case .noSourceProvided:
                return "BinaryInputContent requires id, url, or data to be provided"
            }
        }
    }

    /// The content type discriminator (always "binary").
    public let type: String

    /// The MIME type identifying the binary content format.
    ///
    /// Common MIME types:
    /// - Images: `image/jpeg`, `image/png`, `image/gif`
    /// - Documents: `application/pdf`, `text/plain`
    /// - Audio: `audio/mpeg`, `audio/wav`
    /// - Video: `video/mp4`, `video/quicktime`
    public let mimeType: String

    /// Optional identifier for retrieving the binary content.
    ///
    /// Used when content is stored in a content management system or
    /// blob storage and can be retrieved by ID.
    public let id: String?

    /// Optional URL pointing to the binary content.
    ///
    /// The URL should be accessible to the agent system and return the
    /// binary content with the specified MIME type.
    public let url: String?

    /// Optional base64-encoded binary data.
    ///
    /// For smaller files (images under ~1MB, short audio clips), data can be
    /// embedded directly in the message as base64. Larger files should use
    /// URL or ID references.
    public let data: String?

    /// Optional original filename of the binary content.
    ///
    /// Provides context about the content and can be used when saving
    /// or displaying the file.
    public let filename: String?

    /// Creates a new binary content instance.
    ///
    /// - Parameters:
    ///   - mimeType: The MIME type of the binary content
    ///   - id: Optional identifier for content retrieval
    ///   - url: Optional URL pointing to the content
    ///   - data: Optional base64-encoded binary data
    ///   - filename: Optional original filename
    ///
    /// - Throws: `ValidationError.noSourceProvided` if none of id, url, or data are provided
    public init(
        mimeType: String,
        id: String? = nil,
        url: String? = nil,
        data: String? = nil,
        filename: String? = nil
    ) throws {
        // Validate that at least one source is provided
        try Self.validate(mimeType: mimeType, id: id, url: url, data: data)

        self.type = "binary"
        self.mimeType = mimeType
        self.id = id
        self.url = url
        self.data = data
        self.filename = filename
    }

    /// Validates that at least one source field is provided.
    internal static func validate(
        mimeType: String,
        id: String?,
        url: String?,
        data: String?
    ) throws {
        guard id != nil || url != nil || data != nil else {
            throw ValidationError.noSourceProvided
        }
    }
}

// MARK: - Convenience Initializers

extension BinaryInputContent {
    /// Creates binary content from a URL.
    ///
    /// - Parameters:
    ///   - mimeType: The MIME type of the content
    ///   - url: URL pointing to the binary content
    ///   - filename: Optional original filename
    public init(mimeType: String, url: String, filename: String? = nil) {
        self.type = "binary"
        self.mimeType = mimeType
        self.id = nil
        self.url = url
        self.data = nil
        self.filename = filename
    }

    /// Creates binary content from an ID.
    ///
    /// - Parameters:
    ///   - mimeType: The MIME type of the content
    ///   - id: Identifier for content retrieval
    ///   - filename: Optional original filename
    public init(mimeType: String, id: String, filename: String? = nil) {
        self.type = "binary"
        self.mimeType = mimeType
        self.id = id
        self.url = nil
        self.data = nil
        self.filename = filename
    }

    /// Creates binary content from base64-encoded data.
    ///
    /// - Parameters:
    ///   - mimeType: The MIME type of the content
    ///   - data: Base64-encoded binary data
    ///   - filename: Optional original filename
    public init(mimeType: String, data: String, filename: String? = nil) {
        self.type = "binary"
        self.mimeType = mimeType
        self.id = nil
        self.url = nil
        self.data = data
        self.filename = filename
    }
}
