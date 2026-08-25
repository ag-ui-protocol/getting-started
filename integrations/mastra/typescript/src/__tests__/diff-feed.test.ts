import {
  FakeMemory,
  FakeLocalAgent,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

const SIMPLE_STREAM_CHUNKS = [
  { type: "text-delta", payload: { text: "ok" } },
  { type: "finish", payload: {} },
];

/**
 * OSS-105: AG-UI clients re-send the whole conversation every turn. The bridge
 * must forward only the messages Mastra hasn't already stored (the new turn),
 * so Mastra memory — not the re-sent history — owns the thread. Without this,
 * re-sent history is re-persisted and storage balloons.
 */
describe("only-new-messages diff feed", () => {
  it("forwards only messages whose id is not already stored", async () => {
    const memory = new FakeMemory();
    // Mastra already has the first turn persisted (ids u1 + a1).
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hi" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hello" }] } },
    ];

    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    // Client re-sends the full history + the new user message.
    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "a1", role: "assistant", content: "hello" },
          { id: "u2", role: "user", content: "say bye" },
        ] as any,
      }),
    );

    const sent = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!;
    const ids = sent.map((m: any) => m.id);
    expect(ids).toEqual(["u2"]); // only the new turn reaches Mastra
  });

  it("forwards the full list on the first turn (nothing stored yet)", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
  });

  it("falls back to the full list if every message is already stored", async () => {
    // Defensive: never send an empty turn.
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hi" }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
  });

  it("re-includes the matching assistant tool-call when a tool-result is the new turn", async () => {
    // A lone tool-result can't resolve the stored pending call (Mastra appends a
    // separate result → call/result split → model re-calls). So the retained
    // tool-result must travel with its assistant tool-call, in order.
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "change bg" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "tc1", toolName: "change_background", args: {} } }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "change bg" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", type: "function", function: { name: "change_background", arguments: "{}" } }],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
        ] as any,
      }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    // a1 (stored) is re-included so it precedes its result; order preserved.
    expect(ids).toEqual(["a1", "t1"]);
  });

  it("forwards the full list for remote agents (no local memory to dedupe against)", async () => {
    const agent = makeRemoteMastraAgent({ streamChunks: SIMPLE_STREAM_CHUNKS });
    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "u2", role: "user", content: "bye" },
        ] as any,
      }),
    );
    const ids = (agent.agent as any).lastStreamMessages?.map((m: any) => m.id) ?? null;
    // Remote fake records messages too; both forwarded unchanged.
    expect(ids).toEqual(["u1", "u2"]);
  });
});
