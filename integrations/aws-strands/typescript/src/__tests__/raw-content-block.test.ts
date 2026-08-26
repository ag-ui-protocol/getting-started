/**
 * Issue #2291 regression — the RAW fallback must not re-deliver assembled
 * content blocks.
 *
 * `Agent.stream()` wraps EVERY completed content block in a `ContentBlockEvent`
 * (`dist/src/agent/agent.js`: anything from `model.streamAggregated` that is not
 * a `ModelStreamEvent` becomes `new ContentBlockEvent({ contentBlock })`).
 * `unwrapStrandsEvent` then reduces that wrapper to the bare block, whose
 * `type` is `"textBlock"`, `"reasoningBlock"`, `"citationsBlock"`, and so on.
 * The dispatch chain maps only `"toolUseBlock"`, so before this fix every other
 * block fell through to the RAW fallback — meaning an ordinary text turn
 * re-delivered the entire assistant answer as a RAW event immediately after it
 * had finished streaming as `TEXT_MESSAGE_CONTENT`.
 *
 * That is precisely the duplication Python's `ModelMessageEvent` skip exists to
 * prevent, and it is a bug the RAW fallback itself introduced.
 *
 * Every other test in this suite hand-writes event object literals, which is
 * exactly why this went unnoticed: a literal is only ever the shape its author
 * already had in mind. These cases construct the REAL SDK classes and let the
 * adapter meet the shapes the SDK actually produces.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import {
  ContentBlockEvent,
  ReasoningBlock,
  TextBlock,
} from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { collect, scriptedStrandsAgent, stream } from "./helpers";

/** Wrap a real content block exactly as `Agent.stream()` does. */
function contentBlockEvent(contentBlock: unknown): AgentStreamEvent {
  return new ContentBlockEvent({
    // The adapter strips `agent`/`invocationState` by name; a stub is enough
    // here and keeps the fixture from needing a live model.
    agent: {} as never,
    contentBlock: contentBlock as never,
    invocationState: {} as never,
  }) as unknown as AgentStreamEvent;
}

function rawPayloads(events: Array<{ type: string }>): unknown[] {
  return events
    .filter((e) => e.type === EventType.RAW)
    .map((e) => (e as unknown as { event: unknown }).event);
}

describe("assembled content blocks never reach the RAW fallback", () => {
  it("emits no RAW for a real TextBlock, and does not repeat the answer", async () => {
    const answer = "the whole assistant answer";
    const agent = scriptedStrandsAgent([
      stream.textDelta(answer),
      contentBlockEvent(new TextBlock(answer)),
    ]);

    const events = await collect(agent);
    const raws = rawPayloads(events as Array<{ type: string }>);

    expect(raws).toEqual([]);
    // Belt and braces: the answer must appear exactly once on the wire, via
    // the streamed text — never a second time inside a RAW payload.
    expect(JSON.stringify(raws)).not.toContain(answer);
  });

  it("emits no RAW for a real ReasoningBlock, including its signature", async () => {
    const agent = scriptedStrandsAgent([
      contentBlockEvent(
        new ReasoningBlock({ text: "chain of thought", signature: "sig" }),
      ),
    ]);

    const events = await collect(agent);
    const raws = rawPayloads(events as Array<{ type: string }>);

    expect(raws).toEqual([]);
    // The signature is a verification token the adapter deliberately keeps off
    // the wire; leaking it through RAW would defeat that.
    expect(JSON.stringify(raws)).not.toContain("sig");
  });

  it("emits no RAW for any assembled block kind the SDK may add", async () => {
    // The fix is keyed on the `contentBlockEvent` wrapper rather than on a list
    // of block names, so a block type this adapter has never heard of is still
    // covered. By construction any content block is the assembled form of
    // deltas that already streamed.
    const agent = scriptedStrandsAgent([
      contentBlockEvent({ type: "someFutureBlock", payload: "assembled" }),
    ]);

    const events = await collect(agent);

    expect(rawPayloads(events as Array<{ type: string }>)).toEqual([]);
  });

  it("still forwards genuinely unmapped events that are not content blocks", async () => {
    // Guard against over-correcting: the fallback must keep doing its job for
    // events that carry information no mapped AG-UI event conveys.
    const agent = scriptedStrandsAgent([
      contentBlockEvent(new TextBlock("streamed already")),
      {
        type: "modelMetadataEvent",
        usage: { inputTokens: 10, outputTokens: 20 },
      } as unknown as AgentStreamEvent,
    ]);

    const events = await collect(agent);
    const raws = rawPayloads(events as Array<{ type: string }>) as Array<{
      type?: string;
    }>;

    expect(raws.map((r) => r?.type)).toEqual(["modelMetadataEvent"]);
  });
});
