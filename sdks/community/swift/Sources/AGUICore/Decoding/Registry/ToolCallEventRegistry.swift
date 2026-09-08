// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum ToolCallEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .toolCallStart: { data, decoder in
                try decoder.decode(ToolCallStartEvent.self, from: data).withRawEvent(data)
            },
            .toolCallArgs: { data, decoder in
                try decoder.decode(ToolCallArgsEvent.self, from: data).withRawEvent(data)
            },
            .toolCallEnd: { data, decoder in
                try decoder.decode(ToolCallEndEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .toolCallResult: { data, decoder in
                try decoder.decode(ToolCallResultEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .toolCallChunk: { data, decoder in
                try decoder.decode(ToolCallChunkEventDTO.self, from: data).toDomain(rawEvent: data)
            }
        ]
    }
}
