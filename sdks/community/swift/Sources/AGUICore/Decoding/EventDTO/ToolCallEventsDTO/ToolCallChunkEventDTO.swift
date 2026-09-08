// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ToolCallChunkEventDTO: Decodable {
    let toolCallId: String?
    let toolCallName: String?
    let delta: String?
    let parentMessageId: String?
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ToolCallChunkEvent {
        ToolCallChunkEvent(
            toolCallId: toolCallId,
            toolCallName: toolCallName,
            delta: delta,
            parentMessageId: parentMessageId,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
