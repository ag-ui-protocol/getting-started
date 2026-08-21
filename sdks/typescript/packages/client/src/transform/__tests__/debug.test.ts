import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { take } from "rxjs/operators";
import { parseSSEStream } from "../sse";
import { transformHttpEventStream } from "../http";
import { createDebugLogger } from "@/debug-logger";
import { HttpEvent, HttpEventType } from "../../run/http-request";
import { EventType } from "@ag-ui/core";

describe("parseSSEStream debug logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createSSEData = (json: object): HttpEvent => ({
    type: HttpEventType.DATA,
    data: new TextEncoder().encode(`data: ${JSON.stringify(json)}\n\n`),
  });

  it("no debug logs when logger is undefined", async () => {
    const source$ = new Subject<HttpEvent>();
    const event$ = parseSSEStream(source$, undefined);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    source$.next(
      createSSEData({
        type: "TEXT_MESSAGE_START",
        messageId: "1",
        role: "assistant",
      }),
    );

    await resultPromise;
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("with events+verbose: logs full JSON of each parsed SSE event with [SSE] prefix", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: true,
    })!;

    const source$ = new Subject<HttpEvent>();
    const event$ = parseSSEStream(source$, logger);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    const eventData = {
      type: "TEXT_MESSAGE_START",
      messageId: "1",
      role: "assistant",
    };
    source$.next(createSSEData(eventData));

    await resultPromise;

    const sseCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[SSE]"),
    );
    expect(sseCalls.length).toBe(1);
    expect(sseCalls[0][0]).toBe("[SSE] Event received:");
    // In verbose mode, should be JSON string
    expect(typeof sseCalls[0][1]).toBe("string");
    const parsed = JSON.parse(sseCalls[0][1]);
    expect(parsed).toMatchObject(eventData);
  });

  it("with events only (no verbose): logs { type } summary", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const source$ = new Subject<HttpEvent>();
    const event$ = parseSSEStream(source$, logger);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    const eventData = {
      type: "TEXT_MESSAGE_START",
      messageId: "1",
      role: "assistant",
    };
    source$.next(createSSEData(eventData));

    await resultPromise;

    const sseCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[SSE]"),
    );
    expect(sseCalls.length).toBe(1);
    expect(sseCalls[0][0]).toBe("[SSE] Event received:");
    // In summary mode, should be the summary object
    expect(sseCalls[0][1]).toEqual({ type: "TEXT_MESSAGE_START" });
  });
});

describe("transformHttpEventStream debug logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createHeaders = (contentType: string = "text/event-stream"): HttpEvent => {
    const headers = new Headers();
    headers.append("Content-Type", contentType);
    return {
      type: HttpEventType.HEADERS,
      status: 200,
      headers,
    };
  };

  const createSSEData = (json: object): HttpEvent => ({
    type: HttpEventType.DATA,
    data: new TextEncoder().encode(`data: ${JSON.stringify(json)}\n\n`),
  });

  it("no debug logs when logger is undefined", async () => {
    const source$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(source$, undefined);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    source$.next(createHeaders());
    source$.next(
      createSSEData({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "1",
        role: "assistant",
      }),
    );

    await resultPromise;
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("lifecycle log: [HTTP] Stream format detected: with contentType and parser type", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const source$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(source$, logger);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    source$.next(createHeaders("text/event-stream"));
    source$.next(
      createSSEData({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "1",
        role: "assistant",
      }),
    );

    await resultPromise;

    const lifecycleCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[HTTP] Stream format detected:",
    );
    expect(lifecycleCalls.length).toBe(1);
    expect(lifecycleCalls[0][1]).toEqual({
      contentType: "text/event-stream",
      parser: "sse",
    });
  });

  it("event validation log: [HTTP] Event validated: with type and valid:true on success", async () => {
    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const source$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(source$, logger);
    const resultPromise = firstValueFrom(event$.pipe(take(1)));

    source$.next(createHeaders());
    source$.next(
      createSSEData({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "1",
        role: "assistant",
      }),
    );

    await resultPromise;

    const validatedCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[HTTP] Event validated:",
    );
    expect(validatedCalls.length).toBe(1);
    expect(validatedCalls[0][1]).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      valid: true,
    });
  });

  it("event invalid log: [HTTP] Event invalid: on schema parse failure", async () => {
    expect.assertions(1);

    const logger = createDebugLogger({
      enabled: true,
      events: true,
      lifecycle: true,
      verbose: false,
    })!;

    const source$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(source$, logger);

    // Subscribe to catch the error
    event$.subscribe({
      error: () => {
        // expected
      },
    });

    source$.next(createHeaders());
    // Send an event with an invalid type to trigger schema parse failure
    source$.next(
      createSSEData({
        type: "COMPLETELY_INVALID_EVENT_TYPE_THAT_DOES_NOT_EXIST",
        data: "bad",
      }),
    );

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    const invalidCalls = debugSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0] === "[HTTP] Event invalid:",
    );

    expect(invalidCalls.length).toBe(1);
  });
});
