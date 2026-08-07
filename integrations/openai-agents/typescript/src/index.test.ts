import { HttpAgent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { OpenAIAgentsHttpAgent } from "./index";

describe("OpenAIAgentsHttpAgent", () => {
  it("extends HttpAgent", () => {
    expect(OpenAIAgentsHttpAgent.prototype).toBeInstanceOf(HttpAgent);
  });

  it("can be created with a URL", () => {
    const agent = new OpenAIAgentsHttpAgent({
      url: "http://localhost:8027/agentic_chat/",
    });

    expect(agent).toBeInstanceOf(OpenAIAgentsHttpAgent);
    expect(agent).toBeInstanceOf(HttpAgent);
  });
});
