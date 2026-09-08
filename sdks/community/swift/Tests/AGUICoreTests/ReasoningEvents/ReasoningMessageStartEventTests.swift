// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningMessageStartEventTests: XCTestCase,
                                              AGUIEventDecoderTestHelpers,
                                              EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId, "role": "reasoning"]
    }

    var eventTypeString: String { "REASONING_MESSAGE_START" }
    var expectedEventType: EventType { .reasoningMessageStart }
    var unknownEventTypeString: String { "REASONING_MESSAGE_PAUSED" }

    // MARK: - Decode

    func test_decodeValidReasoningMessageStart_returnsCorrectEvent() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "reasoning"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageStartEvent)
        XCTAssertEqual(event.eventType, .reasoningMessageStart)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertEqual(event.role, "reasoning")
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {
          "type": "REASONING_MESSAGE_START",
          "messageId": "\(EventTestData.messageId)",
          "role": "reasoning",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageStartEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_START","messageId":"\(EventTestData.messageId)","role":"reasoning"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageStartEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingMessageId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_START","role":"reasoning"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func test_missingRole_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_START","messageId":"\(EventTestData.messageId)"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningMessageStart() {
        let event = ReasoningMessageStartEvent(messageId: EventTestData.messageId, role: "reasoning")
        XCTAssertEqual(event.eventType, .reasoningMessageStart)
    }

    func test_defaultRole_isReasoning() {
        let event = ReasoningMessageStartEvent(messageId: EventTestData.messageId)
        XCTAssertEqual(event.role, "reasoning")
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningMessageStartEvent(messageId: EventTestData.messageId, role: "reasoning")
        let e2 = ReasoningMessageStartEvent(messageId: EventTestData.messageId, role: "reasoning")
        XCTAssertEqual(e1, e2)
    }
}
