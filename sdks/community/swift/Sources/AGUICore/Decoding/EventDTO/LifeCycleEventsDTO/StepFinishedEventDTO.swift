// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct StepFinishedEventDTO: Decodable {
    let stepName: String
    let timestamp: Int64?

    func toDomain(rawEvent: Data? = nil) -> StepFinishedEvent {
        StepFinishedEvent(stepName: stepName, timestamp: timestamp, rawEvent: rawEvent)
    }
}
