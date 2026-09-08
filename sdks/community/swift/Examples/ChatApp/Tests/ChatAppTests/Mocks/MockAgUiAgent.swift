// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIAgentSDK
import AGUICore
import Foundation

/// A scriptable `AgUiAgent` subclass used in unit tests.
///
/// Set `events` before calling any store method that triggers a run.
/// Set `errorToThrow` to simulate network or protocol errors.
final class MockAgUiAgent: AgUiAgent {
    /// Ordered events to emit when `run(input:)` is called.
    var events: [any AGUIEvent] = []
    /// When non-nil, this error is thrown instead of emitting events.
    var errorToThrow: Error?

    init() {
        // URL is unused — `run(input:)` is fully overridden.
        super.init(url: URL(string: "https://mock.test.local")!)
    }

    override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        let events = self.events
        let error = self.errorToThrow
        return AsyncThrowingStream { continuation in
            Task {
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }
    }
}
