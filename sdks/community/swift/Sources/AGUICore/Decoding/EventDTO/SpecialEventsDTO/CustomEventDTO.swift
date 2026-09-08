// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct CustomEventDTO {
    let customType: String
    let data: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> CustomEventDTO {
        // Parse the entire JSON to extract the customType and data fields
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // AG-UI protocol wire format uses "name" (not "customType")
        guard let customType = jsonObject["name"] as? String else {
            if jsonObject["name"] == nil {
                throw DecodingError.keyNotFound(
                    CodingKeys.customType,
                    DecodingError.Context(codingPath: [], debugDescription: "Missing key 'name' at root")
                )
            } else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.customType], debugDescription: "Expected String for name")
                )
            }
        }

        // AG-UI protocol wire format uses "value" (not "data"); value is optional
        let dataValue = jsonObject["value"]

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert value to JSON data; treat absent/null value as empty object {}
        let eventData: Data
        if let dataValue {
            if dataValue is NSNull {
                eventData = Data("null".utf8)
            } else if dataValue is [Any] || dataValue is [String: Any] {
                eventData = try JSONSerialization.data(withJSONObject: dataValue, options: [])
            } else {
                let encoder = JSONEncoder()
                eventData = try encoder.encode(JSONPrimitiveWrapper(value: dataValue))
            }
        } else {
            eventData = Data("{}".utf8)
        }

        return CustomEventDTO(customType: customType, data: eventData, timestamp: timestamp)
    }

    // Wire keys: "name" maps to customType, "value" maps to data
    enum CodingKeys: String, CodingKey {
        case customType = "name"
        case data = "value"
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> CustomEvent {
        CustomEvent(
            name: customType,
            value: data,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
