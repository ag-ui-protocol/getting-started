// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation
@testable import AGUIAgentSDK

/// Test double for `ChatAgent`.
///
/// Configured and read exclusively from `@MainActor` context (both test classes
/// are `@MainActor`), so `@MainActor` isolation satisfies the `Sendable` requirement
/// without locks or `@unchecked`.
@MainActor
final class MockChatAgent: ChatAgent, Sendable {

    // MARK: - Configuration (set before each test)

    /// Events that `chat()` will yield through the returned stream.
    var eventsToYield: [any AGUIEvent] = []

    /// When set, `chat()` itself throws this error before returning a stream.
    var chatThrows: Error? = nil

    /// When set, the returned stream finishes by throwing this error.
    var streamThrows: Error? = nil

    // MARK: - Captured invocations (assert after the test)

    private(set) var chatCalls: [(message: String, threadId: String)] = []
    private(set) var clearCalls: [String?] = []

    // MARK: - ChatAgent conformance

    func chat(
        message: String,
        threadId: String
    ) async throws -> AsyncThrowingStream<any AGUIEvent, Error> {
        chatCalls.append((message: message, threadId: threadId))

        if let err = chatThrows { throw err }

        let events = eventsToYield
        let streamError = streamThrows

        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish(throwing: streamError)
        }
    }

    func clearHistory(threadId: String?) async {
        clearCalls.append(threadId)
    }
}
