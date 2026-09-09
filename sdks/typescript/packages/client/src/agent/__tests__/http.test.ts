import { HttpAgent } from "../http";
import { runHttpRequest, HttpEventType } from "@/run/http-request";
import { v4 as uuidv4 } from "uuid";
import { of } from "rxjs";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";

// Mock the runHttpRequest module
vi.mock("@/run/http-request", () => ({
  runHttpRequest: vi.fn(),
  HttpEventType: {
    HEADERS: "headers",
    DATA: "data",
  },
}));

// Mock uuid module
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-run-id"),
}));

// Mock transformHttpEventStream
vi.mock("@/transform/http", () => ({
  transformHttpEventStream: vi.fn((source$) => source$),
}));

describe("HttpAgent", () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should configure and execute HTTP requests correctly", async () => {
    // Setup mock observable for the HTTP response
    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    // Mock the runHttpRequest function
    (runHttpRequest as Mock).mockReturnValue(mockObservable);

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
    });

    // Setup input data for the agent
    agent.messages = [
      {
        id: uuidv4(),
        role: "user",
        content: "Hello",
      },
    ];

    // Prepare the input that would be used in runAgent
    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    // Call run method directly, which should call runHttpRequest
    agent.run(input);

    // Verify runHttpRequest was called with a fetch thunk
    expect(runHttpRequest).toHaveBeenCalledWith(expect.any(Function));
  });

  it("should abort the request when abortRun is called", () => {
    // Setup mock implementation
    (runHttpRequest as Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Spy on the abort method of AbortController
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    // Trigger runAgent without actually calling it by checking the abortController
    expect(agent.abortController).toBeInstanceOf(AbortController);

    // Call abortRun directly
    agent.abortRun();

    // Verify abort was called
    expect(abortSpy).toHaveBeenCalled();

    // Clean up
    abortSpy.mockRestore();
  });

  it("should use a custom abort controller when provided", () => {
    // Setup mock implementation
    (runHttpRequest as Mock).mockReturnValue(of());

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Create a custom abort controller
    const customController = new AbortController();
    const abortSpy = vi.spyOn(customController, "abort");

    // Set the custom controller
    agent.abortController = customController;

    // Call abortRun directly
    agent.abortRun();

    // Verify the custom controller was used
    expect(abortSpy).toHaveBeenCalled();

    // Clean up
    abortSpy.mockRestore();
  });

  it("should handle transformHttpEventStream correctly", async () => {
    // Import the actual transformHttpEventStream function
    const { transformHttpEventStream } = await import("../../transform/http");

    // Verify transformHttpEventStream is a function
    expect(typeof transformHttpEventStream).toBe("function");

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Verify that the HttpAgent's run method uses transformHttpEventStream
    // This is an indirect test of implementation details, but useful to verify the pipeline
    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    (runHttpRequest as Mock).mockReturnValue(mockObservable);

    // Call run with mock input
    const input = {
      threadId: agent.threadId,
      runId: "test-run-id",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    };

    // Execute the run function
    agent.run(input);

    // Verify that transformHttpEventStream was called with the mock observable and debugLogger
    // When debug is off (default), createDebugLogger returns undefined
    expect(transformHttpEventStream).toHaveBeenCalledWith(mockObservable, undefined);
  });

  it("should process HTTP response data end-to-end", async () => {
    // Create mock headers
    const mockHeaders = new Headers();
    mockHeaders.append("Content-Type", "text/event-stream");

    // Create a mock response data
    const mockResponseObservable = of(
      {
        type: HttpEventType.HEADERS,
        status: 200,
        headers: mockHeaders,
      },
      {
        type: HttpEventType.DATA,
        data: new Uint8Array(
          new TextEncoder().encode(
            'data: {"type": "TEXT_MESSAGE_START", "messageId": "test-id"}\n\n',
          ),
        ),
      },
    );

    // Directly mock runHttpRequest
    (runHttpRequest as Mock).mockReturnValue(mockResponseObservable);

    // Configure test agent
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    // Prepare input for the agent
    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    // Call run method directly
    agent.run(input);

    // Verify runHttpRequest was called with a fetch thunk
    expect(runHttpRequest).toHaveBeenCalledWith(expect.any(Function));
  });

  it("should use custom fetch function when provided in config", async () => {
    const customFetch = vi.fn().mockResolvedValue(new Response());

    const mockObservable = of({
      type: HttpEventType.HEADERS,
      status: 200,
      headers: new Headers(),
    });

    (runHttpRequest as Mock).mockReturnValue(mockObservable);

    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
      fetch: customFetch,
    });

    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    agent.run(input);

    // Verify runHttpRequest was called with a thunk
    expect(runHttpRequest).toHaveBeenCalledWith(expect.any(Function));

    // Execute the thunk to verify it uses the custom fetch
    const thunk = (runHttpRequest as Mock).mock.calls[0][0];
    await thunk();

    expect(customFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat",
      expect.objectContaining({ method: "POST" }),
    );
    // The outgoing boundary re-serialises through the validator, so the key
    // ORDER is the schema's; the content must be exactly the input.
    const sentBody = JSON.parse((customFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody).toEqual(input);
  });
});
