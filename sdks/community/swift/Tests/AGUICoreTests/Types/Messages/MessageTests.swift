// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the Message protocol
final class MessageTests: XCTestCase {
    // MARK: - Mock Message Implementation

    /// Mock message implementation for testing protocol conformance
    struct MockMessage: Message {
        let id: String
        let role: Role
        let content: String?
        let name: String?
        let encryptedValue: String?

        init(id: String = "test-id", role: Role = .user, content: String? = "Test content", name: String? = nil, encryptedValue: String? = nil) {
            self.id = id
            self.role = role
            self.content = content
            self.name = name
            self.encryptedValue = encryptedValue
        }
    }

    // MARK: - Protocol Conformance Tests

    func testMessageProtocolRequiresId() {
        let message = MockMessage(id: "msg-123")
        XCTAssertEqual(message.id, "msg-123")
    }

    func testMessageProtocolRequiresRole() {
        let message = MockMessage(role: .assistant)
        XCTAssertEqual(message.role, .assistant)
    }

    func testMessageProtocolRequiresContent() {
        let message = MockMessage(content: "Hello, world!")
        XCTAssertEqual(message.content, "Hello, world!")
    }

    func testMessageProtocolRequiresName() {
        let message = MockMessage(name: "TestBot")
        XCTAssertEqual(message.name, "TestBot")
    }

    func testMessageContentCanBeNil() {
        let message = MockMessage(content: nil)
        XCTAssertNil(message.content)
    }

    func testMessageNameCanBeNil() {
        let message = MockMessage(name: nil)
        XCTAssertNil(message.name)
    }

    // MARK: - Sendable Conformance Tests

    func testMessageIsSendable() {
        // This test verifies that Message conforming types can be sent across isolation boundaries
        let message = MockMessage()

        Task {
            // If MockMessage is Sendable, this should compile without warnings
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, message.id)
        }
    }

    // MARK: - Protocol Behavior Tests

    // Note: Message protocol no longer requires Codable conformance.
    // Serialization is handled through message-specific DTOs and MessageDecoder.
    // The following tests verify basic protocol requirements.

    func testMessageSupportsAllRoleTypes() {
        let roles: [Role] = [.developer, .system, .assistant, .user, .tool, .activity]

        for role in roles {
            let message = MockMessage(id: "msg-\(role)", role: role)
            XCTAssertEqual(message.role, role, "Message should support role: \(role)")
        }
    }

    // MARK: - Equatable Tests (if implemented)

    func testMockMessageEquality() {
        let message1 = MockMessage(id: "msg-1", role: .user, content: "Hello", name: "User1")
        let message2 = MockMessage(id: "msg-1", role: .user, content: "Hello", name: "User1")
        let message3 = MockMessage(id: "msg-2", role: .user, content: "Hello", name: "User1")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
    }
}

// MARK: - MockMessage Equatable Conformance

extension MessageTests.MockMessage: Equatable {
    static func == (lhs: MessageTests.MockMessage, rhs: MessageTests.MockMessage) -> Bool {
        lhs.id == rhs.id &&
        lhs.role == rhs.role &&
        lhs.content == rhs.content &&
        lhs.name == rhs.name
    }
}
