/**
 * Shared `CORS_ALLOW_ORIGINS` parsing for the TypeScript Strands examples.
 *
 * Both the all-in-one verification server (`server.ts`) and the standalone
 * example that opts into cross-origin access read the same variable, so the
 * parsing lives here once. Two details are easy to get wrong per call site and
 * fail silently when they are:
 *
 * - `cors` only treats `"*"` as a wildcard when it is the bare string. Inside
 *   an array it is a literal one-character origin string that no browser origin
 *   ever equals, so `["*"]` answers preflights with no
 *   `Access-Control-Allow-Origin` header at all and denies everything.
 * - a bare string other than `"*"` is a fixed origin echoed to every caller
 *   without comparing `Origin`, so an allowlist has to be an array.
 * - allowlist entries are compared to the request's `Origin` verbatim, so an
 *   entry that is not shaped like a browser origin (`https://app.tld/` with a
 *   trailing slash, `localhost:3000` with no scheme, `HTTPS://App.tld` in the
 *   wrong case) matches nothing at all while still reading like an allowed
 *   origin in the startup log.
 *
 * {@link corsPolicyFromEnv} returns a value that is correct for both, and
 * says out loud when the configuration denies more than the operator likely
 * intended.
 */

const WILDCARD = "*";

/**
 * Default when `CORS_ALLOW_ORIGINS` is unset: the two origins a locally run
 * dojo is served from. `pnpm start` / `pnpm dev` through
 * `apps/dojo/scripts/run-dojo-everything.js` pins `PORT=9999`, and a bare
 * `next dev` in `apps/dojo` lands on Next's default 3000.
 *
 * Nothing these servers exist for needs a permissive default. The curl parity
 * payloads send no `Origin` header, and the dojo calls in from its own Next
 * route handler rather than the browser, so neither path is subject to CORS at
 * all. The default is for anyone pointing a browser page here directly, and it
 * matters that it stops short of a wildcard, because the verification server
 * binds `0.0.0.0` and the port is reachable from the whole local network.
 */
export const DEFAULT_CORS_ALLOW_ORIGINS =
  "http://localhost:9999,http://localhost:3000";

export interface CorsPolicy {
  /**
   * Ready to hand to `cors` as its `origin` option, or to `createStrandsApp`
   * as `corsOrigin`. Either the bare `"*"` wildcard or an exact-match
   * allowlist, which may be empty to deny every origin.
   */
  origin: "*" | string[];
  /** One-line summary of {@link CorsPolicy.origin} for a startup log. */
  description: string;
}

/** Scheme, then `://`, as a browser serialises the start of an origin. */
const SCHEME_SEPARATOR = "://";

/**
 * Why *entry* can never equal a browser `Origin` header, or `null` when it can.
 *
 * `cors` compares an allowlist entry to the request's `Origin` with `===`, and a
 * browser serialises an origin as `scheme://host[:port]` with no trailing
 * slash, path, query or fragment. An entry outside that shape matches nothing
 * for the life of the process, which is worth saying out loud rather than
 * printing as an allowed origin.
 */
function originShapeProblem(entry: string): string | null {
  const separator = entry.indexOf(SCHEME_SEPARATOR);
  const scheme = separator === -1 ? "" : entry.slice(0, separator);
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    return "it has no `scheme://` prefix, which a browser `Origin` header always carries";
  }
  const authority = entry.slice(separator + SCHEME_SEPARATOR.length);
  if (authority === "") {
    return "it names no host after `://`";
  }
  if (/[/?#]/.test(authority)) {
    return "a browser `Origin` header is `scheme://host[:port]`, with no trailing slash, path, query or fragment";
  }
  if (entry !== entry.toLowerCase()) {
    return "a browser lowercases the scheme and host it sends in `Origin`, so an entry with uppercase letters never matches";
  }
  return null;
}

/**
 * Read `CORS_ALLOW_ORIGINS` (comma-separated, the same variable the Python
 * reference server reads) into a policy the `cors` middleware interprets as
 * written.
 *
 * Unset falls back to {@link DEFAULT_CORS_ALLOW_ORIGINS}. Set but empty allows
 * nothing: that is the safe direction, unlike the Python server which
 * wildcards instead, so it stays as it is and is reported rather than applied
 * silently.
 */
export function corsPolicyFromEnv(
  raw: string | undefined = process.env.CORS_ALLOW_ORIGINS,
): CorsPolicy {
  const entries = (raw ?? DEFAULT_CORS_ALLOW_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (entries.includes(WILDCARD)) {
    const named = entries.filter((origin) => origin !== WILDCARD);
    if (named.length > 0) {
      console.warn(
        `CORS_ALLOW_ORIGINS contains "*" alongside ${named.join(", ")}. ` +
          `"*" wins and those named origins are ignored, so every origin is ` +
          `allowed. Drop the "*" to enforce the allowlist.`,
      );
    }
    return { origin: WILDCARD, description: "* (any origin)" };
  }

  // Only reachable when the variable was set to something with no usable
  // entries, since the default is not empty.
  if (entries.length === 0) {
    console.warn(
      "CORS_ALLOW_ORIGINS is set but names no origin, so every cross-origin " +
        "browser request is denied. Set it to a comma-separated origin list, " +
        `or to "*" to allow any origin during local development, or unset it ` +
        `for the default (${DEFAULT_CORS_ALLOW_ORIGINS}).`,
    );
    return {
      origin: [],
      description: "none (CORS_ALLOW_ORIGINS is set but names no origin)",
    };
  }

  // Shape check rather than a filter: an unmatchable entry is left on the list
  // exactly as written, since dropping it would change the policy the operator
  // asked for. It is the silence that is the bug, not the entry surviving.
  const unmatchable = entries
    .map((origin) => ({ origin, problem: originShapeProblem(origin) }))
    .filter((entry): entry is { origin: string; problem: string } => {
      return entry.problem !== null;
    });
  if (unmatchable.length > 0) {
    const one = unmatchable.length === 1;
    console.warn(
      `CORS_ALLOW_ORIGINS names ${one ? "an entry" : "entries"} that can never ` +
        `match a browser Origin header, so ${one ? "it is" : "they are"} ` +
        "allowed in name only: " +
        unmatchable
          .map(({ origin, problem }) => `"${origin}" (${problem})`)
          .join("; ") +
        "." +
        (unmatchable.length === entries.length
          ? " Nothing else is on the list, so every cross-origin browser " +
            "request is denied."
          : ""),
    );
  }

  return { origin: entries, description: entries.join(", ") };
}
