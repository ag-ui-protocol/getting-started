import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_DIR,
  eventDefinitions,
  eventValidator,
  normaliseErrors,
  schema,
  validatorFor,
} from "./validator";

const FIXTURES_DIR = join(DRAFT_DIR, "fixtures");

interface Fixture {
  /** The anchored definition the document is validated against. */
  anchor: string;
  /** Fixture file name, used as the test title. */
  name: string;
  path: string;
}

interface Expectation {
  keyword: string;
  instanceLocation: string;
  /** Which rule in the schema produced the error, as a JSON Pointer into it. */
  keywordLocation: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function collect(kind: "valid" | "invalid"): Fixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  const fixtures: Fixture[] = [];
  for (const anchor of readdirSync(FIXTURES_DIR).sort()) {
    const dir = join(FIXTURES_DIR, anchor, kind);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      // Expectation files sit beside the documents they describe, so they have
      // to be skipped rather than treated as documents themselves.
      if (!file.endsWith(".json") || file.endsWith(".expect.json")) continue;
      fixtures.push({
        anchor,
        name: `${anchor}/${kind}/${file}`,
        path: join(dir, file),
      });
    }
  }
  return fixtures;
}

const valid = collect("valid");
const invalid = collect("invalid");

describe("the fixture corpus", () => {
  it("matches the committed manifest", () => {
    // `has fixtures to run` is satisfied by one document, so nothing stopped
    // the corpus from shrinking: deleting every ReasoningMessageStartEvent
    // fixture would have left this suite green and the closure probes, the
    // root-union checks and the generated-zod comparison all running over
    // whatever survived. A committed listing makes that a diff — asserted in
    // BOTH directions, so a NEW fixture missing from the manifest fails too.
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
            : entry.name.endsWith(".json")
              ? [`${prefix}${entry.name}`]
              : [],
        );
    const found = walk(FIXTURES_DIR, "").sort();
    const manifest = readFileSync(join(FIXTURES_DIR, "MANIFEST.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .sort();
    expect(
      manifest,
      "spec/draft/fixtures/MANIFEST.txt is out of date. If you added or removed a fixture, " +
        "regenerate it in the same commit (the command is in the file's header) and say so in " +
        "the message; if you did not, a fixture has gone missing.",
    ).toEqual(found);
  });
});

describe("accepted documents", () => {
  it("has fixtures to run", () => {
    expect(valid.length).toBeGreaterThan(0);
  });

  it.each(valid.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const validate = validatorFor(fixture.anchor);
      const document = readJson<unknown>(fixture.path);
      const accepted = validate(document);
      expect(
        accepted,
        JSON.stringify(normaliseErrors(validate.errors), null, 2),
      ).toBe(true);
    },
  );
});

describe("rejected documents", () => {
  it("has fixtures to run", () => {
    expect(invalid.length).toBeGreaterThan(0);
  });

  it.each(invalid.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const expectationPath = fixture.path.replace(/\.json$/, ".expect.json");
      expect(
        existsSync(expectationPath),
        `${fixture.name} has no ${basename(expectationPath)}. Every rejection has to name the ` +
          `keyword and location that caused it: a document that fails for an unrelated reason ` +
          `would still fail if the rule under test vanished, which is a false green.`,
      ).toBe(true);

      const expectation = readJson<Expectation>(expectationPath);
      const validate = validatorFor(fixture.anchor);
      const document = readJson<unknown>(fixture.path);

      expect(validate(document), "document was accepted").toBe(false);

      // The expectation names the rule as well as the keyword and the place,
      // because keyword-and-place alone does not identify a rule: inside a union,
      // several branches report the same keyword at the same instance location.
      //
      // Uniqueness is deliberately not required. ajv reports `keywordLocation`
      // relative to the subschema it compiled, so sibling branches of a union
      // share it — `#/required` is what both AddOperation and ReplaceOperation
      // report — and demanding one match would fail on documents that are
      // correctly rejected. What stops a union expectation from being satisfied
      // by the wrong branch is asserting the union's own `oneOf` rather than a
      // branch's rule, which is what the three union fixtures do.
      const errors = normaliseErrors(validate.errors);
      const matched = errors.filter(
        (error) =>
          error.keyword === expectation.keyword &&
          error.instanceLocation === expectation.instanceLocation &&
          error.keywordLocation === expectation.keywordLocation,
      );
      expect(
        matched.length,
        `expected ${expectation.keyword} at "${expectation.instanceLocation}" from ` +
          `${expectation.keywordLocation}, found none. All errors:\n` +
          JSON.stringify(errors, null, 2),
      ).toBeGreaterThan(0);
    },
  );
});

describe("closure probes", () => {
  // Closure is a semantic property, and the structural guards in
  // schema.test.ts can only forbid the neutralising constructs they know
  // about — a rogue allOf member, a sibling $ref, a stray
  // additionalProperties. This is the check no construct can dodge: take a
  // document the definition provably accepts, add one property no version of
  // the protocol declares, and demand rejection. Whatever route reopens a
  // closed object, it ends with this probe being accepted, so it fails here.
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const closedAnchors = new Set(
    Object.entries(defs)
      .filter(([, def]) => def.unevaluatedProperties === false)
      .map(([name]) => name),
  );
  const probeable = valid.filter((fixture) =>
    closedAnchors.has(fixture.anchor),
  );

  it("has closed-definition fixtures to probe", () => {
    expect(probeable.length).toBeGreaterThan(0);
  });

  it.each(probeable.map((fixture) => [fixture.name, fixture] as const))(
    "%s with an undeclared property is rejected",
    (_name, fixture) => {
      const validate = validatorFor(fixture.anchor);
      const document = readJson<Record<string, unknown>>(fixture.path);
      // The document validates without the probe (the accepted-documents suite
      // pins that), so a rejection here is attributable to the probe alone.
      expect(
        validate({ ...document, xClosureProbe: true }),
        "an undeclared property was accepted",
      ).toBe(false);
    },
  );
});

describe("the document root", () => {
  // schema.json's stated purpose is that validating a document against the file
  // itself validates it as an AG-UI event. Nothing exercised that: every other
  // test compiles a definition by anchor, so the root union — the one address a
  // consumer is most likely to use — went unchecked.
  const eventAnchors = new Set(eventDefinitions().values());
  const eventFixtures = valid.filter((fixture) =>
    eventAnchors.has(fixture.anchor),
  );

  it("has event fixtures to run", () => {
    expect(eventFixtures.length).toBeGreaterThan(0);
  });

  it.each(eventFixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s validates against schema.json itself",
    (_name, fixture) => {
      const validate = eventValidator();
      const document = readJson<unknown>(fixture.path);
      expect(
        validate(document),
        JSON.stringify(normaliseErrors(validate.errors), null, 2),
      ).toBe(true);
    },
  );

  it("rejects a document that is not an event", () => {
    const validate = eventValidator();
    expect(validate({ type: "NOT_AN_EVENT" })).toBe(false);
    expect(
      normaliseErrors(validate.errors).some((e) => e.keyword === "oneOf"),
    ).toBe(true);
  });
});

describe("the shared capabilities fixture", () => {
  // sdks/fixtures/agent-capabilities.json is what the three SDKs are held to;
  // the documents under AgentCapabilities/valid are what the schema is held
  // to. The shared fixture claims they are the same documents. Nothing else
  // checks that, so both copies could drift while every suite stayed green.
  const shared = readJson<{
    cases: Array<{ name: string; input: unknown; expected: unknown }>;
  }>(join(DRAFT_DIR, "..", "..", "sdks", "fixtures", "agent-capabilities.json"));
  const SPEC_FIXTURE_FOR: Record<string, string> = {
    full_every_group_populated: "full.json",
    minimal_nothing_declared: "minimal.json",
    partial_as_a_real_producer_declares: "partial.json",
    open_values_may_be_null: "open-values-null.json",
  };
  const validDir = join(FIXTURES_DIR, "AgentCapabilities", "valid");

  it("maps every shared case to a spec fixture, and every spec fixture to a case", () => {
    expect(shared.cases.map((c) => c.name).sort()).toEqual(Object.keys(SPEC_FIXTURE_FOR).sort());
    expect(readdirSync(validDir).filter((f) => f.endsWith(".json")).sort()).toEqual(
      Object.values(SPEC_FIXTURE_FOR).sort(),
    );
  });

  it.each(shared.cases.map((c) => [c.name, c] as const))(
    "%s is the same document the schema validates, on both sides of the round trip",
    (_name, c) => {
      const spec = readJson<unknown>(join(validDir, SPEC_FIXTURE_FOR[c.name]));
      expect(c.input).toEqual(spec);
      expect(c.expected).toEqual(spec);
    },
  );
});
