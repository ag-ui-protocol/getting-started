// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

/// Comprehensive tests for EventStream AsyncSequence.
///
/// Tests the integration of:
/// - HTTP streaming (AsyncBytes)
/// - SSE parsing
/// - AG-UI event decoding
/// - Error handling
/// - Stream lifecycle
final class EventStreamTests: XCTestCase {
    // MARK: - Basic Streaming Tests

    func testStreamSingleEvent() async throws {
        let sseData = "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n"
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0] is RunStartedEvent)
        let runStarted = events[0] as! RunStartedEvent
        XCTAssertEqual(runStarted.threadId, "t1")
        XCTAssertEqual(runStarted.runId, "r1")
    }

    func testStreamMultipleEvents() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"Hello"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 5)
        guard events.count >= 5 else {
            XCTFail("Expected 5 events but got \(events.count)")
            return
        }
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is TextMessageStartEvent)
        XCTAssertTrue(events[2] is TextMessageChunkEvent)
        XCTAssertTrue(events[3] is TextMessageEndEvent)
        XCTAssertTrue(events[4] is RunFinishedEvent)
    }

    func testStreamEmptyStream() async throws {
        let bytes = MockAsyncBytes(data: Data())
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 0)
    }

    // MARK: - Partial Chunk Tests

    func testStreamHandlesPartialChunks() async throws {
        // Simulate bytes arriving in small chunks
        let part1 = "data: {\"type\":\"TEXT_"
        let part2 = "MESSAGE_CHUNK\",\"messageId\""
        let part3 = ":\"msg1\",\"delta\":\"Hi\"}\n\n"

        let combinedData = Data((part1 + part2 + part3).utf8)
        let bytes = MockAsyncBytes(data: combinedData, chunkSize: 10)
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0] is TextMessageChunkEvent)
    }

    func testStreamHandlesUTF8AcrossBoundaries() async throws {
        // Emoji split across chunk boundaries
        let emoji = "👋"
        let sseData = "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"delta\":\"\(emoji)\"}\n\n"
        let bytes = MockAsyncBytes(data: Data(sseData.utf8), chunkSize: 5)
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        let chunk = events[0] as! TextMessageChunkEvent
        XCTAssertEqual(chunk.delta, emoji)
    }

    // MARK: - Error Handling Tests

    func testStreamHandlesMalformedJSON() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {invalid json}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        // Should skip malformed event and continue
        XCTAssertEqual(events.count, 2)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is RunFinishedEvent)
    }

    func testStreamHandlesUnknownEventType() async throws {
        // In strict mode (default), an unrecognised event type causes the decoder to
        // throw EventDecodingError.unknownEventType. The TypeScript reference implementation
        // calls eventSubject.error(err) for all decode failures — the stream terminates.
        // EventStream must propagate, not swallow, the error.
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"UNKNOWN_EVENT_TYPE","data":"something"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder() // strict mode by default

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var eventsBeforeThrow: [any AGUIEvent] = []
        do {
            for try await event in stream {
                eventsBeforeThrow.append(event)
            }
            XCTFail("Expected stream to throw EventDecodingError.unknownEventType")
        } catch let error as EventDecodingError {
            guard case .unknownEventType(let typeString) = error else {
                XCTFail("Expected .unknownEventType, got \(error)")
                return
            }
            XCTAssertEqual(typeString, "UNKNOWN_EVENT_TYPE")
            // The first event was yielded before the error occurred.
            XCTAssertEqual(eventsBeforeThrow.count, 1)
            XCTAssertTrue(eventsBeforeThrow[0] is RunStartedEvent)
        }
    }

    func test_tolerantDecoder_returnsUnknownEventForUnrecognisedType() async throws {
        // With .returnUnknown strategy, unknown event types are wrapped in UnknownEvent
        // and forwarded instead of being silently dropped.
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"UNKNOWN_EVENT_TYPE","data":"something"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        var config = AGUIEventDecoder.Configuration()
        config.unknownEventStrategy = .returnUnknown
        let decoder = AGUIEventDecoder(config: config)

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        // Tolerant decoder yields all 3 events; the middle one is UnknownEvent.
        XCTAssertEqual(events.count, 3)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is UnknownEvent)
        let unknown = events[1] as! UnknownEvent
        XCTAssertEqual(unknown.typeRaw, "UNKNOWN_EVENT_TYPE")
        XCTAssertTrue(events[2] is RunFinishedEvent)
    }

    // MARK: - Lifecycle Tests

    func testStreamCanBeIteratedMultipleTimes() async throws {
        let sseData = "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n"
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        // First iteration
        var count1 = 0
        for try await _ in stream {
            count1 += 1
        }

        // Second iteration should start fresh
        var count2 = 0
        for try await _ in stream {
            count2 += 1
        }

        XCTAssertEqual(count1, 1)
        XCTAssertEqual(count2, 1)
    }

    func testStreamEndsWhenBytesEnd() async throws {
        let sseData = "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n"
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        // Should have received exactly one event and then ended
        XCTAssertEqual(eventCount, 1)
    }

    // MARK: - Cancellation Tests

    func testStreamCanBeCancelled() async throws {
        let sseData = String(repeating: "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"delta\":\"x\"}\n\n", count: 100)
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        let task = Task {
            var count = 0
            for try await _ in stream {
                count += 1
                if count >= 5 {
                    break // Stop early
                }
            }
            return count
        }

        let count = try await task.value
        XCTAssertEqual(count, 5)
    }

    // MARK: - Multi-line Data Tests

    func testStreamHandlesMultiLineSSEData() async throws {
        let sseData = """
        data: {"type":"TEXT_MESSAGE_CHUNK",
        data: "messageId":"msg1",
        data: "delta":"Hello"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0] is TextMessageChunkEvent)
    }

    // MARK: - Performance Tests

    func testStreamHandlesLargeNumberOfEvents() async throws {
        var sseData = ""
        for i in 0..<1000 {
            sseData += "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"delta\":\"\(i)\"}\n\n"
        }

        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var eventCount = 0
        for try await _ in stream {
            eventCount += 1
        }

        XCTAssertEqual(eventCount, 1000)
    }

    // MARK: - Real-world AG-UI Scenarios

    func testStreamHandlesTypicalAgentConversation() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":"The"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":" weather"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":" is"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg-1"}

        data: {"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        var textChunks: [String] = []

        for try await event in stream {
            events.append(event)
            if let chunk = event as? TextMessageChunkEvent, let delta = chunk.delta {
                textChunks.append(delta)
            }
        }

        XCTAssertEqual(events.count, 7)
        XCTAssertEqual(textChunks.joined(), "The weather is")
    }

    func testStreamHandlesToolCallScenario() async throws {
        // Wire format uses "toolCallName" (not "toolName") per ToolCallStartEvent.CodingKeys.
        // All 5 events must decode successfully and be yielded in order.
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"weather"}

        data: {"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\\"location\\\":\\\"NYC\\\"}"}

        data: {"type":"TOOL_CALL_END","toolCallId":"tc1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 5)
        XCTAssertTrue(events[0] is RunStartedEvent)
        XCTAssertTrue(events[1] is ToolCallStartEvent)
        let toolStart = events[1] as! ToolCallStartEvent
        XCTAssertEqual(toolStart.toolCallId, "tc1")
        XCTAssertEqual(toolStart.toolCallName, "weather")
        XCTAssertTrue(events[2] is ToolCallArgsEvent)
        XCTAssertTrue(events[3] is ToolCallEndEvent)
        XCTAssertTrue(events[4] is RunFinishedEvent)
    }

    // MARK: - Edge Cases

    func testStreamHandlesHeartbeats() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        :heartbeat

        :heartbeat

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        // Heartbeats shouldn't produce events
        XCTAssertEqual(events.count, 2)
    }

    func testStreamHandlesEmptyDataFields() async throws {
        let sseData = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data:

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let bytes = MockAsyncBytes(data: Data(sseData.utf8))
        let decoder = AGUIEventDecoder()

        let stream = EventStream(bytes: bytes, decoder: decoder)

        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }

        // Empty data fields should be skipped
        XCTAssertEqual(events.count, 2)
    }
}
