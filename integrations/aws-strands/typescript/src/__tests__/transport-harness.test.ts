/**
 * Self-tests for `transport-harness.ts`.
 *
 * Every CORS and auth suite reads its evidence through this harness, so the
 * two places the harness could quietly lie about the server are pinned here
 * rather than inside a suite about something else: how `listen` reports a
 * failure, and which `Content-Type` a request actually arrives with.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import type { Express } from "express";

import { closeServer, listen } from "./transport-harness";

/** An app whose bind fails, driven directly. */
function appThatFailsToBind(failure: Error): Express {
  // A real EADDRINUSE cannot be provoked portably (Node's default SO_REUSEADDR
  // lets a second bind to the same ephemeral port succeed on macOS, and a
  // privileged port succeeds as root), so the emitter stands in for the server.
  return {
    listen: () => {
      const emitter = new EventEmitter();
      setImmediate(() => emitter.emit("error", failure));
      return emitter;
    },
  } as unknown as Express;
}

/** An app that binds successfully, exposing the emitter the harness wires up. */
function appThatBinds(): { app: Express; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const app = {
    listen: (_port: number, onListening: () => void) => {
      setImmediate(onListening);
      return emitter;
    },
  } as unknown as Express;
  return { app, emitter };
}

describe("listen reports a bind failure instead of hanging", () => {
  it("rejects with the error the server emitted", async () => {
    const failure = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });

    // Bounded here rather than left to the runner's own timeout. Without the
    // rejecting listener the promise never settles, and a plain
    // `rejects.toBe(...)` cannot observe that: it would be the vitest timeout
    // reporting a slow test, not this assertion reporting a swallowed bind
    // failure. Racing a short timer turns the same regression into this
    // assertion failing, with `"still pending"` naming what went wrong.
    const settled = await Promise.race([
      listen(appThatFailsToBind(failure)).then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 500)),
    ]);
    expect(settled).toBe(failure);
  });

  it("does not absorb a post-bind server error into the settled promise", async () => {
    const { app, emitter } = appThatBinds();
    const server = await listen(app);
    expect(server).toBe(emitter);

    // The rejecting listener is detached on a successful bind: rejecting a
    // promise that already resolved is a no-op, so leaving it attached would
    // make every later server error disappear. What replaces it re-raises.
    expect(emitter.listenerCount("error")).toBe(1);
    const [handler] = emitter.listeners("error") as ((e: Error) => void)[];
    const postBind = new Error("post-bind failure");
    expect(() => handler!(postBind)).toThrow(postBind);
  });
});

describe("postRun's absent-Content-Type probe", () => {
  it("sends no Content-Type at all only for a byte-array body", async () => {
    // The load-bearing assumption under the harness's `contentType: null`
    // option, and behind every 415 assertion that uses it. undici stamps
    // `text/plain;charset=UTF-8` on a string body, so a string cannot exercise
    // the absent-header path at all: it exercises the mismatching-type path
    // and looks identical because both answer 415.
    const expressModule = await import("express");
    const express = expressModule.default ?? expressModule;
    const app = express();
    app.post("/echo", (req, res) => {
      res.json({ contentType: req.headers["content-type"] ?? null });
    });
    const server = await listen(app);
    try {
      const port = (server.address() as import("net").AddressInfo).port;
      const asBytes = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: "POST",
        body: new TextEncoder().encode("{}"),
      });
      expect(await asBytes.json()).toEqual({ contentType: null });

      const asString = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: "POST",
        body: "{}",
      });
      expect(await asString.json()).toEqual({
        contentType: "text/plain;charset=UTF-8",
      });
    } finally {
      await closeServer(server);
    }
  });
});
