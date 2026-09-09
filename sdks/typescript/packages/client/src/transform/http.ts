import { BaseEvent, EventSchemas } from "@ag-ui/core";
import { Subject, ReplaySubject, Observable, Subscription } from "rxjs";
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

  // Erroring the output does not stop the upstream read on its own: the source
  // subscription owns the teardown that cancels the HTTP reader, so without
  // releasing it the transport keeps reading and the replay buffer keeps
  // retaining chunks that nothing will ever consume.
  //
  // The parser can fail synchronously from inside subscribe(), before the
  // handle below exists, so the intent is recorded and acted on as soon as it
  // does.
  let sourceSubscription: Subscription | undefined;
  let teardownRequested = false;

  const stopReading = () => {
    teardownRequested = true;
    sourceSubscription?.unsubscribe();
  };

  const failStream = (err: unknown) => {
    stopReading();
    eventSubject.error(err);
  };

  const finishStream = () => {
    stopReading();
    eventSubject.complete();
  };

  // Subscribe to source and buffer events while we determine the content type
  sourceSubscription = source$.subscribe({
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
          parseProtoStream(bufferSubject).subscribe({
            next: (event) => eventSubject.next(event),
            error: (err) => failStream(err),
            complete: () => finishStream(),
          });
        } else {
          // Use SSE JSON parser for all other cases
          parseSSEStream(bufferSubject, log).subscribe({
            next: (json) => {
              try {
                const parsedEvent = EventSchemas.parse(json);
                log?.event("HTTP", "Event validated:", parsedEvent, {
                  type: parsedEvent.type,
                  valid: true,
                });
                eventSubject.next(parsedEvent as BaseEvent);
              } catch (err) {
                log?.event("HTTP", "Event invalid:", { json, error: String(err) });
                failStream(err);
              }
            },
            error: (err) => {
              if ((err as DOMException)?.name === "AbortError") {
                eventSubject.next({
                  type: EventType.RUN_ERROR,
                  message: (err as DOMException).message || "Request aborted",
                  code: "abort",
                  rawEvent: err,
                });
                finishStream();
                return;
              }
              return failStream(err);
            },
            complete: () => finishStream(),
          });
        }
      } else if (!parserInitialized) {
        failStream(new Error("No headers event received before data events"));
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

  // Covers a parser that failed synchronously while subscribe() was still
  // running, when there was no handle to release yet.
  if (teardownRequested) {
    sourceSubscription.unsubscribe();
  }

  return eventSubject.asObservable();
};
