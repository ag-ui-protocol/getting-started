import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";

import {
  createStrandsApp,
  type CreateStrandsAppOptions,
  type StrandsAuthMiddleware,
} from "../server";
import {
  FixedAgent,
  getPath,
  postRaw,
  postRun,
  preflight,
  startApp,
  type CorsHeaders,
} from "./transport-harness";
import {
  ALLOWED_ORIGIN,
  CORS_POSTURES,
  DEFAULT_ALLOW_METHODS,
  OTHER_ORIGIN,
  PROBE_REQUEST_HEADERS,
  fixtureReadmeValues,
  parseReadmeCorsOriginValues,
  postureByLabel,
  type MeasuredResponse,
} from "./cors-postures";

/**
 * Compare a real response against a measured expectation.
 *
 * Built as one object comparison rather than a header at a time so a posture
 * cannot quietly grow an unasserted header, and so a test cannot pass by
 * restating the line above it. Every header is asserted for every posture,
 * `Access-Control-Allow-Credentials` included: the factory derives it from the
 * resolved origin, so its value is fixed per posture and an absent header is a
 * measured `null` rather than something left unchecked.
 */
function expectHeaders(actual: CorsHeaders, expected: MeasuredResponse): void {
  const project = (h: MeasuredResponse) => ({
    status: h.status,
    allowOrigin: h.allowOrigin,
    allowCredentials: h.allowCredentials,
    allowMethods: h.allowMethods,
    allowHeaders: h.allowHeaders,
    vary: h.vary,
  });
  expect(project(actual)).toEqual(project(expected));
}

const POSTURE_CASES = CORS_POSTURES.map(
  (posture) => [posture.label, posture] as const,
);

describe("corsOrigin postures on the preflight", () => {
  it.each(POSTURE_CASES)(
    "answers a preflight as measured for %s",
    async (_label, posture) => {
      const { port, close } = await startApp(posture.options);
      try {
        expectHeaders(
          await preflight(port, ALLOWED_ORIGIN, {
            requestHeaders: PROBE_REQUEST_HEADERS,
          }),
          posture.preflight,
        );
        expectHeaders(
          await preflight(port, OTHER_ORIGIN),
          posture.preflightFromOther,
        );
      } finally {
        await close();
      }
    },
  );

  // Narrower than "no route dispatches on OPTIONS", which this counter cannot
  // see. No OPTIONS route is registered, but a preflight that did reach the
  // agent route would be turned away by the JSON media-type check ahead of the
  // agent and leave the counter at 0 anyway. What detects an OPTIONS route
  // appearing is the status column asserted above: Express's own responder
  // answers 200, `cors` answers 204, and the agent route would answer 415. So
  // this is the end-to-end claim only: whatever the origin policy, a preflight
  // never reaches the agent.
  it.each(POSTURE_CASES)(
    "never reaches the agent on a preflight for %s",
    async (_label, posture) => {
      const { port, agent, close } = await startApp(posture.options);
      try {
        await preflight(port, ALLOWED_ORIGIN);
        expect(agent.runs).toBe(0);
      } finally {
        await close();
      }
    },
  );
});

// A preflight is only the gate. These assert the header on the response that
// actually carries the agent's output, which is the one a browser checks before
// handing that output to the calling page.
describe("corsOrigin postures on the agent response", () => {
  it.each(POSTURE_CASES)(
    "answers the agent POST as measured for %s",
    async (_label, posture) => {
      const { port, agent, close } = await startApp(posture.options);
      try {
        const res = await postRun(port, { origin: ALLOWED_ORIGIN });
        // The agent runs either way; the CORS headers decide whether the
        // caller's browser is allowed to read what it produced.
        expect(agent.runs).toBe(1);
        expect(res.body).toContain("RUN_STARTED");
        expectHeaders(res, posture.simple);
      } finally {
        await close();
      }
    },
  );

  it.each(POSTURE_CASES)(
    "answers the agent POST from a disallowed origin as measured for %s",
    async (_label, posture) => {
      const { port, agent, close } = await startApp(posture.options);
      try {
        const res = await postRun(port, { origin: OTHER_ORIGIN });
        // Nothing server-side refuses this caller: the run happens and the
        // stream is written whatever the origin policy says. The policy only
        // decides what the header on the way back claims, which is what the
        // browser then compares against the calling page's own origin. This is
        // where a fixed origin echoed verbatim separates from an allowlist
        // compared per call, and from `true` reflecting the caller.
        expect(agent.runs).toBe(1);
        expect(res.body).toContain("RUN_STARTED");
        expectHeaders(res, posture.simpleFromOther);
      } finally {
        await close();
      }
    },
  );
});

// The middleware is mounted app-wide with `app.use`, ahead of every route, so
// the health and capability probes carry the same policy as the agent route.
describe("corsOrigin postures on /ping and /capabilities", () => {
  it.each(POSTURE_CASES)(
    "answers GET /ping as measured for %s",
    async (_label, posture) => {
      const { port, close } = await startApp(posture.options);
      try {
        const res = await getPath(port, "/ping", ALLOWED_ORIGIN);
        expect(JSON.parse(res.body)).toEqual({ status: "healthy" });
        expectHeaders(res, posture.simple);
      } finally {
        await close();
      }
    },
  );

  it.each(POSTURE_CASES)(
    "answers GET /capabilities as measured for %s",
    async (_label, posture) => {
      const { port, close } = await startApp(posture.options);
      try {
        const res = await getPath(port, "/capabilities", ALLOWED_ORIGIN);
        expect(JSON.parse(res.body).events.RUN_STARTED).toBe(true);
        expectHeaders(res, posture.simple);
      } finally {
        await close();
      }
    },
  );
});

describe("documented corsOrigin postures match the measured ones", () => {
  // Set parity in both directions. A row added to README.md's table without a
  // measured fixture entry is prose nobody verified; a fixture entry with no
  // documented row is behaviour nobody told the caller about. Either one fails
  // here rather than passing review.
  it("has a measured fixture entry for every value README.md documents", () => {
    const readme = readFileSync(
      new URL("../../README.md", import.meta.url),
      "utf8",
    );
    const documented = new Set(parseReadmeCorsOriginValues(readme));
    const measured = fixtureReadmeValues();
    expect([...documented].sort()).toEqual([...measured].sort());
  });
});

describe("allowMethods and allowHeaders narrow the cors defaults", () => {
  it("keeps the cors defaults and reflects request headers verbatim when both are omitted", async () => {
    const { port, close } = await startApp({ corsOrigin: [ALLOWED_ORIGIN] });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      expect(res.allowMethods).toBe(DEFAULT_ALLOW_METHODS);
      // Reflected verbatim, casing and spacing included.
      expect(res.allowHeaders).toBe(PROBE_REQUEST_HEADERS);
      // Both halves of the reflection are cache-relevant, so both are named.
      expect(res.vary).toBe("Origin, Access-Control-Request-Headers");
    } finally {
      await close();
    }
  });

  it("emits only the configured methods and leaves the Vary alone", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      allowMethods: ["POST"],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN);
      expect(res.allowMethods).toBe("POST");
      // `allowMethods` is not what puts `Access-Control-Request-Headers` in
      // the `Vary`: the header reflection does, and that is still on, so the
      // `Vary` is unchanged. Narrowing the *headers* is what shortens it, and
      // the test below is where that happens.
      expect(res.vary).toBe("Origin, Access-Control-Request-Headers");
    } finally {
      await close();
    }
  });

  it("emits only the configured headers whatever the preflight asked for", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      allowHeaders: ["Content-Type"],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      expect(res.allowHeaders).toBe("Content-Type");
      // Nothing is reflected any more, so the request header stops being
      // cache-relevant and `Vary` narrows to `Origin` alone.
      expect(res.vary).toBe("Origin");
    } finally {
      await close();
    }
  });

  it("still answers 204 for a preflight of a method outside allowMethods", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      allowMethods: ["POST"],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestMethod: "DELETE",
      });
      // `cors` does not reject a disallowed preflight; it answers with the
      // narrowed list and leaves enforcement to the browser. Starlette's
      // CORSMiddleware answers 400 here, so the Python suite's assertion on
      // that status must not be ported.
      expect(res.status).toBe(204);
      expect(res.allowMethods).toBe("POST");
    } finally {
      await close();
    }
  });

  it("withholds the methods header entirely for an empty allowMethods", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      allowMethods: [],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN);
      // An empty list is truthy, so it is a deny-all allowlist rather than a
      // request for the default. The header is absent, not sent empty, and in
      // particular is not `GET,HEAD,PUT,PATCH,POST,DELETE`.
      expect(res.allowMethods).toBeNull();
      expect(res.allowOrigin).toBe(ALLOWED_ORIGIN);
    } finally {
      await close();
    }
  });

  it("withholds the headers header entirely for an empty allowHeaders", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      allowHeaders: [],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      // Deny-all again: the preflight asked for two headers and got neither
      // an allowlist nor the reflection.
      expect(res.allowHeaders).toBeNull();
      expect(res.vary).toBe("Origin");
    } finally {
      await close();
    }
  });
});

describe("corsEnabled vetoes the origin policy", () => {
  it("installs nothing for `corsEnabled: false` alongside a truthy corsOrigin", async () => {
    const { port, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      corsEnabled: false,
    });
    try {
      // The allowed origin itself is refused: Express's own OPTIONS responder
      // answers, and no CORS header of any kind is emitted.
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      expect(res).toEqual({
        status: 200,
        allowOrigin: null,
        allowCredentials: null,
        allowMethods: null,
        allowHeaders: null,
        vary: null,
      });
    } finally {
      await close();
    }
  });

  it("silences allowMethods and allowHeaders for `corsEnabled: false` with no origin", async () => {
    // The orphan check does not fire: the caller turned CORS off in one place
    // deliberately, so narrowing options for the policy that will not exist
    // are silenced rather than treated as a misconfiguration.
    const { port, close } = await startApp({
      corsEnabled: false,
      allowMethods: ["POST"],
      allowHeaders: ["Content-Type"],
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.allowOrigin).toBeNull();
      expect(res.allowMethods).toBeNull();
      expect(res.allowHeaders).toBeNull();
    } finally {
      await close();
    }
  });

  it("is a no-op for `corsEnabled: true` alongside a truthy corsOrigin", async () => {
    const { port, close } = await startApp({
      corsOrigin: ALLOWED_ORIGIN,
      corsEnabled: true,
    });
    try {
      const explicit = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      // Byte-identical to the same posture with `corsEnabled` omitted, which
      // the fixture measured.
      expectHeaders(
        explicit,
        postureByLabel("a single origin string").preflight,
      );
    } finally {
      await close();
    }
  });

  const ORPHANED: [string, CreateStrandsAppOptions][] = [
    ["`corsEnabled: true` alone", { corsEnabled: true }],
    [
      "`corsEnabled: true` with a falsy origin",
      { corsEnabled: true, corsOrigin: false },
    ],
    ["`allowMethods` alone", { allowMethods: ["POST"] }],
    ["`allowHeaders` alone", { allowHeaders: ["X-A"] }],
  ];

  it.each(ORPHANED)("rejects %s", async (_label, options) => {
    // The factory is async, so the misconfiguration surfaces as a rejection.
    await expect(createStrandsApp(new FixedAgent(), options)).rejects.toThrow(
      /no `corsOrigin` policy/,
    );
  });

  it("names every orphaned option, in the plural, when more than one is passed", async () => {
    await expect(
      createStrandsApp(new FixedAgent(), {
        corsEnabled: true,
        allowMethods: ["POST"],
        allowHeaders: ["X-A"],
      }),
    ).rejects.toThrow(
      "`corsEnabled: true`, `allowMethods`, `allowHeaders` were passed",
    );
  });

  it("throws before binding anything, so a misconfigured app never serves", async () => {
    // Nothing to close: the rejection happens before `express()` is even
    // constructed, which is what makes this a boot-time failure rather than a
    // request-time surprise.
    const attempt = createStrandsApp(new FixedAgent(), { corsEnabled: true });
    await expect(attempt).rejects.toBeInstanceOf(Error);
  });
});

/** The measured allowlist posture, reused by the error and auth suites below. */
const ALLOWLIST = postureByLabel("an exact-match allowlist array");

/**
 * The allowlist posture's non-preflight headers, at some other status.
 *
 * A browser only surfaces a response status to the calling page once the CORS
 * check passes, so an error carries the same policy a success does or the page
 * sees an opaque network failure instead of the 415 / 400 / 401 / 500 it was
 * told. Deriving the expectation from the measured success row states that
 * once: any header that moves between a 200 and an error is a real difference.
 */
function allowlistHeadersAt(status: number): MeasuredResponse {
  return { ...ALLOWLIST.simple, status };
}

/**
 * CORS headers on the responses that are not a 2xx.
 *
 * `cors` contributes headers only to responses produced downstream of where it
 * is mounted, and it is mounted first: ahead of `express.json()` and ahead of
 * every route. Both of those layers can end a request by themselves, so both
 * are probed here. The route owns 415 and its own 400; the body parser owns
 * the 400 on a body it cannot parse, and that request never reaches the route
 * at all, which makes it the one probe that separates "CORS before the parser"
 * from "CORS after the parser".
 *
 * The 415 and 400 boundaries themselves are duplicated from
 * `endpoint-validation.test.ts` on purpose: the 415 is one of the two defenses
 * the opt-in CORS default leans on (the other being the absent allow-origin
 * header), so it is asserted here against a `createStrandsApp` app rather than
 * only against a hand-assembled one.
 */
describe("createStrandsApp keeps the CORS policy on non-2xx responses", () => {
  it.each([
    ["a genuinely absent content type", null],
    ["a plain-text content type", "text/plain"],
    ["a form-encoded content type", "application/x-www-form-urlencoded"],
  ])(
    "refuses %s with a 415 the browser can still read",
    async (_label, contentType) => {
      const { port, agent, close } = await startApp({
        corsOrigin: [ALLOWED_ORIGIN],
      });
      try {
        const res = await postRun(port, {
          contentType,
          origin: ALLOWED_ORIGIN,
        });
        expect(JSON.parse(res.body)).toEqual({
          error: "Unsupported Media Type: expected application/json",
        });
        expect(agent.runs).toBe(0);
        expectHeaders(res, allowlistHeadersAt(415));
      } finally {
        await close();
      }
    },
  );

  it("refuses an invalid RunAgentInput with a 400 the browser can still read", async () => {
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
    });
    try {
      // Parses as JSON, so it clears the body parser and the media-type check
      // and is turned away by the schema instead.
      const res = await postRaw(port, "{}", { origin: ALLOWED_ORIGIN });
      expect(JSON.parse(res.body).error).toBe("Invalid RunAgentInput");
      expect(agent.runs).toBe(0);
      expectHeaders(res, allowlistHeadersAt(400));
    } finally {
      await close();
    }
  });

  it("keeps the policy on the body parser's own 400, which never reaches the route", async () => {
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
    });
    try {
      // `express.json()` throws a SyntaxError on this, and Express's default
      // error handler answers. The route never runs, so the only reason this
      // response carries any CORS header at all is that the middleware is
      // mounted ahead of the parser. Mount it after, and a browser sees an
      // opaque failure instead of a 400 it could report.
      const res = await postRaw(port, "{not json", {
        origin: ALLOWED_ORIGIN,
      });
      expect(agent.runs).toBe(0);
      expectHeaders(res, allowlistHeadersAt(400));
    } finally {
      await close();
    }
  });

  it("accepts application/json and invokes the agent", async () => {
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
    });
    try {
      const res = await postRun(port, { origin: ALLOWED_ORIGIN });
      expect(agent.runs).toBe(1);
      expectHeaders(res, ALLOWLIST.simple);
    } finally {
      await close();
    }
  });
});

/**
 * `corsOrigin` and `auth` together.
 *
 * The two features are configured independently and are only ever exercised
 * apart, which leaves the interaction between them unpinned: a preflight
 * carries no credentials by design, so a guard that saw one would reject it
 * and no browser could ever reach the guarded route. What keeps the guard off
 * the preflight is that it is mounted on `app.post` for one path rather than
 * app-wide, and that `cors` answers the preflight before any route is
 * consulted.
 */
describe("corsOrigin alongside an auth guard", () => {
  const AUTHORIZED = { Authorization: "Bearer secret" };

  /** A guard that admits one bearer token and counts every consultation. */
  function countingGuard(): {
    auth: StrandsAuthMiddleware;
    calls: () => number;
  } {
    let calls = 0;
    const auth: StrandsAuthMiddleware = (req, res, next) => {
      calls += 1;
      if (req.header("authorization") === "Bearer secret") {
        next();
        return;
      }
      res.status(401).json({ error: "Unauthorized" });
    };
    return { auth, calls: () => calls };
  }

  it("answers a preflight from the CORS layer without consulting the guard", async () => {
    const { auth, calls } = countingGuard();
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      auth,
    });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      // Byte-identical to the unguarded allowlist posture: adding a guard must
      // not change what a browser is told during the preflight, or the
      // credentialed request it is asking permission for never happens.
      expectHeaders(res, ALLOWLIST.preflight);
      expect(calls()).toBe(0);
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("leaves a preflight to Express, still unguarded, with no origin policy", async () => {
    const { auth, calls } = countingGuard();
    const { port, agent, close } = await startApp({ auth });
    try {
      const res = await preflight(port, ALLOWED_ORIGIN, {
        requestHeaders: PROBE_REQUEST_HEADERS,
      });
      // No `cors` to short-circuit anything, so this is the case that shows
      // the guard is bound to `POST` rather than to the path: widen the route
      // to every method and Express dispatches this OPTIONS into the guard,
      // which answers 401 instead of the 200 its own responder gives.
      expectHeaders(res, postureByLabel("omitted").preflight);
      expect(calls()).toBe(0);
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("carries the allowed origin on the guard's own 401", async () => {
    const { auth, calls } = countingGuard();
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      auth,
    });
    try {
      const res = await postRun(port, { origin: ALLOWED_ORIGIN });
      expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
      expect(calls()).toBe(1);
      expect(agent.runs).toBe(0);
      expectHeaders(res, allowlistHeadersAt(401));
    } finally {
      await close();
    }
  });

  it("carries the allowed origin on the 500 a throwing guard produces", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      auth: () => {
        throw new Error("guard exploded");
      },
    });
    try {
      const res = await postRun(port, {
        origin: ALLOWED_ORIGIN,
        headers: AUTHORIZED,
      });
      expect(JSON.parse(res.body)).toEqual({ error: "Internal Server Error" });
      expect(agent.runs).toBe(0);
      expectHeaders(res, allowlistHeadersAt(500));
    } finally {
      await close();
      vi.restoreAllMocks();
    }
  });

  it("admits an authorized cross-origin call and marks the stream readable", async () => {
    const { auth, calls } = countingGuard();
    const { port, agent, close } = await startApp({
      corsOrigin: [ALLOWED_ORIGIN],
      auth,
    });
    try {
      const res = await postRun(port, {
        origin: ALLOWED_ORIGIN,
        headers: AUTHORIZED,
      });
      expect(res.body).toContain("RUN_STARTED");
      expect(calls()).toBe(1);
      expect(agent.runs).toBe(1);
      expectHeaders(res, ALLOWLIST.simple);
    } finally {
      await close();
    }
  });
});
