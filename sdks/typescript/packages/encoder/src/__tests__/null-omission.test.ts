import { EventSchemas } from "@ag-ui/core";

import fixture from "../../../../../fixtures/null-omission.json";

import { EventEncoder } from "../encoder";

/**
 * Runs `sdks/fixtures/null-omission.json`, the cross-language fixture the Python and .NET
 * SDKs run too.
 *
 * TypeScript is the SDK that already behaves correctly here — `JSON.stringify` drops
 * `undefined`, so a field with no value simply does not appear. Running the fixture from
 * this side is what makes it the shared contract rather than a Python/.NET convention: if a
 * case is added that TypeScript would not actually produce, this test says so instead of the
 * other two SDKs being held to something the reference implementation does not do.
 *
 * The re-serialization check alone is not enough to hold this SDK to a case's TOP-LEVEL
 * keys, because `BaseEventSchema` is `.passthrough()`: a key this SDK does not declare
 * survives `.parse()` as an unrecognized key and is re-encoded verbatim, so the round-trip
 * would pass for a field TypeScript has never heard of. Every case therefore also asserts
 * that each top-level key it expects is a DECLARED field of the event variant.
 *
 * That check stops at the top level, and deliberately: `.passthrough()` is used exactly once
 * in this SDK, on `BaseEventSchema`. Every nested schema is a plain `z.object`, which STRIPS
 * an unknown key, so a nested key the SDK stopped declaring disappears from the encoded
 * payload and the round-trip above fails on its own. `passthrough is the only leak` below
 * pins that asymmetry rather than leaving it as a claim in this comment. (.NET gets top-level
 * and nested for free — System.Text.Json drops unknown keys at every depth — and Python,
 * whose `extra="allow"` leaks at every depth, walks its fixture cases recursively.)
 */

const SDK_NAME = "typescript";

interface FixtureCase {
  name: string;
  producedBy: string[];
  note?: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const cases: FixtureCase[] = fixture.stream.filter((entry) => entry.producedBy.includes(SDK_NAME));

/**
 * The number of cases this SDK is held to.
 *
 * Pinned exactly, not as a floor. A floor cannot notice a deletion: under the previous
 * `> 15` bound, with 35 cases present, deleting a case outright left this suite — and the
 * Python and .NET ones — green. Bump this deliberately when adding or removing a case.
 */
const EXPECTED_CASE_COUNT = 36;

/** The field names the event variant for `type` actually declares. */
function declaredFields(type: unknown): string[] {
  const variant = EventSchemas.optionsMap.get(type as string);
  if (variant === undefined) {
    throw new Error(`EventSchemas declares no variant for type ${JSON.stringify(type)}`);
  }
  return Object.keys(variant.shape);
}

function encodeToPayload(event: Parameters<EventEncoder["encode"]>[0]): Record<string, unknown> {
  const encoded = new EventEncoder().encode(event);
  return JSON.parse(encoded.slice("data: ".length, -"\n\n".length));
}

describe("null omission cross-language fixture", () => {
  it("still carries every case this SDK is held to", () => {
    expect(cases.length).toBe(EXPECTED_CASE_COUNT);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s re-serializes to its expected JSON",
    (_name, entry) => {
      const payload = encodeToPayload(EventSchemas.parse(entry.input));

      expect(payload).toEqual(entry.expected);

      // ...and every top-level key the case expects is a field this SDK declares, not one
      // that merely rode through the passthrough schema untouched.
      const declared = declaredFields(entry.expected.type);
      for (const key of Object.keys(entry.expected)) {
        expect(declared).toContain(key);
      }
    },
  );

  it("passthrough is the only leak: an undeclared key survives at the top level and nowhere else", () => {
    // Why the declared-field assertion above is top-level only. An undeclared TOP-LEVEL key
    // rides through `BaseEventSchema.passthrough()` untouched, which is exactly why that
    // assertion has to exist. An undeclared NESTED key is stripped by the plain `z.object`
    // it lands in, so it never reaches the wire — which is why the round-trip assertion
    // already fails when a nested field stops being declared, and no recursive walk is
    // needed on this side. If a nested schema ever gains `.passthrough()`, this test fails
    // and the declared-field walk above has to become recursive.
    const topLevel = encodeToPayload(
      EventSchemas.parse({
        type: "TOOL_CALL_RESULT",
        messageId: "msg_1",
        toolCallId: "tc_1",
        content: "{}",
        undeclaredTopLevelKey: "rode through",
      }),
    );
    expect(topLevel.undeclaredTopLevelKey).toBe("rode through");

    const nested = encodeToPayload(
      EventSchemas.parse({
        type: "MESSAGES_SNAPSHOT",
        messages: [
          {
            id: "msg_3",
            role: "tool",
            content: "{}",
            toolCallId: "tc_1",
            undeclaredNestedKey: "stripped",
          },
        ],
      }),
    );
    expect(nested.messages).toEqual([
      { id: "msg_3", role: "tool", content: "{}", toolCallId: "tc_1" },
    ]);
  });
});
