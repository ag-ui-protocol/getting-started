import { describe, expect, it, vi, afterEach } from "vitest";
import { AntigravityAgent } from "../index";

class TestAgent extends AntigravityAgent {
  public exposedCapabilitiesUrl() {
    return (this as unknown as { capabilitiesUrl(): string }).capabilitiesUrl();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response>) {
  const fetchMock = vi.fn().mockResolvedValue(response as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AntigravityAgent", () => {
  it("derives the capabilities URL from the agent URL", () => {
    const agent = new TestAgent({ url: "http://localhost:8009/agentic_chat" });
    expect(agent.exposedCapabilitiesUrl()).toBe(
      "http://localhost:8009/agentic_chat/capabilities",
    );
  });

  it("does not double up slashes on a trailing-slash URL", () => {
    const agent = new TestAgent({ url: "http://localhost:8009/agentic_chat/" });
    expect(agent.exposedCapabilitiesUrl()).toBe(
      "http://localhost:8009/agentic_chat/capabilities",
    );
  });

  it("appends to a nested path rather than replacing it", () => {
    const agent = new TestAgent({ url: "http://localhost:8009/api/v1/agents/agentic_chat" });
    expect(agent.exposedCapabilitiesUrl()).toBe(
      "http://localhost:8009/api/v1/agents/agentic_chat/capabilities",
    );
  });

  it("preserves query parameters when deriving the capabilities URL", () => {
    const agent = new TestAgent({ url: "http://localhost:8009/agentic_chat?tenant=acme" });
    expect(agent.exposedCapabilitiesUrl()).toBe(
      "http://localhost:8009/agentic_chat/capabilities?tenant=acme",
    );
  });

  it("forwards configured headers and issues a GET on the capabilities request", async () => {
    const fetchMock = stubFetch({ ok: true, json: async () => ({}) });
    const agent = new AntigravityAgent({
      url: "http://localhost:8009/agentic_chat",
      headers: { Authorization: "Bearer secret-token", "X-Tenant": "acme" },
    });

    await agent.getCapabilities();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8009/agentic_chat/capabilities",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer secret-token",
          "X-Tenant": "acme",
          Accept: "application/json",
        },
      }),
    );
  });

  it("parses a capabilities response", async () => {
    stubFetch({
      ok: true,
      json: async () => ({
        identity: { type: "antigravity" },
        tools: { supported: true, clientProvided: true },
        humanInTheLoop: { supported: true, interrupts: true },
      }),
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).resolves.toMatchObject({
      tools: { supported: true },
      humanInTheLoop: { interrupts: true },
    });
  });

  it("throws with the response body on a non-OK status", async () => {
    stubFetch({
      ok: false,
      status: 502,
      text: async () => "upstream down",
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).rejects.toThrow(/502[\s\S]*upstream down/);
  });

  it("rejects a payload that does not match AgentCapabilitiesSchema", async () => {
    // Loose booleans (`state: true`) are NOT valid -- the schema expects
    // nested category objects. This guards the server's default payload.
    stubFetch({ ok: true, json: async () => ({ state: true }) });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).rejects.toThrow(/Invalid capabilities/);
  });

  it("falls back to statusText when reading the error body itself throws", async () => {
    stubFetch({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => {
        throw new Error("body stream already read");
      },
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    const error = await agent.getCapabilities().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // The unreadable-body failure must not mask the status, and must not leak
    // the internal stream error as if it were the server's response.
    expect((error as Error).message).toContain("HTTP 503: Service Unavailable");
    expect((error as Error).message).not.toContain("body stream already read");
  });

  it("falls back to a placeholder when the body throws and statusText is empty", async () => {
    stubFetch({
      ok: false,
      status: 500,
      statusText: "",
      text: async () => {
        throw new Error("body stream already read");
      },
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).rejects.toThrow(
      "HTTP 500: (unable to read response body)",
    );
  });

  it("throws when the body is not valid JSON", async () => {
    stubFetch({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).rejects.toThrow(/Failed to parse/);
  });

  it("stringifies a non-Error thrown while parsing the body", async () => {
    stubFetch({
      ok: true,
      json: async () => {
        // Not an Error instance -- exercises the String(e) fallback.
        throw "raw string rejection";
      },
    });
    const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });
    await expect(agent.getCapabilities()).rejects.toThrow(
      /Failed to parse capabilities response from .*: raw string rejection/,
    );
  });
});

describe("AntigravityAgent fetch and URL resolution", () => {
  it("uses an injected fetch rather than the global one", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const injected = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tools: { supported: true } }),
    } as Response);

    const agent = new AntigravityAgent({
      url: "http://localhost:8027/agentic_chat",
      fetch: injected,
    });
    await agent.getCapabilities();

    expect(injected).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(injected.mock.calls[0][0]).toBe(
      "http://localhost:8027/agentic_chat/capabilities",
    );
  });

  it("resolves a relative agent URL against the document origin", async () => {
    vi.stubGlobal("location", { href: "https://app.example.com/dojo/index.html" });
    const fetchMock = stubFetch({ ok: true, json: async () => ({}) });

    const agent = new AntigravityAgent({ url: "/api/copilotkit" });
    await agent.getCapabilities();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://app.example.com/api/copilotkit/capabilities",
    );
  });

  it("explains itself when a relative URL has no origin to resolve against", async () => {
    vi.stubGlobal("location", undefined);
    const agent = new AntigravityAgent({ url: "/api/copilotkit" });
    await expect(agent.getCapabilities()).rejects.toThrow(
      /not absolute and there is no document origin/,
    );
  });
});
