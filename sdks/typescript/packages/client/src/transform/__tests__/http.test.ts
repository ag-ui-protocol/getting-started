import { transformHttpEventStream } from "../http";
import { HttpEvent, HttpEventType } from "../../run/http-request";
import { parseProtoStream } from "../proto";
import * as proto from "@ag-ui/proto";
import { BaseEvent, EventType } from "@ag-ui/core";
import { firstValueFrom, of, Subject, throwError, toArray } from "rxjs";
import { describe, it, expect, vi, beforeEach, Mock, test } from "vitest";

// Mock dependencies
vi.mock("../proto", () => ({
  parseProtoStream: vi.fn(),
}));

describe("transformHttpEventStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("should correctly transform protocol buffer events", () => {
    // Given
    const mockHttpSource = new Subject<HttpEvent>();
    const mockBaseEvent: BaseEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      timestamp: Date.now(),
      messageId: "msg-1",
      delta: "hello",
    };

    // Mock parseProtoStream to return our test event
    (parseProtoStream as Mock).mockReturnValue(of(mockBaseEvent));

    // Create a list to collect emitted events
    const receivedEvents: BaseEvent[] = [];

    // When
    const result$ = transformHttpEventStream(mockHttpSource);
    result$.subscribe((event) => receivedEvents.push(event));

    // Send a HEADERS event with protocol buffer content type
    mockHttpSource.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers([["content-type", proto.AGUI_MEDIA_TYPE]]),
    });

    // Send a DATA event
    mockHttpSource.next({
      type: HttpEventType.DATA,
      data: new Uint8Array([1, 2, 3, 4]),
    });

    // Complete the stream
    mockHttpSource.complete();

    // Then
    expect(parseProtoStream).toHaveBeenCalled();
    expect(receivedEvents).toEqual([mockBaseEvent]);
  });

  test("should not drop events from a synchronous cold SSE source", async () => {
    const headers = new Headers([["content-type", "text/event-stream"]]);
    const data = new TextEncoder().encode(
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"hello"}\n\n',
    );

    const result$ = transformHttpEventStream(
      of(
        {
          type: HttpEventType.HEADERS,
          status: 200,
          headers,
        },
        {
          type: HttpEventType.DATA,
          data,
        },
      ),
    );

    await expect(firstValueFrom(result$.pipe(toArray()))).resolves.toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "hello",
      },
    ]);
  });

  test("should emit RUN_ERROR and complete on AbortError without erroring", () => {
    const mockHttpSource = new Subject<HttpEvent>();
    const receivedEvents: BaseEvent[] = [];
    let completed = false;
    let receivedError: unknown = undefined;

    const result$ = transformHttpEventStream(mockHttpSource);
    result$.subscribe({
      next: (event) => receivedEvents.push(event),
      error: (err) => {
        receivedError = err;
      },
      complete: () => {
        completed = true;
      },
    });

    mockHttpSource.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers([["content-type", "text/event-stream"]]),
    });

    const abortError = { name: "AbortError" } as DOMException;
    mockHttpSource.error(abortError);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe(EventType.RUN_ERROR);
    const runErrorEvent = receivedEvents[0] as any;
    expect(runErrorEvent.rawEvent).toBe(abortError);
    expect(completed).toBe(true);
    expect(receivedError).toBeUndefined();
  });

  test("should handle parseProtoStream errors", () => {
    return new Promise<void>((resolve, reject) => {
      // Given
      const mockHttpSource = new Subject<HttpEvent>();
      const testError = new Error("Test proto parsing error");

      // Mock parseProtoStream to throw an error
      (parseProtoStream as Mock).mockReturnValue(throwError(() => testError));

      // When
      const result$ = transformHttpEventStream(mockHttpSource);
      result$.subscribe({
        next: () => {
          // Should not emit any events
          reject(new Error("Should not emit events when parseProtoStream errors"));
        },
        error: (err) => {
          // Then
          expect(err).toBe(testError);
          resolve();
        },
      });

      // Send a HEADERS event with protocol buffer content type
      mockHttpSource.next({
        type: HttpEventType.HEADERS,
        status: 200,
        headers: new Headers([["content-type", proto.AGUI_MEDIA_TYPE]]),
      });
    });
  });

  test("should error if DATA received before HEADERS", () => {
    return new Promise<void>((resolve, reject) => {
      // Given
      const mockHttpSource = new Subject<HttpEvent>();

      // When
      const result$ = transformHttpEventStream(mockHttpSource);
      result$.subscribe({
        next: () => {
          // Should not emit any events
          reject(new Error("Should not emit events when DATA received before HEADERS"));
        },
        error: (err) => {
          // Then
          expect(err.message).toContain("No headers event received before data events");
          resolve();
        },
      });

      // Send a DATA event before HEADERS
      mockHttpSource.next({
        type: HttpEventType.DATA,
        data: new Uint8Array([1, 2, 3, 4]),
      });
    });
  });
});
