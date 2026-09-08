// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import XCTest
@testable import AGUIAgentSDK

// MARK: - MockAgentTransport

actor MockAgentTransport: AgentTransport {
    private var _eventSequences: [[any AGUIEvent]] = []

    func enqueue(_ events: [any AGUIEvent]) {
        _eventSequences.append(events)
    }

    nonisolated func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let events = await self.dequeue()
                for event in events { continuation.yield(event) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func dequeue() -> [any AGUIEvent] {
        _eventSequences.isEmpty ? [] : _eventSequences.removeFirst()
    }
}

// MARK: - EndToEndPipelineTests

final class EndToEndPipelineTests: XCTestCase {

    // MARK: - Text-only conversation

    func testTextOnlyConversationBuildsMessages() async throws {
        let mockTransport = MockAgentTransport()
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageContentEvent(messageId: "msg1", delta: ", world!"),
            TextMessageEndEvent(messageId: "msg1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let messages = await agent.messages
        XCTAssertEqual(messages.count, 1)
        let assistantMsg = try XCTUnwrap(messages.first as? AssistantMessage)
        XCTAssertEqual(assistantMsg.id, "msg1")
        XCTAssertEqual(assistantMsg.content, "Hello, world!")
    }

    // MARK: - State snapshot & delta

    func testStateDeltaIsAppliedCorrectly() async throws {
        let mockTransport = MockAgentTransport()

        let initialJSON = Data("{\"count\":0}".utf8)
        let patchJSON = Data("[{\"op\":\"replace\",\"path\":\"/count\",\"value\":5}]".utf8)

        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: initialJSON),
            StateDeltaEvent(delta: patchJSON),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let finalState = await agent.state
        guard let json = try? JSONSerialization.jsonObject(with: finalState) as? [String: Any],
              let count = json["count"] as? Int else {
            XCTFail("Could not parse final state")
            return
        }
        XCTAssertEqual(count, 5)
    }

    func testStateSnapshotReplacesState() async throws {
        let mockTransport = MockAgentTransport()
        let snapshotJSON = Data("{\"mode\":\"creative\"}".utf8)

        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: snapshotJSON),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let state = await agent.state
        guard let json = try? JSONSerialization.jsonObject(with: state) as? [String: Any],
              let mode = json["mode"] as? String else {
            XCTFail("Could not parse state")
            return
        }
        XCTAssertEqual(mode, "creative")
    }

    // MARK: - Sequential multi-run (state persists)

    func testSequentialRunsMaintainState() async throws {
        let mockTransport = MockAgentTransport()

        let state1 = Data("{\"turn\":1}".utf8)
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: state1),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let stateAfterRun1 = await agent.state
        guard let json1 = try? JSONSerialization.jsonObject(with: stateAfterRun1) as? [String: Any],
              let turn1 = json1["turn"] as? Int else {
            XCTFail("Could not parse state after run 1")
            return
        }
        XCTAssertEqual(turn1, 1)

        let state2 = Data("{\"turn\":2}".utf8)
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r2"),
            StateSnapshotEvent(snapshot: state2),
            RunFinishedEvent(threadId: "t1", runId: "r2"),
        ])

        try await agent.runAgent()

        let stateAfterRun2 = await agent.state
        guard let json2 = try? JSONSerialization.jsonObject(with: stateAfterRun2) as? [String: Any],
              let turn2 = json2["turn"] as? Int else {
            XCTFail("Could not parse state after run 2")
            return
        }
        XCTAssertEqual(turn2, 2)
    }

    // MARK: - Invalid event stream — EventVerifier

    func testInvalidEventStreamThrowsProtocolError() async throws {
        let mockTransport = MockAgentTransport()

        await mockTransport.enqueue([
            TextMessageStartEvent(messageId: "msg1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        do {
            try await agent.runAgent()
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertFalse(error.message.isEmpty)
        } catch {
            XCTFail("Expected AGUIProtocolError, got \(type(of: error)): \(error)")
        }
    }

    func testRunAfterRunErrorThrows() async throws {
        let mockTransport = MockAgentTransport()

        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunErrorEvent(message: "fatal error", code: "FATAL"),
            TextMessageStartEvent(messageId: "msg1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        do {
            try await agent.runAgent()
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("errored"))
        } catch {
            XCTFail("Expected AGUIProtocolError, got \(type(of: error)): \(error)")
        }
    }

    // MARK: - Tool call accumulation

    func testToolCallSequenceBuildsAssistantMessageWithToolCalls() async throws {
        let mockTransport = MockAgentTransport()
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "get_weather"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"city\":"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "\"London\"}"),
            ToolCallEndEvent(toolCallId: "tc1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let messages = await agent.messages
        XCTAssertFalse(messages.isEmpty)

        let assistantMsg = messages.compactMap { $0 as? AssistantMessage }.first
        let msg = try XCTUnwrap(assistantMsg)
        let calls = try XCTUnwrap(msg.toolCalls)
        XCTAssertFalse(calls.isEmpty)

        let call = try XCTUnwrap(calls.first)
        XCTAssertEqual(call.id, "tc1")
        XCTAssertEqual(call.function.name, "get_weather")
        XCTAssertEqual(call.function.arguments, "{\"city\":\"London\"}")
    }

    // MARK: - Custom & raw events

    func testRawEventsAccumulate() async throws {
        let mockTransport = MockAgentTransport()
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RawEvent(data: Data("{\"event\":\"raw_1\"}".utf8)),
            RawEvent(data: Data("{\"event\":\"raw_2\"}".utf8)),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let rawEvents = await agent.rawEvents
        XCTAssertEqual(rawEvents.count, 2)
    }

    func testCustomEventsAccumulate() async throws {
        let mockTransport = MockAgentTransport()
        await mockTransport.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            CustomEvent(name: "ping", value: Data("{\"ts\":1}".utf8)),
            CustomEvent(name: "pong", value: Data("{\"ts\":2}".utf8)),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let agent = AbstractAgent(transport: mockTransport)
        try await agent.runAgent()

        let customEvents = await agent.customEvents
        XCTAssertEqual(customEvents.count, 2)
        XCTAssertEqual(customEvents[0].name, "ping")
        XCTAssertEqual(customEvents[1].name, "pong")
    }

    // MARK: - getAllExecutors()

    func testDefaultToolRegistryGetAllExecutors() async throws {
        let registry = DefaultToolRegistry()

        let executor = SimpleMockExecutor(toolName: "search", description: "Search")
        try await registry.register(executor: executor)

        let executors = await registry.getAllExecutors()
        XCTAssertEqual(executors.count, 1)
        XCTAssertNotNil(executors["search"])
    }

    func testGetAllExecutorsReturnsEmptyWhenNoTools() async {
        let registry = DefaultToolRegistry()
        let executors = await registry.getAllExecutors()
        XCTAssertTrue(executors.isEmpty)
    }

    func testGetAllExecutorsAfterUnregister() async throws {
        let registry = DefaultToolRegistry()
        let executor = SimpleMockExecutor(toolName: "tool_a", description: "A")
        try await registry.register(executor: executor)
        _ = await registry.unregister(toolName: "tool_a")

        let executors = await registry.getAllExecutors()
        XCTAssertTrue(executors.isEmpty)
    }
}

// MARK: - SimpleMockExecutor

private final class SimpleMockExecutor: ToolExecutor, Sendable {
    let tool: Tool

    init(toolName: String, description: String) {
        self.tool = Tool(
            name: toolName,
            description: description,
            parameters: Data("{}".utf8)
        )
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(success: true, result: Data("ok".utf8))
    }

    func getMaxExecutionTimeMs() -> Int64? { nil }
}
