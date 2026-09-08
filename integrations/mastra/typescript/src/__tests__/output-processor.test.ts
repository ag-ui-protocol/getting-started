import type { CustomEvent, TextMessageChunkEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  FakeLocalAgent,
  FakeMemory,
  FakeRemoteAgent,
  collectEvents,
  makeInput,
} from "./helpers";

// Helper: text-delta chunk shape
const textDelta = (text: string) => ({
  type: "text-delta",
  payload: { text },
});

// Helper: finish / step-finish chunk shapes with optional response.uiMessages.
const finish = (uiMessages?: any[]) => ({
  type: "finish",
  payload: uiMessages !== undefined ? { response: { uiMessages } } : {},
});
const stepFinish = (uiMessages?: any[]) => ({
  type: "step-finish",
  payload: uiMessages !== undefined ? { response: { uiMessages } } : {},
});

// Helper: a tool-call-suspended chunk (interrupt), used to exercise the
// mid-turn buffer flush.
const suspend = (toolCallId = "tc-1", toolName = "approve") => ({
  type: "tool-call-suspended",
  payload: {
    toolCallId,
    toolName,
    suspendPayload: { reason: "needs approval" },
    args: { amount: 250 },
    resumeSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
  },
});

// Helper: build an agent with a specific stream and processor flag.
// `memory: new FakeMemory()` keeps the working-memory snapshot path off — the
// fake returns `undefined` for getWorkingMemory so no STATE_SNAPSHOT events
// pollute the assertion target.
const buildAgent = (
  streamChunks: any[],
  useProcessedFinalText: boolean,
  isRemote = false,
) => {
  const agent = isRemote
    ? new FakeRemoteAgent({ streamChunks })
    : new FakeLocalAgent({ memory: new FakeMemory(), streamChunks });
  return new MastraAgent({
    agentId: "test-agent",
    agent: agent as any,
    resourceId: "resource-1",
    useProcessedFinalText,
  });
};

const textEventDeltas = (events: any[]): string[] =>
  events
    .filter(
      (e): e is TextMessageChunkEvent =>
        e.type === EventType.TEXT_MESSAGE_CHUNK,
    )
    .map((e) => e.delta ?? "");

describe("useProcessedFinalText", () => {
  describe("disabled (default — no regression)", () => {
    it("streams text-delta chunks individually when flag is false", async () => {
      const agent = buildAgent(
        [textDelta("Hello "), textDelta("world"), finish()],
        false,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["Hello ", "world"]);
    });

    it("ignores finish.payload.response.uiMessages when flag is false", async () => {
      // Even with processor-rewritten uiMessages present, the default
      // behavior must keep streaming raw deltas — flipping behavior on
      // upstream-only changes would be a breaking surprise.
      const agent = buildAgent(
        [
          textDelta("raw text"),
          finish([{ role: "assistant", content: "REWRITTEN" }]),
        ],
        false,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["raw text"]);
    });

    it("still streams deltas across step-finish + finish when flag is false", async () => {
      // Guards the flag-off path against the buffering/split logic: the real
      // Mastra terminal shape (step-finish followed by finish) must not alter
      // delta streaming or duplicate anything.
      const agent = buildAgent(
        [
          textDelta("a"),
          textDelta("b"),
          stepFinish([{ role: "assistant", content: "IGNORED" }]),
          finish([{ role: "assistant", content: "IGNORED" }]),
        ],
        false,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["a", "b"]);
    });
  });

  describe("enabled — local agent", () => {
    it("suppresses text-delta and emits processor-rewritten text from uiMessages", async () => {
      const agent = buildAgent(
        [
          textDelta("raw "),
          textDelta("output"),
          finish([
            { role: "user", content: "Hi" },
            { role: "assistant", content: "rewritten output" },
          ]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["rewritten output"]);
    });

    it("uses the LAST assistant message when uiMessages contains multiple", async () => {
      // Defensive: a supervisor flow may include earlier assistant turns in
      // uiMessages. We only care about the final one (which the processor
      // rewrote).
      const agent = buildAgent(
        [
          textDelta("raw"),
          finish([
            { role: "assistant", content: "stale earlier turn" },
            { role: "user", content: "follow up" },
            { role: "assistant", content: "final rewritten" },
          ]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["final rewritten"]);
    });

    it("falls back to buffered raw text when uiMessages is absent", async () => {
      // Mastra versions before #11549 (or non-processor agents) won't emit
      // response.uiMessages. We must not drop the LLM's text in that case.
      const agent = buildAgent(
        [textDelta("buffered "), textDelta("text"), finish()],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["buffered text"]);
    });

    it("falls back to buffered raw text when uiMessages has no assistant message", async () => {
      const agent = buildAgent(
        [textDelta("buffered"), finish([{ role: "user", content: "Hi" }])],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["buffered"]);
    });

    it("extracts text from array-of-parts content shape", async () => {
      // Mastra UIMessage.content can be an array of parts (text/tool/etc.)
      // — we should concatenate text parts and ignore non-text parts.
      const agent = buildAgent(
        [
          textDelta("raw"),
          finish([
            {
              role: "assistant",
              content: [
                { type: "text", text: "part one " },
                { type: "tool-call", toolCallId: "x", toolName: "y" },
                { type: "text", text: "part two" },
              ],
            },
          ]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["part one part two"]);
    });

    it("falls back to buffered text when assistant message has empty content", async () => {
      // A tool-only final assistant message (no text parts) should not
      // suppress the buffered text — otherwise the user sees nothing.
      const agent = buildAgent(
        [
          textDelta("buffered fallback"),
          finish([
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "x", toolName: "y" }],
            },
          ]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["buffered fallback"]);
    });

    it("emits nothing for text when neither buffered text nor uiMessages text exists", async () => {
      // Tool-only response with no LLM text at all — must not emit empty
      // TEXT_MESSAGE_CHUNK (would render an empty assistant bubble).
      const agent = buildAgent([finish([])], true);
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual([]);
    });

    it("handles step-finish boundaries by releasing per-step text", async () => {
      // Multi-step flow: each step-finish releases its buffered text using
      // its own uiMessages snapshot. Earlier step's buffer must not leak
      // into a later step.
      const agent = buildAgent(
        [
          textDelta("step1 "),
          textDelta("raw"),
          stepFinish([{ role: "assistant", content: "step1 rewritten" }]),
          textDelta("step2 raw"),
          finish([{ role: "assistant", content: "step2 final" }]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual([
        "step1 rewritten",
        "step2 final",
      ]);
    });

    // --- Regression guards for the finish-boundary release logic -----------

    it("emits the final text ONCE when step-finish and finish carry the same uiMessages", async () => {
      // Real Mastra ends a single-step response with a `step-finish`
      // immediately followed by a terminal `finish`, and BOTH carry the same
      // processor-rewritten uiMessages. The release must not emit it twice
      // (the second would land under the already-rotated messageId as a
      // duplicate assistant bubble).
      const agent = buildAgent(
        [
          textDelta("raw"),
          stepFinish([{ role: "assistant", content: "final rewritten" }]),
          finish([{ role: "assistant", content: "final rewritten" }]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["final rewritten"]);
    });

    it("does not emit raw then processed when only the terminal finish carries uiMessages", async () => {
      // If a non-terminal step-finish lacks uiMessages, we must keep buffering
      // rather than emit the raw text — otherwise a later finish that DOES
      // carry processor text would double-render (raw + processed).
      const agent = buildAgent(
        [
          textDelta("raw "),
          textDelta("text"),
          stepFinish(),
          finish([{ role: "assistant", content: "rewritten" }]),
        ],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["rewritten"]);
    });

    it("flushes buffered text as raw when the turn suspends before any finish", async () => {
      // A tool suspend interrupts the turn — no finish will release the buffer.
      // Text streamed before the suspend must still reach the client.
      const agent = buildAgent(
        [textDelta("thinking "), textDelta("out loud"), suspend()],
        true,
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["thinking out loud"]);
      // The interrupt itself must still be emitted (legacy on_interrupt path).
      const custom = events.find(
        (e): e is CustomEvent => e.type === EventType.CUSTOM,
      );
      expect(custom?.name).toBe("on_interrupt");
    });
  });

  describe("enabled — remote agent", () => {
    it("buffers and surfaces uiMessages for remote agents too", async () => {
      // Remote agent path uses processDataStream but shares
      // createChunkProcessor — verify the buffering applies symmetrically.
      const agent = buildAgent(
        [
          textDelta("raw"),
          finish([{ role: "assistant", content: "rewritten" }]),
        ],
        true,
        true, // isRemote
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["rewritten"]);
    });

    it("emits final text once for remote step-finish + finish duplication", async () => {
      const agent = buildAgent(
        [
          textDelta("raw"),
          stepFinish([{ role: "assistant", content: "rewritten" }]),
          finish([{ role: "assistant", content: "rewritten" }]),
        ],
        true,
        true, // isRemote
      );
      const events = await collectEvents(agent, makeInput());
      expect(textEventDeltas(events)).toEqual(["rewritten"]);
    });
  });
});
