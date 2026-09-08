// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents video content in multimodal user input.
///
/// `VideoInputContent` carries video data either as a URL reference or as
/// base64-encoded bytes.
///
/// - SeeAlso: ``InputContent``, ``UserMessage``
public struct VideoInputContent: InputContent, Hashable, Sendable {

    /// The content type discriminator (always `"video"`).
    public let type: String

    /// Optional URL pointing to the video file.
    public let url: String?

    /// Optional base64-encoded video data.
    public let data: String?

    /// Optional MIME type of the video (e.g., `"video/mp4"`, `"video/webm"`).
    public let mimeType: String?

    /// Creates video content from a URL.
    ///
    /// - Parameters:
    ///   - url: URL pointing to the video file
    ///   - mimeType: Optional MIME type (e.g., `"video/mp4"`)
    public init(url: String, mimeType: String? = nil) {
        self.type = "video"
        self.url = url
        self.data = nil
        self.mimeType = mimeType
    }

    /// Creates video content from base64-encoded data.
    ///
    /// - Parameters:
    ///   - data: Base64-encoded video bytes
    ///   - mimeType: Optional MIME type (e.g., `"video/webm"`)
    public init(data: String, mimeType: String? = nil) {
        self.type = "video"
        self.url = nil
        self.data = data
        self.mimeType = mimeType
    }
}
