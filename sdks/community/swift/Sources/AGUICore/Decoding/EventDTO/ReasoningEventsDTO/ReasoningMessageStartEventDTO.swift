// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningMessageStartEventDTO: Decodable {
    let messageId: String
    let role: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningMessageStartEvent {
        ReasoningMessageStartEvent(messageId: messageId, role: role, timestamp: timestamp, rawEvent: rawEvent)
    }
}
