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
 * The re-serialization check alone is not enough to hold this SDK to a case, because
 * `BaseEventSchema` is `.passthrough()`: a key this SDK does not declare survives `.parse()`
 * as an unrecognized key and is re-encoded verbatim, so the round-trip would pass for a
 * field TypeScript has never heard of. Every case therefore also asserts that each key it
 * expects on the wire is a DECLARED field of the event variant. (.NET gets this for free —
 * System.Text.Json drops unknown keys — and the Python harness makes the same assertion
 * against `model_fields`.)
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

/** The field names the event variant for `type` actually declares. */
function declaredFields(type: unknown): string[] {
  const variant = EventSchemas.optionsMap.get(type as string);
  if (variant === undefined) {
    throw new Error(`EventSchemas declares no variant for type ${JSON.stringify(type)}`);
  }
  return Object.keys(variant.shape);
}

describe("null omission cross-language fixture", () => {
  it("covers this SDK", () => {
    expect(cases.length).toBeGreaterThan(15);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s re-serializes to its expected JSON",
    (_name, entry) => {
      const event = EventSchemas.parse(entry.input);
      const encoded = new EventEncoder().encode(event);
      const payload = JSON.parse(encoded.slice("data: ".length, -"\n\n".length));

      expect(payload).toEqual(entry.expected);

      // ...and every key the case expects is a field this SDK declares, not one
      // that merely rode through the passthrough schema untouched.
      const declared = declaredFields(entry.expected.type);
      for (const key of Object.keys(entry.expected)) {
        expect(declared).toContain(key);
      }
    },
  );
});
