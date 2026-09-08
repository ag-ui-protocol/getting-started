// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningStartEventTests: XCTestCase,
                                       AGUIEventDecoderTestHelpers,
                                       EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId]
    }

    var eventTypeString: String { "REASONING_START" }
    var expectedEventType: EventType { .reasoningStart }
    var unknownEventTypeString: String { "REASONING_PAUSED" }

    // MARK: - Decode

    func test_decodeValidReasoningStart_returnsCorrectEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_START","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningStartEvent)
        XCTAssertEqual(event.eventType, .reasoningStart)
        XCTAssertEqual(event.messageId, EventTestData.messageId)
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {"type":"REASONING_START","messageId":"\(EventTestData.messageId)","timestamp":\(EventTestData.timestamp)}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningStartEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_START","messageId":"\(EventTestData.messageId)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningStartEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingMessageId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_START"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningStart() {
        let event = ReasoningStartEvent(messageId: EventTestData.messageId)
        XCTAssertEqual(event.eventType, .reasoningStart)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningStartEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        let e2 = ReasoningStartEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp)
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentMessageIds_notEqual() {
        let e1 = ReasoningStartEvent(messageId: EventTestData.messageId)
        let e2 = ReasoningStartEvent(messageId: EventTestData.messageId2)
        XCTAssertNotEqual(e1, e2)
    }
}
