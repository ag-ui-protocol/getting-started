// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIAgentSDK

final class AgentMessageTests: XCTestCase {

    // MARK: - Initialization

    func testInit_setsAllProvidedFields() {
        let msg = AgentMessage(id: "id-123", role: .user, content: "Hello!")
        XCTAssertEqual(msg.id, "id-123")
        XCTAssertEqual(msg.role, .user)
        XCTAssertEqual(msg.content, "Hello!")
    }

    func testInit_defaultId_isNonEmpty() {
        let msg = AgentMessage(role: .assistant, content: "Hi")
        XCTAssertFalse(msg.id.isEmpty)
    }

    func testInit_twoMessagesWithDefaultId_haveUniqueIds() {
        let a = AgentMessage(role: .user, content: "A")
        let b = AgentMessage(role: .user, content: "B")
        XCTAssertNotEqual(a.id, b.id)
    }

    // MARK: - Role

    func testRole_allCasesExist() {
        let expected: [AgentMessage.Role] = [.user, .assistant, .system, .tool]
        XCTAssertEqual(AgentMessage.Role.allCases.count, expected.count)
        for role in expected {
            XCTAssertTrue(AgentMessage.Role.allCases.contains(role))
        }
    }

    func testRole_rawValues_matchProtocolNames() {
        XCTAssertEqual(AgentMessage.Role.user.rawValue, "user")
        XCTAssertEqual(AgentMessage.Role.assistant.rawValue, "assistant")
        XCTAssertEqual(AgentMessage.Role.system.rawValue, "system")
        XCTAssertEqual(AgentMessage.Role.tool.rawValue, "tool")
    }

    // MARK: - Equatable

    func testEquatable_identicalFields_areEqual() {
        let a = AgentMessage(id: "x", role: .user, content: "hello")
        let b = AgentMessage(id: "x", role: .user, content: "hello")
        XCTAssertEqual(a, b)
    }

    func testEquatable_differentId_notEqual() {
        let a = AgentMessage(id: "a", role: .user, content: "hello")
        let b = AgentMessage(id: "b", role: .user, content: "hello")
        XCTAssertNotEqual(a, b)
    }

    func testEquatable_differentRole_notEqual() {
        let a = AgentMessage(id: "x", role: .user, content: "hello")
        let b = AgentMessage(id: "x", role: .assistant, content: "hello")
        XCTAssertNotEqual(a, b)
    }

    func testEquatable_differentContent_notEqual() {
        let a = AgentMessage(id: "x", role: .user, content: "hello")
        let b = AgentMessage(id: "x", role: .user, content: "world")
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Identifiable

    func testIdentifiable_idMatchesInitParameter() {
        let msg = AgentMessage(id: "unique-id", role: .assistant, content: "Hi")
        XCTAssertEqual(msg.id, "unique-id")
    }
}
