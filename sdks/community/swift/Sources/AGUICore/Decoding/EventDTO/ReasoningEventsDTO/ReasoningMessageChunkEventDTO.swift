// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningMessageChunkEventDTO: Decodable {
    let messageId: String?
    let delta: String?
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningMessageChunkEvent {
        ReasoningMessageChunkEvent(messageId: messageId, delta: delta, timestamp: timestamp, rawEvent: rawEvent)
    }
}
