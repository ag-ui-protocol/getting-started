import { describe, it, expect } from "vitest";
import { HttpAgent } from "../http";

describe("HttpAgent redirect policy", () => {
  it("pins redirect mode to error so redirects never carry the run request", () => {
    const agent = new HttpAgent({
      url: "https://api.example.com/v1/chat",
      headers: { Authorization: "Bearer test-token" },
    });

    const input = {
      threadId: agent.threadId,
      runId: "mock-run-id",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: [],
    };

    const init = (agent as unknown as { requestInit: (i: unknown) => RequestInit }).requestInit(
      input,
    );

    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
    expect(init.body).toBeDefined();
  });
});
