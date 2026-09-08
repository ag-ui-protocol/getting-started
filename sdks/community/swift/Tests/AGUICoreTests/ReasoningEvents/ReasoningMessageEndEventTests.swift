// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningMessageEndEventTests: XCTestCase,
                                            AGUIEventDecoderTestHelpers,
                                            EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId]
    }

    var eventTypeString: String { "REASONING_MESSAGE_END" }
    var expectedEventType: EventType { .reasoningMessageEnd }
    var unknownEventTypeString: String { "REASONING_MESSAGE_TERMINATED" }

    // MARK: - Decode

    func test_decodeValidReasoningMessageEnd_returnsCorrectEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_END","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageEndEvent)
        XCTAssertEqual(event.eventType, .reasoningMessageEnd)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_END","messageId":"\(EventTestData.messageId)","timestamp":\(EventTestData.timestamp)}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageEndEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_END","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningMessageEndEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingMessageId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_MESSAGE_END"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningMessageEnd() {
        let event = ReasoningMessageEndEvent(messageId: EventTestData.messageId)
        XCTAssertEqual(event.eventType, .reasoningMessageEnd)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        let e2 = ReasoningMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentMessageIds_notEqual() {
        let e1 = ReasoningMessageEndEvent(messageId: EventTestData.messageId)
        let e2 = ReasoningMessageEndEvent(messageId: EventTestData.messageId2)
        XCTAssertNotEqual(e1, e2)
    }
}
