// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for VideoInputContent decoding.
struct VideoInputContentDTO {
    let url: String?
    let data: String?
    let mimeType: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> VideoInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        if let type = jsonObject["type"] as? String, type != "video" {
            throw DecodingError.typeMismatch(
                VideoInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'video' but got '\(type)'"
                )
            )
        }

        let url = jsonObject["url"] as? String
        let dataStr = jsonObject["data"] as? String

        guard url != nil || dataStr != nil else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "VideoInputContent requires at least one of: url or data"
                )
            )
        }

        return VideoInputContentDTO(url: url, data: dataStr, mimeType: jsonObject["mimeType"] as? String)
    }

    func toDomain() -> VideoInputContent {
        if let url = url {
            return VideoInputContent(url: url, mimeType: mimeType)
        } else {
            return VideoInputContent(data: data!, mimeType: mimeType)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, url, data, mimeType
    }
}
