import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { EMPTY, Observable } from "rxjs";

class RecordingAgent extends AbstractAgent {
  public capturedMessages: Message[][] = [];

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.capturedMessages.push(input.messages);
    return EMPTY as Observable<BaseEvent>;
  }
}

const userMsg = (id: string, content: string): Message =>
  ({ id, role: "user", content, toolCalls: [] }) as Message;

const assistantMsg = (id: string, content: string): Message =>
  ({ id, role: "assistant", content, toolCalls: [] }) as Message;

describe("AgentConfig.messageFilter", () => {
  it("forwards all messages when messageFilter is not set", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), assistantMsg("a1", "hi"), userMsg("u2", "bye")],
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(3);
  });

  it("applies messageFilter before forwarding messages to run()", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), assistantMsg("a1", "hi"), userMsg("u2", "latest")],
      messageFilter: (messages) => {
        const last = [...messages].reverse().find((m) => m.role === "user");
        return last ? [last] : [];
      },
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(1);
    expect(agent.capturedMessages[0][0]).toMatchObject({ id: "u2", role: "user" });
  });

  it("does not mutate the agent's stored messages", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b"), userMsg("u3", "c")],
      messageFilter: (messages) => messages.slice(-1),
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(1);
    expect(agent.messages).toHaveLength(3);
  });

  it("excludes activity messages before passing to messageFilter", async () => {
    const activityMsg = {
      id: "act1",
      role: "activity",
      content: "thinking…",
    } as unknown as Message;
    const seen: Message[][] = [];

    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), activityMsg, userMsg("u2", "world")],
      messageFilter: (messages) => {
        seen.push([...messages]);
        return messages;
      },
    });

    await agent.runAgent();

    expect(seen[0].every((m) => m.role !== "activity")).toBe(true);
    expect(seen[0]).toHaveLength(2);
  });

  it("preserves messageFilter across clone()", () => {
    const filter = (messages: Message[]) => messages.slice(-1);
    const original = new RecordingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b")],
      messageFilter: filter,
    });

    const cloned = original.clone() as RecordingAgent;

    expect((cloned as any)._messageFilter).toBe(filter);
  });

  it("HttpAgent accepts messageFilter and applies it", async () => {
    const filter = (messages: Message[]) => messages.slice(-1);
    const agent = new HttpAgent({
      url: "https://example.com/agent",
      initialMessages: [userMsg("u1", "first"), userMsg("u2", "second")],
      messageFilter: filter,
    });

    const cloned = agent.clone() as HttpAgent;
    expect((cloned as any)._messageFilter).toBe(filter);
  });
});
