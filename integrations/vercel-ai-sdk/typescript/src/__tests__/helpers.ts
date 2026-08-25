import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";
import type { Subscriber } from "rxjs";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { StreamHandler } from "../stream-handler";

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
 */
type LanguageModelStreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;

export type LanguageModelStreamPart =
  LanguageModelStreamResult["stream"] extends ReadableStream<infer TPart> ? TPart : never;

/** The `finish` member of the provider stream-part union. */
type FinishPart = Extract<LanguageModelStreamPart, { type: "finish" }>;

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

/**
 * Drives a StreamHandler against an async iterable of stream parts and
 * returns the full event sequence emitted to the rxjs Subscriber.
 *
 * Note: this takes `unknown` parts on purpose. Callers feed it fullStream-level
 * (UI) parts directly, which is a different vocabulary from the provider-level
 * parts `makeMockModel` takes.
 */
export function collectEvents(
  stream: AsyncIterable<unknown>,
  input: Partial<RunAgentInput> = {},
): Promise<BaseEvent[]> {
  return firstValueFrom(
    new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const handler = new StreamHandler(makeInput(input), subscriber);
      handler
        .process(stream as AsyncIterable<never>)
        .catch((err) => {
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
 * casts this replaced erased exactly that check, which is how the fixtures
 * drifted off the v7 contract unnoticed.
 *
 * Why `MockLanguageModelV3` and not `MockLanguageModelV4` (both are exported
 * from `ai/test`, and `streamText` accepts either): for every part these tests
 * emit, the V3 and V4 unions are structurally identical, so V4 buys no extra
 * compile-time safety. It would, however, flip the mock's
 * `specificationVersion`, changing which conversion path inside `streamText`
 * all 100+ assertions run through. Typed V3 parts give the drift guard with
 * zero behavioural churn.
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
const providerUsage = (): FinishPart["usage"] => ({
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
});

export const finishStop = (): FinishPart => ({
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: providerUsage(),
});

export const finishToolCalls = (): FinishPart => ({
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: providerUsage(),
});
