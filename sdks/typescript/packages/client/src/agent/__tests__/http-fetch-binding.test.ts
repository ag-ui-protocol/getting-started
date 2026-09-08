import { HttpAgent } from "../http";
import { runHttpRequest } from "@/run/http-request";
import { RunAgentInput } from "@ag-ui/core";
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";

// Capture the fetch thunk passed to runHttpRequest without performing a real request.
vi.mock("@/run/http-request", () => ({
  runHttpRequest: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
}));
vi.mock("@/transform/http", () => ({
  transformHttpEventStream: vi.fn((source$) => source$),
}));

const minimalInput = (): RunAgentInput =>
  ({
    threadId: "t1",
    runId: "r1",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
  }) as unknown as RunAgentInput;

describe("HttpAgent fetch receiver binding", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Regression test for the browser "Illegal invocation" bug: when HttpAgent stores
  // the global fetch unbound (`this.fetch = config.fetch ?? fetch`) and later calls
  // it as a method (`this.fetch(...)`), the receiver becomes the agent instead of
  // window. A browser's native fetch is a checked-receiver method and throws. Node's
  // fetch tolerates it, so this only surfaces in the browser — exactly the dojo e2e
  // failure. We simulate the browser's checked receiver here.
  it("calls the default global fetch with a valid receiver (no Illegal invocation)", async () => {
    const seen: Array<{ url: string }> = [];
    const checkedReceiverFetch = function (
      this: unknown,
      url: string,
      _init?: RequestInit,
    ) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'Window': Illegal invocation",
        );
      }
      seen.push({ url });
      return Promise.resolve(new Response("ok"));
    };
    globalThis.fetch = checkedReceiverFetch as unknown as typeof globalThis.fetch;

    const agent = new HttpAgent({ url: "https://api.example.com/agent" });

    agent.run(minimalInput());

    const thunk = (runHttpRequest as Mock).mock.calls[0][0] as () => Promise<Response>;
    await expect(thunk()).resolves.toBeInstanceOf(Response);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.example.com/agent");
  });
});
