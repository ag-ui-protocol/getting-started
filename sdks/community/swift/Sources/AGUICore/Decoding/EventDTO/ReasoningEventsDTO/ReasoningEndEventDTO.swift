// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningEndEventDTO: Decodable {
    let messageId: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningEndEvent {
        ReasoningEndEvent(messageId: messageId, timestamp: timestamp, rawEvent: rawEvent)
    }
}
