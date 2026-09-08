// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningStartEventDTO: Decodable {
    let messageId: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningStartEvent {
        ReasoningStartEvent(messageId: messageId, timestamp: timestamp, rawEvent: rawEvent)
    }
}
