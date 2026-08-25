import { EventType } from "@ag-ui/client";
import type { StateDeltaEvent, StateSnapshotEvent } from "@ag-ui/client";
import { applyPatch } from "fast-json-patch";
import {
  FakeMemory,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

// A Mastra `update-working-memory` tool call as it appears on fullStream: a
// buffered server-tool `tool-call` chunk whose single arg `memory` carries the
// (JSON-encoded) working-memory content the model wants to persist, followed by
// a `{ success: true }` tool-result.
function updateWorkingMemoryChunks(
  toolCallId: string,
  memory: Record<string, any> | string,
) {
  return [
    {
      type: "tool-call",
      payload: {
        toolCallId,
        toolName: "updateWorkingMemory",
        args: {
          memory: typeof memory === "string" ? memory : JSON.stringify(memory),
        },
      },
    },
    {
      type: "tool-result",
      payload: { toolCallId, result: { success: true } },
    },
  ];
}

// A working-memory update that STREAMS its args, mirroring real Mastra: a
// `tool-call-input-streaming-start`, N `tool-call-delta` chunks slicing the raw
// tool-input JSON (`{"memory":"<escaped json>"}`), a streaming-end, then the
// final `tool-call` whose `args.memory` is the assembled object. Consuming the
// deltas is what lets shared state render progressively (not one blob at end).
function streamingWorkingMemoryChunks(
  toolCallId: string,
  memory: Record<string, any>,
  numChunks = 8,
) {
  const argsText = JSON.stringify({ memory: JSON.stringify(memory) });
  const size = Math.max(1, Math.ceil(argsText.length / numChunks));
  const deltas: any[] = [];
  for (let i = 0; i < argsText.length; i += size) {
    deltas.push({
      type: "tool-call-delta",
      payload: { toolCallId, argsTextDelta: argsText.slice(i, i + size) },
    });
  }
  return [
    {
      type: "tool-call-input-streaming-start",
      payload: { toolCallId, toolName: "updateWorkingMemory" },
    },
    ...deltas,
    { type: "tool-call-input-streaming-end", payload: { toolCallId } },
    {
      type: "tool-call",
      // Real Mastra reports the assembled args.memory as an OBJECT on the final
      // chunk (not the escaped string) — the finalizer must handle that.
      payload: {
        toolCallId,
        toolName: "updateWorkingMemory",
        args: { memory },
      },
    },
  ];
}

// Reconstruct the client-side state after applying, in order, the seeded base
// (input.state) followed by every STATE_DELTA / STATE_SNAPSHOT the run emitted.
function reconstructState(
  events: any[],
  base: Record<string, any>,
): Record<string, any> {
  let doc = structuredClone(base);
  for (const e of events) {
    if (e.type === EventType.STATE_SNAPSHOT) {
      doc = structuredClone((e as StateSnapshotEvent).snapshot as any);
    } else if (e.type === EventType.STATE_DELTA) {
      doc = applyPatch(
        doc,
        (e as StateDeltaEvent).delta as any,
        false,
        false,
      ).newDocument;
    }
  }
  return doc;
}

const factories: Array<[string, typeof makeLocalMastraAgent]> = [
  ["local agent", makeLocalMastraAgent],
  ["remote agent", makeRemoteMastraAgent],
];

describe("Mastra working-memory updates -> AG-UI STATE_DELTA", () => {
  for (const [label, makeAgent] of factories) {
    describe(label, () => {
      it("maps an update-working-memory tool call to shared state (leading STATE_SNAPSHOT)", async () => {
        const agent = makeAgent({
          streamChunks: [
            ...updateWorkingMemoryChunks("wm-1", {
              recipe: { title: "Soup", ingredients: ["water"] },
            }),
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const events = await collectEvents(agent, makeInput());
        // The first working-memory change of a run establishes the base as a
        // STATE_SNAPSHOT (the runtime patches deltas from an empty document, so
        // a leading snapshot is required). A single update = one snapshot.
        const snapshots = events.filter(
          (e) => e.type === EventType.STATE_SNAPSHOT,
        ) as StateSnapshotEvent[];
        expect(snapshots).toHaveLength(1);
        expect(reconstructState(events.slice(0, -1), {})).toMatchObject({
          recipe: { title: "Soup", ingredients: ["water"] },
        });
      });

      it("streams MULTIPLE incremental STATE_DELTAs as the working-memory args arrive", async () => {
        const recipe = {
          recipe: {
            title: "Spaghetti Aglio e Olio",
            ingredients: [
              { icon: "🍝", name: "Spaghetti", amount: "400g" },
              { icon: "🧄", name: "Garlic", amount: "6 cloves" },
              { icon: "🌶️", name: "Chili flakes", amount: "1 tsp" },
              { icon: "🫒", name: "Olive oil", amount: "80ml" },
            ],
            instructions: [
              "Boil the pasta.",
              "Fry garlic in oil.",
              "Combine and toss.",
              "Serve hot.",
            ],
          },
        };
        const agent = makeAgent({
          streamChunks: [
            ...streamingWorkingMemoryChunks("wm-1", recipe, 10),
            { type: "text-delta", payload: { text: "Done." } },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const events = await collectEvents(agent, makeInput());
        const deltas = events.filter(
          (e) => e.type === EventType.STATE_DELTA,
        ) as StateDeltaEvent[];

        // Progressive: several deltas, not one blob at the end.
        expect(deltas.length).toBeGreaterThan(1);
        // The reconstructed state converges to the full recipe.
        expect(reconstructState(events.slice(0, -1), {})).toEqual(recipe);
        // Still no tool render for the working-memory plumbing.
        const types = events.map((e) => e.type);
        expect(types).not.toContain(EventType.TOOL_CALL_START);
        expect(types).not.toContain(EventType.TOOL_CALL_RESULT);
      });

      it("does NOT render the update-working-memory call as a tool (no TOOL_CALL_* / RESULT)", async () => {
        const agent = makeAgent({
          streamChunks: [
            ...updateWorkingMemoryChunks("wm-1", { recipe: { title: "Soup" } }),
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const types = (await collectEvents(agent, makeInput())).map(
          (e) => e.type,
        );
        expect(types).not.toContain(EventType.TOOL_CALL_START);
        expect(types).not.toContain(EventType.TOOL_CALL_ARGS);
        expect(types).not.toContain(EventType.TOOL_CALL_END);
        expect(types).not.toContain(EventType.TOOL_CALL_RESULT);
      });

      it("emits a leading snapshot then an incremental delta for a later update", async () => {
        const agent = makeAgent({
          streamChunks: [
            ...updateWorkingMemoryChunks("wm-1", {
              recipe: { title: "Soup", ingredients: ["water"] },
            }),
            { type: "text-delta", payload: { text: "Added water. " } },
            ...updateWorkingMemoryChunks("wm-2", {
              recipe: { ingredients: ["water", "salt"] },
            }),
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const events = await collectEvents(agent, makeInput());
        // First update -> establishing snapshot; second update -> delta.
        const snapshots = events.filter(
          (e) => e.type === EventType.STATE_SNAPSHOT,
        );
        const deltas = events.filter((e) => e.type === EventType.STATE_DELTA);
        expect(snapshots).toHaveLength(1);
        expect(deltas).toHaveLength(1);

        // Merge semantics: second (partial) update deep-merges onto the first;
        // arrays are replaced. Title survives, ingredients grow.
        expect(reconstructState(events.slice(0, -1), {})).toMatchObject({
          recipe: { title: "Soup", ingredients: ["water", "salt"] },
        });
      });

      it("establishes state by merging the update onto the seeded input.state base", async () => {
        const base = { recipe: { title: "Soup", ingredients: ["water"] } };
        const agent = makeAgent({
          streamChunks: [
            ...updateWorkingMemoryChunks("wm-1", {
              recipe: { ingredients: ["water", "salt"] },
            }),
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const events = await collectEvents(
          agent,
          makeInput({ state: structuredClone(base) }),
        );
        // The leading (mid-run) snapshot merges the update onto the seeded base:
        // the title the update didn't touch survives; the partial ingredients
        // array replaces. (Assert the establishing snapshot directly — a local
        // agent also emits a run-end snapshot from memory, which under the fake
        // reflects only the pre-run sync, not the streamed update.)
        const firstSnapshot = events.find(
          (e) => e.type === EventType.STATE_SNAPSHOT,
        ) as StateSnapshotEvent;
        expect(firstSnapshot).toBeDefined();
        expect(firstSnapshot.snapshot).toMatchObject({
          recipe: { title: "Soup", ingredients: ["water", "salt"] },
        });
      });

      it("skips STATE_DELTA when working-memory args are non-JSON (markdown template mode)", async () => {
        const agent = makeAgent({
          streamChunks: [
            ...updateWorkingMemoryChunks("wm-1", "# Recipe\n- water"),
            { type: "text-delta", payload: { text: "ok" } },
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const types = (await collectEvents(agent, makeInput())).map(
          (e) => e.type,
        );
        expect(types).not.toContain(EventType.STATE_DELTA);
        expect(types).toContain(EventType.RUN_FINISHED);
      });

      it("streams state (snapshot + deltas) BEFORE RUN_FINISHED, not only at run end", async () => {
        const agent = makeAgent({
          streamChunks: [
            ...streamingWorkingMemoryChunks(
              "wm-1",
              {
                recipe: {
                  title: "Minestrone",
                  ingredients: [
                    { icon: "🥕", name: "Carrot", amount: "2" },
                    { icon: "🧅", name: "Onion", amount: "1" },
                    { icon: "🍅", name: "Tomato", amount: "3" },
                  ],
                  instructions: ["Chop.", "Simmer.", "Serve."],
                },
              },
              10,
            ),
            { type: "finish", payload: { finishReason: "stop" } },
          ],
        });

        const types = (await collectEvents(agent, makeInput())).map(
          (e) => e.type,
        );
        const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
        const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);
        const deltaIdx = types.indexOf(EventType.STATE_DELTA);
        expect(finishedIdx).toBeGreaterThan(-1);
        // Both the establishing snapshot and at least one delta land before the
        // run finishes (progressive, not a single run-end emission).
        expect(snapshotIdx).toBeGreaterThan(-1);
        expect(snapshotIdx).toBeLessThan(finishedIdx);
        expect(deltaIdx).toBeGreaterThan(-1);
        expect(deltaIdx).toBeLessThan(finishedIdx);
      });
    });
  }
});
