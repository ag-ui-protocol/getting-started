// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct StateSnapshotEventDTO {
    let snapshot: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> StateSnapshotEventDTO {
        // Parse the entire JSON to extract the snapshot field
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let snapshotValue = jsonObject["snapshot"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.snapshot,
                DecodingError.Context(codingPath: [], debugDescription: "Missing snapshot field")
            )
        }

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert snapshot value to JSON data
        // Use JSONEncoder for primitives, JSONSerialization for collections
        let snapshotData: Data
        if snapshotValue is NSNull {
            // NSNull needs special handling - encode as null JSON
            snapshotData = Data("null".utf8)
        } else if snapshotValue is [Any] || snapshotValue is [String: Any] {
            // Collections can use JSONSerialization
            snapshotData = try JSONSerialization.data(withJSONObject: snapshotValue, options: [])
        } else {
            // Primitives need JSONEncoder
            let encoder = JSONEncoder()
            snapshotData = try encoder.encode(JSONPrimitiveWrapper(value: snapshotValue))
        }

        return StateSnapshotEventDTO(snapshot: snapshotData, timestamp: timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case snapshot
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> StateSnapshotEvent {
        StateSnapshotEvent(
            snapshot: snapshot,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
