/**
 * Tests for the LangGraph A2UI tool's streaming subagent.
 *
 * `streamRenderSubagent` STREAMS the model (`stream`) so the nested render_a2ui
 * tool-call arg deltas surface natively as the graph's OnChatModelStream events
 * — which the generic agent.ts translator paints progressively. The subagent
 * emits nothing itself; it just accumulates the streamed chunks and returns the
 * final render args for the recovery loop. We drive it with a fake model that
 * streams a fixed render_a2ui call as several AIMessageChunks (one arg fragment
 * each), like a real provider, and assert the fragments reconstruct.
 */

import { describe, it, expect } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";

import { streamRenderSubagent } from "./a2ui-tool";

// A structurally-valid render_a2ui result.
const VALID_ARGS = {
  surfaceId: "s1",
  components: [
    { id: "root", component: "Column", children: ["t"] },
    { id: "t", component: "Text", text: "hi" },
  ],
  data: {},
};

/** Split JSON into `parts` non-empty fragments, the way a provider streams. */
function argChunks(args: unknown, parts = 4): string[] {
  const text = JSON.stringify(args);
  const size = Math.max(1, Math.floor(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

/** Fake bound model: streams a fixed render_a2ui call as several chunks. */
function fakeBoundModel(args: unknown, callId = "call-1") {
  return {
    async *stream(_messages: unknown[]) {
      const fragments = argChunks(args);
      for (let i = 0; i < fragments.length; i++) {
        yield new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              // Name + id only on the first fragment, mirroring how providers
              // stamp them once at the start of the call.
              name: i === 0 ? "render_a2ui" : undefined,
              args: fragments[i],
              id: i === 0 ? callId : undefined,
              index: 0,
              type: "tool_call_chunk",
            },
          ],
        });
      }
    },
  };
}

describe("streamRenderSubagent", () => {
  it("accumulates streamed chunks into the full render args", async () => {
    // The render call arrives as several partial AIMessageChunk fragments; the
    // subagent must merge them back into the complete structured args for the
    // recovery loop. (Surfacing the deltas on the wire is langgraph's job, via
    // the OnChatModelStream events the stream emits — not this function's.)
    const captured = await streamRenderSubagent(
      fakeBoundModel(VALID_ARGS),
      "PROMPT",
      [],
    );
    expect(captured).toEqual(VALID_ARGS);
  });

  it("returns null when the model produces no render call", async () => {
    const emptyModel = {
      // eslint-disable-next-line require-yield
      async *stream(_messages: unknown[]) {
        return;
      },
    };
    const captured = await streamRenderSubagent(emptyModel, "PROMPT", []);
    expect(captured).toBeNull();
  });
});
