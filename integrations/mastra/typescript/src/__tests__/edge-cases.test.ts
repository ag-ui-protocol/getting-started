import { vi } from "vitest";
import type { TextMessageChunkEvent, ToolCallStartEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  FakeMemory,
  FakeLocalAgent,
  FakeRemoteAgent,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectError,
} from "./helpers";

describe("working memory edge cases", () => {
  it("emits STATE_SNAPSHOT with wrapped markdown when working memory is not JSON", async () => {
    const markdown = "# User Profile\n## Personal Info\n- Name:\n- Location:";
    const memory = new FakeMemory();
    memory.workingMemoryValue = markdown;

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).snapshot).toEqual({
      workingMemory: markdown,
    });
  });

  it("emits STATE_SNAPSHOT with parsed JSON when working memory is valid JSON", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({
      name: "Alice",
      location: "NYC",
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).snapshot).toEqual({
      name: "Alice",
      location: "NYC",
    });
  });

  it("does not emit STATE_SNAPSHOT when parsed JSON contains $schema", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({
      $schema: "http://example.com",
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    expect(snapshots).toHaveLength(0);
  });

  it("does not emit STATE_SNAPSHOT when getWorkingMemory returns undefined", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = undefined;

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    expect(snapshots).toHaveLength(0);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  // The input.state -> working-memory sync writes through Mastra's
  // resource-scoped store (memory.updateWorkingMemory), NOT thread.metadata:
  // that is the store the agent (getWorkingMemory + its own updateWorkingMemory
  // tool) actually reads, so a client edit reaches the model. These assert the
  // synced payload via the recorded updateWorkingMemory call.
  const lastSyncedWorkingMemory = (memory: FakeMemory) => {
    const call = memory.updateWorkingMemoryCalls.at(-1);
    return call ? JSON.parse(call.workingMemory) : undefined;
  };

  it("starts fresh when existing working memory is invalid JSON", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = "not valid json {{{";

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { foo: "bar" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(lastSyncedWorkingMemory(memory)).toEqual({ foo: "bar" });
  });

  it("syncs state to working memory when none exists yet", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { userName: "Bob" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(memory.updateWorkingMemoryCalls.length).toBeGreaterThan(0);
    expect(lastSyncedWorkingMemory(memory)).toEqual({ userName: "Bob" });
  });

  it("merges input state over existing JSON working memory", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({ existing: "data", count: 1 });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { count: 2, newField: "hello" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(lastSyncedWorkingMemory(memory)).toEqual({
      existing: "data",
      count: 2,
      newField: "hello",
    });
  });

  it("strips messages key from input state before syncing to working memory", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({
        state: {
          messages: [{ id: "1", role: "user", content: "hi" }],
          importantData: "keep",
        },
      }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(lastSyncedWorkingMemory(memory)).toEqual({ importantData: "keep" });
  });

  it("skips state management when memory is null", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.getMemory = async () => null as any;

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeInput({ state: { foo: "bar" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("skips state management when input.state is empty", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput({ state: {} }));

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(memory.threads.size).toBe(0);
  });
});

describe("remote working-memory sync (client -> agent shared state)", () => {
  // A minimal MastraClient stand-in exposing the working-memory HTTP methods
  // the bridge uses for remote agents.
  class FakeRemoteClient {
    workingMemoryValue: string | undefined;
    getCalls: any[] = [];
    updateCalls: Array<{
      agentId: string;
      threadId: string;
      resourceId?: string;
      workingMemory: string;
    }> = [];
    constructor(initial?: string) {
      this.workingMemoryValue = initial;
    }
    async getWorkingMemory(args: any) {
      this.getCalls.push(args);
      return this.workingMemoryValue;
    }
    async updateWorkingMemory(args: any) {
      this.updateCalls.push(args);
      this.workingMemoryValue = args.workingMemory;
    }
  }

  const makeRemote = (client: FakeRemoteClient, streamChunks: any[] = []) =>
    new MastraAgent({
      agentId: "remote-agent",
      agent: new FakeRemoteAgent({ streamChunks }) as any,
      resourceId: "resource-1",
      remoteClient: client as any,
    });

  it("writes input.state to the remote server's working memory via the client", async () => {
    const client = new FakeRemoteClient();
    const agent = makeRemote(client);

    const events = await collectEvents(
      agent,
      makeInput({ state: { recipe: { title: "Soup" } } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(client.updateCalls).toHaveLength(1);
    expect(client.updateCalls[0]).toMatchObject({
      agentId: "remote-agent",
      threadId: "thread-1",
      resourceId: "resource-1",
    });
    expect(JSON.parse(client.updateCalls[0].workingMemory)).toEqual({
      recipe: { title: "Soup" },
    });
  });

  it("merges input.state over the remote's existing working memory", async () => {
    const client = new FakeRemoteClient(
      JSON.stringify({ existing: "data", recipe: { title: "Old" } }),
    );
    const agent = makeRemote(client);

    await collectEvents(
      agent,
      makeInput({ state: { recipe: { title: "New" } } }),
    );

    expect(JSON.parse(client.updateCalls.at(-1)!.workingMemory)).toEqual({
      existing: "data",
      recipe: { title: "New" },
    });
  });

  it("no-ops when input.state is empty (no client write)", async () => {
    const client = new FakeRemoteClient();
    const agent = makeRemote(client);

    const events = await collectEvents(agent, makeInput({ state: {} }));

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(client.updateCalls).toHaveLength(0);
  });

  it("does not crash a remote agent without a client (sync is skipped)", async () => {
    const agent = new MastraAgent({
      agentId: "remote-agent",
      agent: new FakeRemoteAgent({ streamChunks: [] }) as any,
      resourceId: "resource-1",
      // no remoteClient
    });

    const events = await collectEvents(
      agent,
      makeInput({ state: { recipe: { title: "Soup" } } }),
    );
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });
});

describe("error handling", () => {
  it("propagates error chunk from local agent stream to subscriber", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "error", payload: { error: "Something went wrong" } },
      ],
    });

    const { error, events } = await collectError(agent, makeInput());
    expect(error.message).toBe("Something went wrong");

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
  });

  it("propagates error when local agent stream() throws", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.stream = async () => {
      throw new Error("Agent connection failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(agent, makeInput());
    expect(error.message).toBe("Agent connection failed");
  });

  it("propagates error when remote agent stream() throws", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    fakeAgent.stream = async () => {
      throw new Error("Remote agent unavailable");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(agent, makeInput());
    expect(error.message).toBe("Remote agent unavailable");
  });

  it("still emits RUN_FINISHED when getWorkingMemory throws on run finish", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = new FakeMemory();
    memory.getWorkingMemory = async () => {
      throw new Error("Memory service down");
    };

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to emit working memory snapshot"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe("remote agent path", () => {
  it("both local and remote agents produce the same event types for text streaming", async () => {
    const chunks = [{ type: "text-delta", payload: { text: "hello" } }];

    const localEvents = await collectEvents(
      makeLocalMastraAgent({ streamChunks: chunks }),
      makeInput(),
    );
    const remoteEvents = await collectEvents(
      makeRemoteMastraAgent({ streamChunks: chunks }),
      makeInput(),
    );

    const localTypes = localEvents.map((e) => e.type);
    const remoteTypes = remoteEvents.map((e) => e.type);

    expect(localTypes).toEqual(remoteTypes);
  });

  it("does not emit STATE_SNAPSHOT for remote agents", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    expect(snapshots).toHaveLength(0);
  });

  it("handles tool calls via processDataStream for remote agents", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-r1",
            toolName: "search",
            args: { query: "test" },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-r1",
            result: { results: [] },
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );

    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallName).toBe("search");
  });
});

describe("event emission details (fake-only)", () => {
  it("assigns new messageId after finish chunk (multi-turn)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Turn 1" } },
        { type: "finish", payload: {} },
        { type: "text-delta", payload: { text: "Turn 2" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunks = events.filter(
      (e): e is TextMessageChunkEvent =>
        e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    expect(textChunks[0].messageId).not.toBe(textChunks[1].messageId);
  });

  it("assigns new messageId after step-finish (multi-step tool flow)", async () => {
    // Reproduces: text -> tool -> text -> tool across two LLM steps.
    // Without the fix, all TEXT_MESSAGE_CHUNK events share the same
    // messageId, causing the ag-ui client to merge them into one message.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: {} },
        { type: "text-delta", payload: { text: "I'll research..." } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "research_topic",
            args: { topic: "quantum" },
          },
        },
        {
          type: "tool-result",
          payload: { toolCallId: "tc-1", result: { findings: "data" } },
        },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: {} },
        { type: "text-delta", payload: { text: "Here are findings..." } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-2",
            toolName: "show_findings",
            args: { title: "Results" },
          },
        },
        {
          type: "tool-result",
          payload: { toolCallId: "tc-2", result: "ok" },
        },
        { type: "step-finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunks = events.filter(
      (e): e is TextMessageChunkEvent =>
        e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    // Each step's text must have a distinct messageId
    expect(textChunks[0].messageId).not.toBe(textChunks[1].messageId);

    // Tool calls should reference their step's messageId
    const toolStarts = events.filter(
      (e): e is ToolCallStartEvent => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].parentMessageId).toBe(textChunks[0].messageId);
    expect(toolStarts[1].parentMessageId).toBe(textChunks[1].messageId);
  });

  it("tool call start references current messageId as parentMessageId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Let me check" } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "search",
            args: {},
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;

    expect(toolStart.parentMessageId).toBe(textChunk.messageId);
  });

  it("emits full tool call sequence: START, ARGS, END, RESULT", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-1",
            result: { temp: 72 },
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const toolEvents = events.filter((e) =>
      [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
      ].includes(e.type),
    );

    expect(toolEvents.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);

    expect((toolEvents[0] as any).toolCallName).toBe("get_weather");
    expect((toolEvents[1] as any).delta).toBe(JSON.stringify({ city: "NYC" }));
    expect((toolEvents[3] as any).content).toBe(JSON.stringify({ temp: 72 }));
  });

  it("tool-only step (no preceding text) still rotates messageId for next step", async () => {
    // When a step contains only tool calls (no text), flush() is a no-op but
    // onFinishMessagePart still fires and rotates the messageId. A subsequent
    // step's text must get a fresh ID, not the one from before the tool-only step.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: {} },
        { type: "text-delta", payload: { text: "Step 1 text" } },
        { type: "step-finish", payload: {} },
        // Tool-only step — no text-delta
        { type: "step-start", payload: {} },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "lookup",
            args: { key: "x" },
          },
        },
        {
          type: "tool-result",
          payload: { toolCallId: "tc-1", result: "found" },
        },
        { type: "step-finish", payload: {} },
        // Third step — text should have a fresh ID
        { type: "step-start", payload: {} },
        { type: "text-delta", payload: { text: "Step 3 text" } },
        { type: "step-finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunks = events.filter(
      (e): e is TextMessageChunkEvent =>
        e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    // Step 1 and Step 3 text must have distinct messageIds
    expect(textChunks[0].messageId).not.toBe(textChunks[1].messageId);
  });

  describe("custom-data / missing-payload chunks (#1635)", () => {
    it("skips a custom-data chunk lacking a payload instead of aborting the stream", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "text-delta", payload: { text: "Hello" } },
          // Mastra 1.31 custom-data chunk: carries `data`, no `payload`.
          {
            type: "data-workspace-metadata",
            data: { workspaceId: "ws-1", title: "My Workspace" },
          },
          { type: "text-delta", payload: { text: " world" } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });

      const events = await collectEvents(agent, makeInput());

      // The stream must NOT abort: RUN_FINISHED is still emitted.
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

      // Both text deltas (before and after the custom-data chunk) flow through.
      const joinedText = events
        .filter(
          (e): e is TextMessageChunkEvent =>
            e.type === EventType.TEXT_MESSAGE_CHUNK,
        )
        .map((e) => e.delta ?? "")
        .join("");
      expect(joinedText).toContain("Hello");
      expect(joinedText).toContain("world");

      warnSpy.mockRestore();
    });

    it("recognizes text-start / text-end / tool-output without warning (#1635, #836)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "text-start", payload: { id: "t1" } },
          { type: "text-delta", payload: { text: "Hi" } },
          { type: "text-end", payload: { id: "t1" } },
          { type: "tool-output", payload: { output: "interim" } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });

      const events = await collectEvents(agent, makeInput());

      // Text still flows and the run completes.
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
      const joinedText = events
        .filter(
          (e): e is TextMessageChunkEvent =>
            e.type === EventType.TEXT_MESSAGE_CHUNK,
        )
        .map((e) => e.delta ?? "")
        .join("");
      expect(joinedText).toContain("Hi");

      // None of these recognized types hit the `default:` warn flood.
      const warnedTypes = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        warnedTypes.some(
          (m) =>
            m.includes("Unrecognized stream chunk type") &&
            (m.includes("text-start") ||
              m.includes("text-end") ||
              m.includes("tool-output")),
        ),
      ).toBe(false);

      warnSpy.mockRestore();
    });

    it("warns at most once per payload-less chunk type (no log flood)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "data-workspace-metadata", data: { n: 1 } },
          { type: "data-workspace-metadata", data: { n: 2 } },
          { type: "data-workspace-metadata", data: { n: 3 } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });

      const events = await collectEvents(agent, makeInput());

      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

      const skipWarns = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter(
          (m) =>
            m.includes("Skipping stream chunk without payload") &&
            m.includes("data-workspace-metadata"),
        );
      expect(skipWarns).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });
});
