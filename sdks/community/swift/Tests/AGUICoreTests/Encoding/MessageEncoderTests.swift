// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class MessageEncoderTests: XCTestCase {

    private let encoder = MessageEncoder()

    // MARK: - Helper

    private func json(from message: any Message) throws -> [String: Any] {
        let data = try encoder.encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Feature: DeveloperMessage encoding

    func test_encodeDeveloperMessage_producesCorrectJSON() throws {
        // Given
        let message = DeveloperMessage(id: "dev-1", content: "Enable debug logging.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "dev-1")
        XCTAssertEqual(json["role"] as? String, "developer")
        XCTAssertEqual(json["content"] as? String, "Enable debug logging.")
    }

    func test_encodeDeveloperMessage_withName_includesName() throws {
        // Given
        let message = DeveloperMessage(id: "dev-2", content: "Config.", name: "SystemConfigurator")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["name"] as? String, "SystemConfigurator")
    }

    func test_encodeDeveloperMessage_withoutName_omitsName() throws {
        // Given
        let message = DeveloperMessage(id: "dev-3", content: "Config.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    // MARK: - Feature: SystemMessage encoding

    func test_encodeSystemMessage_producesCorrectJSON() throws {
        // Given
        let message = SystemMessage(id: "sys-1", content: "You are a helpful assistant.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "sys-1")
        XCTAssertEqual(json["role"] as? String, "system")
        XCTAssertEqual(json["content"] as? String, "You are a helpful assistant.")
    }

    func test_encodeSystemMessage_emptyContent_includedInJSON() throws {
        // Given — content defaults to "" when omitted
        let message = SystemMessage(id: "sys-2")

        // When
        let json = try json(from: message)

        // Then: content is always included (non-optional String)
        XCTAssertEqual(json["content"] as? String, "")
    }

    func test_encodeSystemMessage_withName_includesName() throws {
        // Given
        let message = SystemMessage(id: "sys-3", content: "Act professionally.", name: "ProfMode")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["name"] as? String, "ProfMode")
    }

    func test_encodeSystemMessage_withoutName_omitsName() throws {
        // Given
        let message = SystemMessage(id: "sys-4", content: "Act professionally.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    // MARK: - Feature: UserMessage encoding

    func test_encodeUserMessage_textOnly_producesCorrectJSON() throws {
        // Given
        let message = UserMessage(id: "user-1", content: "Hello!")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "user-1")
        XCTAssertEqual(json["role"] as? String, "user")
        XCTAssertEqual(json["content"] as? String, "Hello!")
    }

    func test_encodeUserMessage_withName_includesName() throws {
        // Given
        let message = UserMessage(id: "user-2", content: "Hi", name: "Alice")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["name"] as? String, "Alice")
    }

    func test_encodeUserMessage_withoutName_omitsName() throws {
        // Given
        let message = UserMessage(id: "user-3", content: "Hi")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    func test_encodeUserMessage_multimodal_contentIsArray() throws {
        // Given: multimodal message with a single text part
        let message = UserMessage.multimodal(
            id: "user-4",
            parts: [TextInputContent(text: "What's in this image?")]
        )

        // When
        let json = try json(from: message)

        // Then: content must be a JSON array, not a string
        let contentArray = try XCTUnwrap(json["content"] as? [[String: Any]])
        XCTAssertEqual(contentArray.count, 1)
        XCTAssertEqual(contentArray[0]["type"] as? String, "text")
        XCTAssertEqual(contentArray[0]["text"] as? String, "What's in this image?")
    }

    // MARK: - Feature: AssistantMessage encoding

    func test_encodeAssistantMessage_producesCorrectJSON() throws {
        // Given
        let message = AssistantMessage(id: "asst-1", content: "I can help with that.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "asst-1")
        XCTAssertEqual(json["role"] as? String, "assistant")
        XCTAssertEqual(json["content"] as? String, "I can help with that.")
    }

    func test_encodeAssistantMessage_nilContent_omittedFromJSON() throws {
        // Given
        let message = AssistantMessage(id: "asst-2", content: nil)

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["content"])
    }

    func test_encodeAssistantMessage_nilToolCalls_omittedFromJSON() throws {
        // Given
        let message = AssistantMessage(id: "asst-3", content: "Text only")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["toolCalls"])
    }

    func test_encodeAssistantMessage_withToolCalls_encodesToolCallsArray() throws {
        // Given
        let toolCall = ToolCall(
            id: "call-1",
            function: FunctionCall(name: "get_weather", arguments: "{\"city\":\"NYC\"}")
        )
        let message = AssistantMessage(id: "asst-4", toolCalls: [toolCall])

        // When
        let json = try json(from: message)

        // Then: tool calls encoded as array with id and function fields
        let toolCallsArray = try XCTUnwrap(json["toolCalls"] as? [[String: Any]])
        XCTAssertEqual(toolCallsArray.count, 1)
        XCTAssertEqual(toolCallsArray[0]["id"] as? String, "call-1")
        let function = try XCTUnwrap(toolCallsArray[0]["function"] as? [String: Any])
        XCTAssertEqual(function["name"] as? String, "get_weather")
        XCTAssertEqual(function["arguments"] as? String, "{\"city\":\"NYC\"}")
    }

    func test_encodeAssistantMessage_withName_includesName() throws {
        // Given
        let message = AssistantMessage(id: "asst-5", content: "Hi", name: "Claude")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["name"] as? String, "Claude")
    }

    func test_encodeAssistantMessage_withoutName_omitsName() throws {
        // Given
        let message = AssistantMessage(id: "asst-6", content: "Hi")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    // MARK: - Feature: ToolMessage encoding

    func test_encodeToolMessage_producesCorrectJSON() throws {
        // Given
        let message = ToolMessage(id: "tool-1", content: "72°F, sunny", toolCallId: "call-1")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "tool-1")
        XCTAssertEqual(json["role"] as? String, "tool")
        XCTAssertEqual(json["toolCallId"] as? String, "call-1")
        XCTAssertEqual(json["content"] as? String, "72°F, sunny")
    }

    func test_encodeToolMessage_withError_includesError() throws {
        // Given
        let message = ToolMessage(
            id: "tool-2",
            content: "Failed",
            toolCallId: "call-2",
            error: "Connection timeout"
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["error"] as? String, "Connection timeout")
    }

    func test_encodeToolMessage_withoutError_omitsError() throws {
        // Given
        let message = ToolMessage(id: "tool-3", content: "OK", toolCallId: "call-3")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["error"])
    }

    func test_encodeToolMessage_withName_includesName() throws {
        // Given
        let message = ToolMessage(
            id: "tool-4",
            content: "Result",
            toolCallId: "call-4",
            name: "weather_tool"
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["name"] as? String, "weather_tool")
    }

    func test_encodeToolMessage_withoutName_omitsName() throws {
        // Given
        let message = ToolMessage(id: "tool-5", content: "Result", toolCallId: "call-5")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    // MARK: - Feature: ActivityMessage encoding

    func test_encodeActivityMessage_producesCorrectJSON() throws {
        // Given
        let message = ActivityMessage(
            id: "act-1",
            activityType: "progress",
            content: Data("{\"percent\":75}".utf8)
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "act-1")
        XCTAssertEqual(json["role"] as? String, "activity")
        XCTAssertEqual(json["activityType"] as? String, "progress")
    }

    func test_encodeActivityMessage_contentEmbeddedAsJsonObject() throws {
        // Given: content must be inlined as a JSON object, not base64-encoded
        let message = ActivityMessage(
            id: "act-2",
            activityType: "progress",
            content: Data("{\"percent\":75,\"message\":\"Uploading\"}".utf8)
        )

        // When
        let json = try json(from: message)

        // Then: content key holds a dictionary, not a Data blob
        let content = try XCTUnwrap(json["content"] as? [String: Any])
        XCTAssertEqual(content["percent"] as? Int, 75)
        XCTAssertEqual(content["message"] as? String, "Uploading")
    }

    func test_encodeActivityMessage_nameAlwaysOmitted() throws {
        // Given: ActivityMessage.name is always nil per protocol
        let message = ActivityMessage(
            id: "act-3",
            activityType: "status",
            content: Data("{}".utf8)
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    func test_encodeActivityMessage_encryptedValueAlwaysOmitted() throws {
        // Given: ActivityMessage.encryptedValue is always nil per protocol
        let message = ActivityMessage(
            id: "act-4",
            activityType: "status",
            content: Data("{}".utf8)
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["encryptedValue"])
    }

    // MARK: - Feature: ReasoningMessage encoding

    func test_encodeReasoningMessage_producesCorrectJSON() throws {
        // Given
        let message = ReasoningMessage(id: "reasoning-1", content: "Let me think step by step.")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["id"] as? String, "reasoning-1")
        XCTAssertEqual(json["role"] as? String, "reasoning")
        XCTAssertEqual(json["content"] as? String, "Let me think step by step.")
    }

    func test_encodeReasoningMessage_withEncryptedValue() throws {
        // Given
        let message = ReasoningMessage(
            id: "reasoning-2",
            content: "Analysing inputs...",
            encryptedValue: "enc-token-abc"
        )

        // When
        let json = try json(from: message)

        // Then
        XCTAssertEqual(json["encryptedValue"] as? String, "enc-token-abc")
    }

    func test_encodeReasoningMessage_nameAlwaysOmitted() throws {
        // Given: ReasoningMessage.name is always nil per protocol spec
        let message = ReasoningMessage(id: "reasoning-3", content: "Reasoning...")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["name"])
    }

    func test_encodeReasoningMessage_nilEncryptedValue_omittedFromJSON() throws {
        // Given
        let message = ReasoningMessage(id: "reasoning-4", content: "Thinking...")

        // When
        let json = try json(from: message)

        // Then
        XCTAssertNil(json["encryptedValue"])
    }

    // MARK: - Feature: Error handling

    func test_unsupportedRole_throws() {
        // Given: registry with no handlers guarantees an unsupported role error
        let emptyEncoder = MessageEncoder(registry: [:])
        let message = ReasoningMessage(id: "r-1", content: "test")

        // When / Then
        XCTAssertThrowsError(try emptyEncoder.encode(message)) { error in
            guard case MessageEncodingError.unsupportedRole(let role) = error else {
                return XCTFail("Expected unsupportedRole, got \(error)")
            }
            XCTAssertEqual(role, .reasoning)
        }
    }

    func test_invalidMessageType_throws() {
        // Given: route .user role through the .system handler → type mismatch at cast site
        let registry: [Role: MessageEncoder.EncodeHandler] = [
            .user: MessageEncoder.defaultRegistry()[.system]!
        ]
        let mismatchedEncoder = MessageEncoder(registry: registry)
        let message = UserMessage(id: "u-1", content: "Hello")

        // When / Then
        XCTAssertThrowsError(try mismatchedEncoder.encode(message)) { error in
            guard case MessageEncodingError.invalidMessageType(let role, _) = error else {
                return XCTFail("Expected invalidMessageType, got \(error)")
            }
            XCTAssertEqual(role, .system)
        }
    }
}
