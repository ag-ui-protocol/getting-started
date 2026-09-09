import { runHttpRequest, HttpEventType } from "../http-request";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

describe("runHttpRequest", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("should call the provided fetch thunk", async () => {
    // Mock a proper response
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "application/json");

    const mockResponse = {
      ok: true,
      status: 200,
      headers: mockHeaders,
      body: {
        getReader: vi.fn().mockReturnValue({
          read: vi.fn().mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    };

    fetchMock.mockResolvedValue(mockResponse);

    // Execute the function which should trigger a fetch call
    const observable = runHttpRequest(() => fetchMock());

    // Subscribe to trigger the fetch
    const subscription = observable.subscribe({
      next: () => {},
      error: () => {},
      complete: () => {},
    });

    // Give time for async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify the fetch thunk was called
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clean up subscription
    subscription.unsubscribe();
  });

  it("should emit headers and data events from the response", async () => {
    // Create mock chunks to be returned by the reader
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5, 6]);

    // Mock reader that returns multiple chunks before completing
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: chunk1 })
        .mockResolvedValueOnce({ done: false, value: chunk2 })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    // Mock response with our custom reader and headers
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "application/json");

    const mockResponse = {
      ok: true,
      status: 200,
      headers: mockHeaders,
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    };

    fetchMock.mockResolvedValue(mockResponse);

    // Create and execute the run agent function
    const observable = runHttpRequest(() => fetchMock());

    // Collect the emitted events
    const emittedEvents: any[] = [];
    const subscription = observable.subscribe({
      next: (event) => emittedEvents.push(event),
      error: (err) => expect.fail(`Should not have errored: ${err}`),
      complete: () => {},
    });

    // Wait for all async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify we received the expected events
    expect(emittedEvents.length).toBe(3);

    // First event should be headers
    expect(emittedEvents[0].type).toBe(HttpEventType.HEADERS);
    expect(emittedEvents[0].status).toBe(200);
    expect(emittedEvents[0].headers).toBe(mockHeaders);

    // Second and third events should be data
    expect(emittedEvents[1].type).toBe(HttpEventType.DATA);
    expect(emittedEvents[1].data).toBe(chunk1);

    expect(emittedEvents[2].type).toBe(HttpEventType.DATA);
    expect(emittedEvents[2].data).toBe(chunk2);

    // Verify reader.read was called the expected number of times
    expect(mockReader.read).toHaveBeenCalledTimes(3);

    // Clean up
    subscription.unsubscribe();
  });

  it("should throw HTTP error on occurs", async () => {
    // Mock a 404 error response with JSON body
    const mockHeaders = new Headers();
    mockHeaders.append("content-type", "application/json");

    const mockText = '{"message":"User not found"}';

    const mockResponse = new Response(mockText, { status: 404, headers: mockHeaders });
    const textSpy = vi.spyOn(mockResponse, "text");

    // Override fetch for this test
    fetchMock.mockResolvedValue(mockResponse);

    const observable = runHttpRequest(() => Promise.resolve(mockResponse) as Promise<Response>);

    const nextSpy = vi.fn();

    await new Promise<void>((resolve) => {
      const sub = observable.subscribe({
        next: nextSpy,
        error: (err: any) => {
          // error should carry status + parsed payload
          expect(err).toBeInstanceOf(Error);
          expect(err.status).toBe(404);
          expect(err.payload).toEqual({ message: "User not found" });
          // readable message is okay too (optional)
          expect(err.message).toContain("HTTP 404");
          expect(err.message).toContain("User not found");
          resolve();
          sub.unsubscribe();
        },
        complete: () => {
          expect.fail("Should not complete on HTTP error");
        },
      });
    });

    // Should not have emitted any data events on error short-circuit
    expect(nextSpy).not.toHaveBeenCalled();

    expect(textSpy).not.toHaveBeenCalled();
  });
});

describe("bounded HTTP error bodies", () => {
  const cap = 64 * 1024;
  const encoder = new TextEncoder();
  const errorFrom = (response: Response) => new Promise<Error & { status: number; payload: unknown }>((resolve, reject) => {
    runHttpRequest(async () => response).subscribe({
      next: () => reject(new Error("Unexpected event")),
      complete: () => reject(new Error("Unexpected completion")),
      error: resolve,
    });
  });

  function streamingError(chunks: Uint8Array[], contentType = "text/plain", cancel = vi.fn()) {
    let index = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    });
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    return { response: new Response(body, { status: 500, headers: { "content-type": contentType } }), pull, cancel };
  }

  it("caps an oversized chunk and retains bounded payload and message previews", async () => {
    const { response, pull, cancel } = streamingError([encoder.encode("x".repeat(cap * 4)), encoder.encode("never read")]);
    const error = await errorFrom(response);
    expect(error.status).toBe(500);
    expect(error.payload).toBe("x".repeat(cap) + " [truncated]");
    expect(error.message).toBe("HTTP 500: " + "x".repeat(4096) + " [truncated]");
    expect(pull).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it("stops pulling an unbounded stream once the byte budget is reached", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encoder.encode("x".repeat(1024)));
    });
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 503 });
    const error = await errorFrom(response);
    expect(error.status).toBe(503);
    expect(pull).toHaveBeenCalledTimes(64);
    expect(cancel).toHaveBeenCalledOnce();
    expect(String(error.payload).length).toBe(cap + " [truncated]".length);
  });

  it("decodes multibyte UTF-8 split across chunks", async () => {
    const bytes = encoder.encode("你😀");
    const { response } = streamingError([bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)]);
    expect((await errorFrom(response)).payload).toBe("你😀");
  });

  it("does not emit half a UTF-8 character at the cap", async () => {
    const { response } = streamingError([encoder.encode("x".repeat(cap - 1) + "你")]);
    expect((await errorFrom(response)).payload).toBe("x".repeat(cap - 1) + " [truncated]");
  });

  it("keeps oversized JSON as a marked string rather than parsing a partial document", async () => {
    const { response } = streamingError([encoder.encode(JSON.stringify({ message: "x".repeat(cap) }))], "application/json");
    const error = await errorFrom(response);
    expect(typeof error.payload).toBe("string");
    expect(String(error.payload)).toHaveLength(cap + " [truncated]".length);
    expect(error.status).toBe(500);
  });

  it.each(["plain failure", "{invalid json", "", "x".repeat(cap - 1)])("preserves complete bodies below the cap (%#)", async (text) => {
    const { response, cancel } = streamingError([encoder.encode(text)], "application/json");
    expect((await errorFrom(response)).payload).toBe(text);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("marks an exact-cap body without waiting for another read", async () => {
    const { response, pull, cancel } = streamingError([encoder.encode("x".repeat(cap))]);
    expect((await errorFrom(response)).payload).toBe("x".repeat(cap) + " [truncated]");
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports the HTTP status for a missing body", async () => {
    const error = await errorFrom(new Response(null, { status: 502 }));
    expect(error.status).toBe(502);
    expect(error.payload).toBe("");
    expect(error.message).toBe("HTTP 502: ");
  });

  it("does not replace an HTTP error when cancellation rejects", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("Cancel failed"));
    const { response } = streamingError([new Uint8Array(cap)], "text/plain", cancel);
    const error = await errorFrom(response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error.status).toBe(500);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending error body when unsubscribed", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 500 });
    const onError = vi.fn();
    const subscription = runHttpRequest(async () => response).subscribe({ error: onError });
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    subscription.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
});
