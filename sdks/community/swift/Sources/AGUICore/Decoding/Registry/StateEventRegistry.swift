// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

enum StateEventRegistry {
    typealias DecodeHandler = AGUIEventDecoder.DecodeHandler

    static func registry() -> [EventType: DecodeHandler] {
        [
            .stateSnapshot: { data, decoder in
                try StateSnapshotEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .stateDelta: { data, decoder in
                try StateDeltaEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            },
            .messagesSnapshot: { data, decoder in
                try MessagesSnapshotEventDTO.decode(from: data, decoder: decoder).toDomain(rawEvent: data)
            }
        ]
    }
}
