// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the DeveloperMessage type
final class DeveloperMessageTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithRequiredFields() {
        let message = DeveloperMessage(
            id: "dev-1",
            content: "System configuration message"
        )

        XCTAssertEqual(message.id, "dev-1")
        XCTAssertEqual(message.content, "System configuration message")
        XCTAssertNil(message.name)
        XCTAssertEqual(message.role, .developer)
    }

    func testInitWithAllFields() {
        let message = DeveloperMessage(
            id: "dev-2",
            content: "Admin instructions",
            name: "SystemAdmin"
        )

        XCTAssertEqual(message.id, "dev-2")
        XCTAssertEqual(message.content, "Admin instructions")
        XCTAssertEqual(message.name, "SystemAdmin")
        XCTAssertEqual(message.role, .developer)
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let message: any Message = DeveloperMessage(
            id: "dev-3",
            content: "Test message"
        )

        XCTAssertEqual(message.id, "dev-3")
        XCTAssertEqual(message.role, .developer)
        XCTAssertEqual((message as? DeveloperMessage)?.content, "Test message")
    }

    func testRoleIsAlwaysDeveloper() {
        let message1 = DeveloperMessage(id: "1", content: "Message 1")
        let message2 = DeveloperMessage(id: "2", content: "Message 2", name: "Admin")

        XCTAssertEqual(message1.role, .developer)
        XCTAssertEqual(message2.role, .developer)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: DeveloperMessage no longer directly supports Codable.
    // Serialization is handled through DeveloperMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingWithRequiredFields() throws {
        let json = """
        {
            "id": "dev-decode-1",
            "role": "developer",
            "content": "System setup"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is DeveloperMessage)
        let devMessage = message as! DeveloperMessage
        XCTAssertEqual(devMessage.id, "dev-decode-1")
        XCTAssertEqual(devMessage.role, .developer)
        XCTAssertEqual(devMessage.content, "System setup")
        XCTAssertNil(devMessage.name)
    }

    func testDecodingWithAllFields() throws {
        let json = """
        {
            "id": "dev-decode-2",
            "role": "developer",
            "content": "Configuration",
            "name": "SysAdmin"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is DeveloperMessage)
        let devMessage = message as! DeveloperMessage
        XCTAssertEqual(devMessage.id, "dev-decode-2")
        XCTAssertEqual(devMessage.role, .developer)
        XCTAssertEqual(devMessage.content, "Configuration")
        XCTAssertEqual(devMessage.name, "SysAdmin")
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "developer",
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
            "id": "dev-1",
            "role": "developer"
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
            "id": "dev-1",
            "role": "user",
            "content": "Test"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as UserMessage, not DeveloperMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is DeveloperMessage)
        XCTAssertTrue(message is UserMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripEncodingDecoding() throws {
        // Create original message
        let original = DeveloperMessage(
            id: "dev-roundtrip",
            content: "System configuration for agent behavior",
            name: "ConfigManager"
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

        XCTAssertTrue(decoded is DeveloperMessage)
        let devMessage = decoded as! DeveloperMessage
        XCTAssertEqual(devMessage.id, original.id)
        XCTAssertEqual(devMessage.role, original.role)
        XCTAssertEqual(devMessage.content, original.content)
        XCTAssertEqual(devMessage.name, original.name)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let message1 = DeveloperMessage(id: "1", content: "Config", name: "Admin")
        let message2 = DeveloperMessage(id: "1", content: "Config", name: "Admin")
        let message3 = DeveloperMessage(id: "2", content: "Config", name: "Admin")
        let message4 = DeveloperMessage(id: "1", content: "Different", name: "Admin")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let message1 = DeveloperMessage(id: "1", content: "Test")
        let message2 = DeveloperMessage(id: "2", content: "Test")

        let set: Set<DeveloperMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let message = DeveloperMessage(id: "dev-concurrent", content: "Test")

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, "dev-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testSystemLevelConfiguration() {
        let configMessage = DeveloperMessage(
            id: "config-1",
            content: """
            System configuration:
            - Enable debug logging
            - Set max tokens to 4096
            - Use temperature 0.7
            """,
            name: "SystemConfigurator"
        )

        XCTAssertEqual(configMessage.role, .developer)
        XCTAssertTrue(configMessage.content?.contains("System configuration") ?? false)
    }

    func testMetaInstructions() {
        let metaMessage = DeveloperMessage(
            id: "meta-1",
            content: "Agent should prioritize code quality over speed in all responses"
        )

        XCTAssertEqual(metaMessage.role, .developer)
        XCTAssertNotNil(metaMessage.content)
    }
}
