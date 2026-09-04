/**
 * The shared conformance fixture format.
 *
 * A fixture is one replayed stream plus the outcome the specification requires
 * of any client that consumes it. The same files drive the TypeScript lane
 * (this package) and the .NET lane, so the format is deliberately declarative:
 * it states what must be observable afterwards, never how a particular client
 * arrives there, because the two clients expose different surfaces.
 *
 * The files live at `spec/draft/conformance/streams/*.json`; adding one is
 * documented in `spec/draft/conformance/README.md`, one level up, because
 * `streams/` itself holds only the fixtures and the `MANIFEST.txt` listing
 * them.
 */

/** What must hold after a fixture's stream has been consumed. */
export interface StreamExpectation {
  /**
   * Whether the client carried the stream to a clean finish, or the run ended
   * in failure. "failed" covers two roads to the same observable end: a
   * protocol violation the client itself detected and refused, and a failure
   * the producer signalled with RUN_ERROR that the client surfaces as a failed
   * run (also reported through `runError` below, whose message the fixture can
   * pin). "completed" is a run neither the client nor the producer failed.
   */
  outcome?: "completed" | "failed";
  /** Substring of the error a client rejection must surface. */
  errorContains?: string;
  /**
   * The run reported its own failure: `true` for any RUN_ERROR, or a substring
   * the reported message must contain.
   */
  runError?: boolean | string;
  /**
   * The event types delivered to application code, in order, exactly.
   *
   * Without this, a fixture cannot tell dropping from passing through: a
   * client that emitted the required warning and then delivered the
   * unrecognised event anyway would satisfy every other key. Any fixture whose
   * rule is about what reaches the application states this.
   */
  eventTypes?: string[];
  /** Event types that must NOT reach application code. */
  eventTypesAbsent?: string[];
  /**
   * Values inside the delivered events, keyed by `"<index>.<dotted path>"`.
   * Each named path must exist and equal the value given.
   *
   * `eventTypes` proves an event survived; this proves what it survived
   * carrying. Without it a fixture claiming a property was preserved cannot
   * tell preservation from removal.
   */
  eventPaths?: Record<string, unknown>;
  /**
   * Paths inside the delivered events, keyed the same way, that must NOT
   * exist. The only way to assert a removal: a client that warned about
   * stripping something and then delivered it anyway satisfies everything
   * else.
   */
  eventAbsentPaths?: string[];
  /** Substrings that must each appear in at least one emitted warning. */
  warnings?: string[];
  /**
   * No warning at all may be emitted. The guard for conformant streams: a
   * tolerance regression that starts complaining about legal traffic is a
   * defect, and nothing else would catch it.
   */
  noWarnings?: boolean;
  /** Exact number of messages the client holds afterwards. */
  messageCount?: number;
  /** Subset-matched against the final messages, in order. */
  messages?: Array<Record<string, unknown>>;
  /**
   * Subset-matched against the final state. Any JSON value: state is
   * unconstrained by the schema, and fixtures legitimately expect an array,
   * a number or null.
   */
  state?: unknown;
  /**
   * Subset-matched against the RunAgentInput the client actually sent. The
   * only way to test the input-direction compatibility shims, which never
   * touch the event stream at all.
   */
  request?: Record<string, unknown>;
  /** Paths (dot/index notation) that must be absent from the sent request. */
  requestAbsentPaths?: string[];
}

/** A per-client override, with the reason the divergence is deliberate. */
export interface StreamExpectationOverride extends StreamExpectation {
  /**
   * Why this client legitimately differs. Required: an override without a
   * stated reason is an unexplained inconsistency, which is the thing this
   * whole suite exists to prevent.
   */
  intentional: string;
}

export interface StreamFixture {
  /** Unique; matches the file name without .json. */
  name: string;
  /** Which area of the specification this exercises. */
  area: string;
  /** One line: what this fixture proves. */
  description: string;
  /** The specification page the rule lives on. */
  specPage?: string;
  /**
   * The single-line change to the implementation that must make this fixture
   * fail. Every fixture states one — it is how we know the fixture tests
   * something rather than passing vacuously.
   */
  kill: string;
  /** Client configuration for the replay. */
  client?: {
    /**
     * Pins the peer ceiling, which is what installs the version-gated
     * compatibility middlewares. Absent means a current peer and no shims.
     */
    maxProtocolVersion?: string;
  };
  /** Passed to the client when starting the run. */
  input?: {
    messages?: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
    context?: Array<Record<string, unknown>>;
    forwardedProps?: unknown;
  };
  /**
   * The events to replay, verbatim. Deliberately untyped: the point of most
   * fixtures is to send something a conforming producer never would.
   */
  stream: Array<Record<string, unknown>>;
  /** What the specification requires of every client. */
  expect: StreamExpectation;
  /**
   * Where a client legitimately differs, keyed by lane. Keys present here
   * replace the same keys in `expect` for that lane; everything else still
   * applies.
   */
  expectOverrides?: {
    typescript?: StreamExpectationOverride;
    dotnet?: StreamExpectationOverride;
  };
}

/** The expectation one lane must satisfy: the base, with its overrides applied. */
export function resolveExpectation(
  fixture: StreamFixture,
  lane: "typescript" | "dotnet",
): StreamExpectation {
  const override = fixture.expectOverrides?.[lane];
  if (!override) return fixture.expect;
  const { intentional: _intentional, ...keys } = override;
  return { ...fixture.expect, ...keys };
}
