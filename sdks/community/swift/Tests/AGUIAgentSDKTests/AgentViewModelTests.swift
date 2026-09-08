// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

// AgentViewModel requires iOS 17 / macOS 14 (Observation framework).
// Tests are gated by the same availability so the suite stays green on older OS.
#if canImport(Observation)

import AGUICore
import XCTest
@testable import AGUIAgentSDK

@available(iOS 17, macOS 14, tvOS 17, watchOS 10, *)
@MainActor
final class AgentViewModelTests: XCTestCase {

    private var mock: MockChatAgent!
    private var sut: AgentViewModel!

    override func setUp() {
        super.setUp()
        mock = MockChatAgent()
        sut = AgentViewModel(agent: mock, threadId: "test-thread")
    }

    override func tearDown() {
        sut = nil
        mock = nil
        super.tearDown()
    }

    // MARK: - Initial state

    func testInitialState_isClean() {
        XCTAssertTrue(sut.messages.isEmpty)
        XCTAssertFalse(sut.isRunning)
        XCTAssertNil(sut.lastError)
        XCTAssertEqual(sut.threadId, "test-thread")
    }

    // MARK: - send() — user message

    func testSend_appendsUserMessageImmediately() async {
        await sut.send("Hello!")
        let userMessages = sut.messages.filter { $0.role == .user }
        XCTAssertEqual(userMessages.count, 1)
        XCTAssertEqual(userMessages[0].content, "Hello!")
    }

    func testSend_passesCorrectParametersToAgent() async {
        await sut.send("What is Swift?")
        XCTAssertEqual(mock.chatCalls.count, 1)
        XCTAssertEqual(mock.chatCalls[0].message, "What is Swift?")
        XCTAssertEqual(mock.chatCalls[0].threadId, "test-thread")
    }

    func testSend_isRunningFalseAfterStreamFinishes() async {
        await sut.send("Hi")
        XCTAssertFalse(sut.isRunning)
    }

    func testSend_clearsLastErrorAtStart() async {
        mock.streamThrows = URLError(.timedOut)
        await sut.send("First")
        XCTAssertNotNil(sut.lastError)

        mock.streamThrows = nil
        await sut.send("Second")
        XCTAssertNil(sut.lastError)
    }

    // MARK: - send() — assistant message

    func testSend_appendsAssistantMessageOnTextMessageStart() async {
        mock.eventsToYield = [
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageEndEvent(messageId: "msg1"),
        ]
        await sut.send("Hi")
        let assistants = sut.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.count, 1)
    }

    func testSend_accumulatesContentDeltas() async {
        mock.eventsToYield = [
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageContentEvent(messageId: "msg1", delta: ", "),
            TextMessageContentEvent(messageId: "msg1", delta: "world!"),
            TextMessageEndEvent(messageId: "msg1"),
        ]
        await sut.send("Hi")
        let assistant = sut.messages.first(where: { $0.role == .assistant })
        XCTAssertEqual(assistant?.content, "Hello, world!")
    }

    func testSend_preservesAssistantMessageIdAcrossDeltas() async {
        mock.eventsToYield = [
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "A"),
            TextMessageContentEvent(messageId: "msg1", delta: "B"),
        ]
        await sut.send("Hi")
        let assistants = sut.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.count, 1, "Deltas must update the same message, not append new ones")
        XCTAssertFalse(assistants[0].id.isEmpty)
    }

    func testSend_handlesMultipleAssistantMessages() async {
        mock.eventsToYield = [
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "First"),
            TextMessageEndEvent(messageId: "msg1"),
            TextMessageStartEvent(messageId: "msg2"),
            TextMessageContentEvent(messageId: "msg2", delta: "Second"),
            TextMessageEndEvent(messageId: "msg2"),
        ]
        await sut.send("Hi")
        let assistants = sut.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistants.count, 2)
        XCTAssertEqual(assistants[0].content, "First")
        XCTAssertEqual(assistants[1].content, "Second")
    }

    // MARK: - send() — error paths

    func testSend_setsLastErrorOnRunErrorEvent() async {
        mock.eventsToYield = [
            RunErrorEvent(message: "Agent unavailable", code: "ERR_503"),
        ]
        await sut.send("Hi")
        let agentError = sut.lastError as? AgentError
        XCTAssertNotNil(agentError)
        if case .runError(let msg, let code) = agentError {
            XCTAssertEqual(msg, "Agent unavailable")
            XCTAssertEqual(code, "ERR_503")
        } else {
            XCTFail("Expected AgentError.runError")
        }
    }

    func testSend_setsLastErrorWhenStreamThrows() async {
        mock.streamThrows = URLError(.notConnectedToInternet)
        await sut.send("Hi")
        XCTAssertNotNil(sut.lastError)
        XCTAssertFalse(sut.isRunning)
    }

    func testSend_setsLastErrorWhenChatThrows() async {
        mock.chatThrows = URLError(.timedOut)
        await sut.send("Hi")
        XCTAssertNotNil(sut.lastError)
        XCTAssertFalse(sut.isRunning)
    }

    // MARK: - clear()

    func testClear_emptiesMessages() async {
        await sut.send("Hello")
        XCTAssertFalse(sut.messages.isEmpty)

        await sut.clear()
        XCTAssertTrue(sut.messages.isEmpty)
    }

    func testClear_callsAgentClearHistoryWithThreadId() async {
        await sut.clear()
        XCTAssertEqual(mock.clearCalls.count, 1)
        XCTAssertEqual(mock.clearCalls[0], "test-thread")
    }
}

#endif
