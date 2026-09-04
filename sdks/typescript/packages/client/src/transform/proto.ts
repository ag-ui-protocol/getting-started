import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { BaseEvent } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Parses a stream of HTTP events into a stream of BaseEvent objects using Protocol Buffer format.
 * Each message is prefixed with a 4-byte length header (uint32 in big-endian format)
 * followed by the protocol buffer encoded message.
 */
// The same switch the enforcement stage reads, so one variable silences both
// halves of what is really one decision about unrecognised material.
const suppressWarnings = (): boolean =>
  typeof process !== "undefined" &&
  typeof process.env !== "undefined" &&
  Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS);

export const parseProtoStream = (
  source$: Observable<HttpEvent>,
  debugLogger?: DebugLoggerInput,
): Observable<BaseEvent> => {
  const log = resolveDebugLogger(debugLogger);
  const eventSubject = new Subject<BaseEvent>();
  let buffer = new Uint8Array(0);
  // A decode failure leaves its frame in the buffer, so without this the
  // stream end would blame the leftovers on truncation and report the wrong
  // cause for a stream that had already failed for a different reason.
  let failed = false;

  source$.subscribe({
    next: (event: HttpEvent) => {
      if (event.type === HttpEventType.HEADERS) {
        return;
      }

      if (event.type === HttpEventType.DATA && event.data) {
        // Append the new data to our buffer
        const newBuffer = new Uint8Array(buffer.length + event.data.length);
        newBuffer.set(buffer, 0);
        newBuffer.set(event.data, buffer.length);
        buffer = newBuffer;

        // Process as many complete messages as possible
        processBuffer();
      }
    },
    error: (err) => eventSubject.error(err),
    complete: () => {
      // Drain whatever whole frames are left, then account for the remainder.
      // A short final frame never throws — the framing loop just breaks,
      // waiting for bytes that will not come — so nothing but this check can
      // notice it. Losing a message and completing anyway would report success
      // for a stream that was cut in half.
      processBuffer();
      if (failed) return;
      if (buffer.length > 0) {
        eventSubject.error(
          new Error(
            `The binary stream ended mid-frame: ${buffer.length} trailing bytes could not be read as a complete message.`,
          ),
        );
        return;
      }
      eventSubject.complete();
    },
  });

  /**
   * Process as many complete messages as possible from the buffer
   */
  function processBuffer() {
    // Once the stream has failed the undecodable frame is still at the head of
    // the buffer; re-entering would re-read it for every chunk that follows.
    if (failed) return;
    // Keep processing while we have enough data for at least a header (4 bytes)
    while (buffer.length >= 4) {
      // Read message length from the first 4 bytes (big-endian uint32)
      const view = new DataView(buffer.buffer, buffer.byteOffset, 4);
      const messageLength = view.getUint32(0, false); // false = big-endian

      // Check if we have the complete message (header + message body)
      const totalLength = 4 + messageLength;
      if (buffer.length < totalLength) {
        // Not enough data yet, wait for more
        break;
      }

      try {
        // Extract the message (skipping the 4-byte header)
        const message = buffer.slice(4, totalLength);

        // Decode the protocol buffer message using the imported decode function
        const event = proto.decode(message);

        // Emit the parsed event
        log?.event("PROTO", "Event received:", event, { type: event.type });
        eventSubject.next(event);
      } catch (error: unknown) {
        // An event this build was never compiled against is not a failure. The
        // SSE reader hands the same event on to enforcement, which drops it
        // with a warning and leaves the run alive; the binary reader cannot
        // hand it on, because an unknown envelope arm carries no type string.
        // Dropping the frame here is that same answer spelled for this
        // transport — otherwise a producer that adds one event kills every
        // binary client while text clients carry on untouched.
        if (error instanceof proto.AGUIUnknownEventTypeError) {
          if (!suppressWarnings()) {
            console.warn(
              "[ag-ui][proto] Dropped an event this build does not know: the protocol has a variant this SDK predates.",
            );
          }
        } else {
          const errorMessage = error instanceof Error ? error.message : String(error);
          failed = true;
          eventSubject.error(
            new Error(`Failed to decode protocol buffer message: ${errorMessage}`),
          );
          return;
        }
      }

      // Remove the processed message from the buffer, dropped frames included:
      // leaving one in place would re-read it forever.
      buffer = buffer.slice(totalLength);
    }
  }

  return eventSubject.asObservable();
};
