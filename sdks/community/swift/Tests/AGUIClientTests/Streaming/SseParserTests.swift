// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient

/// Comprehensive tests for Server-Sent Events (SSE) parser.
///
/// Tests follow the SSE specification from WHATWG:
/// https://html.spec.whatwg.org/multipage/server-sent-events.html
///
/// Key scenarios:
/// - Single complete events
/// - Multiple events in one chunk
/// - Partial events across chunks
/// - Multi-line data fields
/// - Event IDs and types
/// - Empty events (heartbeat)
/// - UTF-8 edge cases
final class SseParserTests: XCTestCase {
    // MARK: - Basic Parsing Tests

    func testParseSingleEvent() throws {
        var parser = SseParser()
        let events = try parser.parse("data: {\"test\":\"value\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
        XCTAssertNil(events[0].id)
        XCTAssertEqual(events[0].event, "message")
    }

    func testParseMultipleEvents() throws {
        var parser = SseParser()
        let input = """
        data: event1

        data: event2

        data: event3


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0].data, "event1")
        XCTAssertEqual(events[1].data, "event2")
        XCTAssertEqual(events[2].data, "event3")
    }

    func testParseEmptyDataField() throws {
        var parser = SseParser()
        let events = try parser.parse("data:\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "")
    }

    // MARK: - Multi-line Data Tests

    func testParseMultiLineData() throws {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2
        data: line3


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "line1\nline2\nline3")
    }

    func testParseMultiLineDataWithEmptyLines() throws {
        var parser = SseParser()
        let input = """
        data: first
        data:
        data: third


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first\n\nthird")
    }

    // MARK: - Event ID Tests

    func testParseEventWithId() throws {
        var parser = SseParser()
        let events = try parser.parse("id: 123\ndata: test\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "123")
    }

    func testParseEventWithIdAfterData() throws {
        var parser = SseParser()
        let events = try parser.parse("data: test\nid: 456\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "456")
    }

    // MARK: - Event Type Tests

    func testParseEventWithCustomType() throws {
        var parser = SseParser()
        let events = try parser.parse("event: custom\ndata: payload\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
        XCTAssertEqual(events[0].event, "custom")
    }

    func testParseEventWithAllFields() throws {
        var parser = SseParser()
        let input = """
        event: notification
        id: 789
        data: {"message":"hello"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "notification")
        XCTAssertEqual(events[0].id, "789")
        XCTAssertEqual(events[0].data, "{\"message\":\"hello\"}")
    }

    // MARK: - Partial Chunk Tests

    func testParsePartialEventReturnsNoEvents() throws {
        var parser = SseParser()
        let events = try parser.parse("data: incomplete")

        // No complete event yet (missing double newline)
        XCTAssertEqual(events.count, 0)
    }

    func testParsePartialEventCompletedInNextChunk() throws {
        var parser = SseParser()

        // First chunk: incomplete event
        var events = try parser.parse("data: {\"te")
        XCTAssertEqual(events.count, 0)

        // Second chunk: complete the event
        events = try parser.parse("st\":\"value\"}\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
    }

    func testParseMultiplePartialChunks() throws {
        var parser = SseParser()

        var events = try parser.parse("da")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("ta: first")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("\n\ndata: ")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first")

        events = try parser.parse("second\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "second")
    }

    func testParseEventSplitAcrossDoubleNewline() throws {
        var parser = SseParser()

        var events = try parser.parse("data: test\n")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
    }

    // MARK: - Comment Tests

    func testParseIgnoresComments() throws {
        var parser = SseParser()
        let input = """
        : this is a comment
        data: payload


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseIgnoresCommentsBeforeAndAfterData() throws {
        var parser = SseParser()
        let input = """
        : comment 1
        data: value
        : comment 2


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    // MARK: - Empty Event Tests

    func testParseEmptyEventAsHeartbeat() throws {
        var parser = SseParser()
        // Double newline with no data is typically a heartbeat
        let events = try parser.parse("\n\n")

        // Empty events are ignored (no data field)
        XCTAssertEqual(events.count, 0)
    }

    func testParseMultipleHeartbeats() throws {
        var parser = SseParser()
        let input = """




        data: real_event


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "real_event")
    }

    // MARK: - Whitespace Handling Tests

    func testParseTrimsWhitespaceAfterColon() throws {
        var parser = SseParser()
        // SSE spec: Remove only ONE leading space after colon
        let events = try parser.parse("data:   value with spaces   \n\n")

        XCTAssertEqual(events.count, 1)
        // After removing colon and ONE space, "  value with spaces   " remains
        XCTAssertEqual(events[0].data, "  value with spaces   ")
    }

    func testParseHandlesNoSpaceAfterColon() throws {
        var parser = SseParser()
        let events = try parser.parse("data:value\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    func testParsePreservesTrailingWhitespaceInData() throws {
        var parser = SseParser()
        let events = try parser.parse("data: trailing   \n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "trailing   ")
    }

    // MARK: - Special Character Tests

    func testParseDataWithNewlines() throws {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("\n"))
    }

    func testParseDataWithColons() throws {
        var parser = SseParser()
        let events = try parser.parse("data: {\"url\":\"https://example.com\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"url\":\"https://example.com\"}")
    }

    func testParseDataWithEmoji() throws {
        var parser = SseParser()
        let events = try parser.parse("data: Hello 👋 World 🌍\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "Hello 👋 World 🌍")
    }

    // MARK: - Edge Cases

    func testParseLongDataLine() throws {
        var parser = SseParser()
        let longData = String(repeating: "a", count: 10000)
        let events = try parser.parse("data: \(longData)\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, longData)
    }

    func testParseManySmallChunks() throws {
        var parser = SseParser()
        let input = "data: test\n\n"

        // Parse one character at a time
        var allEvents: [SseEvent] = []
        for char in input {
            let events = try parser.parse(String(char))
            allEvents.append(contentsOf: events)
        }

        XCTAssertEqual(allEvents.count, 1)
        XCTAssertEqual(allEvents[0].data, "test")
    }

    func testParseUnknownFieldsAreIgnored() throws {
        var parser = SseParser()
        let input = """
        data: payload
        unknown: field
        retry: 5000


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseFieldWithoutColon() throws {
        var parser = SseParser()
        let input = """
        data: valid
        invalidfield


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "valid")
    }

    // MARK: - Reset Tests

    func testResetClearsBuffer() throws {
        var parser = SseParser()

        // Add partial event
        _ = try parser.parse("data: incomplete")

        // Reset
        parser.reset()

        // New event should not include old buffer
        let events = try parser.parse("data: new\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "new")
    }

    // MARK: - Real-world AG-UI Event Tests

    func testParseAGUIRunStartedEvent() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
    }

    func testParseAGUITextMessageChunk() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":"Hello"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("TEXT_MESSAGE_CHUNK"))
    }

    func testParseMultipleAGUIEvents() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"Hi"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 5)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
        XCTAssertTrue(events[1].data.contains("TEXT_MESSAGE_START"))
        XCTAssertTrue(events[2].data.contains("TEXT_MESSAGE_CHUNK"))
        XCTAssertTrue(events[3].data.contains("TEXT_MESSAGE_END"))
        XCTAssertTrue(events[4].data.contains("RUN_FINISHED"))
    }

    // MARK: - retry field

    func test_sseParser_retryField_parsedAsMilliseconds() throws {
        // WHATWG SSE spec §9.2.6: the retry field sets the reconnection time in ms.
        var parser = SseParser()
        let events = try parser.parse("retry: 5000\ndata: ping\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].retry, 5000)
    }

    func test_sseParser_retryField_nonInteger_isIgnored() throws {
        // Per spec: if the value is not an ASCII integer, ignore the field entirely.
        var parser = SseParser()
        let events = try parser.parse("retry: abc\ndata: ping\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertNil(events[0].retry)
    }

    // MARK: - Thread Safety Tests

    func testParserInstancesHaveIndependentBufferState() throws {
        // SseParser is a value type (struct). Each instance maintains its own buffer.
        // Feeding a partial chunk into one instance must not affect the other.
        var parserA = SseParser()
        var parserB = SseParser()

        // Feed parserA a partial event (no double-newline yet)
        let eventsA1 = try parserA.parse("data: from-a")
        XCTAssertEqual(eventsA1.count, 0, "Partial input should not produce events")

        // parserB starts clean — a complete event completes immediately
        let eventsB = try parserB.parse("data: from-b\n\n")
        XCTAssertEqual(eventsB.count, 1)
        XCTAssertEqual(eventsB[0].data, "from-b")

        // Completing parserA's partial event returns only A's buffered data
        let eventsA2 = try parserA.parse("\n\n")
        XCTAssertEqual(eventsA2.count, 1)
        XCTAssertEqual(eventsA2[0].data, "from-a",
                       "parserA must not contain data from parserB")
    }

    // MARK: - Performance Tests

    func testParseLargeStreamEfficiently() throws {
        var parser = SseParser()

        // Simulate large stream
        let iterations = 1000
        var totalEvents = 0

        for i in 0..<iterations {
            let events = try parser.parse("data: event\(i)\n\n")
            totalEvents += events.count
        }

        XCTAssertEqual(totalEvents, iterations)
    }
}
