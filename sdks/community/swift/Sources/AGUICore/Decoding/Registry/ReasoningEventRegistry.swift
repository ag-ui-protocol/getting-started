// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum ReasoningEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .reasoningStart: { data, decoder in
                try decoder.decode(ReasoningStartEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningMessageStart: { data, decoder in
                try decoder.decode(ReasoningMessageStartEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningMessageContent: { data, decoder in
                try decoder.decode(ReasoningMessageContentEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningMessageEnd: { data, decoder in
                try decoder.decode(ReasoningMessageEndEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningMessageChunk: { data, decoder in
                try decoder.decode(ReasoningMessageChunkEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningEnd: { data, decoder in
                try decoder.decode(ReasoningEndEventDTO.self, from: data).toDomain(rawEvent: data)
            },
            .reasoningEncryptedValue: { data, decoder in
                try decoder.decode(ReasoningEncryptedValueEventDTO.self, from: data).toDomain(rawEvent: data)
            }
        ]
    }
}
