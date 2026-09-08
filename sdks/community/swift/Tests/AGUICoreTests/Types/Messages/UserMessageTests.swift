// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the UserMessage type
final class UserMessageTests: XCTestCase {
    // MARK: - Text-only Initialization Tests

    func testInitWithTextContent() {
        let message = UserMessage(
            id: "user-1",
            content: "What is the weather like today?"
        )

        XCTAssertEqual(message.id, "user-1")
        XCTAssertEqual(message.content, "What is the weather like today?")
        XCTAssertNil(message.name)
        XCTAssertNil(message.contentParts)
        XCTAssertFalse(message.isMultimodal)
        XCTAssertEqual(message.role, .user)
    }

    func testInitWithTextAndName() {
        let message = UserMessage(
            id: "user-2",
            content: "Hello!",
            name: "Alice"
        )

        XCTAssertEqual(message.id, "user-2")
        XCTAssertEqual(message.content, "Hello!")
        XCTAssertEqual(message.name, "Alice")
        XCTAssertFalse(message.isMultimodal)
    }

    // MARK: - Multimodal Initialization Tests

    func testInitMultimodalWithTextAndImage() {
        let parts: [any InputContent] = [
            TextInputContent(text: "What's in this image?"),
            BinaryInputContent(mimeType: "image/jpeg", url: "https://example.com/photo.jpg")
        ]

        let message = UserMessage.multimodal(
            id: "user-3",
            parts: parts
        )

        XCTAssertEqual(message.id, "user-3")
        XCTAssertEqual(message.content, "") // Empty for multimodal
        XCTAssertTrue(message.isMultimodal)
        XCTAssertEqual(message.contentParts?.count, 2)
    }

    func testInitMultimodalWithName() {
        let parts: [any InputContent] = [
            TextInputContent(text: "Analyze this")
        ]

        let message = UserMessage.multimodal(
            id: "user-4",
            parts: parts,
            name: "Bob"
        )

        XCTAssertEqual(message.name, "Bob")
        XCTAssertTrue(message.isMultimodal)
    }

    func testInitMultimodalWithMultipleParts() {
        let parts: [any InputContent] = [
            TextInputContent(text: "Compare these images:"),
            BinaryInputContent(mimeType: "image/png", url: "https://example.com/img1.png"),
            BinaryInputContent(mimeType: "image/png", url: "https://example.com/img2.png"),
            TextInputContent(text: "What are the differences?")
        ]

        let message = UserMessage.multimodal(id: "user-5", parts: parts)

        XCTAssertEqual(message.contentParts?.count, 4)
        XCTAssertTrue(message.isMultimodal)
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let message: any Message = UserMessage(
            id: "user-6",
            content: "Test message"
        )

        XCTAssertEqual(message.id, "user-6")
        XCTAssertEqual(message.role, .user)
        XCTAssertEqual((message as? UserMessage)?.content, "Test message")
    }

    func testRoleIsAlwaysUser() {
        let message1 = UserMessage(id: "1", content: "Text")
        let message2 = UserMessage.multimodal(id: "2", parts: [TextInputContent(text: "Multimodal")])

        XCTAssertEqual(message1.role, .user)
        XCTAssertEqual(message2.role, .user)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: UserMessage no longer directly supports Codable.
    // Serialization is handled through UserMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingTextOnly() throws {
        let json = """
        {
            "id": "user-decode-1",
            "role": "user",
            "content": "Hello, how are you?"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is UserMessage)
        let userMessage = message as! UserMessage
        XCTAssertEqual(userMessage.id, "user-decode-1")
        XCTAssertEqual(userMessage.role, .user)
        XCTAssertEqual(userMessage.content, "Hello, how are you?")
        XCTAssertNil(userMessage.contentParts)
        XCTAssertFalse(userMessage.isMultimodal)
    }

    func testDecodingTextWithName() throws {
        let json = """
        {
            "id": "user-decode-2",
            "role": "user",
            "content": "Test message",
            "name": "Charlie"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is UserMessage)
        let userMessage = message as! UserMessage
        XCTAssertEqual(userMessage.name, "Charlie")
        XCTAssertFalse(userMessage.isMultimodal)
    }

    // MARK: - Multimodal Decoding Tests

    func testDecodingMultimodal() throws {
        let json = """
        {
            "id": "user-decode-3",
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What is this?"
                },
                {
                    "type": "binary",
                    "mimeType": "image/jpeg",
                    "url": "https://example.com/photo.jpg"
                }
            ]
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is UserMessage)
        let userMessage = message as! UserMessage
        XCTAssertEqual(userMessage.id, "user-decode-3")
        XCTAssertTrue(userMessage.isMultimodal)
        XCTAssertEqual(userMessage.contentParts?.count, 2)

        // Verify first part is text
        if let textPart = userMessage.contentParts?[0] as? TextInputContent {
            XCTAssertEqual(textPart.text, "What is this?")
        } else {
            XCTFail("First part should be TextInputContent")
        }

        // Verify second part is binary
        if let binaryPart = userMessage.contentParts?[1] as? BinaryInputContent {
            XCTAssertEqual(binaryPart.mimeType, "image/jpeg")
        } else {
            XCTFail("Second part should be BinaryInputContent")
        }
    }

    func testDecodingMultimodalWithMultipleParts() throws {
        let json = """
        {
            "id": "user-decode-4",
            "role": "user",
            "content": [
                {"type": "text", "text": "Part 1"},
                {"type": "text", "text": "Part 2"},
                {"type": "binary", "mimeType": "image/png", "url": "https://test.com/img.png"}
            ]
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is UserMessage)
        let userMessage = message as! UserMessage
        XCTAssertEqual(userMessage.contentParts?.count, 3)
        XCTAssertTrue(userMessage.isMultimodal)
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "user",
            "content": "Test"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithoutContent() {
        let json = """
        {
            "id": "user-1",
            "role": "user"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithWrongRole() {
        let json = """
        {
            "id": "user-1",
            "role": "assistant",
            "content": "Test"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as AssistantMessage, not UserMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is UserMessage)
        XCTAssertTrue(message is AssistantMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripTextOnly() throws {
        // Create original message
        let original = UserMessage(
            id: "user-rt-1",
            content: "This is a round-trip test",
            name: "Tester"
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content ?? "",
            "name": original.name as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is UserMessage)
        let userMessage = decoded as! UserMessage
        XCTAssertEqual(userMessage.id, original.id)
        XCTAssertEqual(userMessage.content, original.content)
        XCTAssertEqual(userMessage.name, original.name)
        XCTAssertEqual(userMessage.isMultimodal, original.isMultimodal)
    }

    func testRoundTripMultimodal() throws {
        // Create original message
        let parts: [any InputContent] = [
            TextInputContent(text: "Analyze:"),
            BinaryInputContent(mimeType: "image/png", url: "https://test.com/img.png")
        ]

        let original = UserMessage.multimodal(id: "user-rt-2", parts: parts, name: "User")

        // Encode via DTO (simulating what RunAgentInput does)
        let contentArray: [[String: Any]] = [
            ["type": "text", "text": "Analyze:"],
            ["type": "binary", "mimeType": "image/png", "url": "https://test.com/img.png"]
        ]

        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": contentArray,
            "name": original.name as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is UserMessage)
        let userMessage = decoded as! UserMessage
        XCTAssertEqual(userMessage.id, original.id)
        XCTAssertEqual(userMessage.name, original.name)
        XCTAssertTrue(userMessage.isMultimodal)
        XCTAssertEqual(userMessage.contentParts?.count, 2)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let message1 = UserMessage(id: "1", content: "Test")
        let message2 = UserMessage(id: "1", content: "Test")
        let message3 = UserMessage(id: "2", content: "Test")
        let message4 = UserMessage(id: "1", content: "Different")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let message1 = UserMessage(id: "1", content: "Test")
        let message2 = UserMessage(id: "2", content: "Test")

        let set: Set<UserMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let message = UserMessage(id: "user-concurrent", content: "Test")

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, "user-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testSimpleQuestion() {
        let question = UserMessage(
            id: "q-1",
            content: "What is the capital of France?"
        )

        XCTAssertFalse(question.isMultimodal)
        XCTAssertEqual(question.role, .user)
    }

    func testImageAnalysisRequest() {
        let parts: [any InputContent] = [
            TextInputContent(text: "What objects are in this image?"),
            BinaryInputContent(
                mimeType: "image/jpeg",
                url: "https://photos.example.com/vacation.jpg",
                filename: "vacation.jpg"
            )
        ]

        let request = UserMessage.multimodal(id: "img-1", parts: parts)

        XCTAssertTrue(request.isMultimodal)
        XCTAssertEqual(request.contentParts?.count, 2)
    }

    func testMultiImageComparison() {
        let parts: [any InputContent] = [
            TextInputContent(text: "Compare these two images:"),
            BinaryInputContent(mimeType: "image/png", url: "https://test.com/before.png"),
            TextInputContent(text: "versus"),
            BinaryInputContent(mimeType: "image/png", url: "https://test.com/after.png"),
            TextInputContent(text: "What changed?")
        ]

        let comparison = UserMessage.multimodal(id: "comp-1", parts: parts)

        XCTAssertEqual(comparison.contentParts?.count, 5)
        XCTAssertTrue(comparison.isMultimodal)
    }

    func testDocumentAnalysis() {
        let parts: [any InputContent] = [
            TextInputContent(text: "Summarize this document:"),
            BinaryInputContent(
                mimeType: "application/pdf",
                id: "doc-annual-report",
                filename: "annual-report.pdf"
            )
        ]

        let request = UserMessage.multimodal(id: "doc-1", parts: parts)

        XCTAssertTrue(request.isMultimodal)
    }

    func testIsMultimodalProperty() {
        let textMessage = UserMessage(id: "1", content: "Text")
        let multimodalMessage = UserMessage.multimodal(
            id: "2",
            parts: [TextInputContent(text: "Part")]
        )

        XCTAssertFalse(textMessage.isMultimodal)
        XCTAssertTrue(multimodalMessage.isMultimodal)
    }
}
