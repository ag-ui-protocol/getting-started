// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ToolCallEndEventDTO: Decodable {
    let toolCallId: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ToolCallEndEvent {
        ToolCallEndEvent(
            toolCallId: toolCallId,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
