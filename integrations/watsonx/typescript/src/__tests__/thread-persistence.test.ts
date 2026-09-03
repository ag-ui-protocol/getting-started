/**
 * Tests for watsonx thread lifecycle handling: capturing the watsonx-managed
 * thread_id from the SSE stream and reusing it on subsequent runs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WatsonxAgent, type WatsonxThreadIdStore } from "../index";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { firstValueFrom, toArray } from "rxjs";
import type { RunAgentInput, Message } from "@ag-ui/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(threadIdStore?: WatsonxThreadIdStore) {
  return new WatsonxAgent({
    region: "us-south",
    instanceId: "inst-1",
    agentId: "agent-1",
    bearerToken: "tok",
    threadIdStore,
  });
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m-1", role: "user", content: "Hello" } as Message],
    state: null,
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

function textChunk(content: string, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    choices: [{ delta: { content }, finish_reason: null }],
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

/**
 * Mock fetch so every chat request gets a fresh SSE response built from
 * `chunks`, recording headers and bodies of each chat request.
 */
function mockFetch(chunks: (object | string)[]) {
  const requests: { headers: Record<string, string>; body: any }[] = [];
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
    requests.push({
      headers: opts?.headers ?? {},
      body: JSON.parse(opts?.body ?? "{}"),
    });
    return Promise.resolve(sseResponse(chunks));
  });
  return requests;
}

async function collectEvents(
  agent: WatsonxAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watsonx thread persistence", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits X-IBM-THREAD-ID on the first turn of a thread", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-1" })]);
    await collectEvents(makeAgent(), makeInput());

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["X-IBM-THREAD-ID"]).toBeUndefined();
  });

  it("reuses the watsonx thread_id from the stream on the next run", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-abc" })]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ runId: "r-1" }));
    await collectEvents(agent, makeInput({ runId: "r-2" }));

    expect(requests).toHaveLength(2);
    expect(requests[0].headers["X-IBM-THREAD-ID"]).toBeUndefined();
    expect(requests[1].headers["X-IBM-THREAD-ID"]).toBe("wx-abc");
  });

  it("tracks watsonx thread IDs per AG-UI thread", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-1" })]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ threadId: "t-1" }));
    await collectEvents(agent, makeInput({ threadId: "t-2" }));

    // Second AG-UI thread is new to watsonx, so no header yet.
    expect(requests[1].headers["X-IBM-THREAD-ID"]).toBeUndefined();
  });

  it("captures thread_id from chunks without choices", async () => {
    const requests = mockFetch([
      { thread_id: "wx-only" },
      textChunk("Hi"),
    ]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ runId: "r-1" }));
    await collectEvents(agent, makeInput({ runId: "r-2" }));

    expect(requests[1].headers["X-IBM-THREAD-ID"]).toBe("wx-only");
  });

  it("sends only messages since the last user message when continuing", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-1" })]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ runId: "r-1" }));

    const history: Message[] = [
      { id: "m-1", role: "user", content: "Hello" } as Message,
      { id: "a-1", role: "assistant", content: "Hi" } as Message,
      { id: "m-2", role: "user", content: "Follow-up" } as Message,
    ];
    await collectEvents(agent, makeInput({ runId: "r-2", messages: history }));

    // First turn sends full history; continuation sends only the new suffix.
    expect(requests[0].body.messages).toHaveLength(1);
    expect(requests[1].body.messages).toHaveLength(1);
    expect(requests[1].body.messages[0].content).toBe("Follow-up");
  });

  it("keeps trailing assistant/tool messages after the last user message", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-1" })]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ runId: "r-1" }));

    const history: Message[] = [
      { id: "m-1", role: "user", content: "Weather?" } as Message,
      {
        id: "a-1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      } as unknown as Message,
      {
        id: "t-1",
        role: "tool",
        content: "Sunny",
        toolCallId: "tc-1",
      } as unknown as Message,
    ];
    await collectEvents(agent, makeInput({ runId: "r-2", messages: history }));

    const sent = requests[1].body.messages;
    expect(sent.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("uses a custom threadIdStore when provided", async () => {
    const backing = new Map<string, string>([["t-1", "wx-stored"]]);
    const store: WatsonxThreadIdStore = {
      get: async (id) => backing.get(id),
      set: async (id, wxId) => {
        backing.set(id, wxId);
      },
    };
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-new" })]);

    await collectEvents(makeAgent(store), makeInput());

    expect(requests[0].headers["X-IBM-THREAD-ID"]).toBe("wx-stored");
    expect(backing.get("t-1")).toBe("wx-new");
  });

  it("clone() shares the thread-id store", async () => {
    const requests = mockFetch([textChunk("Hi", { thread_id: "wx-clone" })]);
    const agent = makeAgent();

    await collectEvents(agent, makeInput({ runId: "r-1" }));
    const cloned = agent.clone();
    await collectEvents(cloned, makeInput({ runId: "r-2" }));

    expect(requests[1].headers["X-IBM-THREAD-ID"]).toBe("wx-clone");
  });

  it("still emits a normal event lifecycle when thread_id is present", async () => {
    mockFetch([textChunk("Hi", { thread_id: "wx-1" })]);
    const events = await collectEvents(makeAgent(), makeInput());

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
  });
});
