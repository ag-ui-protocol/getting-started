/**
 * The single measured-posture fixture for `corsOrigin`.
 *
 * Every number and header value below was measured against `cors` 2.8.5 on
 * Express 5 with an undici `fetch` client, not inferred from the docs or from
 * `cors`'s source. The suites drive their assertions from this table so a
 * posture is described in exactly one place, and `README.md`'s `corsOrigin`
 * table is checked for set parity against it (see `cors.test.ts`), so
 * documenting a posture nobody measured, or measuring one nobody documented,
 * fails a test rather than passing review.
 */

import type { CreateStrandsAppOptions } from "../server";

/** Origin the probes present themselves as, and the one allowlists admit. */
export const ALLOWED_ORIGIN = "https://app.example.com";
/** A second origin on the allowlists, so an array is visibly a list. */
export const ADMIN_ORIGIN = "https://admin.example.com";
/** An origin no allowlist admits. */
export const OTHER_ORIGIN = "https://evil.example.com";

/** `cors`'s own method list, emitted whenever `allowMethods` is omitted. */
export const DEFAULT_ALLOW_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";
/** Request headers the probing preflight asks permission for. */
export const PROBE_REQUEST_HEADERS = "x-custom, content-type";

/**
 * One measured response: `null` means the header was absent.
 *
 * `allowCredentials` is asserted for every posture, including the ones that
 * withhold the header. The factory derives `credentials` from the resolved
 * origin and from the calling one (`policyAllowsCredentials` and
 * `requestAllowsCredentials` in `server.ts`), and every probe in this fixture
 * calls from an origin naming a site, so the value is a function of the posture
 * alone here and there is nothing left to opt out of: a policy naming at least
 * one specific origin emits `"true"`, and `"*"`, `[]` and the arrays that
 * collapse to `"*"` emit nothing at all. The callers that name no site are
 * measured in `cors.test.ts` rather than here, since they are a property of the
 * request instead of the posture.
 */
export interface MeasuredResponse {
  status: number;
  allowOrigin: string | null;
  allowCredentials: string | null;
  allowMethods: string | null;
  allowHeaders: string | null;
  vary: string | null;
}

export interface CorsPosture {
  /** Test-name fragment. */
  label: string;
  /**
   * The `corsOrigin` value as `README.md`'s table spells it, backticks
   * stripped. Several postures can instantiate one documented row: leaving
   * `corsOrigin` out and passing an explicit `undefined` are two postures for
   * the README's single `omitted` row.
   */
  readmeValue: string;
  options: CreateStrandsAppOptions;
  /**
   * Whether the `cors` middleware is installed at all.
   *
   * The source the installation suites derive their case lists from, so this
   * column is load-bearing rather than documentation: see
   * {@link posturesWithMiddleware} and {@link posturesWithoutMiddleware}.
   */
  installsMiddleware: boolean;
  /**
   * Preflight from {@link ALLOWED_ORIGIN} carrying
   * `Access-Control-Request-Headers: x-custom, content-type`.
   */
  preflight: MeasuredResponse;
  /**
   * Preflight from {@link OTHER_ORIGIN} sending no
   * `Access-Control-Request-Headers`. This column is where a fixed origin
   * (echoed to every caller) separates from an allowlist (compared per call).
   */
  preflightFromOther: MeasuredResponse;
  /**
   * Any non-preflight response from {@link ALLOWED_ORIGIN}: the agent `POST`,
   * `GET /ping` and `GET /capabilities` all measured identically, since the
   * middleware is mounted app-wide and only preflights get the method and
   * header advertisements.
   */
  simple: MeasuredResponse;
  /**
   * The agent `POST` from {@link OTHER_ORIGIN}.
   *
   * The preflight is only the gate; this is the response that actually carries
   * the agent's output, and it is where a disallowed caller finds out whether
   * its browser may read that output. It separates the same two policies
   * {@link preflightFromOther} does, on the response that matters.
   */
  simpleFromOther: MeasuredResponse;
}

/** No CORS middleware: every CORS header absent, Express answers OPTIONS itself. */
const NO_MIDDLEWARE_PREFLIGHT: MeasuredResponse = {
  // Express's own OPTIONS responder, not `cors`'s 204 short-circuit. This is
  // the observable difference between "installed and denying" and "not
  // installed", which is why `[]` below is a counterexample to reading a
  // missing allow-origin header as proof that nothing was mounted.
  status: 200,
  allowOrigin: null,
  allowCredentials: null,
  allowMethods: null,
  allowHeaders: null,
  vary: null,
};

const NO_MIDDLEWARE_SIMPLE: MeasuredResponse = {
  status: 200,
  allowOrigin: null,
  allowCredentials: null,
  allowMethods: null,
  allowHeaders: null,
  vary: null,
};

export const CORS_POSTURES: CorsPosture[] = [
  {
    label: "omitted",
    readmeValue: "omitted",
    options: {},
    installsMiddleware: false,
    preflight: NO_MIDDLEWARE_PREFLIGHT,
    preflightFromOther: NO_MIDDLEWARE_PREFLIGHT,
    simple: NO_MIDDLEWARE_SIMPLE,
    simpleFromOther: NO_MIDDLEWARE_SIMPLE,
  },
  {
    label: "an explicit `undefined`",
    readmeValue: "omitted",
    options: { corsOrigin: undefined },
    installsMiddleware: false,
    preflight: NO_MIDDLEWARE_PREFLIGHT,
    preflightFromOther: NO_MIDDLEWARE_PREFLIGHT,
    simple: NO_MIDDLEWARE_SIMPLE,
    simpleFromOther: NO_MIDDLEWARE_SIMPLE,
  },
  {
    label: "`false`",
    readmeValue: "false",
    options: { corsOrigin: false },
    installsMiddleware: false,
    preflight: NO_MIDDLEWARE_PREFLIGHT,
    preflightFromOther: NO_MIDDLEWARE_PREFLIGHT,
    simple: NO_MIDDLEWARE_SIMPLE,
    simpleFromOther: NO_MIDDLEWARE_SIMPLE,
  },
  {
    label: "an empty string",
    readmeValue: '""',
    options: { corsOrigin: "" },
    installsMiddleware: false,
    preflight: NO_MIDDLEWARE_PREFLIGHT,
    preflightFromOther: NO_MIDDLEWARE_PREFLIGHT,
    simple: NO_MIDDLEWARE_SIMPLE,
    simpleFromOther: NO_MIDDLEWARE_SIMPLE,
  },
  {
    label: "the literal `*` wildcard",
    readmeValue: '"*"',
    options: { corsOrigin: "*" },
    installsMiddleware: true,
    preflight: {
      status: 204,
      // Emitted verbatim, never the caller's own origin.
      allowOrigin: "*",
      // Withheld, and the one posture where that is the CORS protocol's own
      // rule rather than a choice: browsers refuse a literal wildcard paired
      // with credentials outright.
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      // No `Vary: Origin`: the response does not depend on the caller.
      vary: "Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
    simpleFromOther: {
      status: 200,
      // Verbatim again, so a disallowed caller is not a concept here: the
      // wildcard admits every origin for an uncredentialed request.
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
  },
  {
    label: "a single origin string",
    readmeValue: '"https://app.tld"',
    options: { corsOrigin: ALLOWED_ORIGIN },
    installsMiddleware: true,
    preflight: {
      status: 204,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      vary: "Origin, Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      // A fixed origin, not an allowlist: the configured value is echoed to
      // every caller without ever being compared to the request's Origin. A
      // regression to reflecting the caller shows up right here.
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Origin, Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
    simpleFromOther: {
      status: 200,
      // The fixed echo again, on the response carrying the agent's output: the
      // disallowed caller is told the configured origin is allowed, and its
      // browser then compares that against its own and refuses. Nothing
      // server-side withholds anything, so a regression to reflection would
      // hand this caller its own origin and let it read the stream.
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
  },
  {
    label: "an exact-match allowlist array",
    readmeValue: '["https://a.tld"]',
    options: { corsOrigin: [ALLOWED_ORIGIN, ADMIN_ORIGIN] },
    installsMiddleware: true,
    preflight: {
      status: 204,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      vary: "Origin, Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      // Compared against the caller, so a miss withholds the header entirely.
      allowOrigin: null,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Origin, Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
    simpleFromOther: {
      status: 200,
      // The agent still ran and still streamed; the withheld header is the
      // whole of the denial, and it is withheld per caller rather than fixed.
      allowOrigin: null,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
  },
  {
    label: "an array holding only `*`",
    // Its own documented row rather than an instance of the array row:
    // `normalizeCorsOrigin` collapses any array containing `"*"` to the bare
    // string `"*"` before `cors` is constructed, so this is allow-all and not
    // an allowlist whose single entry no browser origin equals. Measured
    // byte-identical to the bare `"*"` posture on all four columns.
    readmeValue: '["*"]',
    options: { corsOrigin: ["*"] },
    installsMiddleware: true,
    preflight: {
      status: 204,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      // No `Vary: Origin`, exactly as for the bare `"*"`: the collapse happens
      // ahead of `cors`, so nothing downstream can tell an array was passed.
      vary: "Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
    simpleFromOther: {
      status: 200,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
  },
  {
    label: "an array holding `*` alongside a concrete origin",
    // The mixed case, and the reason the collapse is `includes("*")` rather
    // than a length check: one `"*"` anywhere in the array collapses the whole
    // array, so the concrete entry beside it narrows nothing. Measured
    // identical to `["*"]`, which is what makes the allowlist this spelling
    // looks like a policy that does not exist.
    readmeValue: '["*", "https://a.tld"]',
    options: { corsOrigin: ["*", ALLOWED_ORIGIN] },
    installsMiddleware: true,
    preflight: {
      status: 204,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      vary: "Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
    simpleFromOther: {
      status: 200,
      // Admitted, though it is not the origin the array named: the wildcard
      // collapsed the list away, so there is no disallowed origin here either.
      allowOrigin: "*",
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: null,
    },
  },
  {
    label: "an empty array",
    readmeValue: "[]",
    options: { corsOrigin: [] },
    installsMiddleware: true,
    preflight: {
      // Deny-all, yet the middleware is mounted and short-circuits the
      // preflight with 204 while still advertising its default method list.
      // Only the absent allow-origin header denies the caller.
      status: 204,
      allowOrigin: null,
      // No wildcard here, and still no credentials: the rule is "no specific
      // origin named", and an empty list names none.
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      vary: "Origin, Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      allowOrigin: null,
      allowCredentials: null,
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Origin, Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: null,
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
    simpleFromOther: {
      status: 200,
      allowOrigin: null,
      allowCredentials: null,
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
  },
  {
    label: "`true`",
    readmeValue: "true",
    options: { corsOrigin: true },
    installsMiddleware: true,
    preflight: {
      status: 204,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: PROBE_REQUEST_HEADERS,
      vary: "Origin, Access-Control-Request-Headers",
    },
    preflightFromOther: {
      status: 204,
      // Reflected per request: more permissive than the literal `*`, since it
      // pairs with credentials in a way a browser accepts.
      allowOrigin: OTHER_ORIGIN,
      allowCredentials: "true",
      allowMethods: DEFAULT_ALLOW_METHODS,
      allowHeaders: null,
      vary: "Origin, Access-Control-Request-Headers",
    },
    simple: {
      status: 200,
      allowOrigin: ALLOWED_ORIGIN,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
    simpleFromOther: {
      status: 200,
      // There is no disallowed origin under `true`: the caller an allowlist
      // would have rejected is handed its own origin back, alongside the
      // credentials header, on the response carrying the agent's output.
      allowOrigin: OTHER_ORIGIN,
      allowCredentials: "true",
      allowMethods: null,
      allowHeaders: null,
      vary: "Origin",
    },
  },
];

/**
 * The posture carrying `label`.
 *
 * Named lookups are how the suites reuse one measured row, and a typo or a
 * renamed row has to say so: `find(...)!` would hand the caller `undefined`
 * and fail several lines later on a missing property instead.
 */
export function postureByLabel(label: string): CorsPosture {
  const posture = CORS_POSTURES.find((p) => p.label === label);
  if (!posture) {
    throw new Error(
      `No measured posture labelled ${JSON.stringify(label)}. Labels: ` +
        CORS_POSTURES.map((p) => JSON.stringify(p.label)).join(", "),
    );
  }
  return posture;
}

/** Postures that install the `cors` middleware, as `it.each` rows. */
export function posturesWithMiddleware(): [string, CreateStrandsAppOptions][] {
  return CORS_POSTURES.filter((p) => p.installsMiddleware).map((p) => [
    p.label,
    p.options,
  ]);
}

/** Postures that leave the optional peer untouched, as `it.each` rows. */
export function posturesWithoutMiddleware(): [
  string,
  CreateStrandsAppOptions,
][] {
  return CORS_POSTURES.filter((p) => !p.installsMiddleware).map((p) => [
    p.label,
    p.options,
  ]);
}

/** The set of documented `corsOrigin` values this fixture measures. */
export function fixtureReadmeValues(): Set<string> {
  return new Set(CORS_POSTURES.map((p) => p.readmeValue));
}

/**
 * Parse the `corsOrigin` value column out of `README.md`'s table.
 *
 * Deliberately literal: it finds the table that follows the `` `corsOrigin`
 * accepts: `` line and reads the first cell of every body row, so a row added
 * to the docs without a measured fixture entry (or vice versa) fails the
 * parity test rather than shipping as unverified prose.
 */
export function parseReadmeCorsOriginValues(readme: string): string[] {
  const lines = readme.split("\n");
  const anchor = lines.findIndex((line) =>
    line.startsWith("`corsOrigin` accepts:"),
  );
  if (anchor === -1) {
    throw new Error(
      "Could not find the '`corsOrigin` accepts:' anchor in README.md; the " +
        "docs table moved and this parity check needs re-pointing.",
    );
  }
  const values: string[] = [];
  let seenHeader = false;
  for (let i = anchor + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "") {
      if (values.length > 0 || seenHeader) break;
      continue;
    }
    if (!line.startsWith("|")) break;
    const cell = line.split("|")[1]?.trim() ?? "";
    if (/^-+$/.test(cell.replace(/[\s:]/g, "-"))) continue;
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    values.push(cell.replace(/`/g, "").trim());
  }
  if (values.length === 0) {
    throw new Error("Parsed no rows out of README.md's `corsOrigin` table.");
  }
  return values;
}
