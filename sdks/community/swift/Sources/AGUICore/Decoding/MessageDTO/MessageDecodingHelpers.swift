// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Helper utilities for decoding message DTOs.
///
/// This enum provides shared decoding logic to reduce code duplication across message DTOs
/// and ensure consistent error handling.
enum MessageDecodingHelpers {

    /// Extracts a required string field from a JSON object.
    ///
    /// - Parameters:
    ///   - jsonObject: The JSON dictionary containing the field
    ///   - key: The key to extract
    /// - Returns: The string value
    /// - Throws: `DecodingError` if field is missing or wrong type
    static func extractRequiredString(from jsonObject: [String: Any], key: String) throws -> String {
        guard let value = jsonObject[key] else {
            throw DecodingError.keyNotFound(
                AnyCodingKey(stringValue: key),
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Missing required field: \(key)"
                )
            )
        }

        guard let stringValue = value as? String else {
            throw DecodingError.typeMismatch(
                String.self,
                DecodingError.Context(
                    codingPath: [AnyCodingKey(stringValue: key)],
                    debugDescription: "Expected String for \(key), got \(type(of: value))"
                )
            )
        }

        return stringValue
    }

    /// Extracts an optional string field from a JSON object.
    ///
    /// - Parameters:
    ///   - jsonObject: The JSON dictionary containing the field
    ///   - key: The key to extract
    /// - Returns: The string value or nil if not present
    static func extractOptionalString(from jsonObject: [String: Any], key: String) -> String? {
        guard let value = jsonObject[key], !(value is NSNull) else {
            return nil
        }
        return value as? String
    }

    /// Extracts role from JSON and validates it.
    ///
    /// - Parameter jsonObject: The JSON dictionary containing the role field
    /// - Returns: The validated Role
    /// - Throws: `DecodingError` if role is missing or invalid
    static func extractRole(from jsonObject: [String: Any]) throws -> Role {
        let roleString = try extractRequiredString(from: jsonObject, key: "role")

        guard let role = Role(rawValue: roleString) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [AnyCodingKey(stringValue: "role")],
                    debugDescription: "Invalid role value: \(roleString)"
                )
            )
        }

        return role
    }

    /// Validates that the role matches the expected value.
    ///
    /// - Parameters:
    ///   - role: The actual role
    ///   - expected: The expected role
    /// - Throws: `DecodingError` if roles don't match
    static func validateRole(_ role: Role, expected: Role) throws {
        guard role == expected else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [AnyCodingKey(stringValue: "role")],
                    debugDescription: "Expected role \(expected.rawValue), got \(role.rawValue)"
                )
            )
        }
    }

    /// Helper CodingKey for constructing error contexts.
    private struct AnyCodingKey: CodingKey {
        var stringValue: String
        var intValue: Int?

        init(stringValue: String) {
            self.stringValue = stringValue
            self.intValue = nil
        }

        init?(intValue: Int) {
            self.stringValue = String(intValue)
            self.intValue = intValue
        }
    }
}
