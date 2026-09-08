// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ToolCallResultEventDTO: Decodable {
    let messageId: String
    let toolCallId: String
    let content: String
    let role: String?
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ToolCallResultEvent {
        ToolCallResultEvent(
            messageId: messageId,
            toolCallId: toolCallId,
            content: content,
            role: role,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
