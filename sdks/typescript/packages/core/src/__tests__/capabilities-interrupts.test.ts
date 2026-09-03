import { describe, expect, it } from "vitest";
import { HumanInTheLoopCapabilitiesSchema } from "../schemas";

describe("HumanInTheLoopCapabilities — interrupt flags", () => {
  it("accepts interrupts: true", () => {
    const parsed = HumanInTheLoopCapabilitiesSchema.parse({ interrupts: true });
    expect(parsed.interrupts).toBe(true);
  });

  it("accepts approveWithEdits: true", () => {
    const parsed = HumanInTheLoopCapabilitiesSchema.parse({ approveWithEdits: true });
    expect(parsed.approveWithEdits).toBe(true);
  });

  it("accepts both flags with existing ones", () => {
    const parsed = HumanInTheLoopCapabilitiesSchema.parse({
      supported: true,
      approvals: true,
      interrupts: true,
      approveWithEdits: true,
    });
    expect(parsed).toEqual({
      supported: true,
      approvals: true,
      interrupts: true,
      approveWithEdits: true,
    });
  });

  it("leaves new flags undefined when omitted", () => {
    const parsed = HumanInTheLoopCapabilitiesSchema.parse({ supported: true });
    expect(parsed.interrupts).toBeUndefined();
    expect(parsed.approveWithEdits).toBeUndefined();
  });
});
