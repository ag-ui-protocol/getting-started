// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

/// Comprehensive tests for HttpAgent public API.
///
/// Tests the high-level API for AG-UI agent communication including:
/// - Initialization and configuration
/// - Run methods with different input styles
/// - Builder pattern integration
/// - Event streaming
/// - Error handling
final class HttpAgentTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithURL() {
        let url = URL(string: "https://agent.example.com")!
        let agent = HttpAgent(baseURL: url)

        // Verify agent was created
        XCTAssertNotNil(agent)
    }

    func testInitWithConfiguration() {
        let url = URL(string: "https://agent.example.com")!
        var config = HttpAgentConfiguration(baseURL: url)
        config.timeout = 60.0
        config.headers = ["X-Custom": "Value"]

        let agent = HttpAgent(configuration: config)

        XCTAssertNotNil(agent)
    }

    func testInitWithCustomHTTPClient() async {
        let url = URL(string: "https://agent.example.com")!
        let config = HttpAgentConfiguration(baseURL: url)
        let mockClient = MockHTTPClient()

        let agent = HttpAgent(configuration: config, httpClient: mockClient)

        XCTAssertNotNil(agent)
    }

    // MARK: - Run Method Tests

    func testRunWithRunAgentInput() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        // Execute
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        let stream = try await agent.run(input)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 2)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is RunFinishedEvent)
    }

    func testRunWithBuilder() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"Hello"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        // Execute with builder
        let stream = try await agent.run(threadId: "thread-1", runId: "run-1") { builder in
            builder.message(UserMessage(
                id: "user1",
                content: "Hello"
            ))
        }

        var events: [any AGUIEvent] = []
        var textChunks: [String] = []

        for try await event in stream {
            events.append(event)
            if let chunk = event as? TextMessageChunkEvent, let delta = chunk.delta {
                textChunks.append(delta)
            }
        }

        XCTAssertEqual(events.count, 5)
        XCTAssertEqual(textChunks.joined(), "Hello")
    }

    func testRunWithMinimalInput() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        // Execute with just thread and run IDs
        let stream = try await agent.run(threadId: "t1", runId: "r1")

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        XCTAssertEqual(eventCount, 2)
    }

    // MARK: - Error Handling Tests

    func testRunHandlesHTTPError() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure error response
        await mockClient.setError(ClientError.httpError(statusCode: 500))

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        do {
            _ = try await agent.run(input)
            XCTFail("Expected error to be thrown")
        } catch let error as ClientError {
            if case .httpError(let statusCode) = error {
                XCTAssertEqual(statusCode, 500)
            } else {
                XCTFail("Expected httpError, got \(error)")
            }
        }
    }

    func testRunHandlesNetworkError() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure network error
        await mockClient.setError(ClientError.timeout)

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        do {
            _ = try await agent.run(input)
            XCTFail("Expected timeout error")
        } catch let error as ClientError {
            if case .timeout = error {
                // Success
            } else {
                XCTFail("Expected timeout error, got \(error)")
            }
        }
    }

    // MARK: - Integration Tests

    func testRunWithMessagesAndTools() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        // Create tool
        let weatherTool = Tool(
            name: "get_weather",
            description: "Get weather for a location",
            parameters: Data("{}".utf8)
        )

        // Execute with messages and tools
        let stream = try await agent.run(threadId: "t1", runId: "r1") { builder in
            builder
                .message(DeveloperMessage(
                    id: "dev1",
                    content: "You are a helpful assistant"
                ))
                .message(UserMessage(
                    id: "user1",
                    content: "What's the weather?"
                ))
                .tool(weatherTool)
        }

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        XCTAssertGreaterThan(eventCount, 0)

        // Verify request was made with correct data
        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1)
    }

    func testRunWithContext() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        // Execute with context
        let stream = try await agent.run(threadId: "t1", runId: "r1") { builder in
            builder.context([Context(
                description: "User timezone",
                value: "America/New_York"
            )])
        }

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        XCTAssertGreaterThan(eventCount, 0)
    }

    // MARK: - Custom Endpoint Tests

    func testRunWithCustomEndpoint() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        // Execute with custom endpoint
        let stream = try await agent.run(input, endpoint: "/custom/run")

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        XCTAssertGreaterThan(eventCount, 0)

        // Verify custom endpoint was used
        let lastRequest = await mockClient.lastRequest
        XCTAssertEqual(lastRequest?.url?.path, "/custom/run")
    }

    // MARK: - Stream Cancellation Tests

    func testRunStreamCanBeCancelled() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Configure mock response with many events
        var sseData = ""
        for i in 0..<100 {
            sseData += "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"delta\":\"\(i)\"}\n\n"
        }

        let mockResponse = try await HTTPResponse.mock(
            data: Data(sseData.utf8),
            statusCode: 200
        )
        await mockClient.setResponse(mockResponse)

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        let stream = try await agent.run(input)

        // Cancel after 5 events
        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
            if eventCount >= 5 {
                break
            }
        }

        XCTAssertEqual(eventCount, 5)
    }

    // MARK: - Thread Safety Tests

    func testSequentialRuns() async throws {
        let url = URL(string: "https://agent.example.com")!
        let mockClient = MockHTTPClient()
        let agent = HttpAgent(
            configuration: HttpAgentConfiguration(baseURL: url),
            httpClient: mockClient
        )

        // Run multiple sequential requests to verify HttpAgent is reusable
        for i in 0..<3 {
            let sseData = """
            data: {"type":"RUN_STARTED","threadId":"t\(i)","runId":"r\(i)"}

            data: {"type":"RUN_FINISHED","threadId":"t\(i)","runId":"r\(i)"}


            """
            let mockResponse = try await HTTPResponse.mock(
                data: Data(sseData.utf8),
                statusCode: 200
            )
            await mockClient.setResponse(mockResponse)

            let input = try RunAgentInput.builder()
                .threadId("t\(i)")
                .runId("r\(i)")
                .build()

            let stream = try await agent.run(input)

            var eventCount = 0
            for try await _ in stream {
                eventCount += 1
            }

            XCTAssertEqual(eventCount, 2, "Run \(i) should have 2 events")
        }
    }
}
