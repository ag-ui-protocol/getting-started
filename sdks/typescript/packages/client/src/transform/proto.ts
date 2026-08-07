import { Observable } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { BaseEvent } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";

/**
 * Parses a stream of HTTP events into a stream of BaseEvent objects using Protocol Buffer format.
 * Each message is prefixed with a 4-byte length header (uint32 in big-endian format)
 * followed by the protocol buffer encoded message.
 */
export const parseProtoStream = (source$: Observable<HttpEvent>): Observable<BaseEvent> => {
  return new Observable<BaseEvent>((subscriber) => {
    let buffer = new Uint8Array(0);

    const subscription = source$.subscribe({
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
      error: (err) => subscriber.error(err),
      complete: () => {
        // Try to process any remaining data in the buffer
        if (buffer.length > 0) {
          try {
            processBuffer();
          } catch (error: unknown) {
            console.warn("Incomplete or invalid protocol buffer data at stream end");
          }
        }
        subscriber.complete();
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
          subscriber.next(event);

          // Remove the processed message from the buffer
          buffer = buffer.slice(totalLength);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          subscriber.error(new Error(`Failed to decode protocol buffer message: ${errorMessage}`));
          return;
        }
      }
    }

    return () => subscription.unsubscribe();
  });
};
