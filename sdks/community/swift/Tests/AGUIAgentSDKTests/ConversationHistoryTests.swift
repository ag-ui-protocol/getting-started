// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIAgentSDK
import XCTest

final class ConversationHistoryTests: XCTestCase {

    // MARK: - Basic Operations

    func testEmptyHistoryInitially() async throws {
        // Given: A new history manager
        let manager = ConversationHistoryManager()

        // When: Getting history for a thread
        let history = await manager.history(for: "thread-1")

        // Then: Should be empty
        XCTAssertTrue(history.isEmpty)
        XCTAssertEqual(history.count, 0)
    }

    func testAppendSingleMessage() async throws {
        // Given: A history manager
        let manager = ConversationHistoryManager()
        let message = UserMessage(id: "msg1", content: "Hello")

        // When: Appending a message
        await manager.append(message: message, to: "thread-1")

        // Then: History should contain the message
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.first?.id, "msg1")
    }

    func testAppendMultipleMessages() async throws {
        // Given: A history manager
        let manager = ConversationHistoryManager()

        // When: Appending multiple messages
        await manager.append(message: UserMessage(id: "msg1", content: "Hello"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "Hi there"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "How are you?"), to: "thread-1")

        // Then: History should contain all messages in order
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "msg1")
        XCTAssertEqual(history[1].id, "msg2")
        XCTAssertEqual(history[2].id, "msg3")
    }

    // MARK: - Multi-Thread Tests

    func testSeparateThreadHistories() async throws {
        // Given: A history manager with messages in different threads
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "t1-msg1", content: "Thread 1"), to: "thread-1")
        await manager.append(message: UserMessage(id: "t2-msg1", content: "Thread 2"), to: "thread-2")
        await manager.append(message: UserMessage(id: "t1-msg2", content: "Thread 1 again"), to: "thread-1")

        // When: Getting histories
        let history1 = await manager.history(for: "thread-1")
        let history2 = await manager.history(for: "thread-2")

        // Then: Each thread should have its own independent history
        XCTAssertEqual(history1.count, 2)
        XCTAssertEqual(history1[0].id, "t1-msg1")
        XCTAssertEqual(history1[1].id, "t1-msg2")

        XCTAssertEqual(history2.count, 1)
        XCTAssertEqual(history2[0].id, "t2-msg1")
    }

    func testCountForThread() async throws {
        // Given: A history manager with different thread sizes
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Hello"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg2", content: "Hi"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "Hey"), to: "thread-2")

        // When: Getting counts
        let count1 = await manager.count(for: "thread-1")
        let count2 = await manager.count(for: "thread-2")
        let count3 = await manager.count(for: "nonexistent")

        // Then: Counts should be accurate
        XCTAssertEqual(count1, 2)
        XCTAssertEqual(count2, 1)
        XCTAssertEqual(count3, 0)
    }

    func testAllThreadIds() async throws {
        // Given: A history manager with multiple threads
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Hello"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg2", content: "Hi"), to: "thread-2")
        await manager.append(message: UserMessage(id: "msg3", content: "Hey"), to: "thread-3")

        // When: Getting all thread IDs
        let threadIds = await manager.allThreadIds()

        // Then: Should contain all thread IDs
        XCTAssertEqual(Set(threadIds), Set(["thread-1", "thread-2", "thread-3"]))
    }

    // MARK: - Clear Tests

    func testClearSpecificThread() async throws {
        // Given: A history manager with multiple threads
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Thread 1"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg2", content: "Thread 2"), to: "thread-2")

        // When: Clearing one thread
        await manager.clear(threadId: "thread-1")

        // Then: Only that thread should be cleared
        let history1 = await manager.history(for: "thread-1")
        let history2 = await manager.history(for: "thread-2")

        XCTAssertTrue(history1.isEmpty)
        XCTAssertEqual(history2.count, 1)
    }

    func testClearAllThreads() async throws {
        // Given: A history manager with multiple threads
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Thread 1"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg2", content: "Thread 2"), to: "thread-2")
        await manager.append(message: UserMessage(id: "msg3", content: "Thread 3"), to: "thread-3")

        // When: Clearing all threads
        await manager.clear(threadId: nil)

        // Then: All threads should be cleared
        let history1 = await manager.history(for: "thread-1")
        let history2 = await manager.history(for: "thread-2")
        let history3 = await manager.history(for: "thread-3")

        XCTAssertTrue(history1.isEmpty)
        XCTAssertTrue(history2.isEmpty)
        XCTAssertTrue(history3.isEmpty)

        let threadIds = await manager.allThreadIds()
        XCTAssertTrue(threadIds.isEmpty)
    }

    // MARK: - Message Type Tests

    func testMixedMessageTypes() async throws {
        // Given: A history manager
        let manager = ConversationHistoryManager()

        // When: Adding different message types
        await manager.append(message: SystemMessage(id: "sys1", content: "You are helpful"), to: "thread-1")
        await manager.append(message: UserMessage(id: "usr1", content: "Hello"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "ast1", content: "Hi"), to: "thread-1")
        await manager.append(
            message: ToolMessage(id: "tool1", content: "Result", toolCallId: "tc1"),
            to: "thread-1"
        )

        // Then: All message types should be preserved
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 4)
        XCTAssertTrue(history[0] is SystemMessage)
        XCTAssertTrue(history[1] is UserMessage)
        XCTAssertTrue(history[2] is AssistantMessage)
        XCTAssertTrue(history[3] is ToolMessage)
    }
}
