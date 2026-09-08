// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Dynamic coding keys for encoding/decoding arbitrary JSON objects.
///
/// This type enables working with JSON objects that have dynamic or unknown keys
/// at compile time, commonly needed when bridging between strongly-typed Swift
/// and loosely-typed JSON.
///
/// ## Usage
///
/// Use with `KeyedEncodingContainer` and `KeyedDecodingContainer` to handle
/// arbitrary JSON structures:
///
/// ```swift
/// let container = try decoder.container(keyedBy: JSONCodingKeys.self)
/// let jsonObject = try container.decodeJSONObject()
/// ```
public struct JSONCodingKeys: CodingKey {
    public var stringValue: String
    public var intValue: Int?

    public init(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    public init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

// MARK: - Decoding Extensions

extension KeyedDecodingContainer where K == JSONCodingKeys {
    /// Decodes an arbitrary JSON object (dictionary) to a Swift dictionary.
    ///
    /// Recursively decodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested objects, nested arrays, and null.
    ///
    /// - Returns: A dictionary with string keys and `Any` values representing the JSON object
    /// - Throws: `DecodingError` if the structure cannot be decoded
    public func decodeJSONObject() throws -> Any {
        var result: [String: Any] = [:]

        for key in allKeys {
            if let value = try? decode(String.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Int.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Double.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Bool.self, forKey: key) {
                result[key.stringValue] = value
            } else if let nestedContainer = try? nestedContainer(keyedBy: JSONCodingKeys.self, forKey: key) {
                result[key.stringValue] = try nestedContainer.decodeJSONObject()
            } else if var nestedContainer = try? nestedUnkeyedContainer(forKey: key) {
                result[key.stringValue] = try nestedContainer.decodeJSONArray()
            } else {
                result[key.stringValue] = NSNull()
            }
        }

        return result
    }
}

extension UnkeyedDecodingContainer {
    /// Decodes an arbitrary JSON array to a Swift array.
    ///
    /// Recursively decodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested objects, nested arrays, and null.
    ///
    /// - Returns: An array of `Any` representing the JSON array
    /// - Throws: `DecodingError` if the structure cannot be decoded
    public mutating func decodeJSONArray() throws -> [Any] {
        var result: [Any] = []

        while !isAtEnd {
            if let value = try? decode(String.self) {
                result.append(value)
            } else if let value = try? decode(Int.self) {
                result.append(value)
            } else if let value = try? decode(Double.self) {
                result.append(value)
            } else if let value = try? decode(Bool.self) {
                result.append(value)
            } else if let nestedContainer = try? nestedContainer(keyedBy: JSONCodingKeys.self) {
                result.append(try nestedContainer.decodeJSONObject())
            } else if var nestedContainer = try? nestedUnkeyedContainer() {
                result.append(try nestedContainer.decodeJSONArray())
            } else {
                result.append(NSNull())
            }
        }

        return result
    }
}

// MARK: - Encoding Extensions

extension KeyedEncodingContainer where K == JSONCodingKeys {
    /// Encodes an arbitrary JSON object (dictionary) from a Swift dictionary.
    ///
    /// Recursively encodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested dictionaries, nested arrays, and null.
    ///
    /// - Parameter object: The object to encode (typically a `[String: Any]` dictionary)
    /// - Throws: `EncodingError` if the object cannot be encoded
    public mutating func encodeJSONObject(_ object: Any) throws {
        if let dict = object as? [String: Any] {
            for (key, value) in dict {
                let codingKey = JSONCodingKeys(stringValue: key)

                if let stringValue = value as? String {
                    try encode(stringValue, forKey: codingKey)
                } else if let boolValue = value as? Bool {
                    try encode(boolValue, forKey: codingKey)
                } else if let intValue = value as? Int {
                    try encode(intValue, forKey: codingKey)
                } else if let doubleValue = value as? Double {
                    try encode(doubleValue, forKey: codingKey)
                } else if value is NSNull {
                    try encodeNil(forKey: codingKey)
                } else if let nestedDict = value as? [String: Any] {
                    var nestedContainer = nestedContainer(keyedBy: JSONCodingKeys.self, forKey: codingKey)
                    try nestedContainer.encodeJSONObject(nestedDict)
                } else if let nestedArray = value as? [Any] {
                    var nestedContainer = nestedUnkeyedContainer(forKey: codingKey)
                    try nestedContainer.encodeJSONArray(nestedArray)
                }
            }
        }
    }
}

extension UnkeyedEncodingContainer {
    /// Encodes an arbitrary JSON array from a Swift array.
    ///
    /// Recursively encodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested dictionaries, nested arrays, and null.
    ///
    /// - Parameter array: The array to encode (typically an `[Any]` array)
    /// - Throws: `EncodingError` if the array cannot be encoded
    public mutating func encodeJSONArray(_ array: [Any]) throws {
        for value in array {
            if let stringValue = value as? String {
                try encode(stringValue)
            } else if let boolValue = value as? Bool {
                try encode(boolValue)
            } else if let intValue = value as? Int {
                try encode(intValue)
            } else if let doubleValue = value as? Double {
                try encode(doubleValue)
            } else if value is NSNull {
                try encodeNil()
            } else if let nestedDict = value as? [String: Any] {
                var nestedContainer = nestedContainer(keyedBy: JSONCodingKeys.self)
                try nestedContainer.encodeJSONObject(nestedDict)
            } else if let nestedArray = value as? [Any] {
                var nestedContainer = nestedUnkeyedContainer()
                try nestedContainer.encodeJSONArray(nestedArray)
            }
        }
    }
}
