// Token-usage mapping: the AI SDK v7 fullStream `finish` part carries the
// run's aggregate `totalUsage`, which becomes the optional `usage` array on
// AG-UI's RUN_FINISHED.
//
// Deliberately self-contained (no `./helpers` import) so the fixtures here
// pin the exact v7 usage shape this mapping depends on.

import { describe, expect, it } from "vitest";
import { Observable, firstValueFrom, toArray, type Subscriber } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { StreamHandler } from "../stream-handler";
import { VercelAISDKAgent, resolveModelIdentity } from "../vercel-ai-sdk";

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    state: undefined,
    ...overrides,
  } as RunAgentInput;
}

/** Feed fullStream-vocabulary parts straight into the handler. */
async function* fromParts(parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

/** Drive a StreamHandler (optionally with model identity) and collect events. */
function collectEvents(
  parts: unknown[],
  modelIdentity?: { provider?: string; model?: string },
): Promise<BaseEvent[]> {
  return firstValueFrom(
    new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const handler = new StreamHandler(makeInput(), subscriber, modelIdentity);
      handler.process(fromParts(parts) as AsyncIterable<never>).catch((err) => {
        if (!subscriber.closed) subscriber.error(err);
      });
    }).pipe(toArray()),
  );
}

function runFinished(events: BaseEvent[]): Record<string, unknown> {
  const found = events.filter((e) => e.type === EventType.RUN_FINISHED);
  expect(found).toHaveLength(1);
  return found[0] as unknown as Record<string, unknown>;
}

/** A one-step text run whose `finish` part reports the given totalUsage. */
function textRun(totalUsage: unknown): unknown[] {
  return [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "hi" },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage },
  ];
}

describe("StreamHandler — token usage on RUN_FINISHED", () => {
  it("maps the finish part's totalUsage counts onto RUN_FINISHED.usage", async () => {
    const events = await collectEvents(
      textRun({ inputTokens: 7, outputTokens: 4, totalTokens: 11 }),
    );

    expect(runFinished(events).usage).toEqual([
      { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
    ]);
  });

  it("labels the usage entry with the provider/model it was constructed with", async () => {
    const events = await collectEvents(
      textRun({ inputTokens: 7, outputTokens: 4, totalTokens: 11 }),
      { provider: "acme", model: "acme-large" },
    );

    expect(runFinished(events).usage).toEqual([
      {
        provider: "acme",
        model: "acme-large",
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
      },
    ]);
  });

  // v7 moved the cached-input and reasoning counts into nested detail objects;
  // dropping them would silently under-report the two counts users most want.
  it("lifts the v7 nested cached-input and reasoning counts", async () => {
    const events = await collectEvents(
      textRun({
        inputTokens: 5,
        inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 2 },
        outputTokens: 3,
        outputTokenDetails: { reasoningTokens: 1 },
        totalTokens: 8,
      }),
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
      textRun({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {},
        outputTokenDetails: {},
      }),
    );

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("omits usage when the stream carries no finish part", async () => {
    const events = await collectEvents([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "hi" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
    ]);

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("omits usage rather than emitting a labels-only entry", async () => {
    const events = await collectEvents(textRun(undefined), {
      provider: "acme",
      model: "acme-large",
    });

    expect(runFinished(events)).not.toHaveProperty("usage");
  });

  it("drops non-finite provider counts instead of failing event validation", async () => {
    const events = await collectEvents(
      textRun({ inputTokens: NaN, outputTokens: "4", totalTokens: 11 }),
    );

    const event = runFinished(events);
    expect(event.usage).toEqual([{ totalTokens: 11 }]);
    expect(RunFinishedEventSchema.safeParse(event).success).toBe(true);
  });

  it("emits a RUN_FINISHED that validates against the AG-UI schema", async () => {
    const events = await collectEvents(
      textRun({ inputTokens: 7, outputTokens: 4, totalTokens: 11 }),
      { provider: "acme", model: "acme-large" },
    );

    const parsed = RunFinishedEventSchema.safeParse(runFinished(events));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.usage).toEqual([
      {
        provider: "acme",
        model: "acme-large",
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
      },
    ]);
  });
});

describe("resolveModelIdentity", () => {
  it("reads provider/modelId off a model instance", () => {
    const model = new MockLanguageModelV3({ provider: "acme", modelId: "acme-large" });
    expect(resolveModelIdentity(model)).toEqual({ provider: "acme", model: "acme-large" });
  });

  it("treats a bare model-id string as the model with no known provider", () => {
    expect(resolveModelIdentity("openai/gpt-4o")).toEqual({ model: "openai/gpt-4o" });
  });
});

describe("VercelAISDKAgent — usage plumbing", () => {
  it("labels the run's usage with the configured model's provider and id", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "p1", modelId: "mock", timestamp: new Date() },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hi" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 5, noCache: 3, cacheRead: 2, cacheWrite: undefined },
                outputTokens: { total: 3, reasoning: 1 },
              },
            },
          ] as never[]),
        }) as never,
    });

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
