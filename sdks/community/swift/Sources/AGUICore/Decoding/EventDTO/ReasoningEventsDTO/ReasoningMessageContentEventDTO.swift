// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningMessageContentEventDTO: Decodable {
    let messageId: String
    let delta: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningMessageContentEvent {
        ReasoningMessageContentEvent(messageId: messageId, delta: delta, timestamp: timestamp, rawEvent: rawEvent)
    }
}
