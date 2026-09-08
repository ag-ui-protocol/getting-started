// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Enumeration of all event types in the AG-UI protocol that can be received from or sent to an AG-UI agent.
///
/// Each case corresponds to a specific event type in the protocol specification.
/// The raw value is the exact string used in the JSON "type" field.
///
/// ## Event Categories
/// - **Lifecycle**: `runStarted`, `runFinished`, `runError`, `stepStarted`, `stepFinished`
/// - **Text Messages**: `textMessageStart`, `textMessageContent`, `textMessageEnd`, `textMessageChunk`
/// - **Tool Calls**: `toolCallStart`, `toolCallArgs`, `toolCallEnd`, `toolCallResult`, `toolCallChunk`
/// - **State**: `stateSnapshot`, `stateDelta`, `messagesSnapshot`
/// - **Reasoning**: `reasoningStart`, `reasoningMessageStart`, `reasoningMessageContent`, `reasoningMessageEnd`, `reasoningMessageChunk`, `reasoningEnd`, `reasoningEncryptedValue`
/// - **Activity**: `activitySnapshot`, `activityDelta`
/// - **Special**: `raw`, `custom`

public enum EventType: String, Codable, CaseIterable, Sendable {
    // MARK: - Lifecycle Events (5)

    /// Agent run has started
    case runStarted = "RUN_STARTED"

    /// Agent run has completed successfully
    case runFinished = "RUN_FINISHED"

    /// Agent run encountered an error
    case runError = "RUN_ERROR"

    /// Agent step has started
    case stepStarted = "STEP_STARTED"

    /// Agent step has finished
    case stepFinished = "STEP_FINISHED"

    // MARK: - Text Message Events (4)

    /// Text message generation started
    case textMessageStart = "TEXT_MESSAGE_START"

    /// Text message content received
    case textMessageContent = "TEXT_MESSAGE_CONTENT"

    /// Text message generation finished
    case textMessageEnd = "TEXT_MESSAGE_END"

    /// Chunk of text message received
    case textMessageChunk = "TEXT_MESSAGE_CHUNK"

    // MARK: - Tool Call Events (5)

    /// Tool call started
    case toolCallStart = "TOOL_CALL_START"

    /// Tool call arguments received
    case toolCallArgs = "TOOL_CALL_ARGS"

    /// Tool call finished
    case toolCallEnd = "TOOL_CALL_END"

    /// Tool call result received
    case toolCallResult = "TOOL_CALL_RESULT"

    /// Chunk of tool call data received
    case toolCallChunk = "TOOL_CALL_CHUNK"

    // MARK: - State Management Events (3)

    /// State snapshot received
    case stateSnapshot = "STATE_SNAPSHOT"

    /// Incremental state update received
    case stateDelta = "STATE_DELTA"

    /// Messages snapshot received
    case messagesSnapshot = "MESSAGES_SNAPSHOT"

    // MARK: - Reasoning Events (7)

    /// Reasoning phase started.
    case reasoningStart = "REASONING_START"

    /// Reasoning message generation started.
    case reasoningMessageStart = "REASONING_MESSAGE_START"

    /// Reasoning message content received.
    case reasoningMessageContent = "REASONING_MESSAGE_CONTENT"

    /// Reasoning message generation finished.
    case reasoningMessageEnd = "REASONING_MESSAGE_END"

    /// Chunk of reasoning message received.
    case reasoningMessageChunk = "REASONING_MESSAGE_CHUNK"

    /// Reasoning phase ended.
    case reasoningEnd = "REASONING_END"

    /// Encrypted reasoning value attached to a message or tool call.
    case reasoningEncryptedValue = "REASONING_ENCRYPTED_VALUE"

    // MARK: - Special Events (2)

    /// Raw untyped event
    case raw = "RAW"

    /// Custom event type
    case custom = "CUSTOM"

    // MARK: - Activity Events (2)

    /// Activity snapshot received
    case activitySnapshot = "ACTIVITY_SNAPSHOT"

    /// Incremental activity update received
    case activityDelta = "ACTIVITY_DELTA"

    // MARK: - Internal Sentinel (1)

    /// Sentinel type returned by ``UnknownEvent`` for events that could not be decoded.
    ///
    /// The raw value `"__UNKNOWN__"` is deliberately not a valid AG-UI wire-format string,
    /// ensuring it never collides with genuine ``EventType/raw`` events.
    ///
    /// - Note: This case is an implementation detail. Consumer code should check `event is UnknownEvent`
    ///   rather than switching on `.unknown` directly.
    case unknown = "__UNKNOWN__"
}
