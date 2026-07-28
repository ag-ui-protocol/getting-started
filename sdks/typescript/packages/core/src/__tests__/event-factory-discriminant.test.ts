/**
 * Regression guard for Markus's review item 3: factories must not let a caller
 * override the `type` discriminant.
 *
 * `BaseEvent` carries `[k: string]: unknown` to mirror wire-level passthrough, so
 * `Omit<Event, "type">` does NOT on its own stop a caller from supplying `type` —
 * the index signature admits it. Two things close the hole:
 *
 *   1. `EventProps<E>` (events.ts) intersects in `type?: never`, so a `type` key
 *      is a compile error. Asserted below with @ts-expect-error.
 *   2. `buildEvent` assigns `type` AFTER spreading props, so even an untyped JS
 *      caller cannot win. Asserted below at runtime.
 */
import { describe, expect, it } from "vitest";
import { EventType } from "../events";
import {
  createTextMessageContentEvent,
  createRunErrorEvent,
  createToolCallStartEvent,
} from "../event-factories";

describe("factories cannot have their discriminant overridden", () => {
  it("ignores a caller-supplied type at runtime", () => {
    const event = createTextMessageContentEvent({
      // @ts-expect-error - `type` is rejected by EventProps<E>'s `type?: never`
      type: EventType.RUN_ERROR,
      messageId: "m1",
      delta: "hello",
    });
    expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  it("holds for every factory shape", () => {
    // @ts-expect-error - see above
    expect(createRunErrorEvent({ type: EventType.CUSTOM, message: "boom" }).type).toBe(
      EventType.RUN_ERROR,
    );
    expect(
      createToolCallStartEvent({
        // @ts-expect-error - see above
        type: EventType.STEP_STARTED,
        toolCallId: "tc1",
        toolCallName: "search",
      }).type,
    ).toBe(EventType.TOOL_CALL_START);
  });
});

describe("factories validate their input", () => {
  // main's factories called schema.parse(...); this keeps that contract so bad
  // payloads fail in the producer instead of erroring the consumer's stream.
  it("throws on a wrong-typed field", () => {
    expect(() =>
      // @ts-expect-error - delta must be a string
      createTextMessageContentEvent({ messageId: "m1", delta: 123 }),
    ).toThrow();
  });

  it("throws on a missing required field", () => {
    // @ts-expect-error - delta is required
    expect(() => createTextMessageContentEvent({ messageId: "m1" })).toThrow();
  });

  it("applies schema defaults and transforms", () => {
    const started = createToolCallStartEvent({
      toolCallId: "tc1",
      toolCallName: "search",
      parentMessageId: null,
    });
    expect(started.parentMessageId).toBeUndefined();
  });
});
