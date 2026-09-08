// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIClient
import XCTest

final class ChunkTransformTests: XCTestCase {

    // MARK: - Text Message Chunk Tests

    func testTransformSingleTextChunk() async throws {
        // Given: A stream with a single text chunk
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(
                messageId: "msg1",
                role: "assistant",
                delta: "Hello",
                timestamp: 1000
            ),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should emit start, content, and end
        XCTAssertEqual(transformed.count, 3)

        guard let start = transformed[0] as? TextMessageStartEvent else {
            XCTFail("Expected TextMessageStartEvent")
            return
        }
        XCTAssertEqual(start.messageId, "msg1")
        XCTAssertEqual(start.role, "assistant")
        XCTAssertEqual(start.timestamp, 1000)

        guard let content = transformed[1] as? TextMessageContentEvent else {
            XCTFail("Expected TextMessageContentEvent")
            return
        }
        XCTAssertEqual(content.messageId, "msg1")
        XCTAssertEqual(content.delta, "Hello")

        guard let end = transformed[2] as? TextMessageEndEvent else {
            XCTFail("Expected TextMessageEndEvent")
            return
        }
        XCTAssertEqual(end.messageId, "msg1")
    }

    func testTransformMultipleTextChunks() async throws {
        // Given: A stream with multiple text chunks for same message
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "assistant", delta: "Hello", timestamp: 1000),
            TextMessageChunkEvent(delta: " world", timestamp: 1001),
            TextMessageChunkEvent(delta: "!", timestamp: 1002),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should emit start, multiple contents, and end
        XCTAssertEqual(transformed.count, 5) // start + 3 contents + end

        XCTAssertTrue(transformed[0] is TextMessageStartEvent)
        XCTAssertTrue(transformed[1] is TextMessageContentEvent)
        XCTAssertTrue(transformed[2] is TextMessageContentEvent)
        XCTAssertTrue(transformed[3] is TextMessageContentEvent)
        XCTAssertTrue(transformed[4] is TextMessageEndEvent)

        guard let content1 = transformed[1] as? TextMessageContentEvent,
              let content2 = transformed[2] as? TextMessageContentEvent,
              let content3 = transformed[3] as? TextMessageContentEvent else {
            XCTFail("Expected TextMessageContentEvent")
            return
        }

        XCTAssertEqual(content1.delta, "Hello")
        XCTAssertEqual(content2.delta, " world")
        XCTAssertEqual(content3.delta, "!")
    }

    func testTransformTextChunkWithEmptyDelta() async throws {
        // Given: Text chunk with empty delta
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "assistant", delta: "", timestamp: 1000),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should only emit start and end (no content for empty delta)
        XCTAssertEqual(transformed.count, 2)
        XCTAssertTrue(transformed[0] is TextMessageStartEvent)
        XCTAssertTrue(transformed[1] is TextMessageEndEvent)
    }

    func testTransformTextChunkWithNilDelta() async throws {
        // Given: Text chunk with nil delta
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "assistant", delta: nil, timestamp: 1000),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should only emit start and end
        XCTAssertEqual(transformed.count, 2)
        XCTAssertTrue(transformed[0] is TextMessageStartEvent)
        XCTAssertTrue(transformed[1] is TextMessageEndEvent)
    }

    // MARK: - Tool Call Chunk Tests

    func testTransformSingleToolCallChunk() async throws {
        // Given: A stream with a single tool call chunk
        let events: [any AGUIEvent] = [
            ToolCallChunkEvent(
                toolCallId: "tool1",
                toolCallName: "calculator",
                delta: "{\"x\":5}",
                timestamp: 2000
            ),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should emit start, args, and end
        XCTAssertEqual(transformed.count, 3)

        guard let start = transformed[0] as? ToolCallStartEvent else {
            XCTFail("Expected ToolCallStartEvent")
            return
        }
        XCTAssertEqual(start.toolCallId, "tool1")
        XCTAssertEqual(start.toolCallName, "calculator")
        XCTAssertEqual(start.timestamp, 2000)

        guard let args = transformed[1] as? ToolCallArgsEvent else {
            XCTFail("Expected ToolCallArgsEvent")
            return
        }
        XCTAssertEqual(args.toolCallId, "tool1")
        XCTAssertEqual(args.delta, "{\"x\":5}")

        guard let end = transformed[2] as? ToolCallEndEvent else {
            XCTFail("Expected ToolCallEndEvent")
            return
        }
        XCTAssertEqual(end.toolCallId, "tool1")
    }

    func testTransformMultipleToolCallChunks() async throws {
        // Given: Multiple tool call chunks for same tool
        let events: [any AGUIEvent] = [
            ToolCallChunkEvent(toolCallId: "tool1", toolCallName: "calculator", delta: "{", timestamp: 2000),
            ToolCallChunkEvent(delta: "\"x\"", timestamp: 2001),
            ToolCallChunkEvent(delta: ":5}", timestamp: 2002),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should emit start, multiple args, and end
        XCTAssertEqual(transformed.count, 5)

        XCTAssertTrue(transformed[0] is ToolCallStartEvent)
        XCTAssertTrue(transformed[1] is ToolCallArgsEvent)
        XCTAssertTrue(transformed[2] is ToolCallArgsEvent)
        XCTAssertTrue(transformed[3] is ToolCallArgsEvent)
        XCTAssertTrue(transformed[4] is ToolCallEndEvent)
    }

    // MARK: - Mixed Chunk Tests

    func testTransformInterleavedTextAndToolChunks() async throws {
        // Given: Interleaved text and tool chunks
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "assistant", delta: "Let me calculate", timestamp: 1000),
            ToolCallChunkEvent(toolCallId: "tool1", toolCallName: "calculator", delta: "{\"x\":5}", timestamp: 2000),
            TextMessageChunkEvent(messageId: "msg2", role: "assistant", delta: "The result is", timestamp: 3000),
        ]

        // When: Transforming chunks
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Should properly close previous sequences
        XCTAssertTrue(transformed[0] is TextMessageStartEvent) // msg1 start
        XCTAssertTrue(transformed[1] is TextMessageContentEvent) // msg1 content
        XCTAssertTrue(transformed[2] is TextMessageEndEvent) // msg1 end (closed by tool)
        XCTAssertTrue(transformed[3] is ToolCallStartEvent) // tool1 start
        XCTAssertTrue(transformed[4] is ToolCallArgsEvent) // tool1 args
        XCTAssertTrue(transformed[5] is ToolCallEndEvent) // tool1 end (closed by msg2)
        XCTAssertTrue(transformed[6] is TextMessageStartEvent) // msg2 start
        XCTAssertTrue(transformed[7] is TextMessageContentEvent) // msg2 content
        XCTAssertTrue(transformed[8] is TextMessageEndEvent) // msg2 end (stream end)
    }

    // MARK: - Passthrough Tests

    func testPassthroughExistingStartContentEnd() async throws {
        // Given: Stream with existing start/content/end events
        let events: [any AGUIEvent] = [
            TextMessageStartEvent(messageId: "msg1", role: "assistant", timestamp: 1000),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello", timestamp: 1001),
            TextMessageEndEvent(messageId: "msg1", timestamp: 1002),
        ]

        // When: Transforming (should pass through)
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Events should pass through unchanged
        XCTAssertEqual(transformed.count, 3)
        XCTAssertTrue(transformed[0] is TextMessageStartEvent)
        XCTAssertTrue(transformed[1] is TextMessageContentEvent)
        XCTAssertTrue(transformed[2] is TextMessageEndEvent)
    }

    func testPassthroughMixedChunksAndExistingEvents() async throws {
        // Given: Mix of chunks and existing events
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "assistant", delta: "Chunk", timestamp: 1000),
            TextMessageStartEvent(messageId: "msg2", role: "assistant", timestamp: 2000),
            TextMessageContentEvent(messageId: "msg2", delta: "Direct", timestamp: 2001),
            TextMessageEndEvent(messageId: "msg2", timestamp: 2002),
        ]

        // When: Transforming
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Chunk should be transformed, existing events pass through
        XCTAssertTrue(transformed[0] is TextMessageStartEvent) // from chunk
        XCTAssertTrue(transformed[1] is TextMessageContentEvent) // from chunk
        XCTAssertTrue(transformed[2] is TextMessageEndEvent) // from chunk (closed by msg2 start)
        XCTAssertTrue(transformed[3] is TextMessageStartEvent) // msg2 passthrough
        XCTAssertTrue(transformed[4] is TextMessageContentEvent) // msg2 passthrough
        XCTAssertTrue(transformed[5] is TextMessageEndEvent) // msg2 passthrough
    }

    // MARK: - Error Tests

    func testTransformTextChunkWithoutMessageIdThrows() async throws {
        // Given: Text chunk without messageId
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: nil, role: "assistant", delta: "Hello", timestamp: 1000),
        ]

        // When/Then: Should throw error
        do {
            _ = try await collectEvents(events.asyncStream.transformChunks())
            XCTFail("Expected ChunkTransformError.missingMessageId")
        } catch ChunkTransformError.missingMessageId {
            // Expected
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testTransformToolCallChunkWithoutIdThrows() async throws {
        // Given: Tool chunk without toolCallId
        let events: [any AGUIEvent] = [
            ToolCallChunkEvent(toolCallId: nil, toolCallName: "calculator", delta: "{}", timestamp: 2000),
        ]

        // When/Then: Should throw error
        do {
            _ = try await collectEvents(events.asyncStream.transformChunks())
            XCTFail("Expected ChunkTransformError.missingToolCallInfo")
        } catch ChunkTransformError.missingToolCallInfo {
            // Expected
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testTransformToolCallChunkWithoutNameThrows() async throws {
        // Given: Tool chunk without toolCallName
        let events: [any AGUIEvent] = [
            ToolCallChunkEvent(toolCallId: "tool1", toolCallName: nil, delta: "{}", timestamp: 2000),
        ]

        // When/Then: Should throw error
        do {
            _ = try await collectEvents(events.asyncStream.transformChunks())
            XCTFail("Expected ChunkTransformError.missingToolCallInfo")
        } catch ChunkTransformError.missingToolCallInfo {
            // Expected
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    // MARK: - Role Preservation Tests

    func testRolePreservationFromChunk() async throws {
        // Given: Chunk with custom role
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: "user", delta: "Hello", timestamp: 1000),
        ]

        // When: Transforming
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Role should be preserved
        guard let start = transformed[0] as? TextMessageStartEvent else {
            XCTFail("Expected TextMessageStartEvent")
            return
        }
        XCTAssertEqual(start.role, "user")
    }

    func testRoleDefaultsToAssistant() async throws {
        // Given: Chunk without role
        let events: [any AGUIEvent] = [
            TextMessageChunkEvent(messageId: "msg1", role: nil, delta: "Hello", timestamp: 1000),
        ]

        // When: Transforming
        let transformed = try await collectEvents(events.asyncStream.transformChunks())

        // Then: Role should default to assistant
        guard let start = transformed[0] as? TextMessageStartEvent else {
            XCTFail("Expected TextMessageStartEvent")
            return
        }
        XCTAssertEqual(start.role, "assistant")
    }

    // MARK: - Helper Methods

    private func collectEvents(_ stream: AsyncThrowingStream<any AGUIEvent, Error>) async throws -> [any AGUIEvent] {
        var events: [any AGUIEvent] = []
        for try await event in stream {
            events.append(event)
        }
        return events
    }
}

// MARK: - Array AsyncSequence Extension

extension Array {
    var asyncStream: AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream { continuation in
            for element in self {
                continuation.yield(element)
            }
            continuation.finish()
        }
    }
}
