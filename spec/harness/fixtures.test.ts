import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_DIR,
  eventDefinitions,
  eventValidator,
  normaliseErrors,
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
