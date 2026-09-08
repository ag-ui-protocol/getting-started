// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation
@testable import AGUIClient

/// Mock HTTP client for testing.
///
/// `MockHTTPClient` enables testing of HTTP transport without network calls.
/// Configure it to return specific responses or throw errors.
///
/// ## Example
///
/// ```swift
/// let mock = MockHTTPClient()
/// mock.responseToReturn = HTTPResponse(
///     bytes: mockBytes,
///     httpResponse: HTTPURLResponse(...)
/// )
///
/// let transport = HttpTransport(
///     configuration: config,
///     httpClient: mock
/// )
///
/// // Now transport.execute() returns the mocked response
/// ```
actor MockHTTPClient: HTTPClient {
    /// Response to return from execute().
    var responseToReturn: HTTPResponse?

    /// Error to throw from execute().
    var errorToThrow: Error?

    /// Records all requests made to execute().
    var requestsReceived: [URLRequest] = []

    /// Number of times execute() was called.
    var executeCallCount: Int {
        requestsReceived.count
    }

    /// The most recent request received.
    var lastRequest: URLRequest? {
        requestsReceived.last
    }

    func execute(_ request: URLRequest) async throws -> HTTPResponse {
        requestsReceived.append(request)

        if let error = errorToThrow {
            throw error
        }

        guard let response = responseToReturn else {
            fatalError("MockHTTPClient: responseToReturn not set")
        }

        return response
    }

    /// Resets the mock to initial state.
    func reset() {
        responseToReturn = nil
        errorToThrow = nil
        requestsReceived.removeAll()
    }

    /// Convenience method to set the response to return.
    func setResponse(_ response: HTTPResponse) {
        responseToReturn = response
        errorToThrow = nil
    }

    /// Convenience method to set the error to throw.
    func setError(_ error: Error) {
        errorToThrow = error
        responseToReturn = nil
    }
}

/// Mock bytes sequence for testing.
///
/// Creates an AsyncSequence of bytes from a Data object with controllable chunking.
public struct MockAsyncBytes: AsyncSequence {
    public typealias Element = UInt8

    private let data: Data
    private let chunkSize: Int

    /// Creates a mock async bytes sequence.
    ///
    /// - Parameters:
    ///   - data: The data to stream as bytes
    ///   - chunkSize: Number of bytes per chunk for simulating network delays (default: 1)
    public init(data: Data, chunkSize: Int = 1) {
        self.data = data
        self.chunkSize = chunkSize
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(data: data, chunkSize: chunkSize)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private let data: Data
        private let chunkSize: Int
        private var index: Int = 0

        init(data: Data, chunkSize: Int) {
            self.data = data
            self.chunkSize = chunkSize
        }

        public mutating func next() async throws -> UInt8? {
            guard index < data.count else { return nil }

            // Simulate variable delay to mimic network
            if index > 0, index % chunkSize == 0 {
                try await Task.sleep(nanoseconds: 100_000) // 0.1ms
            }

            let byte = data[index]
            index += 1
            return byte
        }
    }
}

/// Thread-safe registry for mock URL responses.
///
/// `MockURLProtocolRegistry` provides isolated, thread-safe mock configuration
/// per URLSession configuration. Each registry instance is independent, preventing
/// test interference.
///
/// ## Example
///
/// ```swift
/// let registry = MockURLProtocolRegistry()
/// await registry.register(
///     url: URL(string: "https://test.com")!,
///     data: Data("test".utf8),
///     statusCode: 200
/// )
///
/// let session = URLSession.makeMockSession(registry: registry)
/// // Requests to https://test.com will return the mocked response
/// ```
actor MockURLProtocolRegistry {
    /// Unique identifier for this registry
    let id = UUID()

    private var responses: [String: MockResponse] = [:]

    struct MockResponse: Sendable {
        let data: Data?
        let httpResponse: HTTPURLResponse?
        let error: Error?
    }

    /// Registers a mock response for a specific URL.
    func register(
        url: URL,
        data: Data? = nil,
        statusCode: Int = 200,
        headers: [String: String] = [:],
        error: Error? = nil
    ) {
        let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )

        responses[url.absoluteString] = MockResponse(
            data: data,
            httpResponse: httpResponse,
            error: error
        )
    }

    /// Retrieves the mock response for a URL.
    func response(for url: URL) -> MockResponse? {
        responses[url.absoluteString]
    }

    /// Clears all registered responses.
    func reset() {
        responses.removeAll()
    }
}

/// Global registry manager for MockURLProtocol.
///
/// This actor maintains a thread-safe mapping of registry IDs to their
/// corresponding MockURLProtocolRegistry instances. MockURLProtocol uses
/// this to look up the correct registry for each request.
actor MockURLProtocolRegistryManager {
    static let shared = MockURLProtocolRegistryManager()

    private var registries: [UUID: MockURLProtocolRegistry] = [:]

    /// Registers a registry and returns its ID.
    func register(_ registry: MockURLProtocolRegistry) async -> UUID {
        let id = await registry.id
        registries[id] = registry
        return id
    }

    /// Retrieves a registry by ID.
    func registry(for id: UUID) -> MockURLProtocolRegistry? {
        registries[id]
    }

    /// Unregisters a registry.
    func unregister(_ id: UUID) {
        registries.removeIf(id: id)
    }

    /// Clears all registries.
    func reset() {
        registries.removeAll()
    }
}

extension Dictionary where Key == UUID {
    mutating func removeIf(id: UUID) {
        removeValue(forKey: id)
    }
}

/// Mock URLProtocol for testing HTTP responses.
///
/// This protocol intercepts URLSession requests and returns mock data from a
/// thread-safe registry, enabling isolated testing without network calls.
///
/// ## Usage
///
/// Don't instantiate this directly. Use `URLSession.makeMockSession(registry:)`
/// to create a properly configured test session.
///
/// ## Example
///
/// ```swift
/// let registry = MockURLProtocolRegistry()
/// await registry.register(
///     url: URL(string: "https://api.example.com/data")!,
///     data: Data("response".utf8),
///     statusCode: 200
/// )
///
/// let session = URLSession.makeMockSession(registry: registry)
/// let client = URLSessionHTTPClient(session: session)
///
/// // Requests will use mocked responses from registry
/// let (data, _) = try await session.data(from: URL(string: "https://api.example.com/data")!)
/// ```
final class MockURLProtocol: URLProtocol {
    /// Header key for passing the registry ID
    static let registryIDHeader = "X-MockURLProtocol-Registry-ID"

    override class func canInit(with request: URLRequest) -> Bool {
        // Only handle requests that have a registry ID header
        request.value(forHTTPHeaderField: registryIDHeader) != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        // Get registry ID from header
        guard let registryIDString = request.value(forHTTPHeaderField: Self.registryIDHeader),
              let registryID = UUID(uuidString: registryIDString)
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }

        // Retrieve mock response
        Task {
            // Get registry from global manager
            guard let registry = await MockURLProtocolRegistryManager.shared.registry(for: registryID) else {
                self.client?.urlProtocol(self, didFailWithError: URLError(.unknown))
                return
            }

            let mockResponse = await registry.response(for: url)

            // If no mock response found, return error
            guard let mockResponse = mockResponse else {
                let error = URLError(
                    .resourceUnavailable,
                    userInfo: [NSLocalizedDescriptionKey: "No mock response registered for \(url)"]
                )
                self.client?.urlProtocol(self, didFailWithError: error)
                return
            }

            // Handle error
            if let error = mockResponse.error {
                self.client?.urlProtocol(self, didFailWithError: error)
                return
            }

            // Send response
            if let httpResponse = mockResponse.httpResponse {
                self.client?.urlProtocol(
                    self,
                    didReceive: httpResponse,
                    cacheStoragePolicy: .notAllowed
                )
            }

            // Send data
            if let data = mockResponse.data {
                self.client?.urlProtocol(self, didLoad: data)
            }

            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        // No-op
    }
}

extension HTTPResponse {
    /// Creates a mock HTTP response for testing with URLProtocol.
    ///
    /// - Parameters:
    ///   - data: Response body data
    ///   - statusCode: HTTP status code (default: 200)
    ///   - headers: HTTP headers (default: empty)
    /// - Returns: A mock HTTPResponse with real URLSession.AsyncBytes
    ///
    /// This method creates a real HTTPResponse using MockURLProtocol with an
    /// isolated registry. The returned response contains actual URLSession.AsyncBytes
    /// that can be consumed in tests.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let response = try await HTTPResponse.mock(
    ///     data: Data("test data".utf8),
    ///     statusCode: 200,
    ///     headers: ["Content-Type": "text/plain"]
    /// )
    ///
    /// for try await byte in response.bytes {
    ///     print(byte)
    /// }
    /// ```
    static func mock(
        data: Data = Data(),
        statusCode: Int = 200,
        headers: [String: String] = [:]
    ) async throws -> HTTPResponse {
        let url = URL(string: "https://test-mock.local/response")!

        // Create isolated registry for this mock
        let registry = MockURLProtocolRegistry()
        await registry.register(
            url: url,
            data: data,
            statusCode: statusCode,
            headers: headers
        )

        // Create session with mock protocol
        let session = await URLSession.makeMockSession(registry: registry)

        // Execute request to get bytes
        let (asyncBytes, response) = try await session.bytes(for: URLRequest(url: url))

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }

        // Bridge URLSession.AsyncBytes → AsyncThrowingStream<UInt8, Error>
        let stream = AsyncThrowingStream<UInt8, Error> { continuation in
            Task {
                do {
                    for try await byte in asyncBytes {
                        continuation.yield(byte)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }

        return HTTPResponse(bytes: stream, httpResponse: httpResponse)
    }
}

extension URLSession {
    /// Creates a URLSession configured with MockURLProtocol for testing.
    ///
    /// - Parameter registry: The mock response registry to use
    /// - Returns: A configured URLSession that uses mocked responses
    ///
    /// This factory method creates an ephemeral URLSession that intercepts
    /// requests using MockURLProtocol and returns responses from the provided
    /// registry. Each session is isolated with its own registry, preventing
    /// test interference.
    ///
    /// The registry is automatically registered with the global registry manager
    /// and cleaned up when appropriate.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let registry = MockURLProtocolRegistry()
    /// await registry.register(
    ///     url: URL(string: "https://api.test.com/data")!,
    ///     data: Data("response".utf8),
    ///     statusCode: 200
    /// )
    ///
    /// let session = await URLSession.makeMockSession(registry: registry)
    /// let client = URLSessionHTTPClient(session: session)
    ///
    /// // All requests through this client will use mocked responses
    /// let response = try await client.execute(request)
    /// ```
    static func makeMockSession(registry: MockURLProtocolRegistry) async -> URLSession {
        // Register the registry with the global manager
        let registryID = await MockURLProtocolRegistryManager.shared.register(registry)

        // Create configuration with MockURLProtocol
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]

        // Add registry ID to default headers so all requests include it
        config.httpAdditionalHeaders = [
            MockURLProtocol.registryIDHeader: registryID.uuidString,
        ]

        return URLSession(configuration: config)
    }
}

extension URLSession {
    /// Creates a test URLSession with mocked responses for specific URLs.
    ///
    /// This is a convenience method for creating a mock session with pre-configured
    /// responses. For more control, use `makeMockSession(registry:)` directly.
    ///
    /// - Parameters:
    ///   - mockResponses: Dictionary mapping URLs to mock response data
    ///   - defaultStatusCode: Default status code for all responses (default: 200)
    /// - Returns: A configured URLSession with mocked responses
    ///
    /// ## Example
    ///
    /// ```swift
    /// let session = await URLSession.makeMockSession(
    ///     mockResponses: [
    ///         URL(string: "https://api.test.com/users")!: Data("[...]".utf8),
    ///         URL(string: "https://api.test.com/posts")!: Data("[...]".utf8)
    ///     ]
    /// )
    /// ```
    static func makeMockSession(
        mockResponses: [URL: Data],
        defaultStatusCode: Int = 200
    ) async -> URLSession {
        let registry = MockURLProtocolRegistry()

        for (url, data) in mockResponses {
            await registry.register(
                url: url,
                data: data,
                statusCode: defaultStatusCode
            )
        }

        return await makeMockSession(registry: registry)
    }
}
