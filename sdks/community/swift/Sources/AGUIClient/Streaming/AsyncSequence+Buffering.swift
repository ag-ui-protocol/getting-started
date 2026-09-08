// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - Buffering Extension

extension AsyncSequence where Self: Sendable, Element: Sendable {
    /// Applies bounded buffering with overflow handling.
    ///
    /// Creates a bounded buffer between producer and consumer. When the buffer
    /// fills, the specified strategy determines which elements to keep.
    ///
    /// - Parameters:
    ///   - limit: Maximum number of elements in buffer
    ///   - strategy: Strategy for handling overflow
    /// - Returns: Buffered async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let buffered = eventStream.buffered(limit: 100, strategy: .dropOldest)
    ///
    /// for try await event in buffered {
    ///     // Buffer ensures max 100 events in memory
    ///     await slowProcessing(event)
    /// }
    /// ```
    ///
    /// ## Memory Safety
    ///
    /// The buffer guarantees bounded memory usage: `limit * sizeof(Element)`.
    ///
    /// ## Performance
    ///
    /// - `.dropOldest`: O(1) append, O(n) drop (shifts elements)
    /// - `.dropNewest`: O(1) append and drop
    /// - `.suspend`: Natural backpressure (no buffer overhead)
    public func buffered(
        limit: Int,
        strategy: BufferingStrategy
    ) -> AsyncThrowingStream<Element, Error> {
        // Map our strategy to AsyncThrowingStream's built-in buffer policy.
        // bufferingNewest keeps the newest `limit` elements (drops oldest on overflow).
        // bufferingOldest keeps the oldest `limit` elements (drops newest on overflow).
        let policy: AsyncThrowingStream<Element, Error>.Continuation.BufferingPolicy
        switch strategy {
        case .dropOldest: policy = .bufferingNewest(limit)
        case .dropNewest: policy = .bufferingOldest(limit)
        }

        return AsyncThrowingStream(bufferingPolicy: policy) { continuation in
            let task = Task {
                do {
                    for try await element in self {
                        continuation.yield(element) // yield immediately — no accumulation
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

// MARK: - Batching Extension

extension AsyncSequence where Self: Sendable {
    /// Batches elements by count.
    ///
    /// Groups elements into arrays of the specified size. The last batch
    /// may contain fewer than `count` elements if the sequence ends.
    ///
    /// - Parameter count: Number of elements per batch
    /// - Returns: Batched async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let batched = eventStream.batched(count: 10)
    ///
    /// for try await batch in batched {
    ///     // Process 10 events at once
    ///     await processBatch(batch) // batch.count <= 10
    /// }
    /// ```
    public func batched(count: Int) -> BatchedAsyncSequence<Self> {
        BatchedAsyncSequence(base: self, batchSize: count)
    }
}

extension AsyncSequence where Self: Sendable, Self.Element: Sendable {
    /// Batches elements by time window.
    ///
    /// Groups elements arriving within a time window. Emits batches
    /// when the window expires or the sequence ends.
    ///
    /// - Parameter timeWindow: Duration in seconds
    /// - Returns: Time-batched async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let batched = textChunks.batched(timeWindow: 0.05) // 50ms
    ///
    /// for try await batch in batched {
    ///     // Batch of all chunks received in 50ms window
    ///     let combined = batch.joined()
    ///     await updateUI(combined)
    /// }
    /// ```
    public func batched(timeWindow: TimeInterval) -> TimeBatchedAsyncSequence<Self> {
        TimeBatchedAsyncSequence(base: self, timeWindow: timeWindow)
    }
}

/// Async sequence that batches elements by count.
public struct BatchedAsyncSequence<Base: AsyncSequence>: AsyncSequence where Base: Sendable {
    public typealias Element = [Base.Element]

    private let base: Base
    private let batchSize: Int

    init(base: Base, batchSize: Int) {
        self.base = base
        self.batchSize = batchSize
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), batchSize: batchSize)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var baseIterator: Base.AsyncIterator
        private let batchSize: Int

        init(base: Base.AsyncIterator, batchSize: Int) {
            self.baseIterator = base
            self.batchSize = batchSize
        }

        public mutating func next() async throws -> [Base.Element]? {
            var batch: [Base.Element] = []
            batch.reserveCapacity(batchSize)

            while batch.count < batchSize {
                guard let element = try await baseIterator.next() else {
                    // End of sequence - return partial batch if any
                    return batch.isEmpty ? nil : batch
                }
                batch.append(element)
            }

            return batch
        }
    }
}

// MARK: - TimeBatchProducer

/// Actor that buffers elements from a concurrent producer task so that a
/// time-windowed consumer can safely collect them without races.
///
/// The producer task feeds elements into this actor as fast as the upstream
/// allows. The consumer calls `dequeue()` at each window boundary to drain
/// whatever arrived during that window. Because actor isolation serialises
/// all reads and writes to the buffer, no element is ever lost at window
/// edges — an element added after one `dequeue()` call simply appears in the
/// next window's batch.
fileprivate actor TimeBatchProducer<Element: Sendable> {
    private var buffer: [Element] = []
    private(set) var isExhausted = false
    private var storedError: Error?

    func enqueue(_ element: Element) {
        buffer.append(element)
    }

    func markExhausted() {
        isExhausted = true
    }

    func markFailed(_ error: Error) {
        storedError = error
        isExhausted = true
    }

    /// Drains the buffer and returns it with the exhaustion flag.
    /// Throws if the upstream ended with an error.
    func dequeue() throws -> ([Element], Bool) {
        if let e = storedError { throw e }
        let batch = buffer
        buffer = []
        return (batch, isExhausted)
    }
}

/// Cancels its wrapped `Task` on deinit, ensuring the background producer is
/// torn down if the `TimeBatchedAsyncSequence.AsyncIterator` is dropped before
/// the upstream sequence is exhausted (e.g. `break` out of a `for await` loop).
fileprivate final class ProducerTaskHandle: Sendable {
    let task: Task<Void, Never>
    init(_ task: Task<Void, Never>) { self.task = task }
    deinit { task.cancel() }
}

/// Async sequence that batches elements by time window.
///
/// A dedicated producer task pulls from the upstream sequence as fast as it
/// can, feeding every element into a `TimeBatchProducer` actor. The consumer
/// (`next()`) sleeps for `timeWindow` seconds, then drains whatever arrived
/// during that window and returns it as an array.
///
/// Because actor isolation serialises the producer's `enqueue` and the
/// consumer's `dequeue`, no element can be lost at a window boundary: an
/// element that arrives after one drain is simply included in the next.
///
/// Empty windows (upstream alive but idle) are silently skipped — the
/// consumer starts a new window automatically and only yields once it has
/// collected at least one element.
///
/// ## Example
///
/// ```swift
/// let batched = textChunks.batched(timeWindow: 0.05) // 50 ms windows
/// for try await batch in batched {
///     await render(batch.joined())
/// }
/// ```
///
/// - Note: Requires `Base.Element: Sendable` because elements must cross
///   the actor boundary between the producer task and the consumer.
public struct TimeBatchedAsyncSequence<Base: AsyncSequence>: AsyncSequence
    where Base: Sendable, Base.Element: Sendable
{
    public typealias Element = [Base.Element]

    private let base: Base
    private let timeWindow: TimeInterval

    init(base: Base, timeWindow: TimeInterval) {
        self.base = base
        self.timeWindow = timeWindow
    }

    public func makeAsyncIterator() -> AsyncIterator {
        let producer = TimeBatchProducer<Base.Element>()
        let rawTask = Task { [base, producer] in
            do {
                for try await element in base {
                    await producer.enqueue(element)
                }
                await producer.markExhausted()
            } catch {
                await producer.markFailed(error)
            }
        }
        return AsyncIterator(
            producer: producer,
            handle: ProducerTaskHandle(rawTask),
            timeWindow: timeWindow
        )
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private let producer: TimeBatchProducer<Base.Element>
        /// Class reference so `deinit` cancels the producer when the iterator
        /// is dropped (e.g. after a `break` in the consumer's `for await`).
        private let handle: ProducerTaskHandle
        private let timeWindow: TimeInterval
        private var isLocallyExhausted = false

        fileprivate init(
            producer: TimeBatchProducer<Base.Element>,
            handle: ProducerTaskHandle,
            timeWindow: TimeInterval
        ) {
            self.producer = producer
            self.handle = handle
            self.timeWindow = timeWindow
        }

        public mutating func next() async throws -> [Base.Element]? {
            guard !isLocallyExhausted else { return nil }

            while true {
                // Sleep for the full window duration before collecting.
                try await Task.sleep(for: .seconds(timeWindow))

                let (batch, exhausted) = try await producer.dequeue()

                if exhausted {
                    isLocallyExhausted = true
                    handle.task.cancel()
                    return batch.isEmpty ? nil : batch
                }

                if !batch.isEmpty {
                    return batch
                }
                // Empty window — upstream is alive but idle. Start next window.
            }
        }
    }
}

// MARK: - Throttling Extension

extension AsyncSequence where Self: Sendable, Element: Sendable {
    /// Throttles element emission to a maximum rate.
    ///
    /// Emits the first element immediately, then drops subsequent elements
    /// until the time window expires. This ensures a maximum emission rate.
    ///
    /// - Parameter interval: Minimum time between emitted elements (seconds)
    /// - Returns: Throttled async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let throttled = rapidEvents.throttled(interval: 0.1) // Max 10/sec
    ///
    /// for try await event in throttled {
    ///     // At most 1 event per 100ms
    ///     await processEvent(event)
    /// }
    /// ```
    public func throttled(interval: TimeInterval) -> AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var lastEmitTime: Date?

                    for try await element in self {
                        let now = Date()

                        // Check if enough time has passed since last emit
                        if let lastTime = lastEmitTime {
                            let elapsed = now.timeIntervalSince(lastTime)
                            if elapsed < interval {
                                // Drop this element - too soon
                                continue
                            }
                        }

                        // Emit element and update timestamp
                        continuation.yield(element)
                        lastEmitTime = now
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Samples every Nth element.
    ///
    /// Emits only every Nth element, discarding others.
    ///
    /// - Parameter stride: Sample interval (emit every Nth element)
    /// - Returns: Sampled async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let sampled = videoFrames.sampled(every: 30) // 1 per second at 30fps
    ///
    /// for try await frame in sampled {
    ///     await processFrame(frame)
    /// }
    /// ```
    public func sampled(every stride: Int) -> SampledAsyncSequence<Self> {
        SampledAsyncSequence(base: self, stride: stride)
    }
}

/// Async sequence that samples every Nth element.
public struct SampledAsyncSequence<Base: AsyncSequence>: AsyncSequence where Base: Sendable {
    public typealias Element = Base.Element

    private let base: Base
    private let stride: Int

    init(base: Base, stride: Int) {
        self.base = base
        self.stride = stride
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), stride: stride)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var baseIterator: Base.AsyncIterator
        private let stride: Int
        private var count = 0

        init(base: Base.AsyncIterator, stride: Int) {
            self.baseIterator = base
            self.stride = stride
        }

        public mutating func next() async throws -> Element? {
            while let element = try await baseIterator.next() {
                count += 1

                if count % stride == 0 {
                    return element
                }
            }

            return nil
        }
    }
}
