// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Incremental parser for Server-Sent Events (SSE) streams.
///
/// `SseParser` is a stateful parser that handles SSE data arriving in
/// arbitrary chunks. It maintains an internal buffer for incomplete events
/// and returns complete events as they become available.
///
/// ## Usage
///
/// ```swift
/// var parser = SseParser()
///
/// // Parse chunks as they arrive
/// for chunk in streamChunks {
///     let events = parser.parse(chunk)
///     for event in events {
///         print("Received: \(event.data)")
///     }
/// }
/// ```
///
/// ## SSE Format
///
/// Server-Sent Events use a line-based format:
/// - Lines starting with `data:` contain the payload
/// - Lines starting with `id:` specify the event ID
/// - Lines starting with `event:` specify the event type
/// - Lines starting with `:` are comments (ignored)
/// - Empty line (double newline) signals end of event
/// - Multiple `data:` lines are concatenated with newlines
///
/// ## Example Input
///
/// ```
/// data: {"type":"MESSAGE","content":"Hello"}
///
/// event: notification
/// id: 123
/// data: {"alert":"New message"}
///
/// ```
///
/// ## Thread Safety
///
/// `SseParser` is a mutable struct and not thread-safe. Each thread
/// should maintain its own parser instance.
///
/// ## Reference
///
/// SSE specification: https://html.spec.whatwg.org/multipage/server-sent-events.html
/// Errors thrown by ``SseParser``.
public enum SseParserError: Error, Sendable {
    /// The internal buffer exceeded the maximum byte limit.
    ///
    /// All buffered data has been discarded. This indicates a broken or malicious
    /// connection that is sending data without the double-newline event delimiter.
    /// The stream should be treated as unrecoverable and terminated.
    ///
    /// - Parameter limit: The byte limit that was exceeded (``SseParser/maxBufferByteCount``).
    case bufferOverflow(limit: Int)
}

public struct SseParser {
    /// Maximum number of UTF-8 bytes the internal buffer may hold.
    ///
    /// If a stream sends data faster than complete events arrive — or sends a
    /// pathologically large payload without a double-newline terminator — the
    /// buffer is reset and a ``SseParserError/bufferOverflow(limit:)`` error is
    /// thrown. This prevents unbounded memory growth from malformed or malicious
    /// streams.
    public static let maxBufferByteCount = 10 * 1_048_576 // 10 MB

    /// Internal buffer for incomplete events.
    private var buffer: String = ""

    /// Creates a new SSE parser.
    public init() {}

    /// Parses a chunk of SSE data and returns complete events.
    ///
    /// This method is designed for incremental parsing of streaming data.
    /// Incomplete events are buffered internally and will be completed
    /// when subsequent chunks arrive.
    ///
    /// - Parameter chunk: A chunk of SSE text data
    /// - Returns: Array of complete events parsed from this chunk
    ///
    /// ## Example
    ///
    /// ```swift
    /// var parser = SseParser()
    ///
    /// // First chunk: incomplete event
    /// var events = parser.parse("data: {\"te")
    /// // returns: []
    ///
    /// // Second chunk: completes the event
    /// events = parser.parse("st\":\"value\"}\n\n")
    /// // returns: [SseEvent(data: "{\"test\":\"value\"}")]
    /// ```
    ///
    /// ## Edge Cases
    ///
    /// - Empty chunks are handled gracefully
    /// - Partial UTF-8 sequences are preserved in buffer
    /// - Very long lines are supported
    /// - Multiple events in one chunk are all returned
    public mutating func parse(_ chunk: String) throws -> [SseEvent] {
        // Normalize all line endings to \n per SSE spec (WHATWG):
        // \r\n and \r are both valid line ending sequences.
        let normalized = chunk.replacingOccurrences(of: "\r\n", with: "\n")
                              .replacingOccurrences(of: "\r", with: "\n")
        buffer += normalized

        // Guard against unbounded buffer growth from malformed/malicious streams.
        // Discard buffered data and throw — a 10 MB buffer without an event
        // delimiter indicates a broken or malicious connection.
        guard buffer.utf8.count <= Self.maxBufferByteCount else {
            buffer = ""
            throw SseParserError.bufferOverflow(limit: Self.maxBufferByteCount)
        }

        var events: [SseEvent] = []

        // Split on double newline (event separator — handles \n\n after normalization)
        let parts = buffer.components(separatedBy: "\n\n")

        // Keep the last part in buffer (might be incomplete)
        buffer = parts.last ?? ""

        // Process complete events (all parts except the last)
        for part in parts.dropLast() where !part.isEmpty {
            if let event = parseEvent(part) {
                events.append(event)
            }
        }

        return events
    }

    /// Parses a single complete event from its text representation.
    ///
    /// - Parameter text: The event text (between double newlines)
    /// - Returns: Parsed event, or nil if no data field present
    private func parseEvent(_ text: String) -> SseEvent? {
        var dataLines: [String] = []
        var id: String?
        var eventType: String?
        var retry: Int?

        // Process each line in the event
        for line in text.components(separatedBy: "\n") {
            // Skip empty lines
            guard !line.isEmpty else { continue }

            // Comments start with ':'
            if line.hasPrefix(":") {
                continue
            }

            // Find the colon separator
            guard let colonIndex = line.firstIndex(of: ":") else {
                // Lines without colon are ignored per spec
                continue
            }

            let field = String(line[..<colonIndex])
            var value = String(line[line.index(after: colonIndex)...])

            // Remove single leading space after colon (per spec)
            if value.hasPrefix(" ") {
                value = String(value.dropFirst())
            }

            // Process field
            switch field {
            case "data":
                dataLines.append(value)
            case "event":
                eventType = value
            case "id":
                // Per WHATWG SSE spec §9.2.7: ignore if value contains U+0000 NULL.
                if !value.contains("\0") { id = value }
            case "retry":
                // Per spec §9.2.6: only set if the value is an ASCII integer; ignore otherwise.
                retry = Int(value)
            default:
                // Unknown fields are ignored per spec
                break
            }
        }

        // Events without data field are ignored
        guard !dataLines.isEmpty else {
            return nil
        }

        // Concatenate multiple data lines with newlines
        let data = dataLines.joined(separator: "\n")

        return SseEvent(
            data: data,
            id: id,
            event: eventType ?? "message",
            retry: retry
        )
    }

    /// Resets the parser, clearing any buffered incomplete events.
    ///
    /// Use this when starting a new stream or when an error requires
    /// discarding incomplete data.
    ///
    /// ## Example
    ///
    /// ```swift
    /// var parser = SseParser()
    /// _ = parser.parse("data: incomplete")
    ///
    /// // Discard buffered data
    /// parser.reset()
    ///
    /// // Start fresh
    /// let events = parser.parse("data: new\n\n")
    /// ```
    public mutating func reset() {
        buffer = ""
    }
}
