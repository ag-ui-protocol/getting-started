// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the InputContent protocol and TextInputContent type
final class InputContentTests: XCTestCase {
    // MARK: - TextInputContent Initialization Tests

    func testTextInputContentInit() {
        let content = TextInputContent(text: "Hello, world!")

        XCTAssertEqual(content.text, "Hello, world!")
        XCTAssertEqual(content.type, "text")
    }

    func testTextInputContentWithEmptyString() {
        let content = TextInputContent(text: "")

        XCTAssertEqual(content.text, "")
        XCTAssertEqual(content.type, "text")
    }

    func testTextInputContentWithMultilineText() {
        let multilineText = """
        This is line 1
        This is line 2
        This is line 3
        """

        let content = TextInputContent(text: multilineText)

        XCTAssertTrue(content.text.contains("line 1"))
        XCTAssertTrue(content.text.contains("line 2"))
    }

    // MARK: - TextInputContent Encoding Tests
    // Note: Direct encoding of TextInputContent is not supported.
    // TextInputContent is encoded via DTOs when part of larger structures
    // (e.g., UserMessageDTO when encoding UserMessage with multimodal content).
    // These tests are intentionally omitted as they would not reflect real-world usage.

    // MARK: - TextInputContent Decoding Tests

    func testTextInputContentDecoding() throws {
        let json = """
        {
            "type": "text",
            "text": "Hello from JSON"
        }
        """

        let dto = try TextInputContentDTO.decode(from: Data(json.utf8))
        let content = dto.toDomain()

        XCTAssertEqual(content.type, "text")
        XCTAssertEqual(content.text, "Hello from JSON")
    }

    func testTextInputContentDecodingWithoutType() throws {
        // Type field is optional in the JSON, but the domain model always has type "text"
        let json = """
        {
            "text": "Text without explicit type"
        }
        """

        let dto = try TextInputContentDTO.decode(from: Data(json.utf8))
        let content = dto.toDomain()

        XCTAssertEqual(content.type, "text")
        XCTAssertEqual(content.text, "Text without explicit type")
    }

    func testTextInputContentDecodingFailsWithoutText() {
        let json = """
        {
            "type": "text"
        }
        """

        XCTAssertThrowsError(try TextInputContentDTO.decode(from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - TextInputContent Round-trip Tests

    func testTextInputContentRoundTrip() throws {
        let original = TextInputContent(text: "Round-trip test message")

        // Encode manually (simulating what UserMessageDTO does)
        let dict: [String: Any] = [
            "type": "text",
            "text": original.text
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        let dto = try TextInputContentDTO.decode(from: encoded)
        let decoded = dto.toDomain()

        XCTAssertEqual(decoded.type, original.type)
        XCTAssertEqual(decoded.text, original.text)
    }

    // MARK: - InputContent Protocol Conformance Tests

    func testTextInputContentConformsToInputContent() {
        let content: any InputContent = TextInputContent(text: "Protocol test")

        XCTAssertEqual(content.type, "text")
    }

    func testInputContentArrayWithTextContent() {
        let contents: [any InputContent] = [
            TextInputContent(text: "First message"),
            TextInputContent(text: "Second message"),
            TextInputContent(text: "Third message")
        ]

        XCTAssertEqual(contents.count, 3)
        XCTAssertEqual(contents[0].type, "text")
    }

    // MARK: - Equatable Tests

    func testTextInputContentEquality() {
        let content1 = TextInputContent(text: "Same text")
        let content2 = TextInputContent(text: "Same text")
        let content3 = TextInputContent(text: "Different text")

        XCTAssertEqual(content1, content2)
        XCTAssertNotEqual(content1, content3)
    }

    // MARK: - Hashable Tests

    func testTextInputContentHashable() {
        let content1 = TextInputContent(text: "Text 1")
        let content2 = TextInputContent(text: "Text 2")

        let set: Set<TextInputContent> = [content1, content2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(content1))
        XCTAssertTrue(set.contains(content2))
    }

    // MARK: - Sendable Tests

    func testTextInputContentSendable() {
        let content = TextInputContent(text: "Concurrent test")

        Task {
            let capturedContent = content
            XCTAssertEqual(capturedContent.text, "Concurrent test")
        }
    }

    // MARK: - Real-world Usage Tests

    func testSimpleTextMessage() {
        let content = TextInputContent(text: "What is the weather like today?")

        XCTAssertEqual(content.type, "text")
        XCTAssertTrue(content.text.contains("weather"))
    }

    func testLongTextMessage() {
        let longText = """
        This is a longer message that spans multiple lines and contains
        various information. It might be used in a complex user query that
        requires detailed explanation or context.

        The message can include:
        - Multiple paragraphs
        - Lists
        - Technical details
        """

        let content = TextInputContent(text: longText)

        XCTAssertTrue(content.text.contains("multiple lines"))
        XCTAssertTrue(content.text.contains("Lists"))
    }

    func testCodeSnippetInText() {
        let codeText = """
        Can you help me with this Swift code?

        ```swift
        func greet(name: String) {
            print("Hello, \\(name)!")
        }
        ```
        """

        let content = TextInputContent(text: codeText)

        XCTAssertTrue(content.text.contains("Swift code"))
        XCTAssertTrue(content.text.contains("func greet"))
    }

    func testUnicodeInText() {
        let unicodeText = "Hello 👋 World 🌍 with émojis and spëcial çharacters"

        let content = TextInputContent(text: unicodeText)

        XCTAssertEqual(content.text, unicodeText)
        XCTAssertTrue(content.text.contains("👋"))
    }

    func testTextTypeAlwaysText() {
        let content1 = TextInputContent(text: "Message 1")
        let content2 = TextInputContent(text: "Message 2")
        let content3 = TextInputContent(text: "")

        XCTAssertEqual(content1.type, "text")
        XCTAssertEqual(content2.type, "text")
        XCTAssertEqual(content3.type, "text")
    }
}
