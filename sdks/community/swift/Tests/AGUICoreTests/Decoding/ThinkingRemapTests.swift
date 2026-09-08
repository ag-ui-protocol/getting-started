// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the THINKING_* → REASONING_* backward-compatibility remap.
///
/// The TypeScript `BackwardCompatibility_0_0_45` middleware maintains stateful
/// `currentReasoningId` and `currentMessageId` so that all events in a sequence
/// share stable, correlated IDs. These tests verify the Swift decoder does the same.
final class ThinkingRemapTests: XCTestCase, AGUIEventDecoderTestHelpers {

    // MARK: - Reasoning envelope (THINKING_START / THINKING_END)

    func test_thinkingStart_remapsToReasoningStart() throws {
        let data = jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#)
        let event = try makeStrictDecoder().decode(data)
        XCTAssertTrue(event is ReasoningStartEvent, "Expected ReasoningStartEvent, got \(type(of: event))")
    }

    func test_thinkingEnd_remapsToReasoningEnd() throws {
        let data = jsonData(#"{"type":"THINKING_END","threadId":"t1","runId":"r1"}"#)
        let event = try makeStrictDecoder().decode(data)
        XCTAssertTrue(event is ReasoningEndEvent, "Expected ReasoningEndEvent, got \(type(of: event))")
    }

    func test_thinkingStartAndEnd_shareMessageId() throws {
        // THINKING_START and THINKING_END must carry the same messageId so that
        // consumers can correlate the open/close of a reasoning envelope.
        let decoder = makeStrictDecoder()

        let startData = jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#)
        let endData   = jsonData(#"{"type":"THINKING_END","threadId":"t1","runId":"r1"}"#)

        let startEvent = try XCTUnwrap(try decoder.decode(startData) as? ReasoningStartEvent)
        let endEvent   = try XCTUnwrap(try decoder.decode(endData)   as? ReasoningEndEvent)

        XCTAssertFalse(startEvent.messageId.isEmpty, "THINKING_START must produce a non-empty messageId")
        XCTAssertEqual(startEvent.messageId, endEvent.messageId,
                       "THINKING_START and THINKING_END must share the same messageId")
    }

    // MARK: - Text message sequence (THINKING_TEXT_MESSAGE_*)

    func test_thinkingTextMessageStart_remapsToReasoningMessageStart() throws {
        let data = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_START","threadId":"t1","runId":"r1"}"#)
        let event = try makeStrictDecoder().decode(data)
        XCTAssertTrue(event is ReasoningMessageStartEvent,
                      "Expected ReasoningMessageStartEvent, got \(type(of: event))")
    }

    func test_thinkingTextMessageContent_remapsToReasoningMessageContent() throws {
        // Sequence: START must be decoded first to establish currentMessageId.
        let decoder = makeStrictDecoder()
        _ = try decoder.decode(jsonData(#"{"type":"THINKING_TEXT_MESSAGE_START","threadId":"t1","runId":"r1"}"#))

        let data = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_CONTENT","threadId":"t1","runId":"r1","delta":"hello"}"#)
        let event = try decoder.decode(data)
        XCTAssertTrue(event is ReasoningMessageContentEvent,
                      "Expected ReasoningMessageContentEvent, got \(type(of: event))")
    }

    func test_thinkingTextMessageEnd_remapsToReasoningMessageEnd() throws {
        let decoder = makeStrictDecoder()
        _ = try decoder.decode(jsonData(#"{"type":"THINKING_TEXT_MESSAGE_START","threadId":"t1","runId":"r1"}"#))

        let data = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_END","threadId":"t1","runId":"r1"}"#)
        let event = try decoder.decode(data)
        XCTAssertTrue(event is ReasoningMessageEndEvent,
                      "Expected ReasoningMessageEndEvent, got \(type(of: event))")
    }

    func test_thinkingTextMessageSequence_allShareMessageId() throws {
        // THINKING_TEXT_MESSAGE_START, _CONTENT, and _END must all carry the same
        // messageId so consumers can assemble the full text message.
        let decoder = makeStrictDecoder()

        let startData   = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_START","threadId":"t1","runId":"r1"}"#)
        let contentData = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_CONTENT","threadId":"t1","runId":"r1","delta":"hi"}"#)
        let endData     = jsonData(#"{"type":"THINKING_TEXT_MESSAGE_END","threadId":"t1","runId":"r1"}"#)

        let startEvent   = try XCTUnwrap(try decoder.decode(startData)   as? ReasoningMessageStartEvent)
        let contentEvent = try XCTUnwrap(try decoder.decode(contentData) as? ReasoningMessageContentEvent)
        let endEvent     = try XCTUnwrap(try decoder.decode(endData)     as? ReasoningMessageEndEvent)

        XCTAssertFalse(startEvent.messageId.isEmpty)
        XCTAssertEqual(startEvent.messageId, contentEvent.messageId,
                       "START and CONTENT must share messageId")
        XCTAssertEqual(startEvent.messageId, endEvent.messageId,
                       "START and END must share messageId")
    }

    // MARK: - Two ID axes are independent

    func test_reasoningEnvelopeAndTextMessageIds_areIndependent() throws {
        // The reasoning envelope ID (THINKING_START/END) and the text message ID
        // (THINKING_TEXT_MESSAGE_*) are two separate axes and must not be equal.
        let decoder = makeStrictDecoder()

        let reasoningStart = try XCTUnwrap(
            try decoder.decode(jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#))
                as? ReasoningStartEvent
        )
        let msgStart = try XCTUnwrap(
            try decoder.decode(jsonData(#"{"type":"THINKING_TEXT_MESSAGE_START","threadId":"t1","runId":"r1"}"#))
                as? ReasoningMessageStartEvent
        )

        XCTAssertNotEqual(reasoningStart.messageId, msgStart.messageId,
                          "Reasoning envelope ID and text message ID must be independent")
    }

    // MARK: - Decoder isolation

    func test_separateDecoders_produceDifferentIds() throws {
        // Each AGUIEventDecoder instance must have its own ID state.
        // Two decoders processing identical THINKING_START bytes must produce different messageIds.
        let decoderA = makeStrictDecoder()
        let decoderB = makeStrictDecoder()

        let data = jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#)

        let eventA = try XCTUnwrap(try decoderA.decode(data) as? ReasoningStartEvent)
        let eventB = try XCTUnwrap(try decoderB.decode(data) as? ReasoningStartEvent)

        XCTAssertNotEqual(eventA.messageId, eventB.messageId,
                          "Independent decoders must produce independent messageIds")
    }

    // MARK: - ID resets between sequences

    func test_newThinkingStart_generatesNewId() throws {
        // After THINKING_END closes a reasoning envelope, a new THINKING_START must
        // generate a fresh ID — not reuse the previous one.
        let decoder = makeStrictDecoder()

        let start1 = try XCTUnwrap(
            try decoder.decode(jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#))
                as? ReasoningStartEvent
        )
        _ = try decoder.decode(jsonData(#"{"type":"THINKING_END","threadId":"t1","runId":"r1"}"#))

        let start2 = try XCTUnwrap(
            try decoder.decode(jsonData(#"{"type":"THINKING_START","threadId":"t1","runId":"r1"}"#))
                as? ReasoningStartEvent
        )

        XCTAssertNotEqual(start1.messageId, start2.messageId,
                          "A new THINKING_START sequence must produce a new messageId")
    }
}
