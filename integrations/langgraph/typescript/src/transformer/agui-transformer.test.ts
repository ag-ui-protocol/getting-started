import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import { aguiTransformer } from "./agui-transformer";
import { CustomEventNames, LangGraphEventTypes } from "../types";

type AnyEvent = { type: string; [k: string]: any };

/**
 * Drive the transformer and capture everything it pushes onto the `agui`
 * channel. `init()` returns the very channel the closure pushes through, so
 * we shadow its `push` with a capturing function.
 */
function harness() {
  const t = aguiTransformer();
  const { agui } = t.init() as any;
  const events: AnyEvent[] = [];
  Object.defineProperty(agui, "push", {
    value: (ev: AnyEvent) => {
      events.push(ev);
    },
    configurable: true,
    writable: true,
  });
  const process = (method: string, params: any) =>
    t.process({ method, params } as any);
  const msg = (data: any) => process("messages", { data });
  return { t, events, process, msg };
}

const only = (events: AnyEvent[], type: string) =>
  events.filter((e) => e.type === type);

describe("aguiTransformer", () => {
  it("harness captures pushed events", () => {
    const { events, msg } = harness();
    msg({ event: "message-start", id: "m1" });
    msg({ event: "content-block-start", index: 0, content: { type: "text" } });
    msg({
      event: "content-block-delta",
      index: 0,
      delta: { type: "text-delta", text: "hi" },
    });
    expect(only(events, EventType.TEXT_MESSAGE_START).length).toBe(1);
    expect(only(events, EventType.TEXT_MESSAGE_CONTENT).length).toBe(1);
  });

  // Finding 1: message-error must close open text/tool/reasoning blocks.
  describe("message-error closes open blocks", () => {
    it("emits TEXT_MESSAGE_END for an open text block", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m1" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "hi" },
      });
      msg({ event: "message-error" });
      const starts = only(events, EventType.TEXT_MESSAGE_START);
      const ends = only(events, EventType.TEXT_MESSAGE_END);
      expect(starts.length).toBe(1);
      expect(ends.length).toBe(1);
      expect(ends[0].messageId).toBe(starts[0].messageId);
    });

    it("emits TOOL_CALL_END and REASONING_END for open tool/reasoning blocks", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m1" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", reasoning: "think" },
      });
      msg({
        event: "content-block-start",
        index: 1,
        content: { type: "tool_call", id: "tc1", name: "search", args: "" },
      });
      msg({ event: "message-error" });
      expect(only(events, EventType.TOOL_CALL_END).length).toBe(1);
      expect(only(events, EventType.REASONING_END).length).toBe(1);
    });
  });

  // Finding 2: multiple text blocks in one message need distinct ids.
  describe("multiple text content-blocks get distinct ids", () => {
    it("does not emit two TEXT_MESSAGE_START with the same messageId", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m2" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      });
      msg({
        event: "content-block-start",
        index: 1,
        content: { type: "text" },
      });
      const starts = only(events, EventType.TEXT_MESSAGE_START);
      expect(starts.length).toBe(2);
      const ids = starts.map((e) => e.messageId);
      expect(new Set(ids).size).toBe(2);
    });

    it("END ids match their START ids per block", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m2" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      });
      msg({
        event: "content-block-start",
        index: 1,
        content: { type: "text" },
      });
      msg({
        event: "content-block-finish",
        index: 0,
        content: { type: "text" },
      });
      msg({
        event: "content-block-finish",
        index: 1,
        content: { type: "text" },
      });
      const starts = only(events, EventType.TEXT_MESSAGE_START).map(
        (e) => e.messageId,
      );
      const ends = only(events, EventType.TEXT_MESSAGE_END).map(
        (e) => e.messageId,
      );
      expect(new Set(ends)).toEqual(new Set(starts));
      expect(ends.length).toBe(2);
    });

    it("preserves the bare message id for a single text block", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "sole" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      });
      const starts = only(events, EventType.TEXT_MESSAGE_START);
      expect(starts[0].messageId).toBe("sole");
    });
  });

  // Finding 3: message-finish must close still-open tool/reasoning blocks.
  describe("message-finish closes non-text blocks", () => {
    it("emits TOOL_CALL_END for a tool block with no content-block-finish", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m3" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc1", name: "foo", args: "" },
      });
      msg({ event: "message-finish" });
      expect(only(events, EventType.TOOL_CALL_END).length).toBe(1);
    });

    it("emits REASONING_END for a reasoning block with no content-block-finish", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m3" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", reasoning: "x" },
      });
      msg({ event: "message-finish" });
      expect(only(events, EventType.REASONING_END).length).toBe(1);
    });

    it("does not leak a tool block into the next message at the same index", () => {
      const { events, msg } = harness();
      // First message opens a tool at index 0 but never gets a block-finish.
      msg({ event: "message-start", id: "m3a" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tcA", name: "foo", args: "" },
      });
      msg({ event: "message-finish" });
      // Second message opens a different tool at the same index.
      msg({ event: "message-start", id: "m3b" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tcB", name: "bar", args: "" },
      });
      msg({
        event: "content-block-finish",
        index: 0,
        content: { type: "tool_call" },
      });
      const ends = only(events, EventType.TOOL_CALL_END).map(
        (e) => e.toolCallId,
      );
      expect(ends).toContain("tcA");
      expect(ends).toContain("tcB");
    });
  });

  // Finding 4: tool name known only on a later frame must reach TOOL_CALL_START.
  describe("tool name arriving after start", () => {
    it("defers TOOL_CALL_START until the name is available", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m4" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call_chunk", id: "tc1", name: "", args: "" },
      });
      // No start yet: name unknown.
      expect(only(events, EventType.TOOL_CALL_START).length).toBe(0);
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { name: "search" } },
      });
      const starts = only(events, EventType.TOOL_CALL_START);
      expect(starts.length).toBe(1);
      expect(starts[0].toolCallName).toBe("search");
    });

    it("still emits START with the name when it is present up front", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m4" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc1", name: "known", args: "" },
      });
      const starts = only(events, EventType.TOOL_CALL_START);
      expect(starts.length).toBe(1);
      expect(starts[0].toolCallName).toBe("known");
    });

    it("flushes buffered args once the name arrives, in order", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m4" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call_chunk", id: "tc1", name: "", args: '{"q"' },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: {
          type: "block-delta",
          fields: { name: "search", args: '{"q":"x"}' },
        },
      });
      const start = only(events, EventType.TOOL_CALL_START);
      expect(start.length).toBe(1);
      const args = only(events, EventType.TOOL_CALL_ARGS).map((e) => e.delta);
      // Concatenation must reconstruct the full args exactly once.
      expect(args.join("")).toBe('{"q":"x"}');
    });
  });

  // Finding 5: replace branch must not resend the already-streamed prefix.
  describe("block-delta args buffer replace", () => {
    it("normal append emits only the appended tail", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m5" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc1", name: "t", args: "" },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"a"' } },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"a":1}' } },
      });
      const args = only(events, EventType.TOOL_CALL_ARGS).map((e) => e.delta);
      expect(args.join("")).toBe('{"a":1}');
    });

    it("replace does not double the common prefix", () => {
      const { events, msg } = harness();
      msg({ event: "message-start", id: "m5" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc1", name: "t", args: "" },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"a":1}' } },
      });
      // Buffer replaced: last char corrected 1}->12}. Common prefix is {"a":1.
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { args: '{"a":12}' } },
      });
      const argsDeltas = only(events, EventType.TOOL_CALL_ARGS).map(
        (e) => e.delta,
      );
      // The replace frame must NOT re-send the full new buffer.
      expect(argsDeltas).not.toContain('{"a":12}');
      expect(argsDeltas[argsDeltas.length - 1]).toBe("2}");
    });
  });

  // Finding 6: bare interrupt value must be a string, not the undefined value.
  describe("interrupt value coercion", () => {
    it("tasks interrupt with no value emits a string value", () => {
      const { events, process } = harness();
      process("tasks", { data: { id: "task1", interrupts: [{ id: "i1" }] } });
      const custom = events.filter(
        (e) =>
          e.type === EventType.CUSTOM &&
          e.name === LangGraphEventTypes.OnInterrupt,
      );
      expect(custom.length).toBe(1);
      expect(typeof custom[0].value).toBe("string");
      expect(custom[0].value).toBe("null");
    });

    it("input.requested with no payload emits a string value", () => {
      const { events, process } = harness();
      process("input.requested", { data: { interrupt_id: "i2" } });
      const custom = events.filter(
        (e) =>
          e.type === EventType.CUSTOM &&
          e.name === LangGraphEventTypes.OnInterrupt,
      );
      expect(custom.length).toBe(1);
      expect(typeof custom[0].value).toBe("string");
      expect(custom[0].value).toBe("null");
    });
  });

  // Finding (a): root `failed` must close open blocks/steps BEFORE the
  // terminal RUN_ERROR — no block-END or STEP_FINISHED may trail it.
  describe("root failed closes blocks before RUN_ERROR", () => {
    it("emits no block-END or STEP_FINISHED after RUN_ERROR on an open stream", () => {
      const { t, events, msg, process } = harness();
      // Open a step, then a message with an open text block.
      process("lifecycle", {
        data: { event: "started" },
        namespace: ["node:uuid"],
      });
      msg({ event: "message-start", id: "m1" });
      msg({
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      });
      msg({
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "hi" },
      });
      // Root failure.
      process("lifecycle", {
        data: { event: "failed", error: "boom" },
        namespace: [],
      });
      // finalize() runs at run end; it must not append anything.
      t.finalize?.();

      const errIdx = events.findIndex((e) => e.type === EventType.RUN_ERROR);
      expect(errIdx).toBeGreaterThanOrEqual(0);
      expect(events[errIdx].message).toBe("boom");
      // RUN_ERROR is the terminal event: nothing may follow it.
      expect(errIdx).toBe(events.length - 1);
      // The open text block and step were closed BEFORE the error.
      const endIdx = events.findIndex(
        (e) => e.type === EventType.TEXT_MESSAGE_END,
      );
      const stepIdx = events.findIndex(
        (e) => e.type === EventType.STEP_FINISHED,
      );
      expect(endIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeLessThan(errIdx);
      expect(stepIdx).toBeGreaterThanOrEqual(0);
      expect(stepIdx).toBeLessThan(errIdx);
      // Exactly one RUN_ERROR.
      expect(only(events, EventType.RUN_ERROR).length).toBe(1);
    });
  });

  // Finding (b): ManuallyEmitState must record the snapshot hash so the
  // root-completed flush dedups an identical auto-snapshot.
  describe("ManuallyEmitState snapshot dedup", () => {
    it("emits a single STATE_SNAPSHOT when the manual value equals the auto-snapshot", () => {
      const { events, process } = harness();
      process("custom", {
        data: {
          name: CustomEventNames.ManuallyEmitState,
          payload: { foo: "bar" },
        },
      });
      // Root completion flushes snapshots from cached state. The cached
      // state equals the manually emitted value, so no new snapshot.
      process("lifecycle", { data: { event: "completed" }, namespace: [] });
      expect(only(events, EventType.STATE_SNAPSHOT).length).toBe(1);
    });

    it("still emits a second STATE_SNAPSHOT when state changes after the manual emit", () => {
      const { events, process } = harness();
      process("custom", {
        data: {
          name: CustomEventNames.ManuallyEmitState,
          payload: { foo: "bar" },
        },
      });
      // A subsequent root values event changes state, so the flush must
      // emit a fresh snapshot (dedup is by value, not blanket suppression).
      process("values", { data: { foo: "baz" }, namespace: [] });
      process("lifecycle", { data: { event: "completed" }, namespace: [] });
      expect(only(events, EventType.STATE_SNAPSHOT).length).toBe(2);
    });
  });

  // OpenAI Responses reasoning rides on the assistant message's
  // additional_kwargs.reasoning (not a messages-channel content block), so the
  // transformer surfaces it from the flushed state as a REASONING entity.
  describe("reasoning from message additional_kwargs", () => {
    const aiMessage = (reasoning: unknown) => ({
      id: "ai-1",
      type: "ai",
      content: "Here are my recommendations.",
      additional_kwargs: { reasoning },
      response_metadata: {},
    });

    it("emits a REASONING sequence from additional_kwargs.reasoning.summary", () => {
      const { events, process } = harness();
      process("values", {
        namespace: [],
        data: {
          messages: [
            aiMessage({
              id: "rs_1",
              type: "reasoning",
              summary: [{ type: "summary_text", text: "I weighed reliability and value." }],
            }),
          ],
        },
      });
      process("lifecycle", { data: { event: "completed" }, namespace: [] });

      expect(only(events, EventType.REASONING_START).length).toBe(1);
      expect(only(events, EventType.REASONING_END).length).toBe(1);
      const content = events.find(
        (e) => e.type === EventType.REASONING_MESSAGE_CONTENT,
      ) as any;
      expect(content?.delta).toBe("I weighed reliability and value.");
    });

    it("does not emit reasoning when the summary is empty", () => {
      const { events, process } = harness();
      process("values", {
        namespace: [],
        data: { messages: [aiMessage({ id: "rs_2", type: "reasoning", summary: [] })] },
      });
      process("lifecycle", { data: { event: "completed" }, namespace: [] });
      expect(only(events, EventType.REASONING_START).length).toBe(0);
    });

    it("does not re-emit the same reasoning id across repeated flushes", () => {
      const { events, process } = harness();
      const msg = aiMessage({
        id: "rs_3",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
      });
      process("values", { namespace: [], data: { messages: [msg] } });
      process("lifecycle", { data: { event: "completed" }, namespace: [] });
      // A second flush of the same state must not duplicate the reasoning.
      process("values", { namespace: [], data: { messages: [msg], tick: 1 } });
      process("lifecycle", { data: { event: "completed" }, namespace: [] });
      expect(only(events, EventType.REASONING_START).length).toBe(1);
    });
  });

  // input.requested dedup, consistent with the tasks path.
  describe("input.requested dedup by id", () => {
    it("does not double-emit for a duplicated interrupt frame", () => {
      const { events, process } = harness();
      process("input.requested", {
        data: { interrupt_id: "dup1", payload: "hi" },
      });
      process("input.requested", {
        data: { interrupt_id: "dup1", payload: "hi" },
      });
      const custom = events.filter(
        (e) =>
          e.type === EventType.CUSTOM &&
          e.name === LangGraphEventTypes.OnInterrupt,
      );
      expect(custom.length).toBe(1);
    });
  });
});
