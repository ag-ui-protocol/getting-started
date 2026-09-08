// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the Context type
final class ContextTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithBasicContext() {
        let context = Context(
            description: "User preferences",
            value: "Dark mode enabled"
        )

        XCTAssertEqual(context.description, "User preferences")
        XCTAssertEqual(context.value, "Dark mode enabled")
    }

    func testInitWithLongDescription() {
        let context = Context(
            description: "This is a detailed description of the contextual information",
            value: "Some value"
        )

        XCTAssertEqual(context.description, "This is a detailed description of the contextual information")
    }

    func testInitWithEmptyStrings() {
        let context = Context(
            description: "",
            value: ""
        )

        XCTAssertEqual(context.description, "")
        XCTAssertEqual(context.value, "")
    }

    // MARK: - Encoding Tests

    func testEncodingBasicContext() throws {
        let context = Context(
            description: "API Key",
            value: "sk-test-123"
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(context)
        let json = String(data: encoded, encoding: .utf8)

        XCTAssertNotNil(json)
        XCTAssertTrue(json?.contains("\"description\"") ?? false)
        XCTAssertTrue(json?.contains("\"value\"") ?? false)
        XCTAssertTrue(json?.contains("\"API Key\"") ?? false)
    }

    func testEncodedStructure() throws {
        let context = Context(
            description: "User location",
            value: "San Francisco, CA"
        )

        let encoded = try JSONEncoder().encode(context)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertEqual(json?["description"] as? String, "User location")
        XCTAssertEqual(json?["value"] as? String, "San Francisco, CA")
    }

    // MARK: - Decoding Tests

    func testDecodingBasicContext() throws {
        let json = """
        {
            "description": "Current date",
            "value": "2024-01-01"
        }
        """

        let decoder = JSONDecoder()
        let context = try decoder.decode(Context.self, from: Data(json.utf8))

        XCTAssertEqual(context.description, "Current date")
        XCTAssertEqual(context.value, "2024-01-01")
    }

    func testDecodingWithSpecialCharacters() throws {
        let json = """
        {
            "description": "User's name",
            "value": "O'Brien"
        }
        """

        let decoder = JSONDecoder()
        let context = try decoder.decode(Context.self, from: Data(json.utf8))

        XCTAssertEqual(context.description, "User's name")
        XCTAssertEqual(context.value, "O'Brien")
    }

    func testDecodingFailsWithoutDescription() {
        let json = """
        {
            "value": "test"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(Context.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutValue() {
        let json = """
        {
            "description": "test"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(Context.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - Round-trip Tests

    func testRoundTrip() throws {
        let original = Context(
            description: "Session ID",
            value: "abc-123-xyz"
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(Context.self, from: encoded)

        XCTAssertEqual(decoded.description, original.description)
        XCTAssertEqual(decoded.value, original.value)
    }

    func testRoundTripWithUnicode() throws {
        let original = Context(
            description: "Greeting",
            value: "こんにちは"
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(Context.self, from: encoded)

        XCTAssertEqual(decoded.value, "こんにちは")
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let context1 = Context(description: "Test", value: "Value1")
        let context2 = Context(description: "Test", value: "Value1")
        let context3 = Context(description: "Test", value: "Value2")
        let context4 = Context(description: "Other", value: "Value1")

        XCTAssertEqual(context1, context2)
        XCTAssertNotEqual(context1, context3)
        XCTAssertNotEqual(context1, context4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let context1 = Context(description: "Key1", value: "Val1")
        let context2 = Context(description: "Key2", value: "Val2")

        let set: Set<Context> = [context1, context2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(context1))
        XCTAssertTrue(set.contains(context2))
    }

    func testHashableDuplicates() {
        let context1 = Context(description: "Key", value: "Val")
        let context2 = Context(description: "Key", value: "Val")

        let set: Set<Context> = [context1, context2]
        XCTAssertEqual(set.count, 1)
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let context = Context(
            description: "Test",
            value: "Concurrent"
        )

        Task {
            let capturedContext = context
            XCTAssertEqual(capturedContext.description, "Test")
        }
    }

    // MARK: - Real-world Usage Tests

    func testUserPreferencesContext() {
        let context = Context(
            description: "Theme preference",
            value: "dark"
        )

        XCTAssertEqual(context.description, "Theme preference")
        XCTAssertEqual(context.value, "dark")
    }

    func testLocationContext() {
        let context = Context(
            description: "User location",
            value: "New York, NY, USA"
        )

        XCTAssertEqual(context.value, "New York, NY, USA")
    }

    func testAPIKeyContext() {
        let context = Context(
            description: "API credentials",
            value: "sk-proj-abc123xyz"
        )

        XCTAssertEqual(context.description, "API credentials")
    }

    func testTimestampContext() {
        let context = Context(
            description: "Request timestamp",
            value: "2024-01-01T12:00:00Z"
        )

        XCTAssertEqual(context.value, "2024-01-01T12:00:00Z")
    }

    func testMultipleContextsInArray() {
        let contexts = [
            Context(description: "user_id", value: "12345"),
            Context(description: "session_id", value: "abc-xyz"),
            Context(description: "language", value: "en-US")
        ]

        XCTAssertEqual(contexts.count, 3)
        XCTAssertEqual(contexts[0].description, "user_id")
        XCTAssertEqual(contexts[1].description, "session_id")
        XCTAssertEqual(contexts[2].description, "language")
    }

    func testJSONStructuredValue() throws {
        // Value can be a JSON string itself
        let context = Context(
            description: "User profile",
            value: """
            {"name": "Alice", "age": 30}
            """
        )

        XCTAssertEqual(context.description, "User profile")
        XCTAssertTrue(context.value.contains("Alice"))
    }
}
