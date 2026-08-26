use crate::error::AgUiClientError;
use async_trait::async_trait;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use reqwest::Response;
use std::pin::Pin;

/// Maximum number of bytes held in the read buffer while waiting for a frame
/// delimiter.
///
/// Mirrors the Dart SDK's `kSseDefaultMaxDataCodeUnits` (8 MiB) so the community
/// SDKs bound an unterminated stream at the same point. Exceeding it clears the
/// buffer and surfaces an [`AgUiClientError::SseParse`].
pub const SSE_MAX_BUFFER_BYTES: usize = 8 * 1024 * 1024;

/// Represents a parsed Server-Sent Event
#[derive(Debug)]
pub struct SseEvent {
    /// The event type (from the "event:" field)
    pub event: Option<String>,

    /// The event ID (from the "id:" field)
    pub id: Option<String>,

    /// The event data (from the "data:" field)
    pub data: String,
}

/// Extension trait for processing Server-Sent Events (SSE) responses from reqwest::Response
///
/// This trait provides methods to process SSE responses as a stream of events with customizable
/// type parameters for event type, data, and id fields.
///
/// # SSE Format
///
/// Server-Sent Events typically follow this format:
/// ```text
/// event: ping
/// id: 1
/// data: {"message": "hello"}
///
/// event: update
/// id: 2
/// data: {"id": 123, "status": "ok"}
/// ```
///
/// Where:
/// - `event`: Optional field specifying the event type
/// - `id`: Optional field providing an event identifier
/// - `data`: The event payload, often JSON data
///
/// Events are separated by a blank line, i.e. two consecutive line terminators
/// (`\r\n`, `\n`, or `\r` in any combination).
#[async_trait]
pub trait SseResponseExt {
    /// Converts a reqwest::Response into a Stream of SSE events
    async fn event_source(
        self,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>>;
}

#[async_trait]
impl SseResponseExt for Response {
    async fn event_source(
        self,
    ) -> Pin<Box<dyn Stream<Item = Result<SseEvent, AgUiClientError>> + Send>> {
        // Create a stream of bytes from the response
        let stream = self.bytes_stream();

        // Process the stream with type conversions
        Box::pin(SseEventProcessor::new(stream))
    }
}

/// A processor that converts a byte stream into an SSE event stream
struct SseEventProcessor;

impl SseEventProcessor {
    /// Creates a new SSE event processor
    #[allow(clippy::new_ret_no_self)]
    fn new(
        stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + 'static,
    ) -> impl Stream<Item = Result<SseEvent, AgUiClientError>> {
        let mut buffer = String::new();
        // Set when a frame breaks the cap. Every later chunk is discarded, because the parser gave
        // up partway through a frame and no offset after that is a known boundary.
        let mut terminated = false;

        // Process the stream
        stream
            .map(move |chunk_result| {
                // Nothing after an overflow can be trusted to start on a frame boundary.
                if terminated {
                    return Vec::new();
                }

                // Map reqwest errors
                let chunk = match chunk_result {
                    Ok(chunk) => chunk,
                    Err(err) => return vec![Err(AgUiClientError::HttpTransport(err))],
                };

                // Convert bytes to string and append to buffer
                match String::from_utf8(chunk.to_vec()) {
                    Ok(text) => {
                        buffer.push_str(&text);

                        // Process complete events from the buffer, refusing any frame over the
                        // cap before it is parsed.
                        let (mut events, new_buffer, overflowed) =
                            process_raw_sse_events_capped(&buffer, SSE_MAX_BUFFER_BYTES);

                        if overflowed {
                            /*
                             * End the stream rather than carry on from an arbitrary offset.
                             *
                             * The parser was inside the frame that broke the cap, and the bytes
                             * after the point it gave up are the tail of that frame, not a new
                             * one. Clearing the buffer and continuing reads that tail as a frame
                             * of its own, so a sender could place anything it liked after the cap
                             * and have it dispatched as an event. There is no offset that is known
                             * to be a frame boundary, so there is nothing safe to resume from.
                             */
                            terminated = true;
                            buffer = String::new();
                            events.push(Err(AgUiClientError::SseParse {
                                message: format!(
                                    "SSE frame exceeded {SSE_MAX_BUFFER_BYTES} bytes; ending the stream"
                                ),
                            }));
                        } else {
                            buffer = new_buffer;
                        }

                        events
                    }
                    Err(e) => vec![Err(AgUiClientError::SseParse {
                        message: format!("Invalid UTF-8: {e}"),
                    })],
                }
            })
            .flat_map(futures::stream::iter)
    }
}

/// Process SSE data from a buffer string into raw SSE events
///
/// Returns a tuple of (events, new_buffer) where:
/// - events: A vector of parsed events or errors
/// - new_buffer: The remaining buffer that might contain incomplete events
/// Only the tests parse without a limit; the stream always applies one.
#[cfg(test)]
fn process_raw_sse_events(buffer: &str) -> (Vec<Result<SseEvent, AgUiClientError>>, String) {
    let (events, rest, _) = process_raw_sse_events_capped(buffer, usize::MAX);
    (events, rest)
}

/// As [`process_raw_sse_events`], with a per-frame size limit.
///
/// The limit is applied to each frame *before* it is parsed, and to the incomplete remainder
/// afterwards. Checking only the remainder is not the same thing: by then a frame larger than the
/// limit has already been parsed and handed to the caller, so the cap can be stepped over by
/// terminating the oversized frame instead of leaving it open.
///
/// The third element of the return is whether the limit was hit. On that path the remainder is
/// dropped, because the parser is somewhere inside a frame it refused and no later offset is known
/// to be a frame boundary.
fn process_raw_sse_events_capped(
    buffer: &str,
    max_frame_bytes: usize,
) -> (Vec<Result<SseEvent, AgUiClientError>>, String, bool) {
    let mut results = Vec::new();
    let mut rest = buffer;

    while let Some((frame_end, delimiter_len)) = find_frame_end(rest) {
        if frame_end > max_frame_bytes {
            return (results, String::new(), true);
        }
        let frame = &rest[..frame_end];
        if !frame.is_empty() {
            results.push(parse_sse_event(frame));
        }
        rest = &rest[frame_end + delimiter_len..];
    }

    // Whatever follows the last delimiter is an incomplete frame; keep buffering it, unless it has
    // already outgrown what any single frame is allowed to be.
    if rest.len() > max_frame_bytes {
        return (results, String::new(), true);
    }

    (results, rest.to_string(), false)
}

/// Length of the line terminator at `index`, if one starts there.
///
/// The SSE spec allows CRLF, LF, or a bare CR to end a line.
fn line_terminator_len(bytes: &[u8], index: usize) -> Option<usize> {
    match bytes.get(index)? {
        b'\r' if bytes.get(index + 1) == Some(&b'\n') => Some(2),
        b'\r' | b'\n' => Some(1),
        _ => None,
    }
}

/// Locate the first frame boundary, i.e. two consecutive line terminators.
///
/// Returns `(offset of the first terminator, combined length of both terminators)`,
/// or `None` when the buffer holds no complete frame yet.
fn find_frame_end(buffer: &str) -> Option<(usize, usize)> {
    let bytes = buffer.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        match line_terminator_len(bytes, index) {
            Some(first) => match line_terminator_len(bytes, index + first) {
                Some(second) => return Some((index, first + second)),
                None => index += first,
            },
            None => index += 1,
        }
    }

    None
}

/// Parse a single SSE event text into an SseEvent
fn parse_sse_event(event_text: &str) -> Result<SseEvent, AgUiClientError> {
    let mut event = None;
    let mut id = None;
    let mut data_lines = Vec::new();

    // Split on any spec-legal line terminator; CRLF yields an empty segment that the
    // emptiness check below skips.
    for line in event_text.split(['\r', '\n']) {
        if line.is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            id = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            // For data lines, trim a leading space if present
            let data_content = value.strip_prefix(" ").unwrap_or(value);
            data_lines.push(data_content);
        }
        // Ignore other fields like "retry:"
    }

    // Join all data lines with newlines
    let data = data_lines.join("\n");

    Ok(SseEvent { event, id, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize, Debug, PartialEq)]
    struct TestEvent {
        event_type: String,
        data: String,
    }

    #[tokio::test]
    async fn test_process_raw_sse_events() {
        // Test with a single complete event
        let buffer = "data: {\"event_type\":\"test\",\"data\":\"hello\"}\n\n";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(new_buffer, "");
        let event = events[0].as_ref().unwrap();
        assert_eq!(event.data, "{\"event_type\":\"test\",\"data\":\"hello\"}");

        // Test with multiple events
        let buffer = "data: {\"event_type\":\"test1\",\"data\":\"hello1\"}\n\n\
                      data: {\"event_type\":\"test2\",\"data\":\"hello2\"}\n\n";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(new_buffer, "");

        // Test with incomplete event
        let buffer = "data: {\"event_type\":\"test\",\"data\":\"hello\"}";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 0);
        assert_eq!(new_buffer, buffer);

        // Test with complete and incomplete events
        let buffer = "data: {\"event_type\":\"test1\",\"data\":\"hello1\"}\n\n\
                      data: {\"event_type\":\"test2\",\"data\":\"hello2\"}";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(
            new_buffer,
            "data: {\"event_type\":\"test2\",\"data\":\"hello2\"}"
        );
    }

    #[tokio::test]
    async fn test_process_raw_sse_events_crlf() {
        // A spec-legal CRLF-delimited stream must dispatch just like an LF one.
        let buffer = "event: ping\r\ndata: {\"message\":\"hello\"}\r\n\r\n\
                      event: update\r\nid: 7\r\ndata: {\"status\":\"ok\"}\r\n\r\n";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(new_buffer, "");

        let ping = events[0].as_ref().unwrap();
        assert_eq!(ping.event, Some("ping".to_string()));
        assert_eq!(ping.data, "{\"message\":\"hello\"}");

        let update = events[1].as_ref().unwrap();
        assert_eq!(update.event, Some("update".to_string()));
        assert_eq!(update.id, Some("7".to_string()));
        assert_eq!(update.data, "{\"status\":\"ok\"}");
    }

    #[tokio::test]
    async fn test_process_raw_sse_events_crlf_partial_frame_is_retained() {
        let buffer = "data: first\r\n\r\ndata: seco";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].as_ref().unwrap().data, "first");
        assert_eq!(new_buffer, "data: seco");
    }

    #[tokio::test]
    async fn test_process_raw_sse_events_bare_cr() {
        // A bare CR is also a spec-legal line terminator.
        let buffer = "event: ping\rdata: one\r\rdata: two\r\r";
        let (events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(new_buffer, "");
        assert_eq!(events[0].as_ref().unwrap().event, Some("ping".to_string()));
        assert_eq!(events[0].as_ref().unwrap().data, "one");
        assert_eq!(events[1].as_ref().unwrap().data, "two");
    }

    #[tokio::test]
    async fn test_buffer_is_capped_when_no_frame_ever_completes() {
        // A stream that never emits a frame delimiter must not grow without bound.
        let chunk_len = 1024 * 1024;
        let chunk_count = SSE_MAX_BUFFER_BYTES / chunk_len + 2;
        let chunks: Vec<Result<Bytes, reqwest::Error>> = (0..chunk_count)
            .map(|_| Ok(Bytes::from(vec![b'x'; chunk_len])))
            .collect();

        let results: Vec<_> = SseEventProcessor::new(futures::stream::iter(chunks))
            .collect::<Vec<_>>()
            .await;

        assert!(
            results
                .iter()
                .any(|r| matches!(r, Err(AgUiClientError::SseParse { .. }))),
            "expected an SseParse error once the buffer exceeded the cap"
        );
    }

    #[tokio::test]
    async fn test_frame_larger_than_the_cap_is_refused_not_emitted() {
        // The cap has to be decided before a frame is parsed. Checked afterwards, against only
        // what is left over, a frame that is itself over the cap has already been emitted.
        let oversized = "x".repeat(SSE_MAX_BUFFER_BYTES + 1);
        let chunks: Vec<Result<Bytes, reqwest::Error>> =
            vec![Ok(Bytes::from(format!("data: {oversized}\n\n")))];

        let results: Vec<_> = SseEventProcessor::new(futures::stream::iter(chunks))
            .collect::<Vec<_>>()
            .await;

        assert!(
            results
                .iter()
                .any(|r| matches!(r, Err(AgUiClientError::SseParse { .. }))),
            "expected an SseParse error for a frame over the cap"
        );
        assert!(
            !results.iter().any(|r| r.is_ok()),
            "an over-cap frame must not be emitted as an event"
        );
    }

    #[tokio::test]
    async fn test_stream_ends_after_an_overflow_rather_than_resynchronizing() {
        // Clearing the buffer on overflow forgets that the parser was inside a rejected frame, so
        // the tail of that frame reads as a new one. Both the forged tail and the frame after it
        // were emitted. Overflow now ends the stream.
        let oversized = "y".repeat(SSE_MAX_BUFFER_BYTES + 1);
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from(oversized)),
            Ok(Bytes::from(
                "data: forged tail\n\ndata: legitimate\n\n".to_string(),
            )),
        ];

        let results: Vec<_> = SseEventProcessor::new(futures::stream::iter(chunks))
            .collect::<Vec<_>>()
            .await;

        assert!(
            results
                .iter()
                .any(|r| matches!(r, Err(AgUiClientError::SseParse { .. }))),
            "expected an SseParse error once the cap was exceeded"
        );
        let emitted: Vec<&str> = results
            .iter()
            .filter_map(|r| r.as_ref().ok())
            .map(|e| e.data.as_str())
            .collect();
        assert!(
            emitted.is_empty(),
            "nothing may be emitted after an overflow, got {emitted:?}"
        );
    }

    #[tokio::test]
    async fn test_parse_sse_event() {
        // Test with event and data
        let event_text = "event: ping\ndata: {\"message\":\"hello\"}";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("ping".to_string()));
        assert_eq!(sse_event.id, None);
        assert_eq!(sse_event.data, "{\"message\":\"hello\"}");

        // Test with event, id, and data
        let event_text = "event: update\nid: 123\ndata: {\"status\":\"ok\"}";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("update".to_string()));
        assert_eq!(sse_event.id, Some("123".to_string()));
        assert_eq!(sse_event.data, "{\"status\":\"ok\"}");

        // Test with multi-line data
        let event_text = "event: message\ndata: line 1\ndata: line 2\ndata: line 3";
        let sse_event = parse_sse_event(event_text).unwrap();
        assert_eq!(sse_event.event, Some("message".to_string()));
        assert_eq!(sse_event.data, "line 1\nline 2\nline 3");
    }

    #[tokio::test]
    async fn test_different_event_types() {
        // Define different data structures for different event types
        #[derive(Deserialize, Debug, PartialEq)]
        struct PingData {
            message: String,
        }

        #[derive(Deserialize, Debug, PartialEq)]
        struct UpdateData {
            id: u32,
            status: String,
        }

        // Create a buffer with different event types
        let buffer = "event: ping\ndata: {\"message\":\"hello\"}\n\n\
                      event: update\ndata: {\"id\":123,\"status\":\"ok\"}\n\n";

        // Process the raw events
        let (raw_events, new_buffer) = process_raw_sse_events(buffer);
        assert_eq!(raw_events.len(), 2);
        assert_eq!(new_buffer, "");

        // Process each event based on its type
        let ping_event = raw_events[0].as_ref().unwrap();
        let update_event = raw_events[1].as_ref().unwrap();

        assert_eq!(ping_event.event, Some("ping".to_string()));
        assert_eq!(update_event.event, Some("update".to_string()));

        // Deserialize the ping event
        let ping_data: PingData = serde_json::from_str(&ping_event.data).unwrap();
        assert_eq!(
            ping_data,
            PingData {
                message: "hello".to_string()
            }
        );

        // Deserialize the update event
        let update_data: UpdateData = serde_json::from_str(&update_event.data).unwrap();
        assert_eq!(
            update_data,
            UpdateData {
                id: 123,
                status: "ok".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_enum_event_types() {
        // Define an enum for event types
        #[derive(Deserialize, Debug, PartialEq)]
        #[serde(rename_all = "lowercase")]
        enum EventType {
            Ping,
            Update,
            Message,
        }

        // Define a data structure
        #[derive(Deserialize, Debug, PartialEq)]
        struct EventData {
            value: String,
        }

        // Test direct deserialization with stream_with_types
        let buffer = "event: ping\ndata: {\"value\":\"ping data\"}\n\n\
                      event: update\ndata: {\"value\":\"update data\"}\n\n\
                      event: message\ndata: {\"value\":\"message data\"}\n\n";

        // Process the raw events
        let (raw_events, _) = process_raw_sse_events(buffer);
        assert_eq!(raw_events.len(), 3);

        // Parse event types as enum values
        for raw_event in raw_events {
            let sse_event = raw_event.unwrap();
            let event_type: EventType =
                serde_json::from_str(&format!("\"{}\"", sse_event.event.unwrap())).unwrap();
            let data: EventData = serde_json::from_str(&sse_event.data).unwrap();

            // Verify the event type matches the expected enum variant
            match event_type {
                EventType::Ping => assert_eq!(data.value, "ping data"),
                EventType::Update => assert_eq!(data.value, "update data"),
                EventType::Message => assert_eq!(data.value, "message data"),
            }
        }
    }
}
