// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for ReasoningMessage decoding.
struct ReasoningMessageDTO {
    let id: String
    let content: String
    let encryptedValue: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ReasoningMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .reasoning)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")
        let content = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "content")

        // Extract optional fields
        let encryptedValue = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "encryptedValue")

        return ReasoningMessageDTO(id: id, content: content, encryptedValue: encryptedValue)
    }

    func toDomain() -> ReasoningMessage {
        ReasoningMessage(id: id, content: content, encryptedValue: encryptedValue)
    }
}
