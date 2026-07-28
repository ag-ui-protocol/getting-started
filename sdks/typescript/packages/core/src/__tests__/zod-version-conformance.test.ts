/**
 * Protocol conformance guard.
 *
 * `@ag-ui/core/schemas` supports zod `^3.25.18 || ^4.0.0` through the `zod/v4`
 * subpath. The API surface is identical across that range but the *engine*
 * version is not (zod@3.25.x ships engine 4.0.0, zod@4.4.x ships 4.4.x), and
 * engine releases have changed parse behavior — most notably, a bare `z.any()`
 * object value is accepted when missing on 4.0.0 and rejected as `nonoptional`
 * on 4.4.x.
 *
 * `@ag-ui/client` calls `EventSchemas.parse(json)` and errors the stream when it
 * throws, so any such divergence would make the wire contract depend on which
 * zod the consumer happened to install. This suite pins the verdict for every
 * payload in the shared corpus against the workspace zod; the `zod-compat` job
 * in .github/workflows/unit-typescript-sdk.yml runs the same corpus against
 * every supported zod version.
 */
import { describe, expect, it } from "vitest";
import { EventSchemas, ToolSchema, RunAgentInputSchema } from "../schemas";
import { ACCEPT, REJECT } from "./fixtures/event-corpus";

describe("event corpus parses identically across the supported zod range", () => {
  it.each(ACCEPT.map((c) => [c.name, c] as const))("accepts %s", (_name, testCase) => {
    const result = EventSchemas.safeParse(testCase.payload);
    if (!result.success) {
      throw new Error(`expected accept but got: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    for (const [key, value] of Object.entries(testCase.expect ?? {})) {
      expect((result.data as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it.each(REJECT.map((c) => [c.name, c] as const))("rejects %s", (_name, testCase) => {
    expect(EventSchemas.safeParse(testCase.payload).success).toBe(false);
  });
});

describe("z.any() object values are optional on every engine", () => {
  // Regression guard for Markus's review item 2. A bare `z.any()` here would pass
  // on zod engine 4.0.0 and fail on 4.4.x, so the schema must be explicitly
  // `.optional()` and match the hand-written type.
  it("accepts a Tool without parameters", () => {
    expect(ToolSchema.safeParse({ name: "search", description: "searches" }).success).toBe(true);
  });

  it("accepts a RunAgentInput without state or forwardedProps", () => {
    const result = RunAgentInputSchema.safeParse({
      threadId: "t1",
      runId: "r1",
      messages: [],
      tools: [],
      context: [],
    });
    expect(result.success).toBe(true);
  });

  it("still accepts them when present", () => {
    expect(
      RunAgentInputSchema.safeParse({
        threadId: "t1",
        runId: "r1",
        messages: [],
        tools: [{ name: "s", description: "d", parameters: { type: "object" } }],
        context: [],
        state: { count: 1 },
        forwardedProps: { a: true },
      }).success,
    ).toBe(true);
  });
});
