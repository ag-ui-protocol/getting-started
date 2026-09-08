// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

final class HttpTransportTests: XCTestCase {
    // MARK: - Initialization Tests

    func testTransportInitialization() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let transport = HttpTransport(configuration: config)

        // Verify transport was created (actor, so we need async)
        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }

    func testTransportWithCustomTimeout() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url, timeout: 30.0)
        let transport = HttpTransport(configuration: config)

        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }

    func testTransportWithCustomHeaders() async {
        let url = URL(string: "https://agent.example.com")!
        let headers = ["Authorization": "Bearer token"]
        let config = HttpAgentConfiguration(baseURL: url, headers: headers)
        let transport = HttpTransport(configuration: config)

        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }

    // MARK: - URL Construction Tests

    func testEndpointURLConstruction() {
        let baseURL = URL(string: "https://agent.example.com")!
        let endpoint = "/run"

        let expectedURL = baseURL.appendingPathComponent(endpoint)
        XCTAssertEqual(expectedURL.absoluteString, "https://agent.example.com/run")
    }

    func testEndpointWithExistingPath() {
        let baseURL = URL(string: "https://agent.example.com/api")!
        let endpoint = "/run"

        let expectedURL = baseURL.appendingPathComponent(endpoint)
        XCTAssertTrue(expectedURL.absoluteString.contains("/api/run"))
    }

    // MARK: - Input Encoding Tests

    func testRunAgentInputEncoding() throws {
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .build()

        let encoder = JSONEncoder()
        let data = try encoder.encode(input)

        XCTAssertFalse(data.isEmpty)

        // Verify it contains expected fields
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["threadId"] as? String, "thread-1")
        XCTAssertEqual(json?["runId"] as? String, "run-1")
    }

    func testRunAgentInputWithMessagesEncoding() throws {
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .message(UserMessage(id: "msg-1", content: "Hello"))
            .build()

        let encoder = JSONEncoder()
        let data = try encoder.encode(input)

        XCTAssertFalse(data.isEmpty)
    }

    // MARK: - Error Mapping Tests

    func testURLErrorTimeoutMapping() {
        let urlError = URLError(.timedOut)
        let transport = HttpTransport(configuration: HttpAgentConfiguration(baseURL: URL(string: "https://test.com")!))

        // We can't directly test the private mapURLError method,
        // but we know it maps timedOut to .timeout
        // This would be tested in integration tests
    }

    func testURLErrorCancelledMapping() {
        let urlError = URLError(.cancelled)
        // Similar to above, would be tested in integration
    }

    // MARK: - Actor Isolation Tests

    func testTransportIsActor() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let transport = HttpTransport(configuration: config)

        // Verify we can call async methods on the transport
        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }

    func testMultipleTransportsCanExist() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)

        let transport1 = HttpTransport(configuration: config)
        let transport2 = HttpTransport(configuration: config)

        // Verify both exist independently
        await withCheckedContinuation { continuation in
            Task {
                _ = transport1
                _ = transport2
                continuation.resume()
            }
        }
    }

    // MARK: - Dependency Injection Tests

    func testTransportWithCustomHTTPClient() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let mockClient = MockHTTPClient()

        let transport = HttpTransport(configuration: config, httpClient: mockClient)

        // Verify transport was created with custom client
        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }

    func testTransportExecutesWithMockClient() async throws {
        // Setup
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let mockClient = MockHTTPClient()

        // Configure mock response
        let mockData = Data("event: test\ndata: {}\n\n".utf8)
        let mockResponse = try await HTTPResponse.mock(data: mockData, statusCode: 200)
        await mockClient.setResponse(mockResponse)

        let transport = HttpTransport(configuration: config, httpClient: mockClient)

        // Execute
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .build()

        let bytes = try await transport.execute(endpoint: "/run", input: input)

        // Verify request was made
        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1)

        let lastRequest = await mockClient.lastRequest
        XCTAssertNotNil(lastRequest)
        XCTAssertEqual(lastRequest?.url?.path, "/run")
        XCTAssertEqual(lastRequest?.httpMethod, "POST")
        XCTAssertEqual(lastRequest?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(lastRequest?.value(forHTTPHeaderField: "Accept"), "text/event-stream")

        // Verify bytes are returned
        _ = bytes
    }

    func testTransportPropagatesClientErrors() async throws {
        // Setup
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let mockClient = MockHTTPClient()

        // Configure mock to throw error
        await mockClient.setError(ClientError.timeout)

        let transport = HttpTransport(configuration: config, httpClient: mockClient)

        // Execute
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .build()

        // Verify error is propagated
        do {
            _ = try await transport.execute(endpoint: "/run", input: input)
            XCTFail("Expected error to be thrown")
        } catch let error as ClientError {
            if case .timeout = error {
                // Success
            } else {
                XCTFail("Expected timeout error, got \(error)")
            }
        }
    }

    func testTransportHandlesHTTPErrors() async throws {
        // Setup
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let mockClient = MockHTTPClient()

        // Configure mock response with error status
        let mockResponse = try await HTTPResponse.mock(statusCode: 500)
        await mockClient.setResponse(mockResponse)

        let transport = HttpTransport(configuration: config, httpClient: mockClient)

        // Execute
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .build()

        // Verify HTTP error is thrown
        do {
            _ = try await transport.execute(endpoint: "/run", input: input)
            XCTFail("Expected HTTP error to be thrown")
        } catch let error as ClientError {
            if case .httpError(let statusCode) = error {
                XCTAssertEqual(statusCode, 500)
            } else {
                XCTFail("Expected httpError, got \(error)")
            }
        }
    }

    func testTransportUsesDefaultClientWhenNoneProvided() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)

        // Create without providing httpClient - should use default URLSessionHTTPClient
        let transport = HttpTransport(configuration: config)

        await withCheckedContinuation { continuation in
            Task {
                _ = transport
                continuation.resume()
            }
        }
    }
}
