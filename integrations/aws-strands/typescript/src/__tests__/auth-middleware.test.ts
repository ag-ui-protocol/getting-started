import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import type { AddressInfo } from "net";
import type { Express, RequestHandler } from "express";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { createStrandsApp, type StrandsAuthMiddleware } from "../server";
import { addStrandsExpressEndpoint } from "../endpoint";
import { StrandsAgent } from "../agent";
import type { Logger } from "../logger";
import {
  FixedAgent,
  closeServer,
  getPath,
  listen,
  postRaw,
  postRun,
  runAgentInputPayload,
  type StartedApp,
} from "./transport-harness";

/** Message the failing guards carry, so a leak into the body is unmistakable. */
const SENSITIVE_MARKER = "SENSITIVE-STACK-MARKER";

/** Body a rejecting guard writes for itself: the caller owns its own 401. */
const CALLER_401 = { error: "Unauthorized" };

const AUTHORIZED = { Authorization: "Bearer secret" };

/** The log line every failure path emits, matched exactly. */
const AUTH_FAILURE_LOG = "Auth middleware failed for the agent route";

type LogFn = (message: string, ...args: unknown[]) => void;

/** A `Logger` whose three methods are all spies. */
function spyLogger(): Logger & { error: Mock<LogFn> } {
  return {
    debug: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Spin until `predicate` holds, with a deadline.
 *
 * The guards below have to fail at a precise point in the response's life (head
 * flushed but not ended, stream open mid-run). Without the deadline a missed
 * transition reads as a suite that hangs rather than as a failing assertion.
 */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Attach an HTTP status to an error, the way `express-jwt` and friends do. */
function errorWithStatus(
  field: "status" | "statusCode",
  value: unknown,
): Error & Record<string, unknown> {
  const error = new Error(SENSITIVE_MARKER) as Error & Record<string, unknown>;
  error[field] = value;
  return error;
}

/** The stub Strands core `FixedAgent` builds, which the harness keeps private. */
function stubStrandsCore(): import("@strands-agents/sdk").Agent {
  return {
    model: {},
    tools: [],
    toolRegistry: {
      list: () => [],
      add() {},
      get: () => undefined,
      remove() {},
    },
    sessionManager: undefined,
  } as unknown as import("@strands-agents/sdk").Agent;
}

/**
 * `FixedAgent` plus the two things these suites inject and the shared harness
 * cannot: an adapter `logger` in the agent's config, and a gate that holds the
 * run open so a failure can land while the stream is still live.
 */
class ConfiguredAgent extends StrandsAgent {
  public runs = 0;
  /** Resolves once `RUN_STARTED` is on the wire and the run is parked. */
  public readonly started: Promise<void>;
  private readonly gate: Promise<void> | undefined;
  private readonly announceStarted: () => void;

  constructor(options: { logger?: Logger; gate?: Promise<void> } = {}) {
    super({
      agent: stubStrandsCore(),
      name: "configured",
      config: options.logger ? { logger: options.logger } : {},
    });
    this.gate = options.gate;
    const start = deferred();
    this.started = start.promise;
    this.announceStarted = start.resolve;
  }

  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    this.runs += 1;
    yield { type: EventType.RUN_STARTED, threadId: "t", runId: "r" };
    // Reached only once the endpoint has written the event above, so a guard
    // awaiting `started` knows the stream is genuinely open.
    this.announceStarted();
    if (this.gate) await this.gate;
    yield { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" };
  }
}

const admitBearer: StrandsAuthMiddleware = (req, res, next) => {
  if (req.header("authorization") === "Bearer secret") {
    next();
    return;
  }
  res.status(401).json(CALLER_401);
};

/** Boot `createStrandsApp`, with or without a guard on the agent route. */
async function startAuthedApp(
  auth?: StrandsAuthMiddleware,
): Promise<StartedApp> {
  const agent = new FixedAgent();
  const app = await createStrandsApp(agent, { auth });
  const server = await listen(app);
  return {
    port: (server.address() as AddressInfo).port,
    agent,
    close: () => closeServer(server),
  };
}

interface BareApp extends StartedApp {
  /**
   * Errors that reached the consumer's own Express error handler, mounted
   * after the endpoint.
   *
   * This is the only instrument that separates "the guard declined to advance
   * a spoken-for request" from "it advanced and the handler blew up on its
   * first write". Both answer the caller identically, and in both the agent
   * never runs, because the agent route sets a response header before it ever
   * touches the agent. The difference is whether an ERR_HTTP_HEADERS_SENT
   * lands in the app's error pipeline.
   */
  appErrors: string[];
}

interface BareAppOptions<A extends StrandsAgent> {
  auth?: StrandsAuthMiddleware;
  /** Route-scoped parser to mount after auth and before the agent. */
  bodyParser?: RequestHandler;
  /** Agent to mount. Defaults to a plain `FixedAgent`. */
  agent?: A;
  /**
   * Mounted after the agent endpoint and before the error handler, for the
   * `next("route")` fall-through.
   */
  mountAfter?: (app: Express) => void;
}

interface BareAppOf<A extends StrandsAgent> extends Omit<BareApp, "agent"> {
  agent: A;
}

/** Boot a bare Express app carrying only `express.json()` and the endpoint. */
async function startBareAppWith<A extends StrandsAgent>(
  options: BareAppOptions<A> & { agent: A },
): Promise<BareAppOf<A>> {
  const expressModule = await import("express");
  const express = expressModule.default ?? expressModule;
  const app = express();
  if (!options.bodyParser) {
    app.use(express.json());
  }
  const agent = options.agent;
  addStrandsExpressEndpoint(app, agent, {
    path: "/",
    auth: options.auth,
    bodyParser: options.bodyParser,
  });
  options.mountAfter?.(app);
  const appErrors: string[] = [];
  app.use(
    (
      err: unknown,
      _req: unknown,
      _res: unknown,
      next: (e?: unknown) => void,
    ) => {
      appErrors.push(err instanceof Error ? err.message : String(err));
      next(err);
    },
  );
  const server = await listen(app);
  return {
    port: (server.address() as AddressInfo).port,
    agent,
    appErrors,
    close: () => closeServer(server),
  };
}

async function startBareApp(auth?: StrandsAuthMiddleware): Promise<BareApp> {
  return startBareAppWith({ agent: new FixedAgent(), auth });
}

/**
 * What the caller actually observed, for the paths where the honest answer is
 * that the connection went away.
 *
 * `dropped` and `hung` are the two failure modes that both read as "no
 * response" from a bare `await fetch()`: one is the adapter dropping a
 * response it can no longer set a status on, the other is a request nobody
 * ever settled. Telling them apart is the point of this helper.
 */
type WireOutcome =
  | { kind: "answered"; status: number; body: string }
  | { kind: "dropped" }
  | { kind: "hung" };

async function postRunOutcome(
  port: number,
  timeoutMs = 2000,
): Promise<WireOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTHORIZED },
      body: runAgentInputPayload(),
      signal: controller.signal,
    });
    const body = await res.text();
    return { kind: "answered", status: res.status, body };
  } catch {
    return timedOut ? { kind: "hung" } : { kind: "dropped" };
  } finally {
    clearTimeout(timer);
    // Release the socket either way, so `server.close()` is not waiting on a
    // response nobody is going to finish.
    controller.abort();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth admits and rejects on createStrandsApp", () => {
  it("streams the run for an authenticated POST", async () => {
    const { port, agent, close } = await startAuthedApp(admitBearer);
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(200);
      expect(agent.runs).toBe(1);
      // Ordering, not just presence: a guard that admitted the request halfway
      // would leave the lifecycle pair incomplete or out of order.
      expect(res.body).toContain("RUN_STARTED");
      expect(res.body.indexOf("RUN_STARTED")).toBeLessThan(
        res.body.indexOf("RUN_FINISHED"),
      );
    } finally {
      await close();
    }
  });

  it("answers the guard's own body for an unauthenticated POST", async () => {
    const { port, agent, close } = await startAuthedApp(admitBearer);
    try {
      const res = await postRun(port);
      expect(res.status).toBe(401);
      // The guard owns the status and the body; the adapter invents neither.
      expect(JSON.parse(res.body)).toEqual(CALLER_401);
      // The counter, not just the status: a 401 written while the agent was
      // already running would still read as a 401 here.
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("leaves /ping and /capabilities open", async () => {
    const { port, close } = await startAuthedApp(admitBearer);
    try {
      // Health probes have to keep working, and the capability document is a
      // static matrix of what the adapter supports, not user data.
      const ping = await getPath(port, "/ping");
      expect(ping.status).toBe(200);
      expect(JSON.parse(ping.body)).toEqual({ status: "healthy" });

      const caps = await getPath(port, "/capabilities");
      expect(caps.status).toBe(200);
      expect(JSON.parse(caps.body).features.interrupts).toBe(true);
    } finally {
      await close();
    }
  });

  it("keeps the 415 and 400 boundaries behind a passing guard", async () => {
    const { port, agent, close } = await startAuthedApp(admitBearer);
    try {
      const noType = await postRun(port, {
        contentType: null,
        headers: AUTHORIZED,
      });
      expect(noType.status).toBe(415);
      expect(JSON.parse(noType.body)).toEqual({
        error: "Unsupported Media Type: expected application/json",
      });

      const badBody = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTHORIZED },
        body: "{}",
      });
      const parsed = JSON.parse(await badBody.text());
      expect(badBody.status).toBe(400);
      expect(parsed.error).toBe("Invalid RunAgentInput");
      expect(Array.isArray(parsed.issues)).toBe(true);
      expect(parsed.issues.length).toBeGreaterThan(0);

      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("makes no 401 possible when auth is omitted", async () => {
    const { port, agent, close } = await startAuthedApp();
    try {
      // No Authorization header, and the route is still open: the guard is
      // strictly opt-in, so every existing app is unaffected.
      const res = await postRun(port);
      expect(res.status).toBe(200);
      expect(agent.runs).toBe(1);
    } finally {
      await close();
    }
  });
});

/** Every way a guard can fail, all of which have to fail closed. */
const FAILING_GUARDS: [string, StrandsAuthMiddleware][] = [
  [
    "a synchronous throw",
    () => {
      throw new Error(SENSITIVE_MARKER);
    },
  ],
  [
    "a rejected promise after an await",
    async () => {
      await Promise.resolve();
      throw new Error(SENSITIVE_MARKER);
    },
  ],
  [
    "next(error)",
    (_req, _res, next) => {
      next(new Error(SENSITIVE_MARKER));
    },
  ],
];

describe("auth fails closed", () => {
  it.each(FAILING_GUARDS)(
    "answers 500 and never runs the agent for %s",
    async (_label, guard) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const { port, agent, close } = await startAuthedApp(guard);
      try {
        const res = await postRun(port, { headers: AUTHORIZED });
        expect(res.status).toBe(500);
        // Exactly this object: no `message` key, no `stack` key.
        expect(JSON.parse(res.body)).toEqual({
          error: "Internal Server Error",
        });
        expect(agent.runs).toBe(0);

        // The failure is not swallowed either: it lands in the server log,
        // which is the only place it belongs. `console.error` here is the
        // default logger's own documented output for an agent configured with
        // no `logger`, not the console being addressed directly: an injected
        // logger takes over completely, which the injectable-logger suite
        // below pins separately.
        expect(errorLog).toHaveBeenCalledWith(
          AUTH_FAILURE_LOG,
          expect.objectContaining({ message: SENSITIVE_MARKER }),
        );
      } finally {
        await close();
      }
    },
  );

  it.each(FAILING_GUARDS)(
    "leaks neither the message nor a stack frame for %s",
    async (_label, guard) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { port, close } = await startAuthedApp(guard);
      try {
        const res = await postRun(port, { headers: AUTHORIZED });
        // Express's default error handler serialises the stack into the body
        // outside production, and answers with an HTML page. Owning the 500
        // is what keeps all three of these out of the response.
        expect(res.body).not.toContain(SENSITIVE_MARKER);
        expect(res.body).not.toContain("at ");
        expect(res.body).not.toContain("<");
        expect(res.body).not.toMatch(/\bTypeError\b|Error:/);
      } finally {
        await close();
      }
    },
  );

  it.each(FAILING_GUARDS)(
    "settles the request promptly for %s",
    async (_label, guard) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { port, close } = await startAuthedApp(guard);
      try {
        // Express 4, still inside the accepted peer range, does not await
        // handlers at all, so an unawaited rejection would leave the socket
        // hanging. A bare `await fetch()` cannot tell a hang from a slow
        // suite, so this goes through the aborting probe: a request nobody
        // settles comes back as `hung` rather than as a vitest timeout.
        const outcome = await postRunOutcome(port);
        expect(outcome.kind).not.toBe("hung");
      } finally {
        await close();
      }
    },
  );
});

describe("auth on addStrandsExpressEndpoint directly", () => {
  it("rejects then admits against a bare Express app", async () => {
    const { port, agent, close } = await startBareApp(admitBearer);
    try {
      const rejected = await postRun(port);
      expect(rejected.status).toBe(401);
      expect(agent.runs).toBe(0);

      const admitted = await postRun(port, { headers: AUTHORIZED });
      expect(admitted.status).toBe(200);
      expect(agent.runs).toBe(1);
    } finally {
      await close();
    }
  });

  it("can keep auth and parsing in the same route, in that order", async () => {
    const expressModule = await import("express");
    const express = expressModule.default ?? expressModule;
    const jsonParser = express.json();
    let authCalls = 0;
    let parserCalls = 0;
    const bodyParser: RequestHandler = (req, res, next) => {
      parserCalls += 1;
      jsonParser(req, res, next);
    };
    const agent = new FixedAgent();
    const { port, close } = await startBareAppWith({
      agent,
      bodyParser,
      auth: (req, res, next) => {
        authCalls += 1;
        if (req.header("authorization") === "Bearer secret") {
          next();
          return;
        }
        res.status(401).json(CALLER_401);
      },
    });
    try {
      const rejected = await postRaw(port, "{ this is not json");
      expect(rejected.status).toBe(401);
      expect(authCalls).toBe(1);
      expect(parserCalls).toBe(0);
      expect(agent.runs).toBe(0);

      const admitted = await postRun(port, { headers: AUTHORIZED });
      expect(admitted.status).toBe(200);
      expect(authCalls).toBe(2);
      expect(parserCalls).toBe(1);
      expect(agent.runs).toBe(1);
    } finally {
      await close();
    }
  });

  it("does not advance a guard that answered the request and continued anyway", async () => {
    const answeredThenContinued: StrandsAuthMiddleware = (_req, res, next) => {
      res.status(401).json(CALLER_401);
      // A real mistake, and the dangerous one: the response is already spoken
      // for, so letting this reach the agent would have it stream into a
      // finished response.
      next();
    };
    const { port, agent, appErrors, close } = await startBareApp(
      answeredThenContinued,
    );
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual(CALLER_401);
      expect(agent.runs).toBe(0);
      // The load-bearing half. Advancing a spoken-for request raises
      // ERR_HTTP_HEADERS_SENT into the app's error pipeline while the caller
      // still sees exactly this 401, so only this list separates the two.
      expect(appErrors).toEqual([]);
    } finally {
      await close();
    }
  });

  it.each(FAILING_GUARDS)(
    "owns the 500 rather than handing %s to the app's error handler",
    async (_label, guard) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { port, appErrors, close } = await startBareApp(guard);
      try {
        const res = await postRun(port, { headers: AUTHORIZED });
        expect(res.status).toBe(500);
        // Forwarding instead would hand the error to whatever handler the
        // consumer installed, and to Express's default one when they installed
        // none, which serialises the stack into the body outside production.
        // There is no way to detect which from inside the middleware, so the
        // 500 is owned here and nothing is forwarded.
        expect(appErrors).toEqual([]);
      } finally {
        await close();
      }
    },
  );

  it("accepts a plain Express RequestHandler with no cast", async () => {
    // `@types/express` 5 declares `RequestHandler`'s return type wider than
    // `void | Promise<void>`, which is what the `unknown` return type on
    // `StrandsAuthMiddleware` exists for. The assignment below is the
    // compile-time assertion; the requests just prove it is still wired.
    const guard: RequestHandler = (req, res, next) => {
      if (req.header("authorization")) return next();
      res.status(401).json(CALLER_401);
    };
    const auth: StrandsAuthMiddleware = guard;
    const { port, agent, close } = await startBareApp(auth);
    try {
      expect((await postRun(port)).status).toBe(401);
      expect((await postRun(port, { headers: AUTHORIZED })).status).toBe(200);
      expect(agent.runs).toBe(1);
    } finally {
      await close();
    }
  });
});

describe("auth honours the failing guard's own status", () => {
  /** Every field-and-value pair a real guard sets to mean "401". */
  const HONOURED: [string, StrandsAuthMiddleware, number, string][] = [
    [
      "express-jwt's `status` of 401",
      (_req, _res, next) => next(errorWithStatus("status", 401)),
      401,
      "Unauthorized",
    ],
    [
      "a `statusCode` of 403",
      (_req, _res, next) => next(errorWithStatus("statusCode", 403)),
      403,
      "Forbidden",
    ],
    [
      "a 429 thrown rather than passed to next()",
      () => {
        throw errorWithStatus("status", 429);
      },
      429,
      "Too Many Requests",
    ],
    [
      "a rejected promise carrying 503",
      async () => {
        await Promise.resolve();
        throw errorWithStatus("status", 503);
      },
      503,
      "Service Unavailable",
    ],
    [
      "a 499 with no registered reason phrase",
      (_req, _res, next) => next(errorWithStatus("status", 499)),
      499,
      "Error",
    ],
  ];

  it.each(HONOURED)(
    "answers %s with a generic body",
    async (_label, guard, status, reason) => {
      const logger = spyLogger();
      const { port, agent, appErrors, close } = await startBareAppWith({
        agent: new ConfiguredAgent({ logger }),
        auth: guard,
      });
      try {
        const res = await postRun(port, { headers: AUTHORIZED });
        // The status the guard actually meant. A flat 500 here would turn every
        // rejected credential from the guards the README recommends into a
        // server fault.
        expect(res.status).toBe(status);
        // The reason phrase and nothing else: an auth error's message can name
        // internal detail, and the adapter cannot tell which messages are safe.
        expect(JSON.parse(res.body)).toEqual({ error: reason });
        expect(res.body).not.toContain(SENSITIVE_MARKER);
        expect(agent.runs).toBe(0);
        expect(appErrors).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
          AUTH_FAILURE_LOG,
          expect.objectContaining({ message: SENSITIVE_MARKER }),
        );
      } finally {
        await close();
      }
    },
  );

  /** Statuses that exist on the error but are not usable HTTP error codes. */
  const UNTRUSTWORTHY: [string, unknown][] = [
    ["a success code", 200],
    ["a redirect", 302],
    ["one below the error range", 399],
    ["one above the error range", 600],
    ["a non-integer", 401.5],
    ["a numeric string", "401"],
    ["a boolean", true],
    ["NaN", Number.NaN],
  ];

  it.each(UNTRUSTWORTHY)("falls back to 500 for %s", async (_label, value) => {
    const logger = spyLogger();
    const { port, agent, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: (_req, _res, next) => next(errorWithStatus("status", value)),
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal Server Error" });
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("falls back to 500 for a thrown non-object", async () => {
    const logger = spyLogger();
    const { port, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: () => {
        // A string has no `status` to read, and reading one off it must not
        // throw inside the failure path.
        throw SENSITIVE_MARKER;
      },
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal Server Error" });
      expect(res.body).not.toContain(SENSITIVE_MARKER);
    } finally {
      await close();
    }
  });
});

describe("auth forwards Express control-flow signals", () => {
  it('falls through to the next route for next("route")', async () => {
    const logger = spyLogger();
    const { port, agent, appErrors, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: (_req, _res, next) => next("route"),
      // `next("route")` means "skip the rest of this route", so this is what
      // has to answer. A 500 in its place is the defect.
      mountAfter: (app) =>
        app.post("/", (_req, res) => {
          res.status(299).json({ answered: "next-route" });
        }),
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(299);
      expect(JSON.parse(res.body)).toEqual({ answered: "next-route" });
      expect(agent.runs).toBe(0);
      expect(appErrors).toEqual([]);
      // Control flow is not a failure, so nothing is logged as one either.
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('skips the factory agent route for next("route")', async () => {
    const agent = new FixedAgent();
    let authCalls = 0;
    const app = await createStrandsApp(agent, {
      auth: (_req, _res, next) => {
        authCalls += 1;
        next("route");
      },
    });
    app.post("/", (req, res) => {
      res.status(299).json({
        answered: "next-route",
        threadId: req.body.threadId,
      });
    });
    const server = await listen(app);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(299);
      expect(JSON.parse(res.body)).toEqual({
        answered: "next-route",
        threadId: "t",
      });
      expect(authCalls).toBe(1);
      expect(agent.runs).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('leaves the router for next("router")', async () => {
    const logger = spyLogger();
    const { port, agent, appErrors, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: (_req, _res, next) => next("router"),
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      // Out of the router with no other layer to match: Express's own 404.
      expect(res.status).toBe(404);
      expect(agent.runs).toBe(0);
      expect(appErrors).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("still fails closed for an error that merely looks like a signal", async () => {
    const logger = spyLogger();
    const { port, agent, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      // Express compares the signal as an exact string, so an `Error` whose
      // message reads "route" is an error, not control flow.
      auth: (_req, _res, next) => next(new Error("route")),
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(500);
      expect(agent.runs).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});

describe("auth stands down or drops based on what is already on the wire", () => {
  it("drops the connection for a guard that fails after the head is flushed", async () => {
    const logger = spyLogger();
    // Observed from inside the guard, because the difference between dropping
    // the connection and trying to set a status on it is invisible to the
    // caller: both end the request without a usable response.
    const settledSocket = deferred<boolean>();
    const guard: StrandsAuthMiddleware = (_req, res) => {
      const socket = res.socket;
      res.status(200);
      res.flushHeaders();
      setTimeout(() => settledSocket.resolve(Boolean(socket?.destroyed)), 50);
      throw new Error(SENSITIVE_MARKER);
    };
    const { port, agent, appErrors, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: guard,
    });
    try {
      const outcome = await postRunOutcome(port);
      // Not `hung`: there is no status left to set, so the request still has to
      // be settled, and dropping the connection is the only honest way left.
      expect(outcome.kind).toBe("dropped");
      expect(await settledSocket.promise).toBe(true);
      // The load-bearing half. Answering a status on a response whose head is
      // already sent raises ERR_HTTP_HEADERS_SENT into the app's error
      // pipeline, and the caller cannot tell that from a clean drop.
      expect(appErrors).toEqual([]);
      expect(agent.runs).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        AUTH_FAILURE_LOG,
        expect.objectContaining({ message: SENSITIVE_MARKER }),
      );
    } finally {
      await close();
    }
  });

  it("leaves a response the guard already finished alone", async () => {
    const logger = spyLogger();
    const GUARD_ANSWER = { error: "Payment Required", detail: "seat expired" };
    const settledSocket = deferred<boolean>();
    const guard: StrandsAuthMiddleware = (_req, res) => {
      const socket = res.socket;
      // Answered in full, then a cleanup step blows up. The rejection is real,
      // but the response it would drop is already complete and correct.
      res.status(402).json(GUARD_ANSWER);
      setTimeout(() => settledSocket.resolve(Boolean(socket?.destroyed)), 50);
      throw new Error(SENSITIVE_MARKER);
    };
    const { port, agent, appErrors, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: guard,
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(402);
      expect(JSON.parse(res.body)).toEqual(GUARD_ANSWER);
      // Checking `headersSent` alone would destroy this socket, tearing down a
      // response that had already finished cleanly.
      expect(await settledSocket.promise).toBe(false);
      expect(agent.runs).toBe(0);
      expect(appErrors).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});

describe("auth keeps the one-shot on both exits", () => {
  it("does not answer over a live stream when a rejection lands late", async () => {
    const logger = spyLogger();
    const gate = deferred();
    const agent = new ConfiguredAgent({ logger, gate: gate.promise });
    // Admits the request, then fails once the agent is mid-run. Nothing about
    // the failure is fake: this is what a callback-style guard whose token
    // refresh rejects after it already called `next()` does.
    const guard: StrandsAuthMiddleware = async (_req, _res, next) => {
      next();
      await agent.started;
      // Let the run finish shortly after the failure lands, so a stream that
      // survived can be told apart from one that was torn down.
      setTimeout(() => gate.resolve(), 50);
      throw new Error(SENSITIVE_MARKER);
    };
    const { port, appErrors, close } = await startBareAppWith({
      agent,
      auth: guard,
    });
    try {
      const outcome = await postRunOutcome(port);
      expect(outcome.kind).toBe("answered");
      if (outcome.kind !== "answered") return;
      expect(outcome.status).toBe(200);
      // The whole run, in order. A failure path that answered here would
      // truncate the stream after RUN_STARTED.
      expect(outcome.body).toContain("RUN_STARTED");
      expect(outcome.body).toContain("RUN_FINISHED");
      expect(outcome.body.indexOf("RUN_STARTED")).toBeLessThan(
        outcome.body.indexOf("RUN_FINISHED"),
      );
      expect(agent.runs).toBe(1);
      expect(appErrors).toEqual([]);
      // Standing down is not the same as swallowing: the rejection is real and
      // the log is the only place it can surface.
      expect(logger.error).toHaveBeenCalledWith(
        AUTH_FAILURE_LOG,
        expect.objectContaining({ message: SENSITIVE_MARKER }),
      );
    } finally {
      gate.resolve();
      await close();
    }
  });

  it("logs a failure that arrives after the response has ended", async () => {
    const logger = spyLogger();
    const guardDone = deferred();
    const guard: StrandsAuthMiddleware = async (_req, res, next) => {
      next();
      await waitUntil(() => res.writableEnded, "the response to end");
      next(new Error(SENSITIVE_MARKER));
      guardDone.resolve();
    };
    const { port, agent, appErrors, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: guard,
    });
    try {
      const res = await postRun(port, { headers: AUTHORIZED });
      expect(res.status).toBe(200);
      expect(agent.runs).toBe(1);
      await guardDone.promise;
      // Returning early on the one-shot without logging would leave this
      // failure with no trace anywhere at all.
      expect(logger.error).toHaveBeenCalledWith(
        AUTH_FAILURE_LOG,
        expect.objectContaining({ message: SENSITIVE_MARKER }),
      );
      expect(appErrors).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("auth logs through the injectable logger", () => {
  it("routes the failure to StrandsAgentConfig.logger, not the console", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const logger = spyLogger();
    const { port, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger }),
      auth: () => {
        throw new Error(SENSITIVE_MARKER);
      },
    });
    try {
      expect((await postRun(port, { headers: AUTHORIZED })).status).toBe(500);
      expect(logger.error).toHaveBeenCalledWith(
        AUTH_FAILURE_LOG,
        expect.objectContaining({ message: SENSITIVE_MARKER }),
      );
      // The injection is only real if it also takes the console out of the
      // path: an app that redirected the adapter's output gets auth failures
      // where the rest of the adapter's output goes, and nowhere else.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("silences auth logging entirely for a no-op logger", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const silent: Logger = { debug() {}, warn() {}, error() {} };
    const { port, close } = await startBareAppWith({
      agent: new ConfiguredAgent({ logger: silent }),
      auth: (_req, _res, next) => next(errorWithStatus("status", 401)),
    });
    try {
      expect((await postRun(port, { headers: AUTHORIZED })).status).toBe(401);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});

describe("auth runs ahead of the factory's body parser", () => {
  it("rejects malformed JSON at the guard, not at the parser", async () => {
    let authCalls = 0;
    const { port, agent, close } = await startAuthedApp((_req, res) => {
      authCalls += 1;
      res.status(401).json({ error: "Unauthorized" });
    });
    try {
      // `express.json()` is mounted app-wide by the factory, so this is the
      // probe that pins the mount order: a body the parser itself rejects
      // never reaches the route, so a guard mounted on the route instead of
      // ahead of the parser answers `400` from the parser with the guard never
      // consulted and the parser's stack in the body. A well-formed body under
      // the size limit cannot tell the two orders apart, because it parses
      // either way and the guard then declines it.
      const res = await postRaw(port, "{ this is not json");
      expect(res.status).toBe(401);
      expect(authCalls).toBe(1);
      expect(agent.runs).toBe(0);
      expect(res.body).not.toMatch(/\bat\s+\S+:\d+/);
      expect(res.body).not.toContain("SyntaxError");
    } finally {
      await close();
    }
  });

  it("runs the guard exactly once per request", async () => {
    // The factory mounts the guard itself and must not also hand `auth` to
    // `addStrandsExpressEndpoint`, which would mount a second copy.
    let authCalls = 0;
    const { port, agent, close } = await startAuthedApp((_req, _res, next) => {
      authCalls += 1;
      next();
    });
    try {
      expect((await postRun(port, { headers: AUTHORIZED })).status).toBe(200);
      expect(authCalls).toBe(1);
      expect(agent.runs).toBe(1);
    } finally {
      await close();
    }
  });

  it("leaves ping and capabilities open while the agent route is guarded", async () => {
    let authCalls = 0;
    const { port, close } = await startAuthedApp((_req, res) => {
      authCalls += 1;
      res.status(401).json({ error: "Unauthorized" });
    });
    try {
      expect((await getPath(port, "/ping")).status).toBe(200);
      expect((await getPath(port, "/capabilities")).status).toBe(200);
      expect(authCalls).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("createStrandsApp validates options", () => {
  it("throws for a misspelled security option instead of ignoring it", async () => {
    const agent = new FixedAgent();
    await expect(
      createStrandsApp(agent, {
        autth: (_req: unknown, _res: unknown, next: () => void) => next(),
      } as never),
    ).rejects.toThrow(/unknown option `autth`/);
    expect(agent.runs).toBe(0);
  });

  it("names every unknown option and lists the valid ones", async () => {
    await expect(
      createStrandsApp(new FixedAgent(), {
        autth: 1,
        corsOrigns: 2,
      } as never),
    ).rejects.toThrow(/unknown options `autth`, `corsOrigns`[\s\S]*`auth`/);
  });

  it.each([
    ["path", 1, "a string"],
    ["pingPath", false, "a string, null, or undefined"],
    ["capabilitiesPath", false, "a string, null, or undefined"],
    ["capabilities", [], "an object or undefined"],
    ["corsOrigin", 1, "a string, boolean, string array, or undefined"],
    [
      "corsOrigin",
      ["https://app.example.com", 1],
      "a string, boolean, string array, or undefined",
    ],
    ["corsEnabled", "true", "a boolean or undefined"],
    ["allowMethods", ["POST", 1], "a string array or undefined"],
    ["allowHeaders", "Content-Type", "a string array or undefined"],
    ["auth", false, "a function or undefined"],
  ])("rejects an invalid %s value", async (option, value, expected) => {
    await expect(
      createStrandsApp(new FixedAgent(), {
        [option]: value,
      } as never),
    ).rejects.toThrow(
      `createStrandsApp option \`${option}\` must be ${expected}`,
    );
  });

  it("still accepts every documented option together", async () => {
    const app = await createStrandsApp(new FixedAgent(), {
      path: "/",
      pingPath: "/ping",
      capabilitiesPath: "/capabilities",
      capabilities: {},
      corsOrigin: ["https://app.example.com"],
      corsEnabled: true,
      allowMethods: ["POST"],
      allowHeaders: ["Content-Type"],
      auth: (_req, _res, next) => next(),
    });
    expect(app).toBeDefined();
  });
});

describe("addStrandsExpressEndpoint validates options", () => {
  it("throws for a misspelled security option before mounting a route", () => {
    const post = vi.fn();
    const app = { post } as unknown as Express;
    expect(() =>
      addStrandsExpressEndpoint(app, new FixedAgent(), {
        path: "/",
        autth: (_req: unknown, _res: unknown, next: () => void) => next(),
      } as never),
    ).toThrow(/unknown option `autth`/);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["path", 1, "a string"],
    ["auth", false, "a function or undefined"],
    ["bodyParser", false, "an Express request handler or undefined"],
  ])("rejects an invalid %s value", (option, value, expected) => {
    const post = vi.fn();
    const app = { post } as unknown as Express;
    expect(() =>
      addStrandsExpressEndpoint(app, new FixedAgent(), {
        path: "/",
        [option]: value,
      } as never),
    ).toThrow(
      `addStrandsExpressEndpoint option \`${option}\` must be ${expected}`,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
