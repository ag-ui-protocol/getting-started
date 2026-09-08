// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ActivityDeltaEventDTO {
    let messageId: String
    let activityType: String
    let patch: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> ActivityDeltaEventDTO {
        // Parse the entire JSON to extract fields
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let messageId = jsonObject["messageId"] as? String ?? jsonObject["message_id"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.messageId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing messageId field")
            )
        }

        guard let activityType = jsonObject["activityType"] as? String ?? jsonObject["activity_type"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.activityType,
                DecodingError.Context(codingPath: [], debugDescription: "Missing activityType field")
            )
        }

        guard let patchValue = jsonObject["patch"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.patch,
                DecodingError.Context(codingPath: [], debugDescription: "Missing patch field")
            )
        }

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert patch value to JSON data (must be an array)
        guard patchValue is [Any] else {
            throw DecodingError.typeMismatch(
                [Any].self,
                DecodingError.Context(codingPath: [], debugDescription: "Patch must be a JSON array")
            )
        }

        let patchData = try JSONSerialization.data(withJSONObject: patchValue, options: [])

        return ActivityDeltaEventDTO(
            messageId: messageId,
            activityType: activityType,
            patch: patchData,
            timestamp: timestamp
        )
    }

    enum CodingKeys: String, CodingKey {
        case messageId
        case activityType
        case patch
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> ActivityDeltaEvent {
        ActivityDeltaEvent(
            messageId: messageId,
            activityType: activityType,
            patch: patch,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
