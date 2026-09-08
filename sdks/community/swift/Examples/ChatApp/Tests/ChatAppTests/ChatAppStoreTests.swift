// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import XCTest
@testable import ChatApp

@MainActor
final class ChatAppStoreTests: XCTestCase {

    // MARK: - Helpers

    private func makeStore() -> ChatAppStore {
        // Use an isolated UserDefaults suite so tests don't share persisted state.
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        return ChatAppStore(defaults: defaults)
    }

    private func testConfig() -> AgentConfig {
        AgentConfig(name: "TestAgent", url: "https://test.local")
    }

    // MARK: - Text message streaming

    func test_streamingMessageReconstruction() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(TextMessageStartEvent(messageId: "msg1", role: "assistant"))
        store.processEvent(TextMessageContentEvent(messageId: "msg1", delta: "Hello"))
        store.processEvent(TextMessageContentEvent(messageId: "msg1", delta: ", world"))
        store.processEvent(TextMessageEndEvent(messageId: "msg1"))

        XCTAssertEqual(store.state.messages.count, 1)
        let msg = store.state.messages[0]
        XCTAssertEqual(msg.content, "Hello, world")
        XCTAssertFalse(msg.isStreaming)
        XCTAssertEqual(msg.role, .assistant)
    }

    func test_multipleStreamingMessages() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(TextMessageStartEvent(messageId: "a", role: "assistant"))
        store.processEvent(TextMessageContentEvent(messageId: "a", delta: "First"))
        store.processEvent(TextMessageEndEvent(messageId: "a"))

        store.processEvent(TextMessageStartEvent(messageId: "b", role: "assistant"))
        store.processEvent(TextMessageContentEvent(messageId: "b", delta: "Second"))
        store.processEvent(TextMessageEndEvent(messageId: "b"))

        XCTAssertEqual(store.state.messages.count, 2)
        XCTAssertEqual(store.state.messages[0].content, "First")
        XCTAssertEqual(store.state.messages[1].content, "Second")
    }

    func test_streamingIndicator_clears_onEnd() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(TextMessageStartEvent(messageId: "m1", role: "assistant"))
        XCTAssertTrue(store.state.messages.last?.isStreaming == true)

        store.processEvent(TextMessageEndEvent(messageId: "m1"))
        XCTAssertFalse(store.state.messages.last?.isStreaming == true)
    }

    // MARK: - Phase 1A: Tool call ephemeral banner (.toolCall slot)

    func test_toolCallStart_setsToolCallEphemeralSlot() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "web_search"))

        let banner = store.state.ephemeralSlots[.toolCall]
        XCTAssertNotNil(banner)
        XCTAssertEqual(banner?.content, "Calling web_search…")
        if case .toolCall(let name) = banner?.role {
            XCTAssertEqual(name, "web_search")
        } else {
            XCTFail("Expected .toolCall role")
        }
    }

    func test_toolCallEnd_schedulesEphemeralDismissal() async throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())
        // Inject a short delay so the test doesn't wait the production 1 second.
        store.ephemeralDismissDelayOverrides[.toolCall] = .milliseconds(50)

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        XCTAssertNotNil(store.state.ephemeralSlots[.toolCall])

        store.processEvent(ToolCallEndEvent(toolCallId: "tc1"))

        // Wait long enough for the injected 50ms delay to fire.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(store.state.ephemeralSlots[.toolCall])
    }

    // MARK: - Phase 1A: Step ephemeral banner (.step slot)

    func test_stepStarted_setsStepEphemeralSlot() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(StepStartedEvent(stepName: "Reasoning"))

        let banner = store.state.ephemeralSlots[.step]
        XCTAssertNotNil(banner)
        XCTAssertEqual(banner?.content, "Reasoning")
        if case .stepInfo(let name) = banner?.role {
            XCTAssertEqual(name, "Reasoning")
        } else {
            XCTFail("Expected .stepInfo role")
        }
    }

    func test_stepFinished_clearsStepSlotImmediately() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(StepStartedEvent(stepName: "Reasoning"))
        XCTAssertNotNil(store.state.ephemeralSlots[.step])

        store.processEvent(StepFinishedEvent(stepName: "Reasoning"))

        XCTAssertNil(store.state.ephemeralSlots[.step])
    }

    func test_stepFinished_doesNotClearToolCallSlot() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        store.processEvent(StepStartedEvent(stepName: "Reasoning"))
        store.processEvent(StepFinishedEvent(stepName: "Reasoning"))

        // .toolCall slot must survive .step dismissal
        XCTAssertNotNil(store.state.ephemeralSlots[.toolCall])
        XCTAssertNil(store.state.ephemeralSlots[.step])
    }

    func test_bothEphemeralSlotsCoexist() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(StepStartedEvent(stepName: "Reasoning"))
        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))

        XCTAssertNotNil(store.state.ephemeralSlots[.step])
        XCTAssertNotNil(store.state.ephemeralSlots[.toolCall])
        XCTAssertEqual(store.state.ephemeralSlots.count, 2)
    }

    func test_newToolCall_replacesExistingToolCallSlot() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        store.processEvent(ToolCallStartEvent(toolCallId: "tc2", toolCallName: "calculator"))

        let banner = store.state.ephemeralSlots[.toolCall]
        // The second call replaces the first in the slot
        XCTAssertEqual(banner?.content, "Calling calculator…")
    }

    // MARK: - Run error

    func test_runError_setsErrorState() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(RunErrorEvent(message: "Request timed out", code: "TIMEOUT"))

        XCTAssertEqual(store.state.error, "Request timed out")
    }

    func test_dismissError_clearsError() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())
        store.processEvent(RunErrorEvent(message: "boom", code: "ERR"))

        store.dismissError()

        XCTAssertNil(store.state.error)
    }

    // MARK: - Phase 1B: Supplemental messages

    func test_buildAgent_appendsConnectionSupplemental() {
        let store = makeStore()
        store.presentCreateAgent()
        store.draft.name = "TestAgent"
        store.draft.url = "https://test.local"
        store.saveAgent()

        XCTAssertFalse(store.state.supplementalMessages.isEmpty)
        if case .connection(let name) = store.state.supplementalMessages.first?.kind {
            XCTAssertEqual(name, "TestAgent")
        } else {
            XCTFail("Expected .connection supplemental message")
        }
    }

    func test_runError_appendsInlineError() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())
        let initialCount = store.state.supplementalMessages.count

        store.processEvent(RunErrorEvent(message: "Network failed", code: "ERR"))

        XCTAssertEqual(store.state.supplementalMessages.count, initialCount + 1)
        if case .error(let msg) = store.state.supplementalMessages.last?.kind {
            XCTAssertEqual(msg, "Network failed")
        } else {
            XCTFail("Expected .error supplemental message")
        }
    }

    func test_chatRows_includesAgentMessages() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(TextMessageStartEvent(messageId: "m1", role: "assistant"))
        store.processEvent(TextMessageEndEvent(messageId: "m1"))

        let rows = store.state.chatRows
        XCTAssertFalse(rows.isEmpty)
        let hasAgentRow = rows.contains { if case .agent = $0 { return true }; return false }
        XCTAssertTrue(hasAgentRow)
    }

    func test_chatRows_mergesAgentAndSupplementalByTimestamp() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        // Add a supplemental message
        store.processEvent(RunErrorEvent(message: "Oops", code: "ERR"))
        // Add an agent message after
        store.processEvent(TextMessageStartEvent(messageId: "m1", role: "assistant"))
        store.processEvent(TextMessageEndEvent(messageId: "m1"))

        let rows = store.state.chatRows
        // Both rows should be present
        let agentRows = rows.filter { if case .agent = $0 { return true }; return false }
        let suppRows = rows.filter { if case .supplemental = $0 { return true }; return false }
        XCTAssertEqual(agentRows.count, 1)
        XCTAssertEqual(suppRows.count, 1)
    }

    // MARK: - Background hex (custom event)

    func test_changeBackgroundCustomEvent_setsHex() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        let payload = try JSONSerialization.data(withJSONObject: ["hex": "FF5733"])
        store.processEvent(CustomEvent(name: "change_background", value: payload))

        XCTAssertEqual(store.state.backgroundHex, "FF5733")
    }

    // MARK: - Phase 1C: Optimistic user messages

    func test_displayMessage_isSendingDefaultsFalse() {
        let msg = DisplayMessage(role: .user, content: "Hello")
        XCTAssertFalse(msg.isSending)
    }

    func test_displayMessage_isSendingCanBeSet() {
        let msg = DisplayMessage(role: .user, content: "Hello", isSending: true)
        XCTAssertTrue(msg.isSending)
    }

    func test_injectPendingMessage_appearsInMessages() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.injectPendingMessageForTesting(content: "Hello!")

        let pending = store.state.messages.last
        XCTAssertNotNil(pending)
        XCTAssertTrue(pending?.isSending == true)
        XCTAssertEqual(pending?.content, "Hello!")
        XCTAssertEqual(pending?.role, .user)
    }

    func test_messagesSnapshot_correlatesAndClearsPending() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())
        store.injectPendingMessageForTesting(content: "Hello!")

        XCTAssertNotNil(store.pendingUserMessageId)

        // Simulate the agent echoing the message in a snapshot
        let snapshotData = try JSONSerialization.data(withJSONObject: [
            ["id": "server-msg-1", "role": "user", "content": "Hello!"],
        ])
        store.processEvent(MessagesSnapshotEvent(messages: snapshotData))

        // Pending should be cleared once the content is found in the snapshot
        XCTAssertNil(store.pendingUserMessageId)
        XCTAssertFalse(store.state.messages.isEmpty)
    }

    func test_messagesSnapshot_reinjectsPendingIfNotFound() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())
        store.injectPendingMessageForTesting(content: "Pending message")

        // Snapshot that does NOT include the pending message
        let snapshotData = try JSONSerialization.data(withJSONObject: [
            ["id": "server-msg-1", "role": "assistant", "content": "I am processing"],
        ])
        store.processEvent(MessagesSnapshotEvent(messages: snapshotData))

        // Pending must still be in the message list
        XCTAssertNotNil(store.pendingUserMessageId)
        let pendingMsg = store.state.messages.first { $0.role == .user }
        XCTAssertNotNil(pendingMsg)
        XCTAssertTrue(pendingMsg?.isSending == true)
    }

    // MARK: - Phase 2A: ToolCallArgsEvent — args preview in ephemeral slot

    func test_toolCallArgs_updatesEphemeralContent() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"query\":\"swift\"}"))

        let banner = store.state.ephemeralSlots[.toolCall]
        XCTAssertNotNil(banner)
        XCTAssertEqual(banner?.content, "{\"query\":\"swift\"}")
    }

    func test_toolCallArgs_multipleDeltas_concatenate() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"query\":"))
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: "\"swift\""))
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: "}"))

        let banner = store.state.ephemeralSlots[.toolCall]
        XCTAssertEqual(banner?.content, "{\"query\":\"swift\"}")
    }

    func test_toolCallArgs_truncatesAt80Chars() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        let longArgs = String(repeating: "x", count: 90)
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: longArgs))

        let banner = store.state.ephemeralSlots[.toolCall]
        XCTAssertEqual(banner?.content, String(repeating: "x", count: 80) + "…")
    }

    func test_toolCallEnd_clearsArgBuffer() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        store.processEvent(ToolCallStartEvent(toolCallId: "tc1", toolCallName: "search"))
        store.processEvent(ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"query\":\"test\"}"))

        XCTAssertNotNil(store.toolCallArgBuffer["tc1"])

        store.processEvent(ToolCallEndEvent(toolCallId: "tc1"))

        XCTAssertNil(store.toolCallArgBuffer["tc1"])
    }

    // MARK: - Phase 3A: DisplayMessage animation state helpers

    func test_showsTypingIndicator_trueWhenStreamingWithEmptyContent() {
        let msg = DisplayMessage(role: .assistant, content: "", isStreaming: true)
        XCTAssertTrue(msg.showsTypingIndicator)
    }

    func test_showsTypingIndicator_falseWhenNotStreaming() {
        let msg = DisplayMessage(role: .assistant, content: "", isStreaming: false)
        XCTAssertFalse(msg.showsTypingIndicator)
    }

    func test_showsTypingIndicator_falseWhenStreamingWithContent() {
        let msg = DisplayMessage(role: .assistant, content: "Hello", isStreaming: true)
        XCTAssertFalse(msg.showsTypingIndicator)
    }

    func test_showsStreamingCursor_trueWhenStreamingWithContent() {
        let msg = DisplayMessage(role: .assistant, content: "Hello", isStreaming: true)
        XCTAssertTrue(msg.showsStreamingCursor)
    }

    func test_showsStreamingCursor_falseWhenNotStreaming() {
        let msg = DisplayMessage(role: .assistant, content: "Hello", isStreaming: false)
        XCTAssertFalse(msg.showsStreamingCursor)
    }

    func test_showsStreamingCursor_falseWhenEmptyContent() {
        let msg = DisplayMessage(role: .assistant, content: "", isStreaming: true)
        XCTAssertFalse(msg.showsStreamingCursor)
    }

    func test_streamingMessage_transitionsFromTypingToCursor() {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        // On TextMessageStart, message has empty content → typing indicator
        store.processEvent(TextMessageStartEvent(messageId: "m1", role: "assistant"))
        let streaming = store.state.messages.last
        XCTAssertTrue(streaming?.showsTypingIndicator == true)
        XCTAssertFalse(streaming?.showsStreamingCursor == true)

        // After first content delta → cursor indicator
        store.processEvent(TextMessageContentEvent(messageId: "m1", delta: "Hi"))
        let withContent = store.state.messages.last
        XCTAssertFalse(withContent?.showsTypingIndicator == true)
        XCTAssertTrue(withContent?.showsStreamingCursor == true)

        // After TextMessageEnd → no animation state
        store.processEvent(TextMessageEndEvent(messageId: "m1"))
        let finished = store.state.messages.last
        XCTAssertFalse(finished?.showsTypingIndicator == true)
        XCTAssertFalse(finished?.showsStreamingCursor == true)
    }

    // MARK: - Agent lifecycle

    func test_presentCreateAgent_setsDraft() {
        let store = makeStore()
        store.presentCreateAgent()

        XCTAssertEqual(store.formMode, .create)
        XCTAssertTrue(store.draft.name.isEmpty)
    }

    func test_saveAgent_appendsToList() {
        let store = makeStore()
        store.presentCreateAgent()
        store.draft.name = "My Agent"
        store.draft.url = "https://agent.example.com"

        store.saveAgent()

        XCTAssertEqual(store.agents.count, 1)
        XCTAssertEqual(store.agents[0].name, "My Agent")
        XCTAssertNil(store.formMode)
    }

    func test_deleteAgent_removesFromList() {
        let store = makeStore()
        store.presentCreateAgent()
        store.draft.name = "Agent A"
        store.draft.url = "https://a.example.com"
        store.saveAgent()

        let id = store.agents[0].id
        store.deleteAgent(id: id)

        XCTAssertTrue(store.agents.isEmpty)
    }

    // MARK: - Phase 4: A2UI / Generative UI

    func test_activitySnapshot_insertsA2UIDisplayMessage() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        let content = try JSONSerialization.data(withJSONObject: ["type": "text", "content": "Hello"])
        let event = ActivitySnapshotEvent(messageId: "act1", activityType: "a2ui-surface", content: content)

        store.processEvent(event)

        XCTAssertNotNil(store.state.a2uiSurfaces["act1"])
        XCTAssertTrue(store.state.messages.contains { $0.id == "a2ui-act1" })
        if let msg = store.state.messages.first(where: { $0.id == "a2ui-act1" }) {
            if case .a2uiSurface(let messageId) = msg.role {
                XCTAssertEqual(messageId, "act1")
            } else {
                XCTFail("Expected .a2uiSurface role")
            }
        }
    }

    func test_activityDelta_updatesA2UIState() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        // Snapshot first
        let content = try JSONSerialization.data(withJSONObject: ["type": "text", "content": "Hello"])
        store.processEvent(ActivitySnapshotEvent(messageId: "act1", activityType: "a2ui-surface", content: content))

        // Then delta
        let patch = try JSONSerialization.data(withJSONObject: [["op": "replace", "path": "/content", "value": "World"]])
        store.processEvent(ActivityDeltaEvent(messageId: "act1", activityType: "a2ui-surface", patch: patch))

        let updatedData = try XCTUnwrap(store.state.a2uiSurfaces["act1"])
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: updatedData) as? [String: Any])
        XCTAssertEqual(dict["content"] as? String, "World")
    }

    func test_activitySnapshot_ignoredForNonA2UISurface() throws {
        let store = makeStore()
        store.setupForTesting(agent: testConfig())

        let content = try JSONSerialization.data(withJSONObject: ["data": "whatever"])
        store.processEvent(ActivitySnapshotEvent(messageId: "act1", activityType: "some-other-type", content: content))

        // Non-a2ui-surface activity types should not create A2UI messages
        XCTAssertNil(store.state.a2uiSurfaces["act1"])
        XCTAssertFalse(store.state.messages.contains { $0.id == "a2ui-act1" })
    }
}
