// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import XCTest
@testable import AGUIAgentSDK

// MARK: - StatefulAgUiAgentTests

final class StatefulAgUiAgentTests: XCTestCase {

    // MARK: - Helpers

    private func makeAgent(
        configure: (inout StatefulAgUiAgentConfig) -> Void = { _ in }
    ) -> (StatefulAgUiAgent, CapturingTransport) {
        let url = URL(string: "https://placeholder.local")!
        var cfg = StatefulAgUiAgentConfig(baseURL: url)
        configure(&cfg)
        let transport = CapturingTransport()
        let agent = StatefulAgUiAgent(transport: transport, config: cfg)
        return (agent, transport)
    }

    private func drain(
        _ stream: AsyncThrowingStream<any AGUIEvent, Error>
    ) async throws -> [any AGUIEvent] {
        var received: [any AGUIEvent] = []
        for try await event in stream { received.append(event) }
        return received
    }

    // MARK: - RunAgentInput construction

    func testUserMessageIncludedInInput() async throws {
        let (agent, transport) = makeAgent()
        _ = try await drain(agent.sendMessage(
            message: "Hello",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        let input = try XCTUnwrap(inputs.first)
        let userMessages = input.messages.filter { $0.role == .user }
        XCTAssertEqual(userMessages.count, 1)
        XCTAssertEqual((userMessages[0] as? UserMessage)?.content, "Hello")
    }

    func testSystemPromptAddedOnFirstMessageWhenEnabled() async throws {
        let (agent, transport) = makeAgent { cfg in
            cfg.systemPrompt = "Be helpful."
        }
        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: true
        ))

        let inputs = await transport.capturedInputs
        let input = try XCTUnwrap(inputs.first)
        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].role, .system)
        XCTAssertEqual((input.messages[0] as? SystemMessage)?.content, "Be helpful.")
        XCTAssertEqual(input.messages[1].role, .user)
    }

    func testSystemPromptOmittedWhenFlagIsFalse() async throws {
        let (agent, transport) = makeAgent { cfg in
            cfg.systemPrompt = "Be helpful."
        }
        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        let input = try XCTUnwrap(inputs.first)
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].role, .user)
    }

    func testSystemPromptAddedOnlyOnFirstMessage() async throws {
        let (agent, _) = makeAgent { cfg in
            cfg.systemPrompt = "Be helpful."
        }

        _ = try await drain(agent.sendMessage(
            message: "First",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: true
        ))
        _ = try await drain(agent.sendMessage(
            message: "Second",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: true
        ))

        let history = await agent.history(for: "t1")
        let systemMessages = history.filter { $0.role == .system }
        XCTAssertEqual(systemMessages.count, 1, "System prompt must appear exactly once")
    }

    func testThreadIdPassedToTransport() async throws {
        let (agent, transport) = makeAgent()
        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "my-thread",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.first?.threadId, "my-thread")
    }

    func testCustomStatePassedToTransport() async throws {
        let customState = Data("{\"mode\":\"creative\"}".utf8)
        let (agent, transport) = makeAgent()
        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: customState,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.first?.state, customState)
    }

    // MARK: - chat() convenience

    func testChatDelegatesToSendMessageWithGivenThread() async throws {
        let (agent, transport) = makeAgent()
        _ = try await drain(agent.chat(message: "Hello!", threadId: "t1"))

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(inputs[0].threadId, "t1")
    }

    func testChatIncludesSystemPromptByDefault() async throws {
        let (agent, transport) = makeAgent { cfg in
            cfg.systemPrompt = "You are helpful."
        }
        _ = try await drain(agent.chat(message: "Hi", threadId: "t1"))

        let inputs = await transport.capturedInputs
        let input = try XCTUnwrap(inputs.first)
        XCTAssertEqual(input.messages[0].role, .system)
    }

    // MARK: - History accumulation

    func testUserMessageAppendedToHistory() async throws {
        let (agent, _) = makeAgent()
        _ = try await drain(agent.sendMessage(
            message: "Hello",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let userMessages = history.filter { $0.role == .user }
        XCTAssertEqual(userMessages.count, 1)
        XCTAssertEqual((userMessages[0] as? UserMessage)?.content, "Hello")
    }

    func testHistoryAccumulatesAcrossRounds() async throws {
        let (agent, _) = makeAgent()

        _ = try await drain(agent.sendMessage(
            message: "First",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))
        _ = try await drain(agent.sendMessage(
            message: "Second",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let userMessages = history.filter { $0.role == .user }
        XCTAssertEqual(userMessages.count, 2)
        XCTAssertEqual((userMessages[0] as? UserMessage)?.content, "First")
        XCTAssertEqual((userMessages[1] as? UserMessage)?.content, "Second")
    }

    func testHistoryPassedToTransportOnSecondCall() async throws {
        let (agent, transport) = makeAgent()

        _ = try await drain(agent.sendMessage(
            message: "First",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))
        _ = try await drain(agent.sendMessage(
            message: "Second",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.count, 2)
        // Second call's input must contain "First" already in history
        XCTAssertEqual(inputs[1].messages.count, 2)
        XCTAssertEqual((inputs[1].messages[0] as? UserMessage)?.content, "First")
        XCTAssertEqual((inputs[1].messages[1] as? UserMessage)?.content, "Second")
    }

    func testHistoryIsolatedPerThread() async throws {
        let (agent, _) = makeAgent()

        _ = try await drain(agent.sendMessage(
            message: "Thread A",
            threadId: "thread-a",
            state: nil,
            includeSystemPrompt: false
        ))
        _ = try await drain(agent.sendMessage(
            message: "Thread B",
            threadId: "thread-b",
            state: nil,
            includeSystemPrompt: false
        ))

        let historyA = await agent.history(for: "thread-a")
        let historyB = await agent.history(for: "thread-b")
        XCTAssertEqual(historyA.count, 1)
        XCTAssertEqual(historyB.count, 1)
        XCTAssertEqual((historyA[0] as? UserMessage)?.content, "Thread A")
        XCTAssertEqual((historyB[0] as? UserMessage)?.content, "Thread B")
    }

    func testHistoryTrimmingRespected() async throws {
        let (agent, _) = makeAgent { cfg in
            cfg.maxHistoryLength = 3
        }

        for i in 1...5 {
            _ = try await drain(agent.sendMessage(
                message: "Message \(i)",
                threadId: "t1",
                state: nil,
                includeSystemPrompt: false
            ))
        }

        let history = await agent.history(for: "t1")
        XCTAssertLessThanOrEqual(history.count, 3)
    }

    func testHistoryForNewThreadIsEmpty() async {
        let (agent, _) = makeAgent()
        let history = await agent.history(for: "nonexistent-thread")
        XCTAssertTrue(history.isEmpty)
    }

    // MARK: - clearHistory

    func testClearHistoryClearsSpecificThread() async throws {
        let (agent, _) = makeAgent()
        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        await agent.clearHistory(threadId: "t1")

        let history = await agent.history(for: "t1")
        XCTAssertTrue(history.isEmpty)
    }

    func testClearHistoryNilClearsAllThreads() async throws {
        let (agent, _) = makeAgent()

        for threadId in ["t1", "t2", "t3"] {
            _ = try await drain(agent.sendMessage(
                message: "Hi",
                threadId: threadId,
                state: nil,
                includeSystemPrompt: false
            ))
        }

        await agent.clearHistory()

        for threadId in ["t1", "t2", "t3"] {
            let history = await agent.history(for: threadId)
            XCTAssertTrue(history.isEmpty, "Thread \(threadId) should be empty after clearHistory()")
        }
    }

    // MARK: - Event passthrough

    func testAllEventsYieldedDownstream() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        let received = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        XCTAssertEqual(received.count, 2)
        XCTAssertTrue(received[0] is RunStartedEvent)
        XCTAssertTrue(received[1] is RunFinishedEvent)
    }

    // MARK: - Text message assembly (trackHistoryAndState)

    func testTextMessageAssemblyRecordedInHistory() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageContentEvent(messageId: "msg1", delta: ", world!"),
            TextMessageEndEvent(messageId: "msg1"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let assistantMsgs = history.compactMap { $0 as? AssistantMessage }
        XCTAssertEqual(assistantMsgs.count, 1)
        XCTAssertEqual(assistantMsgs[0].id, "msg1")
        XCTAssertEqual(assistantMsgs[0].content, "Hello, world!")
    }

    func testTextMessageContentConcatenated() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            TextMessageStartEvent(messageId: "m1"),
            TextMessageContentEvent(messageId: "m1", delta: "A"),
            TextMessageContentEvent(messageId: "m1", delta: "B"),
            TextMessageContentEvent(messageId: "m1", delta: "C"),
            TextMessageEndEvent(messageId: "m1"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let assistantMsg = try XCTUnwrap(history.compactMap { $0 as? AssistantMessage }.first)
        XCTAssertEqual(assistantMsg.content, "ABC")
    }

    func testEmptyTextMessageStillRecordedInHistory() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            TextMessageStartEvent(messageId: "m2"),
            TextMessageEndEvent(messageId: "m2"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Hi",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let assistantMsgs = history.compactMap { $0 as? AssistantMessage }
        XCTAssertEqual(assistantMsgs.count, 1)
        XCTAssertEqual(assistantMsgs[0].content, "")
    }

    // MARK: - Tool call tracking (trackHistoryAndState)

    func testToolCallResultAppendsToolMessageToHistory() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "get_weather"),
            ToolCallEndEvent(toolCallId: "tc1"),
            ToolCallResultEvent(messageId: "res1", toolCallId: "tc1", content: "72°F, sunny"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Weather?",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let toolMessages = history.compactMap { $0 as? ToolMessage }
        XCTAssertEqual(toolMessages.count, 1)
        XCTAssertEqual(toolMessages[0].toolCallId, "tc1")
        XCTAssertEqual(toolMessages[0].content, "72°F, sunny")
    }

    func testToolCallResultFlushesPendingAssistantMessage() async throws {
        let (agent, transport) = makeAgent()
        await transport.setMockEvents([
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "get_weather"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"city\":\"London\"}"),
            ToolCallEndEvent(toolCallId: "tc1"),
            ToolCallResultEvent(messageId: "res1", toolCallId: "tc1", content: "Rainy"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Weather?",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let assistantMsgs = history.compactMap { $0 as? AssistantMessage }
        XCTAssertEqual(assistantMsgs.count, 1)
        let calls = try XCTUnwrap(assistantMsgs[0].toolCalls)
        XCTAssertEqual(calls[0].id, "tc1")
        XCTAssertEqual(calls[0].function.name, "get_weather")
        XCTAssertEqual(calls[0].function.arguments, "{\"city\":\"London\"}")
    }

    func testToolCallEndDoesNotDuplicateAssistantMessage() async throws {
        let (agent, transport) = makeAgent()
        // Two tool calls complete before a ToolCallResultEvent — must not prematurely flush
        await transport.setMockEvents([
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "tool_a"),
            ToolCallEndEvent(toolCallId: "tc1"),
            ToolCallStartEvent(toolCallId: "tc2", toolCallName: "tool_b"),
            ToolCallEndEvent(toolCallId: "tc2"),
            ToolCallResultEvent(messageId: "res1", toolCallId: "tc1", content: "ok"),
        ])

        _ = try await drain(agent.sendMessage(
            message: "Go",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let history = await agent.history(for: "t1")
        let assistantMsgs = history.compactMap { $0 as? AssistantMessage }
        XCTAssertEqual(assistantMsgs.count, 1, "ToolCallEnd must not flush assistant message early")
    }

    // MARK: - State event tracking (trackHistoryAndState)

    func testStateSnapshotUpdatesStateForNextRun() async throws {
        let (agent, transport) = makeAgent()
        let newState = Data("{\"count\":42}".utf8)
        await transport.setMockEvents([StateSnapshotEvent(snapshot: newState)])

        _ = try await drain(agent.sendMessage(
            message: "First",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        await transport.setMockEvents([])
        _ = try await drain(agent.sendMessage(
            message: "Second",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs[1].state, newState)
    }

    func testStateDeltaAppliedToCurrentState() async throws {
        let (agent, transport) = makeAgent()
        let snapshot = Data("{\"count\":0}".utf8)
        let patch = Data("[{\"op\":\"replace\",\"path\":\"/count\",\"value\":7}]".utf8)
        await transport.setMockEvents([
            StateSnapshotEvent(snapshot: snapshot),
            StateDeltaEvent(delta: patch),
        ])

        _ = try await drain(agent.sendMessage(
            message: "First",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        await transport.setMockEvents([])
        _ = try await drain(agent.sendMessage(
            message: "Second",
            threadId: "t1",
            state: nil,
            includeSystemPrompt: false
        ))

        let inputs = await transport.capturedInputs
        let stateData = inputs[1].state
        guard let json = try? JSONSerialization.jsonObject(with: stateData) as? [String: Any],
              let count = json["count"] as? Int else {
            XCTFail("Could not parse state JSON")
            return
        }
        XCTAssertEqual(count, 7)
    }
}
