import { omitOptionalNulls } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";

import fixture from "../../../../../fixtures/null-omission.json";

import { EventEncoder } from "../encoder";

/**
 * Runs `sdks/fixtures/null-omission.json`, the cross-language fixture the Python and .NET
 * SDKs run too.
 *
 * Producer inputs may contain optional nulls; serialization omits them using
 * the known protocol shape. Required and nested payload nulls remain intact.
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
      const event = EventSchemas.parse(omitOptionalNulls(entry.input, "Event"));
      const encoded = new EventEncoder().encode(event);
      const payload = JSON.parse(encoded.slice("data: ".length, -"\n\n".length));

      expect(payload).toEqual(entry.expected);
    },
  );
});
