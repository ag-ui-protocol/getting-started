// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIAgentSDK
import XCTest

final class HistoryTrimmingTests: XCTestCase {

    // MARK: - Basic Trimming

    func testTrimNoEffectWhenUnderLimit() async throws {
        // Given: History with 3 messages and limit of 5
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Hello"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "Hi"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "How are you?"), to: "thread-1")

        // When: Trimming to 5
        await manager.trim(threadId: "thread-1", maxLength: 5)

        // Then: All messages should remain
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "msg1")
        XCTAssertEqual(history[1].id, "msg2")
        XCTAssertEqual(history[2].id, "msg3")
    }

    func testTrimRemovesOldestMessages() async throws {
        // Given: History with 5 messages
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg4", content: "4"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg5", content: "5"), to: "thread-1")

        // When: Trimming to 3
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: Should keep last 3 messages
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "msg3")
        XCTAssertEqual(history[1].id, "msg4")
        XCTAssertEqual(history[2].id, "msg5")
    }

    // MARK: - System Message Preservation

    func testTrimPreservesSystemMessage() async throws {
        // Given: History with system message and 4 user/assistant messages
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "You are helpful"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg4", content: "4"), to: "thread-1")

        // When: Trimming to 3 (system excluded from count — keep last 3 non-system)
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: System + last 3 non-system messages = 4 total
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 4)
        XCTAssertTrue(history[0] is SystemMessage)
        XCTAssertEqual(history[0].id, "sys1")
        XCTAssertEqual(history[1].id, "msg2")
        XCTAssertEqual(history[2].id, "msg3")
        XCTAssertEqual(history[3].id, "msg4")
    }

    func testTrimWithOnlySystemMessage() async throws {
        // Given: History with only system message
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "You are helpful"), to: "thread-1")

        // When: Trimming to 3
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: System message should remain
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].id, "sys1")
    }

    func testTrimWithSystemMessageAndOneOther() async throws {
        // Given: System message + one user message, trim to 1
        // maxLength=1 means keep 1 non-system message (system excluded from count).
        // With exactly 1 non-system message, no messages are dropped.
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "System"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "User"), to: "thread-1")

        // When: Trimming to 1
        await manager.trim(threadId: "thread-1", maxLength: 1)

        // Then: System + 1 non-system = 2 total (nothing is dropped since count matches limit)
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history[0].id, "sys1")
        XCTAssertEqual(history[1].id, "msg1")
    }

    // MARK: - Edge Cases

    func testTrimToZeroWithoutSystemMessage() async throws {
        // Given: History with 3 messages, no system message
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")

        // When: Trimming to 0
        await manager.trim(threadId: "thread-1", maxLength: 0)

        // Then: All messages removed
        let history = await manager.history(for: "thread-1")
        XCTAssertTrue(history.isEmpty)
    }

    func testTrimToOneWithSystemMessage() async throws {
        // Given: System message + 3 others
        // maxLength=1 means keep 1 non-system (system excluded from count).
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "System"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")

        // When: Trimming to 1
        await manager.trim(threadId: "thread-1", maxLength: 1)

        // Then: System + last 1 non-system = 2 total
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history[0].id, "sys1")
        XCTAssertEqual(history[1].id, "msg3")
    }

    // MARK: - Documented contract: system message excluded from maxLength (Issue 41)

    func test_trim_withSystemMessage_systemExcludedFromCount_docContractExample() async throws {
        // This is the exact example from the method's doc comment.
        // The doc states: "The system message does not count toward the limit."
        // Given: [SystemMessage, User1, Assistant1, User2, Assistant2, User3]
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys", content: "System"), to: "t")
        await manager.append(message: UserMessage(id: "u1", content: "1"), to: "t")
        await manager.append(message: AssistantMessage(id: "a1", content: "2"), to: "t")
        await manager.append(message: UserMessage(id: "u2", content: "3"), to: "t")
        await manager.append(message: AssistantMessage(id: "a2", content: "4"), to: "t")
        await manager.append(message: UserMessage(id: "u3", content: "5"), to: "t")

        // When: trim(maxLength: 3) — keep last 3 non-system messages
        await manager.trim(threadId: "t", maxLength: 3)

        // Then: [SystemMessage, User2, Assistant2, User3] — 4 total
        // System does NOT count; we keep exactly 3 non-system messages.
        let history = await manager.history(for: "t")
        XCTAssertEqual(history.count, 4, "Expected system + 3 non-system messages (system excluded from count)")
        XCTAssertTrue(history[0] is SystemMessage)
        XCTAssertEqual(history[1].id, "u2")
        XCTAssertEqual(history[2].id, "a2")
        XCTAssertEqual(history[3].id, "u3")
    }

    func testTrimNonexistentThread() async throws {
        // Given: Empty manager
        let manager = ConversationHistoryManager()

        // When: Trimming nonexistent thread
        await manager.trim(threadId: "nonexistent", maxLength: 5)

        // Then: Should not crash, history still empty
        let history = await manager.history(for: "nonexistent")
        XCTAssertTrue(history.isEmpty)
    }

    // MARK: - Realistic Scenarios

    func testRealisticConversationTrim() async throws {
        // Given: A realistic conversation (system + 6 non-system messages)
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys", content: "You are helpful"), to: "chat")
        await manager.append(message: UserMessage(id: "u1", content: "Hello"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a1", content: "Hi!"), to: "chat")
        await manager.append(message: UserMessage(id: "u2", content: "Weather?"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a2", content: "Sunny"), to: "chat")
        await manager.append(message: UserMessage(id: "u3", content: "Thanks"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a3", content: "Welcome"), to: "chat")

        // When: Trimming with maxLength=5 (keep last 5 non-system; system excluded from count)
        await manager.trim(threadId: "chat", maxLength: 5)

        // Then: System + last 5 non-system = 6 total
        let history = await manager.history(for: "chat")
        XCTAssertEqual(history.count, 6)
        XCTAssertEqual(history[0].id, "sys")
        XCTAssertEqual(history[1].id, "a1")
        XCTAssertEqual(history[2].id, "u2")
        XCTAssertEqual(history[3].id, "a2")
        XCTAssertEqual(history[4].id, "u3")
        XCTAssertEqual(history[5].id, "a3")
    }

    func testAggressiveTrimToSystemOnly() async throws {
        // Given: Long conversation (system + 20 non-system messages)
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys", content: "System"), to: "chat")
        for i in 1...10 {
            await manager.append(message: UserMessage(id: "u\(i)", content: "\(i)"), to: "chat")
            await manager.append(message: AssistantMessage(id: "a\(i)", content: "\(i)"), to: "chat")
        }

        // When: Trimming with maxLength=2 (keep last 2 non-system; system excluded from count)
        await manager.trim(threadId: "chat", maxLength: 2)

        // Then: System + last 2 non-system = 3 total
        let history = await manager.history(for: "chat")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "sys")
        XCTAssertEqual(history[1].id, "u10")
        XCTAssertEqual(history[2].id, "a10")
    }
}
