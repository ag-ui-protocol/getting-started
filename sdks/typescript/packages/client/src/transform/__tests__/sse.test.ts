import { Subject } from "rxjs";
import { firstValueFrom } from "rxjs";
import { take } from "rxjs/operators";
import { transformHttpEventStream } from "../http";
import { EventType } from "@ag-ui/core";
import { HttpEvent, HttpEventType } from "../../run/http-request";

describe("transformHttpEventStream", () => {
  it("should emit events as soon as complete SSE events are encountered", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the first event before emitting
    const firstEventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send first chunk with a complete SSE event
    const firstChunkData = new TextEncoder().encode(
      'data: {"type": "TEXT_MESSAGE_START", "messageId": "1", "role": "assistant"}\n\n',
    );

    chunk$.next({
      type: HttpEventType.DATA,
      data: firstChunkData,
    });

    // Await the first event
    const firstEvent = await firstEventPromise;
    expect(firstEvent).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      role: "assistant",
      messageId: "1",
    });

    // Set up subscription promise for the second event before emitting
    const secondEventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send second chunk with another complete SSE event
    const secondChunkData = new TextEncoder().encode(
      'data: {"type": "TEXT_MESSAGE_CONTENT", "messageId": "1", "delta": "Hello"}\n\n',
    );

    chunk$.next({
      type: HttpEventType.DATA,
      data: secondChunkData,
    });

    // Await the second event
    const secondEvent = await secondEventPromise;
    expect(secondEvent).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Hello",
    });

    // Complete the stream
    chunk$.complete();
  });

  it("should handle multiple complete SSE events in a single chunk", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Create a promise that resolves after receiving 2 events
    const eventsPromise = new Promise<any[]>((resolve) => {
      const events: any[] = [];
      event$.subscribe({
        next: (event) => {
          events.push(event);
          if (events.length === 2) {
            resolve(events);
          }
        },
        error: (err) => expect.fail(String(err)),
      });
    });

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send a single chunk with multiple complete SSE events
    const multilineJson = new TextEncoder().encode(
      'data: {"type": "TEXT_MESSAGE_START", "messageId": "1", "role": "assistant"}\n\n' +
        'data: {"type": "TEXT_MESSAGE_CONTENT", "messageId": "1", "delta": "Hello"}\n\n',
    );

    chunk$.next({
      type: HttpEventType.DATA,
      data: multilineJson,
    });

    // Wait for both events to be emitted
    const events = await eventsPromise;

    // Verify we received both events in the correct order
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      role: "assistant",
      messageId: "1",
    });
    expect(events[1]).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Hello",
    });

    // Complete the stream
    chunk$.complete();
  });

  it("should handle split SSE event across multiple chunks", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$);

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send first part of an SSE event
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('data: {"type": "TEXT_MESSAGE'),
    });

    // Send middle part
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('_START", "messageId": '),
    });

    // Send final part with double newline to complete the SSE event
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('"1", "role": "assistant"}\n\n'),
    });

    // Complete the stream after sending all chunks
    chunk$.complete();

    // Await the complete event
    const event = await eventPromise;

    // Verify we correctly assembled and parsed the JSON
    expect(event).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      role: "assistant",
      messageId: "1",
    });
  });

  it("should emit error when invalid JSON is received in SSE format", async () => {
    const chunk$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(chunk$);

    // Create a promise that will resolve when an error occurs
    const errorPromise = new Promise<any>((resolve) => {
      event$.subscribe({
        next: () => {
          // This should not be called
          expect.fail("Should not emit events for invalid JSON");
        },
        error: (err) => {
          resolve(err);
        },
        complete: () => {
          expect.fail("Stream should not complete successfully with invalid JSON");
        },
      });
    });

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send invalid JSON (missing closing bracket) in SSE format
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('data: {"type": "TEXT_MESSAGE_START", "messageId": "1"\n\n'),
    });

    // Wait for the error to be caught
    const error = await errorPromise;

    // Verify we got a JSON parsing error
    expect(error).toBeDefined();
    expect(error instanceof SyntaxError || error.message.includes("JSON")).toBeTruthy();
  });

  it("should handle Server-Sent Events (SSE) format with multiple data lines", async () => {
    const chunk$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send an SSE formatted event with multi-line data
    const sseData = new TextEncoder().encode(
      "event: message\n" +
        "id: 123\n" +
        "data: {\n" +
        'data: "type": "TEXT_MESSAGE_CONTENT",\n' +
        'data: "messageId": "1",\n' +
        'data: "delta": "Hello World"\n' +
        "data: }\n\n",
    );

    chunk$.next({
      type: HttpEventType.DATA,
      data: sseData,
    });

    // Await the event
    const event = await eventPromise;

    // Verify we received the correct event with the multi-line data properly joined
    expect(event).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Hello World",
    });

    // Complete the stream
    chunk$.complete();
  });

  it("should handle JSON split between HTTP chunks in a single SSE event", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$);

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send the start of the SSE event with first part of the JSON
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('data: {"type": "TEXT_MESSAGE_CONTENT", "messageId": "1"'),
    });

    // Send the middle part of the JSON
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode(', "delta": "Hello '),
    });

    // Send the end of the JSON with the closing SSE event markers
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('World"}\n\n'),
    });

    // Complete the stream after sending all chunks
    chunk$.complete();

    // Await the complete event
    const event = await eventPromise;

    // Verify we correctly assembled and parsed the JSON
    expect(event).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Hello World",
    });
  });

  it("should handle SSE with 'data:' prefix split from JSON content", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$);

    // Send headers event first
    const headers = new Headers();
    headers.append("Content-Type", "text/event-stream");

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send the first chunk with just the SSE prefix
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode("data: "),
    });

    // Send the start of the JSON
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode('{"type": "TEXT_MESSAGE_CONTENT"'),
    });

    // Send the middle part of the JSON
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode(', "messageId": "1", "delta":'),
    });

    // Send the end of the JSON with the closing SSE event markers
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode(' "Split JSON Test"}\n\n'),
    });

    // Complete the stream after sending all chunks
    chunk$.complete();

    // Await the complete event
    const event = await eventPromise;

    // Verify we correctly assembled and parsed the JSON
    expect(event).toEqual({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "Split JSON Test",
    });
  });
});
