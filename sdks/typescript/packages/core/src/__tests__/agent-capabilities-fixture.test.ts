import fixture from "../../../../../fixtures/agent-capabilities.json";

import { AgentCapabilitiesSchema } from "../schemas";

/**
 * Runs `sdks/fixtures/agent-capabilities.json`, the cross-language fixture the Python and
 * .NET SDKs run too.
 *
 * `AgentCapabilities` is generated from one schema definition for every SDK, and the three
 * hand-written copies that preceded it had drifted (dictionary-typed `identity.metadata` and
 * `custom` in .NET, a `subAgents` spelling everywhere). This test is TypeScript's side of the
 * agreement: parse each `input` into the generated model, serialize it back through the
 * SDK's normal JSON path, and require exactly `expected` — no invented defaults for a group
 * the input left out, and no unset optional member surfacing as `null`.
 *
 * `sdks/fixtures` sits outside this project directory, so `@ag-ui/core` turns off Nx caching
 * for its `test` target (see `nx.targets` in `package.json` and the wiring note in
 * `sdks/fixtures/README.md`); without that an edit to the fixture could leave a stale green
 * result behind.
 */

const SDK_NAME = "typescript";

interface FixtureCase {
  name: string;
  producedBy: string[];
  note?: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const allCases: FixtureCase[] = fixture.cases;
const cases: FixtureCase[] = allCases.filter((entry) => entry.producedBy.includes(SDK_NAME));

/**
 * The open-by-key members. A `null` VALUE under one of these is data the protocol
 * says MUST be preserved (the `open_values_may_be_null` case pins it), so the
 * no-null walk does not descend into them; everywhere else a null can only be an
 * unset optional member spelled wrong.
 */
const OPEN_BY_KEY = new Set(["metadata", "custom"]);

/** Every value reachable from `value` outside the open-by-key members, so a stray `null` can be spotted. */
function collectNullPaths(value: unknown, path: string, found: string[]): string[] {
  if (value === null) {
    found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectNullPaths(item, `${path}[${index}]`, found));
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (OPEN_BY_KEY.has(key)) {
        // Skipping the member skipped its VALUE, not the member itself: the
        // schema types `custom` and `identity.metadata` as objects that may be
        // absent but are never null when present, so `"custom": null` in an
        // `expected` document is the very mistake this walk exists to catch —
        // and it was the one shape the walk never looked at.
        if (child === null) found.push(here);
        continue;
      }
      collectNullPaths(child, here, found);
    }
  }
  return found;
}

describe("agent capabilities cross-language fixture", () => {
  it("has cases, and every one of them covers this SDK", () => {
    expect(allCases.length).toBeGreaterThan(0);

    // `producedBy` exists for wire types an SDK genuinely does not implement. Nothing about
    // `AgentCapabilities` is optional for TypeScript — the model is generated from the same
    // schema as the others — so a case that skipped TypeScript would be papering over a
    // failure rather than recording a real gap. If one ever legitimately needs skipping, the
    // reason belongs here, next to the loosened assertion.
    expect(allCases.filter((entry) => !entry.producedBy.includes(SDK_NAME))).toEqual([]);
    expect(cases.length).toBe(allCases.length);
  });

  it("expects no null anywhere: absent is how an unset member is spelled", () => {
    // Control, first, because the loop below is vacuous without it: no document
    // in the shared fixture puts a null AT an open-by-key member today, so the
    // one line that handles that shape — `if (child === null) found.push(here)`
    // in the OPEN_BY_KEY branch — can be deleted and every assertion here stays
    // green. These three pin the branch directly: a null AT the member is found,
    // a null INSIDE its value is not.
    expect(collectNullPaths({ custom: null }, "", [])).toEqual(["custom"]);
    expect(collectNullPaths({ identity: { metadata: null } }, "", [])).toEqual([
      "identity.metadata",
    ]);
    expect(collectNullPaths({ custom: { anything: null } }, "", [])).toEqual([]);

    for (const entry of allCases) {
      expect({ [entry.name]: collectNullPaths(entry.expected, "", []) }).toEqual({
        [entry.name]: [],
      });
    }
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s re-serializes to its expected JSON",
    (_name, entry) => {
      const capabilities = AgentCapabilitiesSchema.parse(entry.input);
      const payload = JSON.parse(JSON.stringify(capabilities));

      expect(payload).toEqual(entry.expected);
    },
  );
});
