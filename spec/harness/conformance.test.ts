/**
 * The gate over the conformance fixture corpus.
 *
 * The fixtures themselves are run by each client's own lane — TypeScript in
 * `@ag-ui/client`, .NET in `AGUI.Client.UnitTests` — because only a client can
 * say what a client does. What belongs here is everything true of the corpus
 * regardless of who consumes it: that each file is well formed, that a
 * divergence between the two clients is always explained, and that the
 * behaviours this suite exists to pin all still have a fixture.
 *
 * Both lanes discover fixtures by reading this directory, so "every fixture
 * runs in both lanes" is structural rather than asserted: a file added here is
 * picked up by both, and a lane that stopped reading the directory would fail
 * its own has-fixtures check.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_SPEC_OUTPUT_DIR } from "../generator/generate";

const STREAMS_DIR = join(
  DOCS_SPEC_OUTPUT_DIR,
  "..",
  "..",
  "..",
  "spec",
  "draft",
  "conformance",
  "streams",
);

interface Fixture {
  name?: unknown;
  area?: unknown;
  description?: unknown;
  kill?: unknown;
  stream?: unknown;
  expect?: unknown;
  expectOverrides?: Record<string, { intentional?: unknown } | undefined>;
}

const files = readdirSync(STREAMS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

const fixtures = files.map((file) => ({
  file,
  fixture: JSON.parse(readFileSync(join(STREAMS_DIR, file), "utf8")) as Fixture,
}));

describe("the conformance fixture corpus", () => {
  it("has fixtures", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("$file is well formed", ({ file, fixture }) => {
    expect(fixture.name, "name is required").toBe(basename(file, ".json"));
    expect(typeof fixture.area, "area is required").toBe("string");
    expect(
      typeof fixture.description === "string" &&
        fixture.description.length > 0,
      "description is required",
    ).toBe(true);
    // Every fixture states the change that must break it. A fixture nobody can
    // break is a fixture that proves nothing, and this is the only mechanical
    // pressure against writing one.
    expect(
      typeof fixture.kill === "string" && fixture.kill.length > 0,
      "kill is required: name the one-line change that must make this fail",
    ).toBe(true);
    expect(Array.isArray(fixture.stream), "stream must be an array").toBe(true);
    expect(
      fixture.expect !== null && typeof fixture.expect === "object",
      "expect is required",
    ).toBe(true);
  });

  /**
   * The keys a lane actually implements. A runner ignores what it does not
   * recognise, so a typo — `messageCounts` for `messageCount` — would produce
   * a fixture that asserts nothing at all and still passes. Nothing else
   * catches that, which makes this the gate's most load-bearing check.
   */
  const EXPECTATION_KEYS = new Set([
    "outcome",
    "errorContains",
    "runError",
    "eventTypes",
    "eventTypesAbsent",
    "warnings",
    "noWarnings",
    "messageCount",
    "messages",
    "state",
    "request",
    "requestAbsentPaths",
    "eventPaths",
    "eventAbsentPaths",
  ]);

  it.each(fixtures)("$file uses only implemented expectation keys", ({
    fixture,
  }) => {
    const blocks: Array<[string, Record<string, unknown>]> = [
      ["expect", (fixture.expect ?? {}) as Record<string, unknown>],
    ];
    for (const [lane, override] of Object.entries(
      fixture.expectOverrides ?? {},
    )) {
      blocks.push([
        `expectOverrides.${lane}`,
        (override ?? {}) as Record<string, unknown>,
      ]);
    }
    for (const [where, block] of blocks) {
      for (const key of Object.keys(block)) {
        if (where !== "expect" && key === "intentional") continue;
        expect(
          EXPECTATION_KEYS.has(key),
          `${where}.${key} is not an expectation any lane implements — a typo here asserts nothing`,
        ).toBe(true);
      }
    }
  });

  /**
   * Whether a key actually constrains anything. Several forms look like
   * assertions and are not: `warnings: []` reads as "each of these substrings
   * must appear" over an empty list, `request: {}` subset-matches every
   * object, `noWarnings: false` is the default. An empty ARRAY is different
   * where the emptiness is the claim — `eventTypes: []` says no events were
   * delivered, `messages: []` says none were built — so those still count.
   */
  const isEffective = (key: string, value: unknown): boolean => {
    switch (key) {
      case "warnings":
      case "eventTypesAbsent":
      case "eventAbsentPaths":
      case "requestAbsentPaths":
        return Array.isArray(value) && value.length > 0;
      case "request":
      case "eventPaths":
        // Not an array: typeof calls one "object" too, and the .NET runner
        // reads these keys only as JSON objects, so an array would satisfy
        // this check while that lane ran no assertion at all.
        return (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value as Record<string, unknown>).length > 0
        );
      case "noWarnings":
        return value === true;
      case "errorContains":
      case "outcome":
        return typeof value === "string" && value.length > 0;
      case "messageCount":
        return typeof value === "number";
      case "runError":
        return value === true || (typeof value === "string" && value.length > 0);
      case "eventTypes":
      case "messages":
        return Array.isArray(value);
      case "state":
        return value !== undefined;
      default:
        // A key whose value is the wrong type is read by neither runner, so
        // it constrains nothing however present it looks from here.
        return false;
    }
  };

  /**
   * Keys a lane does not implement at all. The .NET client keeps no state and
   * has no JSON Patch reducer, so its runner skips `state` — a fixture whose
   * only constraint is `state` therefore asserts nothing there, however
   * effective the key looks from here.
   */
  const UNIMPLEMENTED: Record<string, Set<string>> = {
    dotnet: new Set(["state"]),
  };

  const effectiveKeys = (
    block: Record<string, unknown>,
    lane?: string,
  ): string[] =>
    Object.entries(block)
      .filter(
        ([key, value]) =>
          key !== "intentional" &&
          isEffective(key, value) &&
          !(lane !== undefined && UNIMPLEMENTED[lane]?.has(key)),
      )
      .map(([key]) => key);

  /** The type each expectation must hold for a runner to read it at all. */
  const KEY_SHAPES: Record<string, (value: unknown) => boolean> = {
    outcome: (v) => v === "completed" || v === "failed",
    errorContains: (v) => typeof v === "string",
    runError: (v) => typeof v === "boolean" || typeof v === "string",
    eventTypes: (v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
    eventTypesAbsent: (v) =>
      Array.isArray(v) && v.every((e) => typeof e === "string"),
    eventPaths: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    eventAbsentPaths: (v) =>
      Array.isArray(v) && v.every((e) => typeof e === "string"),
    warnings: (v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
    noWarnings: (v) => typeof v === "boolean",
    messageCount: (v) => typeof v === "number",
    messages: (v) => Array.isArray(v),
    state: () => true,
    request: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    requestAbsentPaths: (v) =>
      Array.isArray(v) && v.every((e) => typeof e === "string"),
  };

  it.each(fixtures)("$file gives every expectation a readable shape", ({
    fixture,
  }) => {
    // Declining to COUNT a wrongly-typed value is not the same as rejecting
    // it: `eventPaths: []` beside a valid outcome would pass the vacuity
    // check while the payload assertion it looks like silently does nothing.
    const blocks: Array<[string, Record<string, unknown>]> = [
      ["expect", (fixture.expect ?? {}) as Record<string, unknown>],
    ];
    for (const [lane, override] of Object.entries(
      fixture.expectOverrides ?? {},
    ))
      blocks.push([
        `expectOverrides.${lane}`,
        (override ?? {}) as Record<string, unknown>,
      ]);
    for (const [where, block] of blocks) {
      for (const [key, value] of Object.entries(block)) {
        if (key === "intentional") continue;
        const shape = KEY_SHAPES[key];
        if (shape === undefined) continue; // the unknown-key gate covers this
        expect(
          shape(value),
          `${where}.${key} holds a value no runner can read: ${JSON.stringify(value)}`,
        ).toBe(true);
      }
    }
  });

  it.each(fixtures)("$file asserts something", ({ fixture }) => {
    const base = (fixture.expect ?? {}) as Record<string, unknown>;
    expect(
      effectiveKeys(base),
      "expect must contain at least one assertion that actually constrains something",
    ).not.toEqual([]);

    // And so must EVERY lane, whether or not it has an override: a lane that
    // skips a key it does not implement can be left asserting nothing even
    // when the base looks well populated.
    for (const lane of ["typescript", "dotnet"]) {
      const override = (fixture.expectOverrides ?? {})[lane] ?? {};
      const resolved = { ...base, ...(override as Record<string, unknown>) };
      delete resolved.intentional;
      expect(
        effectiveKeys(resolved, lane),
        `on the ${lane} lane this fixture asserts nothing`,
      ).not.toEqual([]);
    }
  });

  it.each(fixtures)(
    "$file explains any client divergence",
    ({ fixture }) => {
      for (const [lane, override] of Object.entries(
        fixture.expectOverrides ?? {},
      )) {
        expect(["typescript", "dotnet"]).toContain(lane);
        // The whole point of recording a divergence is that someone reading it
        // learns why the two clients differ. An override without a reason is
        // the silent inconsistency this suite exists to prevent.
        expect(
          typeof override?.intentional === "string" &&
            override.intentional.length > 0,
          `${lane} override must say why the divergence is intentional`,
        ).toBe(true);
      }
    },
  );

  /**
   * The behaviours the conformance suite exists to pin. Each names a fixture
   * that must exist; deleting the fixture fails here rather than quietly
   * shrinking what the clients are held to. Renaming one is fine — update the
   * entry with it, deliberately.
   */
  const required: Array<[behaviour: string, fixtureName: string]> = [
    ["unknown event dropped with a warning", "unknown-event-dropped"],
    ["unknown property stripped with a warning", "unknown-property-stripped"],
    ["a malformed known value is fatal", "malformed-known-field-fatal"],
    ["a retired event is translated, not dropped", "era-0-0-45-thinking-translated"],
    [
      "a downgrade that loses content warns",
      "era-0-0-57-subagent-dropped-with-warning",
    ],
    ["a malformed sequence is rejected", "content-without-start-fatal"],
    ["the 0.0.39 era shim has a fixture", "era-0-0-39-flattens-content"],
    // Deliberately not "the 0.0.45 shim has a fixture". It cannot have one:
    // the always-on compatibility boundary translates every THINKING_* shape
    // the 0.0.45 shim handles, and runs innermost, so the shim never sees one
    // in the shipped pipeline. Measured — disabling either translator alone
    // leaves the fixture green; only disabling both fails it. What the fixture
    // holds is the retired shapes' translation, wherever it happens.
    [
      "retired THINKING_* shapes are translated by something",
      "era-0-0-45-thinking-translated",
    ],
    ["the 0.0.47 era shim has a fixture", "era-0-0-47-upgrades-binary-content"],
    [
      "the 0.0.57 era shim has a fixture",
      "era-0-0-57-subagent-dropped-with-warning",
    ],
    ["a conformant 1.0 stream stays quiet", "conformant-run-is-quiet"],
    // The 0.0.39 and 0.0.47 fixtures delegate their version-gate coverage
    // here, so deleting this one removes those two checks entirely. The
    // 0.0.57 gate is also covered incidentally elsewhere — an unpinned
    // subagent fixture fails if that shim installs unconditionally — so this
    // entry protects two gates, not three.
    [
      "the era version gates are killable",
      "era-current-peer-keeps-modern-content",
    ],
  ];

  it.each(required)("still covers: %s", (_behaviour, fixtureName) => {
    expect(files).toContain(`${fixtureName}.json`);
  });

  it("names every fixture uniquely", () => {
    const names = fixtures.map(({ fixture }) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
