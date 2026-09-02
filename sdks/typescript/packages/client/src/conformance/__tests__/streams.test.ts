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
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) =>
        matchesSubset((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === expected;
}

/** Reads a dot/index path, for asserting a field is absent from the request. */
function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || typeof node !== "object"
          ? undefined
          : (node as Record<string, unknown>)[key],
      value,
    );
}

interface ReplayResult {
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
  agent.subscribe({
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
    expect(
      readPath(result.request, path),
      `${path} must be absent from the request the client sent`,
    ).toBeUndefined();
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
