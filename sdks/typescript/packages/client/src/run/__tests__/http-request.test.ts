import { runHttpRequest, HttpEventType } from "../http-request";
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";

describe("runHttpRequest", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [new DOMException("Aborted", "AbortError"), false],
    [new Error("Socket closed"), true],
  ])("handles cancellation rejection during unsubscribe: %s", async (failure, shouldWarn) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})),
      cancel: vi.fn().mockRejectedValue(failure),
    };
    const response = {
      ok: true, status: 200, headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const onError = vi.fn();
    const subscription = runHttpRequest(async () => response).subscribe({ error: onError });
    try {
      await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
      subscription.unsubscribe();
      // Let the cancellation rejection and Node's unhandled-rejection checkpoint run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      if (shouldWarn) {
        expect(warn).toHaveBeenCalledExactlyOnceWith("Failed to cancel HTTP response reader:", failure);
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      subscription.unsubscribe();
      process.off("unhandledRejection", unhandled);
    }
  });

  it("preserves the original read error when cancellation also fails", async () => {
    const readError = new Error("Connection terminated");
    const cancelError = new Error("Reader already errored");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = {
      read: vi.fn().mockRejectedValue(readError),
      cancel: vi.fn().mockRejectedValue(cancelError),
    };
    const response = {
      ok: true, status: 200, headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const error = await new Promise((resolve) => {
      runHttpRequest(async () => response).subscribe({ error: resolve });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error).toBe(readError);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Failed to cancel HTTP response reader:", cancelError);
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

    const mockResponse = {
      ok: false,
      status: 404,
      headers: mockHeaders,
      // our error-path reads .text() (not streaming)
      text: vi.fn().mockResolvedValue(mockText),
    } as unknown as Response;

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

    // Ensure we read the error body exactly once
    expect((mockResponse as any).text).toHaveBeenCalledTimes(1);
  });
});
