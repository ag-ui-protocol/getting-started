// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for RunAgentInputBuilder
final class RunAgentInputBuilderTests: XCTestCase {

    // MARK: - Basic Builder Tests

    func testBuilderWithMinimalParameters() throws {
        let input = try RunAgentInput.builder()
            .threadId("thread-123")
            .runId("run-456")
            .build()

        XCTAssertEqual(input.threadId, "thread-123")
        XCTAssertEqual(input.runId, "run-456")
        XCTAssertNil(input.parentRunId)
        XCTAssertTrue(input.messages.isEmpty)
        XCTAssertTrue(input.tools.isEmpty)
        XCTAssertTrue(input.context.isEmpty)
    }

    func testBuilderWithAllParameters() throws {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello")
        ]
        let tools = [
            Tool(name: "tool1", description: "Test tool", parameters: Data("{}".utf8))
        ]
        let contexts = [
            Context(description: "key", value: "val")
        ]
        let state = Data("{\"x\": 1}".utf8)
        let props = Data("{\"y\": 2}".utf8)

        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")
            .parentRunId("run-0")
            .state(state)
            .messages(messages)
            .tools(tools)
            .context(contexts)
            .forwardedProps(props)
            .build()

        XCTAssertEqual(input.threadId, "thread-1")
        XCTAssertEqual(input.runId, "run-1")
        XCTAssertEqual(input.parentRunId, "run-0")
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.state, state)
        XCTAssertEqual(input.forwardedProps, props)
    }

    // MARK: - Fluent Interface Tests

    func testBuilderMethodChaining() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .parentRunId("r0")
            .build()

        XCTAssertEqual(input.threadId, "t1")
        XCTAssertEqual(input.runId, "r1")
        XCTAssertEqual(input.parentRunId, "r0")
    }

    func testBuilderCanBeReused() throws {
        let builder = RunAgentInput.builder()
            .threadId("thread-1")
            .runId("run-1")

        let input1 = try builder.build()
        let input2 = try builder.build()

        XCTAssertEqual(input1.threadId, input2.threadId)
        XCTAssertEqual(input1.runId, input2.runId)
    }

    // MARK: - Message Building Tests

    func testBuilderWithSingleMessage() throws {
        let message = UserMessage(id: "msg-1", content: "Hello")

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .message(message)
            .build()

        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].id, "msg-1")
    }

    func testBuilderWithMultipleMessages() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .message(UserMessage(id: "msg-1", content: "Hello"))
            .message(AssistantMessage(id: "msg-2", content: "Hi"))
            .build()

        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].id, "msg-1")
        XCTAssertEqual(input.messages[1].id, "msg-2")
    }

    func testBuilderWithMessagesArray() throws {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi")
        ]

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .messages(messages)
            .build()

        XCTAssertEqual(input.messages.count, 2)
    }

    func testBuilderCombiningMessageAndMessages() throws {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello")
        ]

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .messages(messages)
            .message(AssistantMessage(id: "msg-2", content: "Hi"))
            .build()

        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].id, "msg-1")
        XCTAssertEqual(input.messages[1].id, "msg-2")
    }

    // MARK: - Tool Building Tests

    func testBuilderWithSingleTool() throws {
        let tool = Tool(name: "get_weather", description: "Get weather", parameters: Data("{}".utf8))

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .tool(tool)
            .build()

        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.tools[0].name, "get_weather")
    }

    func testBuilderWithMultipleTools() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .tool(Tool(name: "tool1", description: "Tool 1", parameters: Data("{}".utf8)))
            .tool(Tool(name: "tool2", description: "Tool 2", parameters: Data("{}".utf8)))
            .build()

        XCTAssertEqual(input.tools.count, 2)
        XCTAssertEqual(input.tools[0].name, "tool1")
        XCTAssertEqual(input.tools[1].name, "tool2")
    }

    // MARK: - Context Building Tests

    func testBuilderWithSingleContext() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .contextItem(Context(description: "user_id", value: "123"))
            .build()

        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.context[0].description, "user_id")
    }

    func testBuilderWithMultipleContextItems() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .contextItem(Context(description: "user_id", value: "123"))
            .contextItem(Context(description: "language", value: "en"))
            .build()

        XCTAssertEqual(input.context.count, 2)
        XCTAssertEqual(input.context[0].description, "user_id")
        XCTAssertEqual(input.context[1].description, "language")
    }

    func testBuilderWithContextArray() throws {
        let contexts = [
            Context(description: "user_id", value: "123"),
            Context(description: "language", value: "en")
        ]

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .context(contexts)
            .build()

        XCTAssertEqual(input.context.count, 2)
    }

    // MARK: - State and Props Tests

    func testBuilderWithJSONState() throws {
        let stateDict: [String: Any] = ["counter": 42, "active": true]
        let stateData = try JSONSerialization.data(withJSONObject: stateDict)

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .state(stateData)
            .build()

        let decoded = try JSONSerialization.jsonObject(with: input.state) as? [String: Any]
        XCTAssertEqual(decoded?["counter"] as? Int, 42)
        XCTAssertEqual(decoded?["active"] as? Bool, true)
    }

    func testBuilderWithForwardedProps() throws {
        let propsDict: [String: Any] = ["custom_field": "value"]
        let propsData = try JSONSerialization.data(withJSONObject: propsDict)

        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .forwardedProps(propsData)
            .build()

        let decoded = try JSONSerialization.jsonObject(with: input.forwardedProps) as? [String: Any]
        XCTAssertEqual(decoded?["custom_field"] as? String, "value")
    }

    // MARK: - Real-world Usage Tests

    func testBuilderForChatConversation() throws {
        let input = try RunAgentInput.builder()
            .threadId("chat-session-123")
            .runId("run-456")
            .message(DeveloperMessage(id: "dev-1", content: "You are helpful"))
            .message(UserMessage(id: "user-1", content: "Hello!"))
            .build()

        XCTAssertEqual(input.threadId, "chat-session-123")
        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].role, .developer)
        XCTAssertEqual(input.messages[1].role, .user)
    }

    func testBuilderForAgentWithTools() throws {
        let weatherTool = Tool(
            name: "get_weather",
            description: "Get current weather",
            parameters: Data("{\"type\": \"object\"}".utf8)
        )

        let input = try RunAgentInput.builder()
            .threadId("agent-thread-1")
            .runId("run-1")
            .message(UserMessage(id: "user-1", content: "What's the weather?"))
            .tool(weatherTool)
            .contextItem(Context(description: "user_location", value: "San Francisco"))
            .build()

        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.messages.count, 1)
    }

    func testBuilderForNestedRun() throws {
        let input = try RunAgentInput.builder()
            .threadId("thread-1")
            .runId("child-run-1")
            .parentRunId("parent-run-1")
            .build()

        XCTAssertEqual(input.parentRunId, "parent-run-1")
    }

    // MARK: - Default Values Tests

    func testBuilderDefaultsAreCorrect() throws {
        let input = try RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")
            .build()

        // Verify defaults match direct initialization
        let direct = RunAgentInput(threadId: "t1", runId: "r1")

        XCTAssertEqual(input.threadId, direct.threadId)
        XCTAssertEqual(input.runId, direct.runId)
        XCTAssertEqual(input.parentRunId, direct.parentRunId)
        XCTAssertEqual(input.state, direct.state)
        XCTAssertEqual(input.forwardedProps, direct.forwardedProps)
        XCTAssertEqual(input.messages.count, direct.messages.count)
        XCTAssertEqual(input.tools.count, direct.tools.count)
        XCTAssertEqual(input.context.count, direct.context.count)
    }

    // MARK: - Resume Tests

    func test_builder_withResume_setsResumeField() throws {
        let entries = [
            ResumeEntry(interruptId: "int-1", status: .resolved),
            ResumeEntry(interruptId: "int-2", status: .cancelled)
        ]

        let input = try RunAgentInput.builder()
            .threadId("t")
            .runId("r")
            .resume(entries)
            .build()

        XCTAssertEqual(input.resume?.count, 2)
        XCTAssertEqual(input.resume?[0].interruptId, "int-1")
        XCTAssertEqual(input.resume?[1].interruptId, "int-2")
    }

    func test_builder_withoutResume_resumeIsNil() throws {
        let input = try RunAgentInput.builder()
            .threadId("t")
            .runId("r")
            .build()

        XCTAssertNil(input.resume)
    }

    // MARK: - Sendable Tests

    func testBuilderIsSendable() {
        let builder = RunAgentInput.builder()
            .threadId("t1")
            .runId("r1")

        Task {
            let capturedBuilder = builder
            let input = try capturedBuilder.build()
            XCTAssertEqual(input.threadId, "t1")
        }
    }
}
