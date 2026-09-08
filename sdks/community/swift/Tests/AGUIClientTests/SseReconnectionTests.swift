// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

// MARK: - SequencedHTTPClient

/// Test double that returns a pre-configured queue of responses/errors.
///
/// Enables deterministic retry scenarios without real network calls:
/// - `.success(HTTPResponse)` — returns the response normally
/// - `.failure(Error)` — throws before streaming begins (pre-stream failure)
/// - `.midStreamFailure(sseText:error:)` — streams bytes then throws mid-stream
actor SequencedHTTPClient: HTTPClient {

    enum Response: Sendable {
        case success(HTTPResponse)
        case failure(Error)
        /// Streams `sseText` as bytes, then throws `error` — simulates a network drop
        /// after the server has already sent some events.
        case midStreamFailure(sseText: String, error: Error)
    }

    private var queue: [Response]
    private(set) var requestHistory: [URLRequest] = []

    var executeCallCount: Int { requestHistory.count }

    init(responses: [Response]) {
        self.queue = responses
    }

    func execute(_ request: URLRequest) async throws -> HTTPResponse {
        requestHistory.append(request)
        precondition(!queue.isEmpty, "SequencedHTTPClient: ran out of responses")
        switch queue.removeFirst() {
        case .success(let response):
            return response
        case .failure(let error):
            throw error
        case .midStreamFailure(let sseText, let error):
            return Self.midStreamResponse(sseText: sseText, trailingError: error)
        }
    }

    /// Builds an HTTPResponse whose byte stream delivers `sseText` then throws.
    private static func midStreamResponse(sseText: String, trailingError: Error) -> HTTPResponse {
        let bytes = Data(sseText.utf8)
        let stream = AsyncThrowingStream<UInt8, Error> { continuation in
            for byte in bytes {
                continuation.yield(byte)
            }
            continuation.finish(throwing: trailingError)
        }
        let url = URL(string: "https://mock.local")!
        let httpResponse = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return HTTPResponse(bytes: stream, httpResponse: httpResponse)
    }
}

// MARK: - SseReconnectionTests

final class SseReconnectionTests: XCTestCase {

    // MARK: - Shared helpers

    private let baseURL = URL(string: "https://agent.example.com")!

    /// Minimal two-event SSE payload (RUN_STARTED + RUN_FINISHED).
    private var minimalSSE: String {
        """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
    }

    private func makeSuccessResponse() async throws -> HTTPResponse {
        try await HTTPResponse.mock(data: Data(minimalSSE.utf8), statusCode: 200)
    }

    private func makeAgent(
        retryPolicy: HttpAgentConfiguration.RetryPolicy,
        httpClient: any HTTPClient
    ) -> HttpAgent {
        let config = HttpAgentConfiguration(baseURL: baseURL, retryPolicy: retryPolicy)
        return HttpAgent(configuration: config, httpClient: httpClient)
    }

    private func makeInput() throws -> RunAgentInput {
        try RunAgentInput.builder().threadId("t1").runId("r1").build()
    }

    // MARK: - RetryPolicy.none — no retry on transient errors

    func testRetryPolicy_none_doesNotRetry_onTimeout() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.timeout),
        ])
        let agent = makeAgent(retryPolicy: .none, httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected ClientError.timeout to be thrown")
        } catch let error as ClientError {
            XCTAssertEqual(error, .timeout)
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1, ".none policy must not retry")
    }

    func testRetryPolicy_none_doesNotRetry_onNetworkError() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.networkError(URLError(.networkConnectionLost))),
        ])
        let agent = makeAgent(retryPolicy: .none, httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected error")
        } catch {}

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1)
    }

    // MARK: - RetryPolicy.fixed — retries on transient errors

    func testRetryPolicy_fixed_retriesOnTimeout_andSucceeds() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.timeout),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 2, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 2, "Should retry once after timeout and succeed")
        XCTAssertFalse(events.isEmpty, "Events must be delivered after successful retry")
    }

    func testRetryPolicy_fixed_retriesOnNetworkError_andSucceeds() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.networkError(URLError(.networkConnectionLost))),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 2, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 2, "Should retry once on network error")
        XCTAssertFalse(events.isEmpty)
    }

    func testRetryPolicy_fixed_exhaustsMaxAttempts_thenThrows() async throws {
        // maxAttempts: 2 → initial attempt + 2 retries = 3 total execute calls
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.timeout),
            .failure(ClientError.timeout),
            .failure(ClientError.timeout),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 2, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected error after exhausting retries")
        } catch let error as ClientError {
            XCTAssertEqual(error, .timeout, "Final error must be the last transient error")
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 3, "1 initial + 2 retries = 3 total")
    }

    func testRetryPolicy_fixed_doesNotRetry_onHTTPError() async throws {
        // HTTP errors (4xx/5xx) are not retryable — server explicitly rejected the request
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.httpError(statusCode: 500)),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 3, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected httpError")
        } catch let error as ClientError {
            if case .httpError(let code) = error {
                XCTAssertEqual(code, 500)
            } else {
                XCTFail("Expected httpError, got \(error)")
            }
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1, "HTTP errors must not trigger retry")
    }

    func testRetryPolicy_fixed_doesNotRetry_onInvalidResponse() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.invalidResponse),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 3, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected error")
        } catch {}

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 1, "invalidResponse must not trigger retry")
    }

    // MARK: - RetryPolicy.exponentialBackoff

    func testRetryPolicy_exponentialBackoff_retriesAndSucceeds() async throws {
        // Use baseDelay: 0 to keep the test fast
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.timeout),
            .failure(ClientError.timeout),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(
            retryPolicy: .exponentialBackoff(maxAttempts: 3, baseDelay: 0),
            httpClient: mockClient
        )
        let stream = agent.run(input: try makeInput())

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 3, "Should retry twice and succeed on third attempt")
        XCTAssertFalse(events.isEmpty)
    }

    func testRetryPolicy_exponentialBackoff_exhaustsAttempts_thenThrows() async throws {
        let mockClient = SequencedHTTPClient(responses: [
            .failure(ClientError.timeout),
            .failure(ClientError.timeout),
            .failure(ClientError.timeout),
        ])
        let agent = makeAgent(
            retryPolicy: .exponentialBackoff(maxAttempts: 2, baseDelay: 0),
            httpClient: mockClient
        )
        let stream = agent.run(input: try makeInput())

        do {
            for try await _ in stream {}
            XCTFail("Expected error")
        } catch let error as ClientError {
            XCTAssertEqual(error, .timeout)
        }

        let callCount = await mockClient.executeCallCount
        XCTAssertEqual(callCount, 3)
    }

    // MARK: - Last-Event-ID header on reconnect

    func testReconnect_sendsLastEventIdHeader_afterMidStreamFailure() async throws {
        // First response: delivers SSE with an id:, then drops mid-stream
        let sseWithId = """
        id: event-42
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}


        """

        let mockClient = SequencedHTTPClient(responses: [
            .midStreamFailure(sseText: sseWithId, error: ClientError.timeout),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 1, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        // Consume the stream — retry happens transparently
        for try await _ in stream {}

        let requests = await mockClient.requestHistory
        XCTAssertEqual(requests.count, 2, "Should have made 2 requests (1 initial + 1 retry)")
        XCTAssertEqual(
            requests[1].value(forHTTPHeaderField: "Last-Event-ID"),
            "event-42",
            "Retry request must carry the last seen SSE event id"
        )
    }

    func testReconnect_noLastEventIdHeader_whenFirstStreamHadNoId() async throws {
        // First response: SSE without any id: fields
        let sseWithoutId = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}


        """

        let mockClient = SequencedHTTPClient(responses: [
            .midStreamFailure(sseText: sseWithoutId, error: ClientError.timeout),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 1, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        for try await _ in stream {}

        let requests = await mockClient.requestHistory
        XCTAssertEqual(requests.count, 2)
        XCTAssertNil(
            requests[1].value(forHTTPHeaderField: "Last-Event-ID"),
            "No Last-Event-ID header when stream contained no SSE ids"
        )
    }

    func testReconnect_lastEventIdUpdatesToMostRecentId() async throws {
        // Stream delivers two events with different ids
        let sseMultipleIds = """
        id: id-001
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        id: id-002
        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """

        let mockClient = SequencedHTTPClient(responses: [
            .midStreamFailure(sseText: sseMultipleIds, error: ClientError.timeout),
            .success(try await makeSuccessResponse()),
        ])
        let agent = makeAgent(retryPolicy: .fixed(maxAttempts: 1, delay: 0), httpClient: mockClient)
        let stream = agent.run(input: try makeInput())

        for try await _ in stream {}

        let requests = await mockClient.requestHistory
        XCTAssertEqual(
            requests[1].value(forHTTPHeaderField: "Last-Event-ID"),
            "id-002",
            "Must use the LAST seen id, not the first"
        )
    }

    // MARK: - HttpTransport Last-Event-ID parameter

    func testHttpTransport_sendsLastEventIdHeader_whenProvided() async throws {
        let mockClient = MockHTTPClient()
        let response = try await HTTPResponse.mock(data: Data(minimalSSE.utf8), statusCode: 200)
        await mockClient.setResponse(response)

        let config = HttpAgentConfiguration(baseURL: baseURL)
        let transport = HttpTransport(configuration: config, httpClient: mockClient)
        let input = try makeInput()

        _ = try await transport.execute(endpoint: "/run", input: input, lastEventId: "event-99")

        let lastRequest = await mockClient.lastRequest
        XCTAssertEqual(
            lastRequest?.value(forHTTPHeaderField: "Last-Event-ID"),
            "event-99",
            "Transport must set Last-Event-ID header when lastEventId is provided"
        )
    }

    func testHttpTransport_doesNotSendLastEventIdHeader_whenNil() async throws {
        let mockClient = MockHTTPClient()
        let response = try await HTTPResponse.mock(data: Data(minimalSSE.utf8), statusCode: 200)
        await mockClient.setResponse(response)

        let config = HttpAgentConfiguration(baseURL: baseURL)
        let transport = HttpTransport(configuration: config, httpClient: mockClient)
        let input = try makeInput()

        _ = try await transport.execute(endpoint: "/run", input: input, lastEventId: nil)

        let lastRequest = await mockClient.lastRequest
        XCTAssertNil(
            lastRequest?.value(forHTTPHeaderField: "Last-Event-ID"),
            "Transport must not set Last-Event-ID header when lastEventId is nil"
        )
    }

    // MARK: - EventStream lastEventId property

    func testEventStream_tracksLastSseEventId() async throws {
        let sseData = """
        id: first-id
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        id: second-id
        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = asyncBytes(from: sseData)
        let stream = EventStream(bytes: bytes, decoder: AGUIEventDecoder())

        for try await _ in stream {}

        let lastId = await stream.lastEventId
        XCTAssertEqual(lastId, "second-id", "Must track the LAST seen SSE id")
    }

    func testEventStream_lastEventIdIsNil_whenStreamHasNoIds() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}


        """
        let bytes = asyncBytes(from: sseData)
        let stream = EventStream(bytes: bytes, decoder: AGUIEventDecoder())

        for try await _ in stream {}

        let lastId = await stream.lastEventId
        XCTAssertNil(lastId, "lastEventId must be nil when no id: fields appear")
    }

    func testEventStream_lastEventIdUpdatesAcrossEvents() async throws {
        let sseData = """
        id: alpha
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        id: beta
        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = asyncBytes(from: sseData)
        let stream = EventStream(bytes: bytes, decoder: AGUIEventDecoder())

        var idAfterFirst: String? = nil
        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
            if eventCount == 1 {
                idAfterFirst = await stream.lastEventId
            }
        }

        XCTAssertEqual(idAfterFirst, "alpha", "After first event, id should be 'alpha'")
        let finalId = await stream.lastEventId
        XCTAssertEqual(finalId, "beta", "After all events, id should be 'beta'")
    }

    func testEventStream_lastEventIdIsSetEvenWhenEventFailsToDecode() async throws {
        // The id: field must be captured even if the data: JSON is undecodable
        let sseData = """
        id: orphan-id
        data: this-is-not-valid-json


        """
        let bytes = asyncBytes(from: sseData)
        let stream = EventStream(bytes: bytes, decoder: AGUIEventDecoder())

        for try await _ in stream {}

        let lastId = await stream.lastEventId
        XCTAssertEqual(
            lastId,
            "orphan-id",
            "id must be captured even when event data fails to decode"
        )
    }

    // MARK: - Private helpers

    private func asyncBytes(from string: String) -> AsyncThrowingStream<UInt8, Error> {
        AsyncThrowingStream { continuation in
            for byte in Data(string.utf8) {
                continuation.yield(byte)
            }
            continuation.finish()
        }
    }
}
