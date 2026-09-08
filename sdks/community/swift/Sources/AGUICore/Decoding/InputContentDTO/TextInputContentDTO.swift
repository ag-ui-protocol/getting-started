// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for TextInputContent decoding.
struct TextInputContentDTO {
    let text: String

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> TextInputContentDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate type field
        if let type = jsonObject["type"] as? String, type != "text" {
            throw DecodingError.typeMismatch(
                TextInputContent.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.type],
                    debugDescription: "Expected type 'text' but got '\(type)'"
                )
            )
        }

        // Extract required text field
        guard let text = jsonObject["text"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.text,
                DecodingError.Context(codingPath: [], debugDescription: "Missing text field")
            )
        }

        return TextInputContentDTO(text: text)
    }

    func toDomain() -> TextInputContent {
        TextInputContent(text: text)
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case text
    }
}
