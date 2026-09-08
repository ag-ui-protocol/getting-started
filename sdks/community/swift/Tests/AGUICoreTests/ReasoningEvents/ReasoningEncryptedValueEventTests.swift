// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningEncryptedValueEventTests: XCTestCase,
                                                AGUIEventDecoderTestHelpers,
                                                EventDecodingErrorTests {

    private let entityId = "entity-abc"
    private let encryptedValue = "enc-xyz-token"

    // MARK: - EventDecodingErrorTests

    var validEventFieldsWithoutType: [String: Any] {
        ["subtype": "tool-call", "entityId": "entity-abc", "encryptedValue": "enc-xyz-token"]
    }

    var eventTypeString: String { "REASONING_ENCRYPTED_VALUE" }
    var expectedEventType: EventType { .reasoningEncryptedValue }
    var unknownEventTypeString: String { "REASONING_ENCRYPTED_CHUNK" }

    // MARK: - Decode

    func test_decodeWithSubtypeToolCall_returnsCorrectEvent() throws {
        let data = jsonData("""
        {
          "type": "REASONING_ENCRYPTED_VALUE",
          "subtype": "tool-call",
          "entityId": "\(entityId)",
          "encryptedValue": "\(encryptedValue)"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEncryptedValueEvent)
        XCTAssertEqual(event.eventType, .reasoningEncryptedValue)
        XCTAssertEqual(event.subtype, .toolCall)
        XCTAssertEqual(event.entityId, entityId)
        XCTAssertEqual(event.encryptedValue, encryptedValue)
        XCTAssertNil(event.timestamp)
    }

    func test_decodeWithSubtypeMessage_returnsCorrectEvent() throws {
        let data = jsonData("""
        {
          "type": "REASONING_ENCRYPTED_VALUE",
          "subtype": "message",
          "entityId": "\(entityId)",
          "encryptedValue": "\(encryptedValue)"
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEncryptedValueEvent)
        XCTAssertEqual(event.subtype, .message)
    }

    func test_decodeWithTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {
          "type": "REASONING_ENCRYPTED_VALUE",
          "subtype": "message",
          "entityId": "\(entityId)",
          "encryptedValue": "\(encryptedValue)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEncryptedValueEvent)
        XCTAssertEqual(event.timestamp, EventTestData.timestamp)
    }

    func test_decodePreservesRawEvent() throws {
        let data = jsonData("""
        {"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"\(entityId)","encryptedValue":"\(encryptedValue)"}
        """)
        let event = try XCTUnwrap(try makeStrictDecoder().decode(data) as? ReasoningEncryptedValueEvent)
        XCTAssertEqual(event.rawEvent, data)
    }

    func test_missingSubtype_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_ENCRYPTED_VALUE","entityId":"entity-abc","encryptedValue":"token"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func test_missingEntityId_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","encryptedValue":"token"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func test_missingEncryptedValue_throwsDecodingFailed() {
        let data = jsonData("""
        {"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"entity-abc"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
        }
    }

    func test_invalidSubtypeValue_throwsInvalidJSON() {
        let data = jsonData("""
        {"type":"REASONING_ENCRYPTED_VALUE","subtype":"unknown-subtype","entityId":"entity-abc","encryptedValue":"token"}
        """)
        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            XCTAssertEqual(error as? EventDecodingError, .invalidJSON,
                           "Invalid enum raw value maps to .invalidJSON via dataCorrupted")
        }
    }

    // MARK: - Model

    func test_eventTypeIsAlwaysReasoningEncryptedValue() {
        let event = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: encryptedValue)
        XCTAssertEqual(event.eventType, .reasoningEncryptedValue)
    }

    func test_equatable_sameFields_areEqual() {
        let e1 = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: encryptedValue)
        let e2 = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: encryptedValue)
        XCTAssertEqual(e1, e2)
    }

    func test_equatable_differentSubtype_notEqual() {
        let e1 = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: encryptedValue)
        let e2 = ReasoningEncryptedValueEvent(subtype: .message, entityId: entityId, encryptedValue: encryptedValue)
        XCTAssertNotEqual(e1, e2)
    }

    func test_equatable_differentEncryptedValue_notEqual() {
        let e1 = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: "token-a")
        let e2 = ReasoningEncryptedValueEvent(subtype: .toolCall, entityId: entityId, encryptedValue: "token-b")
        XCTAssertNotEqual(e1, e2)
    }

    // MARK: - ReasoningEncryptedValueSubtype

    func test_subtypeToolCall_hasCorrectRawValue() {
        XCTAssertEqual(ReasoningEncryptedValueSubtype.toolCall.rawValue, "tool-call")
    }

    func test_subtypeMessage_hasCorrectRawValue() {
        XCTAssertEqual(ReasoningEncryptedValueSubtype.message.rawValue, "message")
    }
}
