/**
 * The TypeScript conformance lane: every shared fixture stream, replayed over
 * real HTTP/SSE into a real HttpAgent, asserted against the outcome the
 * specification requires.
 *
 * The streams arrive the way a producer would send them — aimock writes each
 * event as its own SSE frame — so this exercises the whole consumer: the SSE
 * reader, the compatibility boundary, middleware, enforcement, chunk
 * expansion, verification and the reducer. That is the point: the unit tests
 * around each stage already pass, and the two clients still disagreed.
 *
 * The .NET lane reads the same files and asserts the same expectations.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAgent } from "@/agent";
import type { RunAgentInput } from "@ag-ui/core";
import {
  resolveExpectation,
  type StreamExpectation,
  type StreamFixture,
} from "../fixture";

/**
 * Walked up from this file rather than counted in "..", so moving the runner
 * cannot silently point it at a directory that does not exist — the same
 * reason the .NET corpus test walks instead of trusting a caller path.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "spec", "draft", "conformance"))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("no repository root above the conformance runner");
    dir = parent;
  }
  return dir;
}

export const STREAMS_DIR = join(
  repoRoot(),
  "spec",
  "draft",
  "conformance",
  "streams",
);

export function loadFixtures(): StreamFixture[] {
  return readdirSync(STREAMS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          readFileSync(join(STREAMS_DIR, name), "utf8"),
        ) as StreamFixture,
    );
}

/**
 * Deep subset match: every key the expectation names must be present and
 * equal, and keys it does not name are ignored. Expectations state what the
 * specification requires, not every incidental field a client happens to
 * carry — an exact match would fail on details the two lanes legitimately
 * differ about.
 */
function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => matchesSubset(actual[index], item))
    );
  }
  if (expected !== null && typeof expected === "object") {
    // An expected OBJECT must meet an object, never an array: `typeof` calls
    // both "object", and the .NET lane distinguishes them, so accepting an
    // array here would let the two lanes disagree about the same fixture.
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      return false;
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(actual, key) &&
        matchesSubset((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === expected;
}

/** Whether a dot/index path exists at all — an explicit null still exists. */
function pathExists(value: unknown, path: string): boolean {
  let node: unknown = value;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      // Only a numeric index addresses an array member. `in` would answer
      // true for `length`, which is not a JSON member and which the .NET
      // lane's JsonArray would never report.
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= node.length)
        return false;
      node = node[index];
      continue;
    }
    // hasOwnProperty, not `in`: `in` finds inherited members such as
    // `constructor`, so an absence assertion would silently never hold.
    if (!Object.prototype.hasOwnProperty.call(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

/**
 * Reads a dot/index path. Walks arrays by numeric index, exactly as
 * `pathExists` does — otherwise a zero-padded segment like "01" would exist
 * and then read as undefined, and the two lanes would disagree.
 */
function readPath(value: unknown, path: string): unknown {
  let node: unknown = value;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= node.length)
        return undefined;
      node = node[index];
      continue;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

interface ReplayResult {
  eventTypes: string[];
  events: Array<Record<string, unknown>>;
  outcome: "completed" | "failed";
  error?: string;
  runError?: string;
  warnings: string[];
  messages: Array<Record<string, unknown>>;
  state: unknown;
  request?: RunAgentInput;
}

async function replay(fixture: StreamFixture): Promise<ReplayResult> {
  const mock = new AGUIMock({ logLevel: "silent" });
  let request: RunAgentInput | undefined;
  mock.onPredicate(
    (input: unknown) => {
      request = input as RunAgentInput;
      return true;
    },
    // The stream is replayed verbatim: these are the bytes a producer would
    // have sent, including the ones no conforming producer would.
    fixture.stream as never,
  );
  const url = await mock.start();

  const pinned = fixture.client?.maxProtocolVersion;
  class FixtureAgent extends HttpAgent {
    // A pinned peer is what installs the version-gated compatibility
    // middlewares; the deprecated spelling is deliberate here only where a
    // fixture asks for it, so the default is the current name.
    override get maxProtocolVersion(): string {
      return pinned ?? super.maxProtocolVersion;
    }
  }
  const agent = new FixtureAgent({ url });
  // A producer reporting its own failure is a well-formed stream, so it does
  // not reject the run — it arrives as an event, and this is where a client
  // observes it.
  let runError: string | undefined;
  // What actually reached application code, which is the only way a fixture
  // can tell a dropped event from one that was passed through.
  const eventTypes: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  agent.subscribe({
    onEvent: ({ event }) => {
      eventTypes.push(String((event as { type?: unknown }).type));
      events.push(event as unknown as Record<string, unknown>);
    },
    onRunErrorEvent: ({ event }) => {
      runError = (event as { message?: string }).message ?? "";
    },
  });
  if (fixture.input?.messages !== undefined) {
    agent.messages = fixture.input.messages as never;
  }

  const warnings: string[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) =>
      warnings.push(args.map((a) => String(a)).join(" ")),
    );

  let outcome: "completed" | "failed" = "completed";
  let error: string | undefined;
  try {
    await agent.runAgent({
      ...(fixture.input?.tools !== undefined && {
        tools: fixture.input.tools as never,
      }),
      ...(fixture.input?.context !== undefined && {
        context: fixture.input.context as never,
      }),
      ...(fixture.input?.forwardedProps !== undefined && {
        forwardedProps: fixture.input.forwardedProps as never,
      }),
    });
  } catch (thrown) {
    outcome = "failed";
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    warn.mockRestore();
    await mock.stop();
  }

  return {
    eventTypes,
    events,
    outcome,
    error,
    runError,
    warnings,
    messages: agent.messages as unknown as Array<Record<string, unknown>>,
    state: agent.state,
    request,
  };
}

function assertExpectation(
  result: ReplayResult,
  expectation: StreamExpectation,
): void {
  if (expectation.outcome !== undefined) {
    expect(
      result.outcome,
      `expected the run to be ${expectation.outcome}${
        result.error ? ` — it failed with: ${result.error}` : ""
      }`,
    ).toBe(expectation.outcome);
  }
  if (expectation.eventTypes !== undefined) {
    expect(
      result.eventTypes,
      "the events delivered to application code",
    ).toEqual(expectation.eventTypes);
  }
  for (const type of expectation.eventTypesAbsent ?? []) {
    expect(
      result.eventTypes,
      `${type} must not reach application code`,
    ).not.toContain(type);
  }
  for (const [path, value] of Object.entries(expectation.eventPaths ?? {})) {
    expect(
      pathExists(result.events, path),
      `${path} must exist in the delivered events`,
    ).toBe(true);
    expect(readPath(result.events, path), `delivered event at ${path}`).toEqual(
      value,
    );
  }
  for (const path of expectation.eventAbsentPaths ?? []) {
    expect(
      pathExists(result.events, path),
      `${path} must NOT exist in the delivered events`,
    ).toBe(false);
  }
  if (expectation.errorContains !== undefined) {
    expect(result.error ?? "").toContain(expectation.errorContains);
  }
  if (expectation.runError !== undefined) {
    if (expectation.runError === false) {
      expect(result.runError, "the run must not report a failure").toBeUndefined();
    } else {
      expect(
        result.runError,
        "the run was expected to report its own failure",
      ).toBeDefined();
      if (typeof expectation.runError === "string") {
        expect(result.runError ?? "").toContain(expectation.runError);
      }
    }
  }
  for (const substring of expectation.warnings ?? []) {
    expect(
      result.warnings.some((warning) => warning.includes(substring)),
      `expected a warning containing ${JSON.stringify(substring)}; saw: ${
        result.warnings.length === 0
          ? "(none)"
          : result.warnings.map((w) => JSON.stringify(w)).join(", ")
      }`,
    ).toBe(true);
  }
  if (expectation.noWarnings === true) {
    expect(
      result.warnings,
      "a conformant stream must not make a client complain",
    ).toEqual([]);
  }
  if (expectation.messageCount !== undefined) {
    expect(result.messages).toHaveLength(expectation.messageCount);
  }
  if (expectation.messages !== undefined) {
    expect(
      matchesSubset(result.messages, expectation.messages),
      `messages did not match:\nexpected subset ${JSON.stringify(
        expectation.messages,
      )}\nactual ${JSON.stringify(result.messages)}`,
    ).toBe(true);
  }
  if (expectation.state !== undefined) {
    expect(
      matchesSubset(result.state, expectation.state),
      `state did not match:\nexpected subset ${JSON.stringify(
        expectation.state,
      )}\nactual ${JSON.stringify(result.state)}`,
    ).toBe(true);
  }
  if (expectation.request !== undefined) {
    expect(
      matchesSubset(result.request, expectation.request),
      `the request the client sent did not match:\nexpected subset ${JSON.stringify(
        expectation.request,
      )}\nactual ${JSON.stringify(result.request)}`,
    ).toBe(true);
  }
  for (const path of expectation.requestAbsentPaths ?? []) {
    // pathExists, not a value read: an explicit null is present, and raw
    // property access would resolve inherited members like `constructor`.
    expect(
      pathExists(result.request, path),
      `${path} must be absent from the request the client sent`,
    ).toBe(false);
  }
}

const fixtures = loadFixtures();

describe("conformance: fixture streams", () => {
  const previousSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  beforeEach(() => {
    // The compatibility shims honour this variable; a developer who has it set
    // would otherwise see every warning assertion fail for no visible reason.
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  });
  afterEach(() => {
    if (previousSuppress !== undefined)
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS = previousSuppress;
  });

  it("has fixtures to run", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.area}: ${fixture.name} — ${fixture.description}`, async () => {
      const result = await replay(fixture);
      assertExpectation(result, resolveExpectation(fixture, "typescript"));
    });
  }
});
