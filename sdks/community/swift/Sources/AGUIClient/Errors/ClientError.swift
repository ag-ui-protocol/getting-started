// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Errors that can occur during client operations.
public enum ClientError: Error {
    /// Invalid URL configuration.
    case invalidURL

    /// Received invalid response from server.
    case invalidResponse

    /// HTTP error with status code.
    case httpError(statusCode: Int)

    /// Network error occurred.
    case networkError(Error)

    /// Failed to encode request body.
    case encodingError(Error)

    /// Failed to decode event.
    case decodingError(Error)

    /// Stream processing error.
    case streamError(String)

    /// Request timed out.
    case timeout

    /// Request was cancelled.
    case cancelled
}

extension ClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL configuration"
        case .invalidResponse:
            return "Received invalid response from server"
        case .httpError(let code):
            return "HTTP error: \(code)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .encodingError(let error):
            return "Failed to encode request: \(error.localizedDescription)"
        case .decodingError(let error):
            return "Failed to decode event: \(error.localizedDescription)"
        case .streamError(let message):
            return "Stream error: \(message)"
        case .timeout:
            return "Request timed out"
        case .cancelled:
            return "Request was cancelled"
        }
    }
}

extension ClientError: Equatable {
    public static func == (lhs: ClientError, rhs: ClientError) -> Bool {
        switch (lhs, rhs) {
        case (.invalidURL, .invalidURL),
             (.invalidResponse, .invalidResponse),
             (.timeout, .timeout),
             (.cancelled, .cancelled):
            return true
        case (.httpError(let lcode), .httpError(let rcode)):
            return lcode == rcode
        case (.streamError(let lmsg), .streamError(let rmsg)):
            return lmsg == rmsg
        case (.networkError(let lerr), .networkError(let rerr)):
            return lerr.localizedDescription == rerr.localizedDescription
        case (.encodingError(let lerr), .encodingError(let rerr)):
            return lerr.localizedDescription == rerr.localizedDescription
        case (.decodingError(let lerr), .decodingError(let rerr)):
            return lerr.localizedDescription == rerr.localizedDescription
        default:
            return false
        }
    }
}
