import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { AddressInfo } from "net";

import { createStrandsApp, type CreateStrandsAppOptions } from "../server";
import { StrandsAgent } from "../agent";

class FixedAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];
  constructor(events: BaseEvent[]) {
    super({
      agent: {
        model: {},
        tools: [],
        toolRegistry: {
          list: () => [],
          add() {},
          get: () => undefined,
          remove() {},
        },
        sessionManager: undefined,
      } as unknown as import("@strands-agents/sdk").Agent,
      name: "fixed",
    });
    this._events = events;
  }
  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    for (const e of this._events) yield e;
  }
}

async function startApp(options?: CreateStrandsAppOptions): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = await createStrandsApp(
    new FixedAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]),
    options,
  );
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Issue a CORS preflight (OPTIONS) carrying an Origin and read back the ACA-* headers. */
async function preflight(
  port: number,
  origin: string,
): Promise<{ allowOrigin: string | null; allowCredentials: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
    },
  });
  return {
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowCredentials: res.headers.get("access-control-allow-credentials"),
  };
}

describe("createStrandsApp CORS", () => {
  const APP_ORIGIN = "https://app.example.com";
  const OTHER_ORIGIN = "https://evil.example.com";

  it("defaults to a literal `*` origin, not a reflected one", async () => {
    const { port, close } = await startApp();
    try {
      const { allowOrigin } = await preflight(port, OTHER_ORIGIN);
      // Literal wildcard, NOT the reflected request Origin: `origin: true`
      // would have echoed the caller's origin back instead.
      expect(allowOrigin).toBe("*");
      expect(allowOrigin).not.toBe(OTHER_ORIGIN);
    } finally {
      await close();
    }
  });

  // `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials:
  // true` is a pairing browsers reject, so the wildcard default withholds
  // credentials and only a concrete allow-list enables them. Python derives
  // the flag the same way, from `bool(origins) and not is_wildcard`; its
  // matching assertions live in test_endpoint_cors.py.
  it("withholds credentials on the wildcard default", async () => {
    const { port, close } = await startApp();
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        OTHER_ORIGIN,
      );
      expect(allowOrigin).toBe("*");
      expect(allowCredentials).toBeNull();
    } finally {
      await close();
    }
  });

  it("honours an explicit single-origin override and allows credentials", async () => {
    const { port, close } = await startApp({ corsOrigin: APP_ORIGIN });
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        APP_ORIGIN,
      );
      expect(allowOrigin).toBe(APP_ORIGIN);
      expect(allowCredentials).toBe("true");
    } finally {
      await close();
    }
  });

  it("honours a concrete allow-list and allows credentials", async () => {
    const { port, close } = await startApp({ corsOrigin: [APP_ORIGIN] });
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        APP_ORIGIN,
      );
      expect(allowOrigin).toBe(APP_ORIGIN);
      expect(allowCredentials).toBe("true");
    } finally {
      await close();
    }
  });

  it("does not grant an origin outside a concrete allow-list", async () => {
    const { port, close } = await startApp({ corsOrigin: [APP_ORIGIN] });
    try {
      const { allowOrigin } = await preflight(port, OTHER_ORIGIN);
      expect(allowOrigin).toBeNull();
    } finally {
      await close();
    }
  });

  // `cors` compares array entries by string equality, so an unnormalized
  // `["*"]` would emit no allow-origin header at all and deny every caller,
  // where Python's `origins=["*"]` allows all. Assert the origin header, not
  // just the credentials one: credentials are absent under a denial too, so
  // checking them alone passes whether or not the wildcard works.
  it("treats a wildcard inside an array as allow-all", async () => {
    const { port, close } = await startApp({ corsOrigin: ["*"] });
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        OTHER_ORIGIN,
      );
      expect(allowOrigin).toBe("*");
      expect(allowCredentials).toBeNull();
    } finally {
      await close();
    }
  });

  it("treats a wildcard alongside concrete origins as allow-all", async () => {
    const { port, close } = await startApp({ corsOrigin: ["*", APP_ORIGIN] });
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        OTHER_ORIGIN,
      );
      expect(allowOrigin).toBe("*");
      expect(allowCredentials).toBeNull();
    } finally {
      await close();
    }
  });

  // Deliberately NOT widened to a wildcard. An empty allow-list denies every
  // origin, and normalizing it would turn a deliberate deny-all into
  // allow-all. Python coerces an empty list to a wildcard via `origins or
  // ["*"]`; that is a quirk to fix on that side, not one to mirror here.
  it("leaves an empty allow-list denying every origin", async () => {
    const { port, close } = await startApp({ corsOrigin: [] });
    try {
      const { allowOrigin } = await preflight(port, OTHER_ORIGIN);
      expect(allowOrigin).toBeNull();
    } finally {
      await close();
    }
  });

  // A reflected origin is still a concrete one, so credentials are valid and
  // deployments that pass `true` depend on them. Only a literal `"*"` is the
  // pairing browsers refuse.
  it("keeps credentials when the origin is reflected", async () => {
    const origin = "https://reflected.example.com";
    const { port, close } = await startApp({ corsOrigin: true });
    try {
      const { allowOrigin, allowCredentials } = await preflight(port, origin);
      expect(allowOrigin).toBe(origin);
      expect(allowCredentials).toBe("true");
    } finally {
      await close();
    }
  });

  it("disables CORS entirely for `false`, with no credentials", async () => {
    const { port, close } = await startApp({ corsOrigin: false });
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        OTHER_ORIGIN,
      );
      expect(allowOrigin).toBeNull();
      expect(allowCredentials).toBeNull();
    } finally {
      await close();
    }
  });

  it("streams a real run with the allow-origin header attached", async () => {
    const { port, close } = await startApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: OTHER_ORIGIN,
        },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.text()).toContain("RUN_STARTED");
    } finally {
      await close();
    }
  });
});
