/**
 * Tests for AG-UI <-> LangChain message conversion (all message types).
 * Extends existing multimodal tests in utils.test.ts to cover full message lifecycle.
 */

import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { Message, ReasoningMessage } from "@ag-ui/client";
import { aguiMessagesToLangChain, langchainMessagesToAgui } from "./utils";

// Runtime shape of a reasoning content block on a LangChain assistant message
// (not part of the LangGraph SDK's typed content union).
type ReasoningBlock = {
  type?: string;
  id?: string;
  text?: string;
  encrypted_content?: string;
  summary?: { text?: string }[];
};

// The LangGraph SDK's MessageContent type models only string | (text|image)
// blocks, so a reasoning content block has no place in it. These two helpers
// centralize the single unavoidable cast at that boundary — building a fixture
// AIMessage whose content carries reasoning blocks, and reading those blocks
// back out — so the test bodies stay cast-free.
const aiMessageWithBlocks = (id: string, content: unknown[]): LangGraphMessage =>
  ({ id, type: "ai", content }) as unknown as LangGraphMessage;
const contentBlocksOf = (message: LangGraphMessage): ReasoningBlock[] =>
  message.content as unknown as ReasoningBlock[];

describe("Message Conversion - All Types", () => {
  describe("aguiMessagesToLangChain", () => {
    it("should convert user message", () => {
      const msg: Message = { id: "h1", role: "user", content: "Hello" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("human");
      expect(result[0].content).toBe("Hello");
      expect(result[0].id).toBe("h1");
    });

    it("should convert assistant message", () => {
      const msg: Message = { id: "a1", role: "assistant", content: "Hi there" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("ai");
      expect(result[0].content).toBe("Hi there");
    });

    it("should convert assistant message with tool calls", () => {
      const msg: Message = {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "search", arguments: '{"query":"weather"}' },
          },
        ],
      };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].tool_calls).toHaveLength(1);
      expect(result[0].tool_calls[0].name).toBe("search");
      expect(result[0].tool_calls[0].args).toEqual({ query: "weather" });
    });

    it("should convert system message", () => {
      const msg: Message = { id: "s1", role: "system", content: "Be helpful" };
      const result = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("system");
      expect(result[0].content).toBe("Be helpful");
    });

    it("should convert tool message", () => {
      const msg: Message = { id: "t1", role: "tool", content: "42", toolCallId: "tc1" };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("tool");
      expect(result[0].content).toBe("42");
      expect(result[0].tool_call_id).toBe("tc1");
      // A tool result with no error maps to LangChain's default "success" status.
      expect(result[0].status).toBe("success");
    });

    it("should map a tool message error onto LangChain's status flag", () => {
      // A client-reported tool failure must reach the model as an error, not a
      // silent success — AG-UI's ToolMessage.error becomes status: "error".
      const msg: Message = {
        id: "t1",
        role: "tool",
        content: "Tool failed: invalid id",
        toolCallId: "tc1",
        error: "invalid id",
      };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("tool");
      expect(result[0].status).toBe("error");
    });

    it("should throw for unsupported role", () => {
      const msg = { id: "x", role: "unknown", content: "test" } as any;
      expect(() => aguiMessagesToLangChain([msg])).toThrow("not supported");
    });

    it("should preserve message ordering", () => {
      const msgs: Message[] = [
        { id: "1", role: "user", content: "Q" },
        { id: "2", role: "assistant", content: "A" },
        { id: "3", role: "user", content: "Q2" },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
      expect(result[2].type).toBe("human");
    });

    it("should fold reasoning messages onto the adjacent assistant (not drop)", () => {
      // Reasoning belongs as a content block ON the assistant AIMessage — not a
      // standalone message (would duplicate context), but not dropped either
      // (the model would lose its chain-of-thought on a stateless turn).
      const msgs: Message[] = [
        { id: "u1", role: "user", content: "Hi" },
        { id: "r1", role: "reasoning", content: "thinking..." },
        { id: "a1", role: "assistant", content: "Hello" },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
      const reasoningBlocks = contentBlocksOf(result[1]).filter((b) => b.type === "reasoning");
      expect(reasoningBlocks).toHaveLength(1);
      expect(reasoningBlocks[0].id).toBe("r1");
    });

    it("should drop developer messages (handled by agent system prompt)", () => {
      const msgs: Message[] = [
        { id: "d1", role: "developer", content: "be concise" } as any,
        { id: "u1", role: "user", content: "Hi" },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("human");
    });
  });

  describe("langchainMessagesToAgui", () => {
    it("should convert human message", () => {
      // Cast to any to bypass strict LangGraph SDK type checks — runtime shape is valid
      const msg = { id: "h1", type: "human", content: "Hello" } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("user");
      expect(result[0].content).toBe("Hello");
      expect(result[0].id).toBe("h1");
    });

    it("should convert ai message with tool calls", () => {
      const msg = {
        id: "a2",
        type: "ai",
        content: "",
        tool_calls: [{ id: "tc1", name: "search", args: { q: "hello" } }],
      } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("assistant");
      expect(result[0].toolCalls).toHaveLength(1);
      expect(result[0].toolCalls[0].function.name).toBe("search");
      expect(JSON.parse(result[0].toolCalls[0].function.arguments)).toEqual({ q: "hello" });
    });

    it("should convert system message", () => {
      const msg = { id: "s1", type: "system", content: "Sys prompt" } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("system");
    });

    it("should convert tool message", () => {
      const msg = { id: "t1", type: "tool", content: "result", tool_call_id: "tc1" } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("tool");
      expect(result[0].toolCallId).toBe("tc1");
    });

    it("should handle generic (ChatMessage) type as assistant", () => {
      const msg = {
        id: "g1",
        type: "generic",
        content: "hello from generic",
        tool_calls: [{ id: "tc1", name: "search", args: { q: "weather" } }],
      } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("assistant");
      expect(result[0].content).toBe("hello from generic");
      expect(result[0].toolCalls).toHaveLength(1);
      expect(result[0].toolCalls[0].function.name).toBe("search");
    });

    it("should handle generic type with no tool calls", () => {
      const msg = {
        id: "g2",
        type: "generic",
        content: "plain generic message",
      } as any as LangGraphMessage;
      const result: any[] = langchainMessagesToAgui([msg]);
      expect(result[0].role).toBe("assistant");
      expect(result[0].content).toBe("plain generic message");
    });

    it("should throw for unsupported type", () => {
      const msg = { id: "x", type: "unknown", content: "", role: "other" } as any;
      expect(() => langchainMessagesToAgui([msg])).toThrow("not supported");
    });

    it("should handle multimodal human message", () => {
      const msg = {
        id: "m1",
        type: "human",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("image");
      expect(content[1].source.type).toBe("url");
      expect(content[1].source.value).toBe("https://example.com/img.png");
    });

    it("should parse data URLs in multimodal content", () => {
      const msg = {
        id: "m2",
        type: "human",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
        ],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      const content = result[0].content as any[];
      expect(content[0].type).toBe("image");
      expect(content[0].source.type).toBe("data");
      expect(content[0].source.mimeType).toBe("image/jpeg");
      expect(content[0].source.value).toBe("abc123");
    });
  });

  describe("Edge cases - langchainMessagesToAgui", () => {
    it("should return empty array for empty input", () => {
      expect(langchainMessagesToAgui([])).toHaveLength(0);
    });

    it("should handle ai message with list content (text blocks)", () => {
      const msg = {
        id: "a1",
        type: "ai",
        content: [{ type: "text", text: "extracted" }],
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].content).toBe("extracted");
    });

    it("should handle ai message with empty string content", () => {
      const msg = {
        id: "a2",
        type: "ai",
        content: "",
      } as any as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      expect(result[0].content).toBe("");
    });
  });

  describe("Edge cases - aguiMessagesToLangChain", () => {
    it("should return empty array for empty input", () => {
      expect(aguiMessagesToLangChain([])).toHaveLength(0);
    });

    it("should handle assistant message with no tool_calls", () => {
      const msg: Message = { id: "a3", role: "assistant", content: "plain text" };
      const result: any[] = aguiMessagesToLangChain([msg]);
      expect(result[0].type).toBe("ai");
      expect(result[0].tool_calls).toHaveLength(0);
    });
  });

  describe("Round-trip conversion", () => {
    it("should round-trip user message", () => {
      const original: Message = { id: "rt1", role: "user", content: "Test" };
      const lc = aguiMessagesToLangChain([original]);
      const back = langchainMessagesToAgui(lc);
      expect(back[0].role).toBe("user");
      expect(back[0].content).toBe("Test");
      expect(back[0].id).toBe("rt1");
    });

    it("should round-trip assistant with tool calls", () => {
      const original: Message = {
        id: "rt2",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "calc", arguments: '{"x":1}' } },
        ],
      };
      const lc = aguiMessagesToLangChain([original]);
      const back: any[] = langchainMessagesToAgui(lc);
      expect(back[0].toolCalls).toHaveLength(1);
      expect(back[0].toolCalls[0].function.name).toBe("calc");
    });

    it("should round-trip tool message", () => {
      const original: Message = { id: "rt3", role: "tool", content: "done", toolCallId: "tc1" };
      const lc = aguiMessagesToLangChain([original]);
      const back: any[] = langchainMessagesToAgui(lc);
      expect(back[0].role).toBe("tool");
      expect(back[0].content).toBe("done");
      expect(back[0].toolCallId).toBe("tc1");
    });
  });

  // Reasoning must survive AG-UI <-> LangChain conversion losslessly so a
  // stateless client can hand a reasoning model back its own chain-of-thought.
  describe("reasoning round-trip", () => {
    it("should fold a reasoning message onto the adjacent assistant message", () => {
      const msgs: Message[] = [
        { id: "u1", role: "user", content: "Hi" },
        { id: "rs_abc", role: "reasoning", content: "step 1; step 2", encryptedValue: "ENC123" },
        { id: "a1", role: "assistant", content: "Hello" },
      ];
      const result = aguiMessagesToLangChain(msgs);

      expect(result).toHaveLength(2); // reasoning folded in, not standalone
      expect(result[0].type).toBe("human");
      expect(result[1].type).toBe("ai");
      const blocks = contentBlocksOf(result[1]);
      const reasoningBlocks = blocks.filter((b) => b.type === "reasoning");
      expect(reasoningBlocks).toHaveLength(1);
      expect(reasoningBlocks[0].id).toBe("rs_abc");
      expect(reasoningBlocks[0].encrypted_content).toBe("ENC123");
      expect(blocks.some((b) => b.type === "text" && b.text === "Hello")).toBe(true);
    });

    it("should emit a reasoning message for an AI reasoning content block", () => {
      const msg = aiMessageWithBlocks("a1", [
        { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "step 1; step 2" }], encrypted_content: "ENC123" },
        { type: "text", text: "Hello" },
      ]);
      const result = langchainMessagesToAgui([msg]);

      expect(result).toHaveLength(2);
      const reasoning = result[0] as ReasoningMessage;
      expect(reasoning.role).toBe("reasoning");
      expect(reasoning.id).toBe("rs_abc");
      expect(reasoning.content).toBe("step 1; step 2");
      expect(reasoning.encryptedValue).toBe("ENC123");
      expect(result[1].role).toBe("assistant");
      expect(result[1].content).toBe("Hello");
    });

    it("should preserve a reasoning block that carries only an id (store=true)", () => {
      // Real OpenAI Responses (store=true) persists reasoning as just an rs_ id
      // with empty summary; the id is the round-trip handle.
      const msg = aiMessageWithBlocks("a1", [
        { type: "reasoning", id: "rs_only", summary: [], content: [] },
        { type: "text", text: "Done." },
      ]);
      const agui = langchainMessagesToAgui([msg]);
      const reasoning = agui.filter((m) => m.role === "reasoning");
      expect(reasoning).toHaveLength(1);
      expect(reasoning[0].id).toBe("rs_only");

      const back = aguiMessagesToLangChain(agui);
      const blocks = contentBlocksOf(back[0]).filter((b) => b.type === "reasoning");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe("rs_only");
    });

    it("should round-trip reasoning losslessly (langchain -> agui -> langchain)", () => {
      const original = aiMessageWithBlocks("a1", [
        { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "because X" }], encrypted_content: "ENC123" },
        { type: "text", text: "The answer is 42." },
      ]);
      const agui = langchainMessagesToAgui([original]);
      const back = aguiMessagesToLangChain(agui);

      expect(back).toHaveLength(1);
      const allBlocks = contentBlocksOf(back[0]);
      const blocks = allBlocks.filter((b) => b.type === "reasoning");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe("rs_abc");
      expect(blocks[0].encrypted_content).toBe("ENC123");
      // The summary text and the assistant's own text must survive too.
      const summaryText = (blocks[0].summary ?? []).map((s) => s.text).join("");
      expect(summaryText).toContain("because X");
      expect(allBlocks.some((b) => b.type === "text" && b.text === "The answer is 42.")).toBe(true);
    });

    it("should preserve every part of a multi-part summary on round-trip", () => {
      const original = aiMessageWithBlocks("a1", [
        { type: "reasoning", id: "rs_multi", summary: [{ text: "first part" }, { text: "second part" }] },
        { type: "text", text: "Answer." },
      ]);
      const back = aguiMessagesToLangChain(langchainMessagesToAgui([original]));
      const block = contentBlocksOf(back[0]).find((b) => b.type === "reasoning")!;
      const text = (block.summary ?? []).map((s) => s.text).join("");
      expect(text).toContain("first part");
      expect(text).toContain("second part");
    });

    it("should give multiple id-less reasoning blocks distinct ids", () => {
      const msg = aiMessageWithBlocks("a1", [
        { type: "reasoning", summary: [{ text: "alpha" }] },
        { type: "reasoning", summary: [{ text: "beta" }] },
        { type: "text", text: "Done." },
      ]);
      const reasoning = langchainMessagesToAgui([msg]).filter((m) => m.role === "reasoning");
      expect(reasoning).toHaveLength(2);
      expect(reasoning[0].id).not.toBe(reasoning[1].id);
    });

    it("should fold two buffered reasoning messages onto one assistant", () => {
      const msgs: Message[] = [
        { id: "rs_1", role: "reasoning", content: "first" },
        { id: "rs_2", role: "reasoning", content: "second" },
        { id: "a1", role: "assistant", content: "Hello" },
      ];
      const result = aguiMessagesToLangChain(msgs);
      expect(result).toHaveLength(1);
      const ids = contentBlocksOf(result[0]).filter((b) => b.type === "reasoning").map((b) => b.id);
      expect(ids).toEqual(["rs_1", "rs_2"]);
    });

    it("should drop reasoning that is not immediately followed by an assistant", () => {
      // No assistant to attach to; materializing standalone loops under
      // add_messages, so the drop is deliberate. Lock in the behavior.
      const trailing = aguiMessagesToLangChain([
        { id: "u1", role: "user", content: "Hi" },
        { id: "rs_x", role: "reasoning", content: "orphan" },
      ]);
      expect(trailing.map((m) => m.type)).toEqual(["human"]);

      const followedByUser = aguiMessagesToLangChain([
        { id: "rs_y", role: "reasoning", content: "orphan" },
        { id: "u1", role: "user", content: "Hi" },
      ]);
      expect(followedByUser.map((m) => m.type)).toEqual(["human"]);
    });
  });

  // Tool-call argument handling must match the Python converter (no crash on
  // empty arguments; no `undefined` emitted for missing args).
  describe("tool-call argument robustness", () => {
    it("should not throw on an assistant tool call with empty arguments", () => {
      const msg: Message = {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", type: "function", function: { name: "noargs", arguments: "" } }],
      };
      const result = aguiMessagesToLangChain([msg]);
      const ai = result[0] as { tool_calls?: { args: unknown }[] };
      expect(ai.tool_calls?.[0].args).toEqual({});
    });

    it("should emit \"{}\" (not undefined) for a tool call with no args", () => {
      const msg = {
        id: "a1",
        type: "ai",
        content: "",
        tool_calls: [{ id: "tc1", name: "noargs" }],
      } as unknown as LangGraphMessage;
      const result = langchainMessagesToAgui([msg]);
      const assistant = result[0] as { toolCalls?: { function: { arguments: string } }[] };
      expect(assistant.toolCalls?.[0].function.arguments).toBe("{}");
    });
  });
});
