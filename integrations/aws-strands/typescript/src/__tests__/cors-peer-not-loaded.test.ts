import { describe, it, expect, vi } from "vitest";

import { createStrandsApp, type CreateStrandsAppOptions } from "../server";
import { FixedAgent } from "./transport-harness";
import {
  ADMIN_ORIGIN,
  ALLOWED_ORIGIN,
  posturesWithoutMiddleware,
} from "./cors-postures";

/**
 * `cors` is an optional peer dependency, so an app that opts out of
 * cross-origin access must not import the module at all: a deployment that
 * never installed it has to boot.
 *
 * The counter below can only answer that question once. The `vi.mock` factory
 * runs on the first import of `cors` and vitest caches the result, so once any
 * construction in this module registry has opted in, every later count is
 * indistinguishable from a cached hit. That is why this lives in its own file
 * with a single test rather than as the first test of a larger suite: there,
 * the assertion would silently become vacuous the moment someone reordered the
 * file, and nothing would go red.
 */
const { moduleLoads } = vi.hoisted(() => ({ moduleLoads: { count: 0 } }));

vi.mock("cors", () => {
  moduleLoads.count += 1;
  return {
    default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

/**
 * Every option shape that must leave the optional peer unimported.
 *
 * The origin policies come from the measured posture table's
 * `installsMiddleware` column, so a posture added there as installing nothing
 * is checked here too. The `corsEnabled: false` shapes are appended: the veto
 * is an independent switch, not an origin policy the fixture measures.
 */
const OPTS_OUT: CreateStrandsAppOptions[] = [
  ...posturesWithoutMiddleware().map(([, options]) => options),
  { corsOrigin: ALLOWED_ORIGIN, corsEnabled: false },
  {
    corsOrigin: [ALLOWED_ORIGIN, ADMIN_ORIGIN],
    corsEnabled: false,
    allowMethods: ["POST"],
    allowHeaders: ["Content-Type"],
  },
];

describe("the optional cors peer is loaded lazily", () => {
  it("is never imported until an app opts into cross-origin access", async () => {
    for (const options of OPTS_OUT) {
      await createStrandsApp(new FixedAgent(), options);
    }
    expect(moduleLoads.count).toBe(0);

    // The second half is what keeps the first half honest. If the mock were
    // never wired up, or the specifier were spelled differently in the source,
    // the count would sit at 0 whatever the options were and the assertion
    // above would pass vacuously.
    await createStrandsApp(new FixedAgent(), { corsOrigin: ALLOWED_ORIGIN });
    expect(moduleLoads.count).toBe(1);
  });
});
