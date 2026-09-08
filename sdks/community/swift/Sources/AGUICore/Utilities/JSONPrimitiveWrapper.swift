// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Wraps an untyped `Any` primitive so it can be encoded into JSON via `Codable`.
///
/// This is an internal helper used by DTO types that receive raw `Any` values
/// from `JSONSerialization` and need to round-trip them through `JSONEncoder`.
///
/// Supported value types: `Bool`, `Int`, `Int64`, `Double`, `String`, `NSNull`.
struct JSONPrimitiveWrapper: Encodable {
    let value: Any

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let int64 as Int64:
            try container.encode(int64)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case is NSNull:
            try container.encodeNil()
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: [],
                    debugDescription: "Unsupported primitive type"
                )
            )
        }
    }
}
