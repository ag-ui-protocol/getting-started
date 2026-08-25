/**
 * Pure message-builder for the post-release #engr Slack notification.
 *
 * This is the load-bearing truth table for what (if anything) gets posted to
 * Slack after the publish-release.yml workflow runs. It is deliberately a PURE
 * function of its inputs so the full truth table can be unit-tested without any
 * GitHub Actions / network involvement. The thin CLI wrapper
 * (scripts/release/build-release-notification.ts) parses env vars, calls this
 * function, and writes the result to GITHUB_OUTPUT.
 *
 * Ported from CopilotKit's scripts/release/lib/build-release-notification.ts.
 * The truth table (suppression rules, lane independence, intent gating,
 * cancelled-is-neutral, page-on-uncertainty) is preserved verbatim in spirit;
 * the only divergence is the SUCCESS message shape. CopilotKit resolves a
 * package COUNT from release.config.json and renders one summary line; ag-ui
 * instead receives the actual published-package SETS from the build job's
 * registry-diff outputs (ts_packages + ts_groups_json for npm, py_packages for
 * PyPI), so the success line is rendered directly from those sets — count,
 * package names, and (for npm) dist-tag grouping — as ONE concise message per
 * lane, never one-per-package.
 *
 * Build/publish job topology — SINGLE SHARED JOBS (ag-ui divergence):
 *
 *   ag-ui runs ONE build job and ONE publish job spanning BOTH lanes. The
 *   workflow wires BUILD_RESULT and PY_BUILD_RESULT both to needs.build.result,
 *   and NPM_RESULT and PY_RESULT both to needs.publish.result. So the per-lane
 *   build-vs-publish-skip distinction from CopilotKit (which had separate
 *   build-python / publish-python jobs, where a build-stage failure skipped the
 *   matching publish job and produced a distinct per-lane signal) does NOT apply
 *   here — a build failure reds BOTH lanes' build signal, a publish failure reds
 *   BOTH lanes' publish signal. Lane attribution therefore comes from the
 *   published-package SETS (tsPackages vs pyPackages) — the AUTHORITATIVE
 *   "this lane actually attempted a release" signal — with the event-derived
 *   intent gates (npmIntended / pyIntended) used only as a BUILD-FAILURE
 *   FALLBACK (when the build failed before detection could populate the set),
 *   NOT from which job result is red.
 *   (CopilotKit lineage: the buildResult/pyBuildResult split that once let a
 *   single ecosystem's build failure page just that lane no longer applies.)
 *   KNOWN LIMITATION: because npm and PyPI share ONE publish job, a single-lane
 *   publish failure reds the shared result for BOTH lanes; if both lanes
 *   detected packages, both red lines may show (safe over-report). True
 *   per-lane attribution needs the publish job to emit per-lane outputs. The
 *   shared BUILD job has the SAME coupling: a build failure in one ecosystem's
 *   steps sets needs.build.result=failure for BOTH lanes, so a TS-only build
 *   failure can red the PyPI lane (and vice-versa) when the other lane also
 *   detected packages or was intended. Same safe over-report direction; true
 *   per-lane attribution needs the build job to emit per-lane results.
 *
 * Failure model — FOUR INDEPENDENT LANES (npm + PyPI + NuGet + Maven Central):
 *
 *   - dry-run → no post (entirely suppressed).
 *
 *   - canary (mode === "prerelease") → no post AT ALL, BOTH lanes (success AND
 *     failure). A canary run is fully suppressed: canaries are noise and we want
 *     exactly one concise message per stable release, never canary spam. This
 *     matches the npm-lane canary suppression and now extends it to the PyPI
 *     lane, so a canary PyPI publish-failure never pages while a canary success
 *     posts nothing — consistent silence on both lanes.
 *
 *   - npm lane (stable only — canary already short-circuited above):
 *       • SUCCESS line when mode==stable && npmResult==success && ≥1 published
 *         package. Rendered from tsPackages (count + names) grouped by dist-tag
 *         via tsGroups. An EMPTY published set is anomalous (success result but
 *         nothing published) and renders NO success line — never a false
 *         success.
 *       • FAILURE alert (lane-level, NOT step-level) when
 *         (npmResult==failure || buildResult==failure) AND (tsPackages.length>0
 *         OR (buildResult==failure && npmIntended)). PRIMARY gate is the
 *         detected package set (tsPackages) — the authoritative attempted-a-
 *         release signal; event-derived npmIntended is only the BUILD-FAILURE
 *         FALLBACK so an early build failure (before detection ran) on an
 *         intended release still pages. NOT additionally gated on mode==stable
 *         (which would swallow a real stable publish failure whose mode output
 *         came back empty). The publish step may have succeeded with a LATER
 *         tag/release step failing, so the wording is "release failed", never
 *         "publish failed".
 *
 *   - PyPI lane (stable only — canary already short-circuited above):
 *       • SUCCESS line when mode==stable && pyResult==success && ≥1 published
 *         package, rendered from pyPackages (count + names). Symmetric with the
 *         npm SUCCESS arm: BOTH lanes require mode==="stable" so neither claims a
 *         success on a degraded/empty MODE (the canary mode==="prerelease" case
 *         is already fully suppressed by the early-return above; this gate guards
 *         the mode==="" degraded case). py_packages is only populated on a stable
 *         release, so this never suppresses a legitimate post.
 *       • FAILURE alert when (pyResult==failure || pyBuildResult==failure) AND
 *         (pyPackages.length>0 OR (pyBuildResult==failure && pyIntended)).
 *         Symmetric with the npm lane: PRIMARY gate is the detected PyPI package
 *         set (pyPackages); event-derived pyIntended is only the BUILD-FAILURE
 *         FALLBACK. The pyBuildResult arm closes the gap where the build job
 *         FAILS during a genuine release → publish is skipped → pyResult is
 *         "skipped", so a bare pyResult check would post nothing. The
 *         build-failure fallback to pyIntended catches a build failure that
 *         never emitted publish outputs, and keeps routine non-Python merges
 *         quiet.
 *
 *   - cancelled is NEUTRAL everywhere — never a failure line. (GitHub has no
 *     timeout-specific result; a job hitting timeout-minutes reports
 *     "cancelled", which correctly stays neutral.)
 *
 *   - a skipped lane contributes NOTHING (no false red).
 *   - shouldPost is true iff ≥1 line (success OR failure) was emitted; an empty
 *     message never posts.
 *
 * See build-release-notification.test.ts for the exhaustive truth table.
 */

export type ReleaseMode = "stable" | "prerelease" | "";

/**
 * GitHub Actions `result` values for a needed job. These are the ONLY values
 * GitHub emits: success | failure | cancelled | skipped (plus "" when unset).
 * We only treat "success" and "failure" as actionable;
 * "skipped"/"cancelled"/"" are neutral.
 */
export type JobResult = "success" | "failure" | "skipped" | "cancelled" | "";

/** A published package, as carried in the build job's package arrays. */
export interface PublishedPackage {
  name: string;
  version: string;
}

/** dist-tag → package-name list (ag-ui's ts_groups_json shape). */
export type DistTagGroups = Record<string, string[]>;

export interface BuildReleaseNotificationInput {
  /** needs.build.outputs.mode — "stable" | "prerelease" | "". */
  mode: ReleaseMode;
  /** needs.publish.result — the shared publish job result (npm lane view). */
  npmResult: JobResult;
  /**
   * needs.build.result — the shared build job result (npm lane view). ag-ui has
   * ONE build job spanning both lanes, so this is the SAME value as
   * pyBuildResult (both wired to needs.build.result). The CopilotKit per-lane
   * build-vs-publish distinction does NOT apply here. Catches build-stage
   * failures on the npm side.
   */
  buildResult: JobResult;
  /**
   * NPM_INTENDED — "true" when the notify job determined an npm release was
   * actually attempted (a push whose compare-range touched a package.json, or
   * a workflow_dispatch stable lane). FALLBACK signal for the npm FAILURE arm:
   * used only when the BUILD failed before the detected package set could be
   * populated, so an early build failure on a genuine npm release still pages.
   * The primary failure gate is the detected package set (tsPackages).
   */
  npmIntended: string;
  /** needs.build.outputs.ts_packages — the published npm package set. */
  tsPackages: PublishedPackage[];
  /** needs.build.outputs.ts_groups_json — dist-tag groupings for the npm set. */
  tsGroups: DistTagGroups;
  /**
   * PY_INTENDED — "true" when the notify job determined a Python release was
   * intended (a push whose compare-range touched a pyproject.toml, or a
   * workflow_dispatch stable lane). FALLBACK signal for the PyPI FAILURE arm:
   * used only when the BUILD failed before the detected package set could be
   * populated. The primary failure gate is the detected package set
   * (pyPackages).
   */
  pyIntended: string;
  /**
   * needs.publish.result mapped to the PyPI lane. ag-ui publishes BOTH lanes
   * from the SAME publish job, so this is the SAME value as npmResult.
   */
  pyResult: JobResult;
  /**
   * needs.build.result mapped to the PyPI lane. ag-ui has ONE build job, so
   * this is the SAME value as buildResult. The CopilotKit lineage where a
   * separate build-python failure pages only the PyPI lane no longer applies.
   */
  pyBuildResult: JobResult;
  /** needs.build.outputs.py_packages — the published PyPI package set. */
  pyPackages: PublishedPackage[];
  /**
   * NUGET_INTENDED — "true" when the notify job determined a NuGet release was
   * intended. Same role as npmIntended/pyIntended: build-failure fallback only.
   */
  nugetIntended: string;
  /** needs.publish-dotnet.result mapped to the NuGet lane. */
  nugetResult: JobResult;
  /** needs.build.result mapped to the NuGet lane. */
  nugetBuildResult: JobResult;
  /** needs.build.outputs.dotnet_packages — the published NuGet package set. */
  nugetPackages: PublishedPackage[];
  /**
   * MAVEN_INTENDED — "true" when the notify job determined a Maven Central
   * release was intended. Same role as the other intent gates: build-failure
   * fallback only.
   */
  mavenIntended: string;
  /** needs.publish-maven.result mapped to the Maven Central lane. */
  mavenResult: JobResult;
  /** needs.build.result mapped to the Maven Central lane. */
  mavenBuildResult: JobResult;
  /** needs.build.outputs.java_packages — the published Maven package set. */
  mavenPackages: PublishedPackage[];
  /** needs.build.outputs.scope. Reserved for future use; not rendered today. */
  scope: string;
  /** inputs.dry_run — true on a dry-run dispatch. */
  dryRun: boolean;
  /** URL to this workflow run (for failure "View run" links). */
  runUrl: string;
  /** URL to the npm org page (https://www.npmjs.com/org/ag-ui). */
  npmOrgUrl: string;
  /** Base URL for PyPI project pages (https://pypi.org/project). */
  pyBaseUrl: string;
  /** Base URL for NuGet package pages (https://www.nuget.org/packages). */
  nugetBaseUrl: string;
  /** Base URL for Maven Central artifact pages (https://central.sonatype.com/artifact). */
  mavenBaseUrl: string;
}

export interface BuildReleaseNotificationResult {
  /** The combined Slack message (mrkdwn). Empty when shouldPost is false. */
  message: string;
  /** True iff there is ≥1 success line OR ≥1 failure line. */
  shouldPost: boolean;
}

/** Maximum package names to list inline before collapsing to "+N more". */
const MAX_NAMES = 5;

function pluralize(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** Render a capped, comma-joined name list with a "+N more" overflow tail. */
function renderNameList(names: string[]): string {
  if (names.length <= MAX_NAMES) {
    return names.join(", ");
  }
  const shown = names.slice(0, MAX_NAMES);
  const remaining = names.length - MAX_NAMES;
  return `${shown.join(", ")}, +${remaining} more`;
}

/**
 * Render the npm dist-tag breakdown for the success line. Each group is shown
 * as "`<tag>`: <name list>". Groups are sorted with "latest" first, then
 * alphabetically, so the most common case reads naturally. Empty-array groups
 * are skipped so a degraded ts_groups_json never renders a malformed "`tag`: "
 * fragment with no names.
 */
function renderNpmGroups(groups: DistTagGroups): string {
  const tags = Object.keys(groups)
    .filter((tag) => groups[tag].length > 0)
    .sort((a, b) => {
      if (a === "latest") return -1;
      if (b === "latest") return 1;
      return a.localeCompare(b);
    });
  return tags
    .map((tag) => `\`${tag}\`: ${renderNameList(groups[tag])}`)
    .join(" · ");
}

/**
 * Build the #engr Slack message for a release run. Pure function: same inputs
 * always produce the same output.
 */
export function buildReleaseNotification(
  input: BuildReleaseNotificationInput,
): BuildReleaseNotificationResult {
  const empty: BuildReleaseNotificationResult = {
    message: "",
    shouldPost: false,
  };

  // Dry-run never posts (no real publish happened on any lane).
  if (input.dryRun) {
    return empty;
  }

  // Canary (mode === "prerelease") is fully suppressed on BOTH lanes — success
  // AND failure. Canaries are noise; we want exactly one concise message per
  // stable release. This sits at the same level as the dry-run early-return so
  // neither a success nor a failure line is produced for any canary run.
  if (input.mode === "prerelease") {
    return empty;
  }

  // Event-derived intent signals computed in the notify job. These are now the
  // BUILD-FAILURE FALLBACK for each failure arm (used only when the build
  // failed before the detected package set could populate); the PRIMARY failure
  // gate is the detected package set (tsPackages / pyPackages).
  const npmIntended = input.npmIntended === "true";
  const pyIntended = input.pyIntended === "true";
  const nugetIntended = input.nugetIntended === "true";
  const mavenIntended = input.mavenIntended === "true";

  const lines: string[] = [];

  // --- npm lane (stable only — canary already short-circuited above) ------
  if (
    input.mode === "stable" &&
    input.npmResult === "success" &&
    input.tsPackages.length > 0
  ) {
    const count = input.tsPackages.length;
    // Prefer the dist-tag grouping (carries tag context); fall back to a flat
    // name list from tsPackages if groups came back empty/degraded. When groups
    // ARE populated, validate that they agree with the tsPackages set on TWO
    // axes, because the count (from tsPackages) and the rendered names (from
    // tsGroups) must never disagree:
    //   1. TOTAL count — the sum of grouped names ACROSS all groups, INCLUDING
    //      duplicates, must equal tsPackages.length. A name appearing in two
    //      groups would dedupe to the same Set size yet render more names than
    //      the count claims, so a Set-only check would miss it.
    //   2. Set membership — the deduped set of grouped names must exactly match
    //      the tsPackages name set (catches a dropped group, or a phantom name
    //      listed that isn't in tsPackages).
    // On ANY mismatch, warn and fall back to the flat list so count and names
    // always agree. (renderNpmGroups already skips empty-array groups; this
    // total-count axis additionally catches the multi-group-duplicate case.)
    let breakdown: string;
    if (Object.keys(input.tsGroups).length > 0) {
      const groupNames = new Set<string>();
      let totalGroupedNames = 0;
      for (const names of Object.values(input.tsGroups)) {
        for (const n of names) {
          groupNames.add(n);
          totalGroupedNames += 1;
        }
      }
      const packageNames = new Set(input.tsPackages.map((p) => p.name));
      const sameTotalCount = totalGroupedNames === input.tsPackages.length;
      const sameMembership =
        groupNames.size === packageNames.size &&
        [...groupNames].every((n) => packageNames.has(n));
      if (sameTotalCount && sameMembership) {
        breakdown = renderNpmGroups(input.tsGroups);
      } else {
        console.warn(
          "::warning::npm dist-tag groups (ts_groups_json) disagree with the published package set (ts_packages) — falling back to a flat name list so the count and names agree.",
        );
        breakdown = renderNameList(input.tsPackages.map((p) => p.name));
      }
    } else {
      breakdown = renderNameList(input.tsPackages.map((p) => p.name));
    }
    lines.push(
      `🚀 *ag-ui release* · ${pluralize(count, "npm package")} published ` +
        `(${breakdown}) · ` +
        `<${input.npmOrgUrl}|npm>`,
    );
  } else if (
    (input.npmResult === "failure" || input.buildResult === "failure") &&
    (input.tsPackages.length > 0 ||
      (input.buildResult === "failure" && npmIntended))
  ) {
    // FAILURE gating keys off the DETECTED PACKAGE SET, not the event-derived
    // intent. The detected set (tsPackages.length > 0) is the authoritative
    // "this lane actually attempted a release" signal → page on its failure
    // regardless of which manifest the push touched. This closes a
    // silent-swallow: detect_ts diffs LOCAL manifests against the REGISTRY, so
    // a push that only touched the OTHER ecosystem's manifest can still
    // re-detect a STALE unpublished bump from a prior failed release; intent
    // (compare-range) for THIS lane is then false, which under the old
    // intent-only gate would shut the arm and swallow a real publish failure.
    // When the BUILD failed before detection could populate the package set, we
    // fall back to the event-derived intent (npmIntended) so an early build
    // failure on an intended release still pages — never toward silence. When
    // the build SUCCEEDED but detected no packages (e.g. a dependabot dep bump
    // that touched package.json without bumping the package's own version),
    // this lane does NOT page (fixes the prior false-positive).
    //
    // KNOWN LIMITATION (out of scope — needs a publish-job change): npm and
    // PyPI share ONE publish job, so npmResult and pyResult are both
    // needs.publish.result. A single-lane publish failure therefore marks the
    // shared result "failure"; if the OTHER lane also detected packages, both
    // red lines may show. This is the safe over-report direction; true per-lane
    // attribution requires the publish job to emit per-lane outputs. The shared
    // BUILD job has the same coupling: buildResult is needs.build.result for
    // BOTH lanes, so a TS-only build failure can red the PyPI lane (and
    // vice-versa) when the other lane also detected packages or was intended.
    //
    // Lane-level wording: a later tag/release step may have failed while
    // publish itself succeeded, so never say "npm publish failed".
    lines.push(`🔴 *ag-ui npm release failed* · <${input.runUrl}|View run>`);
  }
  // cancelled / skipped on the npm lane are NEUTRAL → no line.

  // --- PyPI lane (stable only — canary already short-circuited above) -----
  if (
    input.mode === "stable" &&
    input.pyResult === "success" &&
    input.pyPackages.length > 0
  ) {
    const count = input.pyPackages.length;
    const names = renderNameList(input.pyPackages.map((p) => p.name));
    // Link to the flagship project page. ag-ui's flagship is ag-ui-protocol;
    // select it explicitly by name if present (nothing sorts pyPackages, so we
    // must not assume index 0 is the flagship), else fall back to the first
    // published package.
    const flagship =
      input.pyPackages.find((p) => p.name === "ag-ui-protocol")?.name ??
      input.pyPackages[0].name;
    lines.push(
      `🐍 *ag-ui release* · ${pluralize(count, "PyPI package")} published ` +
        `(${names}) · ` +
        `<${input.pyBaseUrl}/${flagship}/|PyPI>`,
    );
  } else if (
    (input.pyResult === "failure" || input.pyBuildResult === "failure") &&
    (input.pyPackages.length > 0 ||
      (input.pyBuildResult === "failure" && pyIntended))
  ) {
    // Symmetric with the npm failure arm: gate on the DETECTED PACKAGE SET
    // (pyPackages.length > 0) as the authoritative "this lane attempted a
    // release" signal → page on its failure regardless of which manifest the
    // push touched (closes the stale-cross-lane silent-swallow where detect_py
    // re-detects a stale unpublished bump on an npm-only push). When the BUILD
    // failed before detection could populate the package set, fall back to the
    // event-derived pyIntended so an early build failure on an intended release
    // still pages. When the build SUCCEEDED but detected no packages, this lane
    // does NOT page. Use pyBuildResult === "failure" (NOT "skipped"): a
    // CANCELLED build reports "cancelled" and stays NEUTRAL, so a deliberate
    // cancel never false-REDs.
    //
    // Same KNOWN LIMITATION as the npm arm: the shared publish job means a
    // single-lane publish failure reds both lanes' result; safe over-report.
    // The shared BUILD job has the same coupling: pyBuildResult is
    // needs.build.result for BOTH lanes, so a PyPI-only build failure can red
    // the npm lane (and vice-versa) when the other lane also detected packages
    // or was intended.
    lines.push(`🔴 *ag-ui PyPI release failed* · <${input.runUrl}|View run>`);
  }

  // --- NuGet lane (stable only — canary already short-circuited above) ---
  if (
    input.mode === "stable" &&
    input.nugetResult === "success" &&
    input.nugetPackages.length > 0
  ) {
    const count = input.nugetPackages.length;
    const names = renderNameList(input.nugetPackages.map((p) => p.name));
    const flagship = input.nugetPackages[0].name;
    lines.push(
      `📦 *ag-ui release* · ${pluralize(count, "NuGet package")} published ` +
        `(${names}) · ` +
        `<${input.nugetBaseUrl}/${flagship}/|NuGet>`,
    );
  } else if (
    (input.nugetResult === "failure" || input.nugetBuildResult === "failure") &&
    (input.nugetPackages.length > 0 ||
      (input.nugetBuildResult === "failure" && nugetIntended))
  ) {
    lines.push(`🔴 *ag-ui NuGet release failed* · <${input.runUrl}|View run>`);
  }

  // --- Maven Central lane ------------------------------------------------
  // The Maven lane is stable-only by construction (Maven Central has no canary
  // channel and the build job rejects a prerelease dispatch that resolves to a
  // Maven scope), so the mode === "prerelease" early-return above never has a
  // real Maven publish to suppress. The mode === "stable" gate is still
  // required, symmetric with the other lanes, so a degraded empty MODE cannot
  // claim a success.
  if (
    input.mode === "stable" &&
    input.mavenResult === "success" &&
    input.mavenPackages.length > 0
  ) {
    const count = input.mavenPackages.length;
    const names = renderNameList(input.mavenPackages.map((p) => p.name));
    const flagship = input.mavenPackages[0].name;
    lines.push(
      `☕ *ag-ui release* · ${pluralize(count, "Maven package")} published ` +
        `(${names}) · ` +
        `<${input.mavenBaseUrl}/com.ag-ui.community/${flagship}|Maven Central>`,
    );
  } else if (
    (input.mavenResult === "failure" || input.mavenBuildResult === "failure") &&
    (input.mavenPackages.length > 0 ||
      (input.mavenBuildResult === "failure" && mavenIntended))
  ) {
    lines.push(
      `🔴 *ag-ui Maven Central release failed* · <${input.runUrl}|View run>`,
    );
  }

  if (lines.length === 0) {
    return empty;
  }

  return { message: lines.join("\n"), shouldPost: true };
}
