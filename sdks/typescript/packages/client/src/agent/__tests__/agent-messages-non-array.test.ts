import { AbstractAgent } from "../agent";
import { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";
import { describe, it, expect, vi } from "vitest";

vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("mock-uuid"),
}));

vi.mock("@/verify", () => ({
  verifyEvents: vi.fn(() => (source$: Observable<any>) => source$),
}));

vi.mock("@/chunks", () => ({
  transformChunks: vi.fn(() => (source$: Observable<any>) => source$),
}));

class TestAgent extends AbstractAgent {
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return of();
  }
}

describe("runAgent when messages is not an array", () => {
  it("treats null messages as empty array — does not throw", async () => {
    const agent = new TestAgent({ threadId: "t1" });
    (agent as any).messages = null;

    await expect(agent.runAgent()).resolves.toBeDefined();
  });

  it("treats undefined messages as empty array — does not throw", async () => {
    const agent = new TestAgent({ threadId: "t1" });
    (agent as any).messages = undefined;

    await expect(agent.runAgent()).resolves.toBeDefined();
  });

  it("works normally when messages is a valid array", async () => {
    const agent = new TestAgent({ threadId: "t1" });
    agent.messages = [{ id: "msg-1", role: "user", content: "hi" }];

    await expect(agent.runAgent()).resolves.toBeDefined();
  });
});
