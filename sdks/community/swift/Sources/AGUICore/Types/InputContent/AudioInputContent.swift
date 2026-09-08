// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents audio content in multimodal user input.
///
/// `AudioInputContent` carries audio data either as a URL reference or as
/// base64-encoded bytes. The optional `format` field identifies the audio codec
/// (e.g., `"mp3"`, `"wav"`, `"ogg"`).
///
/// - SeeAlso: ``InputContent``, ``UserMessage``
public struct AudioInputContent: InputContent, Hashable, Sendable {

    /// The content type discriminator (always `"audio"`).
    public let type: String

    /// Optional URL pointing to the audio file.
    public let url: String?

    /// Optional base64-encoded audio data.
    public let data: String?

    /// Optional audio format identifier.
    ///
    /// Common values: `"mp3"`, `"wav"`, `"ogg"`, `"flac"`.
    public let format: String?

    /// Optional MIME type of the audio (e.g., `"audio/mpeg"`, `"audio/wav"`).
    public let mimeType: String?

    /// Creates audio content from a URL.
    ///
    /// - Parameters:
    ///   - url: URL pointing to the audio file
    ///   - format: Optional format identifier (e.g., `"mp3"`)
    ///   - mimeType: Optional MIME type (e.g., `"audio/mpeg"`)
    public init(url: String, format: String? = nil, mimeType: String? = nil) {
        self.type = "audio"
        self.url = url
        self.data = nil
        self.format = format
        self.mimeType = mimeType
    }

    /// Creates audio content from base64-encoded data.
    ///
    /// - Parameters:
    ///   - data: Base64-encoded audio bytes
    ///   - format: Optional format identifier (e.g., `"wav"`)
    ///   - mimeType: Optional MIME type (e.g., `"audio/wav"`)
    public init(data: String, format: String? = nil, mimeType: String? = nil) {
        self.type = "audio"
        self.url = nil
        self.data = data
        self.format = format
        self.mimeType = mimeType
    }
}
