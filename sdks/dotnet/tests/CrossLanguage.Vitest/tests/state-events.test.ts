import { describe, it, expect } from "vitest";
import {
  EventType,
  type BaseEvent,
  type StateSnapshotEvent,
  type StateDeltaEvent,
} from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";
import {
  TRANSPORTS,
  TRANSPORT_MEDIA_TYPE,
  createTransportAgent,
} from "../helpers/transport";

// STATE_SNAPSHOT / STATE_DELTA (and the Run*/TextMessage* envelope) are all in the
// protobuf-supported event set, so the state suite is parameterized over both
// transports — the same scenarios decode identically over SSE and protobuf.
describe.each(TRANSPORTS)(
  "TS HttpAgent → C# AG-UI server (state) [%s]",
  (transport) => {
    async function runRoute(
      route: string,
      message: string,
      threadId: string,
    ): Promise<BaseEvent[]> {
      const { agent, lastResponseContentType } = createTransportAgent(
        { url: `${baseUrl()}${route}`, threadId, agentId: "cross-language-test" },
        transport,
      );
      agent.messages = [{ id: `u-${threadId}`, role: "user", content: message }];
      const events: BaseEvent[] = [];
      await agent.runAgent(
        {},
        {
          onEvent: ({ event }) => {
            events.push(event);
          },
        },
      );
      expect(lastResponseContentType()).toBe(TRANSPORT_MEDIA_TYPE[transport]);
      return events;
    }

    it("shared_state: receives a complete STATE_SNAPSHOT and follow-up text", async () => {
      // The dojo shared-state agent (sharedStatePage.spec.ts) drives a recipe
      // editor: the LLM emits a tool call whose args define the new recipe,
      // and the server folds it into the run's state. Our C# server short-
      // circuits the LLM and emits the canned recipe directly — the wire
      // contract is what matters for cross-language testing.
      const events = await runRoute(
        "/shared_state",
        "Give me a pasta recipe",
        `t-shared-state-${transport}`,
      );

      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.RUN_STARTED);
      expect(types).toContain(EventType.STATE_SNAPSHOT);
      expect(types).toContain(EventType.RUN_FINISHED);

      const snapshot = events.find(
        (e) => e.type === EventType.STATE_SNAPSHOT,
      ) as StateSnapshotEvent;
      expect(snapshot).toBeDefined();
      const state = snapshot.snapshot as {
        recipe?: { title?: string; ingredients?: unknown[] };
      };
      expect(state.recipe?.title).toBe("Pasta al Limone");
      expect(state.recipe?.ingredients).toHaveLength(3);

      // The follow-up assistant text still flows through alongside the
      // STATE_SNAPSHOT — neither blocks the other.
      const text = events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e: any) => e.delta as string)
        .join("");
      expect(text).toContain("Recipe ready");
    });

    it("predictive_state_updates: streams successive STATE_DELTA patches that build a document", async () => {
      // The dojo predictiveStateUpdate spec exercises a tool whose args are
      // partial-streamed: the document text grows one fragment at a time
      // and is reflected as incremental state updates. The TS client
      // applies JSON Patch operations from each STATE_DELTA in order.
      const events = await runRoute(
        "/predictive_state_updates",
        "Write a story about a dragon called Atlantis",
        `t-predictive-${transport}`,
      );

      const deltas = events.filter(
        (e): e is StateDeltaEvent => e.type === EventType.STATE_DELTA,
      );
      expect(deltas.length).toBeGreaterThan(1);

      // Each delta is a JSON Patch operations array. The final patch should
      // mention "Atlantis" — proving the deltas built up coherent content
      // rather than each replacing each other into nonsense.
      const finalDelta = deltas[deltas.length - 1]!;
      const ops = finalDelta.delta as Array<{
        op: string;
        path: string;
        value: unknown;
      }>;
      expect(ops).toBeInstanceOf(Array);
      expect(ops[0]?.path).toBe("/document");
      expect(String(ops[0]?.value)).toMatch(/Atlantis/);
    });
  },
);
