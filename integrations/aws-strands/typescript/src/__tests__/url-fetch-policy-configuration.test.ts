/**
 * Reaching the URL fetch policy from configuration, and what that changes.
 *
 * `url-fetch-policy.test.ts` pins the policy itself: what it refuses, and what
 * a caller passing one straight to `fetchUrlContent` gets. This file pins the
 * layer above it, which is the one a deployment actually touches: the policy
 * named on `StrandsAgentConfig` is what every attachment in the run is fetched
 * under, an absent one is the safe default, and a broken one ends the run
 * instead of quietly reverting to that default.
 *
 * Deliberately driven through `agent.run()` rather than through the converter.
 * A policy plumbed into the converter but not into the run would satisfy every
 * assertion made one level down and still leave the option inert.
 *
 * Counterpart to the `TestPolicyIsReachableFromConfiguration` class in
 * `python/tests/test_url_fetch_ssrf.py`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventType, type BaseEvent } from "@ag-ui/core";

import * as pkg from "../index";
import {
  DEFAULT_URL_FETCH_POLICY,
  urlFetchTransport,
  type UrlFetchPolicy,
  type SchemeAllowlist,
} from "../utils";
import { convertMessagesForStrandsSeed } from "../agent";
import {
  collect,
  errorCodes,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  type ScriptedModel,
} from "./helpers";
import { expectContractError } from "./error-code-table";

const PUBLIC_IP = "93.184.216.34";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Point every hostname lookup at a public address. */
function mockPublicDns() {
  return vi
    .spyOn(dns.promises, "lookup")
    .mockResolvedValue([{ address: PUBLIC_IP, family: 4 }] as never);
}

/** Stand in for the socket layer, so no test here can reach a real host. */
function stubTransport(body = "stub body") {
  const attempted: string[] = [];
  const spy = vi
    .spyOn(urlFetchTransport, "request")
    .mockImplementation(async (target: string) => {
      attempted.push(target);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
  return { spy, attempted };
}

function imageAt(url: string) {
  return {
    type: "image",
    source: { type: "url", value: url, mimeType: "image/png" },
  };
}

/**
 * Every image the model was actually handed, as text.
 *
 * Read off the model rather than off the returned events: the events say what
 * a client was told, and the question here is what left the process toward the
 * provider.
 */
function imagesSeenBy(model: ScriptedModel): string[] {
  const seen: string[] = [];
  for (const turn of model.seenMessages) {
    for (const message of turn) {
      for (const block of message.content as unknown[]) {
        const record = block as {
          type?: string;
          source?: { bytes?: Uint8Array };
        };
        if (record.type === "imageBlock" && record.source?.bytes) {
          seen.push(Buffer.from(record.source.bytes).toString());
        }
      }
    }
  }
  return seen;
}

/** A message list whose attachments pass through all three conversions. */
function messagesCarrying(firstUrl: string, lastUrl: string) {
  return [
    // Converted by the construction seed and again by the history replay.
    { id: "u1", role: "user", content: [imageAt(firstUrl)] },
    { id: "a1", role: "assistant", content: "seen" },
    // The live turn's own prompt. The text is what the run falls back to when
    // the attachment does not survive, so a refusal shows up as a completed
    // run carrying no image rather than as a failed one.
    {
      id: "u2",
      role: "user",
      content: [{ type: "text", text: "and this one?" }, imageAt(lastUrl)],
    },
  ] as never[];
}

/** A local HTTP server on loopback, which the default policy refuses to reach. */
async function privateCdn(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(`private ${req.url}`);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the URL fetch policy is reachable from configuration", () => {
  it("is exported from the package entry", () => {
    // Without the default there is nothing to spread an override over, and
    // without SchemeAllowlist a consumer cannot write the type of the field
    // they are narrowing. Both types are checked by being used.
    expect(pkg.DEFAULT_URL_FETCH_POLICY).toBe(DEFAULT_URL_FETCH_POLICY);
    expect([...pkg.DEFAULT_URL_FETCH_POLICY.allowedSchemes].sort()).toEqual([
      "http",
      "https",
    ]);
    expect(new pkg.UrlFetchPolicyError("refused")).toBeInstanceOf(Error);

    const schemes: SchemeAllowlist = new Set(["https"]);
    const narrowed: pkg.UrlFetchPolicy = {
      ...pkg.DEFAULT_URL_FETCH_POLICY,
      allowedSchemes: schemes,
    };
    expect(narrowed.allowedSchemes.has("http")).toBe(false);
  });

  it("is absent from a default config, which means the safe policy", () => {
    // Mirrors Python's `StrandsAgentConfig().url_fetch_policy is None`: the
    // adapter reads `undefined` as the default rather than storing a copy of
    // it, so there is one authority on what the default is.
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);
    expect(agent.config.urlFetchPolicy).toBeUndefined();
  });

  it("refuses a private CDN with no policy configured, and reaches it with one", async () => {
    // The whole point of the option, end to end over a real socket: the same
    // attachment, the same adapter, the only difference being the config.
    const cdn = await privateCdn();
    try {
      const withDefault = realStrandsAgent([modelTurn.text("ok")]);
      const defaultEvents = await collect(
        withDefault.agent,
        minimalRunInput({
          threadId: "cdn-default",
          messages: messagesCarrying(
            `${cdn.origin}/a.png`,
            `${cdn.origin}/b.png`,
          ),
        }),
      );

      expectCompletedRun(defaultEvents);
      expect(imagesSeenBy(withDefault.model)).toEqual([]);

      const withOptIn = realStrandsAgent([modelTurn.text("ok")], {
        config: {
          urlFetchPolicy: {
            ...DEFAULT_URL_FETCH_POLICY,
            allowPrivateNetworks: true,
          },
        },
      });
      const optInEvents = await collect(
        withOptIn.agent,
        minimalRunInput({
          threadId: "cdn-optin",
          messages: messagesCarrying(
            `${cdn.origin}/a.png`,
            `${cdn.origin}/b.png`,
          ),
        }),
      );

      expectCompletedRun(optInEvents);
      // Both attachments arrive: the first through the seed / replayed
      // history, the second through the live turn's own prompt. A policy set
      // on only one of the conversion paths would deliver one of them.
      expect([...new Set(imagesSeenBy(withOptIn.model))].sort()).toEqual([
        "private /a.png",
        "private /b.png",
      ]);
    } finally {
      await cdn.close();
    }
  });

  it("keeps the cloud metadata endpoint refused under the private-network opt-in", async () => {
    // The opt-in a deployment needs for its own CDN must not be the opt-in
    // that hands an attacker the instance's credentials.
    const { spy } = stubTransport();
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: {
        urlFetchPolicy: {
          ...DEFAULT_URL_FETCH_POLICY,
          allowPrivateNetworks: true,
        },
      },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "metadata",
        messages: messagesCarrying(
          "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
          "http://169.254.170.2/v2/credentials/",
        ),
      }),
    );

    expectCompletedRun(events);
    expect(spy).not.toHaveBeenCalled();
    expect(imagesSeenBy(model)).toEqual([]);
  });

  it.each([
    ["a non-HTTP scheme", "file:///etc/passwd"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["a private range", "http://10.0.0.5/internal"],
    ["a link-local address", "http://169.254.169.254/latest/meta-data/"],
    ["a reserved range", "http://192.0.0.192/opc/v2/instance/"],
    ["multicast", "http://224.0.0.1/"],
    ["the unspecified address", "http://0.0.0.0/"],
  ])("still refuses %s when no policy is configured", async (_label, url) => {
    const { spy } = stubTransport();
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: `default-${url}`,
        messages: messagesCarrying(url, url),
      }),
    );

    expectCompletedRun(events);
    expect(spy).not.toHaveBeenCalled();
    expect(imagesSeenBy(model)).toEqual([]);
  });

  it("reports what it could not deliver rather than dropping it silently", async () => {
    // The refusals above are not invisible: the run still tells the client
    // which attachments did not reach the model.
    stubTransport();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "reported",
        messages: messagesCarrying(
          "http://10.0.0.5/a.png",
          "http://10.0.0.5/b.png",
        ),
      }),
    );

    const dropped = events.filter(
      (e: BaseEvent) =>
        e.type === EventType.CUSTOM &&
        (e as { name?: string }).name === "MediaDropped",
    );
    expect(dropped).toHaveLength(1);
  });

  it("hands the policy to the exported seed builders too", async () => {
    // `buildStrandsSeed` and `convertMessagesForStrandsSeed` are on the public
    // surface, so a host calling one directly has to be able to say what
    // policy its attachments are fetched under.
    const { spy } = stubTransport("seeded bytes");
    // `buildStrandsSeed` holds back a trailing user turn for the live prompt,
    // so the attachment has to sit behind one for it to convert anything.
    const messages = [
      {
        id: "u1",
        role: "user",
        content: [imageAt("http://127.0.0.1:9/a.png")],
      },
      { id: "a1", role: "assistant", content: "seen" },
    ] as never[];
    const optIn = {
      urlFetchPolicy: {
        ...DEFAULT_URL_FETCH_POLICY,
        allowPrivateNetworks: true,
      },
    };

    for (const build of [pkg.buildStrandsSeed, convertMessagesForStrandsSeed]) {
      spy.mockClear();

      const underDefault = await build(messages);
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(underDefault)).not.toContain("image");

      const underOptIn = await build(messages, undefined, optIn);
      expect(spy).toHaveBeenCalledOnce();
      expect(JSON.stringify(underOptIn)).toContain("image");
    }
  });
});

describe("an unusable URL fetch policy fails the run", () => {
  /**
   * Each of these would otherwise be swallowed. `fetchUrlContent` refuses an
   * unusable policy by throwing, and the history-replay conversion catches a
   * throw and logs "falling back to text", so without the run-level check a
   * misconfigured deployment would see attachments quietly stripped, once per
   * message, and nothing on the wire saying why.
   */
  const UNUSABLE: Array<[string, Partial<UrlFetchPolicy>]> = [
    ["maxBytes below one", { maxBytes: 0 }],
    ["a fractional maxBytes", { maxBytes: 1.5 }],
    ["timeoutMs below one", { timeoutMs: 0 }],
    ["negative maxRedirects", { maxRedirects: -1 }],
    [
      "a scheme with no pinned transport",
      { allowedSchemes: new Set(["file"]) },
    ],
    [
      "a widened scheme allowlist",
      { allowedSchemes: new Set(["http", "https", "file"]) },
    ],
    [
      "a non-boolean allowPrivateNetworks",
      { allowPrivateNetworks: "false" as unknown as boolean },
    ],
  ];

  it.each(UNUSABLE)(
    "ends the run over %s, before fetching anything",
    async (_label, overrides) => {
      mockPublicDns();
      const { spy } = stubTransport();
      const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
        config: {
          urlFetchPolicy: { ...DEFAULT_URL_FETCH_POLICY, ...overrides },
        },
      });

      const events = await collect(
        agent,
        minimalRunInput({
          threadId: "unusable",
          // A URL the DEFAULT policy would happily fetch, so a silent revert
          // to the default is distinguishable from failing closed.
          messages: messagesCarrying(
            "https://cdn.example/a.png",
            "https://cdn.example/b.png",
          ),
        }),
      );

      const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
      expect(errors).toHaveLength(1);
      expectContractError(errors[0]!, "URL_FETCH_POLICY_INVALID");
      // Not the default's answer, and not a text-only turn either: the run
      // never got as far as a socket or as far as the model.
      expect(spy).not.toHaveBeenCalled();
      expect(model.calls).toBe(0);
      expect(errorCodes(events)).toEqual(["URL_FETCH_POLICY_INVALID"]);
    },
  );

  it("names the field and the reason", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")], {
      config: {
        urlFetchPolicy: { ...DEFAULT_URL_FETCH_POLICY, maxRedirects: 1.5 },
      },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "named", messages: [] }),
    );
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      | (BaseEvent & { message?: string })
      | undefined;

    expect(error?.message).toContain("urlFetchPolicy");
    expect(error?.message).toContain("maxRedirects");
  });

  it("fails a run that carries no attachment at all", async () => {
    // Configuration, not content: the policy is wrong whether or not this
    // particular turn would have exercised it. Reporting it only on a run
    // that happens to carry a URL would leave the mistake latent until a user
    // pasted a link.
    const { agent } = realStrandsAgent([modelTurn.text("ok")], {
      config: { urlFetchPolicy: { ...DEFAULT_URL_FETCH_POLICY, maxBytes: 0 } },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "no-attachment",
        messages: [{ id: "u1", role: "user", content: "hello" }] as never[],
      }),
    );

    expect(errorCodes(events)).toEqual(["URL_FETCH_POLICY_INVALID"]);
  });

  it("lets a usable policy through untouched", async () => {
    // The guard must not be a new way for a legitimate configuration to fail.
    mockPublicDns();
    const { spy } = stubTransport("public bytes");
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: {
        urlFetchPolicy: {
          ...DEFAULT_URL_FETCH_POLICY,
          allowedSchemes: new Set(["https"]),
          maxBytes: 1024,
          maxRedirects: 0,
        },
      },
    });

    const events = await collect(
      agent,
      minimalRunInput({
        threadId: "usable",
        messages: messagesCarrying(
          "https://cdn.example/a.png",
          "https://cdn.example/b.png",
        ),
      }),
    );

    expectCompletedRun(events);
    expect(spy).toHaveBeenCalled();
    expect(imagesSeenBy(model)).toContain("public bytes");
  });
});
