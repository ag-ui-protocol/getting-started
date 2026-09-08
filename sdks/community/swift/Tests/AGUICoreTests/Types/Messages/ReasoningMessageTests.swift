// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ReasoningMessageTests: XCTestCase {

    private let messageId = "msg-reasoning-1"
    private let content = "Let me think step by step..."

    // MARK: - Role

    func test_roleIsAlwaysReasoning() {
        let message = ReasoningMessage(id: messageId, content: content)
        XCTAssertEqual(message.role, .reasoning)
    }

    // MARK: - Initialization

    func test_initWithContent_storesContent() {
        let message = ReasoningMessage(id: messageId, content: content)
        XCTAssertEqual(message.id, messageId)
        XCTAssertEqual(message.content, content)
        XCTAssertNil(message.encryptedValue)
    }

    func test_initWithEncryptedValue_storesEncryptedValue() {
        let token = "enc-abc-token"
        let message = ReasoningMessage(id: messageId, content: content, encryptedValue: token)
        XCTAssertEqual(message.encryptedValue, token)
    }

    func test_nameIsAlwaysNil() {
        let message = ReasoningMessage(id: messageId, content: content)
        XCTAssertNil(message.name)
    }

    // MARK: - Equatable / Hashable

    func test_equatable_sameFields_areEqual() {
        let m1 = ReasoningMessage(id: messageId, content: content)
        let m2 = ReasoningMessage(id: messageId, content: content)
        XCTAssertEqual(m1, m2)
    }

    func test_equatable_differentContent_notEqual() {
        let m1 = ReasoningMessage(id: messageId, content: "a")
        let m2 = ReasoningMessage(id: messageId, content: "b")
        XCTAssertNotEqual(m1, m2)
    }

    func test_equatable_differentId_notEqual() {
        let m1 = ReasoningMessage(id: "id-1", content: content)
        let m2 = ReasoningMessage(id: "id-2", content: content)
        XCTAssertNotEqual(m1, m2)
    }

    func test_equatable_differentEncryptedValue_notEqual() {
        let m1 = ReasoningMessage(id: messageId, content: content, encryptedValue: "token-a")
        let m2 = ReasoningMessage(id: messageId, content: content, encryptedValue: "token-b")
        XCTAssertNotEqual(m1, m2)
    }

    func test_hashable_equalMessagesHaveSameHash() {
        let m1 = ReasoningMessage(id: messageId, content: content)
        let m2 = ReasoningMessage(id: messageId, content: content)
        XCTAssertEqual(m1.hashValue, m2.hashValue)
    }

    func test_hashable_canBeUsedInSet() {
        let m1 = ReasoningMessage(id: messageId, content: content)
        let m2 = ReasoningMessage(id: messageId, content: content)
        let set: Set<ReasoningMessage> = [m1, m2]
        XCTAssertEqual(set.count, 1)
    }
}
