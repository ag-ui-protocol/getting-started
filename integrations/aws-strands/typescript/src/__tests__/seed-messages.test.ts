/**
 * Prior conversation history is converted into Strands `MessageData` and
 * seeded on the per-thread agent's `AgentConfig.messages`.
 */

import { describe, it, expect } from "vitest";
import type { Message as AguiMessage } from "@ag-ui/core";
import { convertMessagesForStrandsSeed, buildStrandsSeed } from "../agent";

describe("convertMessagesForStrandsSeed", () => {
  it("seeds only real text from a content array", async () => {
    const seed = await convertMessagesForStrandsSeed([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: null },
          { type: "jsonBlock", text: "not the user's words" },
          { type: "text", text: "keep me" },
        ],
      } as unknown as AguiMessage,
    ]);
    // Copying `text` off anything carrying the key sent the provider an empty
    // block, a null, and a tool result's payload as if the user had typed it.
    expect(seed).toEqual([{ role: "user", content: [{ text: "keep me" }] }]);
  });

  it("keeps a turn that yields no text so roles still alternate", async () => {
    const seed = await convertMessagesForStrandsSeed([
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "hi" },
      {
        id: "u2",
        role: "user",
        content: [{ type: "text", text: "" }],
      },
      { id: "a2", role: "assistant", content: "still here" },
    ] as unknown as AguiMessage[]);

    // Dropping the empty turn leaves ["user","assistant","assistant"], which
    // the provider rejects just as surely as the blank text block that
    // dropping it was meant to avoid.
    expect(seed.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const texts = seed.flatMap((m) =>
      (m.content as { text?: string }[]).map((c) => c.text),
    );
    expect(texts).not.toContain("");
  });

  it("drops system and developer messages", async () => {
    const seed = await convertMessagesForStrandsSeed([
      {
        id: "s",
        role: "system",
        content: "You are a cat.",
      } as unknown as AguiMessage,
      {
        id: "d",
        role: "developer",
        content: "be terse",
      } as unknown as AguiMessage,
      { id: "u1", role: "user", content: "hi" } as unknown as AguiMessage,
      {
        id: "a1",
        role: "assistant",
        content: "hello",
      } as unknown as AguiMessage,
    ]);
    expect(seed.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("preserves text content", async () => {
    const seed = await convertMessagesForStrandsSeed([
      {
        id: "u",
        role: "user",
        content: "what is 2+2?",
      } as unknown as AguiMessage,
      { id: "a", role: "assistant", content: "4" } as unknown as AguiMessage,
    ]);
    expect(seed[0]).toEqual({
      role: "user",
      content: [{ text: "what is 2+2?" }],
    });
    expect(seed[1]).toEqual({ role: "assistant", content: [{ text: "4" }] });
  });

  it("emits toolUse blocks for assistant toolCalls", async () => {
    const seed = await convertMessagesForStrandsSeed([
      { id: "u", role: "user", content: "lookup" } as unknown as AguiMessage,
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "search", arguments: '{"q":"x"}' },
          },
        ],
      } as unknown as AguiMessage,
    ]);
    expect(seed[1].content).toEqual([
      { toolUse: { name: "search", toolUseId: "tc-1", input: { q: "x" } } },
    ]);
  });

  it("merges tool messages into a single user message of toolResult blocks", async () => {
    const seed = await convertMessagesForStrandsSeed([
      { id: "u", role: "user", content: "lookup" } as unknown as AguiMessage,
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "s1", arguments: "{}" },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "s2", arguments: "{}" },
          },
        ],
      } as unknown as AguiMessage,
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc-1",
        content: "A",
      } as unknown as AguiMessage,
      {
        id: "t2",
        role: "tool",
        toolCallId: "tc-2",
        content: "B",
      } as unknown as AguiMessage,
    ]);
    // user, assistant, (merged user with both toolResults)
    expect(seed).toHaveLength(3);
    expect(seed[2].role).toBe("user");
    expect(seed[2].content).toEqual([
      {
        toolResult: {
          toolUseId: "tc-1",
          status: "success",
          content: [{ text: "A" }],
        },
      },
      {
        toolResult: {
          toolUseId: "tc-2",
          status: "success",
          content: [{ text: "B" }],
        },
      },
    ]);
  });

  it("carries a client-reported tool failure onto the seeded toolResult", async () => {
    // Same producer as `_buildStrandsHistory` and the reconciler, so the status
    // and the body come from `ToolMessage.error` together: the reason travels
    // with the flag rather than the raw body standing in for it. Each result is
    // stamped independently.
    const seed = await convertMessagesForStrandsSeed([
      { id: "u", role: "user", content: "lookup" } as unknown as AguiMessage,
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "s1", arguments: "{}" },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "s2", arguments: "{}" },
          },
        ],
      } as unknown as AguiMessage,
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc-1",
        content: "ok",
      } as unknown as AguiMessage,
      {
        id: "t2",
        role: "tool",
        toolCallId: "tc-2",
        content: "tool failed: invalid id",
        error: "invalid id",
      } as unknown as AguiMessage,
    ]);
    expect(seed[2].content).toEqual([
      {
        toolResult: {
          toolUseId: "tc-1",
          status: "success",
          content: [{ text: "ok" }],
        },
      },
      {
        toolResult: {
          toolUseId: "tc-2",
          status: "error",
          content: [
            { text: "Failed: invalid id (returned: tool failed: invalid id)" },
          ],
        },
      },
    ]);
  });

  it("drops orphaned tool messages whose call id wasn't announced", async () => {
    const seed = await convertMessagesForStrandsSeed([
      { id: "u", role: "user", content: "hi" } as unknown as AguiMessage,
      {
        id: "t",
        role: "tool",
        toolCallId: "bogus",
        content: "stale",
      } as unknown as AguiMessage,
    ]);
    expect(seed.map((m) => m.role)).toEqual(["user"]);
  });

  it("returns an empty array for an empty history", async () => {
    expect(await convertMessagesForStrandsSeed([])).toEqual([]);
  });

  it("preserves multimodal image/document content on user turns", async () => {
    // 1x1 red PNG as base64
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";
    const seed = await convertMessagesForStrandsSeed([
      {
        id: "u",
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image",
            source: { type: "data", mimeType: "image/png", value: PNG },
          },
        ],
      } as unknown as AguiMessage,
      { id: "a", role: "assistant", content: "nice" } as unknown as AguiMessage,
    ]);
    // First entry should include at minimum the text block; the image block
    // is best-effort depending on the content converter's format support.
    expect(seed[0].role).toBe("user");
    const texts = seed[0].content.filter(
      (c: unknown) => c && typeof c === "object" && "text" in (c as object),
    );
    expect(texts.length).toBeGreaterThanOrEqual(1);
    // Assert the image block survived — shape is `{ image: { source, format, ... } }`.
    const images = seed[0].content.filter(
      (c: unknown) => c && typeof c === "object" && "image" in (c as object),
    );
    expect(images.length).toBe(1);
  });
});

describe("buildStrandsSeed", () => {
  it("drops the final user turn when tail is user (trim-for-prompt)", async () => {
    const out = await buildStrandsSeed([
      { id: "u1", role: "user", content: "first" } as unknown as AguiMessage,
      {
        id: "a1",
        role: "assistant",
        content: "response",
      } as unknown as AguiMessage,
      {
        id: "u2",
        role: "user",
        content: "becomes prompt",
      } as unknown as AguiMessage,
    ]);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<{ role: string }>;
    expect(arr).toHaveLength(2);
    expect(arr.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("seeds the FULL history on continuation (tail is a tool message)", async () => {
    // Scenario: frontend-tool round-trip completed, client POSTs the next
    // run with [user, assistant+toolCalls, tool]. Without this fix the seed
    // would be undefined, losing all context.
    const out = await buildStrandsSeed([
      {
        id: "u",
        role: "user",
        content: "set bg to red",
      } as unknown as AguiMessage,
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "change_bg", arguments: '{"color":"red"}' },
          },
        ],
      } as unknown as AguiMessage,
      {
        id: "t",
        role: "tool",
        toolCallId: "tc1",
        content: "ok",
      } as unknown as AguiMessage,
    ]);
    expect(out).toBeDefined();
    const arr = out as Array<{ role: string }>;
    expect(arr).toHaveLength(3); // user, assistant+toolUse, user w/ toolResult
    expect(arr.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("drops leading assistant turns (Bedrock requires user-first history)", async () => {
    const out = await buildStrandsSeed([
      {
        id: "a0",
        role: "assistant",
        content: "Hi, how can I help?",
      } as unknown as AguiMessage,
      {
        id: "u1",
        role: "user",
        content: "actually, bye",
      } as unknown as AguiMessage,
    ]);
    // After trimming the tail user, seed is [assistant-only]. Bedrock
    // rejects assistant-first history, so we drop it → undefined.
    expect(out).toBeUndefined();
  });

  it("returns undefined on an empty history", async () => {
    expect(await buildStrandsSeed([])).toBeUndefined();
  });

  it("returns undefined when the only message is the prompt user turn", async () => {
    expect(
      await buildStrandsSeed([
        {
          id: "u",
          role: "user",
          content: "only turn",
        } as unknown as AguiMessage,
      ]),
    ).toBeUndefined();
  });
});
