import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";
import type { Subscriber } from "rxjs";
import type {
  FinishReason,
  LanguageModelUsage,
  StepResultPerformance,
  TextStreamPart,
  ToolSet,
} from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { StreamHandler } from "../stream-handler";

/**
 * The fullStream-level (UI) part union — exactly what `StreamHandler.process`
 * consumes, and a different vocabulary from the provider-level parts
 * `makeMockModel` takes. Exported so tests can type their own hand-rolled
 * `AsyncIterable` fixtures against it.
 */
export type FullStreamPart = TextStreamPart<ToolSet>;

/**
 * The provider-level stream contract a mock language model must satisfy —
 * i.e. `LanguageModelV3StreamResult` / `LanguageModelV3StreamPart` from
 * `@ai-sdk/provider`.
 *
 * These are derived from the mock instead of imported by name because neither
 * `ai` nor `ai/test` re-exports them, and `@ai-sdk/provider` is only a
 * transitive dependency of `ai` (not resolvable from this package under pnpm's
 * strict node_modules). Deriving pins the fixtures to whatever provider
 * version the installed `ai` actually ships, with no extra package.json entry.
 *
 * Deliberately not exported: tests consume the fixtures and builders below
 * rather than the part type, and the name collides with `ai`'s
 * `Experimental_LanguageModelStreamPart` (a different union).
 */
type LanguageModelStreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;

type LanguageModelStreamPart =
  LanguageModelStreamResult["stream"] extends ReadableStream<infer TPart> ? TPart : never;

/** The `finish` member of the provider stream-part union. */
type FinishPart = Extract<LanguageModelStreamPart, { type: "finish" }>;

/** Provider-level token usage, as carried by a `finish` stream part. */
type ProviderUsage = FinishPart["usage"];

export function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
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
export async function* fromParts(parts: FullStreamPart[]): AsyncIterable<FullStreamPart> {
  for (const part of parts) yield part;
}

/**
 * Drives a StreamHandler against an async iterable of fullStream parts and
 * returns the full event sequence emitted to the rxjs Subscriber.
 *
 * The parameter is `process()`'s own type, so a hand-rolled fixture that has
 * drifted off the v7 fullStream contract — a flat `usage`, a `finish-step`
 * missing `performance` — is a `tsc` error at the fixture rather than a silent
 * runtime mismatch. Fixtures that are malformed *on purpose* (defensive-path
 * tests) cast at the one offending literal.
 */
export function collectEvents(
  stream: AsyncIterable<FullStreamPart>,
  input: Partial<RunAgentInput> = {},
  modelIdentity?: { provider?: string; model?: string },
): Promise<BaseEvent[]> {
  return firstValueFrom(
    new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const handler = new StreamHandler(makeInput(input), subscriber, modelIdentity);
      handler.process(stream).catch((err) => {
        if (!subscriber.closed) subscriber.error(err);
      });
    }).pipe(toArray()),
  );
}

/**
 * Build a MockLanguageModelV3 whose doStream() returns the supplied parts.
 * If `parts` is a function it is treated as a multi-call factory: call N
 * receives `parts(N)`.
 *
 * `parts` is typed as the real provider stream-part union and `doStream` is
 * annotated with the real result type, so a mis-shaped fixture — a pre-v7
 * `finishReason: "stop"` string, or a flat `usage.inputTokens: number` — is a
 * `tsc` error right here rather than a silent runtime mismatch. The `as never`
 * casts that this replaced erased exactly that check, which is how the
 * fixtures drifted off the v7 contract unnoticed.
 *
 * Why `MockLanguageModelV3` and not `MockLanguageModelV4` (both are exported
 * from `ai/test`): for every part these tests emit the two unions are
 * structurally identical, so V4 buys no extra compile-time safety — but it
 * would flip the mock's `specificationVersion`, changing which conversion path
 * inside `streamText` all 100+ assertions run through.
 */
export function makeMockModel(
  parts: LanguageModelStreamPart[] | ((callCount: number) => LanguageModelStreamPart[]),
): MockLanguageModelV3 {
  let callCount = 0;
  return new MockLanguageModelV3({
    doStream: async (): Promise<LanguageModelStreamResult> => {
      callCount += 1;
      const list = typeof parts === "function" ? parts(callCount) : parts;
      return { stream: convertArrayToReadableStream(list) };
    },
  });
}

/** Return events of a given EventType, narrowed to a usable shape. */
export function eventsOfType<E extends BaseEvent = BaseEvent>(
  events: BaseEvent[],
  type: EventType,
): E[] {
  return events.filter((e) => e.type === type) as E[];
}

/** Convenience: stream-start + response-metadata + finish wrapper. */
export const streamStart: Extract<LanguageModelStreamPart, { type: "stream-start" }> = {
  type: "stream-start",
  warnings: [],
};

export const responseMetadata = (
  id = "test-1",
): Extract<LanguageModelStreamPart, { type: "response-metadata" }> => ({
  type: "response-metadata",
  id,
  modelId: "mock",
  timestamp: new Date(),
});

/** Provider-level usage: v7 nests the token counts and requires every field. */
const providerUsage = (): ProviderUsage => ({
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
});

export const finishStop = (usage: ProviderUsage = providerUsage()): FinishPart => ({
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage,
});

export const finishToolCalls = (usage: ProviderUsage = providerUsage()): FinishPart => ({
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage,
});

// fullStream-level fixture builders ---------------------------------------
//
// Only the noisy parts get a builder. Simple parts (`text-start`,
// `tool-input-delta`, …) stay as literals at their call sites: the union
// narrows them on `type` and they carry no required boilerplate.

/** The token counts a fixture names, flat — see `fsUsage`. */
export interface UsageCounts {
  inputTokens?: number;
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/**
 * fullStream-level token usage (`LanguageModelUsage`).
 *
 * v7 nests the cache and reasoning figures under `inputTokenDetails` /
 * `outputTokenDetails` and requires both objects to be present even when
 * every count in them is unknown, so this takes the counts flat and fills
 * whatever it isn't given with `undefined`.
 */
export const fsUsage = (counts: UsageCounts = {}): LanguageModelUsage => ({
  inputTokens: counts.inputTokens,
  inputTokenDetails: {
    noCacheTokens: counts.noCacheTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
  },
  outputTokens: counts.outputTokens,
  outputTokenDetails: {
    textTokens: counts.textTokens,
    reasoningTokens: counts.reasoningTokens,
  },
  totalTokens: counts.totalTokens,
});

/** The default counts a fixture gets when it doesn't care about usage. */
const defaultUsage = (): LanguageModelUsage =>
  fsUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });

const stepPerformance: StepResultPerformance = {
  effectiveOutputTokensPerSecond: 0,
  outputTokensPerSecond: undefined,
  inputTokensPerSecond: undefined,
  effectiveTotalTokensPerSecond: 0,
  stepTimeMs: 0,
  responseTimeMs: 0,
  toolExecutionMs: {},
  timeToFirstOutputMs: undefined,
};

/** A complete `start-step` part. */
export const fsStartStep = (): Extract<FullStreamPart, { type: "start-step" }> => ({
  type: "start-step",
  request: {},
  warnings: [],
});

/**
 * A complete `finish-step` part. The handler reads nothing off this part —
 * it is purely a step boundary — so the response metadata, performance
 * figures and raw finish reason v7 requires are constants here; only
 * `finishReason` (which fixtures vary, for readability) and the per-step
 * `usage` are parameters.
 */
export const fsFinishStep = (
  finishReason: FinishReason = "stop",
  usage: LanguageModelUsage = defaultUsage(),
): Extract<FullStreamPart, { type: "finish-step" }> => ({
  type: "finish-step",
  response: { id: "step-1", modelId: "mock", timestamp: new Date(0) },
  usage,
  performance: stepPerformance,
  finishReason,
  rawFinishReason: undefined,
  providerMetadata: undefined,
});

/**
 * A complete `finish` part. `totalUsage` is the one field the handler reads
 * (it becomes RUN_FINISHED.usage), so it leads.
 */
export const fsFinish = (
  totalUsage: LanguageModelUsage = defaultUsage(),
  finishReason: FinishReason = "stop",
): Extract<FullStreamPart, { type: "finish" }> => ({
  type: "finish",
  finishReason,
  rawFinishReason: undefined,
  totalUsage,
});
