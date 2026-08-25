#!/usr/bin/env -S pnpm tsx
/**
 * CLI wrapper for the post-release #engr Slack notification builder.
 *
 * Thin glue around the pure buildReleaseNotification() function in
 * ./lib/build-release-notification.ts. The truth-table logic lives (and is
 * unit-tested) there; this file only:
 *   1. reads the release signals from env vars (set by the notify job from
 *      needs.build.outputs / needs.publish.* results + workflow inputs +
 *      the event-derived intent step),
 *   2. parses the JSON package/group arrays defensively (a cosmetic parse
 *      failure must never suppress a real alert),
 *   3. calls the pure builder, and
 *   4. writes `message=` and `should_post=` to GITHUB_OUTPUT.
 *
 * Env vars (all optional; absent → empty string / empty set):
 *   MODE             needs.build.outputs.mode            ("stable" | "prerelease" | "")
 *   NPM_RESULT       needs.publish.result                (shared publish job result)
 *   BUILD_RESULT     needs.build.result                  (shared build job result)
 *   NPM_INTENDED     notify-job event-derived npm release intent ("true" | ...)
 *   TS_PACKAGES      needs.build.outputs.ts_packages     (JSON [{name,version,path}])
 *   TS_GROUPS        needs.build.outputs.ts_groups_json  (JSON {tag: [name,...]})
 *   PY_INTENDED      notify-job event-derived Python release intent ("true" | ...)
 *   PY_RESULT        needs.publish.result                (SAME value as NPM_RESULT)
 *   PY_BUILD_RESULT  needs.build.result                  (SAME value as BUILD_RESULT)
 *   PY_PACKAGES      needs.build.outputs.py_packages     (JSON [{name,version,dir}])
 *   NUGET_INTENDED   notify-job event-derived NuGet release intent ("true" | ...)
 *   NUGET_RESULT     needs.publish-dotnet.result
 *   NUGET_BUILD_RESULT needs.build.result
 *   NUGET_PACKAGES   needs.build.outputs.dotnet_packages (JSON [{name,version,path}])
 *   MAVEN_INTENDED   notify-job event-derived Maven Central release intent ("true" | ...)
 *   MAVEN_RESULT     needs.publish-maven.result
 *   MAVEN_BUILD_RESULT needs.build.result
 *   MAVEN_PACKAGES   needs.build.outputs.java_packages   (JSON [{name,version,path,groupId}])
 *
 *   NOTE: ag-ui runs ONE shared build job and ONE shared publish job spanning
 *   BOTH lanes. The workflow wires BOTH BUILD_RESULT and PY_BUILD_RESULT to the
 *   SAME needs.build.result, and BOTH NPM_RESULT and PY_RESULT to the SAME
 *   needs.publish.result. These are NOT distinct per-lane signals. Lane
 *   attribution comes from the detected package SETS (TS_PACKAGES vs
 *   PY_PACKAGES) + the per-lane intent gates, NOT from distinct per-lane
 *   build/publish results (see the lib interface doc, which says the same).
 *   SCOPE            needs.build.outputs.scope
 *   DRY_RUN          inputs.dry_run                      ("true" | "false" | "")
 *   RUN_URL          this workflow run URL
 *   NPM_ORG_URL      npm org page URL
 *   PY_BASE_URL      PyPI project base URL
 *   NUGET_BASE_URL   NuGet package base URL
 *   MAVEN_BASE_URL   Maven Central artifact base URL
 *
 * Usage: pnpm tsx scripts/release/build-release-notification.ts
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildReleaseNotification } from "./lib/build-release-notification";
import type {
  ReleaseMode,
  JobResult,
  PublishedPackage,
  DistTagGroups,
  BuildReleaseNotificationResult,
} from "./lib/build-release-notification";

function env(name: string): string {
  return process.env[name] ?? "";
}

const KNOWN_MODES: readonly ReleaseMode[] = ["stable", "prerelease", ""];

const KNOWN_JOB_RESULTS: readonly JobResult[] = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "",
];

/**
 * Validate a raw GitHub Actions job-result env value against the known
 * JobResult set, degrading LOUDLY to "failure" (page-on-uncertainty) on any
 * unrecognized value. RESULT values drive FAILURE-gating; an unknown result is
 * anomalous and must err toward PAGING. The failure arms are PACKAGE-SET-gated
 * (the detected ts_packages/py_packages set is the primary gate; intent is only
 * the build-failure fallback), so an unrecognized job-result value coerced to
 * "failure" is the fail-toward-paging direction. In practice GitHub only ever
 * emits success|failure|cancelled|skipped (plus "" when unset), so this
 * coercion branch is defensive and not normally reached.
 */
export function resolveJobResultSafe(raw: string): JobResult {
  if ((KNOWN_JOB_RESULTS as readonly string[]).includes(raw)) {
    return raw as JobResult;
  }
  console.warn(
    `::warning::resolveJobResultSafe: unrecognized job result "${raw}" (expected one of: success, failure, cancelled, skipped, or empty) — coercing to "failure" (page-on-uncertainty; the intent gates ensure this only pages on a real release).`,
  );
  return "failure";
}

/**
 * Validate the raw MODE env value, degrading LOUDLY to "" (neutral "npm lane
 * did not run") on any unrecognized value. MODE drives the npm SUCCESS-gating;
 * degrading a typo to "stable" would FALSELY claim a publish, so MODE degrades
 * to "" — never inventing a success. This does NOT swallow failures: the
 * npm-failure arm keys off the event-derived intent + job RESULTS.
 */
export function resolveModeSafe(raw: string): ReleaseMode {
  if ((KNOWN_MODES as readonly string[]).includes(raw)) {
    return raw as ReleaseMode;
  }
  console.warn(
    `::warning::resolveModeSafe: unrecognized MODE "${raw}" (expected one of: stable, prerelease, or empty) — coercing to "" (treated as "npm lane did not run").`,
  );
  return "";
}

/**
 * Parse a JSON package array (ag-ui's ts_packages / py_packages output shape)
 * into a clean PublishedPackage[], degrading to [] on ANY error or malformed
 * entry. A cosmetic package set must NEVER throw and suppress a real alert.
 * Entries missing a string `name` are dropped; `version` defaults to "".
 */
export function parsePackagesSafe(raw: string): PublishedPackage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // A non-empty raw input that parses to a non-array (e.g. an object) would
      // otherwise silently yield no packages → no success line → no post, with
      // no diagnostic. Warn before degrading to [] (mirrors the catch branch).
      console.warn(
        "::warning::parsePackagesSafe: package set parsed to a non-array — rendering without it.",
      );
      return [];
    }
    const out: PublishedPackage[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        if (typeof o.name === "string" && o.name.length > 0) {
          out.push({
            name: o.name,
            version: typeof o.version === "string" ? o.version : "",
          });
        }
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `::warning::parsePackagesSafe: failed to parse package set — rendering without it. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/**
 * Parse the ts_groups_json dist-tag grouping object, degrading to {} on ANY
 * error or non-object shape. Only string→string[] entries are kept.
 */
export function parseGroupsSafe(raw: string): DistTagGroups {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // A non-empty raw input that parses to a non-object (e.g. an array or
      // null) would otherwise silently yield no grouping with no diagnostic.
      // Warn before degrading to {} (mirrors parsePackagesSafe's non-array
      // branch and the catch branch below).
      console.warn(
        "::warning::parseGroupsSafe: dist-tag groups parsed to a non-object — rendering without grouping.",
      );
      return {};
    }
    const out: DistTagGroups = {};
    for (const [tag, names] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (Array.isArray(names) && names.every((n) => typeof n === "string")) {
        out[tag] = names as string[];
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `::warning::parseGroupsSafe: failed to parse dist-tag groups — rendering without grouping. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}

/**
 * Serialize the builder result to a GITHUB_OUTPUT file using a per-write RANDOM
 * heredoc delimiter (GitHub's documented pattern), so message content can never
 * collide with / prematurely terminate the heredoc.
 */
export function writeGithubOutput(
  outputPath: string,
  result: BuildReleaseNotificationResult,
): void {
  const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
  // Build BOTH the message heredoc block AND the should_post line into a SINGLE
  // string and write them with ONE appendFileSync. A prior two-call form could
  // leave GITHUB_OUTPUT with `message` but no `should_post` if the second call
  // threw — the Post step's `should_post == 'true'` guard would then be false
  // and a real alert would silently vanish. One write keeps the pair atomic.
  const payload =
    `message<<${delimiter}\n${result.message}\n${delimiter}\n` +
    `should_post=${result.shouldPost}\n`;
  try {
    fs.appendFileSync(outputPath, payload);
  } catch (err) {
    // Fail LOUD: a notifier that cannot persist its outputs is broken, and
    // silently no-op'ing would swallow a real release alert. The ::error::
    // annotation + non-zero exit routes to the workflow self-watchdog.
    console.error(
      `::error::Failed to write should_post/message to GITHUB_OUTPUT — cannot emit the release notification. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }
}

function main(): void {
  const result = buildReleaseNotification({
    mode: resolveModeSafe(env("MODE")),
    npmResult: resolveJobResultSafe(env("NPM_RESULT")),
    buildResult: resolveJobResultSafe(env("BUILD_RESULT")),
    npmIntended: env("NPM_INTENDED"),
    tsPackages: parsePackagesSafe(env("TS_PACKAGES")),
    tsGroups: parseGroupsSafe(env("TS_GROUPS")),
    pyIntended: env("PY_INTENDED"),
    pyResult: resolveJobResultSafe(env("PY_RESULT")),
    pyBuildResult: resolveJobResultSafe(env("PY_BUILD_RESULT")),
    pyPackages: parsePackagesSafe(env("PY_PACKAGES")),
    nugetIntended: env("NUGET_INTENDED"),
    nugetResult: resolveJobResultSafe(env("NUGET_RESULT")),
    nugetBuildResult: resolveJobResultSafe(env("NUGET_BUILD_RESULT")),
    nugetPackages: parsePackagesSafe(env("NUGET_PACKAGES")),
    mavenIntended: env("MAVEN_INTENDED"),
    mavenResult: resolveJobResultSafe(env("MAVEN_RESULT")),
    mavenBuildResult: resolveJobResultSafe(env("MAVEN_BUILD_RESULT")),
    mavenPackages: parsePackagesSafe(env("MAVEN_PACKAGES")),
    scope: env("SCOPE"),
    dryRun: env("DRY_RUN") === "true",
    runUrl: env("RUN_URL"),
    npmOrgUrl: env("NPM_ORG_URL") || "https://www.npmjs.com/org/ag-ui",
    pyBaseUrl: env("PY_BASE_URL") || "https://pypi.org/project",
    nugetBaseUrl: env("NUGET_BASE_URL") || "https://www.nuget.org/packages",
    mavenBaseUrl:
      env("MAVEN_BASE_URL") || "https://central.sonatype.com/artifact",
  });

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    writeGithubOutput(outputPath, result);
  } else if (process.env.GITHUB_ACTIONS === "true") {
    // A status notifier that cannot write its should_post/message outputs is
    // broken: the Post step gates on those outputs, so silently no-op'ing would
    // swallow a real release alert. Fail loud under Actions.
    console.error(
      "::error::GITHUB_OUTPUT is unset under GitHub Actions — cannot emit should_post/message for the release notification.",
    );
    process.exit(1);
  }

  // Console echo (always useful in logs; the sole output channel for an
  // explicit local/no-Actions invocation).
  console.log(`should_post=${result.shouldPost}`);
  if (result.message) {
    console.log(`message:\n${result.message}`);
  }
}

// Only run when invoked directly as a CLI, not when imported by tests. Apply
// fs.realpathSync to BOTH sides so a symlinked checkout can't make main()
// silently not run. realpathSync THROWS (ENOENT) if argv[1] doesn't resolve on
// disk, which would crash before main() and swallow a real alert — so guard it
// with a path.resolve()-normalized compare on throw.
function isInvokedDirectly(): boolean {
  if (process.argv[1] == null) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(modulePath) === fs.realpathSync(process.argv[1]);
  } catch (err) {
    // ENOENT is the documented case: argv[1] (or the module path) does not
    // resolve on disk. For that, keep the weaker path.resolve() fallback.
    // For ANY OTHER error under GitHub Actions (e.g. EACCES, ELOOP), a wrong
    // `false` here would mean main() never runs → no $GITHUB_OUTPUT written →
    // the alert silently vanishes. Fail LOUD instead so the self-watchdog sees
    // it, rather than degrading to a compare that could also wrongly skip.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && process.env.GITHUB_ACTIONS === "true") {
      console.error(
        `::error::isInvokedDirectly: realpathSync failed (${
          err instanceof Error ? err.message : String(err)
        }) — cannot reliably determine direct invocation; refusing to silently skip the release notifier.`,
      );
      process.exit(1);
    }
    return path.resolve(modulePath) === path.resolve(process.argv[1]);
  }
}
if (isInvokedDirectly()) {
  main();
}
