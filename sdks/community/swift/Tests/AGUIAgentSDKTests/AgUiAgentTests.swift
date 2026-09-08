// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import XCTest
@testable import AGUIAgentSDK

// MARK: - Test helpers

actor CapturingTransport: AgentTransport {
    private(set) var capturedInputs: [RunAgentInput] = []
    var mockEvents: [any AGUIEvent] = []

    func setMockEvents(_ events: [any AGUIEvent]) {
        mockEvents = events
    }

    nonisolated func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                await self.record(input)
                let events = await self.mockEvents
                for event in events { continuation.yield(event) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func record(_ input: RunAgentInput) {
        capturedInputs.append(input)
    }
}

// MARK: - AgUiAgentTests

final class AgUiAgentTests: XCTestCase {

    private let agentURL = URL(string: "https://agent.example.com")!

    private func makeCapturingAgent(
        configure: (inout AgUiAgentConfig) -> Void = { _ in }
    ) -> (AgUiAgent, CapturingTransport) {
        var cfg = AgUiAgentConfig()
        configure(&cfg)
        let transport = CapturingTransport()
        let agent = AgUiAgent(transport: transport, config: cfg)
        return (agent, transport)
    }

    // MARK: - sendMessage constructs correct RunAgentInput

    func testSendMessageProducesUserMessage() async throws {
        let (agent, transport) = makeCapturingAgent()
        let stream = agent.sendMessage("Hello!")
        for try await _ in stream {}

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.count, 1)

        let input = try XCTUnwrap(inputs.first)
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].role, .user)
        XCTAssertEqual((input.messages[0] as? UserMessage)?.content, "Hello!")
    }

    func testSendMessagePrependsSystemPromptWhenConfigured() async throws {
        let (agent, transport) = makeCapturingAgent { config in
            config.systemPrompt = "Be concise."
        }
        let stream = agent.sendMessage("Hi", includeSystemPrompt: true)
        for try await _ in stream {}

        let captured1 = await transport.capturedInputs
        let input = try XCTUnwrap(captured1.first)
        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].role, .system)
        XCTAssertEqual((input.messages[0] as? SystemMessage)?.content, "Be concise.")
        XCTAssertEqual(input.messages[1].role, .user)
    }

    func testSendMessageOmitsSystemPromptWhenDisabled() async throws {
        let (agent, transport) = makeCapturingAgent { config in
            config.systemPrompt = "Be concise."
        }
        let stream = agent.sendMessage("Hi", includeSystemPrompt: false)
        for try await _ in stream {}

        let captured2 = await transport.capturedInputs
        let input = try XCTUnwrap(captured2.first)
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].role, .user)
    }

    func testSendMessageUsesProvidedThreadId() async throws {
        let (agent, transport) = makeCapturingAgent()
        let stream = agent.sendMessage("Hello", threadId: "my-thread")
        for try await _ in stream {}

        let captured3 = await transport.capturedInputs
        let input = try XCTUnwrap(captured3.first)
        XCTAssertEqual(input.threadId, "my-thread")
    }

    func testSendMessageUsesProvidedState() async throws {
        let customState = Data("{\"mode\":\"test\"}".utf8)
        let (agent, transport) = makeCapturingAgent()
        let stream = agent.sendMessage("Hello", state: customState)
        for try await _ in stream {}

        let captured4 = await transport.capturedInputs
        let input = try XCTUnwrap(captured4.first)
        XCTAssertEqual(input.state, customState)
    }

    func testSendMessageEachCallIsFreshNoHistory() async throws {
        let (agent, transport) = makeCapturingAgent()

        for try await _ in agent.sendMessage("Message 1") {}
        for try await _ in agent.sendMessage("Message 2") {}

        let capturedAll = await transport.capturedInputs
        XCTAssertEqual(capturedAll.count, 2)

        let first = capturedAll[0]
        let second = capturedAll[1]

        XCTAssertEqual(first.messages.count, 1)
        XCTAssertEqual((first.messages[0] as? UserMessage)?.content, "Message 1")

        XCTAssertEqual(second.messages.count, 1)
        XCTAssertEqual((second.messages[0] as? UserMessage)?.content, "Message 2")
    }

    // MARK: - Tool registry integration

    func testSendMessageIncludesToolsFromRegistry() async throws {
        let tool1 = Tool(name: "get_weather", description: "Get weather", parameters: Data("{}".utf8))
        let tool2 = Tool(name: "search_web", description: "Search the web", parameters: Data("{}".utf8))
        let registry = MockToolRegistry(tools: [tool1, tool2])

        let (agent, transport) = makeCapturingAgent { config in
            config.toolRegistry = registry
        }

        let stream = agent.sendMessage("What's the weather?")
        for try await _ in stream {}

        let captured5 = await transport.capturedInputs
        let input = try XCTUnwrap(captured5.first)
        XCTAssertEqual(input.tools.count, 2)
        XCTAssertEqual(input.tools[0].name, "get_weather")
        XCTAssertEqual(input.tools[1].name, "search_web")
    }

    func testSendMessageHasEmptyToolsWhenNoRegistry() async throws {
        let (agent, transport) = makeCapturingAgent()
        let stream = agent.sendMessage("Hello")
        for try await _ in stream {}

        let captured6 = await transport.capturedInputs
        let input = try XCTUnwrap(captured6.first)
        XCTAssertTrue(input.tools.isEmpty)
    }

    // MARK: - Context passthrough

    func testSendMessageIncludesContext() async throws {
        let ctx = Context(description: "timezone", value: "America/New_York")
        let (agent, transport) = makeCapturingAgent { config in
            config.context = [ctx]
        }
        let stream = agent.sendMessage("What time is it?")
        for try await _ in stream {}

        let captured7 = await transport.capturedInputs
        let input = try XCTUnwrap(captured7.first)
        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.context[0].description, "timezone")
    }

    // MARK: - Event passthrough

    func testSendMessageYieldsEventsFromRun() async throws {
        let (agent, transport) = makeCapturingAgent()
        await transport.setMockEvents([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        var received: [any AGUIEvent] = []
        for try await event in agent.sendMessage("Hi") {
            received.append(event)
        }

        XCTAssertEqual(received.count, 2)
        XCTAssertTrue(received[0] is RunStartedEvent)
        XCTAssertTrue(received[1] is RunFinishedEvent)
    }

    // MARK: - threadId stability (Issue 25)

    func test_sendMessage_defaultThreadId_isStableAcrossCalls() async throws {
        // Two consecutive calls with no explicit threadId must share the same ID.
        // This fails before the fix because UUID().uuidString is evaluated fresh each call.
        let (agent, transport) = makeCapturingAgent()

        for try await _ in agent.sendMessage("First") {}
        for try await _ in agent.sendMessage("Second") {}

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs.count, 2)
        XCTAssertEqual(inputs[0].threadId, inputs[1].threadId,
                       "Expected stable threadId across calls, got '\(inputs[0].threadId)' and '\(inputs[1].threadId)'")
    }

    func test_sendMessage_explicitThreadId_overridesAgentDefault() async throws {
        // Explicit threadId must be honoured; the following un-keyed call uses the stable default.
        let (agent, transport) = makeCapturingAgent()

        for try await _ in agent.sendMessage("Hi", threadId: "explicit-thread") {}
        for try await _ in agent.sendMessage("Again") {}

        let inputs = await transport.capturedInputs
        XCTAssertEqual(inputs[0].threadId, "explicit-thread")
        XCTAssertNotEqual(inputs[1].threadId, "explicit-thread")
    }

    func test_sendMessage_twoAgentInstances_haveIndependentDefaultThreadIds() async throws {
        // Two independent agent instances must not share thread IDs.
        let (agent1, transport1) = makeCapturingAgent()
        let (agent2, transport2) = makeCapturingAgent()

        for try await _ in agent1.sendMessage("Hi") {}
        for try await _ in agent2.sendMessage("Hi") {}

        let id1 = await transport1.capturedInputs.first?.threadId
        let id2 = await transport2.capturedInputs.first?.threadId

        XCTAssertNotNil(id1)
        XCTAssertNotNil(id2)
        XCTAssertNotEqual(id1, id2)
    }

    // MARK: - close()

    func testCloseDoesNotCrash() async {
        let agent = AgUiAgent(url: agentURL)
        await agent.close()
    }

    func testCloseCanBeCalledMultipleTimes() async {
        let agent = AgUiAgent(url: agentURL)
        await agent.close()
        await agent.close()
    }
}
