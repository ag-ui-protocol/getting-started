// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Helper utilities for decoding event DTOs.
///
/// This enum provides shared decoding logic to reduce code duplication across event DTOs
/// and ensure consistent error handling.
enum EventDecodingHelpers {

    /// Extracts and validates a timestamp field from a JSON object.
    ///
    /// This method handles various timestamp representations:
    /// - Missing field: returns `nil`
    /// - NSNull value: returns `nil`
    /// - Int64 value: returns the value
    /// - Int value: converts to Int64 and returns
    /// - Other types: throws a type mismatch error
    ///
    /// - Parameter jsonObject: The JSON dictionary containing the timestamp field
    /// - Returns: The timestamp as Int64, or nil if not present or null
    /// - Throws: `DecodingError.typeMismatch` if timestamp has an invalid type
    static func extractTimestamp(from jsonObject: [String: Any]) throws -> Int64? {
        guard let timestampValue = jsonObject["timestamp"] else {
            return nil
        }

        if timestampValue is NSNull {
            return nil
        } else if let timestampValue = timestampValue as? Int64 {
            return timestampValue
        } else if let timestampValue = timestampValue as? Int {
            return Int64(timestampValue)
        } else {
            throw DecodingError.typeMismatch(
                Int64.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.timestamp],
                    debugDescription: "Expected Int64 for timestamp, got \(type(of: timestampValue))"
                )
            )
        }
    }

    /// Helper CodingKey for constructing error contexts.
    private enum CodingKeys: String, CodingKey {
        case timestamp
    }
}
