import { describe, expect, it } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { VercelAISDKAgent } from "../vercel-ai-sdk";
import {
  makeInput,
  makeMockModel,
  streamStart,
  responseMetadata,
  finishStop,
} from "./helpers";

function collect(agent: VercelAISDKAgent, input: RunAgentInput): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

describe("VercelAISDKAgent", () => {
  it("constructs with defaults (maxSteps=1, toolChoice=auto)", () => {
    const agent = new VercelAISDKAgent({ model: makeMockModel([]) });
    expect(agent.maxSteps).toBe(1);
    expect(agent.toolChoice).toBe("auto");
  });

  it("accepts custom maxSteps and toolChoice", () => {
    const agent = new VercelAISDKAgent({
      model: makeMockModel([]),
      maxSteps: 5,
      toolChoice: "none",
    });
    expect(agent.maxSteps).toBe(5);
    expect(agent.toolChoice).toBe("none");
  });

  it("clones with the same config", () => {
    const model = makeMockModel([]);
    const agent = new VercelAISDKAgent({ model, maxSteps: 3, toolChoice: "required" });
    const clone = agent.clone();
    expect(clone).not.toBe(agent);
    expect(clone.maxSteps).toBe(3);
    expect(clone.toolChoice).toBe("required");
    expect(clone.model).toBe(model);
  });

  it("clone preserves accumulated messages, state, and headers", () => {
    const model = makeMockModel([]);
    const agent = new VercelAISDKAgent({ model, maxSteps: 2 });
    agent.threadId = "thread-42";
    agent.messages = [{ id: "m1", role: "user", content: "hi" }];
    agent.state = { counter: 7 };
    agent.headers = { "x-test": "1" };

    const clone = agent.clone();

    expect(clone.threadId).toBe("thread-42");
    expect(clone.messages).toEqual(agent.messages);
    expect(clone.messages).not.toBe(agent.messages);
    expect(clone.state).toEqual({ counter: 7 });
    expect(clone.headers).toEqual({ "x-test": "1" });
    expect(clone.headers).not.toBe(agent.headers);
    expect(clone.model).toBe(model);
    expect(clone.maxSteps).toBe(2);
  });

  it("runs end-to-end: emits RUN_STARTED, text events, RUN_FINISHED", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);
    const agent = new VercelAISDKAgent({ model });
    const events = await collect(
      agent,
      makeInput({ messages: [{ id: "u", role: "user", content: "Hi" }] }),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);
  });

  it("propagates abort on unsubscribe — does not emit RUN_ERROR to the consumer", async () => {
    // Custom delayed stream so the consumer can unsubscribe mid-stream.
    // Deterministic timing: the stream blocks after the first delta until the
    // test signals (after observing TEXT_MESSAGE_CONTENT and unsubscribing).
    const { MockLanguageModelV3 } = await import("ai/test");
    let releaseStream!: () => void;
    const blockedUntilUnsubscribe = new Promise<void>((r) => {
      releaseStream = r;
    });
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue(streamStart);
              controller.enqueue(responseMetadata());
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: "Partial" });
              await blockedUntilUnsubscribe;
              controller.close();
            },
          }),
        }) as never,
    });
    const agent = new VercelAISDKAgent({ model });

    const events: BaseEvent[] = [];
    const sub = agent
      .run(makeInput({ messages: [{ id: "u", role: "user", content: "Hi" }] }))
      .subscribe({
        next: (e) => {
          events.push(e);
          if (e.type === EventType.TEXT_MESSAGE_CONTENT) {
            sub.unsubscribe();
            releaseStream();
          }
        },
      });
    // Wait for the stream's start() to return (after releaseStream resolves
    // the awaited promise and controller.close() finishes).
    await blockedUntilUnsubscribe;
    // One microtask hop so any pending emit() guarded by subscriber.closed
    // gets a chance to no-op cleanly.
    await Promise.resolve();

    const errs = events.filter((e) => e.type === EventType.RUN_ERROR);
    expect(errs.length).toBe(0);
  });
});
