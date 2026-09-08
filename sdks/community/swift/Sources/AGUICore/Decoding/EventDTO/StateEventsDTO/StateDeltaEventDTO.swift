// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct StateDeltaEventDTO {
    let delta: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> StateDeltaEventDTO {
        // Parse the entire JSON to extract the delta field
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let deltaValue = jsonObject["delta"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.delta,
                DecodingError.Context(codingPath: [], debugDescription: "Missing delta field")
            )
        }

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert delta value to JSON data
        // Delta must be an array of JSON Patch operations (RFC 6902)
        let deltaData = try serializeDelta(deltaValue)

        return StateDeltaEventDTO(delta: deltaData, timestamp: timestamp)
    }

    /// Serializes the delta value to JSON data.
    ///
    /// The delta must be an array of JSON Patch operations per RFC 6902,
    /// or NSNull in edge cases.
    ///
    /// - Parameter deltaValue: The delta value from the JSON object
    /// - Returns: JSON data representation of the delta
    /// - Throws: `DecodingError.typeMismatch` if delta is not an array or NSNull
    private static func serializeDelta(_ deltaValue: Any) throws -> Data {
        if deltaValue is NSNull {
            // NSNull needs special handling - encode as null JSON
            return Data("null".utf8)
        } else if deltaValue is [Any] {
            // Array can use JSONSerialization
            return try JSONSerialization.data(withJSONObject: deltaValue, options: [])
        } else {
            // Delta must be an array per RFC 6902
            throw DecodingError.typeMismatch(
                [Any].self,
                DecodingError.Context(
                    codingPath: [CodingKeys.delta],
                    debugDescription: "Delta must be an array of JSON Patch operations per RFC 6902, got \(type(of: deltaValue))"
                )
            )
        }
    }

    enum CodingKeys: String, CodingKey {
        case delta
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> StateDeltaEvent {
        StateDeltaEvent(
            delta: delta,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
