import { Observable, Subject } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { BaseEvent } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";

/**
 * Maximum size the framing buffer is allowed to reach before the stream fails.
 *
 * processBuffer waits until the buffer holds the whole message named by the
 * 4-byte length prefix, so a prefix that is never satisfied grows the buffer
 * without bound. Mirrors SseParser::kMaxBufferSize in the C++ SDK
 * (sdks/community/c++/src/stream/sse_parser.h), which caps the same
 * accumulation at 10 MB.
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Parses a stream of HTTP events into a stream of BaseEvent objects using Protocol Buffer format.
 * Each message is prefixed with a 4-byte length header (uint32 in big-endian format)
 * followed by the protocol buffer encoded message.
 */
export const parseProtoStream = (source$: Observable<HttpEvent>): Observable<BaseEvent> => {
  const eventSubject = new Subject<BaseEvent>();
  let buffer = new Uint8Array(0);

  source$.subscribe({
    next: (event: HttpEvent) => {
      if (event.type === HttpEventType.HEADERS) {
        return;
      }

      if (event.type === HttpEventType.DATA && event.data) {
        // Checked before the allocation, so the buffer never passes the limit
        // even briefly.
        if (buffer.length + event.data.length > MAX_BUFFER_SIZE) {
          eventSubject.error(
            new Error(
              `Protobuf buffer size exceeded maximum limit of ${MAX_BUFFER_SIZE / (1024 * 1024)} MB`,
            ),
          );
          return;
        }

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
      // Try to process any remaining data in the buffer
      if (buffer.length > 0) {
        try {
          processBuffer();
        } catch (_error: unknown) {
          console.warn("Incomplete or invalid protocol buffer data at stream end");
        }
      }
      eventSubject.complete();
    },
  });

  /**
   * Process as many complete messages as possible from the buffer
   */
  function processBuffer() {
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
        eventSubject.next(event);

        // Remove the processed message from the buffer
        buffer = buffer.slice(totalLength);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        eventSubject.error(new Error(`Failed to decode protocol buffer message: ${errorMessage}`));
        return;
      }
    }
  }

  return eventSubject.asObservable();
};
