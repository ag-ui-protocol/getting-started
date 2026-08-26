import { describe, it, expect, vi } from "vitest";

import { createStrandsApp } from "../server";
import { FixedAgent } from "./transport-harness";
import { ALLOWED_ORIGIN } from "./cors-postures";

/**
 * The failure a caller who opts into cross-origin access without installing
 * the optional `cors` peer actually hits.
 *
 * The message the loaders produce differs by loader (Node's ESM loader says
 * "Cannot find package", a `require` downlevelled by a downstream bundler says
 * "Cannot find module", and the Vite family says `Could not resolve` while
 * setting no error code at all), so the adapter matches on the phrasing rather
 * than on `error.code`. Each phrasing gets a row below, and a failure raised
 * from inside `cors` about one of its own dependencies gets a row proving it is
 * not mistaken for a missing `cors`.
 *
 * The loader failure is simulated by a namespace whose `default` getter throws
 * rather than by a factory that throws: vitest replaces an error thrown from a
 * `vi.mock` factory with its own "error when mocking a module" message, which
 * would make every row here assert against that instead of the adapter. The
 * code path is the same one either way, since `loadCors` reads `.default`
 * inside the same `try` that wraps the import.
 */
const failing = { message: "" };

vi.mock("cors", () => ({
  get default() {
    throw new Error(failing.message);
  },
}));

const EXPECTED_MESSAGE =
  "`corsOrigin` was passed to createStrandsApp, but the optional peer " +
  "dependency `cors` could not be resolved. Install it (`pnpm add cors`, " +
  "plus `pnpm add -D @types/cors` for TypeScript), or omit `corsOrigin` to " +
  "run with no CORS middleware and no cross-origin access.";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error,
  );
  if (error === null) throw new Error("expected the factory to reject");
  return error;
}

describe("a missing cors peer names itself and the fix", () => {
  it.each([
    [
      "Node's ESM loader",
      "Cannot find package 'cors' imported from /a/server.mjs",
    ],
    [
      "a downlevelled require",
      "Cannot find module 'cors'\nRequire stack:\n- /a/server.js",
    ],
    [
      "the Vite family",
      'Could not resolve "cors" imported by "@ag-ui/aws-strands". Is it installed?',
    ],
  ])("replaces the wording %s produces", async (_label, loaderMessage) => {
    failing.message = loaderMessage;
    const error = await rejection(
      createStrandsApp(new FixedAgent(), { corsOrigin: ALLOWED_ORIGIN }),
    );
    // Verbatim, backticks included: this string is what the operator reads.
    expect(error.message).toBe(EXPECTED_MESSAGE);
    // The original failure is kept rather than discarded, so the loader and
    // the path it tried are still recoverable.
    expect(((error as { cause?: Error }).cause as Error).message).toBe(
      loaderMessage,
    );
  });

  it("rethrows a resolution failure raised from inside cors untouched", async () => {
    // `cors` depends on `vary`. A failure naming one of its own dependencies
    // is a broken install of `cors`, not a missing `cors`, and telling the
    // caller to install `cors` would send them the wrong way.
    failing.message = "Cannot find package 'vary' imported from /a/cors.js";
    const error = await rejection(
      createStrandsApp(new FixedAgent(), { corsOrigin: ALLOWED_ORIGIN }),
    );
    expect(error.message).toBe(failing.message);
    expect(error.message).not.toBe(EXPECTED_MESSAGE);
  });

  it("never reaches the loader when the app opts out", async () => {
    failing.message = "Cannot find package 'cors' imported from /a/server.mjs";
    // The same broken install, with no `corsOrigin`: the app still boots,
    // which is the whole point of the peer being optional.
    const app = await createStrandsApp(new FixedAgent(), { corsOrigin: false });
    expect(typeof app.listen).toBe("function");
  });
});
