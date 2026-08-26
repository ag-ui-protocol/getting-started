/**
 * URL fetch scheme/network policy (server-side request forgery and local file
 * reads) for AG-UI content sources.
 *
 * The fetch happens during mechanical input construction, before any model or
 * tool decision, so anything reachable here is reachable by anyone who can
 * post a `RunAgentInput`. These tests pin the policy at that boundary.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import type { InputContent } from "@ag-ui/core";

import {
  DEFAULT_URL_FETCH_POLICY,
  UrlFetchPolicyError,
  UrlFetchUnavailableError,
  cidr,
  urlFetchTransport,
  convertAguiContentToStrands,
  fetchUrlBytes,
  validateFetchUrl,
  type UrlFetchPolicy,
} from "../utils";

const PUBLIC_IP = "93.184.216.34";

type LogMethod = (message: string, ...args: unknown[]) => void;

function makeLog() {
  return {
    debug: vi.fn<LogMethod>(),
    warn: vi.fn<LogMethod>(),
    error: vi.fn<LogMethod>(),
  };
}

/** Point every hostname lookup at the given addresses. */
function mockDns(...addresses: string[]) {
  return vi.spyOn(dns.promises, "lookup").mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })) as never,
  );
}

function policy(overrides: Partial<UrlFetchPolicy> = {}): UrlFetchPolicy {
  return { ...DEFAULT_URL_FETCH_POLICY, ...overrides };
}

/**
 * Install a fetch stub and return it plus the URLs it was asked to open.
 *
 * The stub honours `redirect` the way the platform does: only `"manual"` hands
 * a 3xx back to the caller, so an implementation that stops asking for manual
 * redirects gets the followed body without any policy check, exactly as it
 * would in production.
 */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const attempted: string[] = [];
  const spy = vi
    .spyOn(urlFetchTransport, "request")
    .mockImplementation(async (target: string) => {
      attempted.push(target);
      return await handler(target);
    });
  return { spy, attempted };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const MALFORMED_URLS = [
  "http://example.com:99999/a.png",
  "http://example.com:-1/a.png",
  "http://example.com:abc/a.png",
  "http://[not-an-ip]/a.png",
  "http://[::1/a.png",
  "http://[cdn.example.com]/a.png",
  "http://ex℀mple.com/a.png",
];

// ---------------------------------------------------------------------------
// Scheme allowlist
// ---------------------------------------------------------------------------

describe("URL fetch policy: scheme allowlist", () => {
  it.each([
    "file:///etc/passwd",
    "file://localhost/etc/shadow",
    "ftp://example.com/secret.txt",
    "gopher://example.com:70/_test",
    "data:text/plain;base64,aGVsbG8=",
    "jar:file:///etc/passwd!/",
  ])("refuses %s without opening a connection", async (url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(await fetchUrlBytes(url, log)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("names the scheme in the refusal", async () => {
    await expect(validateFetchUrl("file:///etc/passwd")).rejects.toThrow(
      UrlFetchPolicyError,
    );
    await expect(validateFetchUrl("file:///etc/passwd")).rejects.toThrow(
      /scheme 'file' is not allowed/,
    );
  });

  it("allows https and hands back the addresses it approved", async () => {
    mockDns(PUBLIC_IP);

    // The approved set is the contract the transport is pinned to, so it is
    // returned rather than discarded.
    await expect(
      validateFetchUrl("https://example.com/file.txt"),
    ).resolves.toEqual([
      { version: 4, bytes: new Uint8Array([93, 184, 216, 34]) },
    ]);
  });

  it("does not relax the scheme allowlist under the private-network opt-in", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        "file:///etc/passwd",
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Malformed URLs
// ---------------------------------------------------------------------------

describe("URL fetch policy: malformed URLs", () => {
  it.each(MALFORMED_URLS)("refuses %s without raising", async (url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an over-long DNS label because it cannot resolve", async () => {
    const url = `http://${"a".repeat(64)}.example.com/a.png`;
    // Mocked so the case does not depend on the host resolver, which may sit
    // behind a wildcard DNS provider that answers anything.
    vi.spyOn(dns.promises, "lookup").mockRejectedValue(
      new Error("getaddrinfo EAI_AGAIN"),
    );
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops a malformed image URL during conversion", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "url",
            value: "http://example.com:abc/a.png",
            mimeType: "image/png",
          },
        },
      ] as InputContent[],
      makeLog(),
    );

    expect(blocks).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Private / loopback / link-local network blocking
// ---------------------------------------------------------------------------

describe("URL fetch policy: blocked address ranges", () => {
  it.each([
    // Cloud instance metadata: credentials to a plain unauthenticated GET.
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    // Container task credentials, served to a plain request on the same range.
    "http://169.254.170.2/v2/credentials/",
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/router",
    "http://172.16.0.1/",
    "http://100.64.1.1/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[ff02::1]/",
    "http://0.0.0.0/",
  ])("refuses %s", async (url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["decimal loopback", "http://2130706433/"],
    ["shortened loopback", "http://127.1/"],
    ["hexadecimal loopback", "http://0x7f000001/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
  ])("refuses the %s form", async (_label, url) => {
    const dnsSpy = mockDns(PUBLIC_IP);
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // The alternate forms must be recognised as literals, never handed to a
    // resolver that might or might not normalise them.
    expect(dnsSpy).not.toHaveBeenCalled();
  });

  it("names the blocked address in the refusal", async () => {
    await expect(
      validateFetchUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("refuses a hostname that resolves to the metadata address", async () => {
    mockDns("169.254.169.254");
    await expect(
      validateFetchUrl("http://metadata.attacker.example/"),
    ).rejects.toThrow(UrlFetchPolicyError);
  });

  it("refuses a hostname that resolves to loopback", async () => {
    mockDns("127.0.0.1");
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes("http://localhost:9000/", makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an unresolvable hostname", async () => {
    vi.spyOn(dns.promises, "lookup").mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND"),
    );
    // Fails closed, but a resolver error is not a refusal, so it must not be
    // reported as one.
    await expect(
      validateFetchUrl("http://does-not-exist.invalid/"),
    ).rejects.toThrow(UrlFetchUnavailableError);
  });

  it("refuses a host resolving to both a public and a private address", async () => {
    mockDns(PUBLIC_IP, "127.0.0.1");
    await expect(validateFetchUrl("http://rebind.example/")).rejects.toThrow(
      UrlFetchPolicyError,
    );
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.170.2/v2/credentials/",
    "http://[fe80::1]/",
  ])("keeps %s blocked under the private-network opt-in", async (url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        url,
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:169.254.170.2]/v2/credentials/",
  ])(
    "unwraps %s and keeps it blocked under the private-network opt-in",
    async (url) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));

      expect(
        await fetchUrlBytes(
          url,
          makeLog(),
          policy({ allowPrivateNetworks: true }),
        ),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("reports an IPv4-mapped address in its unwrapped form", async () => {
    await expect(
      validateFetchUrl("http://[::ffff:169.254.169.254]/"),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("logs refusals at error level", async () => {
    const log = makeLog();
    const { spy } = stubFetch(() => new Response("should not be reached"));

    await fetchUrlBytes("http://169.254.169.254/latest/meta-data/", log);

    expect(spy).not.toHaveBeenCalled();

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledOnce();
    expect(String(log.error.mock.calls[0][0])).toContain(
      "Refusing to fetch URL",
    );
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe("URL fetch policy: redirects", () => {
  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("refuses a redirect to the metadata address before the hop goes out", async () => {
    mockDns(PUBLIC_IP);
    const metadataUrl = "http://169.254.169.254/latest/meta-data/";
    const startUrl = "http://public.example/start";
    const { attempted } = stubFetch((url) =>
      url === startUrl
        ? redirectTo(metadataUrl)
        : new Response("metadata secret"),
    );
    const log = makeLog();

    expect(await fetchUrlBytes(startUrl, log)).toBeNull();
    expect(attempted).toEqual([startUrl]);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("refuses a redirect to a blocked scheme", async () => {
    mockDns(PUBLIC_IP);
    const startUrl = "http://public.example/start";
    const { attempted } = stubFetch(() => redirectTo("file:///etc/passwd"));

    expect(await fetchUrlBytes(startUrl, makeLog())).toBeNull();
    expect(attempted).toEqual([startUrl]);
  });

  it.each([301, 302, 303, 307, 308])(
    "re-validates a %d redirect",
    async (status) => {
      mockDns(PUBLIC_IP);
      const startUrl = "http://public.example/start";
      const { attempted } = stubFetch(() =>
        redirectTo("http://127.0.0.1/admin", status),
      );

      expect(await fetchUrlBytes(startUrl, makeLog())).toBeNull();
      expect(attempted).toEqual([startUrl]);
    },
  );

  it("follows an allowed redirect and returns the final body", async () => {
    mockDns(PUBLIC_IP);
    const startUrl = "http://public.example/start";
    const finalUrl = "http://public.example/final";
    const { attempted } = stubFetch((url) =>
      url === startUrl ? redirectTo("/final") : new Response("payload"),
    );

    const bytes = await fetchUrlBytes(startUrl, makeLog());

    expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
    expect(attempted).toEqual([startUrl, finalUrl]);
  });

  it("stops at the redirect hop cap", async () => {
    mockDns(PUBLIC_IP);
    let hop = 0;
    // The chain never ends on its own; the ceiling turns an uncapped follow
    // loop into a fast failure instead of a hang.
    const { attempted } = stubFetch(() => {
      if (++hop > 8) throw new Error("redirect chain was never capped");
      return redirectTo(`http://public.example/hop-${hop}`);
    });
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "http://public.example/start",
        log,
        policy({ maxRedirects: 2 }),
      ),
    ).toBeNull();
    expect(attempted).toHaveLength(3);
    expect(String(log.error.mock.calls[0][0])).toContain(
      "more than 2 redirects",
    );
  });

  it("refuses the first redirect when the hop cap is zero", async () => {
    mockDns(PUBLIC_IP);
    let hop = 0;
    const { attempted } = stubFetch(() => {
      if (++hop > 8) throw new Error("redirect chain was never capped");
      return redirectTo(`http://public.example/next-${hop}`);
    });
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "http://public.example/start",
        log,
        policy({ maxRedirects: 0 }),
      ),
    ).toBeNull();
    expect(attempted).toEqual(["http://public.example/start"]);
    expect(String(log.error.mock.calls[0][0])).toContain(
      "more than 0 redirects",
    );
  });

  it("names the failing redirect hop, not just the original URL", async () => {
    mockDns(PUBLIC_IP);
    const startUrl = "http://public.example/start";
    stubFetch((url) =>
      url === startUrl
        ? redirectTo("http://public.example/gone")
        : new Response(null, { status: 404 }),
    );
    const log = makeLog();

    expect(await fetchUrlBytes(startUrl, log)).toBeNull();
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).toMatch(/at redirect target url#[0-9a-f]{12}/);
    // The hop is a different URL from the one requested, so it must carry a
    // different identifier.
    const ids = [...line.matchAll(/url#([0-9a-f]{12})/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it("names the hop when a redirect target is refused on policy", async () => {
    mockDns(PUBLIC_IP);
    const startUrl = "http://public.example/start";
    stubFetch(() => redirectTo("file:///etc/passwd"));
    const log = makeLog();

    expect(await fetchUrlBytes(startUrl, log)).toBeNull();
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toContain("scheme 'file' is not allowed");
    // The hop is identified, but only opaquely.
    expect(message).toMatch(/at redirect target url#[0-9a-f]{12}/);
    expect(message).not.toContain("/etc/passwd");
  });

  it("re-validates a hop whose hostname resolves to a blocked address", async () => {
    // Every other redirect case uses IP literals, which would let a cached or
    // hoisted lookup pass. This one needs the resolver on the hop itself.
    const startUrl = "http://public.example/start";
    vi.spyOn(dns.promises, "lookup").mockImplementation((async (
      host: string,
    ) => [
      {
        address: host === "public.example" ? PUBLIC_IP : "169.254.169.254",
        family: 4,
      },
    ]) as never);
    const { attempted } = stubFetch(() =>
      redirectTo("http://internal.example/creds"),
    );

    expect(await fetchUrlBytes(startUrl, makeLog())).toBeNull();
    expect(attempted).toEqual([startUrl]);
  });

  it("refuses a redirect without a Location header", async () => {
    mockDns(PUBLIC_IP);
    const { attempted } = stubFetch(() => new Response(null, { status: 302 }));
    const log = makeLog();

    expect(await fetchUrlBytes("http://public.example/start", log)).toBeNull();
    expect(attempted).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Response size cap
// ---------------------------------------------------------------------------

describe("URL fetch policy: response size cap", () => {
  it("refuses an oversized response", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(() => new Response("x".repeat(100)));
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "https://example.com/big.bin",
        log,
        policy({ maxBytes: 10 }),
      ),
    ).toBeNull();
    expect(String(log.error.mock.calls[0][0])).toContain(
      "response exceeds the 10 byte limit",
    );
  });

  it("refuses on a declared length over the limit without reading the body", async () => {
    mockDns(PUBLIC_IP);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      () => new Response(body, { headers: { "content-length": "9999" } }),
    );
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "https://example.com/big.bin",
        log,
        policy({ maxBytes: 10 }),
      ),
    ).toBeNull();
    // Released rather than consumed. The stream's own read-ahead accounts for
    // the one queued chunk; nothing further is transferred.
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1);
    expect(String(log.error.mock.calls[0][0])).toContain("declares 9999 bytes");
  });

  it("still enforces the cap when the declared length understates the body", async () => {
    mockDns(PUBLIC_IP);
    // A server can lie, so the header must not be the authority.
    stubFetch(
      () =>
        new Response("x".repeat(100), {
          headers: { "content-length": "1" },
        }),
    );

    expect(
      await fetchUrlBytes(
        "https://example.com/liar.bin",
        makeLog(),
        policy({ maxBytes: 10 }),
      ),
    ).toBeNull();
  });

  it("refuses a response one byte over the limit", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(() => new Response("x".repeat(11)));

    expect(
      await fetchUrlBytes(
        "https://example.com/over.bin",
        makeLog(),
        policy({ maxBytes: 10 }),
      ),
    ).toBeNull();
  });

  it("returns a response exactly at the limit", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(() => new Response("x".repeat(10)));

    const bytes = await fetchUrlBytes(
      "https://example.com/exact.bin",
      makeLog(),
      policy({ maxBytes: 10 }),
    );

    expect(bytes).toEqual(new TextEncoder().encode("x".repeat(10)));
  });

  it("returns a response within the limit", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(() => new Response("hello"));

    const bytes = await fetchUrlBytes(
      "https://example.com/small.txt",
      makeLog(),
      policy({ maxBytes: 1024 }),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("hello");
  });

  it("stops pulling from the stream instead of buffering the whole body", async () => {
    mockDns(PUBLIC_IP);
    const chunk = 1024;
    const cap = 2048;
    // Far past the cap, but finite, so an unbounded read fails on the
    // assertions below instead of never returning.
    const ceiling = 64;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > ceiling) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(() => new Response(body));

    const result = await fetchUrlBytes(
      "https://example.com/endless.bin",
      makeLog(),
      policy({ maxBytes: cap }),
    );

    expect(result).toBeNull();
    // The cap has to be enforced while the stream is still being consumed, not
    // after the whole body has been buffered. The bound is generous relative
    // to the cap so that a change in stream read-ahead cannot fail it, while
    // still being far below the ceiling an unbounded read would reach.
    expect(pulls).toBeGreaterThan(0);
    expect(pulls * chunk).toBeLessThan(cap * 4);
    expect(cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configurability (safe by default, opt-in relaxation)
// ---------------------------------------------------------------------------

describe("URL fetch policy: configuration", () => {
  it("defaults are restrictive", () => {
    expect([...DEFAULT_URL_FETCH_POLICY.allowedSchemes].sort()).toEqual([
      "http",
      "https",
    ]);
    expect(DEFAULT_URL_FETCH_POLICY.allowPrivateNetworks).toBe(false);
    expect(DEFAULT_URL_FETCH_POLICY.maxBytes).toBe(25 * 1024 * 1024);
    expect(DEFAULT_URL_FETCH_POLICY.timeoutMs).toBe(30_000);
    expect(DEFAULT_URL_FETCH_POLICY.maxRedirects).toBe(10);
  });

  it("allows private networks when opted into", async () => {
    stubFetch(() => new Response("local"));

    const bytes = await fetchUrlBytes(
      "http://127.0.0.1:8000/f.txt",
      makeLog(),
      policy({ allowPrivateNetworks: true }),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("local");
  });

  it("keeps 0.0.0.0/8 blocked when private networks are opted into", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "http://0.1.2.3/probe",
        log,
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(String(log.error.mock.calls[0][0])).toContain("0.1.2.3");
  });

  it.each([["ftp"], ["data"], ["file"], ["blob"]])(
    "refuses a policy that allows the %s scheme",
    async (scheme) => {
      // Only http and https get a transport pinned to the validated addresses.
      // Any other scheme would be fetched by a client that resolves the host
      // again, reopening the rebinding window.
      await expect(
        fetchUrlBytes(
          `${scheme}://example.com/f.txt`,
          makeLog(),
          policy({ allowedSchemes: new Set([scheme]) }),
        ),
      ).rejects.toThrow(/may only contain http and https/);
    },
  );

  it("accepts an allowlist narrowed to https alone", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(() => new Response("secure"));

    const bytes = await fetchUrlBytes(
      "https://example.com/f.txt",
      makeLog(),
      policy({ allowedSchemes: new Set(["https"]) }),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("secure");
    expect(
      await fetchUrlBytes(
        "http://example.com/f.txt",
        makeLog(),
        policy({ allowedSchemes: new Set(["https"]) }),
      ),
    ).toBeNull();
  });

  it("refuses a host-less URL whatever the opt-ins say", async () => {
    // There is no longer an escape hatch here: a host-less scheme cannot be
    // allowed at all, so `data:` is refused on the scheme before the missing
    // host is even reached.
    const dataUrl = "data:text/plain;base64,aGVsbG8=";

    await expect(validateFetchUrl(dataUrl)).rejects.toThrow(
      /scheme 'data' is not allowed/,
    );
    await expect(
      validateFetchUrl(dataUrl, policy({ allowPrivateNetworks: true })),
    ).rejects.toThrow(/scheme 'data' is not allowed/);
  });
});

// ---------------------------------------------------------------------------
// End to end through content conversion
// ---------------------------------------------------------------------------

describe("content conversion does not fetch blocked URLs", () => {
  it("drops an image URL source with the file scheme", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "url",
            value: "file:///etc/passwd",
            mimeType: "image/png",
          },
        },
      ] as InputContent[],
      makeLog(),
    );

    expect(blocks).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops a URL source on the deprecated binary content path", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "binary",
          mimeType: "image/png",
          url: "http://169.254.169.254/latest/meta-data/",
        },
      ] as unknown as InputContent[],
      makeLog(),
    );

    expect(blocks).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("opens no connection to a live loopback listener", async () => {
    const connections: string[] = [];
    const server = http.createServer((req, res) => {
      connections.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end("LOOPBACK SECRET");
    });
    server.on("connection", () => connections.push("<tcp>"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: {
              type: "url",
              value: `http://127.0.0.1:${port}/x.png`,
              mimeType: "image/png",
            },
          },
        ] as InputContent[],
        makeLog(),
      );

      expect(blocks).toEqual([]);
      expect(connections).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// IPv6 spellings that embed an IPv4 target
// ---------------------------------------------------------------------------

describe("URL fetch policy: IPv6 transition forms", () => {
  it.each([
    ["6to4 metadata", "http://[2002:a9fe:a9fe::]/latest/meta-data/"],
    ["6to4 loopback", "http://[2002:7f00:1::]/"],
    ["6to4 private", "http://[2002:a00:1::]/"],
    ["6to4 relay anycast IPv4", "http://192.88.99.1/"],
  ])("refuses %s by default", async (_label, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  // Every one of these is a different IPv6 spelling of 169.254.169.254. The
  // private-network opt-in must not turn any of them into a way to reach the
  // metadata endpoint.
  it.each([
    ["IPv4-mapped", "http://[::ffff:169.254.169.254]/"],
    ["IPv4-compatible", "http://[::169.254.169.254]/"],
    ["IPv4-translated", "http://[::ffff:0:169.254.169.254]/"],
    ["NAT64 well-known", "http://[64:ff9b::169.254.169.254]/"],
    // The whole local-use prefix is refused rather than decoded, because
    // RFC 6052 splits the embedded IPv4 around the reserved octet at byte 8:
    // 169.254.169.254 under this prefix is 64:ff9b:1:a9fe:a9:fe00::, not the
    // contiguous spelling it looks like it should be.
    [
      "NAT64 local-use, RFC 6052 encoding",
      "http://[64:ff9b:1:a9fe:a9:fe00::]/",
    ],
    [
      "NAT64 local-use, contiguous spelling",
      "http://[64:ff9b:1:a9fe:0:a9fe::]/",
    ],
    ["6to4", "http://[2002:a9fe:a9fe::]/"],
  ])(
    "keeps the %s spelling of the metadata address blocked under the private-network opt-in",
    async (_label, url) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));

      expect(
        await fetchUrlBytes(
          url,
          makeLog(),
          policy({ allowPrivateNetworks: true }),
        ),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  // A NAT64 address is a wrapper: the IPv4 it carries is what gets judged, so
  // a blocked destination is refused and a public one is allowed through.
  it.each([
    // RFC 6052 splits the embedded address around the reserved octet at byte 8.
    [
      "NAT64 local-use carrying 192.88.99.1",
      "http://[64:ff9b:1:c058:63:100::]/",
    ],
    [
      "NAT64 local-use carrying the metadata address",
      "http://[64:ff9b:1:a9fe:a9:fe00::]/",
    ],
    [
      "NAT64 well-known carrying the metadata address",
      "http://[64:ff9b::a9fe:a9fe]/",
    ],
    ["NAT64 well-known carrying loopback", "http://[64:ff9b::7f00:1]/"],
    ["NAT64 well-known carrying a private address", "http://[64:ff9b::a00:1]/"],
  ])("refuses %s", async (_label, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["the well-known prefix", "http://[64:ff9b::1]/"],
    ["the local-use prefix", "http://[64:ff9b:1:0:0:100::]/"],
  ])("refuses 0.0.0.1 through %s", async (_label, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(await fetchUrlBytes(url, log)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(String(log.error.mock.calls[0][0])).toContain("0.0.0.1");
  });

  it.each([
    ["the well-known prefix", "http://[64:ff9b::1]/"],
    ["the local-use prefix", "http://[64:ff9b:1:0:0:100::]/"],
  ])(
    "keeps 0.0.0.1 through %s blocked under the private-network opt-in",
    async (_label, url) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));
      const log = makeLog();

      expect(
        await fetchUrlBytes(url, log, policy({ allowPrivateNetworks: true })),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(String(log.error.mock.calls[0][0])).toContain("0.0.0.1");
    },
  );

  it.each([
    {
      label: "direct IPv4 zero-net under the default policy",
      url: "http://0.0.0.1/probe",
      fetchPolicy: undefined,
    },
    {
      label: "direct IPv4 zero-net with the private-network opt-in",
      url: "http://0.0.0.1/probe",
      fetchPolicy: policy({ allowPrivateNetworks: true }),
    },
    {
      label: "well-known NAT64 zero-net under the default policy",
      url: "http://[64:ff9b::1]/probe",
      fetchPolicy: undefined,
    },
    {
      label: "well-known NAT64 zero-net with the private-network opt-in",
      url: "http://[64:ff9b::1]/probe",
      fetchPolicy: policy({ allowPrivateNetworks: true }),
    },
    {
      label: "local-use NAT64 zero-net under the default policy",
      url: "http://[64:ff9b:1:0:0:100::]/probe",
      fetchPolicy: undefined,
    },
    {
      label: "local-use NAT64 zero-net with the private-network opt-in",
      url: "http://[64:ff9b:1:0:0:100::]/probe",
      fetchPolicy: policy({ allowPrivateNetworks: true }),
    },
  ])("keeps $label blocked", async ({ url, fetchPolicy }) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(await fetchUrlBytes(url, log, fetchPolicy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(String(log.error.mock.calls[0][0])).toContain("0.0.0.1");
  });

  it.each([
    // 93.184.216.34, a public address, translated under each known prefix.
    ["the well-known prefix", "http://[64:ff9b::5db8:d822]/f.bin"],
    ["the local-use prefix", "http://[64:ff9b:1:5db8:0:d822::]/f.bin"],
  ])(
    "allows a public IPv4 destination reached through %s",
    async (_label, url) => {
      // An IPv6-only deployment reaching IPv4-only services over DNS64/NAT64
      // must still be able to download a public image.
      stubFetch(() => new Response("payload"));

      const bytes = await fetchUrlBytes(url, makeLog());

      expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
    },
  );

  it("refuses a private destination under a configured network-specific prefix", async () => {
    const configured = policy({ nat64Prefixes: ["2600:1f18:aaaa::/48"] });
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        "http://[2600:1f18:aaaa:a00:1::]/",
        makeLog(),
        configured,
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats an unconfigured network-specific prefix as ordinary global IPv6", async () => {
    // A deployment-specific prefix cannot be inferred from the address alone.
    // This is the documented limitation: without configuration the address is
    // not recognised as NAT64, so an egress control has to cover it.
    stubFetch(() => new Response("payload"));

    const bytes = await fetchUrlBytes(
      "http://[2600:1f18:aaaa:a00:1::]/f.bin",
      makeLog(),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
  });

  it.each([
    ["Alibaba Cloud metadata", "http://100.100.100.200/latest/meta-data/"],
    ["Alibaba Cloud metadata, IPv4-mapped", "http://[::ffff:100.100.100.200]/"],
    ["Oracle Cloud metadata", "http://192.0.0.192/opc/v2/instance/"],
  ])(
    "keeps %s blocked under the private-network opt-in",
    async (_label, url) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));

      expect(
        await fetchUrlBytes(
          url,
          makeLog(),
          policy({ allowPrivateNetworks: true }),
        ),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["this-network", "http://0.1.2.3/"],
    ["IETF protocol assignments", "http://192.0.0.8/"],
    ["TEST-NET-1", "http://192.0.2.5/"],
    ["benchmarking", "http://198.18.0.5/"],
    ["TEST-NET-2", "http://198.51.100.5/"],
    ["TEST-NET-3", "http://203.0.113.5/"],
    ["reserved", "http://240.0.0.5/"],
    ["broadcast", "http://255.255.255.255/"],
    ["IETF protocol assignments v6", "http://[2001:0:1::1]/"],
    ["documentation v6", "http://[2001:db8::1]/"],
    ["unique local v6", "http://[fc00::1]/"],
  ])("refuses the %s range by default", async (_label, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["Azure WireServer", "http://168.63.129.16/machine/"],
    ["Azure WireServer, IPv4-mapped", "http://[::ffff:168.63.129.16]/"],
  ])("keeps %s blocked under the private-network opt-in", async (_l, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        url,
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses the RFC 9637 documentation range by default", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes("http://[3fff::1]/", makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("names the embedded IPv4 rather than only the IPv6 wrapper", async () => {
    await expect(
      validateFetchUrl("http://[2002:a9fe:a9fe::]/"),
    ).rejects.toThrow(/169\.254\.169\.254 \(embedded in 2002:a9fe:a9fe/);
  });

  it.each([
    // Teredo carries the client IPv4 in its low 32 bits XOR 0xffffffff, so
    // 169.254.169.254 becomes 5601:5601. The prefix is refused as a range.
    [
      "Teredo carrying the metadata address",
      "http://[2001:0:0:0:0:0:5601:5601]/",
    ],
    ["Teredo carrying anything at all", "http://[2001:0:0:0:0:0:1:2]/"],
  ])("refuses %s under the private-network opt-in", async (_label, url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        url,
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses the 6bone range by default", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes("http://[3ffe::1]/", makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the AWS IPv6 metadata address blocked under the private-network opt-in", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes(
        "http://[fd00:ec2::254]/latest/meta-data/",
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a 6to4 address even when it embeds a public IPv4", async () => {
    // 2002:5db8:d822:: embeds 93.184.216.34, which is public. 6to4 is
    // deprecated and the whole range is special-purpose, so it stays blocked
    // on the range alone rather than on the embedded address.
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(
      await fetchUrlBytes("http://[2002:5db8:d822::]/f.bin", makeLog()),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("omits the embedded-address clause for a plain IPv4 host", async () => {
    await expect(validateFetchUrl("http://169.254.169.254/")).rejects.toThrow(
      /non-public address 169\.254\.169\.254, which is blocked/,
    );
    await expect(
      validateFetchUrl("http://169.254.169.254/"),
    ).rejects.not.toThrow(/embedded in/);
  });

  it("still allows a genuine public IPv6 address", async () => {
    stubFetch(() => new Response("payload"));

    const bytes = await fetchUrlBytes(
      "http://[2001:4860:4860::8888]/f.bin",
      makeLog(),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
  });

  // The URL constructor rejects these before any policy code runs, which is
  // itself worth pinning. The parser's own strictness is exercised through the
  // resolver path, where an arbitrary string can reach it.
  it.each([
    "http://[1:2:3:4:5:6:7:8:9]/",
    "http://[12345::]/",
    "http://[::ffff:127.0.0.1.5]/",
    "http://[::zz]/",
  ])("refuses %s before it reaches the address parser", async (url) => {
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes(url, makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Blocklist construction
// ---------------------------------------------------------------------------

describe("URL fetch policy: blocklist construction", () => {
  // A bare address would yield a NaN prefix length, and every membership test
  // against it would pass, turning one entry into "block everything".
  it.each(["169.254.0.0", "169.254.0.0/", "169.254.0.0/abc", "10.0.0.0/33"])(
    "rejects the unusable CIDR literal %s",
    (literal) => {
      expect(() => cidr(literal)).toThrow();
    },
  );

  it.each(["0.0.0.0/0", "::/0"])(
    "rejects the match-everything prefix %s",
    (literal) => {
      expect(() => cidr(literal)).toThrow();
    },
  );

  it("accepts a well-formed CIDR literal", () => {
    expect(() => cidr("169.254.0.0/16")).not.toThrow();
    expect(() => cidr("fe80::/10")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connection and resource handling
// ---------------------------------------------------------------------------

describe("URL fetch policy: resource handling", () => {
  function trackedResponse(
    cancelled: string[],
    label: string,
    status: number,
    headers: Record<string, string> = {},
  ): Response {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled.push(label);
      },
    });
    return new Response(body, { status, headers });
  }

  it("releases the body of a redirect hop and of an error response", async () => {
    mockDns(PUBLIC_IP);
    const cancelled: string[] = [];
    let call = 0;
    stubFetch(() =>
      ++call === 1
        ? trackedResponse(cancelled, "redirect-hop", 302, {
            location: "http://public.example/next",
          })
        : trackedResponse(cancelled, "error-response", 404),
    );

    expect(await fetchUrlBytes("http://public.example/start", makeLog())).toBe(
      null,
    );
    // Undici holds the socket until the body is consumed or cancelled.
    expect(cancelled).toEqual(["redirect-hop", "error-response"]);
  });

  it("releases the body of a redirect with no Location header", async () => {
    mockDns(PUBLIC_IP);
    const cancelled: string[] = [];
    stubFetch(() => trackedResponse(cancelled, "no-location", 302));

    expect(await fetchUrlBytes("http://public.example/start", makeLog())).toBe(
      null,
    );
    expect(cancelled).toEqual(["no-location"]);
  });

  it("gives up on a hung request at the policy timeout", async () => {
    mockDns(PUBLIC_IP);
    const spy = vi.spyOn(urlFetchTransport, "request").mockImplementation(
      (_target, _approved, _policy, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            ),
          );
        }),
    );
    const log = makeLog();

    const bytes = await fetchUrlBytes(
      "http://public.example/hangs",
      log,
      policy({ timeoutMs: 25 }),
    );

    expect(bytes).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Resolution results that cannot be checked
// ---------------------------------------------------------------------------

describe("URL fetch policy: unusable resolution results", () => {
  it("refuses a host whose resolved address cannot be parsed", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "not-an-address", family: 4 },
    ] as never);
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes("http://weird.example/", makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    "1:2:3:4:5:6:7:8:9",
    "12345::",
    "::ffff:127.0.0.1.5",
    "1:2:3:4:5:6:7",
    // Nine groups whose first eight spell a public address. A parser that
    // truncated instead of refusing would validate an address that is not the
    // one the resolver returned.
    "2001:4860:4860:0:0:0:0:8888:1",
    // A dotted quad is only legal as the final group. This one has exactly
    // eight groups' worth and its pieces are all well formed, so only the
    // position rule rejects it -- and misparsing it would yield a public
    // address that passes every range check.
    "2001:4860:8.8.8.8:4860:0:0:0",
    "2001::1.2.3.4:5",
    "1.2.3.4:0:0:0:0:0:0:0",
  ])("refuses a host resolved to the malformed address %s", async (address) => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address, family: 6 },
    ] as never);
    const { spy } = stubFetch(() => new Response("should not be reached"));

    expect(await fetchUrlBytes("http://weird.example/", makeLog())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives up on a stalled resolver at the policy timeout", async () => {
    vi.spyOn(dns.promises, "lookup").mockImplementation(
      () => new Promise(() => {}) as never,
    );
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    const started = Date.now();
    const bytes = await fetchUrlBytes(
      "http://slow-resolver.example/f.bin",
      log,
      policy({ timeoutMs: 40 }),
    );

    expect(bytes).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(spy).not.toHaveBeenCalled();
    // A stalled resolver is a transient failure, not a policy refusal, so it
    // must not pollute the error-level refusal signal.
    expect(log.error).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain(
      "exceeded the request deadline",
    );
  });

  it("refuses a host that resolves to an empty address list", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([] as never);

    await expect(validateFetchUrl("http://empty.example/")).rejects.toThrow(
      UrlFetchUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// Default policy immutability
// ---------------------------------------------------------------------------

describe("URL fetch policy: default is not mutable", () => {
  it("cannot be repointed at a larger cap by a third party", () => {
    expect(Object.isFrozen(DEFAULT_URL_FETCH_POLICY)).toBe(true);
    expect(() => {
      (DEFAULT_URL_FETCH_POLICY as { maxBytes: number }).maxBytes = 1;
    }).toThrow();
    expect(DEFAULT_URL_FETCH_POLICY.maxBytes).toBe(25 * 1024 * 1024);
  });

  it("cannot have a scheme added to its allowlist", () => {
    const allowlist = DEFAULT_URL_FETCH_POLICY.allowedSchemes;

    // Reaching past a shadowed own property is what defeats a frozen Set, so
    // that is the call the guarantee has to survive.
    expect(() => Set.prototype.add.call(allowlist as never, "file")).toThrow();
    expect(() => (allowlist as unknown as Set<string>).add("file")).toThrow();
    expect(allowlist.has("file")).toBe(false);
    expect([...allowlist].sort()).toEqual(["http", "https"]);
  });
});

// ---------------------------------------------------------------------------
// Packaging contract
// ---------------------------------------------------------------------------

describe("URL fetch policy: main-entry dependency graph", () => {
  // src/index.ts deliberately keeps server-only dependencies off the main
  // entry so client-side bundlers can trace it. Every module it re-exports is
  // part of that graph, so all of them are checked, not only the one this
  // change touched.
  const MAIN_ENTRY_MODULES = [
    "index.ts",
    "agent.ts",
    "client-proxy-tool.ts",
    "utils.ts",
    "a2ui-tool.ts",
    "logger.ts",
    "config.ts",
    "types.ts",
  ];

  // Static builtin imports that already existed on main. Recorded rather than
  // fixed here, so a NEW one anywhere in the graph fails this test while the
  // known pre-existing case does not mask it.
  const KNOWN_STATIC_BUILTINS: Record<string, string[]> = {
    "agent.ts": ["crypto"],
  };

  const QUOTE = "[\"'`]";

  /**
   * Every Node builtin `source` pulls in through a static specifier.
   *
   * Uses the real builtin list rather than a hand-kept one. Covers
   * `from "x"`, a bare side-effect `import "x"` and `require("x")`, in any
   * quote style, with or without the `node:` prefix or a subpath, and across
   * however many lines a formatter has wrapped the statement onto.
   */
  function staticBuiltinsIn(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      // `import type` is erased at compile time, so it reaches no bundler.
      .replace(/^\s*import\s+type\s[^;]*;/gm, "");
    const names = builtinModules
      .filter((name) => !name.startsWith("_"))
      .sort((a, b) => b.length - a.length)
      .join("|")
      .replace(/\//g, "\\/");
    const name = `(?:node:)?(?:${names})`;
    const patterns = [
      `\\bfrom\\s*${QUOTE}(${name})${QUOTE}`,
      `^\\s*import\\s+${QUOTE}(${name})${QUOTE}`,
      `\\brequire\\s*\\(\\s*${QUOTE}(${name})${QUOTE}`,
    ];
    const found = new Set<string>();
    for (const pattern of patterns) {
      for (const match of code.matchAll(new RegExp(pattern, "gm"))) {
        found.add(match[1].replace(/^node:/, "").split("/")[0]);
      }
    }
    return [...found].sort();
  }

  it.each(MAIN_ENTRY_MODULES)(
    "%s pulls in no Node builtin beyond the recorded baseline",
    (module) => {
      const source = readFileSync(
        new URL(`../${module}`, import.meta.url),
        "utf8",
      );

      expect(staticBuiltinsIn(source)).toEqual(
        (KNOWN_STATIC_BUILTINS[module] ?? []).slice().sort(),
      );
    },
  );

  it("reaches node:dns through a deferred import instead", () => {
    const source = readFileSync(
      new URL("../utils.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(/await import\(["'`]node:dns["'`]\)/);
    expect(staticBuiltinsIn(source)).toEqual([]);
  });

  it.each([
    'import dns from "node:dns";',
    "import dns from 'node:dns';",
    'import { promises } from "dns";',
    'import "node:net";',
    'const dns = require("node:dns");',
    'import fs from "node:fs/promises";',
    'import {\n  promises,\n} from "node:dns";',
    'const x = 1; // not an import\nimport net from "net";',
  ])("detects the static builtin import form %#", (form) => {
    // Guards the guard: each of these evaded a narrower version of this check
    // at some point, so the detector is asserted against them directly.
    expect(staticBuiltinsIn(form).length).toBeGreaterThan(0);
  });

  it.each([
    '// import dns from "node:dns"',
    'const specifier = "node:dns";',
    'import { thing } from "./local";',
    'import pkg from "@ag-ui/core";',
    'const url = "https://example.com/path";',
  ])("does not mistake %# for a builtin import", (line) => {
    expect(staticBuiltinsIn(line)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every spelling of every blocked target
// ---------------------------------------------------------------------------

/**
 * Derive each IPv6 transition spelling of `v4` from its octets.
 *
 * Generated rather than written out, because a hand-written literal can encode
 * the wrong layout and then assert the implementation's matching mistake. The
 * refusal message is checked against `v4` as well, so a spelling that does not
 * actually carry the intended address fails instead of passing for the wrong
 * reason.
 */
function ipv6Spellings(v4: string): { label: string; host: string }[] {
  const [a, b, c, d] = v4.split(".").map(Number);
  const group = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
  return [
    { label: "IPv4-mapped", host: `[::ffff:${v4}]` },
    { label: "IPv4-compatible", host: `[::${v4}]` },
    { label: "IPv4-translated", host: `[::ffff:0:${v4}]` },
    { label: "NAT64 well-known", host: `[64:ff9b::${v4}]` },
    { label: "6to4", host: `[2002:${group(a, b)}:${group(c, d)}::]` },
  ];
}

// Reachable by a plain GET and never a legitimate content source, so these stay
// blocked whatever the policy says.
const ALWAYS_BLOCKED_TARGETS = [
  ["EC2 / AgentCore instance metadata", "169.254.169.254"],
  ["ECS / Fargate task credentials", "169.254.170.2"],
  ["Alibaba Cloud metadata", "100.100.100.200"],
  ["Oracle Cloud metadata", "192.0.0.192"],
];

// Blocked by the default policy; an explicit private-network opt-in may reach
// them, which is the point of the opt-in.
const DEFAULT_BLOCKED_TARGETS = [
  ["loopback", "127.0.0.1"],
  ["private class A", "10.0.0.1"],
  ["private class C", "192.168.1.1"],
  ["carrier-grade NAT", "100.64.1.1"],
  ["6to4 relay anycast", "192.88.99.1"],
];

describe("URL fetch policy: every spelling of a blocked target", () => {
  const cases = [...ALWAYS_BLOCKED_TARGETS, ...DEFAULT_BLOCKED_TARGETS].flatMap(
    ([name, v4]) =>
      ipv6Spellings(v4).map(({ label, host }) => ({ name, v4, label, host })),
  );

  it.each(cases)(
    "refuses $name as $label ($host) by default",
    async ({ v4, host }) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));
      const log = makeLog();

      expect(await fetchUrlBytes(`http://${host}/probe`, log)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      // Proves the spelling really carries the address it claims to.
      expect(String(log.error.mock.calls[0][0])).toContain(v4);
    },
  );

  const optInCases = ALWAYS_BLOCKED_TARGETS.flatMap(([name, v4]) => [
    { name, v4, label: "plain IPv4", host: v4 },
    ...ipv6Spellings(v4).map(({ label, host }) => ({ name, v4, label, host })),
  ]);

  it.each(optInCases)(
    "refuses $name as $label ($host) even with the private-network opt-in",
    async ({ v4, host }) => {
      const { spy } = stubFetch(() => new Response("should not be reached"));
      const log = makeLog();

      expect(
        await fetchUrlBytes(
          `http://${host}/probe`,
          log,
          policy({ allowPrivateNetworks: true }),
        ),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(String(log.error.mock.calls[0][0])).toContain(v4);
    },
  );

  it.each(DEFAULT_BLOCKED_TARGETS)(
    "reaches %s under an explicit private-network opt-in",
    async (_label, v4) => {
      // The opt-in has to actually opt in, or the suite above would pass with
      // a policy that blocks everything unconditionally.
      stubFetch(() => new Response("internal"));

      const bytes = await fetchUrlBytes(
        `http://${v4}/probe`,
        makeLog(),
        policy({ allowPrivateNetworks: true }),
      );

      expect(bytes && Buffer.from(bytes).toString()).toBe("internal");
    },
  );

  it("still reaches a public address through the same spellings", async () => {
    // The generator has to be capable of producing something allowed, or the
    // suite above would pass even if the policy blocked everything.
    stubFetch(() => new Response("payload"));

    const bytes = await fetchUrlBytes(
      "http://[::ffff:93.184.216.34]/f.bin",
      makeLog(),
      policy({ allowPrivateNetworks: true }),
    );

    expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics and policy hygiene
// ---------------------------------------------------------------------------

describe("URL fetch policy: log hygiene", () => {
  // Sentinels in every component a URL can carry a secret in. Stripping the
  // query is not enough: a capability URL puts its bearer material in the
  // path, and a tenant identifier or secret can live in a subdomain.
  it.each([
    ["userinfo", "http://user:SENTINELhunter@169.254.169.254/a.png"],
    ["query", "http://169.254.169.254/a.png?sig=SENTINELsig"],
    ["fragment", "http://169.254.169.254/a.png#SENTINELfrag"],
    ["pathname", "http://169.254.169.254/SENTINELpath/a.png"],
    ["hostname", "http://SENTINELtenant.169.254.169.254.nip.io/a.png"],
  ])("keeps a secret in the %s out of the log", async (_label, url) => {
    mockDns("169.254.169.254");
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(await fetchUrlBytes(url, log)).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    const line = [...log.error.mock.calls, ...log.warn.mock.calls]
      .map((call) => String(call[0]))
      .join(" ");
    expect(line).not.toContain("SENTINEL");
    // Identified opaquely instead, so a refusal is still correlatable.
    expect(line).toMatch(/url#[0-9a-f]{12}/);
  });

  it("keeps a secret out of the log when an error quotes the whole URL", async () => {
    mockDns(PUBLIC_IP);
    const url = "https://SENTINELhost.example/SENTINELpath?sig=SENTINELsig";
    vi.spyOn(urlFetchTransport, "request").mockImplementation(async () => {
      throw new TypeError(`request failed for ${url}`);
    });
    const log = makeLog();

    expect(await fetchUrlBytes(url, log)).toBeNull();
    expect(String(log.warn.mock.calls[0][0])).not.toContain("SENTINEL");
  });

  // A runtime error may quote one component rather than the whole URL, which
  // the whole-URL substitution alone would not catch.
  it.each([
    ["the path alone", (u: URL) => u.pathname],
    ["the query alone", (u: URL) => u.search],
    ["the host alone", (u: URL) => u.host],
  ])(
    "keeps a secret out of the log when an error quotes %s",
    async (_label, pick) => {
      mockDns(PUBLIC_IP);
      // Lowercase throughout: the URL parser lowercases the host, so an
      // uppercase sentinel would disappear from the host case on its own and the
      // assertion would pass without the scrub doing anything.
      const url = "https://sentinelhost.example/sentinelpath?sig=sentinelsig";
      const quoted = pick(new URL(url));
      vi.spyOn(urlFetchTransport, "request").mockImplementation(async () => {
        throw new TypeError(`request failed at ${quoted}`);
      });
      const log = makeLog();

      expect(await fetchUrlBytes(url, log)).toBeNull();
      expect(String(log.warn.mock.calls[0][0]).toLowerCase()).not.toContain(
        "sentinel",
      );
    },
  );

  it("gives the same URL the same identifier every time", async () => {
    const url = "http://169.254.169.254/latest/meta-data/";
    const ids: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const log = makeLog();
      stubFetch(() => new Response("should not be reached"));
      await fetchUrlBytes(url, log);
      ids.push(
        String(log.error.mock.calls[0][0]).match(/url#([0-9a-f]{12})/)![1],
      );
      vi.restoreAllMocks();
    }
    expect(new Set(ids).size).toBe(1);

    // A different URL must not collide with it.
    const other = makeLog();
    stubFetch(() => new Response("should not be reached"));
    await fetchUrlBytes("http://169.254.169.254/other", other);
    expect(String(other.error.mock.calls[0][0])).not.toContain(ids[0]);
  });

  it("reports a loopback IPv6 address as itself, not as a fabricated IPv4", async () => {
    const log = makeLog();
    stubFetch(() => new Response("should not be reached"));

    await fetchUrlBytes("http://[::1]/admin", log);

    const line = String(log.error.mock.calls[0][0]);
    // `::/96` matches `::1`, so the embedded-address decode would otherwise
    // report the meaningless 0.0.0.1.
    expect(line).not.toContain("0.0.0.1");
    expect(line).toContain("0:0:0:0:0:0:0:1");
  });

  it("reports an exhausted deadline as unavailable, not as a refusal", async () => {
    mockDns(PUBLIC_IP);
    // The clock is driven so the budget is provably spent by the time the hop
    // is checked, rather than depending on how fast the resolver answers.
    let reading = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const value = reading;
      reading += 10_000;
      return value;
    });
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    expect(
      await fetchUrlBytes(
        "http://public.example/f.bin",
        log,
        policy({ timeoutMs: 1000 }),
      ),
    ).toBeNull();
    // A spent budget is a transient outcome, not a refusal on the merits.
    expect(log.error).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain("deadline exceeded");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("URL fetch policy: unusable policy values", () => {
  it.each([
    ["maxBytes below one", { maxBytes: 0 }],
    ["a maxBytes that is not a number", { maxBytes: Number.NaN }],
    ["a fractional maxBytes", { maxBytes: 1.5 }],
    ["an infinite maxBytes", { maxBytes: Number.POSITIVE_INFINITY }],
    ["timeoutMs below one", { timeoutMs: 0 }],
    ["negative maxRedirects", { maxRedirects: -1 }],
    ["fractional maxRedirects", { maxRedirects: 1.5 }],
  ])("rejects a policy with %s", async (_label, overrides) => {
    // A nonsensical limit would otherwise surface as "more than -1 redirects"
    // or refuse every response, which reads as a policy decision.
    await expect(
      fetchUrlBytes(
        "http://public.example/f.bin",
        makeLog(),
        policy(overrides as Partial<UrlFetchPolicy>),
      ),
    ).rejects.toThrow(/URL fetch policy/);
  });
});

describe("URL fetch policy: runtimes that hide redirects", () => {
  it("refuses rather than following a redirect it cannot inspect", async () => {
    mockDns(PUBLIC_IP);
    // Browsers and Deno return an opaque redirect for `redirect: "manual"`,
    // so the hop cannot be re-validated and must not be followed blind.
    const opaque = {
      status: 0,
      type: "opaqueredirect",
      ok: false,
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const spy = vi
      .spyOn(urlFetchTransport, "request")
      .mockImplementation(async () => opaque);
    const log = makeLog();

    expect(await fetchUrlBytes("http://public.example/start", log)).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    expect(String(log.error.mock.calls[0][0])).toContain(
      "cannot be re-validated",
    );
  });
});

// ---------------------------------------------------------------------------
// Transport hazards
// ---------------------------------------------------------------------------

describe("URL fetch policy: transport hazards", () => {
  it("refuses a URL carrying credentials in its userinfo", async () => {
    const { spy } = stubFetch(() => new Response("should not be reached"));
    const log = makeLog();

    // fetch rejects these unconditionally, so allowing one through would be a
    // permanent drop reported as a transient failure.
    expect(
      await fetchUrlBytes("http://user:hunter2@example.com/a.png", log),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    const line = String(log.error.mock.calls[0][0]);
    expect(line).toContain("userinfo");
    expect(line).not.toContain("hunter2");
  });

  it("refuses a redirect that downgrades https to http", async () => {
    mockDns(PUBLIC_IP);
    const { attempted } = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://public.example/plain" },
        }),
    );
    const log = makeLog();

    expect(await fetchUrlBytes("https://public.example/start", log)).toBeNull();
    expect(attempted).toEqual(["https://public.example/start"]);
    expect(String(log.error.mock.calls[0][0])).toContain(
      "downgrades the transfer from https to http",
    );
  });

  it("allows an http to https upgrade across a redirect", async () => {
    mockDns(PUBLIC_IP);
    stubFetch((url) =>
      url === "http://public.example/start"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://public.example/secure" },
          })
        : new Response("payload"),
    );

    const bytes = await fetchUrlBytes("http://public.example/start", makeLog());

    expect(bytes && Buffer.from(bytes).toString()).toBe("payload");
  });

  it("names an unusable redirect Location", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://[::1" },
        }),
    );
    const log = makeLog();

    expect(await fetchUrlBytes("http://public.example/start", log)).toBeNull();
    expect(String(log.error.mock.calls[0][0])).toContain(
      "Location is not a usable URL",
    );
  });

  it("does not leak a redirect Location's query into the hop suffix", async () => {
    mockDns(PUBLIC_IP);
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal?X-Amz-Signature=hopsecret9999",
          },
        }),
    );
    const log = makeLog();

    expect(await fetchUrlBytes("http://public.example/start", log)).toBeNull();
    const line = String(log.error.mock.calls[0][0]);
    expect(line).toMatch(/at redirect target url#[0-9a-f]{12}/);
    expect(line).not.toContain("hopsecret9999");
    expect(line).not.toContain("127.0.0.1/internal");
  });

  it("treats a zero status as a transport failure, not an opaque redirect", async () => {
    mockDns(PUBLIC_IP);
    const errored = {
      status: 0,
      type: "error",
      ok: false,
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () => errored,
    );
    const log = makeLog();

    expect(await fetchUrlBytes("http://public.example/start", log)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain("no HTTP status");
  });

  it("does not leak the URL through a runtime error message", async () => {
    mockDns(PUBLIC_IP);
    const url = "https://public.example/a.png?X-Amz-Signature=deadbeefcafe";
    // Runtime errors quote the URL they were handed, which is how a signature
    // gets past the redaction on the message prefix.
    vi.spyOn(urlFetchTransport, "request").mockImplementation(async () => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const log = makeLog();

    expect(await fetchUrlBytes(url, log)).toBeNull();
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).not.toContain("deadbeefcafe");
    expect(line).not.toContain("public.example");
    expect(line).not.toContain("/a.png");
    expect(line).toMatch(/url#[0-9a-f]{12}/);
  });

  it("does not let a client-controlled MIME type forge a log line", async () => {
    const log = makeLog();

    await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "data",
            value: Buffer.from("x").toString("base64"),
            mimeType:
              "image/x\n[@ag-ui/aws-strands] Refusing to fetch URL http://evil/: forged",
          },
        },
      ] as InputContent[],
      log,
    );

    const line = String(log.warn.mock.calls[0][0]);
    expect(line).not.toContain("\n");
    expect(line).toContain("Refusing to fetch URL http://evil/: forged");
    // The forged text is present but flattened onto the one real line, so it
    // cannot masquerade as a separate record.
    expect(line.split("\n")).toHaveLength(1);
  });

  it("does not echo a data URI payload into the log", async () => {
    const log = makeLog();
    const secret = "c3VwZXItc2VjcmV0LXBheWxvYWQ=";

    expect(
      await fetchUrlBytes(`data:text/plain;base64,${secret}`, log),
    ).toBeNull();
    expect(String(log.error.mock.calls[0][0])).not.toContain(secret);
  });

  it("survives a resolver that rejects after the deadline has passed", async () => {
    // The lookup promise is created by the caller before the deadline is
    // checked, so the already-expired path must still subscribe to it. An
    // unhandled rejection ends the process.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.spyOn(dns.promises, "lookup").mockImplementation(
        (() =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("ENOTFOUND")), 20),
          )) as never,
      );

      // An already-elapsed deadline takes the early-throw branch.
      await expect(
        validateFetchUrl(
          "http://slow.example/f.bin",
          DEFAULT_URL_FETCH_POLICY,
          performance.now() - 1,
        ),
      ).rejects.toThrow(UrlFetchUnavailableError);

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("logs a malformed URL as a transient failure, not a policy refusal", async () => {
    const log = makeLog();

    // Client junk should not raise the error-level signal reserved for a
    // request the policy turned away on its merits.
    expect(await fetchUrlBytes("http://example.com:abc/a.png", log)).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain("URL is malformed");
  });
});

// ---------------------------------------------------------------------------
// Log integrity and policy limits
// ---------------------------------------------------------------------------

describe("URL fetch policy: log integrity", () => {
  const FORGERY =
    "\n[@ag-ui/aws-strands] Refusing to fetch URL http://evil/: forged";

  // Every client-controlled value that reaches a log line, not just the one
  // that happened to be noticed first.
  it.each([
    [
      "an image MIME type",
      {
        type: "image",
        source: { type: "data", value: "eA==", mimeType: `image/x${FORGERY}` },
      },
    ],
    [
      "a content source type",
      {
        type: "image",
        source: {
          type: `weird${FORGERY}`,
          value: "eA==",
          mimeType: "image/png",
        },
      },
    ],
    ["a content item type", { type: `hologram${FORGERY}` }],
    [
      "a deprecated binary MIME type",
      { type: "binary", mimeType: `image/x${FORGERY}`, data: "eA==" },
    ],
  ])("keeps %s on a single line", async (_label, item) => {
    const log = makeLog();

    await convertAguiContentToStrands([item] as unknown as InputContent[], log);

    const lines = [...log.warn.mock.calls, ...log.error.mock.calls].map(
      (call) => String(call[0]),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.split("\n")).toHaveLength(1);
    }
  });

  it.each([
    ["a parseable URL", "http://user:pa@ss@example.com/a.png"],
    // A space makes this unparseable, so the textual fallback runs. That scrub
    // has to reach the last '@' before the path, or the tail of the password
    // survives in the log.
    ["an unparseable URL", "http://user:pa@ss@bad host/a.png"],
  ])(
    "scrubs a userinfo password containing an at sign from %s",
    async (_label, url) => {
      const log = makeLog();

      expect(await fetchUrlBytes(url, log)).toBeNull();
      const line = [...log.error.mock.calls, ...log.warn.mock.calls]
        .map((call) => String(call[0]))
        .join(" ");
      expect(line).not.toContain("pa@ss");
      expect(line).not.toContain("ss@");
    },
  );

  it("caps an unbounded hostname in a refusal", async () => {
    mockDns("127.0.0.1");
    const log = makeLog();
    const host = `${"h".repeat(4000)}.example`;

    expect(await fetchUrlBytes(`http://${host}/a.png`, log)).toBeNull();
    expect(String(log.error.mock.calls[0][0]).length).toBeLessThan(600);
  });

  // Line-break forging is not only CR and LF: several of these are treated as
  // line separators by log consumers, and ESC drives a terminal sink.
  it.each([
    ["vertical tab", "\v"],
    ["form feed", "\f"],
    ["next line", "\u0085"],
    ["line separator", "\u2028"],
    ["escape", "\u001b"],
    ["null", "\0"],
  ])("strips %s from a client-controlled value", async (_label, control) => {
    const log = makeLog();

    await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "data",
            value: "eA==",
            mimeType: `image/x${control}forged`,
          },
        },
      ] as unknown as InputContent[],
      log,
    );

    const line = String(log.warn.mock.calls[0][0]);
    expect(line).not.toContain(control);
    expect(line).toContain("forged");
  });

  it("caps the length of a logged URL", async () => {
    const log = makeLog();
    const longPath = "a".repeat(5000);

    expect(
      await fetchUrlBytes(`http://169.254.169.254/${longPath}`, log),
    ).toBeNull();
    expect(String(log.error.mock.calls[0][0]).length).toBeLessThan(600);
  });
});

describe("URL fetch policy: limits that cannot work", () => {
  it("rejects a timeout past what setTimeout can represent", async () => {
    // setTimeout silently clamps anything larger to 1ms, which would abort
    // every fetch immediately and report it as a network failure.
    await expect(
      fetchUrlBytes(
        "http://public.example/f.bin",
        makeLog(),
        policy({ timeoutMs: 2 ** 31 }),
      ),
    ).rejects.toThrow(/timeoutMs must be between/);
  });

  it("rejects an allowlist that cannot answer a membership test", async () => {
    await expect(
      fetchUrlBytes("http://public.example/f.bin", makeLog(), {
        ...DEFAULT_URL_FETCH_POLICY,
        allowedSchemes: {},
      } as UrlFetchPolicy),
    ).rejects.toThrow(/allowedSchemes/);
  });

  it.each([
    ["a string instead of a boolean", "false"],
    ["a number instead of a boolean", 0],
    ["undefined", undefined],
  ])(
    "rejects allowPrivateNetworks given as %s",
    async (_label, allowPrivateNetworks) => {
      // Read in truthiness position, so a non-boolean out of config could
      // otherwise open the private network.
      await expect(
        fetchUrlBytes("http://public.example/f.bin", makeLog(), {
          ...DEFAULT_URL_FETCH_POLICY,
          allowPrivateNetworks,
        } as unknown as UrlFetchPolicy),
      ).rejects.toThrow(/allowPrivateNetworks/);
    },
  );

  it("applies the same gate when validating directly", async () => {
    await expect(
      validateFetchUrl(
        "http://public.example/f.bin",
        policy({ maxRedirects: -1 }),
      ),
    ).rejects.toThrow(/maxRedirects/);
  });
});

// ---------------------------------------------------------------------------
// The socket goes only where validation said it could
// ---------------------------------------------------------------------------

describe("URL fetch policy: transport binding", () => {
  async function rawResponseListener(response: string) {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.end(response));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    return {
      port,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  }

  async function settleWithin<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("transport did not settle")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function requestRawResponse(port: number) {
    return urlFetchTransport.request(
      `http://hostile.example:${port}/probe`,
      [{ version: 4, bytes: new Uint8Array([127, 0, 0, 1]) }],
      policy({ timeoutMs: 250 }),
      new AbortController().signal,
    );
  }

  it.each([204, 205, 304])(
    "represents HTTP %i without constructing a forbidden body",
    async (status) => {
      const listener = await rawResponseListener(
        `HTTP/1.1 ${status} Empty\r\nConnection: close\r\n\r\n`,
      );
      try {
        const response = await settleWithin(requestRawResponse(listener.port));

        expect(response.status).toBe(status);
        expect(response.body).toBeNull();
      } finally {
        await listener.close();
      }
    },
  );

  it("rejects an HTTP status outside the Fetch response range", async () => {
    const listener = await rawResponseListener(
      "HTTP/1.1 600 Hostile\r\nConnection: close\r\n\r\n",
    );
    try {
      await expect(
        settleWithin(requestRawResponse(listener.port)),
      ).rejects.toThrow(/unsupported HTTP status 600/);
    } finally {
      await listener.close();
    }
  });

  it("rejects and closes a protocol upgrade", async () => {
    const listener = await rawResponseListener(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: upgrade\r\n" +
        "Upgrade: hostile\r\n\r\n",
    );
    try {
      await expect(
        settleWithin(requestRawResponse(listener.port)),
      ).rejects.toThrow(/protocol upgrade/);
    } finally {
      await listener.close();
    }
  });

  /** A listener that records connections and serves a sentinel if reached. */
  async function sentinelListener() {
    const connections: string[] = [];
    const server = http.createServer((req, res) => {
      connections.push(req.url ?? "");
      res.writeHead(200, { "content-type": "image/png" });
      res.end("SENTINEL-SECRET-NEVER-FETCH-ME");
    });
    server.on("connection", () => connections.push("<tcp>"));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    return {
      port,
      connections,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  // The real transport is used here. Only the resolver is controlled, so the
  // pinning is what has to hold.
  it("does not connect to an address the policy never approved", async () => {
    const listener = await sentinelListener();
    try {
      // The hostname is one the real resolver DOES resolve, and it resolves to
      // where the sentinel is listening. Validation is told a different
      // address. If the socket layer were allowed to resolve the name itself,
      // it would reach the sentinel, so this fails if the pinning is dropped
      // rather than passing because the name does not resolve.
      let approvals = 0;
      vi.spyOn(dns.promises, "lookup").mockImplementation((async () => {
        approvals += 1;
        return [{ address: "127.0.0.2", family: 4 }];
      }) as never);

      const log = makeLog();
      const bytes = await fetchUrlBytes(
        `http://localhost:${listener.port}/probe`,
        log,
        // The approved address is loopback, so the opt-in is needed for it to
        // be approved at all. What is under test is that the socket dials the
        // approved address and no other.
        policy({ allowPrivateNetworks: true, timeoutMs: 1500 }),
      );

      expect(approvals).toBeGreaterThan(0);
      expect(bytes).toBeNull();
      expect(listener.connections).toEqual([]);
      const line = [...log.error.mock.calls, ...log.warn.mock.calls]
        .map((c) => String(c[0]))
        .join(" ");
      expect(line).not.toContain("SENTINEL");
    } finally {
      await listener.close();
    }
  });

  it("connects to the approved address while the request still carries the hostname", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.host);
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      // Loopback is the approved address here, via the opt-in, so the fetch
      // should succeed and the Host header must still name the hostname, which
      // is what TLS SNI and certificate verification also rely on.
      vi.spyOn(dns.promises, "lookup").mockResolvedValue([
        { address: "127.0.0.1", family: 4 },
      ] as never);

      const bytes = await fetchUrlBytes(
        `http://pinned.example:${port}/probe`,
        makeLog(),
        policy({ allowPrivateNetworks: true, timeoutMs: 1500 }),
      );

      expect(bytes && Buffer.from(bytes).toString()).toBe("ok");
      expect(seen).toEqual([`pinned.example:${port}`]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("refuses when no approved address is usable", async () => {
    const listener = await sentinelListener();
    try {
      // An empty approved set must fail closed rather than falling back to a
      // resolver.
      const log = makeLog();
      const bytes = await urlFetchTransport
        .request(
          `http://rebind.example:${listener.port}/probe`,
          [],
          DEFAULT_URL_FETCH_POLICY,
          new AbortController().signal,
        )
        .then(() => "CONNECTED")
        .catch((e: Error) => e.message);

      expect(String(bytes)).toContain("no validated address");
      expect(listener.connections).toEqual([]);
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("re-pins on a redirect instead of reusing the first hop's connection", async () => {
    const listener = await sentinelListener();
    try {
      // Hop one is public and answers with a redirect to the loopback
      // sentinel. Hop two has to be validated and pinned on its own.
      vi.spyOn(dns.promises, "lookup").mockImplementation((async (
        host: string,
      ) => [
        {
          address: host === "public.example" ? PUBLIC_IP : "127.0.0.1",
          family: 4,
        },
      ]) as never);
      const { attempted } = stubFetch((url) =>
        url.includes("public.example")
          ? new Response(null, {
              status: 302,
              headers: {
                location: `http://sentinel.example:${listener.port}/probe`,
              },
            })
          : new Response("should not be reached"),
      );

      expect(
        await fetchUrlBytes("http://public.example/start", makeLog()),
      ).toBeNull();
      expect(attempted).toHaveLength(1);
      expect(listener.connections).toEqual([]);
    } finally {
      await listener.close();
    }
  });
});
