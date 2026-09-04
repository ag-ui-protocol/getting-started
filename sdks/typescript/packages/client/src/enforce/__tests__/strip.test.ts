/**
 * The stripper on its own, at the shapes the enforcement tests cannot reach
 * through a whole event: what it must NOT touch, what it must report, and the
 * schema constructs the generated schemas do not use yet.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { EventType } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { stripUnknown } from "../strip";

function eventSchema(type: EventType): z.ZodType {
  const option = (EventSchema.options as unknown as Array<{
    shape: { type: { value: string } };
  }>).find((candidate) => candidate.shape.type.value === type);
  if (option === undefined) throw new Error(`no schema for ${type}`);
  return option as unknown as z.ZodType;
}

const RUN_FINISHED = eventSchema(EventType.RUN_FINISHED);
const MESSAGES_SNAPSHOT = eventSchema(EventType.MESSAGES_SNAPSHOT);

describe("a wrong-typed value in a discriminated-union slot", () => {
  // A union slot holding something that is not an object at all is a malformed
  // VALUE on a field the protocol describes, and the rule for those is that
  // they stay fatal. An ARRAY is one of those — `typeof [] === "object"` is the
  // only reason it ever looked like a union member — and stripping it would
  // silently turn a rejected stream into a successful run whose pending
  // interrupts have gone missing.
  // Third column: the offence the validator must name. A bare `toThrow()` is
  // satisfied by any failure at all — including one about a different field,
  // or a stripper that mangled the event so badly that some unrelated required
  // key went missing — which is exactly the outcome these cases exist to rule
  // out.
  const cases: Array<[string, unknown, string]> = [
    ["a string", "success", "received string"],
    ["a number", 7, "received number"],
    [
      "an array",
      [{ type: "interrupt", interrupts: [{ id: "i1", reason: "why" }] }],
      "received array",
    ],
  ];

  for (const [label, outcome, received] of cases) {
    it(`${label} is left for the validator, not stripped`, () => {
      const event = {
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
        outcome,
      };
      const { value, stripped } = stripUnknown(event, RUN_FINISHED);
      expect(stripped).toEqual([]);
      expect((value as { outcome?: unknown }).outcome).toEqual(outcome);
      // The rejection is about `outcome`, and about the shape it actually had.
      expect(() => RUN_FINISHED.parse(value)).toThrow('"outcome"');
      expect(() => RUN_FINISHED.parse(value)).toThrow(received);
    });
  }
});

describe("the reported paths", () => {
  it("names nothing inside a subtree it then removed whole", () => {
    // The media part is removed entire, because its source kind is one this
    // build does not know and `source` is required. A path naming a property
    // INSIDE that part describes a removal that never happened on its own, and
    // the enforcement stage warns once per path — so the operator is told to
    // look for a `junk` key that was never the reason for anything.
    const event = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "m1",
          role: "user",
          junkTop: 1,
          content: [{ type: "image", junk: 2, source: { type: "future-kind" } }],
        },
      ],
    };
    const { value, stripped } = stripUnknown(event, MESSAGES_SNAPSHOT);
    expect(stripped).toEqual(["/messages/0/junkTop", "/messages/0/content/0"]);
    expect(value).toEqual({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "m1", role: "user", content: [] }],
    });
  });
});

describe("a top-level value the stripper cannot recognise at all", () => {
  it("is a loud internal error, never a silent unstripped passthrough", () => {
    // Unreachable through the generated schemas — every required union sits
    // inside an array, which absorbs the drop. If it ever becomes reachable,
    // returning the original value while reporting removals would make the
    // warnings lie about what the caller is holding, so it must be impossible
    // to reach quietly.
    const schema = z.looseObject({
      outcome: z.discriminatedUnion("type", [z.looseObject({ type: z.literal("success") })]),
    });
    expect(() => stripUnknown({ junk: 1, outcome: { type: "unknown-kind" } }, schema)).toThrow(
      /mismatch/i,
    );
  });
});

describe("a structural union of two object options", () => {
  it("strips against neither, because it cannot tell which was meant", () => {
    // Not a discriminated union, so there is no tag to read: matching on basic
    // kind alone picks whichever option is listed first and reports the other
    // option's own keys as unrecognised material. No generated schema has this
    // shape today; the guard is what keeps one from acquiring it silently.
    const schema = z.looseObject({
      payload: z.union([
        z.looseObject({ a: z.string() }),
        z.looseObject({ b: z.string() }),
      ]),
    });
    const { value, stripped } = stripUnknown({ payload: { b: "x" } }, schema);
    expect(stripped).toEqual([]);
    expect(value).toEqual({ payload: { b: "x" } });
  });

  it("still recurses when only one option is an object", () => {
    const schema = z.looseObject({
      payload: z.union([z.string(), z.looseObject({ a: z.string() })]),
    });
    const { value, stripped } = stripUnknown({ payload: { a: "x", junk: 1 } }, schema);
    expect(stripped).toEqual(["/payload/junk"]);
    expect(value).toEqual({ payload: { a: "x" } });
  });
});

describe("wrappers and containers the generated schemas do not use yet", () => {
  const inner = () => z.looseObject({ a: z.string() });

  it("sees through a pipe", () => {
    const schema = z.looseObject({ payload: inner().pipe(z.transform((v) => v)) });
    const { value, stripped } = stripUnknown({ payload: { a: "x", junk: 1 } }, schema);
    expect(stripped).toEqual(["/payload/junk"]);
    expect(value).toEqual({ payload: { a: "x" } });
  });

  it("sees through a lazy", () => {
    const schema = z.looseObject({ payload: z.lazy(inner) });
    const { value, stripped } = stripUnknown({ payload: { a: "x", junk: 1 } }, schema);
    expect(stripped).toEqual(["/payload/junk"]);
    expect(value).toEqual({ payload: { a: "x" } });
  });

  it("sees through a catch", () => {
    const schema = z.looseObject({ payload: inner().catch({ a: "" }) });
    const { value, stripped } = stripUnknown({ payload: { a: "x", junk: 1 } }, schema);
    expect(stripped).toEqual(["/payload/junk"]);
    expect(value).toEqual({ payload: { a: "x" } });
  });

  it("recurses into the values of a record", () => {
    const schema = z.looseObject({ payload: z.record(z.string(), inner()) });
    const { value, stripped } = stripUnknown({ payload: { k: { a: "x", junk: 1 } } }, schema);
    expect(stripped).toEqual(["/payload/k/junk"]);
    expect(value).toEqual({ payload: { k: { a: "x" } } });
  });

  it("removes a record entry whose value is unrecognisable", () => {
    const schema = z.looseObject({
      payload: z.record(
        z.string(),
        z.looseObject({
          kind: z.discriminatedUnion("type", [z.looseObject({ type: z.literal("known") })]),
        }),
      ),
    });
    const { value, stripped } = stripUnknown(
      { payload: { keep: { kind: { type: "known" } }, gone: { kind: { type: "future" } } } },
      schema,
    );
    expect(stripped).toEqual(["/payload/gone"]);
    expect(value).toEqual({ payload: { keep: { kind: { type: "known" } } } });
  });
});

describe("a producer key that shares a name with Object.prototype", () => {
  // Found while auditing the chunk-expansion collision report. The shape
  // lookup is `shape[key]` over PRODUCER-supplied keys, and a plain object's
  // property access walks the prototype chain: `shape["toString"]` answers
  // with `Object.prototype.toString`, a function, not `undefined`. The
  // stripper read that as "the schema describes this field", left the value in
  // place and reported nothing — so an unrecognised property named `toString`,
  // `constructor`, `valueOf` or `hasOwnProperty` survived enforcement and
  // reached subscribers, silently. That is both halves of the guarantee at
  // once: nothing unrecognised may survive, and nothing may go unannounced.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    "is stripped and reported like any other unknown key (%s)",
    (key) => {
      const event = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        [key]: "from a producer",
      };
      const START = eventSchema(EventType.TEXT_MESSAGE_START);
      const { value, stripped } = stripUnknown(event, START);

      expect(stripped).toEqual([`/${key}`]);
      expect(Object.keys(value as object)).not.toContain(key);
    },
  );

  it("still leaves the fields the schema really does describe alone", () => {
    const START = eventSchema(EventType.TEXT_MESSAGE_START);
    const { value, stripped } = stripUnknown(
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      START,
    );
    expect(stripped).toEqual([]);
    expect(value).toEqual({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    });
  });
});
