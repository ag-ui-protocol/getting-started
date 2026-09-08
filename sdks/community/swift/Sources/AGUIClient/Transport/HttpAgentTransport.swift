// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

public struct HttpAgentTransport: AgentTransport {
    private let transport: HttpTransport
    private let decoder: AGUIEventDecoder
    private let endpoint: String
    private let configuration: HttpAgentConfiguration

    public init(configuration: HttpAgentConfiguration, endpoint: String = "/run") {
        self.configuration = configuration
        self.transport = HttpTransport(configuration: configuration)
        self.decoder = AGUIEventDecoder()
        self.endpoint = endpoint
    }

    public init(configuration: HttpAgentConfiguration, httpClient: any HTTPClient, endpoint: String = "/run") {
        self.configuration = configuration
        self.transport = HttpTransport(configuration: configuration, httpClient: httpClient)
        self.decoder = AGUIEventDecoder()
        self.endpoint = endpoint
    }

    /// Executes a raw HTTP request and returns the byte stream.
    ///
    /// Exposes the underlying transport's execute method so callers can share
    /// the same URLSession without creating a duplicate `HttpTransport`.
    ///
    /// - Parameters:
    ///   - endpoint: API endpoint path
    ///   - input: The run agent input
    ///   - lastEventId: Optional last SSE event ID for reconnection
    /// - Returns: Raw byte stream from the HTTP response
    public func execute(
        endpoint: String,
        input: RunAgentInput,
        lastEventId: String? = nil
    ) async throws -> AsyncThrowingStream<UInt8, Error> {
        try await transport.execute(
            endpoint: endpoint,
            input: input,
            lastEventId: lastEventId
        )
    }

    public func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        let transport = self.transport
        let decoder = self.decoder
        let endpoint = self.endpoint
        let configuration = self.configuration

        return AsyncThrowingStream { continuation in
            let task = Task {
                var lastEventId: String? = nil
                var attempt = 0
                var currentStream: EventStream<AsyncThrowingStream<UInt8, Error>>? = nil

                while true {
                    do {
                        let bytes = try await transport.execute(
                            endpoint: endpoint,
                            input: input,
                            lastEventId: lastEventId
                        )
                        let eventStream = EventStream(bytes: bytes, decoder: decoder)
                        currentStream = eventStream
                        for try await event in eventStream {
                            continuation.yield(event)
                        }
                        continuation.finish()
                        return
                    } catch {
                        if let stream = currentStream {
                            lastEventId = await stream.lastEventId ?? lastEventId
                        }
                        currentStream = nil

                        guard shouldRetry(error: error, attempt: attempt, configuration: configuration) else {
                            continuation.finish(throwing: error)
                            return
                        }

                        let delay = retryDelay(for: attempt, configuration: configuration)
                        attempt += 1

                        if delay > 0 {
                            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                        }
                    }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func shouldRetry(error: Error, attempt: Int, configuration: HttpAgentConfiguration) -> Bool {
        guard isRetryable(error) else { return false }
        switch configuration.retryPolicy {
        case .none:
            return false
        case .fixed(let maxAttempts, _):
            return attempt < maxAttempts
        case .exponentialBackoff(let maxAttempts, _):
            return attempt < maxAttempts
        }
    }

    private func isRetryable(_ error: Error) -> Bool {
        guard let clientError = error as? ClientError else { return false }
        switch clientError {
        case .timeout, .networkError:
            return true
        default:
            return false
        }
    }

    private func retryDelay(for attempt: Int, configuration: HttpAgentConfiguration) -> TimeInterval {
        switch configuration.retryPolicy {
        case .none:
            return 0
        case .fixed(_, let delay):
            return delay
        case .exponentialBackoff(_, let baseDelay):
            return min(baseDelay * pow(2.0, Double(attempt)), 60.0)
        }
    }
}
