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
  specPage?: unknown;
  kill?: unknown;
  client?: unknown;
  input?: unknown;
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
    // Non-empty, not merely an array: `"stream": []` replays nothing, so every
    // stream-shaped expectation below is satisfied by a run that never
    // happened. Both runners iterate the array, so neither notices.
    expect(
      Array.isArray(fixture.stream) && fixture.stream.length > 0,
      "stream must be a non-empty array: an empty stream replays nothing and asserts nothing",
    ).toBe(true);
    expect(
      fixture.expect !== null && typeof fixture.expect === "object",
      "expect is required",
    ).toBe(true);
  });

  /**
   * The keys a fixture file may carry at the top level. The
   * implemented-expectation gate below only looks INSIDE `expect` and
   * `expectOverrides.<lane>`, so a misspelling one level up — `expectOverride`
   * for `expectOverrides`, `stream` typed as `streams` — is read by neither
   * runner and silently drops the whole block it was meant to name. The list
   * is exactly what the README documents. `name`, `area`, `description`,
   * `kill`, `stream` and `expect` are additionally required by the
   * well-formedness check above; `specPage` is required too, but by its own
   * `it` below rather than by that check; and `client`, `input` and
   * `expectOverrides` are the optional three.
   */
  const TOP_LEVEL_KEYS = new Set([
    "name",
    "area",
    "description",
    "specPage",
    "kill",
    "client",
    "input",
    "stream",
    "expect",
    "expectOverrides",
  ]);

  it.each(fixtures)("$file carries only documented top-level keys", ({
    fixture,
  }) => {
    for (const key of Object.keys(fixture as Record<string, unknown>)) {
      expect(
        TOP_LEVEL_KEYS.has(key),
        `top-level "${key}" is not a key either runner reads — a typo here drops the block it names`,
      ).toBe(true);
    }
  });

  it("requires specPage of every fixture", () => {
    // Named separately from the well-formedness check because it is the one
    // required key that check did not cover, and the allowlist above would
    // otherwise be the only place it is mentioned at all.
    for (const { file, fixture } of fixtures) {
      expect(
        typeof fixture.specPage === "string" && fixture.specPage.length > 0,
        `${file} has no specPage`,
      ).toBe(true);
    }
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

  const LANES = ["typescript", "dotnet"] as const;

  /** What a lane is actually held to, once its override is applied. */
  const resolvedFor = (
    fixture: Fixture,
    lane: string,
  ): Record<string, unknown> => {
    const base = (fixture.expect ?? {}) as Record<string, unknown>;
    const override = (fixture.expectOverrides ?? {})[lane] ?? {};
    const resolved = { ...base, ...(override as Record<string, unknown>) };
    delete resolved.intentional;
    return resolved;
  };

  /**
   * Lanes whose only surviving assertion is `outcome`, and why.
   *
   * `outcome` alone says "the client consumed the stream", which every fixture
   * that is not about rejection asserts by construction — so a fixture holding
   * nothing else is a fixture that would still pass if the behaviour it is
   * named for disappeared. These entries are the corpus's real vacuities, kept
   * as named exemptions rather than left invisible, and the stale-pin check
   * below deletes the entry for you the moment it stops applying.
   */
  const OUTCOME_ONLY: Record<string, string> = {
    // Empty, and worth keeping empty. The four entries that used to live here —
    // the three `state-*` snapshot fixtures and
    // `reasoning-message-wrong-role-fatal`, all on the .NET lane — were closed
    // by giving each an `eventTypes`/`eventPaths` assertion both lanes can see,
    // not by relaxing anything.
    //
    // Read that as narrowly as it is written: what it says is that no lane is
    // left asserting `outcome` alone. It does not say every lane observes the
    // whole of what its fixture is named for. The three `state-*` fixtures are
    // the case to know about: their .NET `eventPaths` (`"2.snapshot"` = `0`,
    // `null`, `["only-this"]`) prove that lane delivers the raw snapshot value
    // verbatim — falsy, null and array alike — which is a real behaviour and
    // the one the payload half of each name refers to. The REDUCTION those
    // fixtures also name, `state` after the second snapshot, is what each
    // `kill` changes, and the .NET lane cannot see it: `UNIMPLEMENTED.dotnet`
    // above lists `state` because that client keeps none. So applying any of
    // those three kills reddens the TypeScript lane only. That is a gap in the
    // .NET client, recorded there, not a fixture to weaken.
  };

  /**
   * Lanes that expect a failure without saying which failure, and why.
   *
   * `outcome: "failed"` is satisfied by ANY rejection, so a fixture that only
   * says "failed" passes when the client starts rejecting the stream for an
   * unrelated reason — which is how a fatal-path fixture turns into a
   * tautology. `errorContains` or `runError` is what ties the rejection to the
   * rule under test.
   */
  const FAILURE_WITHOUT_REASON: Record<string, string> = {
    // Empty: the one entry that lived here — `unknown-outcome-stripped` on the
    // .NET lane — now pins the outcome converter's own JsonException text in
    // `expectOverrides.dotnet.errorContains`.
  };

  it.each(fixtures)("$file asserts something", ({ file, fixture }) => {
    const base = (fixture.expect ?? {}) as Record<string, unknown>;
    expect(
      effectiveKeys(base),
      "expect must contain at least one assertion that actually constrains something",
    ).not.toEqual([]);

    // And so must EVERY lane, whether or not it has an override: a lane that
    // skips a key it does not implement can be left asserting nothing even
    // when the base looks well populated.
    for (const lane of LANES) {
      const resolved = resolvedFor(fixture, lane);
      const effective = effectiveKeys(resolved, lane);
      expect(
        effective,
        `on the ${lane} lane this fixture asserts nothing`,
      ).not.toEqual([]);

      // `outcome` is not on its own an assertion about the behaviour a fixture
      // is named for: every fixture has one, and "the stream was consumed" is
      // the default. Requiring a second effective key is what makes the
      // vacuity check able to fail at all.
      const beyondOutcome = effective.filter((key) => key !== "outcome");
      const exemption = OUTCOME_ONLY[`${file}:${lane}`];
      if (exemption === undefined) {
        expect(
          beyondOutcome,
          `on the ${lane} lane this fixture asserts only \`outcome\` — which every fixture ` +
            `asserts. Add a key that observes the behaviour it is named for, or, if this lane ` +
            `genuinely cannot observe it, add an OUTCOME_ONLY entry saying so.`,
        ).not.toEqual([]);
      } else {
        expect(
          beyondOutcome,
          `${file}:${lane} is listed in OUTCOME_ONLY (${exemption}) but now asserts ` +
            `${beyondOutcome.join(", ")} — delete the entry.`,
        ).toEqual([]);
      }
    }
  });

  it.each(fixtures)("$file says why any expected failure failed", ({
    file,
    fixture,
  }) => {
    for (const lane of LANES) {
      const resolved = resolvedFor(fixture, lane);
      // The RESOLVED outcome, not the base one: the README sanctions
      // `errorContains: ""` as the way an override lifts a base requirement,
      // and a lane an override resolves to `completed` has no rejection to
      // describe. Reading the base here would demand a reason from exactly the
      // lanes that cannot give one.
      if (resolved.outcome !== "failed") continue;
      const said =
        isEffective("errorContains", resolved.errorContains) ||
        isEffective("runError", resolved.runError);
      const exemption = FAILURE_WITHOUT_REASON[`${file}:${lane}`];
      if (exemption === undefined) {
        expect(
          said,
          `on the ${lane} lane this fixture expects a failure without naming it. ` +
            `\`outcome: "failed"\` is satisfied by any rejection, so add \`errorContains\` ` +
            `(or \`runError\`) to tie the failure to the rule under test — or a ` +
            `FAILURE_WITHOUT_REASON entry if the message genuinely cannot be pinned.`,
        ).toBe(true);
      } else {
        expect(
          said,
          `${file}:${lane} is listed in FAILURE_WITHOUT_REASON (${exemption}) but now names ` +
            `its failure — delete the entry.`,
        ).toBe(false);
      }
    }
  });

  it("keeps no stale vacuity exemption", () => {
    // A renamed or deleted fixture must not leave an exemption behind that
    // would silently apply to nothing — or, worse, to a future fixture that
    // reuses the name.
    const addresses = new Set(
      fixtures.flatMap(({ file }) => LANES.map((lane) => `${file}:${lane}`)),
    );
    for (const list of [OUTCOME_ONLY, FAILURE_WITHOUT_REASON]) {
      expect(
        Object.keys(list).filter((key) => !addresses.has(key)),
        "exemption names a fixture:lane that does not exist",
      ).toEqual([]);
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
    ["a malformed sequence is rejected", "content-without-start-fatal"],
    ["the 0.0.39 era shim has a fixture", "era-0-0-39-flattens-content"],
    // One entry, not two: this fixture used to be listed twice, once as "a
    // retired event is translated, not dropped" and once as "retired
    // THINKING_* shapes are translated by something", which read as two
    // behaviours covered while protecting one file — so a green count said
    // more than it knew. Deliberately NOT "the 0.0.45 shim has a fixture": it
    // cannot have one, because the always-on compatibility boundary translates
    // every THINKING_* shape that shim handles, and runs innermost, so the
    // shim never sees one in the shipped pipeline. Measured — disabling either
    // translator alone leaves the fixture green; only disabling both fails it.
    // What the fixture holds is the retired shapes' translation, wherever it
    // happens.
    [
      "a retired event is translated by something, not dropped",
      "era-0-0-45-thinking-translated",
    ],
    ["the 0.0.47 era shim has a fixture", "era-0-0-47-upgrades-binary-content"],
    // Also formerly listed twice, as "a downgrade that loses content warns"
    // and as "the 0.0.57 era shim has a fixture". Same file, same protection.
    [
      "the 0.0.57 era shim has a fixture, and a downgrade that loses content warns",
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
    // The RUN_ERROR contract, in three fixtures: the event is DELIVERED and the
    // stream carries on. It is admitted as the first event, admitted after a
    // RUN_FINISHED, and a RUN_STARTED after it begins a new run in the same
    // stream. Naming all three here is what makes ending the stream at
    // RUN_ERROR — the shape that reads plausible every time someone meets this
    // code — a rename someone has to make on purpose.
    ["a stream may open with RUN_ERROR, and the run continues", "run-error-first-run-continues"],
    [
      "RUN_ERROR after RUN_FINISHED is delivered, and the run continues",
      "late-run-error-after-finished-run-continues",
    ],
    [
      "a RUN_STARTED after a RUN_ERROR begins a new run in the same stream",
      "run-error-then-new-run-continues",
    ],
    // `reasoning-discipline-verified` stopped being an admitted gap and became
    // asserted behaviour — it was a fixture pinning what the client DID, and
    // flipping it back is now a deliberate rename that fails here rather than a
    // quiet regression — plus `unknown-outcome-array-fatal`, which was never an
    // admitted gap and has asserted the rule from the start. It sits here
    // because it belongs to the same processing rule, not because it was ever
    // an admission.
    ["reasoning messages are bracketed like any other", "reasoning-discipline-verified"],
    [
      "a malformed value in the outcome slot is fatal, not stripped",
      "unknown-outcome-array-fatal",
    ],
  ];

  it("names each required behaviour once, and each fixture once", () => {
    // The list is read as a census of what the corpus protects, so a fixture
    // appearing twice inflates that census: twelve entries covering ten files
    // read as twelve behaviours held.
    const behaviours = required.map(([behaviour]) => behaviour);
    expect(new Set(behaviours).size, "duplicate behaviour text").toBe(
      behaviours.length,
    );
    const names = required.map(([, name]) => name);
    expect(
      names.filter((name, index) => names.indexOf(name) !== index),
      "a fixture is listed under more than one behaviour — merge the entries",
    ).toEqual([]);
  });

  it.each(required)("still covers: %s", (_behaviour, fixtureName) => {
    expect(files).toContain(`${fixtureName}.json`);
  });

  it("matches the committed manifest", () => {
    // `toBeGreaterThan(0)` was the only pressure on the corpus's size, and it
    // is satisfied by one fixture: deleting sixty of the sixty-four would have
    // left this suite green. A committed listing makes a shrinking corpus a
    // diff — asserted in BOTH directions, so an added fixture missing from the
    // manifest fails too, and the editor has to say what they meant.
    const manifest = readFileSync(join(STREAMS_DIR, "MANIFEST.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(
      manifest,
      "spec/draft/conformance/streams/MANIFEST.txt is out of date. If you added or removed a " +
        "fixture, regenerate it in the same commit (the command is in the file's header) and " +
        "say so in the message; if you did not, a fixture has gone missing.",
    ).toEqual(files);
  });

  it("names every fixture uniquely", () => {
    const names = fixtures.map(({ fixture }) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
