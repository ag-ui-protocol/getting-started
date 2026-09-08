// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct TextMessageChunkEventDTO: Decodable {
    let messageId: String?
    let role: String?
    let name: String?
    let delta: String?
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> TextMessageChunkEvent {
        TextMessageChunkEvent(
            messageId: messageId,
            role: role,
            name: name,
            delta: delta,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
