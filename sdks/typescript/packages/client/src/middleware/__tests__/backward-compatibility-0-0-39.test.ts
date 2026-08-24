import { describe, it, expect, vi } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { Observable, of } from "rxjs";

class LegacyAgent extends AbstractAgent {
  public receivedInput?: RunAgentInput;

  constructor(initialMessages: Message[]) {
    super({ initialMessages });
  }

  override get maxVersion(): string {
    return "0.0.39";
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    this.receivedInput = input;
    return of({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
  }

  protected override prepareRunAgentInput(
    parameters?: Parameters<AbstractAgent["prepareRunAgentInput"]>[0],
  ): RunAgentInput {
    const prepared = super.prepareRunAgentInput(parameters);
    return { ...prepared, parentRunId: "legacy-parent" };
  }
}

describe("BackwardCompatibility_0_0_39 middleware (auto insertion)", () => {
  it("automatically strips parentRunId and flattens array message content when maxVersion <= 0.0.39", async () => {
    const initialMessages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world!" },
          { type: "binary", mimeType: "text/plain", data: "ignored" },
        ] as unknown as Message["content"],
      } as Message,
      {
        id: "msg-2",
        role: "assistant",
        content: undefined,
      } as Message,
    ];

    const agent = new LegacyAgent(initialMessages);

    await agent.runAgent({
      runId: "run-1",
      tools: [],
      context: [],
      forwardedProps: {},
    });

    expect(agent.receivedInput).toBeDefined();
    expect(agent.receivedInput?.parentRunId).toBeUndefined();
    expect(agent.receivedInput?.messages[0].content).toBe("Hello world!");
    expect(agent.receivedInput?.messages[1].content).toBe("");
  });
});

describe("BackwardCompatibility_0_0_39 (lossy path warning)", () => {
  it("warns when flattening drops image, audio, video or document parts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
    const agent = new LegacyAgent([
      {
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "see: " },
          { type: "image", source: { type: "url", value: "https://x.test/i.png" } },
          { type: "document", source: { type: "url", value: "https://x.test/d.pdf" } },
        ],
      } as unknown as Message,
    ]);

    await agent.runAgent({ runId: "run-warn" });

    // The parts are still gone — a 0.0.39 peer cannot take them — but the
    // loss is no longer silent.
    expect(agent.receivedInput?.messages[0].content).toBe("see: ");
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("image");
    expect(warned).toContain("document");
    expect(warned).toContain("DEPRECATIONS.md");
    warnSpy.mockRestore();
  });
});
