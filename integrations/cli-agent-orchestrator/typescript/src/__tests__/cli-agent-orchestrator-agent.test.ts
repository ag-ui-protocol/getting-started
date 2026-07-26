import { CliAgentOrchestratorAgent } from "../index";
import { HttpAgent } from "@ag-ui/client";
import { describe, it, expect } from "vitest";

describe("CliAgentOrchestratorAgent", () => {
  it("should be a subclass of HttpAgent", () => {
    const agent = new CliAgentOrchestratorAgent({
      url: "http://localhost:8027/agentic-chat",
    });
    expect(agent).toBeInstanceOf(HttpAgent);
  });

  it("should store the provided URL", () => {
    const url = "http://localhost:8027/agentic-chat";
    const agent = new CliAgentOrchestratorAgent({ url });
    expect(agent.url).toBe(url);
  });

  it("should accept custom headers", () => {
    const agent = new CliAgentOrchestratorAgent({
      url: "http://localhost:8027/agentic-chat",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(agent.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("should export CliAgentOrchestratorAgent from the package", () => {
    expect(CliAgentOrchestratorAgent).toBeDefined();
    expect(typeof CliAgentOrchestratorAgent).toBe("function");
  });
});
