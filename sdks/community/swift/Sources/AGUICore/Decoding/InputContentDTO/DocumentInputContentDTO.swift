// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for DocumentInputContent decoding.
struct DocumentInputContentDTO {
    let url: String?
    let data: String?
    let mimeType: String?
    let title: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> DocumentInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        if let type = jsonObject["type"] as? String, type != "document" {
            throw DecodingError.typeMismatch(
                DocumentInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'document' but got '\(type)'"
                )
            )
        }

        let url = jsonObject["url"] as? String
        let dataStr = jsonObject["data"] as? String

        guard url != nil || dataStr != nil else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "DocumentInputContent requires at least one of: url or data"
                )
            )
        }

        return DocumentInputContentDTO(
            url: url,
            data: dataStr,
            mimeType: jsonObject["mimeType"] as? String,
            title: jsonObject["title"] as? String
        )
    }

    func toDomain() -> DocumentInputContent {
        if let url = url {
            return DocumentInputContent(url: url, mimeType: mimeType, title: title)
        } else {
            return DocumentInputContent(data: data!, mimeType: mimeType, title: title)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, url, data, mimeType, title
    }
}
