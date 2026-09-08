// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Data Transfer Object for ToolMessage decoding.
struct ToolMessageDTO {
    let id: String
    let toolCallId: String
    let content: String?
    let name: String?
    let error: String?
    let encryptedValue: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ToolMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .tool)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")
        let toolCallId = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "toolCallId")

        // Extract optional fields
        let content = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "content")
        let name = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "name")
        let error = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "error")
        let encryptedValue = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "encryptedValue")

        return ToolMessageDTO(id: id, toolCallId: toolCallId, content: content, name: name, error: error, encryptedValue: encryptedValue)
    }

    /// Converts this DTO to a domain `ToolMessage`.
    ///
    /// `content` defaults to an empty string when the JSON field is absent,
    /// matching the AG-UI protocol where tool result content is optional.
    func toDomain() -> ToolMessage {
        ToolMessage(id: id, content: content ?? "", toolCallId: toolCallId, name: name, error: error, encryptedValue: encryptedValue)
    }
}
