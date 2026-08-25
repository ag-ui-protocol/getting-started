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
import type { StrandsAguiCapabilitiesOverrides } from "./endpoint";

export {
  addStrandsExpressEndpoint,
  addPing,
  addCapabilities,
  capabilitiesFor,
  DEFAULT_CAPABILITIES,
} from "./endpoint";

export type {
  AddStrandsEndpointOptions,
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
   * Override CORS origin. Default `"*"` (wide-open, matches the Python adapter,
   * which configures Starlette `CORSMiddleware` with `allow_origins=["*"]`).
   *
   * Note: with the `cors` package, a literal `"*"` is emitted verbatim as
   * `Access-Control-Allow-Origin: *`, whereas `true` would reflect the request's
   * `Origin` header back per-request, a more permissive posture. Stick to `"*"`
   * to match the Python adapter.
   *
   * An array containing `"*"` is normalized to the bare `"*"`, so it means
   * allow-all as it does in Python. An empty array is left denying every
   * origin. Credentials follow from the resolved value: every concrete origin
   * enables them, including a reflected one, and only a literal `"*"` does
   * not.
   */
  corsOrigin?: string | string[] | boolean;
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
 * Whether credentialed cross-origin requests may be allowed for `origin`.
 *
 * Only a concrete origin qualifies, whether given as a single string or a
 * list. `Access-Control-Allow-Origin: *`
 * together with `Access-Control-Allow-Credentials: true` is a pairing browsers
 * reject outright, and `origin: true` reflects whatever Origin the caller sent,
 * which would extend credentials to every site. The Python adapter applies the
 * same rule via `allow_credentials=bool(origins) and not is_wildcard`.
 *
 * Call this on the output of {@link normalizeCorsOrigin}, so the wildcard
 * spellings have already collapsed to `"*"`.
 */
function allowsCredentials(origin: string | string[] | boolean): boolean {
  // `false` turns the middleware off; `""` leaves no origin to grant
  // credentials against. A literal `"*"` is the one value browsers refuse to
  // pair with credentials at all.
  if (typeof origin === "string") return origin !== "*" && origin !== "";
  // A surviving array is a concrete allow-list; normalization has already
  // collapsed the wildcard spelling. Kept as a guard rather than a bare
  // `true` so calling this on an unnormalized value stays safe.
  if (Array.isArray(origin)) return origin.length > 0 && !origin.includes("*");
  // `true` reflects the caller's Origin, so the header carries a concrete
  // origin and credentials are valid. Permissive, but it is what the caller
  // asked for, and withholding them would break deployments that rely on it.
  return origin === true;
}

/** Create an Express app with a single Strands agent endpoint and optional ping endpoint. */
export async function createStrandsApp(
  agent: StrandsAgent,
  options: CreateStrandsAppOptions = {},
): Promise<import("express").Express> {
  const {
    path = "/",
    pingPath = "/ping",
    capabilitiesPath = "/capabilities",
    capabilities,
    corsOrigin = "*",
  } = options;

  // Lazy dynamic imports so `express` / `cors` are only required at runtime
  // when `createStrandsApp` is actually called.
  const expressModule = await import("express");
  const corsModule = await import("cors");
  const express = (expressModule.default ??
    expressModule) as typeof import("express");
  const cors = (corsModule.default ?? corsModule) as typeof import("cors");

  const app = express();
  const resolvedCorsOrigin = normalizeCorsOrigin(corsOrigin);
  app.use(
    cors({
      origin: resolvedCorsOrigin,
      credentials: allowsCredentials(resolvedCorsOrigin),
    }),
  );
  app.use(express.json({ limit: "50mb" }));

  addStrandsExpressEndpoint(app, agent, { path });

  if (pingPath) {
    addPing(app, pingPath);
  }

  if (capabilitiesPath) {
    addCapabilities(app, capabilitiesPath, { agent, overrides: capabilities });
  }

  return app;
}
