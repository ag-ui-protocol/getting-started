import { describe, expect, it } from "vitest";
import { createAjv, SCHEMA_ID, validatorFor } from "./validator";

const optionalJsonFields = [
  ["BaseEvent", "rawEvent"],
  ["RunFinishedEvent", "result"],
  ["SubagentFinishedEvent", "result"],
  ["ResumeEntry", "payload"],
  ["ImageInputContent", "metadata"],
  ["AudioInputContent", "metadata"],
  ["VideoInputContent", "metadata"],
  ["DocumentInputContent", "metadata"],
  ["Tool", "parameters"],
  ["RunAgentInput", "state"],
  ["RunAgentInput", "forwardedProps"],
];

describe("optional JSON fields are omitted when null", () => {
  const ajv = createAjv();
  it.each(optionalJsonFields)(
    "%s.%s excludes whole null but preserves JSON data",
    (name, field) => {
      const validate = ajv.compile({
        $ref: `${SCHEMA_ID}#/$defs/${name}/properties/${field}`,
      });
      expect(validate(null)).toBe(false);
      for (const value of [false, 0, "", [], { nested: null }, [null]]) {
        expect(validate(value), JSON.stringify(value)).toBe(true);
      }
    },
  );

  it("preserves required JSON null", () => {
    expect(
      validatorFor("CustomEvent")({ type: "CUSTOM", name: "x", value: null }),
    ).toBe(true);
    expect(validatorFor("RawEvent")({ type: "RAW", event: null })).toBe(true);
    expect(
      validatorFor("StateSnapshotEvent")({
        type: "STATE_SNAPSHOT",
        snapshot: null,
      }),
    ).toBe(true);
    expect(
      validatorFor("StateDeltaEvent")({
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/x", value: null }],
      }),
    ).toBe(true);
  });
});
