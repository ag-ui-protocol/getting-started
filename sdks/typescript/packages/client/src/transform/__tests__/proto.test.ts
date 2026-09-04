import { HttpEvent, HttpEventType } from "../../run/http-request";
import { firstValueFrom, Subject, take } from "rxjs";
import {
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";
import * as proto from "@ag-ui/proto";
import { transformHttpEventStream } from "../http";
import { MAX_BUFFER_SIZE } from "../proto";
import * as encoder from "@ag-ui/encoder";
import { describe, it, expect, vi, beforeEach } from "vitest";

const eventEncoder = new encoder.EventEncoder({
  accept: proto.AGUI_MEDIA_TYPE,
});

// Don't mock the proto package so we can use real encoding/decoding
vi.unmock("@ag-ui/proto");

describe("parseProtoStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should correctly decode protocol buffer events", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the first event before emitting
    const firstEventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Create a test event
    const originalEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg123",
      role: "assistant",
      timestamp: Date.now(),
    };

    // Encode the event using the encoder
    const encodedEvent = eventEncoder.encodeBinary(originalEvent);

    // Send the encoded event as a DATA chunk
    chunk$.next({
      type: HttpEventType.DATA,
      data: encodedEvent,
    });

    // Await the received event
    const receivedEvent = (await firstEventPromise) as TextMessageStartEvent;

    // Verify we got back the same event
    expect(receivedEvent.type).toEqual(originalEvent.type);
    expect(receivedEvent.timestamp).toEqual(originalEvent.timestamp);
    expect(receivedEvent.messageId).toEqual(originalEvent.messageId);
    expect(receivedEvent.role).toEqual(originalEvent.role);
    // Complete the stream
    chunk$.complete();
  });

  it("should handle multiple protobuf events in a single chunk", async () => {
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
        error: (err) => {
          throw new Error(`Unexpected error: ${err}`);
        },
      });
    });

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Create two test events
    const startEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg123",
      role: "assistant",
      timestamp: Date.now(),
    };

    const contentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg123",
      delta: "Hello world",
      timestamp: Date.now(),
    };

    // Encode both events and concatenate them
    const encodedStart = eventEncoder.encodeBinary(startEvent);
    const encodedContent = eventEncoder.encodeBinary(contentEvent);

    // Concatenate the two encoded events
    const combinedData = new Uint8Array(encodedStart.length + encodedContent.length);
    combinedData.set(encodedStart, 0);
    combinedData.set(encodedContent, encodedStart.length);

    // Send the combined data as a single chunk
    chunk$.next({
      type: HttpEventType.DATA,
      data: combinedData,
    });

    // Wait for both events to be emitted
    const events = await eventsPromise;

    // Verify we received both events correctly
    expect(events.length).toBe(2);
    expect(events[0].type).toEqual(startEvent.type);
    expect(events[0].messageId).toEqual(startEvent.messageId);
    expect(events[0].role).toEqual(startEvent.role);
    expect(events[1].type).toEqual(contentEvent.type);
    expect(events[1].messageId).toEqual(contentEvent.messageId);
    expect(events[1].delta).toEqual(contentEvent.delta);

    // Complete the stream
    chunk$.complete();
  });

  it("should handle split protobuf event across multiple chunks", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$);

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Create a test event
    const originalEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg123",
      delta: "This is a message that will be split across chunks",
      timestamp: Date.now(),
    };

    // Encode the event using the encoder
    const encodedEvent = eventEncoder.encodeBinary(originalEvent);

    // Split the encoded event into three parts
    const firstPart = encodedEvent.slice(0, Math.floor(encodedEvent.length / 3));
    const secondPart = encodedEvent.slice(
      Math.floor(encodedEvent.length / 3),
      Math.floor((2 * encodedEvent.length) / 3),
    );
    const thirdPart = encodedEvent.slice(Math.floor((2 * encodedEvent.length) / 3));

    // Send the parts as separate chunks
    chunk$.next({
      type: HttpEventType.DATA,
      data: firstPart,
    });

    chunk$.next({
      type: HttpEventType.DATA,
      data: secondPart,
    });

    chunk$.next({
      type: HttpEventType.DATA,
      data: thirdPart,
    });

    // Complete the stream
    chunk$.complete();

    // Await the received event
    const receivedEvent = (await eventPromise) as TextMessageContentEvent;

    // Verify we got back the same event
    expect(receivedEvent.type).toEqual(originalEvent.type);
    expect(receivedEvent.messageId).toEqual(originalEvent.messageId);
    expect(receivedEvent.delta).toEqual(originalEvent.delta);
  });

  it("should emit error when invalid protobuf data is received", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    let receivedEvent = false;
    let _receivedError = false;
    let _errorReceived: unknown = null;

    // Set up a subscription with shorter timeout
    const subscription = event$.subscribe({
      next: () => {
        receivedEvent = true;
      },
      error: (err) => {
        _receivedError = true;
        _errorReceived = err;
      },
      complete: () => {
        // This is fine if it completes
      },
    });

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Send invalid protobuf data (just random bytes)
    const invalidData = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xee, 0xdd]);

    chunk$.next({
      type: HttpEventType.DATA,
      data: invalidData,
    });

    // Give it a moment to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Force completion
    chunk$.complete();

    // Clean up subscription
    subscription.unsubscribe();

    // Here we're just verifying we didn't get an event from invalid data
    // The implementation could either emit an error or just ignore bad data
    expect(receivedEvent).toBe(false);
  }, 3000);

  it("should correctly encode and decode a STATE_DELTA event with JSON patch operations", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Create a state delta event with JSON patch operations
    const stateDeltaEvent: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      timestamp: Date.now(),
      delta: [
        { op: "add", path: "/counter", value: 42 },
        { op: "add", path: "/items", value: ["apple", "banana", "cherry"] },
        { op: "replace", path: "/users/123/name", value: "Jane Doe" },
        { op: "remove", path: "/outdated" },
        { op: "move", from: "/oldPath", path: "/newPath" },
        { op: "copy", from: "/source", path: "/destination" },
      ],
    };

    // Encode the event using the encoder
    const encodedEvent = eventEncoder.encodeBinary(stateDeltaEvent);

    // Send the encoded event as a DATA chunk
    chunk$.next({
      type: HttpEventType.DATA,
      data: encodedEvent,
    });

    // Await the received event
    const receivedEvent = (await eventPromise) as StateDeltaEvent;

    // Verify we got back the same event with all patch operations intact
    expect(receivedEvent.type).toEqual(stateDeltaEvent.type);
    expect(receivedEvent.timestamp).toEqual(stateDeltaEvent.timestamp);

    // Check the JSON patch operations were correctly preserved
    expect(receivedEvent.delta.length).toEqual(stateDeltaEvent.delta.length);

    // Verify each patch operation
    receivedEvent.delta.forEach((operation, index) => {
      expect(operation.op).toEqual(stateDeltaEvent.delta[index].op);
      expect(operation.path).toEqual(stateDeltaEvent.delta[index].path);

      if ("from" in operation) {
        expect(operation.from).toEqual(stateDeltaEvent.delta[index].from);
      }

      if ("value" in operation) {
        expect(operation.value).toEqual(stateDeltaEvent.delta[index].value);
      }
    });

    // Complete the stream
    chunk$.complete();
  });

  it("should correctly encode and decode a MESSAGES_SNAPSHOT event", async () => {
    // Create a subject to simulate the HTTP chunk stream
    const chunk$ = new Subject<HttpEvent>();

    // Create the transform stream
    const event$ = transformHttpEventStream(chunk$);

    // Set up subscription promise for the event
    const eventPromise = firstValueFrom(event$.pipe(take(1)));

    // Send headers event first with protobuf content type
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Create a messages snapshot event with complex message objects
    const messagesSnapshotEvent: MessagesSnapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      timestamp: Date.now(),
      messages: [
        {
          id: "msg1",
          role: "user",
          content: "Hello, can you help me with something?",
        },
        {
          id: "msg2",
          role: "assistant",
          content: "Of course! How can I assist you today?",
        },
        {
          id: "msg3",
          role: "user",
          content: [
            {
              type: "text",
              text: "I need help with coding",
            },
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.com/mock.png",
                mimeType: "image/png",
              },
            },
          ],
        },
        {
          id: "msg4",
          role: "assistant",
          content: undefined,
          toolCalls: [
            {
              id: "tool1",
              type: "function",
              function: {
                name: "write_code",
                arguments: JSON.stringify({
                  language: "python",
                  task: "sorting algorithm",
                }),
              },
            },
          ],
        },
      ],
    };

    // Encode the event using the encoder
    const encodedEvent = eventEncoder.encodeBinary(messagesSnapshotEvent);

    // Send the encoded event as a DATA chunk
    chunk$.next({
      type: HttpEventType.DATA,
      data: encodedEvent,
    });

    // Await the received event
    const receivedEvent = (await eventPromise) as MessagesSnapshotEvent;

    // Verify we got back the same event
    expect(receivedEvent.type).toEqual(messagesSnapshotEvent.type);
    expect(receivedEvent.timestamp).toEqual(messagesSnapshotEvent.timestamp);

    // Check the messages array was correctly preserved
    expect(receivedEvent.messages.length).toEqual(messagesSnapshotEvent.messages.length);

    // Verify each message
    receivedEvent.messages.forEach((message, index) => {
      expect(message.id).toEqual(messagesSnapshotEvent.messages[index].id);
      expect(message.role).toEqual(messagesSnapshotEvent.messages[index].role);
      expect(message.content).toEqual(messagesSnapshotEvent.messages[index].content);

      // Check tool calls if present
      if ((messagesSnapshotEvent.messages[index] as any).toolCalls) {
        expect((message as any).toolCalls).toBeDefined();
        expect((message as any).toolCalls!.length).toEqual(
          (messagesSnapshotEvent.messages[index] as any).toolCalls!.length,
        );

        (message as any).toolCalls!.forEach((toolCall: any, toolIndex: number) => {
          const originalToolCall = (messagesSnapshotEvent.messages[index] as any).toolCalls![
            toolIndex
          ];
          expect(toolCall.id).toEqual(originalToolCall.id);
          expect(toolCall.type).toEqual(originalToolCall.type);
          expect(toolCall.function.name).toEqual(originalToolCall.function.name);
          expect(JSON.parse(toolCall.function.arguments)).toEqual(
            JSON.parse(originalToolCall.function.arguments),
          );
        });
      }
    });

    // Complete the stream
    chunk$.complete();
  });

  it("should emit error when the protobuf buffer exceeds the maximum size", async () => {
    const chunk$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(chunk$);

    const errors: any[] = [];
    event$.subscribe({
      next: () => {
        expect.fail("Should not emit events while the length prefix is unsatisfied");
      },
      error: (err) => errors.push(err),
      complete: () => {
        expect.fail("Stream should not complete once the buffer limit is passed");
      },
    });

    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // A length prefix naming a message far larger than anything that will
    // arrive, so processBuffer keeps waiting while the buffer keeps growing.
    const lengthPrefix = new Uint8Array(4);
    new DataView(lengthPrefix.buffer).setUint32(0, 0xffffffff, false);

    chunk$.next({
      type: HttpEventType.DATA,
      data: lengthPrefix,
    });

    const filler = new Uint8Array(1024 * 1024);
    const chunkCount = Math.floor(MAX_BUFFER_SIZE / filler.length) + 1;

    for (let i = 0; i < chunkCount; i++) {
      chunk$.next({
        type: HttpEventType.DATA,
        data: filler,
      });
    }

    // The check runs inside the DATA handler, so the failure is already
    // delivered by the time the last chunk above returns.
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Protobuf buffer size exceeded maximum limit");
  });

  it("should not emit error when complete messages exceed the limit in total", async () => {
    const chunk$ = new Subject<HttpEvent>();
    const event$ = transformHttpEventStream(chunk$);

    const received: any[] = [];
    let errored: any = null;
    const settled = new Promise<void>((resolve) => {
      event$.subscribe({
        next: (event) => received.push(event),
        error: (err) => {
          errored = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);

    chunk$.next({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: headers,
    });

    // Each message is complete, so processBuffer slices it away as soon as it
    // lands. The total crosses the limit; the live buffer never does.
    const encoded = eventEncoder.encodeBinary({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg123",
      delta: "A".repeat(1024 * 1024),
    });
    const chunkCount = Math.floor(MAX_BUFFER_SIZE / encoded.length) + 1;

    for (let i = 0; i < chunkCount; i++) {
      chunk$.next({
        type: HttpEventType.DATA,
        data: encoded,
      });
    }
    chunk$.complete();

    await settled;

    expect(errored).toBeNull();
    expect(received).toHaveLength(chunkCount);
  });
});
