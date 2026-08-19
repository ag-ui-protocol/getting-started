import { Observable, from, defer, throwError } from "rxjs";
import { mergeMap, switchMap } from "rxjs/operators";

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
        const contentType = response.headers.get("content-type") || "";
        // Read the (small) error body once, then error the stream
        return from(response.text()).pipe(
          mergeMap((text) => {
            let payload: unknown = text;
            if (contentType.includes("application/json")) {
              try { payload = JSON.parse(text); } catch {/* keep raw text */}
            }
            const err: Error & { status?: number; payload?: unknown } = new Error(
              `HTTP ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`
            );
            err.status = response.status;
            err.payload = payload;
            return throwError(() => err);
          })
        );
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
