import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { literalValue, stripUnknown } from "../strip";

// zod 3.25.18 — the declared peer floor — ships an early `zod/v4` whose literals
// have `def.values` (an array) and `.values` (a Set) but NO `.value` getter; the
// getter arrived later in the 3.25 line. A consumer pinning that floor next to a
// client that resolved 3.25.76 holds two copies, and every schema the client
// enforces was built by the older one. Found by driving a packed consumer with
// zod@3.25.18: "No validator for recognised event type 'RUN_STARTED'". This
// reproduces the older shape on a real instance rather than a hand-built fake,
// so the brand check (`instanceof`) stays genuine.
// `.value` is an own, non-configurable accessor on the instance, so it cannot be
// redefined; a proxy that hides that one key and forwards everything else — the
// `_zod.traits` brand that `instanceof` reads, `def`, `values`, `shape` — is the
// older literal in every way the readers under test can observe.
const asZod3_25_18 = <T extends z.ZodType>(schema: T): T =>
  new Proxy(schema, {
    get: (target, key) => (key === "value" ? undefined : Reflect.get(target, key, target)),
    has: (target, key) => key !== "value" && Reflect.has(target, key),
  });

describe("literalValue across the zod 3.25 line", () => {
  it("reads the literal from def.values, not from the newer .value getter", () => {
    const modern = z.literal("RUN_STARTED");
    const older = asZod3_25_18(z.literal("RUN_STARTED"));
    expect((older as unknown as { value?: unknown }).value).toBeUndefined();
    expect(literalValue(modern)).toBe("RUN_STARTED");
    expect(literalValue(older)).toBe("RUN_STARTED");
  });

  it("still narrows a discriminated union when the literals have no .value", () => {
    const a = z.looseObject({ type: asZod3_25_18(z.literal("A")), keep: z.string() });
    const b = z.looseObject({ type: asZod3_25_18(z.literal("B")), other: z.number() });
    const union = z.discriminatedUnion("type", [a, b]);
    const { value, stripped } = stripUnknown(
      { items: [{ type: "A", keep: "x", extra: 1 }] },
      z.object({ items: z.array(union) }),
    );
    expect(stripped).toEqual(["/items/0/extra"]);
    expect(value).toEqual({ items: [{ type: "A", keep: "x" }] });
  });
});
