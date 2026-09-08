// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Errors that can occur during event decoding.
public enum EventDecodingError: Error, LocalizedError, Equatable {
    /// The event type in the JSON is unknown or unsupported
    case unknownEventType(String)

    /// The JSON data is invalid or malformed
    case invalidJSON

    /// The required "type" field is missing from the JSON
    case missingTypeField

    /// Decoding failed with an underlying error
    case decodingFailed(String)

    case unsupportedEventType(EventType)

    public var errorDescription: String? {
        switch self {
        case .unknownEventType(let type):
            return "Unknown event type: '\(type)'. This event type is not supported by this version of AGUISwift."
        case .invalidJSON:
            return "Invalid JSON data. The provided data could not be parsed as valid JSON."
        case .missingTypeField:
            return "Missing 'type' field. All AG-UI events must have a 'type' field."
        case .decodingFailed(let message):
            return "Event decoding failed: \(message)"
        case .unsupportedEventType(let type):
            return "Unsupported event type: '\(type.rawValue)'. " +
                "This SDK knows about it but doesn't implement decoding for it."
        }
    }

    public var recoverySuggestion: String? {
        switch self {
        case .unknownEventType:
            return "Check if you're using the latest version of AGUISwift, " +
                "or inspect the raw JSON to see if it's a custom event type."
        case .invalidJSON:
            return "Verify that the JSON data is well-formed and complete."
        case .missingTypeField:
            return "Ensure the JSON contains a 'type' field at the root level."
        case .decodingFailed:
            return "Check the event JSON structure against the AG-UI protocol specification."
        case .unsupportedEventType:
            return "Ensure the correct module/registry is linked, or implement/register a decoder for this event type."
        }
    }
}
