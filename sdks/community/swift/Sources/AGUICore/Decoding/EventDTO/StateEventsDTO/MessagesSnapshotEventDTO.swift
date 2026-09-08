// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct MessagesSnapshotEventDTO {
    let messages: [any Message]
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> MessagesSnapshotEventDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let messagesValue = jsonObject["messages"] as? [[String: Any]] else {
            throw DecodingError.keyNotFound(
                CodingKeys.messages,
                DecodingError.Context(codingPath: [], debugDescription: "Missing or non-array messages field")
            )
        }

        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        let messageDecoder = MessageDecoder()
        let messages: [any Message] = try messagesValue.compactMap { dict in
            let msgData = try JSONSerialization.data(withJSONObject: dict)
            return try? messageDecoder.decode(msgData)
        }

        return MessagesSnapshotEventDTO(messages: messages, timestamp: timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case messages
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> MessagesSnapshotEvent {
        MessagesSnapshotEvent(
            messages: messages,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
