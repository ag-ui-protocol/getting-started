// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningMessageChunkEventTests: XCTestCase,
                                              AGUIEventDecoderTestHelpers,
                                              EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    // Both messageId and delta are optional; provide them as representative valid fields.
    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId, "delta": "chunk"]
    }

    var eventTypeString: String { "REASONING_MESSAGE_CHUNK" }
    var expectedEventType: EventType { .reasoningMessageChunk }
    var unknownEventTypeString: String { "REASONING_MESSAGE_PARTIAL" }

    // MARK: - Decode

    func test_decodeWithBothFields_returnsCorrectEvent() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "chunk"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertEqual(event.eventType, .reasoningMessageChunk)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertEqual(event.delta, "chunk")
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithOnlyMessageId_omitsDelta() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CHUNK","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertNil(event.delta)
    }

    func test_decodeWithOnlyDelta_omitsMessageId() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CHUNK","delta":"partial"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertNil(event.messageId)
        XCTAssertEqual(event.delta, "partial")
    }

    func test_decodeWithNoOptionalFields_succeeds() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CHUNK"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertNil(event.messageId)
        XCTAssertNil(event.delta)
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "chunk",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CHUNK","messageId":"\(EventTestData.messageId)","delta":"chunk"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageChunkEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningMessageChunk() {
        let event = ReasoningMessageChunkEvent()
        XCTAssertEqual(event.eventType, .reasoningMessageChunk)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningMessageChunkEvent(messageId: EventTestData.messageId, delta: "chunk")
        let e2 = ReasoningMessageChunkEvent(messageId: EventTestData.messageId, delta: "chunk")
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentDelta_notEqual() {
        let e1 = ReasoningMessageChunkEvent(messageId: EventTestData.messageId, delta: "a")
        let e2 = ReasoningMessageChunkEvent(messageId: EventTestData.messageId, delta: "b")
        XCTAssertNotEqual(e1, e2)
    }

    func test_equatable_nilVsNonNilMessageId_notEqual() {
        let e1 = ReasoningMessageChunkEvent(messageId: nil, delta: "chunk")
        let e2 = ReasoningMessageChunkEvent(messageId: EventTestData.messageId, delta: "chunk")
        XCTAssertNotEqual(e1, e2)
    }
}
