// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningEndEventTests: XCTestCase,
                                     AGUIEventDecoderTestHelpers,
                                     EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId]
    }

    var eventTypeString: String { "REASONING_END" }
    var expectedEventType: EventType { .reasoningEnd }
    var unknownEventTypeString: String { "REASONING_CANCELLED" }

    // MARK: - Decode

    func test_decodeValidReasoningEnd_returnsCorrectEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_END","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEndEvent)
        XCTAssertEqual(event.eventType, .reasoningEnd)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {"type":"REASONING_END","messageId":"\(EventTestData.messageId)","timestamp":\(EventTestData.timestamp)}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEndEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_END","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEndEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingMessageId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_END"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningEnd() {
        let event = ReasoningEndEvent(messageId: EventTestData.messageId)
        XCTAssertEqual(event.eventType, .reasoningEnd)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        let e2 = ReasoningEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentMessageIds_notEqual() {
        let e1 = ReasoningEndEvent(messageId: EventTestData.messageId)
        let e2 = ReasoningEndEvent(messageId: EventTestData.messageId2)
        XCTAssertNotEqual(e1, e2)
    }
}
