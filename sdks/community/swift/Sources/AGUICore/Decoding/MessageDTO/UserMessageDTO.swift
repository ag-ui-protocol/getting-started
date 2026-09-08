// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for UserMessage decoding.
struct UserMessageDTO {
    let id: String
    let content: String
    let name: String?
    let contentParts: [any InputContent]?
    let encryptedValue: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> UserMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .user)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")

        // Extract optional fields
        let name = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "name")
        let encryptedValue = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "encryptedValue")

        // Handle polymorphic content (String or Array of InputContent)
        guard let contentValue = jsonObject["content"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.content,
                DecodingError.Context(codingPath: [], debugDescription: "Missing content field")
            )
        }

        let content: String
        let contentParts: [any InputContent]?

        if let contentString = contentValue as? String {
            // Text-only message
            content = contentString
            contentParts = nil
        } else if let contentArray = contentValue as? [[String: Any]] {
            // Multimodal message
            content = ""
            contentParts = try decodeInputContentArray(contentArray, decoder: decoder)
        } else {
            throw DecodingError.typeMismatch(
                String.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.content],
                    debugDescription: "Expected String or Array for content"
                )
            )
        }

        return UserMessageDTO(id: id, content: content, name: name, contentParts: contentParts, encryptedValue: encryptedValue)
    }

    /// Decodes an array of InputContent from JSON dictionaries using DTOs.
    private static func decodeInputContentArray(
        _ array: [[String: Any]],
        decoder: JSONDecoder
    ) throws -> [any InputContent] {
        var result: [any InputContent] = []

        for (index, item) in array.enumerated() {
            guard let type = item["type"] as? String else {
                throw DecodingError.keyNotFound(
                    CodingKeys.type,
                    DecodingError.Context(
                        codingPath: [ArrayIndex(index: index)],
                        debugDescription: "Missing type field in content array item"
                    )
                )
            }

            let itemData = try JSONSerialization.data(withJSONObject: item)

            switch type {
            case "text":
                let dto = try TextInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(dto.toDomain())
            case "binary":
                let dto = try BinaryInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(try dto.toDomain())
            case "image":
                let dto = try ImageInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(dto.toDomain())
            case "audio":
                let dto = try AudioInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(dto.toDomain())
            case "video":
                let dto = try VideoInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(dto.toDomain())
            case "document":
                let dto = try DocumentInputContentDTO.decode(from: itemData, decoder: decoder)
                result.append(dto.toDomain())
            default:
                throw DecodingError.dataCorrupted(
                    DecodingError.Context(
                        codingPath: [ArrayIndex(index: index), CodingKeys.type],
                        debugDescription: "Unknown InputContent type: \(type)"
                    )
                )
            }
        }

        return result
    }

    func toDomain() -> UserMessage {
        if let parts = contentParts {
            return UserMessage.multimodal(id: id, parts: parts, name: name, encryptedValue: encryptedValue)
        } else {
            return UserMessage(id: id, content: content, name: name, encryptedValue: encryptedValue)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case content
        case type
    }

    private struct ArrayIndex: CodingKey {
        var intValue: Int?
        var stringValue: String

        init(index: Int) {
            self.intValue = index
            self.stringValue = "Index \(index)"
        }

        init?(intValue: Int) {
            self.intValue = intValue
            self.stringValue = "Index \(intValue)"
        }

        init?(stringValue: String) {
            nil
        }
    }
}
