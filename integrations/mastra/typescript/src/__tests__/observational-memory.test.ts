import { EventType } from "@ag-ui/client";
import type {
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  TextMessageChunkEvent,
} from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

const ACTIVITY_TYPE = "mastra-observational-memory";

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

// Reconstruct the per-cycle activity content the client would hold after
// replaying the snapshot + all deltas for `messageId` (cycleId).
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

// Realistic OM stream chunks. OM data parts arrive on fullStream as
// `{ type: "data-om-*", data: {...} }` (note: `data`, not `payload`).
const OBSERVATION_START = {
  type: "data-om-observation-start",
  data: {
    cycleId: "cycle-obs-1",
    operationType: "observation",
    startedAt: "2026-06-30T00:00:00.000Z",
    tokensToObserve: 4200,
    recordId: "rec-1",
    threadId: "thread-1",
    threadIds: ["thread-1"],
  },
};
const OBSERVATION_END = {
  type: "data-om-observation-end",
  data: {
    cycleId: "cycle-obs-1",
    operationType: "observation",
    completedAt: "2026-06-30T00:00:02.500Z",
    durationMs: 2500,
    tokensObserved: 4200,
    observationTokens: 600,
    observations: "User prefers concise answers and is researching Solana.",
    currentTask: "Research the Solana ecosystem",
    suggestedResponse: "Summarize findings so far.",
    recordId: "rec-1",
    threadId: "thread-1",
  },
};
const FINISH = { type: "finish", payload: { finishReason: "stop" } };

describe("Mastra Observational Memory -> AG-UI activity events", () => {
  const factories: Array<[string, typeof makeLocalMastraAgent]> = [
    ["local agent", makeLocalMastraAgent],
    ["remote agent", makeRemoteMastraAgent as typeof makeLocalMastraAgent],
  ];

  for (const [label, makeAgent] of factories) {
    describe(label, () => {
      it("maps an observation cycle to a snapshot + completed delta", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [OBSERVATION_START, OBSERVATION_END, FINISH],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].messageId).toBe("cycle-obs-1");
        expect(snaps[0].activityType).toBe(ACTIVITY_TYPE);
        expect(snaps[0].content).toMatchObject({
          cycleId: "cycle-obs-1",
          operationType: "observation",
          phase: "observation",
          status: "running",
          tokensToObserve: 4200,
          threadId: "thread-1",
          recordId: "rec-1",
        });

        const content = reconstruct(events, "cycle-obs-1");
        expect(content).toMatchObject({
          phase: "observation",
          status: "completed",
          durationMs: 2500,
          tokensObserved: 4200,
          observationTokens: 600,
          observations:
            "User prefers concise answers and is researching Solana.",
          currentTask: "Research the Solana ecosystem",
          suggestedResponse: "Summarize findings so far.",
          completedAt: "2026-06-30T00:00:02.500Z",
        });
      });

      it("maps a buffering cycle to a snapshot + completed delta", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [
            {
              type: "data-om-buffering-start",
              data: {
                cycleId: "cycle-buf-1",
                operationType: "observation",
                startedAt: "2026-06-30T00:00:00.000Z",
                tokensToBuffer: 8000,
                recordId: "rec-1",
                threadId: "thread-1",
                threadIds: ["thread-1"],
              },
            },
            {
              type: "data-om-buffering-end",
              data: {
                cycleId: "cycle-buf-1",
                operationType: "observation",
                completedAt: "2026-06-30T00:00:03.000Z",
                durationMs: 3000,
                tokensBuffered: 8000,
                bufferedTokens: 900,
                observations: "Buffered: user is comparing L1 chains.",
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            FINISH,
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].content).toMatchObject({
          cycleId: "cycle-buf-1",
          phase: "buffering",
          status: "running",
          tokensToBuffer: 8000,
        });

        const content = reconstruct(events, "cycle-buf-1");
        expect(content).toMatchObject({
          phase: "buffering",
          status: "completed",
          durationMs: 3000,
          tokensBuffered: 8000,
          bufferedTokens: 900,
          observations: "Buffered: user is comparing L1 chains.",
        });
      });

      it("maps observation-failed to a failed delta carrying the error", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [
            OBSERVATION_START,
            {
              type: "data-om-observation-failed",
              data: {
                cycleId: "cycle-obs-1",
                operationType: "observation",
                failedAt: "2026-06-30T00:00:01.000Z",
                durationMs: 1000,
                tokensAttempted: 4200,
                error: "Observer model timed out",
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            FINISH,
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const content = reconstruct(events, "cycle-obs-1");
        expect(content).toMatchObject({
          status: "failed",
          error: "Observer model timed out",
          durationMs: 1000,
          completedAt: "2026-06-30T00:00:01.000Z",
        });
      });

      it("maps activation to a single terminal 'activated' snapshot", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [
            {
              type: "data-om-activation",
              data: {
                cycleId: "cycle-act-1",
                operationType: "observation",
                activatedAt: "2026-06-30T00:00:05.000Z",
                chunksActivated: 2,
                tokensActivated: 4200,
                observationTokens: 600,
                messagesActivated: 12,
                generationCount: 1,
                triggeredBy: "threshold",
                observations: "Activated: condensed the early conversation.",
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            FINISH,
          ],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        const deltas = events.filter(
          (e) => e.type === EventType.ACTIVITY_DELTA,
        );
        expect(snaps).toHaveLength(1);
        expect(deltas).toHaveLength(0);
        expect(snaps[0].messageId).toBe("cycle-act-1");
        expect(snaps[0].content).toMatchObject({
          phase: "activation",
          status: "activated",
          chunksActivated: 2,
          tokensActivated: 4200,
          observationTokens: 600,
          messagesActivated: 12,
          generationCount: 1,
          triggeredBy: "threshold",
          observations: "Activated: condensed the early conversation.",
          completedAt: "2026-06-30T00:00:05.000Z",
        });
      });

      it("maps the real async lifecycle (buffering -> activation share a cycleId) to one activity", async () => {
        // Verified against @mastra/memory 1.21.2: the async path emits
        // buffering-start, buffering-end, then activation ALL under one cycleId
        // (e.g. "buffer-obs-..."). So activation must advance the SAME activity
        // to "activated" via a delta, not mint a second activity.
        const cycleId = "buffer-obs-1782820175678-abc";
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [
            {
              type: "data-om-buffering-start",
              data: {
                cycleId,
                operationType: "observation",
                startedAt: "2026-06-30T00:00:00.000Z",
                tokensToBuffer: 363,
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            {
              type: "data-om-buffering-end",
              data: {
                cycleId,
                operationType: "observation",
                completedAt: "2026-06-30T00:00:03.400Z",
                durationMs: 3402,
                tokensBuffered: 363,
                bufferedTokens: 195,
                observations: "User is planning a two-week trip through Japan.",
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            {
              type: "data-om-activation",
              data: {
                cycleId,
                operationType: "observation",
                activatedAt: "2026-06-30T00:00:03.680Z",
                chunksActivated: 1,
                tokensActivated: 363,
                observationTokens: 195,
                messagesActivated: 3,
                generationCount: 0,
                triggeredBy: "threshold",
                recordId: "rec-1",
                threadId: "thread-1",
              },
            },
            FINISH,
          ],
        });
        const events = await collectEvents(agent, makeInput());

        // Exactly ONE activity (one snapshot) for the whole buffering+activation
        // cycle, advanced by deltas.
        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].messageId).toBe(cycleId);

        const content = reconstruct(events, cycleId);
        // Terminal state is "activated", carrying the activation metrics, and
        // the buffered observation summary survives from the buffering-end delta.
        expect(content).toMatchObject({
          phase: "activation",
          status: "activated",
          bufferedTokens: 195,
          observations: "User is planning a two-week trip through Japan.",
          chunksActivated: 1,
          tokensActivated: 363,
          messagesActivated: 3,
          generationCount: 0,
          triggeredBy: "threshold",
          completedAt: "2026-06-30T00:00:03.680Z",
        });
      });

      it("seeds a defensive snapshot when an end arrives without a start", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [OBSERVATION_END, FINISH],
        });
        const events = await collectEvents(agent, makeInput());

        const snaps = events.filter(
          (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
        ) as ActivitySnapshotEvent[];
        expect(snaps).toHaveLength(1);
        const content = reconstruct(events, "cycle-obs-1");
        expect(content.status).toBe("completed");
      });

      it("with the toggle OFF, emits NO activity but still streams cleanly", async () => {
        const agent = makeAgent({
          // observationalMemory omitted -> default OFF
          streamChunks: [
            OBSERVATION_START,
            OBSERVATION_END,
            { type: "text-delta", payload: { text: "Here are the findings." } },
            FINISH,
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
        // The OM chunks must not break the stream: a RUN_FINISHED and the
        // assistant text after the OM chunks both make it through.
        expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(
          true,
        );
        const text = events
          .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
          .map((e) => (e as TextMessageChunkEvent).delta)
          .join("");
        expect(text).toContain("Here are the findings.");
      });

      it("swallows non-surfaced OM parts (status / thread-update) without error", async () => {
        const agent = makeAgent({
          observationalMemory: true,
          streamChunks: [
            {
              type: "data-om-status",
              data: {
                recordId: "rec-1",
                threadId: "thread-1",
                windows: {
                  active: {
                    messages: { tokens: 3000, threshold: 4000 },
                    observations: { tokens: 200, threshold: 2000 },
                  },
                  buffered: {
                    observations: {
                      chunks: 1,
                      messageTokens: 1000,
                      projectedMessageRemoval: 800,
                      observationTokens: 120,
                      status: "running",
                    },
                    reflection: {
                      inputObservationTokens: 0,
                      observationTokens: 0,
                      status: "idle",
                    },
                  },
                },
              },
            },
            {
              type: "data-om-thread-update",
              data: {
                cycleId: "cycle-obs-1",
                threadId: "thread-1",
                newTitle: "Solana research",
                timestamp: "2026-06-30T00:00:02.500Z",
              },
            },
            { type: "text-delta", payload: { text: "ok" } },
            FINISH,
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
        expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(
          true,
        );
      });
    });
  }
});
