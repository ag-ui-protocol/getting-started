import { BaseEvent } from "@ag-ui/core";
import { Subject, ReplaySubject, Observable } from "rxjs";
import { HttpEvent, HttpEventType } from "../run/http-request";
import { parseSSEStream } from "./sse";
import { parseProtoStream } from "./proto";
import * as proto from "@ag-ui/proto";
import { EventType } from "@ag-ui/core";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Transforms HTTP events into BaseEvents using the appropriate format parser based on content type.
 */
export const transformHttpEventStream = (
  source$: Observable<HttpEvent>,
  debugLogger?: DebugLoggerInput,
): Observable<BaseEvent> => {
  const log = resolveDebugLogger(debugLogger);
  const eventSubject = new Subject<BaseEvent>();

  // Use ReplaySubject to buffer events until we decide on the parser
  const bufferSubject = new ReplaySubject<HttpEvent>();

  // Flag to track whether we've set up the parser
  let parserInitialized = false;

  // Subscribe to source and buffer events while we determine the content type
  source$.subscribe({
    next: (event: HttpEvent) => {
      // Forward event to buffer
      bufferSubject.next(event);

      // If we get headers and haven't initialized a parser yet, check content type
      if (event.type === HttpEventType.HEADERS && !parserInitialized) {
        parserInitialized = true;
        const contentType = event.headers.get("content-type");

        log?.lifecycle("HTTP", "Stream format detected:", {
          contentType,
          parser: contentType === proto.AGUI_MEDIA_TYPE ? "protobuf" : "sse",
        });

        // Choose parser based on content type
        if (contentType === proto.AGUI_MEDIA_TYPE) {
          // Use protocol buffer parser
          parseProtoStream(bufferSubject, log).subscribe({
            next: (event) => eventSubject.next(event),
            error: (err) => eventSubject.error(err),
            complete: () => eventSubject.complete(),
          });
        } else {
          // Use SSE JSON parser for all other cases
          parseSSEStream(bufferSubject, log).subscribe({
            next: (json) => {
              // No schema enforcement here: validation runs AFTER the
              // middleware chain (the enforcement stage in the agent
              // pipeline), so a translator for a deprecated or unrecognised
              // event stays reachable. The transport only requires the one
              // thing nothing downstream can work without: a string type.
              // `null`, a number, a string and an array are all valid JSON
              // documents, and `JSON.parse` hands them on as readily as an
              // object. Reading `.type` off `null` throws inside this `next`
              // handler, where the throw is reported to the host rather than
              // to `eventSubject.error` — the run would then RESOLVE, claiming
              // success for a stream nobody read. So the shape is checked
              // before anything is read off it.
              if (typeof json !== "object" || json === null || Array.isArray(json)) {
                const err = new Error("Invalid event: the frame is not a JSON object.");
                log?.event("HTTP", "Event invalid:", { json, error: String(err) });
                eventSubject.error(err);
                return;
              }
              const record = json as { type?: unknown };
              if (typeof record.type !== "string" || record.type.length === 0) {
                const err = new Error("Invalid event: the frame carries no event type.");
                log?.event("HTTP", "Event invalid:", { json, error: String(err) });
                eventSubject.error(err);
                return;
              }
              log?.event("HTTP", "Event received:", json, { type: record.type });
              eventSubject.next(json as BaseEvent);
            },
            error: (err) => {
              if ((err as DOMException)?.name === "AbortError") {
                eventSubject.next({
                  type: EventType.RUN_ERROR,
                  message: (err as DOMException).message || "Request aborted",
                  code: "abort",
                  rawEvent: err,
                });
                eventSubject.complete();
                return;
              }
              return eventSubject.error(err);
            },
            complete: () => eventSubject.complete(),
          });
        }
      } else if (!parserInitialized) {
        eventSubject.error(new Error("No headers event received before data events"));
      }
    },
    error: (err) => {
      bufferSubject.error(err);
      eventSubject.error(err);
    },
    complete: () => {
      bufferSubject.complete();
    },
  });

  return eventSubject.asObservable();
};
