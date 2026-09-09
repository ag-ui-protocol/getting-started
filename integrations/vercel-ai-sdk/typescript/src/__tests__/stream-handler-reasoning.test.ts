import { describe, expect, it } from "vitest";
import {
  EventType,
  type MessagesSnapshotEvent,
  type ReasoningEncryptedValueEvent,
  type ReasoningMessage,
  type ReasoningMessageContentEvent,
} from "@ag-ui/client";
import { streamText } from "ai";
import {
  collectEvents,
  eventsOfType,
  finishStop,
  fsFinish,
  fsFinishStep,
  makeMockModel,
  responseMetadata,
  streamStart,
  type FullStreamPart,
} from "./helpers";

describe("StreamHandler — reasoning", () => {
  it("emits the full reasoning event sequence (START / MESSAGE_START / CONTENT / MESSAGE_END / END)", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Thinking " },
      { type: "reasoning-delta", id: "r1", delta: "hard." },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "42." },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const reasoningEventTypes = events
      .filter((e) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(e.type as EventType),
      )
      .map((e) => e.type);

    expect(reasoningEventTypes).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ]);
  });

  it("uses the AI SDK reasoning-start.id as the messageId for all reasoning events", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r-xyz" },
      { type: "reasoning-delta", id: "r-xyz", delta: "hi" },
      { type: "reasoning-end", id: "r-xyz" },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const reasoningEvents = events.filter(
      (e) =>
        e.type === EventType.REASONING_START ||
        e.type === EventType.REASONING_MESSAGE_START ||
        e.type === EventType.REASONING_MESSAGE_CONTENT ||
        e.type === EventType.REASONING_MESSAGE_END ||
        e.type === EventType.REASONING_END,
    );
    const ids = reasoningEvents.map((e) => (e as unknown as { messageId: string }).messageId);
    expect(new Set(ids)).toEqual(new Set(["r-xyz"]));
  });

  it("preserves a reasoning Message in MESSAGES_SNAPSHOT (separate from any AssistantMessage)", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thought" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "answer" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const reasoningMsg = snapshot.messages.find((m) => m.role === "reasoning") as ReasoningMessage | undefined;
    expect(reasoningMsg).toBeDefined();
    expect(reasoningMsg!.id).toBe("r1");
    expect(reasoningMsg!.content).toBe("thought");

    // assistant message is separate
    const assistant = snapshot.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect((assistant as { content?: string }).content).toBe("answer");
  });

  it("emits REASONING_ENCRYPTED_VALUE when reasoning-end carries Anthropic signature", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r-sig" },
      { type: "reasoning-delta", id: "r-sig", delta: "thinking" },
      {
        type: "reasoning-end",
        id: "r-sig",
        providerMetadata: { anthropic: { signature: "sig_xyz_abc" } },
      },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const enc = eventsOfType<ReasoningEncryptedValueEvent>(events, EventType.REASONING_ENCRYPTED_VALUE);
    expect(enc).toHaveLength(1);
    expect(enc[0].subtype).toBe("message");
    expect(enc[0].entityId).toBe("r-sig");
    expect(enc[0].encryptedValue).toBe("sig_xyz_abc");
  });

  it("populates ReasoningMessage.encryptedValue when an Anthropic signature is present", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r-sig" },
      { type: "reasoning-delta", id: "r-sig", delta: "hmm" },
      {
        type: "reasoning-end",
        id: "r-sig",
        providerMetadata: { anthropic: { signature: "sig_abc" } },
      },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const reasoning = snapshot.messages.find((m) => m.role === "reasoning") as ReasoningMessage;
    expect(reasoning.encryptedValue).toBe("sig_abc");
  });

  it("emits REASONING_ENCRYPTED_VALUE between REASONING_END and the next TEXT_MESSAGE_START", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "x" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: { anthropic: { signature: "sig" } },
      },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "ok" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);

    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const reasoningEndIdx = events.findIndex((e) => e.type === EventType.REASONING_END);
    const encIdx = events.findIndex((e) => e.type === EventType.REASONING_ENCRYPTED_VALUE);
    const textStartIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(reasoningEndIdx).toBeLessThan(encIdx);
    expect(encIdx).toBeLessThan(textStartIdx);
  });

  it("aggregates reasoning content deltas in the final ReasoningMessage", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Part A " },
      { type: "reasoning-delta", id: "r1", delta: "Part B" },
      { type: "reasoning-end", id: "r1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const contentEvents = eventsOfType<ReasoningMessageContentEvent>(
      events,
      EventType.REASONING_MESSAGE_CONTENT,
    );
    expect(contentEvents.map((e) => e.delta).join("")).toBe("Part A Part B");

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const reasoning = snapshot.messages.find((m) => m.role === "reasoning") as ReasoningMessage;
    expect(reasoning.content).toBe("Part A Part B");
  });

  it("defensively closes an open reasoning when text-start arrives without reasoning-end", async () => {
    // Drive the handler directly to bypass AI SDK's invariant enforcement —
    // verifies our defensive close logic runs even if a misbehaving provider
    // skips reasoning-end.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "reasoning-start", id: "r-leak" };
      yield { type: "reasoning-delta", id: "r-leak", text: "thinking..." };
      // Note: no reasoning-end. Text starts directly.
      yield { type: "text-start", id: "t1" };
      yield { type: "text-delta", id: "t1", text: "Done." };
      yield { type: "text-end", id: "t1" };
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts());
    const reasoningEndIdx = events.findIndex((e) => e.type === EventType.REASONING_END);
    const textStartIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(reasoningEndIdx).toBeGreaterThan(-1);
    expect(reasoningEndIdx).toBeLessThan(textStartIdx);

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const reasoning = snapshot.messages.find((m) => m.role === "reasoning") as ReasoningMessage;
    expect(reasoning.content).toBe("thinking...");
  });

  it("does NOT emit reasoning events when the stream contains no reasoning parts", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hi" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "q" }).fullStream);
    const reasoning = events.filter(
      (e) =>
        e.type === EventType.REASONING_START ||
        e.type === EventType.REASONING_MESSAGE_START ||
        e.type === EventType.REASONING_MESSAGE_CONTENT ||
        e.type === EventType.REASONING_MESSAGE_END ||
        e.type === EventType.REASONING_END ||
        e.type === EventType.REASONING_ENCRYPTED_VALUE,
    );
    expect(reasoning).toHaveLength(0);
  });

  it("remaps a reasoning part id that collides with an existing message id", async () => {
    // Anthropic reasoning part ids are the content-block index ("0"), which
    // collides with a message already present in input.messages.
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", delta: "hmm" },
      { type: "reasoning-end", id: "0" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "answer" },
      { type: "text-end", id: "t1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream, {
      messages: [{ id: "0", role: "user", content: "hi" }],
    });

    const rStart = events.find(
      (e) => e.type === EventType.REASONING_MESSAGE_START,
    ) as unknown as { messageId: string };
    expect(rStart.messageId).not.toBe("0");
    const rContent = eventsOfType<ReasoningMessageContentEvent>(
      events,
      EventType.REASONING_MESSAGE_CONTENT,
    )[0];
    expect(rContent.messageId).toBe(rStart.messageId);

    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    const reasoningMsg = snap.messages.find((m) => m.role === "reasoning") as ReasoningMessage;
    expect(reasoningMsg.id).toBe(rStart.messageId);
    const ids = snap.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
