// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for AudioInputContent decoding.
struct AudioInputContentDTO {
    let url: String?
    let data: String?
    let format: String?
    let mimeType: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> AudioInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        if let type = jsonObject["type"] as? String, type != "audio" {
            throw DecodingError.typeMismatch(
                AudioInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'audio' but got '\(type)'"
                )
            )
        }

        let url = jsonObject["url"] as? String
        let dataStr = jsonObject["data"] as? String

        guard url != nil || dataStr != nil else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "AudioInputContent requires at least one of: url or data"
                )
            )
        }

        return AudioInputContentDTO(
            url: url,
            data: dataStr,
            format: jsonObject["format"] as? String,
            mimeType: jsonObject["mimeType"] as? String
        )
    }

    func toDomain() -> AudioInputContent {
        if let url = url {
            return AudioInputContent(url: url, format: format, mimeType: mimeType)
        } else {
            return AudioInputContent(data: data!, format: format, mimeType: mimeType)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, url, data, format, mimeType
    }
}
