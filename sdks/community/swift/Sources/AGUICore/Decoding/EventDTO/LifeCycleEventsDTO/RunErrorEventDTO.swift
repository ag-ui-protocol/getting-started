// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct RunErrorEventDTO {
    let message: String
    let code: String?
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> RunErrorEventDTO {
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let message = jsonObject["message"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.message,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: message")
            )
        }

        let code = jsonObject["code"] as? String
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        return RunErrorEventDTO(message: message, code: code, timestamp: timestamp)
    }

    func toDomain(rawEvent: Data? = nil) -> RunErrorEvent {
        RunErrorEvent(message: message, code: code, timestamp: timestamp, rawEvent: rawEvent)
    }

    private enum CodingKeys: String, CodingKey {
        case message, code, timestamp
    }
}
