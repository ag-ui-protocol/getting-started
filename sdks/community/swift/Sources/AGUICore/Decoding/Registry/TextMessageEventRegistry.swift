// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum TextMessageEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .textMessageStart: { data, decoder in
                try decoder.decode(TextMessageStartEvent.self, from: data).withRawEvent(data)
            },
            .textMessageContent: { data, decoder in
                try decoder.decode(TextMessageContentEvent.self, from: data).withRawEvent(data)
            },
            .textMessageEnd: { data, decoder in
                try decoder.decode(TextMessageEndEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .textMessageChunk: { data, decoder in
                try decoder.decode(TextMessageChunkEventDTO.self, from: data).toDomain(rawEvent: data)
            }
        ]
    }
}
