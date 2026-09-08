// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum ActivityEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .activitySnapshot: { data, decoder in
                try ActivitySnapshotEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .activityDelta: { data, decoder in
                try ActivityDeltaEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            }
        ]
    }
}
