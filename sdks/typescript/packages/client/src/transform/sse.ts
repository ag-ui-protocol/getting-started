import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Maximum size the framing buffer is allowed to reach before the stream fails.
 *
 * The buffer holds the tail after the last \n\n, so a response that never sends a
 * boundary grows it to the size of the whole response. Mirrors
 * SseParser::kMaxBufferSize in the C++ SDK
 * (sdks/community/c++/src/stream/sse_parser.h), which caps the same
 * accumulation at 10 MB.
 *
 * Counted in decoded characters rather than bytes, because the buffer is
 * already a string at the point of the check.
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Parses a stream of HTTP events into a stream of JSON objects using Server-Sent Events (SSE) format.
 * Strictly follows the SSE standard where:
 * - Events are separated by double newlines ('\n\n')
 * - Only 'data:' prefixed lines are processed
 * - Multi-line data events are supported and joined
 * - Non-data fields (event, id, retry) are ignored
 */
export const parseSSEStream = (
  source$: Observable<HttpEvent>,
  debugLogger?: DebugLoggerInput,
  // DEFERRED (PNI-272): this is the exported stream element type; changing it
  // to `unknown` ripples into every consumer of parseSSEStream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Observable<any> => {
  const log = resolveDebugLogger(debugLogger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the exported Observable<any> above
  const jsonSubject = new Subject<any>();
  // Create TextDecoder with stream option set to true to handle split UTF-8 characters
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";

  // Subscribe to the source once and multicast to all subscribers
  source$.subscribe({
    next: (event: HttpEvent) => {
      if (event.type === HttpEventType.HEADERS) {
        return;
      }

      if (event.type === HttpEventType.DATA && event.data) {
        // Decode chunk carefully to handle UTF-8
        const text = decoder.decode(event.data, { stream: true });

        // Checked before the append, so the buffer never passes the limit even
        // briefly. The tail is the only accumulator here: without a boundary it
        // is never released, so one check covers the whole decoder.
        if (buffer.length + text.length > MAX_BUFFER_SIZE) {
          jsonSubject.error(
            new Error(
              `SSE buffer size exceeded maximum limit of ${MAX_BUFFER_SIZE / (1024 * 1024)} MB`,
            ),
          );
          return;
        }

        buffer += text;

        // Process complete events (separated by double newlines)
        const events = buffer.split(/\n\n/);
        // Keep the last potentially incomplete event in buffer
        buffer = events.pop() || "";

        for (const event of events) {
          processSSEEvent(event);
        }
      }
    },
    error: (err) => jsonSubject.error(err),
    complete: () => {
      // Use the final call to decoder.decode() to flush any remaining bytes
      if (buffer) {
        buffer += decoder.decode();
        // Process any remaining SSE event data
        processSSEEvent(buffer);
      }
      jsonSubject.complete();
    },
  });

  /**
   * Helper function to process an SSE event.
   * Extracts and joins data lines, then parses the result as JSON.
   *
   * Follows the SSE spec by processing lines starting with 'data:',
   * ignoring a single space if it is present after the colon.
   *
   * @param eventText The raw event text to process
   */
  function processSSEEvent(eventText: string) {
    const lines = eventText.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        // Remove 'data:' prefix, and optionally a single space afterwards
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    // Only process if we have data lines
    if (dataLines.length > 0) {
      try {
        // Join multi-line data and parse JSON
        const jsonStr = dataLines.join("\n");
        const json = JSON.parse(jsonStr);
        log?.event("SSE", "Event received:", json, { type: json.type });
        jsonSubject.next(json);
      } catch (err) {
        jsonSubject.error(err);
      }
    }
  }

  return jsonSubject.asObservable();
};
