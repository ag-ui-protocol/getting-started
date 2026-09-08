// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIClient
import XCTest

final class DefaultApplyEventsTests: XCTestCase {

    // MARK: - Helpers

    private func makeInput(messages: [any Message] = []) -> RunAgentInput {
        RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages
        )
    }

    private func collectStates(
        _ stream: AsyncThrowingStream<AgentState, Error>
    ) async throws -> [AgentState] {
        var states: [AgentState] = []
        for try await state in stream {
            states.append(state)
        }
        return states
    }

    // MARK: - Text Message Tests

    func testTextMessageSequenceBuildsCorrectAssistantMessage() async throws {
        // Given: A text message event sequence
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageContentEvent(messageId: "msg1", delta: ", world!"),
            TextMessageEndEvent(messageId: "msg1"),
        ]
        let input = makeInput()

        // When: Applying events
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: Find the last messages emission
        let lastMessagesState = states.last(where: { $0.messages != nil })
        let msgs = lastMessagesState?.messages
        XCTAssertNotNil(msgs)
        XCTAssertEqual(msgs?.count, 1)

        let assistantMsg = msgs?[0] as? AssistantMessage
        XCTAssertNotNil(assistantMsg)
        XCTAssertEqual(assistantMsg?.id, "msg1")
        XCTAssertEqual(assistantMsg?.content, "Hello, world!")
    }

    func testTextMessageStartAppendsEmptyMessage() async throws {
        // Given: Just a TEXT_MESSAGE_START
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: Message appended with empty content
        let messagesState = states.first(where: { $0.messages != nil })
        let assistantMsg = messagesState?.messages?.first as? AssistantMessage
        XCTAssertNotNil(assistantMsg)
        XCTAssertEqual(assistantMsg?.content, "")
    }

    // MARK: - Tool Call Tests

    func testToolCallSequenceBuildsAssistantMessageToolCalls() async throws {
        // Given: A tool call event sequence
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1", role: "assistant"),
            ToolCallStartEvent(
                toolCallId: "tc1",
                toolCallName: "get_weather",
                parentMessageId: "msg1"
            ),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"loc\":"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "\"SF\"}"),
            ToolCallEndEvent(toolCallId: "tc1"),
            TextMessageEndEvent(messageId: "msg1"),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: Find the last messages state
        let lastMessagesState = states.last(where: { $0.messages != nil })
        let assistantMsg = lastMessagesState?.messages?.first as? AssistantMessage
        XCTAssertNotNil(assistantMsg)
        XCTAssertEqual(assistantMsg?.toolCalls?.count, 1)

        let toolCall = assistantMsg?.toolCalls?.first
        XCTAssertEqual(toolCall?.id, "tc1")
        XCTAssertEqual(toolCall?.function.name, "get_weather")
        XCTAssertEqual(toolCall?.function.arguments, "{\"loc\":\"SF\"}")
    }

    // MARK: - ToolCallResultEvent Tests

    func testToolCallResultEventAppendsToolMessage() async throws {
        // Given: A ToolCallResultEvent
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ToolCallResultEvent(
                messageId: "result-msg1",
                toolCallId: "tc1",
                content: "Sunny, 22C"
            ),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then
        let lastMessagesState = states.last(where: { $0.messages != nil })
        let toolMsg = lastMessagesState?.messages?.last as? ToolMessage
        XCTAssertNotNil(toolMsg)
        XCTAssertEqual(toolMsg?.id, "result-msg1")
        XCTAssertEqual(toolMsg?.toolCallId, "tc1")
        XCTAssertEqual(toolMsg?.content, "Sunny, 22C")
    }

    // MARK: - StateSnapshotEvent Tests

    func testStateSnapshotEventReplacesState() async throws {
        // Given: A StateSnapshotEvent
        let newStateData = Data("{\"count\":42}".utf8)
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: newStateData),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: Find the state emission
        let stateEmission = states.first(where: { $0.state != nil })
        XCTAssertNotNil(stateEmission)
        XCTAssertEqual(stateEmission?.state, newStateData)
    }

    // MARK: - StateDeltaEvent Tests

    func testStateDeltaEventAppliesPatch() async throws {
        // Given: An initial state and a delta
        let initialState = Data("{\"count\":0}".utf8)
        let patch = Data("[{\"op\":\"replace\",\"path\":\"/count\",\"value\":10}]".utf8)
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateDeltaEvent(delta: patch),
        ]
        let input = RunAgentInput(threadId: "t1", runId: "r1", state: initialState)

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: State should be patched
        let stateEmission = states.first(where: { $0.state != nil })
        XCTAssertNotNil(stateEmission)

        if let updatedState = stateEmission?.state,
           let json = try? JSONSerialization.jsonObject(with: updatedState) as? [String: Any],
           let count = json["count"] as? Int {
            XCTAssertEqual(count, 10)
        } else {
            XCTFail("Failed to parse updated state")
        }
    }

    // MARK: - Initial Messages Tests

    func testInitialMessagesAreEmittedOnFirstEvent() async throws {
        // Given: Input with pre-existing messages
        let existingMessages: [any Message] = [
            UserMessage(id: "user1", content: "Hello"),
        ]
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
        ]
        let input = makeInput(messages: existingMessages)

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then: Initial messages emitted on first event
        let firstMessagesState = states.first(where: { $0.messages != nil })
        XCTAssertNotNil(firstMessagesState)
        XCTAssertEqual(firstMessagesState?.messages?.count, 1)
        XCTAssertEqual(firstMessagesState?.messages?.first?.id, "user1")
    }

    // MARK: - RawEvent and CustomEvent Tests

    func testRawEventAppendsToRawEvents() async throws {
        // Given: A RawEvent
        let rawData = Data("{\"raw\":true}".utf8)
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RawEvent(data: rawData),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then
        let rawState = states.first(where: { $0.rawEvents != nil })
        XCTAssertNotNil(rawState)
        XCTAssertEqual(rawState?.rawEvents?.count, 1)
        XCTAssertEqual(rawState?.rawEvents?.first?.data, rawData)
    }

    func testCustomEventAppendsToCustomEvents() async throws {
        // Given: A CustomEvent
        let customData = Data("{\"action\":\"click\"}".utf8)
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            CustomEvent(name: "com.example.click", value: customData),
        ]
        let input = makeInput()

        // When
        let states = try await collectStates(events.asyncStream.applyEvents(input: input))

        // Then
        let customState = states.first(where: { $0.customEvents != nil })
        XCTAssertNotNil(customState)
        XCTAssertEqual(customState?.customEvents?.count, 1)
        XCTAssertEqual(customState?.customEvents?.first?.name, "com.example.click")
    }
}

// Note: asyncStream is provided by the extension in ChunkTransformTests.swift
