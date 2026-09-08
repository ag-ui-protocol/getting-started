import { EventType } from "@ag-ui/client";
import {
  FakeMemory,
  makeLocalMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

const SIMPLE_STREAM_CHUNKS = [
  { type: "text-delta", payload: { text: "Hello" } },
  { type: "finish", payload: {} },
];

const TOOL_STREAM_CHUNKS = [
  { type: "tool-call", payload: { toolCallId: "t1", toolName: "x", args: {} } },
  { type: "tool-result", payload: { toolCallId: "t1", result: "ok" } },
  { type: "finish", payload: {} },
];

/**
 * The bridge concludes a run with a working-memory STATE_SNAPSHOT, then
 * RUN_FINISHED. It deliberately does NOT emit MESSAGES_SNAPSHOT: diff-feed
 * keeps storage in sync with the client, so re-sending the recalled history is
 * redundant — and it collapsed the client's correctly-ordered streamed
 * messages (tool card vs text) into one Mastra message, flipping their order.
 */
describe("run-end snapshots", () => {
  it("emits a working-memory STATE_SNAPSHOT before RUN_FINISHED", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({ key: "value" });

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());
    const types = events.map((e) => e.type);

    const stateIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
    expect(stateIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(finishedIdx);
  });

  it("never emits MESSAGES_SNAPSHOT (text turn)", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "hi" }] },
      },
    ];
    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const types = (await collectEvents(agent, makeInput())).map((e) => e.type);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("never emits MESSAGES_SNAPSHOT (tool turn)", async () => {
    const memory = new FakeMemory();
    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: TOOL_STREAM_CHUNKS,
    });

    const types = (await collectEvents(agent, makeInput())).map((e) => e.type);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("still emits RUN_FINISHED if the working-memory snapshot fails", async () => {
    const memory = new FakeMemory();
    memory.getWorkingMemory = async () => {
      throw new Error("DB connection failed");
    };
    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const types = (await collectEvents(agent, makeInput())).map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
  });
});
