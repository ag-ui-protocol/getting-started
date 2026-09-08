// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// URLSession-based HTTP client implementation.
///
/// `URLSessionHTTPClient` is the default HTTP client that uses Apple's
/// URLSession for networking. It supports full URLSession configuration
/// and can be injected with a custom session for testing.
///
/// ## Example
///
/// ```swift
/// // Default usage
/// let client = URLSessionHTTPClient.create()
///
/// // Custom configuration
/// let config = URLSessionConfiguration.default
/// config.timeoutIntervalForRequest = 30
/// let session = URLSession(configuration: config)
/// let client = URLSessionHTTPClient(session: session)
///
/// // Execute request
/// let request = URLRequest(url: url)
/// let response = try await client.execute(request)
/// ```
public actor URLSessionHTTPClient: HTTPClient {
    private let session: URLSession

    /// Creates a new URLSession HTTP client with the specified session.
    ///
    /// This is the primary initializer that accepts a URLSession instance,
    /// enabling full control over session configuration and injection of
    /// mock sessions for testing.
    ///
    /// - Parameter session: The URLSession to use for requests
    ///
    /// ## Example
    ///
    /// ```swift
    /// let config = URLSessionConfiguration.default
    /// config.timeoutIntervalForRequest = 60
    /// let session = URLSession(configuration: config)
    /// let client = URLSessionHTTPClient(session: session)
    /// ```
    public init(session: URLSession) {
        self.session = session
    }

    deinit {
        // Release OS-level socket pool and free the session delegate.
        // invalidateAndCancel() is synchronous and safe to call from deinit.
        session.invalidateAndCancel()
    }

    /// Creates a new URLSession HTTP client with the specified configuration.
    ///
    /// This factory method provides a convenient way to create a client
    /// with custom URLSession configuration.
    ///
    /// - Parameter configuration: URLSession configuration (default: .default)
    /// - Returns: A new URLSession HTTP client
    ///
    /// ## Example
    ///
    /// ```swift
    /// let config = URLSessionConfiguration.ephemeral
    /// config.timeoutIntervalForRequest = 30
    /// let client = URLSessionHTTPClient.create(configuration: config)
    /// ```
    public static func create(
        configuration: URLSessionConfiguration = .default
    ) -> URLSessionHTTPClient {
        let session = URLSession(configuration: configuration)
        return URLSessionHTTPClient(session: session)
    }

    /// Executes an HTTP request using URLSession.
    ///
    /// - Parameter request: The URL request to execute
    /// - Returns: An HTTP response containing streaming bytes and metadata
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Error Mapping
    ///
    /// URLErrors are mapped to ClientError:
    /// - `.timedOut` → `.timeout`
    /// - `.cancelled` → `.cancelled`
    /// - Other errors → `.networkError`
    public func execute(_ request: URLRequest) async throws -> HTTPResponse {
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)

        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch let error as URLError {
            throw mapURLError(error)
        } catch {
            throw ClientError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }

        // Bridge URLSession.AsyncBytes → AsyncThrowingStream<UInt8, Error> so that
        // HTTPResponse is decoupled from URLSession and can be mocked in tests.
        let stream = AsyncThrowingStream<UInt8, Error> { continuation in
            let task = Task {
                do {
                    for try await byte in bytes {
                        continuation.yield(byte)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }

        return HTTPResponse(bytes: stream, httpResponse: httpResponse)
    }

    /// Maps URLError to ClientError.
    private func mapURLError(_ error: URLError) -> ClientError {
        switch error.code {
        case .timedOut:
            return .timeout
        case .cancelled:
            return .cancelled
        default:
            return .networkError(error)
        }
    }
}
