// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct StepStartedEventDTO: Decodable {
    let stepName: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> StepStartedEvent {
        StepStartedEvent(stepName: stepName, timestamp: timestamp, rawEvent: rawEvent)
    }
}
