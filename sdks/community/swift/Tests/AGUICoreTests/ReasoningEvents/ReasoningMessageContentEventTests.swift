// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningMessageContentEventTests: XCTestCase,
                                                AGUIEventDecoderTestHelpers,
                                                EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId, "delta": "Let me think..."]
    }

    var eventTypeString: String { "REASONING_MESSAGE_CONTENT" }
    var expectedEventType: EventType { .reasoningMessageContent }
    var unknownEventTypeString: String { "REASONING_MESSAGE_PARTIAL" }

    // MARK: - Decode

    func test_decodeValidReasoningMessageContent_returnsCorrectEvent() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Let me think..."
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageContentEvent)
        XCTAssertEqual(event.eventType, .reasoningMessageContent)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertEqual(event.delta, "Let me think...")
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_CONTENT",
          "messageId": "\(EventTestData.messageId)",
          "delta": "chunk",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageContentEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CONTENT","messageId":"\(EventTestData.messageId)","delta":"chunk"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageContentEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingMessageId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CONTENT","delta":"chunk"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func test_missingDelta_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_CONTENT","messageId":"\(EventTestData.messageId)"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningMessageContent() {
        let event = ReasoningMessageContentEvent(messageId: EventTestData.messageId, delta: "chunk")
        XCTAssertEqual(event.eventType, .reasoningMessageContent)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningMessageContentEvent(messageId: EventTestData.messageId, delta: "chunk")
        let e2 = ReasoningMessageContentEvent(messageId: EventTestData.messageId, delta: "chunk")
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentDelta_notEqual() {
        let e1 = ReasoningMessageContentEvent(messageId: EventTestData.messageId, delta: "a")
        let e2 = ReasoningMessageContentEvent(messageId: EventTestData.messageId, delta: "b")
        XCTAssertNotEqual(e1, e2)
    }
}
