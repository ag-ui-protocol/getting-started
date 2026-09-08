// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum SpecialEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .raw: { data, decoder in
                try RawEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .custom: { data, decoder in
                try CustomEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            }
        ]
    }
}
