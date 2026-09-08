// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for ImageInputContent decoding.
struct ImageInputContentDTO {
    let url: String?
    let data: String?
    let detail: String?
    let mimeType: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ImageInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        if let type = jsonObject["type"] as? String, type != "image" {
            throw DecodingError.typeMismatch(
                ImageInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'image' but got '\(type)'"
                )
            )
        }

        let url = jsonObject["url"] as? String
        let dataStr = jsonObject["data"] as? String

        guard url != nil || dataStr != nil else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "ImageInputContent requires at least one of: url or data"
                )
            )
        }

        return ImageInputContentDTO(
            url: url,
            data: dataStr,
            detail: jsonObject["detail"] as? String,
            mimeType: jsonObject["mimeType"] as? String
        )
    }

    func toDomain() -> ImageInputContent {
        if let url = url {
            return ImageInputContent(url: url, detail: detail, mimeType: mimeType)
        } else {
            return ImageInputContent(data: data!, detail: detail, mimeType: mimeType)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, url, data, detail, mimeType
    }
}
