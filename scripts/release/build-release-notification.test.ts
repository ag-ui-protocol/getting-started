import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseNotification } from "./lib/build-release-notification";
import type { BuildReleaseNotificationInput } from "./lib/build-release-notification";

const RUN_URL = "https://github.com/ag-ui-protocol/ag-ui/actions/runs/123";
const NPM_ORG_URL = "https://www.npmjs.com/org/ag-ui";
const PY_BASE_URL = "https://pypi.org/project";
const NUGET_BASE_URL = "https://www.nuget.org/packages";
const MAVEN_BASE_URL = "https://central.sonatype.com/artifact";

// A neutral baseline where nothing has acted. Each test overrides only the
// fields relevant to its truth-table row.
function base(
  overrides: Partial<BuildReleaseNotificationInput> = {},
): BuildReleaseNotificationInput {
  return {
    mode: "",
    npmResult: "skipped",
    buildResult: "skipped",
    npmIntended: "false",
    tsPackages: [],
    tsGroups: {},
    pyIntended: "false",
    pyResult: "skipped",
    pyBuildResult: "skipped",
    pyPackages: [],
    nugetIntended: "false",
    nugetResult: "skipped",
    nugetBuildResult: "skipped",
    nugetPackages: [],
    mavenIntended: "false",
    mavenResult: "skipped",
    mavenBuildResult: "skipped",
    mavenPackages: [],
    scope: "",
    dryRun: false,
    runUrl: RUN_URL,
    npmOrgUrl: NPM_ORG_URL,
    pyBaseUrl: PY_BASE_URL,
    nugetBaseUrl: NUGET_BASE_URL,
    mavenBaseUrl: MAVEN_BASE_URL,
    ...overrides,
  };
}

// Convenience builders for the published-package sets.
function ts(...names: string[]): { name: string; version: string }[] {
  return names.map((name) => ({ name, version: "0.0.41" }));
}
function py(...names: string[]): { name: string; version: string }[] {
  return names.map((name) => ({ name, version: "0.0.11" }));
}
function nuget(...names: string[]): { name: string; version: string }[] {
  return names.map((name) => ({ name, version: "0.0.1" }));
}
function maven(...names: string[]): { name: string; version: string }[] {
  return names.map((name) => ({ name, version: "0.1.0" }));
}

// ---- dry-run ----------------------------------------------------------------
test("suppresses dry-run — no post", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
      dryRun: true,
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- npm lane: prerelease canary fully suppressed ---------------------------
test("suppresses prerelease (canary) success — no post", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { canary: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("suppresses prerelease (canary) npm failure — no post", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "success",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("suppresses prerelease (canary) build failure — no post (would otherwise fire)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      npmIntended: "true",
      npmResult: "skipped",
      buildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("suppresses prerelease (canary) PyPI success — no post (both lanes suppressed)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("suppresses prerelease (canary) PyPI failure — no post (both lanes suppressed)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      pyIntended: "true",
      pyResult: "failure",
      pyBuildResult: "success",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("suppresses prerelease (canary) NuGet failure — no post", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      nugetIntended: "true",
      nugetResult: "failure",
      nugetBuildResult: "success",
      nugetPackages: nuget("AGUI.Client"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- npm lane: stable success -----------------------------------------------
test("stable npm success → concise npm success line (N packages + names + dist-tag)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core", "@ag-ui/client"),
      tsGroups: { latest: ["@ag-ui/core", "@ag-ui/client"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    "🚀 *ag-ui release* · 2 npm packages published " +
      "(`latest`: @ag-ui/core, @ag-ui/client) · " +
      `<${NPM_ORG_URL}|npm>`,
  );
});

test("single npm package → '1 npm package' (pluralization)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /1 npm package /);
  assert.ok(!/1 npm packages/.test(r.message));
});

test("npm dist-tags other than latest are rendered (alpha)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: [{ name: "@ag-ui/core", version: "1.0.0-alpha.0" }],
      tsGroups: { alpha: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /`alpha`: @ag-ui\/core/);
});

test("npm success with multiple dist-tag groups → all groups rendered", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: [
        { name: "@ag-ui/core", version: "1.0.0" },
        { name: "@ag-ui/client", version: "1.0.0-beta.0" },
      ],
      tsGroups: { latest: ["@ag-ui/core"], beta: ["@ag-ui/client"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /`latest`: @ag-ui\/core/);
  assert.match(r.message, /`beta`: @ag-ui\/client/);
  assert.match(r.message, /2 npm packages published/);
});

// ---- npm lane: count/name agreement (FIX 3) ---------------------------------
test("populated tsPackages + EMPTY tsGroups → flat name list (no dist-tag backticks)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core", "@ag-ui/client"),
      tsGroups: {},
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /2 npm packages published/);
  assert.match(r.message, /@ag-ui\/core, @ag-ui\/client/);
  // Flat list: no dist-tag rendering (no backtick-wrapped tag labels).
  assert.ok(!r.message.includes("`"));
});

test("tsGroups membership MISMATCHES tsPackages → falls back to flat list (count and names agree)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      // Three packages published...
      tsPackages: ts("@ag-ui/core", "@ag-ui/client", "@ag-ui/encoder"),
      // ...but the groups dropped one (degraded ts_groups_json). Count (3) from
      // tsPackages would disagree with names (2) from tsGroups — must fall back.
      tsGroups: { latest: ["@ag-ui/core", "@ag-ui/client"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /3 npm packages published/);
  // Flat fallback lists all three published names (count and names agree).
  assert.match(r.message, /@ag-ui\/core, @ag-ui\/client, @ag-ui\/encoder/);
  // Degraded groups are NOT rendered as dist-tag groups.
  assert.ok(!r.message.includes("`latest`"));
});

test("tsGroups listing a name NOT in tsPackages → falls back to flat list", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      // Group lists a phantom name absent from tsPackages → membership mismatch.
      tsGroups: { latest: ["@ag-ui/core", "@ag-ui/phantom"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /1 npm package published/);
  assert.ok(!r.message.includes("@ag-ui/phantom"));
  assert.ok(!r.message.includes("`latest`"));
});

test("tsGroups with an EMPTY group array → falls back to flat list (no empty `tag`: fragment)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      // An empty-array group renders no names; total grouped count (1) still
      // matches tsPackages.length (1) AND membership matches, but the empty
      // group must never produce a malformed "`beta`: " fragment. The skip in
      // renderNpmGroups drops it; here we additionally assert no empty fragment.
      tsGroups: { latest: ["@ag-ui/core"], beta: [] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /1 npm package published/);
  // No malformed empty dist-tag fragment for the empty `beta` group.
  // renderNpmGroups structurally filters out empty groups, so the absence of
  // any "`beta`" substring fully covers it (a separate "`beta`:" regex would be
  // always-true here and imply coverage it cannot provide).
  assert.ok(!r.message.includes("`beta`"));
});

test("tsGroups with a name duplicated across two groups → falls back to flat list (count/name agreement)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      // One published package...
      tsPackages: ts("@ag-ui/core"),
      // ...but it appears in TWO groups: deduped Set size (1) would match the
      // package set, yet the TOTAL grouped count (2) disagrees with the count
      // (1) from tsPackages. Must fall back to the flat list.
      tsGroups: { latest: ["@ag-ui/core"], next: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /1 npm package published/);
  // Flat fallback: no dist-tag grouping rendered, name listed exactly once.
  assert.ok(!r.message.includes("`latest`"));
  assert.ok(!r.message.includes("`next`"));
  assert.equal(r.message.split("@ag-ui/core").length - 1, 1);
});

// ---- npm lane: failure (lane-level wording) ---------------------------------
test("stable npm failure → lane-level red alert (NOT 'npm publish failed')", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "success",
      // Detected package set is the authoritative "release attempted" signal:
      // build succeeded and packages were detected, then publish failed.
      tsPackages: ts("@ag-ui/core"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
  assert.ok(!r.message.includes("publish failed"));
});

test("npm result failure beats a populated package set → FAILURE line, NOT success (if/else ordering)", () => {
  // A populated tsPackages set does NOT force a success line: the publish job
  // can have packages yet end in `failure` (e.g. a later tag/release step
  // broke). The success arm requires npmResult === "success".
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
  assert.ok(!r.message.includes("🚀"));
  assert.ok(!r.message.includes("published"));
});

test("build failure (mode='', npm skipped) → lane-level npm/build red alert", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      npmIntended: "true",
      npmResult: "skipped",
      buildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
  assert.ok(!r.message.includes("publish failed"));
});

test("npm publish failure with empty mode → lane-level red alert (no mode-coupling swallow)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "success",
      // Packages were detected (build OK) then publish failed → authoritative.
      tsPackages: ts("@ag-ui/core"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
});

// ---- npm lane: EVENT-DERIVED intent gate ------------------------------------
test("npmIntended='true' + buildResult='failure' → npm red ALERT (intent gate open)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      npmIntended: "true",
      npmResult: "skipped",
      buildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
});

test("npmIntended='false' + buildResult='failure' → NEUTRAL (no npm release attempted)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      npmIntended: "false",
      npmResult: "skipped",
      buildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- FIX 1: failure arms gate on the DETECTED PACKAGE SET -------------------
// The detected package set (tsPackages/pyPackages) is the authoritative "this
// lane actually attempted a release" signal. Intent (compare-range) is only the
// build-failure fallback.

test("dependabot-style: build+publish success, NO detected npm packages, npmIntended true → NO npm line (no false positive)", () => {
  // A dependabot dependency bump touches package.json without bumping the
  // package's OWN version. Intent (manifest touched) is true, but the build
  // detected no published packages. With a successful build there is nothing to
  // page about → the lane stays quiet.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: [],
      npmIntended: "true",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("early build failure on an intended npm release (no detected packages yet) → npm failure line (fail toward paging)", () => {
  // The build FAILED before detection could populate tsPackages. The
  // event-derived npmIntended is the fallback that keeps an early build failure
  // on a genuine release from being swallowed.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      buildResult: "failure",
      npmResult: "skipped",
      tsPackages: [],
      npmIntended: "true",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
});

test("detected npm packages + publish failure with npmIntended FALSE → npm failure line (detected set is authoritative)", () => {
  // The detected package set pages on its own failure REGARDLESS of intent: the
  // build succeeded and detected packages, then the publish job failed. Intent
  // for this lane is false (e.g. the push touched only the other ecosystem),
  // yet the real publish failure must still page.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "failure",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      npmIntended: "false",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>`,
  );
});

test("cross-lane stale PyPI bump: detected py packages + publish failure, pyIntended FALSE → PyPI failure line (closes the silent-swallow)", () => {
  // detect_py diffs LOCAL manifests against the REGISTRY, so a push that only
  // touched package.json can still re-detect a STALE unpublished PyPI bump from
  // a prior failed release. The compare-range intent for the PyPI lane is
  // false. Under the old intent-only gate that real publish failure was
  // SILENTLY SWALLOWED; gating on the detected set closes it.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      pyResult: "failure",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
      pyIntended: "false",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui PyPI release failed* · <${RUN_URL}|View run>`,
  );
});

test("build succeeded, NO detected PyPI packages, pyIntended true → NO PyPI line (no false positive)", () => {
  // Symmetric with the dependabot npm case: a successful build that detected no
  // PyPI packages does not page even though intent is true.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: [],
      pyIntended: "true",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- PyPI lane: stable success (mode-gated, symmetric with npm) -------------
test("PyPI success → only PyPI line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    "🐍 *ag-ui release* · 1 PyPI package published (ag-ui-protocol) · " +
      `<${PY_BASE_URL}/ag-ui-protocol/|PyPI>`,
  );
});

test("PyPI success with multiple packages → count + names + org-style link to flagship", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol", "ag-ui-langgraph"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /2 PyPI packages published/);
  assert.match(r.message, /ag-ui-protocol, ag-ui-langgraph/);
});

test("PyPI flagship link targets ag-ui-protocol even when it is NOT first in pyPackages", () => {
  const r = buildReleaseNotification(
    base({
      pyResult: "success",
      pyBuildResult: "success",
      mode: "stable",
      // ag-ui-protocol is deliberately NOT at index 0 — nothing sorts
      // pyPackages, so the flagship must be selected explicitly by name.
      pyPackages: py("ag-ui-langgraph", "ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /2 PyPI packages published/);
  // The link target is the flagship project page, ag-ui-protocol.
  assert.match(
    r.message,
    /<https:\/\/pypi\.org\/project\/ag-ui-protocol\/\|PyPI>/,
  );
});

test("PyPI flagship falls back to first package when ag-ui-protocol absent", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-langgraph", "ag-ui-mastra"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(
    r.message,
    /<https:\/\/pypi\.org\/project\/ag-ui-langgraph\/\|PyPI>/,
  );
});

test("PyPI failure → lane-level PyPI red alert", () => {
  const r = buildReleaseNotification(
    base({
      pyIntended: "true",
      pyResult: "failure",
      pyBuildResult: "success",
      // Build OK + packages detected, then publish failed → authoritative.
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui PyPI release failed* · <${RUN_URL}|View run>`,
  );
});

test("build-python failure during a REAL Python release (publish skipped) → PyPI red alert", () => {
  const r = buildReleaseNotification(
    base({
      pyIntended: "true",
      pyResult: "skipped",
      pyBuildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui PyPI release failed* · <${RUN_URL}|View run>`,
  );
});

test("build-python CANCELLED during a real Python release → NEUTRAL (no false red on deliberate cancel)", () => {
  const r = buildReleaseNotification(
    base({
      pyIntended: "true",
      pyResult: "skipped",
      pyBuildResult: "cancelled",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("build-python failure WITHOUT intent → NO post (routine PR flake)", () => {
  const r = buildReleaseNotification(
    base({
      pyIntended: "false",
      pyResult: "skipped",
      pyBuildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- NuGet lane: stable success/failure -------------------------------------
test("NuGet success → count + names + link to first package", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      nugetResult: "success",
      nugetBuildResult: "success",
      nugetPackages: nuget("AGUI.Client", "AGUI.Server"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    "📦 *ag-ui release* · 2 NuGet packages published (AGUI.Client, AGUI.Server) · " +
      `<${NUGET_BASE_URL}/AGUI.Client/|NuGet>`,
  );
});

test("NuGet success links to first package for a single-package publish", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      nugetResult: "success",
      nugetBuildResult: "success",
      nugetPackages: nuget("AGUI.Client"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /1 NuGet package published/);
  assert.match(
    r.message,
    /<https:\/\/www\.nuget\.org\/packages\/AGUI\.Client\/\|NuGet>/,
  );
});

test("NuGet publish failure with detected packages → lane-level red alert", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      nugetIntended: "false",
      nugetResult: "failure",
      nugetBuildResult: "success",
      nugetPackages: nuget("AGUI.Client"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui NuGet release failed* · <${RUN_URL}|View run>`,
  );
});

test("early build failure on intended NuGet release → NuGet failure line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      nugetIntended: "true",
      nugetResult: "skipped",
      nugetBuildResult: "failure",
      nugetPackages: [],
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui NuGet release failed* · <${RUN_URL}|View run>`,
  );
});

test("python release intended (pyIntended='true', pyBuildResult='failure') → PyPI red ALERT", () => {
  const r = buildReleaseNotification(
    base({
      pyIntended: "true",
      pyResult: "skipped",
      pyBuildResult: "failure",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui PyPI release failed* · <${RUN_URL}|View run>`,
  );
});

// ---- prerelease + both lanes ------------------------------------------------
test("prerelease + BOTH lanes failing → NO post (canary fully suppressed, both lanes)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "failure",
      pyIntended: "true",
      pyResult: "failure",
      pyBuildResult: "success",
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("prerelease + python success → NO post (canary fully suppressed, both lanes)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { canary: ["@ag-ui/core"] },
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- cancelled is NEUTRAL everywhere ----------------------------------------
test("npm cancelled (mode=stable) → no line (neutral, no false red)", () => {
  const r = buildReleaseNotification(
    base({ mode: "stable", npmResult: "cancelled", buildResult: "success" }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("build cancelled → no line (neutral)", () => {
  const r = buildReleaseNotification(
    base({ mode: "", npmResult: "skipped", buildResult: "cancelled" }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("PyPI cancelled → no line (neutral)", () => {
  const r = buildReleaseNotification(
    base({ pyResult: "cancelled", pyBuildResult: "success" }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- skipped lanes contribute nothing ---------------------------------------
test("python-only run (npm lane skipped) → only PyPI line, NO false red", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "skipped",
      buildResult: "skipped",
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.ok(!r.message.includes("🔴"));
  assert.match(r.message, /🐍/);
});

test("npm-only run (PyPI lane not acting) → only npm line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
      pyResult: "skipped",
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /🚀/);
  assert.ok(!r.message.includes("🐍"));
  assert.ok(!r.message.includes("🔴"));
});

// ---- both lanes -------------------------------------------------------------
test("both lanes succeed → one message with both lines", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core", "@ag-ui/client"),
      tsGroups: { latest: ["@ag-ui/core", "@ag-ui/client"] },
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  const expected =
    "🚀 *ag-ui release* · 2 npm packages published " +
    "(`latest`: @ag-ui/core, @ag-ui/client) · " +
    `<${NPM_ORG_URL}|npm>\n` +
    "🐍 *ag-ui release* · 1 PyPI package published (ag-ui-protocol) · " +
    `<${PY_BASE_URL}/ag-ui-protocol/|PyPI>`;
  assert.equal(r.message, expected);
});

test("both lanes fail → one message with both lane-level red lines", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmIntended: "true",
      npmResult: "failure",
      buildResult: "success",
      // Both lanes detected packages (build OK) then the shared publish failed.
      tsPackages: ts("@ag-ui/core"),
      pyIntended: "true",
      pyResult: "failure",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui npm release failed* · <${RUN_URL}|View run>\n` +
      `🔴 *ag-ui PyPI release failed* · <${RUN_URL}|View run>`,
  );
});

// ---- nothing acted ----------------------------------------------------------
test("nothing acted (npm skipped, PyPI not publishing) → no post, empty message", () => {
  const r = buildReleaseNotification(base());
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- no-false-success guards ------------------------------------------------
test("stable npm success with EMPTY package set → no npm success line (no false success)", () => {
  // npmResult=success but no published packages is an anomalous state — do not
  // claim success. With buildResult=success there is also no failure to report.
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: [],
      tsGroups: {},
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("PyPI success with EMPTY package set → no PyPI success line (no false success)", () => {
  const r = buildReleaseNotification(
    base({ pyResult: "success", pyBuildResult: "success", pyPackages: [] }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("npm success but mode not stable (defensive) → no npm success line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

// ---- name-list truncation (keep the message concise) ------------------------
test("npm success with many packages → name list truncates with '+N more'", () => {
  const names = [
    "@ag-ui/core",
    "@ag-ui/client",
    "@ag-ui/encoder",
    "@ag-ui/proto",
    "create-ag-ui-app",
    "@ag-ui/langgraph",
    "@ag-ui/mastra",
  ];
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: names.map((name) => ({ name, version: "1.0.0" })),
      tsGroups: { latest: names },
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /7 npm packages published/);
  // Concise: do not dump all 7 names; cap and summarize the remainder.
  assert.match(r.message, /\+\d+ more/);
});

// ---------------------------------------------------------------------------
// Maven Central lane. Mirrors the NuGet lane rows — the Maven lane is a fourth
// INDEPENDENT lane with the same success/failure/neutral truth table.
// ---------------------------------------------------------------------------

test("Maven success renders count, names and a Maven Central link", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenResult: "success",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core", "java-client", "java-server"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.match(r.message, /3 Maven packages published/);
  assert.match(r.message, /java-core, java-client, java-server/);
  assert.match(
    r.message,
    /<https:\/\/central\.sonatype\.com\/artifact\/com\.ag-ui\.community\/java-core\|Maven Central>/,
  );
});

test("Maven success with EMPTY package set → no Maven success line (no false success)", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenResult: "success",
      mavenBuildResult: "success",
      mavenPackages: [],
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("Maven success but mode not stable (defensive) → no Maven success line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "",
      mavenResult: "success",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("Maven publish failure with detected packages → lane-level red alert", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenIntended: "false",
      mavenResult: "failure",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui Maven Central release failed* · <${RUN_URL}|View run>`,
  );
});

test("early build failure on intended Maven release → Maven failure line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenIntended: "true",
      mavenResult: "skipped",
      mavenBuildResult: "failure",
      mavenPackages: [],
    }),
  );
  assert.equal(r.shouldPost, true);
  assert.equal(
    r.message,
    `🔴 *ag-ui Maven Central release failed* · <${RUN_URL}|View run>`,
  );
});

test("build failure with NO Maven intent and no detected packages → Maven lane silent", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenIntended: "false",
      mavenResult: "skipped",
      mavenBuildResult: "failure",
      mavenPackages: [],
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("cancelled Maven lane is neutral — never a failure line", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      mavenIntended: "true",
      mavenResult: "cancelled",
      mavenBuildResult: "cancelled",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("canary (prerelease) fully suppresses the Maven lane", () => {
  const r = buildReleaseNotification(
    base({
      mode: "prerelease",
      mavenIntended: "true",
      mavenResult: "failure",
      mavenBuildResult: "failure",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("dry-run suppresses the Maven lane", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      dryRun: true,
      mavenResult: "success",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, false);
  assert.equal(r.message, "");
});

test("all four lanes can succeed together — one line each, Maven last", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
      pyResult: "success",
      pyBuildResult: "success",
      pyPackages: py("ag-ui-protocol"),
      nugetResult: "success",
      nugetBuildResult: "success",
      nugetPackages: nuget("AGUI.Client"),
      mavenResult: "success",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, true);
  const lines = r.message.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /npm package published/);
  assert.match(lines[1], /PyPI package published/);
  assert.match(lines[2], /NuGet package published/);
  assert.match(lines[3], /Maven package published/);
});

test("a Maven-only failure does not red the other lanes", () => {
  const r = buildReleaseNotification(
    base({
      mode: "stable",
      npmResult: "success",
      buildResult: "success",
      tsPackages: ts("@ag-ui/core"),
      tsGroups: { latest: ["@ag-ui/core"] },
      mavenIntended: "true",
      mavenResult: "failure",
      mavenBuildResult: "success",
      mavenPackages: maven("java-core"),
    }),
  );
  assert.equal(r.shouldPost, true);
  const lines = r.message.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /npm package published/);
  assert.equal(
    lines[1],
    `🔴 *ag-ui Maven Central release failed* · <${RUN_URL}|View run>`,
  );
});
