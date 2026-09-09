import { describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { decode, encode } from "../proto";
import * as protoEvents from "../generated/events";

/**
 * What encode says when it encodes something anyway.
 *
 * encode is deliberately TOLERANT: an event the schema rejects is still
 * encoded, best effort, so a producer that has drifted keeps working. That
 * decision is settled and these tests do not reopen it — they are about the
 * warning, which is the only thing an operator has to go on when the tolerance
 * kicks in. A warning that names nothing useful is the tolerance without the
 * loudness.
 */
const captureWarnings = (run: () => void): string[] =>
  captureWarningCalls(run).map((args) => args.map((arg) => String(arg)).join(" "));

/** The raw argument lists, for asserting what a warning does NOT carry. */
const captureWarningCalls = (run: () => void): unknown[][] => {
  const calls: unknown[][] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return calls;
};

describe("encode's validation-failure warning", () => {
  it("names where the schema rejected the event", () => {
    const warnings = captureWarnings(() => {
      encode({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "not-a-valid-role",
      } as never);
    });

    const text = warnings.join("\n");
    expect(text).toContain("[ag-ui][proto.encode]");
    // The path the schema complained about, not just "something was wrong".
    expect(text).toMatch(/\/role\b/);
  });

  it("names every rejected path when there is more than one", () => {
    const warnings = captureWarnings(() => {
      encode({ type: EventType.TEXT_MESSAGE_CONTENT } as never);
    });

    const text = warnings.join("\n");
    expect(text).toMatch(/\/messageId\b/);
    expect(text).toMatch(/\/delta\b/);
  });

  /**
   * The event itself used to ride along in the warning. On a stream that is a
   * wall of text around the one line that matters, and it prints whatever the
   * event was carrying — message content included — into logs that may have no
   * business holding it.
   */
  it("does not dump the whole event into the log line", () => {
    const calls = captureWarningCalls(() => {
      encode({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "not-a-valid-role",
        rawEvent: { secret: "do-not-log-me" },
      } as never);
    });

    // One string, and nothing else. Passing the event and the error as extra
    // console arguments is what printed it: String() on an object hides the
    // payload from a joined assertion, a real console expands it in full.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(typeof calls[0][0]).toBe("string");
    expect(JSON.stringify(calls[0])).not.toContain("do-not-log-me");
  });
});

describe("encode's dropped-content-part warning", () => {
  /**
   * With validation bypassed, a content part with no wire form is filtered out
   * of the message on the way to the wire. It has to be — there is no arm to
   * put it on — but the caller was never told which part went missing, so a
   * message arrived at the far end one part shorter with nothing said.
   */
  it("names the message and the part it could not put on the wire", () => {
    const warnings = captureWarnings(() => {
      encode({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m0", role: "user", content: [{ type: "text", text: "kept" }] },
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "kept" },
              { type: "no-such-part" },
            ],
          },
        ],
      } as never);
    });

    expect(warnings.join("\n")).toContain("messages[1].content[1]");
  });

  it("still encodes the parts it could map", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = encode({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "kept" }, { type: "no-such-part" }],
        },
      ],
    } as never);
    warn.mockRestore();

    const decoded = decode(bytes) as unknown as {
      messages: Array<{ content: unknown[] }>;
    };
    expect(decoded.messages[0].content).toEqual([{ type: "text", text: "kept" }]);
  });
});

/**
 * The decode side of the same question: what the reader hands on, and what it
 * refuses to guess at.
 */
describe("decode of a role this build does not know", () => {
  it("hands the message on with its role intact, for enforcement to judge", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = encode({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "m1", role: "oracle", content: [{ type: "text", text: "hi" }] }],
    } as never);
    warn.mockRestore();

    // Not dropped here: dropped here is dropped silently, and enforcement then
    // sees a snapshot with nothing wrong in it. The unrecognised role rides on
    // so the one stage both transports share can strip it and name the path.
    expect(decode(bytes) as unknown as { messages: unknown[] }).toMatchObject({
      messages: [{ id: "m1", role: "oracle", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("refuses a message carrying two content forms at once, whatever the role", () => {
    // Competing spellings of one JSON field. No role, present or future, can
    // mean anything by both — and keeping one would discard the other in
    // silence, which is the failure this whole path exists to avoid.
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "m1",
            role: "oracle",
            content: "a string",
            activityContent: { progress: 1 },
            toolCalls: [],
            contentParts: [],
          },
        ],
      },
    } as never).finish();

    expect(() => decode(bytes)).toThrow(/more than one content form/);
  });
});
