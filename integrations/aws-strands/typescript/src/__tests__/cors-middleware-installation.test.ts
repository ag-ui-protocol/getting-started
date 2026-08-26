import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AddressInfo } from "net";

import { createStrandsApp, type CreateStrandsAppOptions } from "../server";
import { FixedAgent, closeServer, listen } from "./transport-harness";
import {
  ADMIN_ORIGIN,
  ALLOWED_ORIGIN,
  posturesWithMiddleware,
  posturesWithoutMiddleware,
} from "./cors-postures";

/** Stamped by the mock middleware, so a real request can prove it is mounted. */
const MOCK_HEADER = "x-cors-mock";

// `cors` is an optional peer dependency, so an app that opts out of
// cross-origin access must not even construct the middleware. Mocking it makes
// two things observable that the wire cannot distinguish: `corsFactory` counts
// middleware construction and records the exact options object handed to
// `cors`, and the middleware it returns stamps a header so a request through
// the returned app shows whether it was actually mounted. Whether the module is
// imported at all is a third question, and it lives in its own file
// (`cors-peer-not-loaded.test.ts`) because the answer is only observable while
// nothing in the module registry has opted in yet.
const { corsFactory } = vi.hoisted(() => ({
  corsFactory: vi.fn(
    (_options: Record<string, unknown>) =>
      (
        _req: unknown,
        res: { setHeader: (name: string, value: string) => void },
        next: () => void,
      ) => {
        // Read at request time, so this hoisted factory can still share the
        // constant declared above it.
        res.setHeader(MOCK_HEADER, "1");
        next();
      },
  ),
}));

vi.mock("cors", () => ({ default: corsFactory }));

/**
 * Drive one real request through the app and return its response headers.
 *
 * Middleware runs ahead of the routes, so any mounted middleware stamps its
 * header even on this plain GET. Constructing the middleware without mounting
 * it leaves the header absent.
 */
async function headersFromRequest(
  app: import("express").Express,
): Promise<Headers> {
  const server = await listen(app);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    await res.text();
    return res.headers;
  } finally {
    await closeServer(server);
  }
}

/**
 * Every option shape that must leave the optional peer untouched.
 *
 * The falsy-origin rows are the ones that close the guard seam, and they come
 * from the measured posture table rather than being restated here: the factory
 * guard is `Boolean(corsOrigin)`, and nothing on the wire can tell it apart
 * from `corsOrigin !== undefined`, because `cors` itself skips a falsy origin
 * without emitting or short-circuiting anything. A widened guard would install
 * middleware that behaves identically and only surface as a hard failure on a
 * deployment that never installed the peer. Constructing the middleware is the
 * only observable difference, which is what these rows assert, so a posture
 * added to the fixture as installing nothing is covered here automatically.
 *
 * The `corsEnabled: false` rows are appended rather than derived: the veto is
 * a second, independent switch, and the fixture measures origin policies.
 */
const NOT_INSTALLED: [string, CreateStrandsAppOptions][] = [
  ...posturesWithoutMiddleware(),
  [
    "`corsEnabled: false` vetoes a single-origin policy",
    { corsOrigin: ALLOWED_ORIGIN, corsEnabled: false },
  ],
  [
    "`corsEnabled: false` vetoes an allowlist and its narrowing options",
    {
      corsOrigin: [ALLOWED_ORIGIN, ADMIN_ORIGIN],
      corsEnabled: false,
      allowMethods: ["POST"],
      allowHeaders: ["Content-Type"],
    },
  ],
];

/**
 * Option shapes that do install the middleware, with the exact option object
 * `cors` must receive.
 *
 * Neither key is a copy of what the caller passed. `origin` is the output of
 * `normalizeCorsOrigin`, so an array holding `"*"` arrives here as the bare
 * string `"*"` however many other entries it had, and `credentials` is derived
 * from that resolved origin by `allowsCredentials`: `true` only for a policy
 * naming at least one specific origin, which rules out `"*"`, `[]` and every
 * array that collapsed to `"*"`. This is the one file that pins both, so the
 * rows below are the boundary between the option a caller wrote and the option
 * `cors` acts on.
 *
 * Written out rather than derived from the posture table: deriving the expected
 * object would compute it the same way the source does, and a test that
 * recomputes the implementation cannot catch the implementation changing.
 * `covers every posture ...` below is what keeps the hand-written list from
 * falling behind the fixture.
 *
 * The key list is asserted separately from the values because `toEqual`
 * semantics treat an explicit `undefined` value as an absent key, and the
 * difference is load-bearing: `cors` merges options over its defaults with
 * `Object.assign`, so `methods: undefined` clobbers the default and then
 * throws inside `configureMethods`, answering 500 with an HTML stack page.
 */
const INSTALLED: [string, CreateStrandsAppOptions, Record<string, unknown>][] =
  [
    [
      "a single origin",
      { corsOrigin: ALLOWED_ORIGIN },
      { origin: ALLOWED_ORIGIN, credentials: true },
    ],
    [
      // Not collapsed: only an array holding `"*"` becomes a string, and an
      // empty one holds nothing. It reaches `cors` as the empty allowlist it
      // is, with credentials off because it names no origin.
      "a deny-all empty array",
      { corsOrigin: [] },
      { origin: [], credentials: false },
    ],
    [
      "an exact-match allowlist",
      { corsOrigin: [ALLOWED_ORIGIN, ADMIN_ORIGIN] },
      { origin: [ALLOWED_ORIGIN, ADMIN_ORIGIN], credentials: true },
    ],
    [
      "the literal wildcard",
      { corsOrigin: "*" },
      { origin: "*", credentials: false },
    ],
    [
      // Collapsed to the bare string before `cors` sees it, which is why the
      // expected `origin` is not the array that was passed in.
      "an array holding only the literal wildcard",
      { corsOrigin: ["*"] },
      { origin: "*", credentials: false },
    ],
    [
      // The concrete entry is dropped along with the array itself: one `"*"`
      // anywhere collapses the whole list, so this is byte-identical to the
      // row above and no allowlist ever reaches `cors`.
      "an array holding the literal wildcard beside a concrete origin",
      { corsOrigin: ["*", ALLOWED_ORIGIN] },
      { origin: "*", credentials: false },
    ],
    [
      // Reflection names a specific origin per request, so credentials stay on.
      "origin reflection",
      { corsOrigin: true },
      { origin: true, credentials: true },
    ],
    [
      "`corsEnabled: true` alongside an origin",
      { corsOrigin: ALLOWED_ORIGIN, corsEnabled: true },
      { origin: ALLOWED_ORIGIN, credentials: true },
    ],
    [
      "a narrowed method list",
      { corsOrigin: ALLOWED_ORIGIN, allowMethods: ["POST"] },
      { origin: ALLOWED_ORIGIN, credentials: true, methods: ["POST"] },
    ],
    [
      "a narrowed header list",
      { corsOrigin: ALLOWED_ORIGIN, allowHeaders: ["Content-Type"] },
      {
        origin: ALLOWED_ORIGIN,
        credentials: true,
        allowedHeaders: ["Content-Type"],
      },
    ],
    [
      "both narrowing options, including empty lists",
      { corsOrigin: ALLOWED_ORIGIN, allowMethods: [], allowHeaders: [] },
      {
        origin: ALLOWED_ORIGIN,
        credentials: true,
        methods: [],
        allowedHeaders: [],
      },
    ],
  ];

describe("createStrandsApp CORS middleware installation", () => {
  beforeEach(() => {
    corsFactory.mockClear();
  });

  it.each(NOT_INSTALLED)(
    "constructs and mounts no CORS middleware when %s",
    async (_label, options) => {
      const app = await createStrandsApp(new FixedAgent(), options);
      expect(corsFactory).not.toHaveBeenCalled();
      const headers = await headersFromRequest(app);
      expect(headers.get(MOCK_HEADER)).toBeNull();
    },
  );

  it.each(INSTALLED)(
    "constructs and mounts CORS middleware for %s",
    async (_label, options, expectedOptions) => {
      const app = await createStrandsApp(new FixedAgent(), options);
      expect(corsFactory).toHaveBeenCalledTimes(1);
      const passed = corsFactory.mock.calls[0]![0];
      // Key set first: an explicit `undefined` for a key `cors` merges over
      // its own default is the failure mode this guards, and a value
      // comparison cannot see it.
      expect(Object.keys(passed).sort()).toEqual(
        Object.keys(expectedOptions).sort(),
      );
      expect(passed).toEqual(expectedOptions);
      // Constructing the middleware is not installing it: only a request
      // through the returned app shows that it was handed to `app.use`.
      const headers = await headersFromRequest(app);
      expect(headers.get(MOCK_HEADER)).toBe("1");
    },
  );

  it("covers every posture the fixture measures as installing middleware", () => {
    // The gate on the hand-written list above. `installsMiddleware` is the one
    // place a posture declares which half of this file it belongs to, so a
    // posture added there as installing the middleware, with no row asserting
    // what `cors` is handed for it, fails here instead of going unchecked.
    const covered = INSTALLED.map(([, options]) =>
      JSON.stringify(options.corsOrigin ?? null),
    );
    for (const [label, options] of posturesWithMiddleware()) {
      expect(covered, `no INSTALLED row for the ${label} posture`).toContain(
        JSON.stringify(options.corsOrigin ?? null),
      );
    }
  });
});
