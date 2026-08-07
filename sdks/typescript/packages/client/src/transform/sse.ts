import { Observable } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

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
): Observable<any> => {
  const log = resolveDebugLogger(debugLogger);
  return new Observable<any>((subscriber) => {
    // Create TextDecoder with stream option set to true to handle split UTF-8 characters
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffer = "";

    const subscription = source$.subscribe({
      next: (event: HttpEvent) => {
        if (event.type === HttpEventType.HEADERS) {
          return;
        }

        if (event.type === HttpEventType.DATA && event.data) {
          // Decode chunk carefully to handle UTF-8
          const text = decoder.decode(event.data, { stream: true });
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
      error: (err) => subscriber.error(err),
      complete: () => {
        // Use the final call to decoder.decode() to flush any remaining bytes
        if (buffer) {
          buffer += decoder.decode();
          // Process any remaining SSE event data
          processSSEEvent(buffer);
        }
        subscriber.complete();
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
          subscriber.next(json);
        } catch (err) {
          subscriber.error(err);
        }
      }
    }

    return () => subscription.unsubscribe();
  });
};
