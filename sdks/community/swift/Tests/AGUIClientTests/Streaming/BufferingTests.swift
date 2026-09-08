// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

/// Comprehensive tests for backpressure and buffering operators.
///
/// Tests flow control mechanisms for handling varying producer/consumer speeds:
/// - Bounded buffering with overflow strategies
/// - Event batching by count or time
/// - Throttling and sampling
/// - Memory safety guarantees
final class BufferingTests: XCTestCase {
    // MARK: - Buffering Strategy Tests

    func testBufferedDropOldest() async throws {
        // Create fast producer (10 events)
        let events = (0..<10).map { "event-\($0)" }
        let source = AsyncStream<String> { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                    try? await Task.sleep(nanoseconds: 1_000_000) // 1ms
                }
                continuation.finish()
            }
        }

        // Buffer with limit 3, drop oldest
        let buffered = source.buffered(limit: 3, strategy: .dropOldest)

        // Slow consumer (50ms per event)
        var received: [String] = []
        for try await event in buffered {
            received.append(event)
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms - intentionally slow
        }

        // Should have dropped some oldest events due to buffer limit
        XCTAssertLessThan(received.count, events.count)
        // Should have most recent events
        XCTAssertTrue(received.contains("event-9"))
    }

    func testBufferedDropNewest() async throws {
        // Create fast producer
        let events = (0..<10).map { "event-\($0)" }
        let source = AsyncStream<String> { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                    try? await Task.sleep(nanoseconds: 1_000_000)
                }
                continuation.finish()
            }
        }

        // Buffer with limit 3, drop newest
        let buffered = source.buffered(limit: 3, strategy: .dropNewest)

        var received: [String] = []
        for try await event in buffered {
            received.append(event)
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        // Should have dropped some newest events
        XCTAssertLessThan(received.count, events.count)
        // Should have oldest events
        XCTAssertTrue(received.contains("event-0"))
    }

    func testBufferedWithinLimit() async throws {
        // Producer and consumer at similar speeds
        let events = (0..<5).map { "event-\($0)" }
        let source = AsyncStream<String> { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }

        let buffered = source.buffered(limit: 10, strategy: .dropOldest)

        var received: [String] = []
        for try await event in buffered {
            received.append(event)
        }

        // Buffer never fills, should receive all
        XCTAssertEqual(received.count, events.count)
        XCTAssertEqual(received, events)
    }

    // MARK: - Batching Tests

    func testBatchedByCount() async throws {
        // Create stream of individual events
        let events = (0..<10).map { "event-\($0)" }
        let source = AsyncStream<String> { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                    try? await Task.sleep(nanoseconds: 5_000_000) // 5ms
                }
                continuation.finish()
            }
        }

        // Batch into groups of 3
        let batched = source.batched(count: 3)

        var batches: [[String]] = []
        for try await batch in batched {
            batches.append(batch)
        }

        // Should have 4 batches: [3, 3, 3, 1]
        XCTAssertEqual(batches.count, 4)
        XCTAssertEqual(batches[0].count, 3)
        XCTAssertEqual(batches[1].count, 3)
        XCTAssertEqual(batches[2].count, 3)
        XCTAssertEqual(batches[3].count, 1) // Remainder
    }

    func testBatchedByTime() async throws {
        let source = AsyncStream<String> { continuation in
            Task {
                // Send events over 150ms
                for i in 0..<6 {
                    continuation.yield("event-\(i)")
                    try? await Task.sleep(nanoseconds: 25_000_000) // 25ms each
                }
                continuation.finish()
            }
        }

        // Batch every 50ms
        let batched = source.batched(timeWindow: 0.05)

        var batches: [[String]] = []
        for try await batch in batched {
            batches.append(batch)
        }

        // Should have ~3 batches (50ms windows over 150ms)
        // Note: Timing can vary in CI, so we allow a wider range
        XCTAssertGreaterThanOrEqual(batches.count, 2)
        XCTAssertLessThanOrEqual(batches.count, 6)

        // Each batch should have events
        for batch in batches {
            XCTAssertGreaterThan(batch.count, 0)
        }
    }

    // MARK: - Throttling Tests

    func testThrottled() async throws {
        let source = AsyncStream<String> { continuation in
            Task {
                // Emit 20 events rapidly
                for i in 0..<20 {
                    continuation.yield("event-\(i)")
                    try? await Task.sleep(nanoseconds: 10_000_000) // 10ms
                }
                continuation.finish()
            }
        }

        // Throttle to max 1 per 50ms
        let throttled = source.throttled(interval: 0.05)

        var received: [String] = []
        let startTime = Date()

        for try await event in throttled {
            received.append(event)
        }

        let duration = Date().timeIntervalSince(startTime)

        // Should receive fewer events than produced
        XCTAssertLessThan(received.count, 20)

        // Should take at least (receivedCount * interval) seconds
        let expectedMinDuration = Double(received.count - 1) * 0.05
        XCTAssertGreaterThan(duration, expectedMinDuration * 0.8) // 80% tolerance
    }

    func testSampled() async throws {
        let source = AsyncStream<Int> { continuation in
            Task {
                // Emit 100 events
                for i in 0..<100 {
                    continuation.yield(i)
                    try? await Task.sleep(nanoseconds: 1_000_000) // 1ms
                }
                continuation.finish()
            }
        }

        // Sample every 10th event
        let sampled = source.sampled(every: 10)

        var received: [Int] = []
        for try await event in sampled {
            received.append(event)
        }

        // Should have ~10 events (every 10th)
        XCTAssertGreaterThanOrEqual(received.count, 8)
        XCTAssertLessThanOrEqual(received.count, 12)
    }

    // MARK: - Memory Safety Tests

    func testBufferedBoundedMemory() async throws {
        // Create large event stream
        let source = AsyncStream<Data> { continuation in
            Task {
                // 1000 events of 1KB each = 1MB total
                for _ in 0..<1000 {
                    continuation.yield(Data(repeating: 0, count: 1024))
                    try? await Task.sleep(nanoseconds: 100_000) // 0.1ms - fast
                }
                continuation.finish()
            }
        }

        // Buffer only 10 events max = 10KB max memory
        let buffered = source.buffered(limit: 10, strategy: .dropOldest)

        var processedCount = 0
        for try await _ in buffered {
            // Slow consumer
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms
            processedCount += 1
        }

        // Should have processed fewer than total due to buffer dropping
        XCTAssertLessThan(processedCount, 1000)
        // But should have processed something
        XCTAssertGreaterThan(processedCount, 0)
    }

    // MARK: - EventStream Integration Tests

    func testEventStreamBuffered() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"A"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"B"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"C"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)
        let buffered = stream.buffered(limit: 3, strategy: .dropOldest)

        var events: [any AGUIEvent] = []
        for try await event in buffered {
            events.append(event)
        }

        // Should receive events (may drop some if buffer fills)
        XCTAssertGreaterThan(events.count, 0)
    }

    func testEventStreamBatched() async throws {
        let sseData = String(repeating: "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"delta\":\"x\"}\n\n", count: 10)
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)
        let batched = stream.batched(count: 3)

        var batches: [[any AGUIEvent]] = []
        for try await batch in batched {
            batches.append(batch)
        }

        // Should have multiple batches
        XCTAssertGreaterThan(batches.count, 1)

        // Most batches should have 3 events
        let fullBatches = batches.filter { $0.count == 3 }
        XCTAssertGreaterThan(fullBatches.count, 0)
    }

    // MARK: - Composition Tests

    func testBufferedThenBatched() async throws {
        let events = Array(0..<20)
        let source = AsyncStream<Int> { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }

        // Compose: buffer then batch
        let composed = source
            .buffered(limit: 10, strategy: .dropOldest)
            .batched(count: 3)

        var batches: [[Int]] = []
        for try await batch in composed {
            batches.append(batch)
        }

        XCTAssertGreaterThan(batches.count, 0)
    }

    func testBatchedThenThrottled() async throws {
        let source = AsyncStream<String> { continuation in
            Task {
                for i in 0..<30 {
                    continuation.yield("event-\(i)")
                    try? await Task.sleep(nanoseconds: 5_000_000)
                }
                continuation.finish()
            }
        }

        // Batch into groups of 5, then throttle batches
        let composed = source
            .batched(count: 5)
            .throttled(interval: 0.05)

        var receivedBatches = 0
        for try await _ in composed {
            receivedBatches += 1
        }

        // Should have fewer than or equal to 6 batches (30 events / 5 per batch)
        // Throttling may or may not drop batches depending on CI timing
        XCTAssertLessThanOrEqual(receivedBatches, 6)
        XCTAssertGreaterThan(receivedBatches, 0)
    }

    // MARK: - Time-Window Correctness Tests

    func testTimeBatchedWindowFiresEvenWhenUpstreamIsIdle() async throws {
        // Upstream yields one element then pauses 500 ms before the second.
        // A 50 ms window must return the first batch after ~50 ms — NOT block for 500 ms.
        let source = AsyncThrowingStream<String, Error> { continuation in
            Task {
                continuation.yield("a")
                try await Task.sleep(for: .milliseconds(500))
                continuation.yield("b")
                continuation.finish()
            }
        }

        let start = ContinuousClock.now
        var batches: [[String]] = []
        for try await batch in source.batched(timeWindow: 0.05) {
            batches.append(batch)
            // After the first batch arrives, check elapsed wall time
            if batches.count == 1 {
                let elapsed = ContinuousClock.now - start
                // Must have returned within 200 ms (50 ms window + generous tolerance)
                XCTAssertLessThan(
                    elapsed,
                    .milliseconds(200),
                    "First batch must not block for the full 500 ms upstream pause"
                )
            }
        }

        XCTAssertGreaterThanOrEqual(batches.count, 2)
        XCTAssertEqual(batches.flatMap { $0 }, ["a", "b"])
    }

    func testTimeBatchedGroupsFastElementsIntoBatch() async throws {
        // Upstream yields 6 elements at 10 ms intervals — well within a 50 ms window.
        // At least some elements should land in the same batch.
        let source = AsyncStream<Int> { continuation in
            Task {
                for i in 0 ..< 6 {
                    continuation.yield(i)
                    try? await Task.sleep(for: .milliseconds(10))
                }
                continuation.finish()
            }
        }

        var batches: [[Int]] = []
        for try await batch in source.batched(timeWindow: 0.05) {
            batches.append(batch)
        }

        // At 10 ms per element and a 50 ms window, at least 2 elements should batch together
        let hasMultiElementBatch = batches.contains { $0.count > 1 }
        XCTAssertTrue(hasMultiElementBatch, "Fast elements must be grouped within the window")
        XCTAssertEqual(batches.flatMap { $0 }, [0, 1, 2, 3, 4, 5])
    }

    // MARK: - Streaming correctness (verifies elements arrive during iteration, not after)

    func test_buffered_yieldsElementsDuringIteration() async throws {
        // The core bug was: buffered() accumulated all elements and only yielded
        // after upstream finished. For an SSE stream that never closes, this means
        // no events ever arrive. This test verifies elements flow through immediately.
        let firstArrived = expectation(description: "first element arrives before upstream finishes")
        firstArrived.assertForOverFulfill = false

        let source = AsyncThrowingStream<Int, Error> { continuation in
            Task {
                continuation.yield(1)
                // Pause before yielding second element — consumer must receive 1 before this
                try await Task.sleep(for: .milliseconds(200))
                continuation.yield(2)
                continuation.yield(3)
                continuation.finish()
            }
        }

        let buffered = source.buffered(limit: 10, strategy: .dropOldest)
        var received: [Int] = []

        for try await element in buffered {
            received.append(element)
            if element == 1 {
                firstArrived.fulfill()
            }
        }

        await fulfillment(of: [firstArrived], timeout: 1.0)
        XCTAssertEqual(received, [1, 2, 3])
    }

    func test_buffered_propagatesUpstreamError() async throws {
        // Elements received before the error must not be discarded.
        struct UpstreamFailure: Error {}

        let source = AsyncThrowingStream<Int, Error> { continuation in
            Task {
                continuation.yield(1)
                continuation.yield(2)
                continuation.finish(throwing: UpstreamFailure())
            }
        }

        let buffered = source.buffered(limit: 10, strategy: .dropOldest)
        var received: [Int] = []
        var caughtError: Error?

        do {
            for try await element in buffered {
                received.append(element)
            }
        } catch {
            caughtError = error
        }

        XCTAssertEqual(received, [1, 2], "Elements before error must be delivered")
        XCTAssertTrue(caughtError is UpstreamFailure)
    }

    func test_buffered_cancellation_stopsProduction() async throws {
        // When the consumer breaks, the inner Task must be cancelled.
        // We verify by counting how many elements the upstream actually produced.
        let produced = ActorCounter()

        let source = AsyncThrowingStream<Int, Error> { continuation in
            Task {
                for i in 1...1000 {
                    await produced.increment()
                    continuation.yield(i)
                    try await Task.sleep(for: .milliseconds(5))
                }
                continuation.finish()
            }
        }

        let buffered = source.buffered(limit: 5, strategy: .dropOldest)
        for try await _ in buffered {
            break  // cancel immediately after first element
        }

        // Give inner Task a moment to honour cancellation.
        try await Task.sleep(for: .milliseconds(50))
        let count = await produced.value
        // The inner Task must have been cancelled; far fewer than 1000 elements produced.
        XCTAssertLessThan(count, 50, "Cancellation must stop the inner Task promptly")
    }

    // MARK: - Cancellation Tests

    func testBufferedCancellation() async throws {
        let source = AsyncStream<Int> { continuation in
            Task {
                for i in 0..<1000 {
                    continuation.yield(i)
                    try? await Task.sleep(nanoseconds: 1_000_000)
                }
                continuation.finish()
            }
        }

        let buffered = source.buffered(limit: 10, strategy: .dropOldest)

        let task = Task {
            var count = 0
            for try await _ in buffered {
                count += 1
                if count >= 5 {
                    break
                }
            }
            return count
        }

        let count = try await task.value
        XCTAssertEqual(count, 5)
    }
}

// MARK: - Helpers

/// Thread-safe counter for verifying production counts across task boundaries.
actor ActorCounter {
    private(set) var value = 0
    func increment() { value += 1 }
}
