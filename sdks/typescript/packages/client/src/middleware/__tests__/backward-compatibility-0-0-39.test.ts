import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AbstractAgent, HttpAgent } from "@/agent";
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

// The warning tests need the suppress flag OFF, but deleting it outright leaks
// the change into every test that runs afterwards in this worker — including
// suites that assert warnings ARE suppressed. Saved and put back instead.
let priorSuppress: string | undefined;
beforeEach(() => {
  priorSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
});
afterEach(() => {
  if (priorSuppress === undefined) {
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  } else {
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS = priorSuppress;
  }
});

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

describe("BackwardCompatibility_0_0_39 (a downgrade must not repair)", () => {
  class Pinned039 extends HttpAgent {
    override get maxProtocolVersion(): string {
      return "0.0.39";
    }
  }
  class Current extends HttpAgent {}

  const NETWORK_REACHED = "the outgoing boundary should have rejected before the network";
  const neverFetch = () => {
    throw new Error(NETWORK_REACHED);
  };

  it.each([
    ["pinned at 0.0.39", (): HttpAgent => new Pinned039({ url: "http://x.test/a", fetch: neverFetch as never })],
    ["with no shim installed", (): HttpAgent => new Current({ url: "http://x.test/a", fetch: neverFetch as never })],
  ])("rejects a malformed message content %s", async (_label, build) => {
    // `null` is not "content is absent" — it is a known field holding a value
    // the schema rejects. Flattening it to "" made the same defect fatal on a
    // modern peer and invisible behind the shim.
    const agent = build();
    agent.messages = [{ id: "m1", role: "user", content: null } as never];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let thrown: unknown;
    try {
      await agent.runAgent({ runId: "run-null-content" });
    } catch (error) {
      thrown = error;
    } finally {
      errors.mockRestore();
    }

    expect(thrown, "the run must fail").toBeDefined();
    // Named explicitly: the shim used to repair the value, so the run failed
    // only when the stub fetch threw — a green test proving nothing.
    expect(String((thrown as Error).message)).not.toContain(NETWORK_REACHED);
    expect(String((thrown as Error).message)).toContain("content");
  });

  it("still reshapes an ABSENT content into the empty string the old schema requires", async () => {
    // The permitted half of the same rule: an empty value for a field the
    // older schema requires is reshaping, not invention.
    const agent = new LegacyAgent([{ id: "msg-1", role: "assistant", content: undefined } as Message]);
    await agent.runAgent({ runId: "run-absent" });
    expect(agent.receivedInput?.messages[0].content).toBe("");
  });

  it("does not report a malformed text part as a dropped media part", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new LegacyAgent([
      {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: 42 }],
      } as unknown as Message,
    ]);

    try {
      await agent.runAgent({ runId: "run-malformed-part" });
    } catch {
      // The shim's job is only to report honestly; whether the run survives is
      // the enforcement boundary's business.
    }
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    warnSpy.mockRestore();

    // It is a malformed TEXT part, not media the peer cannot represent.
    expect(warned).not.toMatch(/DROPS non-text parts \([^)]*text/);
    expect(warned).toMatch(/malformed/i);
  });
});
