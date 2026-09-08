// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ReasoningEncryptedValueEventDTO: Decodable {
    let subtype: ReasoningEncryptedValueSubtype
    let entityId: String
    let encryptedValue: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> ReasoningEncryptedValueEvent {
        ReasoningEncryptedValueEvent(
            subtype: subtype,
            entityId: entityId,
            encryptedValue: encryptedValue,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
