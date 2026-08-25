/**
 * Issue #2291 — the adapter's event dispatch has no terminal fallback, so any
 * Strands event it does not translate is dropped with no error and no log.
 * Provider extensions the adapter predates (Bedrock citations being the
 * reported case) vanish before they reach the frontend. Citations arrive as a
 * delta kind inside an event the adapter does handle, so the delta branch must
 * let unrecognised kinds fall through rather than consuming them.
 *
 * The adapter must forward anything it does not map as a RAW event carrying
 * the original Strands payload, while the deliberate lifecycle skips stay
 * silent.
 */

import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { collect, scriptedStrandsAgent } from "./helpers";

// The shape `@strands-agents/sdk` 1.1.0 actually emits for Bedrock citations:
// a `modelContentBlockDeltaEvent` whose delta discriminates as
// `citationsDelta` (models/streaming.d.ts, `ContentBlockDelta`). The adapter
// has no branch for that delta kind, so it is what the fallback must forward.
const CITATION_EVENT = {
  type: "modelContentBlockDeltaEvent",
  delta: {
    type: "citationsDelta",
    citations: [
      {
        title: "quarterly-report.pdf",
        source: "s3://reports/quarterly-report.pdf",
        sourceContent: [{ text: "revenue grew 12%" }],
        location: { documentChar: { documentIndex: 0, start: 10, end: 26 } },
      },
    ],
    content: [{ text: "revenue grew 12%" }],
  },
} as unknown as AgentStreamEvent;

function rawEvents(events: Array<{ type: string }>) {
  return events.filter((e) => e.type === EventType.RAW) as unknown as Array<{
    event: { type?: string };
    source?: string;
  }>;
}

describe("RAW fallback for unmapped Strands events", () => {
  it("forwards an unmapped provider event as RAW with the original payload", async () => {
    const agent = scriptedStrandsAgent([CITATION_EVENT]);
    const events = await collect(agent);

    const raws = rawEvents(events as Array<{ type: string }>);
    const citationRaws = raws.filter(
      (e) =>
        (e.event as { delta?: { type?: string } })?.delta?.type ===
        "citationsDelta",
    );

    expect(citationRaws).toHaveLength(1);
    expect(citationRaws[0].source).toBe("strands");
    expect(citationRaws[0].event).toEqual(CITATION_EVENT);
  });

  it("unwraps the modelStreamUpdateEvent envelope before emitting RAW", async () => {
    // Strands v1 decorates raw model events; the RAW payload must be the inner
    // event the adapter actually failed to map, not the wrapper.
    const agent = scriptedStrandsAgent([
      {
        type: "modelStreamUpdateEvent",
        event: CITATION_EVENT,
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);

    const raws = rawEvents(events as Array<{ type: string }>);
    expect(
      raws.map((e) => (e.event as { delta?: { type?: string } })?.delta?.type),
    ).toContain("citationsDelta");
    expect(raws.map((e) => e.event?.type)).not.toContain(
      "modelStreamUpdateEvent",
    );
  });

  it("keeps lifecycle plumbing events silent", async () => {
    const agent = scriptedStrandsAgent([
      { type: "initializedEvent" } as unknown as AgentStreamEvent,
      { type: "beforeInvocationEvent" } as unknown as AgentStreamEvent,
      { type: "beforeModelCallEvent" } as unknown as AgentStreamEvent,
      { type: "afterModelCallEvent" } as unknown as AgentStreamEvent,
      { type: "modelMessageStartEvent" } as unknown as AgentStreamEvent,
      { type: "modelMessageStopEvent" } as unknown as AgentStreamEvent,
      { type: "afterInvocationEvent" } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);

    expect(rawEvents(events as Array<{ type: string }>)).toEqual([]);
  });

  it("does not disturb events the adapter already maps", async () => {
    const agent = scriptedStrandsAgent([
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "hello" },
      } as unknown as AgentStreamEvent,
      CITATION_EVENT,
    ]);
    const events = await collect(agent);

    const deltas = (
      events as unknown as Array<{ type: string; delta?: string }>
    )
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta)
      .join("");
    expect(deltas).toBe("hello");
    expect(rawEvents(events as Array<{ type: string }>)).toHaveLength(1);
  });

  it("does not duplicate payloads that a mapped AG-UI event already carries", async () => {
    // Each of these carries content the client has already received under a
    // mapped event; forwarding them as RAW re-sends it. `agentResultEvent` and
    // `modelMessageEvent` in particular would re-deliver the whole assistant
    // message that just streamed as TEXT_MESSAGE_CONTENT.
    const duplicated = [
      "agentResultEvent",
      "modelMessageEvent",
      "toolResultEvent",
      "messageAddedEvent",
    ];

    const agent = scriptedStrandsAgent([
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "hello" },
      } as unknown as AgentStreamEvent,
      ...duplicated.map(
        (type) =>
          ({
            type,
            message: { role: "assistant", content: [{ text: "hello" }] },
            result: { stopReason: "end_turn" },
          }) as unknown as AgentStreamEvent,
      ),
    ]);
    const events = await collect(agent);

    const leaked = rawEvents(events as Array<{ type: string }>)
      .map((e) => e.event?.type)
      .filter((type) => type !== undefined && duplicated.includes(type));

    expect(leaked).toEqual([]);
  });

  it("still forwards events carrying information no mapped event conveys", async () => {
    // The counterpart of the skip list: usage metrics and guardrail redactions
    // have no AG-UI equivalent, so dropping them silently is the very bug
    // issue #2291 reports. This pins the deliberate decision to forward them.
    const agent = scriptedStrandsAgent([
      {
        type: "modelMetadataEvent",
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
        metrics: { latencyMs: 42 },
      } as unknown as AgentStreamEvent,
      {
        type: "modelRedactionEvent",
        outputRedaction: { text: "[redacted]" },
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);

    const kinds = rawEvents(events as Array<{ type: string }>).map(
      (e) => e.event?.type,
    );
    expect(kinds).toContain("modelMetadataEvent");
    expect(kinds).toContain("modelRedactionEvent");
  });

  it("never forwards the live agent or invocationState on a RAW payload", async () => {
    // Strands hook events hold a live `agent` reference (system prompt, message
    // history, model config) next to their payload. It must not reach a client.
    const liveAgent = {
      systemPrompt: "TOP SECRET SYSTEM PROMPT",
      messages: [{ role: "user", content: [{ text: "private history" }] }],
    };
    const agent = scriptedStrandsAgent([
      {
        type: "modelMetadataEvent",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        agent: liveAgent,
        invocationState: { requestState: {}, agent: liveAgent },
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);

    const raws = rawEvents(events as Array<{ type: string }>);
    expect(raws).toHaveLength(1);

    const serialized = JSON.stringify(raws[0].event);
    expect(serialized).not.toContain("TOP SECRET SYSTEM PROMPT");
    expect(serialized).not.toContain("private history");
    expect(raws[0].event).not.toHaveProperty("agent");
    expect(raws[0].event).not.toHaveProperty("invocationState");
  });

  it("drops an unserializable payload instead of emitting it", async () => {
    // A payload that cannot be encoded must not reach the encoder: on the
    // Python side the equivalent failure aborts the whole SSE stream. Dropping
    // is the only safe outcome — coercing values to strings is what would put
    // an agent's internals on the wire.
    const cyclic: Record<string, unknown> = { type: "modelMetadataEvent" };
    cyclic.self = cyclic;

    const agent = scriptedStrandsAgent([cyclic as unknown as AgentStreamEvent]);
    const events = await collect(agent);

    expect(rawEvents(events as Array<{ type: string }>)).toEqual([]);
  });
});
