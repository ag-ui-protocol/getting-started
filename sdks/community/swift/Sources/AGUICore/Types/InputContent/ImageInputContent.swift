// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents an image in multimodal user input.
///
/// `ImageInputContent` carries image data either as a URL reference or as
/// base64-encoded bytes. The optional `detail` field controls how agents
/// with vision capabilities process the image (e.g., `"high"`, `"low"`, `"auto"`).
///
/// - SeeAlso: ``InputContent``, ``UserMessage``
public struct ImageInputContent: InputContent, Hashable, Sendable {

    /// The content type discriminator (always `"image"`).
    public let type: String

    /// Optional URL pointing to the image.
    public let url: String?

    /// Optional base64-encoded image data.
    public let data: String?

    /// Optional detail level hint for vision-capable agents.
    ///
    /// Common values: `"high"`, `"low"`, `"auto"`.
    public let detail: String?

    /// Optional MIME type of the image (e.g., `"image/png"`, `"image/jpeg"`).
    public let mimeType: String?

    /// Creates an image content from a URL.
    ///
    /// - Parameters:
    ///   - url: URL pointing to the image
    ///   - detail: Optional detail level (`"high"`, `"low"`, `"auto"`)
    ///   - mimeType: Optional MIME type (e.g., `"image/png"`)
    public init(url: String, detail: String? = nil, mimeType: String? = nil) {
        self.type = "image"
        self.url = url
        self.data = nil
        self.detail = detail
        self.mimeType = mimeType
    }

    /// Creates an image content from base64-encoded data.
    ///
    /// - Parameters:
    ///   - data: Base64-encoded image bytes
    ///   - detail: Optional detail level (`"high"`, `"low"`, `"auto"`)
    ///   - mimeType: Optional MIME type (e.g., `"image/jpeg"`)
    public init(data: String, detail: String? = nil, mimeType: String? = nil) {
        self.type = "image"
        self.url = nil
        self.data = data
        self.detail = detail
        self.mimeType = mimeType
    }
}
