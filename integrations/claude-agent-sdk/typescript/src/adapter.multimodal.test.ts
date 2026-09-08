import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@ag-ui/client", () => {
  class AbstractAgent {
    constructor(_config?: Record<string, unknown>) {}
    clone() {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }
  }
  return {
    AbstractAgent,
    EventType: {
      RUN_STARTED: "RUN_STARTED",
      RUN_FINISHED: "RUN_FINISHED",
      RUN_ERROR: "RUN_ERROR",
      TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
      TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
      TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
      TOOL_CALL_START: "TOOL_CALL_START",
      TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
      TOOL_CALL_END: "TOOL_CALL_END",
      TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
      STATE_SNAPSHOT: "STATE_SNAPSHOT",
      MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
      CUSTOM: "CUSTOM",
      REASONING_START: "REASONING_START",
      REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
      REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
      REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
      REASONING_END: "REASONING_END",
      REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    },
    randomUUID: () => crypto.randomUUID(),
  };
});

vi.mock("@ag-ui/core", () => ({}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
}));

vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";
import { processMessages } from "./utils";

async function collectPrompt(prompt: unknown): Promise<unknown> {
  if (typeof prompt === "string") return prompt;
  const messages: unknown[] = [];
  for await (const message of prompt as AsyncIterable<unknown>)
    messages.push(message);
  return messages;
}

async function runAdapter(messages: unknown[], threadId = "thread-media") {
  const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
  const events: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    adapter
      .run({
        threadId,
        runId: "run-1",
        messages,
        tools: [],
        context: [],
      } as never)
      .subscribe({
        next: (event) => events.push(event as Record<string, unknown>),
        error: reject,
        complete: resolve,
      });
  });
  return events;
}

describe("ClaudeAgentAdapter multimodal input", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            value: { type: "result", result: "ok", is_error: false },
            done: false,
          })
          .mockResolvedValueOnce({ value: undefined, done: true }),
      }),
      interrupt: vi.fn(),
    }));
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes ordered text, image, and PDF blocks to query", async () => {
    await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "describe these" },
          {
            type: "image",
            source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
          },
          { type: "text", text: "then read this" },
          {
            type: "document",
            source: {
              type: "data",
              value: "cGRm",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ]);

    const prompt = queryMock.mock.calls[0][0].prompt;
    await expect(collectPrompt(prompt)).resolves.toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe these" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aW1hZ2U=",
              },
            },
            { type: "text", text: "then read this" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "cGRm",
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "thread-media",
      },
    ]);
  });

  it("maps supported remote image and PDF URLs", async () => {
    const { userMessage } = processMessages({
      threadId: "thread-url",
      messages: [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", value: "https://example.com/image.png" },
            },
            {
              type: "document",
              source: {
                type: "url",
                value: "https://example.com/file.pdf",
                mimeType: "application/pdf",
              },
            },
          ],
        },
      ],
    } as never);

    const messages = (await collectPrompt(userMessage)) as Array<
      Record<string, any>
    >;
    expect(messages[0].message.content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/image.png" },
      },
      {
        type: "document",
        source: { type: "url", url: "https://example.com/file.pdf" },
      },
    ]);
  });

  it.each(["audio", "video"])("rejects unsupported %s blocks", (type) => {
    expect(() =>
      processMessages({
        threadId: "thread-unsupported",
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              {
                type,
                source: {
                  type: "data",
                  value: "Ynl0ZXM=",
                  mimeType: `${type}/mp4`,
                },
              },
            ],
          },
        ],
      } as never),
    ).toThrow(`type ${type} is not supported`);
  });

  it("rejects opaque binary ids instead of dropping them", () => {
    expect(() =>
      processMessages({
        threadId: "thread-file",
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              { type: "binary", mimeType: "image/png", id: "file-123" },
            ],
          },
        ],
      } as never),
    ).toThrow("opaque file id");
  });

  it("emits AG-UI error events when adapter input conversion fails", async () => {
    const events = await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          {
            type: "audio",
            source: {
              type: "data",
              value: "Ynl0ZXM=",
              mimeType: "audio/mp4",
            },
          },
        ],
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(events[1].message).toContain("type audio is not supported");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not send empty text blocks to query", async () => {
    await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      },
    ]);

    expect(queryMock.mock.calls[0][0].prompt).toBe("");
  });

  it("keeps plain string prompts unchanged", async () => {
    await runAdapter(
      [{ id: "1", role: "user", content: "hello" }],
      "thread-text",
    );

    expect(queryMock.mock.calls[0][0].prompt).toBe("hello");
  });
});
