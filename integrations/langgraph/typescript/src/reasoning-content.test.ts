/**
 * Tests for resolveReasoningContent and resolveEncryptedReasoningContent.
 * Covers all supported AI provider formats including the Bedrock Converse API
 * fix for issue #1361.
 */

import { resolveReasoningContent, resolveEncryptedReasoningContent } from "./utils";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";

describe("resolveReasoningContent", () => {
  it("should handle Anthropic old format (thinking)", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Let me think...");
    expect(result!.type).toBe("text");
    expect(result!.index).toBe(0);
  });

  it("should handle Anthropic old format with signature", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "Deep thought", signature: "sig123", index: 1 }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result!.text).toBe("Deep thought");
    expect(result!.signature).toBe("sig123");
    expect(result!.index).toBe(1);
  });

  it("should handle LangChain new format (reasoning)", () => {
    const eventData = {
      chunk: {
        content: [{ type: "reasoning", reasoning: "Step 1..." }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Step 1...");
  });

  it("should handle OpenAI Responses API v1 format", () => {
    const eventData = {
      chunk: {
        content: [{ type: "reasoning", summary: [{ text: "Because X implies Y" }] }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Because X implies Y");
  });

  it("should handle OpenAI legacy format via additional_kwargs", () => {
    const eventData = {
      chunk: {
        content: [],
        additional_kwargs: {
          reasoning: { summary: [{ text: "Legacy reasoning", index: 2 }] },
        },
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Legacy reasoning");
    expect(result!.index).toBe(2);
  });

  it("should handle Bedrock Converse API format (issue #1361)", () => {
    const eventData = {
      chunk: {
        content: [
          {
            type: "reasoning_content",
            reasoning_content: { type: "text", text: "Bedrock reasoning here" },
          },
        ],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Bedrock reasoning here");
    expect(result!.type).toBe("text");
  });

  it("should handle Bedrock Converse with index", () => {
    const eventData = {
      chunk: {
        content: [
          {
            type: "reasoning_content",
            reasoning_content: { type: "text", text: "Step 2", index: 3 },
          },
        ],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(3);
  });

  it("should return null for empty content", () => {
    expect(resolveReasoningContent({ chunk: { content: [] } })).toBeNull();
  });

  it("should return null for null content", () => {
    expect(resolveReasoningContent({ chunk: { content: null } })).toBeNull();
  });

  it("should return null for unknown format", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "unknown", data: "stuff" }] } }),
    ).toBeNull();
  });

  it("should return null for regular text blocks", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "text", text: "Regular" }] } }),
    ).toBeNull();
  });

  it("should return null for empty thinking", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "thinking", thinking: "" }] } }),
    ).toBeNull();
  });

  it("should return null for empty reasoning", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "reasoning", reasoning: "" }] } }),
    ).toBeNull();
  });

  it("should return null when reasoning_content inner value is not an object", () => {
    expect(
      resolveReasoningContent({
        chunk: { content: [{ type: "reasoning_content", reasoning_content: "not-an-object" }] },
      }),
    ).toBeNull();
  });

  it("should return null when reasoning_content inner dict has no text key", () => {
    expect(
      resolveReasoningContent({
        chunk: { content: [{ type: "reasoning_content", reasoning_content: { type: "text" } }] },
      }),
    ).toBeNull();
  });

  it("should return null when thinking block has no thinking key", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "thinking" }] } }),
    ).toBeNull();
  });

  it("should return null for OpenAI Responses API with empty summary list", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "reasoning", summary: [] }] } }),
    ).toBeNull();
  });

  it("should return null for additional_kwargs with empty summary list", () => {
    expect(
      resolveReasoningContent({
        chunk: { content: [], additional_kwargs: { reasoning: { summary: [] } } },
      }),
    ).toBeNull();
  });

  it("should return null for additional_kwargs summary entry without text key", () => {
    expect(
      resolveReasoningContent({
        chunk: { content: [], additional_kwargs: { reasoning: { summary: [{ index: 0 }] } } },
      }),
    ).toBeNull();
  });
});

describe("resolveEncryptedReasoningContent", () => {
  it("should extract redacted_thinking data", () => {
    const eventData = {
      chunk: {
        content: [{ type: "redacted_thinking", data: "encrypted_data_here" }],
      },
    };
    expect(resolveEncryptedReasoningContent(eventData)).toBe("encrypted_data_here");
  });

  it("should return null for non-redacted content", () => {
    expect(
      resolveEncryptedReasoningContent({
        chunk: { content: [{ type: "thinking", thinking: "visible" }] },
      }),
    ).toBeNull();
  });

  it("should return null for empty content", () => {
    expect(resolveEncryptedReasoningContent({ chunk: { content: [] } })).toBeNull();
  });

  it("should return null for null chunk", () => {
    expect(resolveEncryptedReasoningContent({ chunk: null })).toBeNull();
  });

  it("should return null for redacted_thinking without data", () => {
    expect(
      resolveEncryptedReasoningContent({
        chunk: { content: [{ type: "redacted_thinking" }] },
      }),
    ).toBeNull();
  });
});

// ─── Canonical reasoning id (snapshot reconciliation) ────────────────────────
//
// Since reasoning round-trips through MESSAGES_SNAPSHOT under the provider's
// canonical block id (e.g. OpenAI `rs_…`), the streamed reasoning message must
// open under that same id or the client renders the reasoning twice (the
// langgraph-python dojo e2e strict-mode failure). The canonical id arrives on
// the `response.reasoning_summary_part.added` chunk (empty text, id set).
describe("resolveReasoningContent canonical id", () => {
  it("surfaces the empty-text summary_part.added chunk and extracts the id", () => {
    const eventData = {
      chunk: {
        content: [{
          type: "reasoning",
          id: "rs-canonical",
          summary: [{ index: 0, type: "summary_text", text: "" }],
          index: 0,
        }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.id).toBe("rs-canonical");
    expect(result!.index).toBe(0);
  });

  it("does not invent an id on text delta chunks", () => {
    const eventData = {
      chunk: {
        content: [{
          type: "reasoning",
          summary: [{ index: 0, type: "summary_text", text: "Because X" }],
          index: 0,
        }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result!.text).toBe("Because X");
    expect(result!.id).toBeUndefined();
  });

  it("attaches the id when text and id are both present", () => {
    const eventData = {
      chunk: {
        content: [{
          type: "reasoning",
          id: "rs-canonical",
          summary: [{ index: 0, type: "summary_text", text: "Hi" }],
        }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result!.text).toBe("Hi");
    expect(result!.id).toBe("rs-canonical");
  });

  it("surfaces the output_item.added shape (id, empty summary) as a text-less id carrier", () => {
    // The only id carrier observed on the LangGraph Platform wire.
    const eventData = {
      chunk: {
        content: [{ type: "reasoning", id: "rs-canonical", summary: [], index: 0 }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.id).toBe("rs-canonical");
  });

  it("drops empty-summary items without an id", () => {
    const eventData = {
      chunk: { content: [{ type: "reasoning", summary: [], index: 0 }] },
    };
    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("drops the part.added shape when its id is null (platform wire shape)", () => {
    const eventData = {
      chunk: {
        content: [{
          type: "reasoning",
          id: null,
          summary: [{ index: 0, type: "summary_text", text: "" }],
          index: 0,
        }],
      },
    };
    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("does not reuse the item id for non-first summary parts", () => {
    const eventData = {
      chunk: {
        content: [{
          type: "reasoning",
          id: "rs-canonical",
          summary: [{ index: 1, type: "summary_text", text: "" }],
          index: 0,
        }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
    expect(result!.id).toBeUndefined();
  });
});

describe("handleReasoningEvent canonical id", () => {
  function buildAgent() {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    });
    const dispatched: any[] = [];
    (agent as any).dispatchEvent = (event: any) => {
      dispatched.push(event);
      return true;
    };
    return { agent, dispatched };
  }

  it("stashes the id from a text-less carrier without emitting anything", () => {
    const { agent, dispatched } = buildAgent();
    agent.handleReasoningEvent({ type: "text", text: "", index: 0, id: "rs-canonical" });
    expect(dispatched).toHaveLength(0);
  });

  it("opens REASONING_START under the stashed canonical id on the first text delta", () => {
    const { agent, dispatched } = buildAgent();
    agent.handleReasoningEvent({ type: "text", text: "", index: 0, id: "rs-canonical" });
    agent.handleReasoningEvent({ type: "text", text: "Because X", index: 0 });

    const starts = dispatched.filter((e) => e.type === EventType.REASONING_START);
    const contents = dispatched.filter(
      (e) => e.type === EventType.REASONING_MESSAGE_CONTENT,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].messageId).toBe("rs-canonical");
    expect(contents).toHaveLength(1);
    expect(contents[0].messageId).toBe("rs-canonical");
    expect(contents[0].delta).toBe("Because X");
  });

  it("falls back to a random id when the stream carries none", () => {
    const { agent, dispatched } = buildAgent();
    agent.handleReasoningEvent({ type: "text", text: "thinking…", index: 0 });

    const starts = dispatched.filter((e) => e.type === EventType.REASONING_START);
    expect(starts).toHaveLength(1);
    expect(starts[0].messageId).toBeTruthy();
    expect(starts[0].messageId).not.toBe("rs-canonical");
  });

  it("still drops chunks with neither text nor id", () => {
    const { agent, dispatched } = buildAgent();
    agent.handleReasoningEvent({ type: "text", text: "", index: 0 });
    expect(dispatched).toHaveLength(0);
  });

  // B1 — index 0 must close on an index change. The guard used a truthiness
  // check (`this.reasoningProcess?.index && ...`), so a process open at
  // index 0 was never closed when a new index arrived: REASONING_END for
  // index 0 was silently skipped. resolveReasoningContent defaults index to
  // 0, so index 0 is the common case.
  it("closes the index-0 reasoning process when a new index arrives", () => {
    const { agent, dispatched } = buildAgent();
    // Open a reasoning process at index 0.
    agent.handleReasoningEvent({ type: "text", text: "first block", index: 0 });
    // A new reasoning block at index 1 must close the index-0 one first.
    agent.handleReasoningEvent({ type: "text", text: "second block", index: 1 });

    const ends = dispatched.filter((e) => e.type === EventType.REASONING_END);
    const starts = dispatched.filter(
      (e) => e.type === EventType.REASONING_START,
    );
    // The index-0 process was closed (END) and a fresh one opened for index 1.
    expect(ends).toHaveLength(1);
    expect(starts).toHaveLength(2);
  });
});
