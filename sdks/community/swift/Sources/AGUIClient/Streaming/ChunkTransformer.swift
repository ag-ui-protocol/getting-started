// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - ChunkTransformError

/// Errors that can occur during chunk transformation.
public enum ChunkTransformError: Error, Sendable {
    /// A text chunk is missing the required messageId.
    case missingMessageId

    /// A tool call chunk is missing required information (toolCallId or toolCallName).
    case missingToolCallInfo
}

// MARK: - ChunkTransformer

/// Transforms chunk events into structured start/content/end sequences.
///
/// `ChunkTransformer` converts `TEXT_MESSAGE_CHUNK` and `TOOL_CALL_CHUNK` events
/// into complete protocol sequences with explicit start, content, and end events.
/// This ensures downstream processing can rely on standard event sequences regardless
/// of the upstream stream shape.
///
/// ## Behavior
///
/// - **Text Chunks**: Transformed into TextMessageStart → TextMessageContent(s) → TextMessageEnd
/// - **Tool Chunks**: Transformed into ToolCallStart → ToolCallArgs(s) → ToolCallEnd
/// - **Existing Events**: Pass through unchanged
/// - **Mode Switching**: Automatically closes pending sequences when switching between text/tool modes
///
/// ## Usage
///
/// ```swift
/// let transformed = events.transformChunks()
/// for try await event in transformed {
///     // Process structured events
/// }
/// ```
///
/// - SeeAlso: ``ChunkTransformError``
public struct ChunkTransformer {
    /// Creates a new chunk transformer.
    public init() {}

    /// Transforms a stream of events, converting chunks to structured sequences.
    ///
    /// - Parameter events: The source event stream
    /// - Returns: Transformed event stream with structured sequences
    /// - Throws: ``ChunkTransformError`` if chunks are malformed
    public func transform<S: AsyncSequence>(
        _ events: S
    ) -> AsyncThrowingStream<any AGUIEvent, Error> where S.Element == any AGUIEvent {
        AsyncThrowingStream { continuation in
            let task = Task {
                let transformer = EventTransformer(continuation: continuation)
                await transformer.processEvents(events)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - EventTransformer

/// Internal transformer that maintains state and processes events.
private actor EventTransformer {
    private var mode: ChunkMode?
    private var textState: TextState?
    private var toolState: ToolState?
    private let continuation: AsyncThrowingStream<any AGUIEvent, Error>.Continuation

    init(continuation: AsyncThrowingStream<any AGUIEvent, Error>.Continuation) {
        self.continuation = continuation
    }

    func processEvents<S: AsyncSequence>(_ events: S) async where S.Element == any AGUIEvent {
        do {
            for try await event in events {
                try await handleEvent(event)
            }
            closeAllPendingState()
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }

    private func handleEvent(_ event: any AGUIEvent) async throws {
        switch event {
        case let chunk as TextMessageChunkEvent:
            try handleTextChunk(chunk)
        case let chunk as ToolCallChunkEvent:
            try handleToolChunk(chunk)
        case is TextMessageStartEvent, is TextMessageContentEvent, is TextMessageEndEvent:
            handleTextEvent(event)
        case is ToolCallStartEvent, is ToolCallArgsEvent, is ToolCallEndEvent:
            handleToolEvent(event)
        default:
            handleOtherEvent(event)
        }
    }

    private func handleTextChunk(_ chunk: TextMessageChunkEvent) throws {
        let messageId = chunk.messageId

        // Check if we need to start a new message
        if mode != .text || (messageId != nil && messageId != textState?.messageId) {
            closePending(chunk)

            guard let id = messageId else {
                throw ChunkTransformError.missingMessageId
            }

            continuation.yield(TextMessageStartEvent(
                messageId: id,
                role: chunk.role ?? "assistant",
                timestamp: chunk.timestamp,
                rawEvent: chunk.rawEvent
            ))

            mode = .text
            textState = TextState(messageId: id, fromChunk: true)
        }

        // Emit content if delta is present and non-empty
        if let delta = chunk.delta, !delta.isEmpty {
            continuation.yield(TextMessageContentEvent(
                messageId: textState!.messageId,
                delta: delta,
                timestamp: chunk.timestamp,
                rawEvent: chunk.rawEvent
            ))
        }
    }

    private func handleToolChunk(_ chunk: ToolCallChunkEvent) throws {
        let toolId = chunk.toolCallId
        let toolName = chunk.toolCallName

        // Check if we need to start a new tool call
        if mode != .tool || (toolId != nil && toolId != toolState?.toolCallId) {
            closePending(chunk)

            guard let id = toolId, let name = toolName else {
                throw ChunkTransformError.missingToolCallInfo
            }

            continuation.yield(ToolCallStartEvent(
                toolCallId: id,
                toolCallName: name,
                parentMessageId: chunk.parentMessageId,
                timestamp: chunk.timestamp,
                rawEvent: chunk.rawEvent
            ))

            mode = .tool
            toolState = ToolState(toolCallId: id, fromChunk: true)
        }

        // Emit args if delta is present and non-empty
        if let delta = chunk.delta, !delta.isEmpty {
            continuation.yield(ToolCallArgsEvent(
                toolCallId: toolState!.toolCallId,
                delta: delta,
                timestamp: chunk.timestamp,
                rawEvent: chunk.rawEvent
            ))
        }
    }

    private func handleTextEvent(_ event: any AGUIEvent) {
        switch event {
        case let start as TextMessageStartEvent:
            closePending(event)
            mode = .text
            textState = TextState(messageId: start.messageId, fromChunk: false)
            continuation.yield(event)

        case let content as TextMessageContentEvent:
            mode = .text
            textState = TextState(messageId: content.messageId, fromChunk: false)
            continuation.yield(event)

        case is TextMessageEndEvent:
            textState = nil
            if mode == .text {
                mode = nil
            }
            continuation.yield(event)

        default:
            break
        }
    }

    private func handleToolEvent(_ event: any AGUIEvent) {
        switch event {
        case let start as ToolCallStartEvent:
            closePending(event)
            mode = .tool
            toolState = ToolState(toolCallId: start.toolCallId, fromChunk: false)
            continuation.yield(event)

        case let args as ToolCallArgsEvent:
            mode = .tool
            if toolState?.toolCallId == args.toolCallId {
                toolState?.fromChunk = false
            } else {
                toolState = ToolState(toolCallId: args.toolCallId, fromChunk: false)
            }
            continuation.yield(event)

        case is ToolCallEndEvent:
            toolState = nil
            if mode == .tool {
                mode = nil
            }
            continuation.yield(event)

        default:
            break
        }
    }

    private func handleOtherEvent(_ event: any AGUIEvent) {
        closePending(event)
        continuation.yield(event)
    }

    private func closeText(_ event: any AGUIEvent) {
        if let state = textState, state.fromChunk {
            continuation.yield(TextMessageEndEvent(
                messageId: state.messageId,
                timestamp: event.timestamp,
                rawEvent: event.rawEvent
            ))
        }
        textState = nil
        if mode == .text {
            mode = nil
        }
    }

    private func closeTool(_ event: any AGUIEvent) {
        if let state = toolState, state.fromChunk {
            continuation.yield(ToolCallEndEvent(
                toolCallId: state.toolCallId,
                timestamp: event.timestamp,
                rawEvent: event.rawEvent
            ))
        }
        toolState = nil
        if mode == .tool {
            mode = nil
        }
    }

    private func closePending(_ event: any AGUIEvent) {
        closeText(event)
        closeTool(event)
    }

    private func closeAllPendingState() {
        if textState != nil || toolState != nil {
            let finalEvent = RunFinishedEvent(
                threadId: "",
                runId: "",
                timestamp: nil,
                rawEvent: nil
            )
            closePending(finalEvent)
        }
    }
}

// MARK: - Internal State Types

private enum ChunkMode {
    case text
    case tool
}

private struct TextState {
    let messageId: String
    var fromChunk: Bool
}

private struct ToolState {
    let toolCallId: String
    var fromChunk: Bool
}

// MARK: - AsyncSequence Extension

extension AsyncSequence where Element == any AGUIEvent {
    /// Apply chunk transformation to the event stream.
    ///
    /// This method transforms `TEXT_MESSAGE_CHUNK` and `TOOL_CALL_CHUNK` events
    /// into structured start/content/end sequences.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let eventStream = httpAgent.run(input)
    /// let transformed = eventStream.transformChunks()
    ///
    /// for try await event in transformed {
    ///     switch event {
    ///     case let start as TextMessageStartEvent:
    ///         print("Message started: \(start.messageId)")
    ///     case let content as TextMessageContentEvent:
    ///         print("Content: \(content.delta)")
    ///     case let end as TextMessageEndEvent:
    ///         print("Message ended: \(end.messageId)")
    ///     default:
    ///         break
    ///     }
    /// }
    /// ```
    ///
    /// - Returns: Transformed event stream with structured sequences
    /// - Throws: ``ChunkTransformError`` if chunks are malformed
    public func transformChunks() -> AsyncThrowingStream<any AGUIEvent, Error> {
        ChunkTransformer().transform(self)
    }
}
