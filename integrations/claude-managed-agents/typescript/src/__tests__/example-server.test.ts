/**
 * Lifecycle and failure handling of the Dojo example server. The example is what
 * people copy, so its rejected-handler, aborted-client and mid-stream-failure
 * paths are worth pinning down.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable, throwError, concat, of } from "rxjs";
import { afterEach, describe, expect, it } from "vitest";
import { safeHandler, streamRun } from "../../examples/server";

const listen = async (handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

const start = async (handler: http.RequestListener): Promise<string> => {
  const { url, close } = await listen(handler);
  servers.push(close);
  return url;
};

/** An SSE response already open, as handleRequest leaves it before streaming. */
const openSse = (res: http.ServerResponse): EventEncoder => {
  const encoder = new EventEncoder({ accept: "text/event-stream" });
  res.writeHead(200, { "Content-Type": encoder.getContentType() });
  return encoder;
};

const input = { threadId: "t", runId: "r", messages: [], tools: [] } as unknown as RunAgentInput;

/** A one-shot event you can await, so a test never has to guess a deadline. */
const signal = () => {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire: () => fire() };
};

/** Await `promise`, failing with `message` instead of hanging if it never settles. */
const within = async <T>(promise: Promise<T>, message: string, ms = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe("example server", () => {
  // The setup module's entry-point guard is covered in setup-guard.test.ts: this
  // file's static import of examples/server evaluates examples/setup during its
  // own import phase, so no test here can observe that module being loaded.

  it("answers 500 instead of crashing when a handler rejects before writing", async () => {
    // Regression: handleRequest is async and was handed straight to
    // http.createServer, so anything that rejected inside it — an aborted body
    // read, a failing lookup — became an unhandled rejection and, by Node's
    // default, took the process down instead of answering the request.
    const url = await start((req, res) => {
      const failing = Object.create(req, {
        url: {
          get() {
            throw new Error("request went bad");
          },
        },
      }) as http.IncomingMessage;
      safeHandler(failing, res);
    });

    const response = await fetch(`${url}/anything`, { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("routes unknown paths and health without touching the body", async () => {
    const url = await start(safeHandler);

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy" });

    const missing = await fetch(`${url}/no_such_feature`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(404);
  });

  it("breaks the stream when a run fails, rather than ending it cleanly", async () => {
    // Regression: the error handler called res.end(), so a run that died halfway
    // was indistinguishable from one that completed — a silent truncation.
    const failing = {
      run: () =>
        concat(
          of({ type: "RUN_STARTED", threadId: "t", runId: "r" } as unknown as BaseEvent),
          throwError(() => new Error("stream exploded")),
        ),
    };
    const url = await start((_req, res) => {
      void streamRun(failing, input, openSse(res), res);
    });

    const read = async () => {
      const response = await fetch(url);
      return response.text();
    };
    await expect(read()).rejects.toThrow();
  });

  it("ends the stream cleanly when a run completes", async () => {
    const finishing = {
      run: () =>
        new Observable<BaseEvent>((subscriber) => {
          subscriber.next({ type: "RUN_FINISHED", threadId: "t", runId: "r" } as unknown as BaseEvent);
          subscriber.complete();
        }),
    };
    const url = await start((_req, res) => {
      void streamRun(finishing, input, openSse(res), res);
    });

    const response = await fetch(url);
    expect(await response.text()).toContain("RUN_FINISHED");
  });

  it("unsubscribes the run when the client goes away", async () => {
    // Both waits are driven by the run itself rather than a fixed sleep. A sleep
    // is a guess at two different races: aborting before the server has
    // subscribed leaves no teardown to observe at all, and teardown may not have
    // run by an arbitrary deadline on a loaded machine. Awaiting the signals is
    // both exact and faster.
    const subscribed = signal();
    const tornDown = signal();
    const hanging = {
      run: () =>
        new Observable<BaseEvent>(() => {
          subscribed.fire();
          return () => tornDown.fire();
        }),
    };
    const url = await start((_req, res) => {
      void streamRun(hanging, input, openSse(res), res);
    });

    const controller = new AbortController();
    const pending = fetch(url, { signal: controller.signal }).catch(() => undefined);
    await within(subscribed.fired, "the run was never subscribed");
    controller.abort();
    await pending;
    await within(tornDown.fired, "the run was never unsubscribed after the client left");
  });
});
