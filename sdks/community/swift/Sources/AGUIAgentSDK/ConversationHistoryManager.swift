// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Thread-safe manager for conversation history across multiple threads.
///
/// `ConversationHistoryManager` maintains separate message histories for each
/// conversation thread, providing automatic trimming and thread-safe access.
///
/// ## Thread Management
///
/// Each thread has its own independent conversation history, identified by
/// a string thread ID (e.g., "default", "user-123", "session-abc").
///
/// ## History Trimming
///
/// When trimming, the manager preserves system messages while removing the
/// oldest user/assistant message pairs to fit within the specified limit.
///
/// ## Example
///
/// ```swift
/// let manager = ConversationHistoryManager()
///
/// // Add messages to a thread
/// await manager.append(
///     message: SystemMessage(id: "sys1", content: "You are helpful"),
///     to: "chat-1"
/// )
/// await manager.append(
///     message: UserMessage(id: "usr1", content: "Hello"),
///     to: "chat-1"
/// )
///
/// // Get history
/// let history = await manager.history(for: "chat-1")
/// print(history.count) // 2
///
/// // Trim to size
/// await manager.trim(threadId: "chat-1", maxLength: 10)
/// ```
actor ConversationHistoryManager {
    /// Storage for per-thread conversation histories.
    private var threadHistories: [String: [any Message]] = [:]

    /// Creates a new conversation history manager.
    public init() {}

    /// Appends a message to a thread's conversation history.
    ///
    /// - Parameters:
    ///   - message: The message to append
    ///   - threadId: The thread identifier
    public func append(message: any Message, to threadId: String) {
        threadHistories[threadId, default: []].append(message)
    }

    /// Retrieves the conversation history for a thread.
    ///
    /// - Parameter threadId: The thread identifier
    /// - Returns: Array of messages in chronological order, or empty if no history exists
    public func history(for threadId: String) -> [any Message] {
        threadHistories[threadId] ?? []
    }

    /// Trims conversation history to fit within a maximum length.
    ///
    /// This method preserves the system message (if present) and removes the oldest
    /// messages to fit within `maxLength`. The system message does not count toward
    /// the limit.
    ///
    /// - Parameters:
    ///   - threadId: The thread identifier
    ///   - maxLength: Maximum number of messages to keep (excluding system message)
    ///
    /// ## Example
    ///
    /// ```swift
    /// // Given: [SystemMessage, User1, Assistant1, User2, Assistant2, User3]
    /// await manager.trim(threadId: "chat", maxLength: 3)
    /// // Result: [SystemMessage, User2, Assistant2, User3]
    /// ```
    public func trim(threadId: String, maxLength: Int) {
        guard let history = threadHistories[threadId], history.count > maxLength else {
            return
        }

        // Check for system message at the beginning
        let hasSystemMessage = history.first is SystemMessage
        if hasSystemMessage && history.count > 1 {
            // Keep system message + last maxLength messages (system excluded from count)
            let systemMessage = history.first!
            let trimmed = Array(history.dropFirst().suffix(maxLength))
            threadHistories[threadId] = [systemMessage] + trimmed
        } else {
            // No system message, just keep last maxLength messages
            threadHistories[threadId] = Array(history.suffix(maxLength))
        }
    }

    /// Clears conversation history for one or all threads.
    ///
    /// - Parameter threadId: The thread ID to clear, or `nil` to clear all threads
    ///
    /// ## Example
    ///
    /// ```swift
    /// // Clear specific thread
    /// await manager.clear(threadId: "chat-1")
    ///
    /// // Clear all threads
    /// await manager.clear(threadId: nil)
    /// ```
    public func clear(threadId: String? = nil) {
        if let threadId = threadId {
            threadHistories.removeValue(forKey: threadId)
        } else {
            threadHistories.removeAll()
        }
    }

    /// Returns the number of messages in a thread's history.
    ///
    /// - Parameter threadId: The thread identifier
    /// - Returns: Number of messages, or 0 if thread doesn't exist
    public func count(for threadId: String) -> Int {
        threadHistories[threadId]?.count ?? 0
    }

    /// Returns all active thread IDs.
    ///
    /// - Returns: Array of thread IDs that have conversation history
    public func allThreadIds() -> [String] {
        Array(threadHistories.keys)
    }
}
