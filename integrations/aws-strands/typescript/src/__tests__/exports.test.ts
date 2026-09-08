/** Every public helper must be reachable from its package entry point. */

import { describe, it, expect } from "vitest";
import * as pkg from "../index";
import * as serverPkg from "../server";

describe("public export surface", () => {
  it("main entry exposes the adapter, proxy helpers, content helpers, and context helper", () => {
    const expected = [
      "StrandsAgent",
      "AWSStrandsAgent",
      "buildSnapshotMessages",
      "buildStrandsSeed",
      "convertMessagesForStrandsSeed",
      "INTERRUPT_CANCELLED",
      "buildContextExtras",
      "convertAguiContentToStrands",
      "flattenContentToText",
      "createProxyTool",
      "syncProxyTools",
      "isProxyTool",
      "syncTemplateTools",
      "parkedBatchToolNames",
      "DEFAULT_URL_FETCH_POLICY",
      "UrlFetchPolicyError",
    ];
    for (const name of expected) {
      expect(pkg).toHaveProperty(name);
      expect((pkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("server subpath exposes the Express transport helpers", () => {
    const expected = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
      "capabilitiesFor",
      "DEFAULT_CAPABILITIES",
    ];
    for (const name of expected) {
      expect(serverPkg).toHaveProperty(name);
      expect((serverPkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it("main entry does NOT expose server-side helpers (bundler safety)", () => {
    // Keeping these off the main entry lets client bundlers (Next.js, Vite)
    // trace this package without pulling in Express / cors.
    const serverOnly = [
      "createStrandsApp",
      "addStrandsExpressEndpoint",
      "addPing",
      "addCapabilities",
    ];
    for (const name of serverOnly) {
      expect(pkg).not.toHaveProperty(name);
    }
  });

  it("keeps the internal URL-fetch error off the public surface", () => {
    // The public class is the refusal a host can act on. Its counterpart,
    // UrlFetchUnavailableError, separates "could not reach a verdict" from
    // "refused" inside the fetch, and both are already turned into a logged
    // `null` before any caller sees either. The Python package exports no
    // equivalent, so exporting one here would be a surface the two adapters
    // do not share.
    expect(pkg).toHaveProperty("UrlFetchPolicyError");
    expect(pkg).not.toHaveProperty("UrlFetchUnavailableError");
  });

  it("exports the cancellation sentinel with the same shape as the Python package", () => {
    // A tool checks `.cancelled` on what it receives, so the value is part of
    // the contract, not just the name.
    expect(pkg.INTERRUPT_CANCELLED).toEqual({ cancelled: true });
  });

  it("exports the cancellation sentinel frozen", () => {
    // Frozen so a consumer cannot mutate the exported shape others match
    // against. Python keeps its own export a plain dict, because callers
    // serialize it, and builds each emitted answer fresh instead.
    expect(Object.isFrozen(pkg.INTERRUPT_CANCELLED)).toBe(true);
    expect(() => {
      (
        pkg.INTERRUPT_CANCELLED as unknown as Record<string, unknown>
      ).cancelled = false;
    }).toThrow();
    expect(pkg.INTERRUPT_CANCELLED).toEqual({ cancelled: true });
  });
});
