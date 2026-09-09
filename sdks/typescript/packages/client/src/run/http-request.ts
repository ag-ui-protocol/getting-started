import { Observable, from, defer, throwError } from "rxjs";
import { switchMap } from "rxjs/operators";

export enum HttpEventType {
  HEADERS = "headers",
  DATA = "data",
}

export interface HttpDataEvent {
  type: HttpEventType.DATA;
  data?: Uint8Array;
}

export interface HttpHeadersEvent {
  type: HttpEventType.HEADERS;
  status: number;
  headers: Headers;
}

export type HttpEvent = HttpDataEvent | HttpHeadersEvent;

export const runHttpRequest = (
  fetchResponse: () => Promise<Response>,
): Observable<HttpEvent> => {
  // Defer the fetch so that it's executed when subscribed to
  return defer(() => from(fetchResponse())).pipe(
    switchMap((response) => {
      if (!response.ok) {
        return readHttpError(response);
      }
      // Emit headers event first
      const headersEvent: HttpHeadersEvent = {
        type: HttpEventType.HEADERS,
        status: response.status,
        headers: response.headers,
      };

      const reader = response.body?.getReader();
      if (!reader) {
        return throwError(() => new Error("Failed to getReader() from response"));
      }

      return new Observable<HttpEvent>((subscriber) => {
        // Emit headers event first
        subscriber.next(headersEvent);

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Emit data event instead of raw Uint8Array
              const dataEvent: HttpDataEvent = {
                type: HttpEventType.DATA,
                data: value,
              };
              subscriber.next(dataEvent);
            }
            subscriber.complete();
          } catch (error) {
            subscriber.error(error);
          }
        })();

        return () => {
          reader.cancel().catch((error) => {
            if ((error as DOMException)?.name === "AbortError") {
              return;
            }

            throw error;
          });
        };
      });
    }),
  );
};

// Bound both the decoded payload and the diagnostic copied into the message.
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 4 * 1024;
const TRUNCATED = " [truncated]";

function readHttpError(response: Response): Observable<never> {
  return new Observable((subscriber) => {
    const reader = response.body?.getReader();
    let finished = false;
    let cancelled = false;
    const cancel = () => {
      if (reader && !finished && !cancelled) {
        cancelled = true;
        // Cleanup must not replace the HTTP error or produce an unhandled rejection.
        void reader.cancel().catch(() => {});
      }
    };

    void (async () => {
      let text = "";
      let truncated = false;
      const decoder = new TextDecoder();
      try {
        let bytes = 0;
        if (reader) {
          while (!subscriber.closed) {
            const { done, value } = await reader.read();
            if (subscriber.closed) return;
            if (done) {
              finished = true;
              text += decoder.decode();
              break;
            }
            const accepted = value.subarray(0, MAX_ERROR_BODY_BYTES - bytes);
            text += decoder.decode(accepted, { stream: true });
            bytes += accepted.byteLength;
            if (bytes === MAX_ERROR_BODY_BYTES) {
              // Do not fetch another chunk to probe for EOF, or flush an
              // incomplete UTF-8 character at the preview boundary.
              truncated = true;
              cancel();
              break;
            }
          }
        }
        if (subscriber.closed) return;
        let payload: unknown = text;
        if (truncated) {
          payload = text + TRUNCATED;
        } else if (response.headers.get("content-type")?.includes("application/json")) {
          try {
            payload = JSON.parse(text);
          } catch {
            // Preserve the readable text for non-JSON error responses.
          }
        }
        const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
        const excerpt = detail.length > MAX_ERROR_MESSAGE_CHARS
          ? detail.slice(0, MAX_ERROR_MESSAGE_CHARS) + TRUNCATED
          : detail;
        const error: Error & { status?: number; payload?: unknown } = new Error(
          `HTTP ${response.status}: ${excerpt}`,
        );
        error.status = response.status;
        error.payload = payload;
        subscriber.error(error);
      } catch (error) {
        subscriber.error(error);
      } finally {
        cancel();
        reader?.releaseLock();
      }
    })();
    return cancel;
  });
}
