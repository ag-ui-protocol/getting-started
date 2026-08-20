import { describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/core";
import { convertMessagesToVercelAISDKMessages } from "../message-converter";

describe("convertMessagesToVercelAISDKMessages", () => {
  it("returns an empty array for empty input", () => {
    expect(convertMessagesToVercelAISDKMessages([])).toEqual([]);
  });

  it("maps developer role to system", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "d1", role: "developer", content: "dev instructions" },
    ]);
    expect(result).toEqual([{ role: "system", content: "dev instructions" }]);
  });

  it("maps system role to system", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "s1", role: "system", content: "you are a helpful assistant" },
    ]);
    expect(result).toEqual([{ role: "system", content: "you are a helpful assistant" }]);
  });

  it("passes through user message with string content", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "u1", role: "user", content: "hi there" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi there" }]);
  });

  it("joins user message of text-only parts into a single string", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: "first\nsecond" }]);
  });

  it("converts user image part with data source to a data URL", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "data", value: "AAAA", mimeType: "image/png" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("converts user image part with url source by passthrough", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", value: "https://example.com/cat.png" },
          },
          { type: "text", text: "describe" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "image", image: "https://example.com/cat.png" },
          { type: "text", text: "describe" },
        ],
      },
    ]);
  });

  it("converts user audio part to a file part with mediaType", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "data", value: "BBBB", mimeType: "audio/mpeg" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "file", data: "data:audio/mpeg;base64,BBBB", mediaType: "audio/mpeg" },
        ],
      },
    ]);
  });

  it("converts legacy binary content with url to image", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "binary", url: "https://example.com/x.png", mimeType: "image/png" },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: "user", content: [{ type: "image", image: "https://example.com/x.png" }] },
    ]);
  });

  it("warns and skips legacy binary with neither url nor data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [{ type: "binary", mimeType: "application/octet-stream" }],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: [] }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("converts assistant message with content only", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "a1", role: "assistant", content: "sure" },
    ]);
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "sure" }] },
    ]);
  });

  it("converts assistant message with tool calls", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "calling tool",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
      },
    ]);
  });

  it("returns empty string content for an assistant message with nothing to send", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "a1", role: "assistant" },
    ]);
    expect(result).toEqual([{ role: "assistant", content: "" }]);
  });

  it("looks up the tool name on a tool message from a prior assistant message", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ];
    const result = convertMessagesToVercelAISDKMessages(messages);
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "get_weather",
          output: { type: "text", value: "sunny" },
        },
      ],
    });
  });

  it("falls back to 'unknown' when the tool name lookup fails", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "t1", role: "tool", toolCallId: "ghost", content: "noop" },
    ]);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "ghost",
            toolName: "unknown",
            output: { type: "text", value: "noop" },
          },
        ],
      },
    ]);
  });

  it("skips activity messages", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "ac1", role: "activity", activityType: "typing", content: { foo: "bar" } },
      { id: "u1", role: "user", content: "hi" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("skips reasoning messages", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "thinking..." },
      { id: "u1", role: "user", content: "hi" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("safely parses malformed tool-call arguments to {} instead of throwing", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "broken", arguments: "{not json" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "broken", input: {} },
        ],
      },
    ]);
  });

  it("preserves whitespace in text-only user parts verbatim", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "  indented code\n" },
          { type: "text", text: "   " },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: "  indented code\n\n   " }]);
  });

  it("marks a failed tool result as error-text output", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: "connection refused",
        error: "connection refused",
      },
    ]);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "unknown",
            output: { type: "error-text", value: "connection refused" },
          },
        ],
      },
    ]);
  });

  it("attaches a reasoning message (with signature) to the following assistant message", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "thinking hard", encryptedValue: "sig-abc" },
      { id: "a1", role: "assistant", content: "the answer" },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking hard",
            providerOptions: { anthropic: { signature: "sig-abc" } },
          },
          { type: "text", text: "the answer" },
        ],
      },
    ]);
  });

  it("attaches a reasoning message without signature as a plain reasoning part", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "brief thought" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "brief thought" },
          { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: {} },
        ],
      },
    ]);
  });

  it("drops buffered reasoning when a non-assistant message follows", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "stale thought" },
      { id: "u1", role: "user", content: "actually, nevermind" },
      { id: "a1", role: "assistant", content: "ok" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "actually, nevermind" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });

  it("routes non-image legacy binary data to a file part with its mediaType", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [{ type: "binary", mimeType: "application/pdf", data: "QUJD" }],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "data:application/pdf;base64,QUJD",
            mediaType: "application/pdf",
          },
        ],
      },
    ]);
  });

  it("routes non-image legacy binary url to a file part keeping its mediaType", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "binary", mimeType: "application/pdf", url: "https://example.com/doc.pdf" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "file", data: "https://example.com/doc.pdf", mediaType: "application/pdf" },
        ],
      },
    ]);
  });
});
