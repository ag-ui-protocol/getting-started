// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class RunFinishedEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "threadId": EventTestData.threadId,
            "runId": EventTestData.runId
        ]
    }

    var eventTypeString: String { "RUN_FINISHED" }
    var expectedEventType: EventType { .runFinished }
    var unknownEventTypeString: String { "RUN_PAUSED" }

    // MARK: - Feature: Decode RUN_FINISHED (base fields)

    func test_decodeValidRunFinished_returnsRunFinishedEvent() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.eventType, .runFinished)
        XCTAssertEqual(runFinished.threadId, EventTestData.threadId)
        XCTAssertEqual(runFinished.runId, EventTestData.runId)
        XCTAssertNil(runFinished.timestamp)
    }

    func test_decodeRunFinished_withTimestamp_populatesTimestamp() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.timestamp, EventTestData.timestamp)
    }

    func test_decodeRunFinished_preservesRawEventBytes() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.rawEvent, data)
    }

    func test_decodeRunFinished_ignoresUnknownExtraFields() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.threadId, EventTestData.threadId)
        XCTAssertEqual(runFinished.runId, EventTestData.runId)
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeRunFinished_missingThreadId_throwsDecodingFailed() {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "runId": "run-456"
        }
        """)

        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("threadId"), "Expected message to mention 'threadId'. Got: \(message)")
        }
    }

    func test_decodeRunFinished_threadIdWrongType_throwsDecodingFailed() {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": 123,
          "runId": "run-456"
        }
        """)

        XCTAssertThrowsError(try makeStrictDecoder().decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(
                message.lowercased().contains("type mismatch") || message.contains("Type mismatch"),
                "Expected a type mismatch message. Got: \(message)"
            )
        }
    }

    // MARK: - Feature: Decode outcome field (wire format: discriminated union object)

    func test_decodeRunFinished_withSuccessOutcome_decodesCorrectly() throws {
        // The AG-UI wire format sends outcome as { "type": "success" }, not a string.
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "success" }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .success)
    }

    func test_decodeRunFinished_withInterruptOutcome_decodesInterrupts() throws {
        // Wire format: { "type": "interrupt", "interrupts": [...] }
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": {
            "type": "interrupt",
            "interrupts": [
              {
                "id": "int-1",
                "reason": "Approval required",
                "message": "Please approve the action",
                "toolCallId": "tool-call-abc"
              }
            ]
          }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        guard case .interrupt(let interrupts) = runFinished.outcome else {
            return XCTFail("Expected .interrupt outcome, got \(String(describing: runFinished.outcome))")
        }
        XCTAssertEqual(interrupts.count, 1)
        XCTAssertEqual(interrupts[0].id, "int-1")
        XCTAssertEqual(interrupts[0].reason, "Approval required")
        XCTAssertEqual(interrupts[0].message, "Please approve the action")
        XCTAssertEqual(interrupts[0].toolCallId, "tool-call-abc")
    }

    func test_decodeRunFinished_withMultipleInterrupts_decodesAll() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": {
            "type": "interrupt",
            "interrupts": [
              { "id": "int-1", "reason": "Step 1 approval" },
              { "id": "int-2", "reason": "Step 2 approval" }
            ]
          }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        guard case .interrupt(let interrupts) = runFinished.outcome else {
            return XCTFail("Expected .interrupt outcome")
        }
        XCTAssertEqual(interrupts.count, 2)
        XCTAssertEqual(interrupts[0].id, "int-1")
        XCTAssertEqual(interrupts[1].id, "int-2")
    }

    func test_decodeRunFinished_withMissingOutcome_yieldsNilOutcome() throws {
        // Absent outcome field → nil (treat as normal completion)
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.outcome)
    }

    func test_decodeRunFinished_withNullOutcome_yieldsNilOutcome() throws {
        // Python SDK compat: model_dump() without exclude_none=True emits "outcome": null
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": null
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.outcome)
    }

    func test_decodeRunFinished_withUnknownOutcomeType_yieldsNilOutcome() throws {
        // Forward compatibility: unknown future outcome types fall through to nil
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "suspended" }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.outcome)
    }

    func test_decodeRunFinished_withInterruptOutcome_emptyInterrupts_yieldsNilOutcome() throws {
        // Malformed: interrupts array is empty — must have at least one per the spec
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "interrupt", "interrupts": [] }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.outcome)
    }

    // MARK: - Feature: Model behaviors

    func test_runFinishedEvent_eventTypeIsAlwaysRunFinished() {
        let event = RunFinishedEvent(threadId: "t", runId: "r")
        XCTAssertEqual(event.eventType, .runFinished)
    }

    func test_runFinishedEvent_defaultOutcomeIsNil() {
        let event = RunFinishedEvent(threadId: "t", runId: "r")
        XCTAssertNil(event.outcome)
    }

    func test_runFinishedEvent_outcomeCanBeSetToSuccess() {
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)
        XCTAssertEqual(event.outcome, .success)
    }

    func test_runFinishedEvent_outcomeCanBeSetToInterrupt() {
        let interrupt = Interrupt(id: "int-1", reason: "Review needed")
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .interrupt([interrupt]))
        XCTAssertEqual(event.outcome, .interrupt([interrupt]))
    }

    func test_runFinishedEvent_equatable_sameFields_areEqual() {
        let event1 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success, timestamp: 1, rawEvent: nil)
        let event2 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success, timestamp: 1, rawEvent: nil)
        XCTAssertEqual(event1, event2)
    }

    func test_runFinishedEvent_equatable_successVsNilOutcome_notEqual() {
        let event1 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)
        let event2 = RunFinishedEvent(threadId: "t", runId: "r", outcome: nil)
        XCTAssertNotEqual(event1, event2)
    }

    func test_runFinishedEvent_equatable_successVsInterrupt_notEqual() {
        let interrupt = Interrupt(id: "int-1", reason: "R")
        let event1 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)
        let event2 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .interrupt([interrupt]))
        XCTAssertNotEqual(event1, event2)
    }

    func test_runFinishedEvent_description_containsOutcome() {
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)
        XCTAssertTrue(event.description.contains("success"))
    }

    func test_runFinishedEvent_description_interruptShowsCount() {
        let interrupts = [
            Interrupt(id: "int-1", reason: "R1"),
            Interrupt(id: "int-2", reason: "R2")
        ]
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .interrupt(interrupts))
        XCTAssertTrue(event.description.contains("2"))
    }

    // MARK: - Feature: Interrupt field completeness (end-to-end decode)

    func test_decodeRunFinished_interruptOutcome_allOptionalFields_surviveDecoding() throws {
        // Verifies that all optional Interrupt fields survive the full wire → domain decode path.
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": {
            "type": "interrupt",
            "interrupts": [
              {
                "id": "int-full",
                "reason": "Needs human approval",
                "message": "Please review the proposed action",
                "toolCallId": "tool-call-xyz",
                "responseSchema": { "approved": { "type": "boolean" } },
                "expiresAt": "2025-12-31T23:59:59Z",
                "metadata": { "source": "tool-executor", "priority": "high" }
              }
            ]
          }
        }
        """)

        let event = try makeStrictDecoder().decode(data)

        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        guard case .interrupt(let interrupts) = runFinished.outcome else {
            return XCTFail("Expected .interrupt outcome")
        }
        XCTAssertEqual(interrupts.count, 1)

        let interrupt = interrupts[0]
        XCTAssertEqual(interrupt.id, "int-full")
        XCTAssertEqual(interrupt.reason, "Needs human approval")
        XCTAssertEqual(interrupt.message, "Please review the proposed action")
        XCTAssertEqual(interrupt.toolCallId, "tool-call-xyz")
        XCTAssertEqual(interrupt.expiresAt, "2025-12-31T23:59:59Z")

        // responseSchema survives as non-nil Data containing valid JSON
        let responseSchemaData = try XCTUnwrap(interrupt.responseSchema)
        let responseSchema = try JSONSerialization.jsonObject(with: responseSchemaData) as? [String: Any]
        XCTAssertNotNil(responseSchema?["approved"])

        // metadata survives as non-nil Data containing valid JSON
        let metadataData = try XCTUnwrap(interrupt.metadata)
        let metadata = try JSONSerialization.jsonObject(with: metadataData) as? [String: Any]
        XCTAssertEqual(metadata?["source"] as? String, "tool-executor")
        XCTAssertEqual(metadata?["priority"] as? String, "high")
    }
}
