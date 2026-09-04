import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbstractAgent } from "@/agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { Observable, from, lastValueFrom, toArray } from "rxjs";
import { BackwardCompatibility_0_0_47 } from "../backward-compatibility-0-0-47";

class MockAgent extends AbstractAgent {
  private events: BaseEvent[];
  public receivedInput?: RunAgentInput;

  constructor(events: BaseEvent[] = []) {
    super({});
    this.events = events;
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    this.receivedInput = input;
    return from(this.events);
  }
}

describe("BackwardCompatibility_0_0_47", () => {
  let middleware: BackwardCompatibility_0_0_47;

  beforeEach(() => {
    middleware = new BackwardCompatibility_0_0_47();
  });

  // Legacy message shapes: the binary content part left the Message type in
  // 1.0, and feeding it anyway is this suite's entire purpose.
  const createInput = (messages: unknown[]): RunAgentInput => ({
    threadId: "thread-1",
    runId: "run-1",
    messages: messages as RunAgentInput["messages"],
    tools: [],
    context: [],
    forwardedProps: {},
  });

  it("passes through plain string content unchanged", async () => {
    const agent = new MockAgent([{ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }]);

    const input = createInput([{ id: "msg-1", role: "user", content: "hello world" }]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()));

    const msg = agent.receivedInput!.messages[0];
    expect(msg.role).toBe("user");
    expect((msg as { content: unknown }).content).toBe("hello world");
  });

  it("passes through TextInputContent unchanged", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts binary with data to image content", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "image",
        source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" },
      },
    ]);
  });

  it("converts binary with url to audio content", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "audio/mp3",
            url: "https://example.com/audio.mp3",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "audio",
        source: {
          type: "url",
          value: "https://example.com/audio.mp3",
          mimeType: "audio/mp3",
        },
      },
    ]);
  });

  it("converts binary with video mimeType to video content", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "video/mp4",
            data: "AAAA",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "video",
        source: { type: "data", value: "AAAA", mimeType: "video/mp4" },
      },
    ]);
  });

  it("converts binary with application mimeType to document content", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "application/pdf",
            url: "https://example.com/doc.pdf",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "document",
        source: {
          type: "url",
          value: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
        },
      },
    ]);
  });

  it("preserves filename as metadata", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/jpeg",
            data: "base64data",
            filename: "photo.jpg",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "image",
        source: { type: "data", value: "base64data", mimeType: "image/jpeg" },
        metadata: { filename: "photo.jpg" },
      },
    ]);
  });

  it("leaves binary with only id as-is", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            id: "file-123",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toEqual([
      {
        type: "binary",
        mimeType: "image/png",
        id: "file-123",
      },
    ]);
  });

  it("handles mixed content parts", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          {
            type: "binary",
            mimeType: "image/png",
            data: "imgdata",
          },
          {
            type: "image",
            source: { type: "url", value: "https://example.com/img.png" },
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    expect(msg.content).toHaveLength(3);
    expect(msg.content[0]).toEqual({ type: "text", text: "Look at this:" });
    expect(msg.content[1]).toEqual({
      type: "image",
      source: { type: "data", value: "imgdata", mimeType: "image/png" },
    });
    // New-format parts pass through unchanged
    expect(msg.content[2]).toEqual({
      type: "image",
      source: { type: "url", value: "https://example.com/img.png" },
    });
  });

  it("does not modify non-user messages", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      { id: "msg-1", role: "assistant", content: "hi" },
      { id: "msg-2", role: "system", content: "You are helpful" },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    expect(agent.receivedInput!.messages[0]).toEqual({
      id: "msg-1",
      role: "assistant",
      content: "hi",
    });
    expect(agent.receivedInput!.messages[1]).toEqual({
      id: "msg-2",
      role: "system",
      content: "You are helpful",
    });
  });

  it("prefers data over url when both present", async () => {
    const agent = new MockAgent([]);

    const input = createInput([
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "base64data",
            url: "https://example.com/img.png",
          },
        ],
      },
    ]);

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const msg = agent.receivedInput!.messages[0] as { content: unknown[] };
    // data takes precedence over url
    expect(msg.content[0]).toEqual({
      type: "image",
      source: { type: "data", value: "base64data", mimeType: "image/png" },
    });
  });
});

describe("BackwardCompatibility_0_0_47 (lossy path warning)", () => {
  // The warning gates on SUPPRESS_TRANSFORMATION_WARNINGS, so the flag has to
  // be off here whatever the ambient environment sets — and PUT BACK, because
  // a bare `delete` leaks into every file vitest runs next in this worker.
  // Same shape as backward-compatibility-0-0-57.test.ts.
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

  it("warns when an id-only binary part cannot be converted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = new BackwardCompatibility_0_0_47();
    const agent = new MockAgent([]);
    const input = {
      threadId: "t",
      runId: "r",
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: [{ type: "binary", mimeType: "image/png", id: "asset-1" }],
        },
      ],
    } as unknown as RunAgentInput;

    await lastValueFrom(middleware.run(input, agent).pipe(toArray()), {
      defaultValue: undefined,
    });

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("asset-1");
    expect(warned).toContain("DEPRECATIONS.md");
    warnSpy.mockRestore();
  });
});
