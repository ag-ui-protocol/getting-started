// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents a document in multimodal user input.
///
/// `DocumentInputContent` carries document data either as a URL reference or as
/// base64-encoded bytes. The optional `mimeType` and `title` fields provide
/// metadata about the document.
///
/// - SeeAlso: ``InputContent``, ``UserMessage``
public struct DocumentInputContent: InputContent, Hashable, Sendable {

    /// The content type discriminator (always `"document"`).
    public let type: String

    /// Optional URL pointing to the document.
    public let url: String?

    /// Optional base64-encoded document data.
    public let data: String?

    /// Optional MIME type of the document (e.g., `"application/pdf"`, `"text/plain"`).
    public let mimeType: String?

    /// Optional human-readable title for the document.
    public let title: String?

    /// Creates document content from a URL.
    ///
    /// - Parameters:
    ///   - url: URL pointing to the document
    ///   - mimeType: Optional MIME type (e.g., `"application/pdf"`)
    ///   - title: Optional document title
    public init(url: String, mimeType: String? = nil, title: String? = nil) {
        self.type = "document"
        self.url = url
        self.data = nil
        self.mimeType = mimeType
        self.title = title
    }

    /// Creates document content from base64-encoded data.
    ///
    /// - Parameters:
    ///   - data: Base64-encoded document bytes
    ///   - mimeType: Optional MIME type (e.g., `"application/pdf"`)
    ///   - title: Optional document title
    public init(data: String, mimeType: String? = nil, title: String? = nil) {
        self.type = "document"
        self.url = nil
        self.data = data
        self.mimeType = mimeType
        self.title = title
    }
}
