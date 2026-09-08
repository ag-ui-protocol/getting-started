/**
 * Server-side entry point for `@ag-ui/aws-strands`.
 *
 * Import from `@ag-ui/aws-strands/server` when you need the Express transport
 * helpers. The main entry point (`@ag-ui/aws-strands`) stays free of Express
 * / cors references so Next.js / Turbopack / Vite bundlers tracing the
 * client-side graph don't pull server-only modules into the browser build.
 */

import {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
} from "./endpoint";
import type { StrandsAgent } from "./agent";
import type {
  StrandsAguiCapabilitiesOverrides,
  StrandsAuthMiddleware,
} from "./endpoint";

export {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
} from "./endpoint";

export type {
  AddStrandsEndpointOptions,
  StrandsAuthMiddleware,
  StrandsAguiCapabilities,
  StrandsAguiCapabilitiesOverrides,
} from "./endpoint";

export interface CreateStrandsAppOptions {
  /** Path for the agent endpoint. Default `/`. */
  path?: string;
  /** Path for the ping endpoint. Pass `null` or `""` to disable. Default `/ping`. */
  pingPath?: string | null;
  /**
   * Path for the capabilities endpoint. Pass `null` or `""` to disable.
   * Default `/capabilities`.
   */
  capabilitiesPath?: string | null;
  /** Override capabilities advertised at {@link CreateStrandsAppOptions.capabilitiesPath}. */
  capabilities?: StrandsAguiCapabilitiesOverrides;
  /**
   * Cross-origin access policy. Omit it and no CORS middleware is installed at
   * all: the app answers with no `Access-Control-Allow-Origin` header, so a
   * browser refuses to hand any cross-origin response to the calling page.
   * Cross-origin access is opt-in because the agent route is unauthenticated
   * by default, and an allowed origin can invoke the agent, trigger whatever
   * side effects its tools have, and read the streamed response back.
   *
   * Pass a value to opt in. Any value that installs the middleware also loads
   * the optional `cors` peer dependency, so it has to be installed:
   * - `false` or `""`: same as omitting the option, no middleware and no CORS
   *   response headers.
   * - `"*"`: emitted verbatim as `Access-Control-Allow-Origin: *`, which is
   *   convenient for local development.
   * - a single origin string: a fixed origin, not an allowlist. `cors` emits it
   *   verbatim to every caller, whichever origin asked, without ever comparing
   *   the request's `Origin` against it.
   * - an array of origins: the exact-match form. The request's `Origin` has to
   *   equal an entry, and a miss withholds `Access-Control-Allow-Origin`. `[]`
   *   denies every origin, yet still installs the middleware, so preflights
   *   are answered with `204` and the default permissive method list while
   *   `Access-Control-Allow-Origin` is withheld. An array containing `"*"` is
   *   normalized to the bare `"*"`, so `["*"]` means allow-all as it does in
   *   Python rather than matching the literal one-character string.
   * - `true`: reflects the request's `Origin` header back per-request, a more
   *   permissive posture than `"*"`.
   *
   * Credentials are derived rather than fixed, from the resolved value and
   * from the calling origin. A policy carries them only if it names a site to
   * begin with, which rules out a literal `"*"`, an empty string, an empty
   * array and a lone `"null"`; a request carries them only if its own `Origin`
   * names a site, which rules out `null` whichever policy admitted it. There
   * is no way to override either half. Three consequences worth reading before
   * picking a value:
   * - `true` is the value to be careful with, not `"*"`. A reflected origin
   *   does carry credentials, so `true` lets a page on any site make a
   *   credentialed call to the agent route and read the stream back. On a route
   *   with no {@link CreateStrandsAppOptions.auth} guard that is every site the
   *   browser visits. Prefer an exact-match array.
   * - `"*"` fails in the safer direction. It withholds credentials, and the
   *   CORS protocol tells browsers to reject a literal wildcard combined with
   *   them anyway, so it only ever serves requests that send none. Name the
   *   origins explicitly when the browser has to send them.
   * - `"null"` is the Origin a browser sends from a sandboxed iframe, a
   *   `file://` page and some redirect chains, and it belongs to no site, so
   *   nothing distinguishes one such caller from another. Listing it still
   *   admits those callers, and the rest of an allowlist holding it is
   *   unaffected, but they are never credentialed: not through a list naming
   *   `"null"`, not through a reflection under `true`, and not through a fixed
   *   origin string echoed at them.
   */
  corsOrigin?: string | string[] | boolean;
  /**
   * Veto over {@link CreateStrandsAppOptions.corsOrigin}, for callers that
   * compute the origin policy somewhere else (an env var, shared config) and
   * want one independent switch to turn cross-origin access off.
   *
   * - `false`: no CORS middleware, whatever `corsOrigin` says. Identical on the
   *   wire to `corsOrigin: false`, and it also silences `allowMethods` /
   *   `allowHeaders`.
   * - `undefined` (default): `corsOrigin` alone decides.
   * - `true`: asserts that CORS is wanted, and only agrees with a truthy
   *   `corsOrigin`. There is no origin policy to enable on its own, so
   *   `corsEnabled: true` without one throws instead of installing anything:
   *   this option can never widen access by itself.
   */
  corsEnabled?: boolean;
  /**
   * Narrow the methods a cross-origin caller may preflight, passed straight to
   * `cors` as `methods`. Omit it to keep the `cors` default,
   * `GET,HEAD,PUT,PATCH,POST,DELETE`.
   *
   * `[]` is a deny-all, not a request for the default. An empty array is
   * truthy, so it reaches `cors`, which then withholds
   * `Access-Control-Allow-Methods` entirely rather than sending it empty. The
   * preflight still answers `204` with an intact
   * `Access-Control-Allow-Origin`, so nothing on the wire looks broken while
   * every cross-origin call is blocked. That mirrors `corsOrigin: []` and is
   * deliberate; construction warns so it is not discovered from a browser
   * console.
   *
   * Only meaningful alongside a truthy {@link CreateStrandsAppOptions.corsOrigin};
   * passing it with no origin policy throws rather than silently doing nothing.
   */
  allowMethods?: string[];
  /**
   * Narrow the request headers a cross-origin caller may send, passed straight
   * to `cors` as `allowedHeaders`. Omit it to keep the `cors` default, which
   * reflects the preflight's own `Access-Control-Request-Headers` back and adds
   * `Vary: Access-Control-Request-Headers`.
   *
   * A narrowed list has to include `Content-Type`. The agent route answers
   * `415` to any request that does not carry a JSON `Content-Type`, and
   * `application/json` is not a CORS-safelisted request header value, so a
   * browser will not send it unless the preflight permitted `Content-Type`. A
   * list that leaves it off blocks every cross-origin agent call while the
   * preflight still answers `204` with the narrowed list. Server-side callers
   * are unaffected, since CORS never applies to them.
   *
   * `[]` is the same deny-all as for
   * {@link CreateStrandsAppOptions.allowMethods}:
   * `Access-Control-Allow-Headers` is withheld entirely and construction warns.
   *
   * Only meaningful alongside a truthy {@link CreateStrandsAppOptions.corsOrigin};
   * passing it with no origin policy throws rather than silently doing nothing.
   */
  allowHeaders?: string[];
  /**
   * Guard for the agent route. Omitted, the agent route is unauthenticated,
   * which is why cross-origin access is opt-in above.
   *
   * The ping and capabilities routes stay open either way: health probes have
   * to keep working, and the capabilities document is a static matrix of what
   * this adapter supports, not user data.
   *
   * @see StrandsAuthMiddleware for the contract the middleware has to honour.
   */
  auth?: StrandsAuthMiddleware;
}

/**
 * A failure to resolve the `cors` specifier itself, in the phrasings the
 * loaders in play produce:
 * - `Cannot find package 'cors'`, Node's ESM loader.
 * - `Cannot find module 'cors'`, a `require` once a downstream bundler
 *   downlevels the dynamic import.
 * - `Could not resolve "cors"`, esbuild and the Vite / Rollup build.
 * - `Failed to resolve import "cors"` and `Failed to resolve module specifier
 *   "cors"`, Vite's dev-server and browser paths. Lower-cased mid-sentence in
 *   Vite's build wrapper (`Rollup failed to resolve import "cors"`), hence the
 *   case-insensitive `f`.
 * - `Can't resolve 'cors'`, webpack. `Cannot resolve` is accepted alongside it
 *   for the loaders that spell it that way.
 *
 * None of the bundler phrasings set an error code, which is why this matches on
 * wording rather than on `error.code`. Matching on `cors` being the named
 * specifier is what keeps a resolution failure raised from *inside* `cors`,
 * naming one of its own dependencies, out of this bucket: those are a broken
 * install of `cors` rather than a missing one, and the friendly message would
 * send the caller the wrong way.
 */
const UNRESOLVED_CORS_MODULE =
  /(?:Cannot find (?:package|module)|Could not resolve|Ca(?:n'|nno)t resolve|[Ff]ailed to resolve (?:import|module specifier))\s+['"]cors['"]/;

const CORS_PEER_MISSING =
  "`corsOrigin` was passed to createStrandsApp, but the optional peer " +
  "dependency `cors` could not be resolved. Install it (`pnpm add cors`, " +
  "plus `pnpm add -D @types/cors` for TypeScript), or omit `corsOrigin` to " +
  "run with no CORS middleware and no cross-origin access.";

/**
 * Load the optional `cors` peer dependency.
 *
 * Unresolvable means the caller opted into cross-origin access without
 * installing the peer, so it becomes an error naming both. Anything else,
 * including a genuine bug inside `cors`, is rethrown untouched.
 */
async function loadCors(): Promise<typeof import("cors")> {
  try {
    const corsModule = await import("cors");
    return (corsModule.default ?? corsModule) as typeof import("cors");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!UNRESOLVED_CORS_MODULE.test(message)) throw error;
    throw new Error(CORS_PEER_MISSING, { cause: error });
  }
}

/**
 * Every key `CreateStrandsAppOptions` accepts. An unknown key is refused rather
 * than ignored: TypeScript's excess-property check only fires on object
 * literals in TypeScript, so a JavaScript caller, a spread, or an `any` can
 * misspell a security option and silently get the insecure default. `autth`
 * instead of `auth` would leave the agent route unguarded.
 */
const CREATE_STRANDS_APP_OPTION_KEYS = [
  "path",
  "pingPath",
  "capabilitiesPath",
  "capabilities",
  "corsOrigin",
  "corsEnabled",
  "allowMethods",
  "allowHeaders",
  "auth",
] as const;

const CREATE_STRANDS_APP_OPTION_KEY_SET = new Set<string>(
  CREATE_STRANDS_APP_OPTION_KEYS,
);

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every((item) => typeof item === "string")
  );
}

function assertCreateStrandsAppOption(
  option: string,
  value: unknown,
  valid: boolean,
  expected: string,
): void {
  if (!valid) {
    const received =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new TypeError(
      `createStrandsApp option \`${option}\` must be ${expected}; received ${received}.`,
    );
  }
}

function assertCreateStrandsAppOptions(
  options: unknown,
): asserts options is CreateStrandsAppOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("createStrandsApp options must be an object.");
  }

  const values = options as Record<string, unknown>;
  const unknown = Object.keys(values).filter(
    (key) => !CREATE_STRANDS_APP_OPTION_KEY_SET.has(key),
  );
  if (unknown.length > 0) {
    const plural = unknown.length === 1 ? "option" : "options";
    throw new Error(
      `createStrandsApp received unknown ${plural} ${unknown
        .map((key) => `\`${key}\``)
        .join(", ")}. A misspelled option would be ignored, and for a ` +
        `security option that means silently running without it. Valid options ` +
        `are ${CREATE_STRANDS_APP_OPTION_KEYS.map((key) => `\`${key}\``).join(", ")}.`,
    );
  }

  assertCreateStrandsAppOption(
    "path",
    values.path,
    values.path === undefined || typeof values.path === "string",
    "a string or undefined",
  );
  for (const option of ["pingPath", "capabilitiesPath"] as const) {
    const value = values[option];
    assertCreateStrandsAppOption(
      option,
      value,
      value === undefined || value === null || typeof value === "string",
      "a string, null, or undefined",
    );
  }
  assertCreateStrandsAppOption(
    "capabilities",
    values.capabilities,
    values.capabilities === undefined ||
      (typeof values.capabilities === "object" &&
        values.capabilities !== null &&
        !Array.isArray(values.capabilities)),
    "an object or undefined",
  );
  assertCreateStrandsAppOption(
    "corsOrigin",
    values.corsOrigin,
    values.corsOrigin === undefined ||
      typeof values.corsOrigin === "string" ||
      typeof values.corsOrigin === "boolean" ||
      isStringArray(values.corsOrigin),
    "a string, boolean, string array, or undefined",
  );
  assertCreateStrandsAppOption(
    "corsEnabled",
    values.corsEnabled,
    values.corsEnabled === undefined || typeof values.corsEnabled === "boolean",
    "a boolean or undefined",
  );
  for (const option of ["allowMethods", "allowHeaders"] as const) {
    const value = values[option];
    assertCreateStrandsAppOption(
      option,
      value,
      value === undefined || isStringArray(value),
      "a string array or undefined",
    );
  }
  assertCreateStrandsAppOption(
    "auth",
    values.auth,
    values.auth === undefined || typeof values.auth === "function",
    "a function or undefined",
  );
}

/**
 * A CORS option that only means something once the middleware is installed,
 * passed with nothing to install it. Silently ignoring it would leave the
 * caller believing cross-origin access is configured, so name what was passed
 * and what it needs.
 */
function corsOptionsWithoutOrigin(names: string[]): string {
  return (
    `${names.join(", ")} ${names.length === 1 ? "was" : "were"} passed to ` +
    "createStrandsApp with no `corsOrigin` policy. CORS middleware is only " +
    "installed for a truthy `corsOrigin`, and there is no wildcard default. " +
    "Pass the origins your frontend is served from (e.g. `corsOrigin: " +
    '["http://localhost:3000"]`), or drop these options to run with no CORS ' +
    "middleware and no cross-origin access."
  );
}

/**
 * Say out loud that a narrowing option denies everything.
 *
 * `allowMethods: []` / `allowHeaders: []` are truthy, so they reach `cors`,
 * which withholds the corresponding header rather than sending it empty. That
 * is intended, and parallel to `corsOrigin: []`, but nothing on the wire hints
 * at it: the preflight still answers `204` with an intact
 * `Access-Control-Allow-Origin`, so the only symptom is a console message in
 * the caller's browser. Cheaper to hear it once at startup.
 */
function warnEmptyNarrowing(option: string, header: string): void {
  console.warn(
    `\`${option}: []\` was passed to createStrandsApp. An empty array is a ` +
      "deny-all rather than a request for the `cors` default, so " +
      `\`${header}\` is withheld entirely and every cross-origin call is ` +
      "blocked while preflights still answer 204. Omit the option to keep " +
      "the `cors` default, or list the values you mean to allow.",
  );
}

/**
 * Reduce an origin option to the form the `cors` package actually honours.
 *
 * `cors` compares array entries to the request Origin by string equality, so
 * a `"*"` sitting inside an array never matches and denies every origin,
 * where Starlette reads the same value as allow-all. Collapse that spelling
 * to the bare string, which `cors` does treat as a wildcard.
 *
 * An empty array is left alone. It denies every origin here, which is what an
 * empty allow-list should mean, and widening it would turn a deliberate
 * deny-all into allow-all. Python's `origins or ["*"]` does coerce an empty
 * list to a wildcard, but that is a falsy-coercion quirk to fix on that side,
 * not a contract to mirror into this one.
 */
function normalizeCorsOrigin(
  origin: string | string[] | boolean,
): string | string[] | boolean {
  if (!Array.isArray(origin)) return origin;
  if (origin.includes("*")) return "*";
  return origin;
}

/**
 * The Origin a browser sends when the calling page belongs to no site: from a
 * sandboxed iframe, a `file://` page and some redirect chains.
 *
 * Credentials granted against it are granted to whatever can present it, which
 * is the same objection as for `"*"`, except that browsers reject the wildcard
 * pairing outright and honour this one. So it is refused on both sides of the
 * decision below: a policy that names nothing else cannot carry credentials,
 * and no individual request from this origin carries them either.
 *
 * Compared exactly, because that is the only spelling a browser can send:
 * `cors` matches allowlist entries with `===` and a browser compares the
 * allow-origin header against its own origin serialization byte for byte, so
 * any other casing or a trailing slash matches nothing and grants nothing.
 */
const NULL_ORIGIN = "null";

/**
 * Whether the origin policy names a site credentials could belong to.
 *
 * Half of the decision, and the request-independent half: a policy naming
 * nothing but `"*"`, `"null"` or nothing at all can never carry credentials,
 * whoever calls. The other half is {@link requestAllowsCredentials}, which is
 * what keeps a policy that does name a site from extending its credentials to
 * a caller that is not one. Splitting them is what lets `["null", "https://
 * a.tld"]` stay a working allowlist: `cors` is given a `credentials` value per
 * request rather than one for the whole policy, so the named site keeps its
 * credentials and only the null caller is refused.
 *
 * The Python adapter refuses the same two values, via
 * `allow_credentials=bool(origins) and not {"*", "null"}.intersection(...)`,
 * but has only this half: Starlette takes one `allow_credentials` for the
 * whole policy, so a list holding `"null"` there loses credentials for every
 * origin beside it.
 *
 * Call this on the output of {@link normalizeCorsOrigin}, so the wildcard
 * spellings have already collapsed to `"*"`.
 */
function policyAllowsCredentials(origin: string | string[] | boolean): boolean {
  // `false` turns the middleware off; `""` leaves no origin to grant
  // credentials against.
  if (typeof origin === "string")
    return origin !== "" && origin !== "*" && origin !== NULL_ORIGIN;
  // A surviving array is an allow-list compared per caller; normalization has
  // already collapsed the wildcard spelling, and the wildcard check is kept as
  // a guard so calling this on an unnormalized value stays safe. One entry
  // naming a site is enough here, because the per-request half decides whether
  // this caller is that entry.
  if (Array.isArray(origin))
    return (
      origin.length > 0 &&
      !origin.includes("*") &&
      origin.some((entry) => entry !== NULL_ORIGIN)
    );
  // `true` reflects the caller's Origin, so the header carries whatever the
  // caller sent and credentials go with it. Permissive, but it is what the
  // caller asked for, and withholding them would break deployments that rely
  // on it. The per-request half is what stops the reflection from crediting an
  // origin that names no site.
  return origin === true;
}

/**
 * Whether this particular caller's Origin can be credentialed.
 *
 * The request half of the decision. Every policy shape can end up answering a
 * request from {@link NULL_ORIGIN}: `true` reflects it, an allowlist can name
 * it, and a fixed origin string is echoed to it. A request with no `Origin` at
 * all is not a cross-origin request and is unaffected.
 */
function requestAllowsCredentials(requestOrigin: string | undefined): boolean {
  return requestOrigin !== NULL_ORIGIN;
}

/** Create an Express app with a single Strands agent endpoint and optional ping endpoint. */
export async function createStrandsApp(
  agent: StrandsAgent,
  options: CreateStrandsAppOptions = {},
): Promise<import("express").Express> {
  assertCreateStrandsAppOptions(options);

  const {
    path = "/",
    pingPath = "/ping",
    capabilitiesPath = "/capabilities",
    capabilities,
    corsOrigin,
    corsEnabled,
    allowMethods,
    allowHeaders,
    auth,
  } = options;

  // `corsEnabled: false` vetoes every other CORS option; otherwise a truthy
  // `corsOrigin` is what installs the middleware. Anything that narrows a
  // policy which will never exist is a misconfiguration, not a no-op.
  // A falsy origin (omitted, `false`, `""`) and a `corsEnabled: false` veto
  // both resolve to no policy at all. Narrowing to `undefined` here rather
  // than testing a boolean keeps the origin's type usable below.
  const corsPolicy =
    corsEnabled === false ? undefined : corsOrigin || undefined;
  const installCors = corsPolicy !== undefined;
  if (!installCors && corsEnabled !== false) {
    const orphaned = [
      corsEnabled === true ? "`corsEnabled: true`" : null,
      allowMethods ? "`allowMethods`" : null,
      allowHeaders ? "`allowHeaders`" : null,
    ].filter((name): name is string => name !== null);
    if (orphaned.length > 0) {
      throw new Error(corsOptionsWithoutOrigin(orphaned));
    }
  }

  // Lazy dynamic imports so `express` is only required at runtime when
  // `createStrandsApp` is actually called, and `cors` only when the caller
  // opts into cross-origin access.
  const expressModule = await import("express");
  const express = (expressModule.default ??
    expressModule) as typeof import("express");

  const app = express();
  // Falsy origins (omitted, `false`, `""`) and `corsEnabled: false` install
  // nothing: their wire behaviour is identical to having no middleware, and
  // `cors` is an optional peer dependency that may not be installed. An empty
  // array is truthy, so a deny-all allowlist still goes through the middleware.
  if (installCors) {
    // Only warn once the middleware is actually going to be installed: a
    // `corsEnabled: false` veto silences these options, so an empty list there
    // is inert rather than a deny-all.
    if (allowMethods && allowMethods.length === 0) {
      warnEmptyNarrowing("allowMethods", "Access-Control-Allow-Methods");
    }
    if (allowHeaders && allowHeaders.length === 0) {
      warnEmptyNarrowing("allowHeaders", "Access-Control-Allow-Headers");
    }
    const cors = await loadCors();
    // Normalize before deciding credentials: `policyAllowsCredentials` expects
    // the wildcard spellings to have collapsed already.
    const resolvedCorsOrigin = normalizeCorsOrigin(corsPolicy);
    const policyCredentials = policyAllowsCredentials(resolvedCorsOrigin);
    const corsOptions = {
      origin: resolvedCorsOrigin,
      // Spread rather than pass `undefined`: `cors` merges the options object
      // over its defaults with `Object.assign`, so an explicit `undefined`
      // would clobber the default instead of falling back to it, and
      // `methods: undefined` then throws inside `cors` itself.
      ...(allowMethods ? { methods: allowMethods } : {}),
      ...(allowHeaders ? { allowedHeaders: allowHeaders } : {}),
    };
    // Options per request rather than one fixed object, because `credentials`
    // depends on who is calling and not only on the configured policy. The
    // origin policy itself is unchanged either way.
    app.use(
      cors((req, done) =>
        done(null, {
          ...corsOptions,
          credentials:
            policyCredentials && requestAllowsCredentials(req.headers.origin),
        }),
      ),
    );
  }
  // Keep auth, parsing, and dispatch in one route. Besides putting auth ahead
  // of body parsing, one route makes Express control flow safe: `next("route")`
  // skips the parser and agent together instead of falling through from an
  // auth-only route into an unguarded copy of the agent endpoint.
  const bodyParser = express.json({ limit: "50mb" });
  addStrandsExpressEndpoint(app, agent, { path, auth, bodyParser });

  // Preserve the factory's existing app-wide parsing for routes callers add
  // to the returned app. The agent route above owns its parser and finishes
  // before reaching this layer; a guard that deliberately calls
  // `next("route")` may still hand a parsed body to a later fallback route.
  app.use(bodyParser);

  if (pingPath) {
    addPing(app, pingPath);
  }

  if (capabilitiesPath) {
    addCapabilities(app, capabilitiesPath, { agent, overrides: capabilities });
  }

  return app;
}
