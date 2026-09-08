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
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
    );
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
