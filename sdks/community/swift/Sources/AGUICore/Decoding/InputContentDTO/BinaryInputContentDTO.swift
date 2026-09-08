// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for BinaryInputContent decoding.
struct BinaryInputContentDTO {
    let mimeType: String
    let id: String?
    let url: String?
    let data: String?
    let filename: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> BinaryInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate type field
        if let type = jsonObject["type"] as? String, type != "binary" {
            throw DecodingError.typeMismatch(
                BinaryInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'binary' but got '\(type)'"
                )
            )
        }

        // Extract required mimeType field
        guard let mimeType = jsonObject["mimeType"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.mimeType,
                DecodingError.Context(codingPath: [], debugDescription: "Missing mimeType field")
            )
        }

        // Extract optional fields
        let id = jsonObject["id"] as? String
        let url = jsonObject["url"] as? String
        let data = jsonObject["data"] as? String
        let filename = jsonObject["filename"] as? String

        // Validate that at least one source is provided
        guard id != nil || url != nil || data != nil else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "BinaryInputContent requires at least one of: id, url, or data"
                )
            )
        }

        return BinaryInputContentDTO(
            mimeType: mimeType,
            id: id,
            url: url,
            data: data,
            filename: filename
        )
    }

    func toDomain() throws -> BinaryInputContent {
        try BinaryInputContent(
            mimeType: mimeType,
            id: id,
            url: url,
            data: data,
            filename: filename
        )
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case mimeType
        case id
        case url
        case data
        case filename
    }
}
