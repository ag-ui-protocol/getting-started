import { convertAGUIMessagesToMastra } from "../utils";
import type { Message } from "@ag-ui/client";

describe("convertAGUIMessagesToMastra", () => {
  describe("user messages", () => {
    it("converts string content", () => {
      const messages: Message[] = [
        { id: "1", role: "user", content: "Hello world" },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([{ id: "1", role: "user", content: "Hello world" }]);
    });

    it("converts array content with text parts", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      ]);
    });

    it("converts array content with single text part", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Single part" },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Single part" },
          ],
        },
      ]);
    });

    it("converts empty array content", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [],
        },
      ]);
    });

    it("returns empty string for null/undefined content", () => {
      const messages: Message[] = [
        { id: "1", role: "user", content: undefined as any },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([{ id: "1", role: "user", content: "" }]);
    });

    it("preserves non-text parts as structured content", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Keep this" },
            {
              type: "image",
              source: { type: "url", value: "http://example.com/img.png" },
            } as any,
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Keep this" },
            { type: "image", image: "http://example.com/img.png" },
          ],
        },
      ]);
    });

    it("leaves whitespace from text parts as-is", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "  hello  " },
            { type: "text", text: "   " },
            { type: "text", text: "world" },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "  hello  " },
            { type: "text", text: "   " },
            { type: "text", text: "world" },
          ],
        },
      ]);
    });
  });

  describe("multimodal user content", () => {
    it("converts ImageInputContent with URL source to structured content", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.com/photo.jpg",
              },
            },
          ] as any,
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "image", image: "https://example.com/photo.jpg" },
          ],
        },
      ]);
    });

    it("converts ImageInputContent with data source to structured content", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "data",
                value: "abc123",
                mimeType: "image/png",
              },
            },
          ] as any,
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "image", image: "data:image/png;base64,abc123" },
          ],
        },
      ]);
    });

    it("converts AudioInputContent to file format", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "audio",
              source: {
                type: "data",
                value: "audiodata",
                mimeType: "audio/wav",
              },
            },
          ] as any,
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "file",
              data: "data:audio/wav;base64,audiodata",
              mimeType: "audio/wav",
            },
          ],
        },
      ]);
    });

    it("converts DocumentInputContent to file format", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "data",
                value: "pdfdata",
                mimeType: "application/pdf",
              },
            },
          ] as any,
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "file",
              data: "data:application/pdf;base64,pdfdata",
              mimeType: "application/pdf",
            },
          ],
        },
      ]);
    });

    it("returns plain string for string content (backwards compat)", () => {
      const messages: Message[] = [
        { id: "1", role: "user", content: "Just a string" },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        { id: "1", role: "user", content: "Just a string" },
      ]);
    });

    it("converts VideoInputContent to file format", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "video",
              source: {
                type: "url",
                value: "https://example.com/video.mp4",
              },
            } as any,
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);
      const content = result[0].content as any[];
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("file");
      expect(content[0].data).toBe("https://example.com/video.mp4");
    });

    it("converts mixed text and media to structured array", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Look at this image:" },
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.com/cat.jpg",
              },
            },
            { type: "text", text: "What do you see?" },
          ] as any,
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Look at this image:" },
            { type: "image", image: "https://example.com/cat.jpg" },
            { type: "text", text: "What do you see?" },
          ],
        },
      ]);
    });
  });

  describe("assistant messages", () => {
    it("converts text content", () => {
      const messages: Message[] = [
        { id: "1", role: "assistant", content: "I can help with that" },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "assistant",
          content: [{ type: "text", text: "I can help with that" }],
        },
      ]);
    });

    it("converts tool calls", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "NYC" }),
              },
            },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              args: { city: "NYC" },
            },
          ],
        },
      ]);
    });

    it("includes both text and tool calls when present", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "assistant",
          content: "Let me check",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "search",
                arguments: JSON.stringify({ q: "test" }),
              },
            },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toEqual([
        {
          id: "1",
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "search",
              args: { q: "test" },
            },
          ],
        },
      ]);
    });

    it("omits text part when content is empty", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "search",
                arguments: JSON.stringify({}),
              },
            },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      // Should only have tool-call, no text part
      expect(result[0].content).toEqual([
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "search",
          args: {},
        },
      ]);
    });
  });

  describe("tool result messages", () => {
    it("looks up toolName from prior assistant message", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "NYC" }),
              },
            },
          ],
        },
        {
          id: "2",
          role: "tool",
          content: "72°F",
          toolCallId: "tc-1",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result[1]).toEqual({
        id: "2",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "get_weather",
            result: "72°F",
          },
        ],
      });
    });

    it("defaults toolName to 'unknown' when not found in prior messages", () => {
      const messages: Message[] = [
        {
          id: "1",
          role: "tool",
          content: "some result",
          toolCallId: "tc-orphan",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result[0]).toEqual({
        id: "1",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-orphan",
            toolName: "unknown",
            result: "some result",
          },
        ],
      });
    });
  });

  describe("mixed conversations", () => {
    it("converts a full conversation with user, assistant, and tool messages", () => {
      const messages: Message[] = [
        { id: "1", role: "user", content: "What's the weather?" },
        {
          id: "2",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "NYC" }),
              },
            },
          ],
        },
        {
          id: "3",
          role: "tool",
          content: "72°F and sunny",
          toolCallId: "tc-1",
        },
        {
          id: "4",
          role: "assistant",
          content: "It's 72°F and sunny in NYC!",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
      expect(result[2].role).toBe("tool");
      expect(result[3].role).toBe("assistant");
    });

    it("returns empty array for empty messages", () => {
      expect(convertAGUIMessagesToMastra([])).toEqual([]);
    });

    it("preserves message id for all roles (issue #1659)", () => {
      const messages: Message[] = [
        { id: "user-id", role: "user", content: "hello" },
        {
          id: "assistant-id",
          role: "assistant",
          content: "hi",
          toolCalls: [],
        },
        {
          id: "tool-id",
          role: "tool",
          content: "result",
          toolCallId: "tc-1",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect((result[0] as any).id).toBe("user-id");
      expect((result[1] as any).id).toBe("assistant-id");
      expect((result[2] as any).id).toBe("tool-id");
    });

    it("omits id key entirely when message.id is undefined for all roles (issue #1659)", () => {
      // Mastra's inputToMastraDBMessage uses `"id" in message` at runtime.
      // For `{ id: undefined, ... }`, that check returns true, defeating the
      // intended fix. The id key must be absent, not present-with-undefined.
      const messages: Message[] = [
        { id: undefined as any, role: "user", content: "hello" },
        {
          id: undefined as any,
          role: "assistant",
          content: "hi",
          toolCalls: [],
        },
        {
          id: undefined as any,
          role: "tool",
          content: "result",
          toolCallId: "tc-1",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect("id" in result[0]).toBe(false);
      expect("id" in result[1]).toBe(false);
      expect("id" in result[2]).toBe(false);
    });
  });

  describe("message id sanitization (OpenAI Responses API charset)", () => {
    // AI SDK v5's `openai(model)` defaults to the Responses API, which rejects
    // any `input[].id` outside `^[A-Za-z0-9_-]+$`. Client-minted ids replayed as
    // prior-turn history must be coerced or the whole multi-turn request 400s
    // (AI_APICallError: Invalid 'input[N].id').

    it("leaves an already-valid id unchanged (common case is a no-op)", () => {
      const messages: Message[] = [
        { id: "msg-AD-dWkWJNkAbXmQx", role: "user", content: "hi" },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect((result[0] as any).id).toBe("msg-AD-dWkWJNkAbXmQx");
    });

    it("replaces out-of-charset characters with dashes for all roles", () => {
      const messages: Message[] = [
        { id: "msg+AD/dWk=", role: "user", content: "hi" },
        {
          id: "msg:with.dots",
          role: "assistant",
          content: "hello",
          toolCalls: [],
        },
        {
          id: "tool id⚡",
          role: "tool",
          content: "result",
          toolCallId: "tc-1",
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect((result[0] as any).id).toBe("msg-AD-dWk-");
      expect((result[1] as any).id).toBe("msg-with-dots");
      expect((result[2] as any).id).toBe("tool-id-");
      // Every sanitized id is now Responses-API-legal.
      for (const msg of result) {
        expect((msg as any).id).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("is deterministic so Mastra's upsert-by-id dedup still matches", () => {
      const messages: Message[] = [
        { id: "msg+AD/dWk=", role: "user", content: "hi" },
      ];

      const first = convertAGUIMessagesToMastra(messages);
      const second = convertAGUIMessagesToMastra(messages);

      expect((first[0] as any).id).toBe((second[0] as any).id);
    });
  });
});
