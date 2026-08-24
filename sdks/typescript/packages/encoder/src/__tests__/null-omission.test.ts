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
    },
  );
});
