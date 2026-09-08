import { EventType } from "@ag-ui/client";
import type { ActivitySnapshotEvent, ActivityDeltaEvent } from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

const ACTIVITY_TYPE = "mastra-background-task";

// Minimal RFC 6902 applier for the op set the bridge emits ("add", incl. the
// "/arr/-" append token). Lets tests assert the reconstructed activity content,
// not just individual patch ops.
function applyPatches(
  base: Record<string, any>,
  patches: Array<Record<string, any>>,
): Record<string, any> {
  const doc = structuredClone(base);
  for (const { op, path, value } of patches) {
    if (op !== "add") throw new Error(`unexpected op ${op}`);
    const parts = path.split("/").slice(1);
    let cur: any = doc;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    const last = parts[parts.length - 1];
    if (last === "-" && Array.isArray(cur)) cur.push(value);
    else cur[last] = value;
  }
  return doc;
}

// Reconstruct the per-task activity content the client would hold after
// replaying the snapshot + all deltas for `messageId` (taskId).
function reconstruct(events: any[], messageId: string): Record<string, any> {
  const snap = events.find(
    (e) => e.type === EventType.ACTIVITY_SNAPSHOT && e.messageId === messageId,
  ) as ActivitySnapshotEvent | undefined;
  if (!snap) throw new Error(`no snapshot for ${messageId}`);
  let content = snap.content as Record<string, any>;
  for (const e of events) {
    if (e.type === EventType.ACTIVITY_DELTA && e.messageId === messageId) {
      content = applyPatches(content, (e as ActivityDeltaEvent).patch as any);
    }
  }
  return content;
}

const STARTED = {
  type: "background-task-started",
  payload: {
    taskId: "task-1",
    toolName: "deep_research",
    toolCallId: "call-1",
  },
};

describe("Mastra background tasks -> AG-UI activity events", () => {
  const factories: Array<[string, typeof makeLocalMastraAgent]> = [
    ["local agent", makeLocalMastraAgent],
    ["remote agent", makeRemoteMastraAgent],
  ];

  for (const [label, makeAgent] of factories) {
    describe(label, () => {
      it("maps background-task-started to a single ACTIVITY_SNAPSHOT", async () => {
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].messageId).toBe("task-1");
        expect(snaps[0].activityType).toBe(ACTIVITY_TYPE);
        expect(snaps[0].content).toMatchObject({
          taskId: "task-1",
          toolName: "deep_research",
          toolCallId: "call-1",
          status: "running",
          outputs: [],
        });
      });

      it("suppresses the normal tool render and the placeholder ack for a backgrounded call (real loop shape)", async () => {
        // Real Mastra surfaces `tool-call` -> `background-task-started` ->
        // placeholder `tool-result` on the dispatching run's stream. The tool
        // call/result must NOT render (it's an activity), the task args are
        // lifted onto the snapshot, and the activity stays "running" (the real
        // outcome is delivered out of band, not on this stream).
        const agent = makeAgent({
          streamChunks: [
            {
              type: "tool-call",
              payload: {
                toolCallId: "call-1",
                toolName: "deep_research",
                args: { topic: "solana" },
              },
            },
            STARTED,
            {
              type: "tool-result",
              payload: {
                toolCallId: "call-1",
                result:
                  'Background task started. The tool "deep_research" is running in the background.',
              },
            },
            {
              type: "text-delta",
              payload: { text: "Kicked off the research." },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());
        const types = events.map((e) => e.type);

        // No normal tool rendering for the backgrounded call.
        expect(types).not.toContain(EventType.TOOL_CALL_START);
        expect(types).not.toContain(EventType.TOOL_CALL_RESULT);

        const snap = events.find(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent;
        expect(snap.content).toMatchObject({
          status: "running",
          args: { topic: "solana" },
        });

        // Activity stays running (no false completion from the placeholder).
        expect(reconstruct(events, "task-1").status).toBe("running");
      });

      it("maps a detached background-task-completed chunk to a completed activity", async () => {
        // When a stream DOES carry the manager's lifecycle chunks, completion
        // is authoritative.
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            {
              type: "background-task-completed",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                result: { summary: "done" },
                completedAt: new Date("2026-01-01T00:00:05.000Z"),
              },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());
        const content = reconstruct(events, "task-1");
        expect(content.status).toBe("completed");
        expect(content.result).toEqual({ summary: "done" });
      });

      it("maps an inline tool-error on a backgrounded call to failed", async () => {
        const agent = makeAgent({
          streamChunks: [
            {
              type: "tool-call",
              payload: {
                toolCallId: "call-1",
                toolName: "deep_research",
                args: {},
              },
            },
            STARTED,
            {
              type: "tool-error",
              payload: { toolCallId: "call-1", error: { message: "kaboom" } },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());
        const content = reconstruct(events, "task-1");
        expect(content.status).toBe("failed");
        expect(content.error).toBe("kaboom");
      });

      it("maps lifecycle chunks to ACTIVITY_DELTA reaching a completed state", async () => {
        const completedAt = new Date("2026-01-01T00:00:05.000Z");
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            {
              type: "background-task-running",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                args: { query: "solana" },
                startedAt: new Date("2026-01-01T00:00:00.000Z"),
              },
            },
            {
              type: "background-task-output",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                payload: { type: "tool-output", payload: "partial-1" },
              },
            },
            {
              type: "background-task-progress",
              payload: {
                taskIds: ["task-1"],
                runningCount: 1,
                elapsedMs: 1200,
              },
            },
            {
              type: "background-task-completed",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                result: { summary: "done" },
                completedAt,
              },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const deltas = events.filter(
          (e) => e.type === EventType.ACTIVITY_DELTA,
        ) as ActivityDeltaEvent[];
        expect(deltas.length).toBeGreaterThanOrEqual(4);
        expect(deltas.every((d) => d.messageId === "task-1")).toBe(true);
        expect(deltas.every((d) => d.activityType === ACTIVITY_TYPE)).toBe(
          true,
        );

        const content = reconstruct(events, "task-1");
        expect(content).toMatchObject({
          taskId: "task-1",
          status: "completed",
          args: { query: "solana" },
          outputs: ["partial-1"],
          elapsedMs: 1200,
          result: { summary: "done" },
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
        });
      });

      it("maps background-task-failed to a failed status with the error message", async () => {
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            {
              type: "background-task-failed",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                error: { message: "boom" },
                completedAt: new Date("2026-01-01T00:00:03.000Z"),
              },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const content = reconstruct(events, "task-1");
        expect(content.status).toBe("failed");
        expect(content.error).toBe("boom");
      });

      it("maps suspend/resume transitions", async () => {
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            {
              type: "background-task-suspended",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                suspendPayload: { reason: "need-approval" },
              },
            },
            {
              type: "background-task-resumed",
              payload: {
                taskId: "task-1",
                toolName: "deep_research",
                toolCallId: "call-1",
                args: { approved: true },
              },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const statuses = (
          events.filter(
            (e) => e.type === EventType.ACTIVITY_DELTA,
          ) as ActivityDeltaEvent[]
        ).flatMap((d) =>
          (d.patch as any[])
            .filter((p) => p.path === "/status")
            .map((p) => p.value),
        );
        expect(statuses).toEqual(["suspended", "resumed"]);

        const content = reconstruct(events, "task-1");
        expect(content.status).toBe("resumed");
        expect(content.suspendPayload).toEqual({ reason: "need-approval" });
      });

      it("tracks two concurrent tasks as separate activities", async () => {
        const agent = makeAgent({
          streamChunks: [
            STARTED,
            {
              type: "background-task-started",
              payload: {
                taskId: "task-2",
                toolName: "summarize",
                toolCallId: "call-2",
              },
            },
            {
              type: "background-task-progress",
              payload: {
                taskIds: ["task-1", "task-2"],
                runningCount: 2,
                elapsedMs: 500,
              },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps.map((s) => s.messageId).sort()).toEqual([
          "task-1",
          "task-2",
        ]);
        expect(reconstruct(events, "task-1").elapsedMs).toBe(500);
        expect(reconstruct(events, "task-2").elapsedMs).toBe(500);
      });

      it("ignores progress ticks for unknown task ids", async () => {
        const agent = makeAgent({
          streamChunks: [
            {
              type: "background-task-progress",
              payload: { taskIds: ["ghost"], runningCount: 1, elapsedMs: 99 },
            },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());
        expect(
          events.filter(
            (e) =>
              e.type === EventType.ACTIVITY_SNAPSHOT ||
              e.type === EventType.ACTIVITY_DELTA,
          ),
        ).toHaveLength(0);
      });

      it("does not emit activity events for ordinary streams", async () => {
        const agent = makeAgent({
          streamChunks: [
            { type: "text-delta", payload: { text: "hello" } },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });
        const events = await collectEvents(agent, makeInput());
        expect(
          events.filter(
            (e) =>
              e.type === EventType.ACTIVITY_SNAPSHOT ||
              e.type === EventType.ACTIVITY_DELTA,
          ),
        ).toHaveLength(0);
      });
    });
  }
});
