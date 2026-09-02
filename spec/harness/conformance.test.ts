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
    ["the 0.0.45 era shim has a fixture", "era-0-0-45-thinking-translated"],
    ["the 0.0.47 era shim has a fixture", "era-0-0-47-upgrades-binary-content"],
    [
      "the 0.0.57 era shim has a fixture",
      "era-0-0-57-subagent-dropped-with-warning",
    ],
    ["a conformant 1.0 stream stays quiet", "conformant-run-is-quiet"],
  ];

  it.each(required)("still covers: %s", (_behaviour, fixtureName) => {
    expect(files).toContain(`${fixtureName}.json`);
  });

  it("names every fixture uniquely", () => {
    const names = fixtures.map(({ fixture }) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
