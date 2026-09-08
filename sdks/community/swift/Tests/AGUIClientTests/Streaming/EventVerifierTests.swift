// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIClient
import XCTest

final class EventVerifierTests: XCTestCase {

    // MARK: - Valid Run Tests

    func testValidCompleteRunPassesThrough() async throws {
        // Given: A well-formed event sequence
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageEndEvent(messageId: "msg1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ]

        // When: Verifying the stream
        let verified = try await collectEvents(events.asyncStream.verifyEvents())

        // Then: All events pass through
        XCTAssertEqual(verified.count, 5)
        XCTAssertTrue(verified[0] is RunStartedEvent)
        XCTAssertTrue(verified[1] is TextMessageStartEvent)
        XCTAssertTrue(verified[2] is TextMessageContentEvent)
        XCTAssertTrue(verified[3] is TextMessageEndEvent)
        XCTAssertTrue(verified[4] is RunFinishedEvent)
    }

    // MARK: - First Event Validation Tests

    func testWrongFirstEventThrowsAGUIProtocolError() async throws {
        // Given: A stream that starts with a non-RUN_STARTED event
        let events: [any AGUIEvent] = [
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
        ]

        // When/Then: Should throw AGUIProtocolError
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertEqual(error.message, "First event must be 'RUN_STARTED'")
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testRunErrorAsFirstEventIsAllowed() async throws {
        // Given: A stream starting with RUN_ERROR
        let events: [any AGUIEvent] = [
            RunErrorEvent(message: "Something failed", code: "ERR"),
        ]

        // When: Verifying
        let verified = try await collectEvents(events.asyncStream.verifyEvents())

        // Then: RUN_ERROR passes through as first event
        XCTAssertEqual(verified.count, 1)
        XCTAssertTrue(verified[0] is RunErrorEvent)
    }

    // MARK: - Duplicate Message Tests

    func testDuplicateTextMessageStartThrowsError() async throws {
        // Given: Two TEXT_MESSAGE_START events with the same messageId
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
        ]

        // When/Then: Should throw AGUIProtocolError
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("msg1"))
            XCTAssertTrue(error.message.contains("already in progress"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Message Without Start Tests

    func testTextMessageContentWithoutStartThrowsError() async throws {
        // Given: TEXT_MESSAGE_CONTENT without matching START
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageContentEvent(messageId: "msg-orphan", delta: "Hello"),
        ]

        // When/Then: Should throw AGUIProtocolError
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("msg-orphan"))
            XCTAssertTrue(error.message.contains("No active text message"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - RUN_FINISHED with Active Message Tests

    func testRunFinishedWithActiveMessageThrowsError() async throws {
        // Given: RUN_FINISHED while a message is still open
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            // Missing TextMessageEndEvent
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ]

        // When/Then: Should throw AGUIProtocolError
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("RUN_FINISHED"))
            XCTAssertTrue(error.message.contains("messages are still active"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Sequential Runs Tests

    func testSequentialRunsResetState() async throws {
        // Given: Two complete runs in sequence
        let events: [any AGUIEvent] = [
            // First run
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageEndEvent(messageId: "msg1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
            // Second run
            RunStartedEvent(threadId: "t1", runId: "r2"),
            TextMessageStartEvent(messageId: "msg2", role: "assistant"),
            TextMessageContentEvent(messageId: "msg2", delta: "World"),
            TextMessageEndEvent(messageId: "msg2"),
            RunFinishedEvent(threadId: "t1", runId: "r2"),
        ]

        // When: Verifying
        let verified = try await collectEvents(events.asyncStream.verifyEvents())

        // Then: All 10 events pass through without error
        XCTAssertEqual(verified.count, 10)
    }

    func testEventsAfterRunErrorThrows() async throws {
        // Given: An event after RUN_ERROR
        let events: [any AGUIEvent] = [
            RunErrorEvent(message: "Failure", code: "ERR"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
        ]

        // When/Then: Should throw
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("already errored"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Tool Call Tests

    func testValidToolCallSequencePassesThrough() async throws {
        // Given: A valid tool call sequence
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "get_weather"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"loc\":"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "\"SF\"}"),
            ToolCallEndEvent(toolCallId: "tc1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ]

        // When: Verifying
        let verified = try await collectEvents(events.asyncStream.verifyEvents())

        // Then: All events pass through
        XCTAssertEqual(verified.count, 6)
    }

    func testToolCallArgsWithoutStartThrowsError() async throws {
        // Given: TOOL_CALL_ARGS without matching START
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ToolCallArgsEvent(toolCallId: "tc-orphan", delta: "{}"),
        ]

        // When/Then: Should throw
        do {
            _ = try await collectEvents(events.asyncStream.verifyEvents())
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("tc-orphan"))
            XCTAssertTrue(error.message.contains("No active tool call"))
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Helper Methods

    private func collectEvents(
        _ stream: AsyncThrowingStream<any AGUIEvent, Error>
    ) async throws -> [any AGUIEvent] {
        var collected: [any AGUIEvent] = []
        for try await event in stream {
            collected.append(event)
        }
        return collected
    }
}

// Note: asyncStream is provided by the extension in ChunkTransformTests.swift
