/**
 * Tests for message mapping: AG-UI messages to watsonx format,
 * tool forwarding, and forwardedProps filtering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxAgent } from "../index";
import { EventType, type BaseEvent, type RunAgentInput, type Message, type Tool } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent() {
  return new WatsonxAgent({
    region: "us-south",
    instanceId: "inst-1",
    agentId: "agent-1",
    bearerToken: "tok",
  });
}

function textChunk(content: string, finishReason?: string | null) {
  return {
    choices: [
      {
        delta: { content },
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

function sseResponse(chunks: (object | string)[]): Response {
  const lines = chunks.map((c) =>
    typeof c === "string" ? c : `data: ${JSON.stringify(c)}`,
  );
  lines.push("data: [DONE]");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Capture the request body sent to the watsonx chat endpoint. */
function captureFetch(): { getBody: () => Record<string, unknown> } {
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
    if (typeof url === "string" && url.includes("iam.cloud.ibm.com")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: "tok",
          expiration: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }
    if (opts?.body) {
      capturedBody = JSON.parse(opts.body);
    }
    return Promise.resolve(sseResponse([textChunk("ok")]));
  });

  return {
    getBody: () => {
      if (!capturedBody) throw new Error("No request body captured");
      return capturedBody;
    },
  };
}

async function collectEvents(
  agent: WatsonxAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  const observable = agent.run(input);
  return firstValueFrom(observable.pipe(toArray()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Message mapping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps user messages correctly", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello");
  });

  it("maps assistant messages with toolCalls", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        {
          id: "a-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function" as const,
              function: { name: "search", arguments: '{"q":"test"}' },
            },
          ],
        } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].tool_calls).toHaveLength(1);
    expect(msgs[0].tool_calls[0].id).toBe("tc-1");
    expect(msgs[0].tool_calls[0].type).toBe("function");
    expect(msgs[0].tool_calls[0].function.name).toBe("search");
    expect(msgs[0].tool_calls[0].function.arguments).toBe('{"q":"test"}');
  });

  it("maps tool messages with tool_call_id", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        {
          id: "t-1",
          role: "tool",
          toolCallId: "tc-1",
          content: "42",
        } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].tool_call_id).toBe("tc-1");
    expect(msgs[0].content).toBe("42");
  });

  it("JSON.stringifys non-string content", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        {
          id: "m-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    // Non-string content should be JSON.stringify'd
    expect(typeof msgs[0].content).toBe("string");
    expect(JSON.parse(msgs[0].content)).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("filters reserved keys from forwardedProps", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {
        messages: [{ role: "system", content: "hacked" }],
        stream: false,
        tools: [{ name: "hacked" }],
        temperature: 0.7,
        model: "gpt-4",
      },
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    // Reserved keys should not override the built request
    expect(body.stream).toBe(true); // Must always be true
    // The actual messages should be from the input, not forwardedProps
    expect((body.messages as any[])[0].content).toBe("Hello");
    // Non-reserved keys should pass through
    expect(body.temperature).toBe(0.7);
    expect(body.model).toBe("gpt-4");
  });

  it("forwards tools in OpenAI function format", async () => {
    const capture = captureFetch();
    const tools: Tool[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools,
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const bodyTools = body.tools as any[];
    expect(bodyTools).toHaveLength(1);
    expect(bodyTools[0].type).toBe("function");
    expect(bodyTools[0].function.name).toBe("get_weather");
    expect(bodyTools[0].function.description).toBe("Get weather for a city");
    expect(bodyTools[0].function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("does not include tools in request body when tools array is empty", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    expect(body.tools).toBeUndefined();
  });

  it("sends Authorization and omits X-IBM-THREAD-ID on the first turn", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("iam.cloud.ibm.com")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            access_token: "tok",
            expiration: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      capturedHeaders = opts?.headers ?? null;
      return Promise.resolve(sseResponse([textChunk("ok")]));
    });

    const input: RunAgentInput = {
      threadId: "my-thread-42",
      runId: "r-1",
      messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    expect(capturedHeaders).toBeDefined();
    // watsonx ignores client-invented thread IDs; the header is omitted so
    // watsonx creates the thread, and the returned thread_id is reused later
    // (see thread-persistence.test.ts).
    expect(capturedHeaders!["X-IBM-THREAD-ID"]).toBeUndefined();
    expect(capturedHeaders!["Authorization"]).toBe("Bearer tok");
    expect(capturedHeaders!["Content-Type"]).toBe("application/json");
  });

  it("maps system messages correctly", async () => {
    const capture = captureFetch();
    const input: RunAgentInput = {
      threadId: "t-1",
      runId: "r-1",
      messages: [
        { id: "s-1", role: "system", content: "Be helpful" } as Message,
        { id: "m-1", role: "user", content: "Hello" } as Message,
      ],
      state: null,
      tools: [],
      context: [],
      forwardedProps: {},
    };

    await collectEvents(makeAgent(), input);

    const body = capture.getBody();
    const msgs = body.messages as any[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Be helpful");
  });
});
