import { ADKAgent } from "../index";
import { describe, it, expect, vi, afterEach, Mock } from "vitest";
import { AgentCapabilities } from "@ag-ui/core";

describe("ADKAgent.getCapabilities", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("should fetch capabilities from {url}/capabilities", async () => {
    const mockCapabilities: AgentCapabilities = {
      identity: { name: "TestAgent", type: "test" },
      custom: { predictiveChips: true },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCapabilities),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/v1/chat",
      headers: { Authorization: "Bearer test-token" },
    });

    const result = await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/capabilities",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/json",
        }),
      }),
    );
    expect(result).toEqual(mockCapabilities);
  });

  it("should not include a signal in the fetch request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await agent.getCapabilities();

    const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
    expect(fetchCall[1].signal).toBeUndefined();
  });

  it("should strip trailing slashes from url before appending /capabilities", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/agent/",
      headers: {},
    });

    await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/agent/capabilities",
      expect.any(Object),
    );
  });

  it("should preserve query parameters when building capabilities URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/chat?tenant=acme",
      headers: {},
    });

    await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/chat/capabilities?tenant=acme",
      expect.any(Object),
    );
  });

  it("should throw on HTTP error responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await expect(agent.getCapabilities()).rejects.toThrow("HTTP 404: Not Found");
  });

  it("should throw on server error responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/v1/chat",
      headers: {},
    });

    await expect(agent.getCapabilities()).rejects.toThrow("HTTP 500");
  });

  it("should forward custom headers in the request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/v1/chat",
      headers: {
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer my-token",
      },
    });

    await agent.getCapabilities();

    const fetchCall = (globalThis.fetch as Mock).mock.calls[0];
    expect(fetchCall[1].headers).toMatchObject({
      "X-Custom-Header": "custom-value",
      Authorization: "Bearer my-token",
      Accept: "application/json",
    });
  });

  it("should parse and validate capabilities with Zod schema", async () => {
    const fullCapabilities: AgentCapabilities = {
      identity: { name: "MyAgent", type: "adk", version: "1.0.0" },
      transport: { streaming: true, websocket: false },
      tools: { supported: true, parallelCalls: false },
      state: { snapshots: true, deltas: true },
      custom: {
        predictiveChips: { enabled: true, maxCount: 3 },
        suggestedQuestions: { enabled: true },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fullCapabilities),
    });

    const agent = new ADKAgent({
      url: "https://api.example.com/agent",
      headers: {},
    });

    const result = await agent.getCapabilities();

    expect(result.identity?.name).toBe("MyAgent");
    expect(result.transport?.streaming).toBe(true);
    expect(result.custom?.predictiveChips).toEqual({ enabled: true, maxCount: 3 });
  });
});
