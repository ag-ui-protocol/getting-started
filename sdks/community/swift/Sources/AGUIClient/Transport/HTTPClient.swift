// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Protocol for HTTP client operations.
///
/// `HTTPClient` abstracts HTTP networking, enabling dependency injection
/// and testability. Implementations can use URLSession, mock responses,
/// or custom networking stacks.
///
/// ## Example Implementation
///
/// ```swift
/// actor URLSessionHTTPClient: HTTPClient {
///     private let session: URLSession
///
///     init(session: URLSession) {
///         self.session = session
///     }
///
///     func execute(_ request: URLRequest) async throws -> HTTPResponse {
///         let (bytes, urlResponse) = try await session.bytes(for: request)
///         guard let httpResponse = urlResponse as? HTTPURLResponse else {
///             throw ClientError.invalidResponse
///         }
///         return HTTPResponse(bytes: bytes, httpResponse: httpResponse)
///     }
/// }
/// ```
public protocol HTTPClient: Sendable {
    /// Executes an HTTP request and returns the response.
    ///
    /// - Parameter request: The URL request to execute
    /// - Returns: An HTTP response containing streaming bytes and metadata
    /// - Throws: `ClientError` if the request fails
    func execute(_ request: URLRequest) async throws -> HTTPResponse
}

/// HTTP response containing streaming bytes and metadata.
///
/// `bytes` is typed as `AsyncThrowingStream<UInt8, Error>` rather than
/// `URLSession.AsyncBytes` so that:
/// - Mock `HTTPClient` implementations can produce byte streams without a live URLSession
/// - The transport layer is testable in isolation
/// - Consumers of `HTTPClient` are decoupled from URLSession internals
public struct HTTPResponse: Sendable {
    /// Streaming response bytes.
    ///
    /// Conforms to `AsyncSequence` producing `UInt8` values, allowing
    /// incremental consumption of the response body.
    public let bytes: AsyncThrowingStream<UInt8, Error>

    /// HTTP response metadata.
    public let httpResponse: HTTPURLResponse

    /// HTTP status code.
    public var statusCode: Int {
        httpResponse.statusCode
    }

    /// Response headers.
    public var headers: [AnyHashable: Any] {
        httpResponse.allHeaderFields
    }

    /// Creates a new HTTP response.
    ///
    /// - Parameters:
    ///   - bytes: Streaming response bytes as an `AsyncThrowingStream<UInt8, Error>`
    ///   - httpResponse: HTTP response metadata
    public init(bytes: AsyncThrowingStream<UInt8, Error>, httpResponse: HTTPURLResponse) {
        self.bytes = bytes
        self.httpResponse = httpResponse
    }
}
