// Token-usage mapping: the AI SDK v7 fullStream `finish` part carries the
// run's aggregate `totalUsage`, which becomes the optional `usage` array on
// AG-UI's RUN_FINISHED.

import { describe, expect, it } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import { EventType, type BaseEvent, type RunFinishedEvent } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import type { LanguageModelUsage } from "ai";
import { VercelAISDKAgent } from "../vercel-ai-sdk";
import {
  collectEvents,
  finishStop,
  finishToolCalls,
  fromParts,
  fsFinish,
  fsFinishStep,
  fsStartStep,
  fsUsage,
  makeInput,
  makeMockModel,
  responseMetadata,
  streamStart,
  type FullStreamPart,
} from "./helpers";

const weatherTool = {
  get_weather: tool({
    description: "Get weather for a city",
    inputSchema: jsonSchema<{ city: string }>({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    }),
    execute: async ({ city }: { city: string }) => ({ city, ok: true }),
  }),
};

function runFinished(events: BaseEvent[]): RunFinishedEvent {
  const found = events.filter((e) => e.type === EventType.RUN_FINISHED);
  expect(found).toHaveLength(1);
  return found[0] as RunFinishedEvent;
}

/**
 * A one-step text run whose `finish` part reports the given totalUsage.
 *
 * `undefined` is accepted — and cast through — on purpose: v7 types
 * `finish.totalUsage` as always present, and one test below feeds a provider
 * that omits it entirely. Every other shape still has to be a real
 * `LanguageModelUsage`, so a flat v5 usage is a `tsc` error at the call site.
 */
function textRun(totalUsage: LanguageModelUsage | undefined): FullStreamPart[] {
  return [
    { type: "start" },
    fsStartStep(),
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hi" },
    { type: "text-end", id: "t1" },
    fsFinishStep(),
    { ...fsFinish(), totalUsage: totalUsage as LanguageModelUsage },
  ];
}

describe("StreamHandler — token usage on RUN_FINISHED", () => {
  it("maps the finish part's totalUsage counts onto RUN_FINISHED.usage", async () => {
    const events = await collectEvents(
      fromParts(textRun(fsUsage({ inputTokens: 7, outputTokens: 4, totalTokens: 11 }))),
    );

    expect(runFinished(events).usage).toEqual([
      { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
    ]);
  });

  it("labels the usage entry with the provider/model it was constructed with", async () => {
    const events = await collectEvents(
      fromParts(textRun(fsUsage({ inputTokens: 7, outputTokens: 4, totalTokens: 11 }))),
      {},
      { provider: "acme", model: "acme-large" },
    );

    const event = runFinished(events);
    expect(event.usage).toEqual([
      {
        provider: "acme",
        model: "acme-large",
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
      },
    ]);
    // A labelled entry is the richest shape we emit; keep it schema-valid.
    expect(RunFinishedEventSchema.safeParse(event).success).toBe(true);
  });

  // v7 moved the cached-input and reasoning counts into nested detail objects;
  // dropping them would silently under-report the two counts users most want.
  it("lifts the v7 nested cached-input and reasoning counts", async () => {
    const events = await collectEvents(
      fromParts(
        textRun(
          fsUsage({
            inputTokens: 5,
            noCacheTokens: 3,
            cacheReadTokens: 2,
            outputTokens: 3,
            reasoningTokens: 1,
            totalTokens: 8,
          }),
        ),
      ),
    );

    expect(runFinished(events).usage).toEqual([
      {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        reasoningTokens: 1,
        cachedInputTokens: 2,
      },
    ]);
  });

  it("omits usage entirely when the provider reported no counts", async () => {
    const events = await collectEvents(
      fromParts(textRun(fsUsage())),
    );

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("omits usage when the stream carries no finish part", async () => {
    const events = await collectEvents(
      fromParts([
        { type: "start" },
        fsStartStep(),
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", text: "hi" },
        { type: "text-end", id: "t1" },
        fsFinishStep(),
      ]),
    );

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("omits usage rather than emitting a labels-only entry", async () => {
    const events = await collectEvents(
      // A `finish` part with no `totalUsage` at all (see textRun's note).
      fromParts(textRun(undefined)),
      {},
      { provider: "acme", model: "acme-large" },
    );

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("drops non-finite provider counts instead of failing event validation", async () => {
    const events = await collectEvents(
      fromParts(
        textRun(
          // `outputTokens` is deliberately a string — provider junk the type
          // forbids and the handler has to drop rather than emit.
          fsUsage({
            inputTokens: NaN,
            outputTokens: "4" as unknown as number,
            totalTokens: 11,
          }),
        ),
      ),
    );

    const event = runFinished(events);
    expect(event.usage).toEqual([{ totalTokens: 11 }]);
    expect(RunFinishedEventSchema.safeParse(event).success).toBe(true);
  });

  // AG-UI's TokenUsage constrains every count to a non-negative integer, so a
  // provider reporting a fraction (or a negative) must lose that one count
  // rather than take the whole RUN_FINISHED down on a validating transport.
  it("drops fractional and negative provider counts instead of failing event validation", async () => {
    const events = await collectEvents(
      fromParts(
        textRun(
          fsUsage({
            inputTokens: 5,
            cacheReadTokens: 1.5,
            outputTokens: 3,
            reasoningTokens: -2,
            totalTokens: 8,
          }),
        ),
      ),
    );

    const event = runFinished(events);
    expect(event.usage).toEqual([{ inputTokens: 5, outputTokens: 3, totalTokens: 8 }]);
    expect(RunFinishedEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("VercelAISDKAgent — usage plumbing", () => {
  // Also the only coverage of resolveModelIdentity's model-instance branch:
  // the labels below are the mock's own `provider`/`modelId`. (Its bare
  // model-id-string branch has no direct test — the function is module-private.)
  it("labels the run's usage with the configured model's provider and id", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata("p1"),
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hi" },
      { type: "text-end", id: "t1" },
      finishStop({
        inputTokens: { total: 5, noCache: 3, cacheRead: 2, cacheWrite: undefined },
        outputTokens: { total: 3, text: 2, reasoning: 1 },
      }),
    ]);

    const agent = new VercelAISDKAgent({ model });
    const input = makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] });
    const events = await firstValueFrom(agent.run(input).pipe(toArray()));

    expect(runFinished(events).usage).toEqual([
      {
        provider: "mock-provider",
        model: "mock-model-id",
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        reasoningTokens: 1,
        cachedInputTokens: 2,
      },
    ]);
  });
});

describe("StreamHandler — multi-step usage aggregation", () => {
  // The terminal `finish` part's totalUsage covers the WHOLE run; each step's
  // own `finish-step` reports only that step. Reading the per-step figure
  // instead would under-report every multi-step run while still looking right
  // on the single-step tests above, so assert the sum of two distinct steps.
  it("reports the sum of every step's usage on RUN_FINISHED", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"Tokyo"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Tokyo"}',
            },
            finishToolCalls({
              inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: undefined },
              outputTokens: { total: 4, text: 3, reasoning: 1 },
            }),
          ]
        : [
            streamStart,
            responseMetadata("s2"),
            { type: "text-start", id: "txt-final" },
            { type: "text-delta", id: "txt-final", delta: "Sunny." },
            { type: "text-end", id: "txt-final" },
            finishStop({
              inputTokens: { total: 20, noCache: 17, cacheRead: 3, cacheWrite: undefined },
              outputTokens: { total: 6, text: 4, reasoning: 2 },
            }),
          ],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    expect(runFinished(events).usage).toEqual([
      {
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
        cachedInputTokens: 5,
        reasoningTokens: 3,
      },
    ]);
  });
});
